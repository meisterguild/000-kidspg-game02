import * as path from 'path';
import * as fs from 'fs/promises';
import { BrowserWindow } from 'electron';
import type { GameResult } from '@shared/types';
import { CommandExecutor, type ExecutionResult, type MagickError } from './command-executor';
import { resolveMagickCommand } from './magick-path';
import { ImageCompositionConfig, type CompositionConfig } from './image-composition-config';
import { MagickScriptGenerator } from './magick-script-generator';
import { discardFailedPartial, finalizeCardOutput } from './card-output';

export interface MemorialCardResult {
  success: boolean;
  outputPath?: string;
  error?: string;
  duration: number;
}

export interface MemorialCardConfig {
  enabled: boolean;
  magickTimeout: number;
  cardBaseImagesDir: string;
}

export class MemorialCardService {
  private readonly config: MemorialCardConfig;
  private readonly commandExecutor: CommandExecutor;
  private readonly imageConfig: ImageCompositionConfig;
  private readonly scriptGenerator: MagickScriptGenerator;
  private readonly mainWindow: BrowserWindow | null;

  constructor(config: MemorialCardConfig, mainWindow?: BrowserWindow, bundleRoot?: string) {
    this.config = config;
    // 🔴 携帯版 ImageMagick は PATH に入っていない（magick-path.ts の注釈）
    this.commandExecutor = new CommandExecutor(
      config.magickTimeout,
      resolveMagickCommand(bundleRoot ? [bundleRoot] : [])
    );
    this.imageConfig = new ImageCompositionConfig(config.cardBaseImagesDir);
    this.scriptGenerator = new MagickScriptGenerator();
    this.mainWindow = mainWindow || null;
  }

  /**
   * ダミー画像を使ったメモリアルカード事前生成
   */
  async generateDummyMemorialCard(datetime: string, resultDir: string, gameResult: GameResult): Promise<MemorialCardResult> {
    const startTime = Date.now();
    
    if (!this.config.enabled) {
      return {
        success: false,
        error: 'Memorial card generation is disabled',
        duration: Date.now() - startTime
      };
    }

    try {
      // Step 1: 前景に使う画像を決める。
      //
      // 🔴 **撮影した本人の写真は前景に使わない。**
      // このカードは後日ネットで公開し各自がダウンロードできるようにする方針のため、
      // 生の顔写真を焼き込むと、そのまま公開物になってしまう（2026-09-02 判断）。
      // AI変換が間に合わない／ComfyUI が使えない場合は、
      // 人物ではない固定のプレースホルダ（assets/dummy_photo.png）を使う。
      const dummyPhotoPath = this.imageConfig.getDummyPhotoPath();

      // Step 2: プレースホルダの存在確認
      try {
        await fs.access(dummyPhotoPath);
      } catch {
        return {
          success: false,
          error: `Placeholder image not found for card: ${dummyPhotoPath}`,
          duration: Date.now() - startTime
        };
      }

      // Step 3: 合成設定生成（ダミー用ファイル名）
      const compositionConfig = this.imageConfig.generateDummyCompositionConfig(gameResult, datetime);

      // Step 4 以降（検証 → スクリプト生成 → 実行 → 確定）は AI 版と共通
      return await this.composeCard(compositionConfig, dummyPhotoPath, resultDir, startTime);

    } catch (error) {
      console.error('MemorialCardService - Dummy card generation error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * AI変換画像用のメモリアルカード生成。
   *
   * 🔴 **成否を必ず返すこと。** 以前は void で失敗を握り潰していたため、
   * 呼び出し側（main.ts の runAIMemorialCard）が無条件に
   * `updateMemorialCardPath` を呼び、**実体が無い正規カードのパス**を
   * result.json（後日のカード公開の正本）と results.json に書いていた。
   * 「カードが出来ていると誤認する」という直したかった不具合が、
   * 1階層上でそのまま残っていた。
   */
  async generateFromAIImage(jobId: string, resultDir: string): Promise<MemorialCardResult> {

    if (!this.config.enabled) {
      return { success: false, error: 'Memorial card generation is disabled', duration: 0 };
    }

    try {
      const result = await this.generateMemorialCard(resultDir);

      if (result.success) {
        this.sendToRenderer('memorial-card-generated', {
          success: true,
          datetime: jobId,
          outputPath: result.outputPath,
          duration: result.duration
        });
      } else {
        console.error(`MemorialCardService - AI image memorial card generation failed: ${result.error}`);
        this.sendToRenderer('memorial-card-error', {
          success: false,
          datetime: jobId,
          error: result.error,
          duration: result.duration
        });
      }

      return result;

    } catch (error) {
      console.error('MemorialCardService - Unexpected error during AI image memorial card generation:', error);
      this.sendToRenderer('memorial-card-error', {
        success: false,
        datetime: jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration: 0
      };
    }
  }

  /**
   * AI変換画像から記念カードを合成する。
   *
   * 前景は必ず `photo_anime_*`（ComfyUI の出力）で、出力名は正規カード
   * （`memorial_card_<日時>.png`）。プレースホルダ版は
   * generateDummyMemorialCard が別に作る。
   */
  async generateMemorialCard(resultDir: string): Promise<MemorialCardResult> {
    const startTime = Date.now();
    
    try {
      // Step 1: 入力検証
      const validation = await this.validateInputs(resultDir);
      if (!validation.valid) {
        return {
          success: false,
          error: `Input validation failed: ${validation.errors?.join(', ') || 'Unknown validation error'}`,
          duration: Date.now() - startTime
        };
      }

      const { gameResult, animePhotoPath } = validation;
      
      if (!gameResult || !animePhotoPath) {
        return {
          success: false,
          error: 'Game result or anime photo path is missing',
          duration: Date.now() - startTime
        };
      }
      
      // Step 2: 合成設定生成（出力は正規カード）
      const datetime = path.basename(resultDir);
      const compositionConfig = this.imageConfig.generateCompositionConfig(gameResult, datetime);

      // Step 3 以降（検証 → スクリプト生成 → 実行 → 確定）はダミー版と共通
      return await this.composeCard(compositionConfig, animePhotoPath, resultDir, startTime);

    } catch (error) {
      console.error('MemorialCardService - Generation error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * 合成設定が決まってから先の共通処理。
   *
   * ダミー版（generateDummyMemorialCard）と AI 版（generateMemorialCard）で
   * まったく同じ手順を2か所に書いていたため、片方だけ直したときに
   * 「ダミーは出るのに本カードだけ壊れる（逆も）」というずれが起きる形になっていた。
   * 出力ファイル名の違いは compositionConfig に入っているので、ここは共有できる。
   */
  private async composeCard(
    compositionConfig: CompositionConfig,
    foregroundImagePath: string,
    resultDir: string,
    startTime: number
  ): Promise<MemorialCardResult> {
    // 設定検証（背景・フォントの実在確認）
    const configValidation = this.imageConfig.validateConfig(compositionConfig);
    if (!configValidation.valid) {
      return {
        success: false,
        error: `Configuration validation failed: ${configValidation.errors.join(', ')}`,
        duration: Date.now() - startTime
      };
    }

    // ImageMagick スクリプト生成と検証
    const scriptPath = await this.scriptGenerator.generateScript(
      compositionConfig,
      foregroundImagePath,
      resultDir
    );
    const scriptValidation = await this.scriptGenerator.validateScriptFile(scriptPath);
    if (!scriptValidation.valid) {
      return {
        success: false,
        error: `Script validation failed: ${scriptValidation.error}`,
        duration: Date.now() - startTime
      };
    }

    const executionResult = await this.commandExecutor.executeMagickScript(scriptPath);
    const result = await this.processExecutionResult(
      executionResult,
      compositionConfig,
      resultDir,
      startTime
    );

    // 🔴 **成功した回のスクリプトは消す。**
    // results/<日時>/magick_script_*.txt は1プレイに2件（ダミー＋本カード）増える。
    // 3000人規模だと 6000 ファイルが OneDrive の同期対象として積み上がり、
    // 同期の遅れがそのままカードの rename 失敗（共有違反）を誘発する。
    // 失敗した回は原因調査に要るので**残す**（当日の調べ物はこのファイルが頼り）。
    if (result.success) {
      await this.scriptGenerator.cleanupScript(scriptPath);
    }

    return result;
  }

  /**
   * 入力ファイルの検証
   */
  private async validateInputs(resultDir: string): Promise<{
    valid: boolean;
    errors?: string[];
    gameResult?: GameResult;
    animePhotoPath?: string;
  }> {
    const errors: string[] = [];

    try {
      // result.jsonの存在確認と読み込み
      const resultJsonPath = path.join(resultDir, 'result.json');
      let gameResult: GameResult;
      
      try {
        const resultContent = await fs.readFile(resultJsonPath, 'utf-8');
        gameResult = JSON.parse(resultContent);
      } catch (error) {
        errors.push(`Failed to read result.json: ${error}`);
        return { valid: false, errors };
      }

      // photo_anime.pngの存在確認
      const animePhotoPath = this.imageConfig.findAnimePhotoPath(resultDir);
      if (!animePhotoPath) {
        errors.push('photo_anime file not found in result directory');
        return { valid: false, errors };
      }


      return {
        valid: true,
        gameResult,
        animePhotoPath
      };

    } catch (error) {
      errors.push(`Validation error: ${error}`);
      return { valid: false, errors };
    }
  }

  /**
   * ImageMagick実行結果の処理
   */
  private async processExecutionResult(
    executionResult: ExecutionResult,
    config: CompositionConfig,
    resultDir: string,
    startTime: number
  ): Promise<MemorialCardResult> {
    const duration = Date.now() - startTime;

    if (executionResult.success) {
      const outputPath = path.join(resultDir, config.outputFileName);

      // 一時出力の完全性を確かめてから最終名へ据える（card-output.ts に集約）
      const finalizeError = await finalizeCardOutput(outputPath);
      if (finalizeError) {
        return { success: false, error: finalizeError, duration };
      }

      return {
        success: true,
        outputPath,
        duration
      };

    } else {
      // magick が異常終了・タイムアウトした場合も一時ファイルは残る。
      // results/ は OneDrive 同期下なので、壊れた2.5MBを放置すると同期に乗り、
      // そのロックが次のカードの rename 失敗を誘発する。
      // 「明確に壊れているものだけ」消す（判定できなかった完成品は残す）。
      await discardFailedPartial(path.join(resultDir, config.outputFileName));

      // エラー解析
      const magickError = this.commandExecutor.parseError(executionResult.stderr);
      const errorMessage = this.formatErrorMessage(magickError, executionResult);

      return {
        success: false,
        error: errorMessage,
        duration
      };
    }
  }

  /**
   * エラーメッセージのフォーマット
   */
  private formatErrorMessage(magickError: MagickError, executionResult: ExecutionResult): string {
    let message = magickError.message;
    
    if (executionResult.exitCode !== null) {
      message += ` (Exit code: ${executionResult.exitCode})`;
    }
    
    if (executionResult.stderr) {
      message += `\nDetails: ${executionResult.stderr}`;
    }
    
    return message;
  }

  /**
   * レンダラープロセスへの通知
   */
  private sendToRenderer(channel: string, data: Record<string, unknown>): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

}