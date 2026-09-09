/**
 * Node.js環境用のMemorialCardService
 * Electronに依存しない独立したメモリアルカード生成サービス
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { GameResult } from '../shared/types';
import { CommandExecutor, type ExecutionResult, type MagickError } from '../main/services/command-executor';
import { MagickScriptGenerator } from '../main/services/magick-script-generator';
import { resolveMagickCommand } from '../main/services/magick-path';
import { discardFailedPartial, finalizeCardOutput } from '../main/services/card-output';
import { NodeImageCompositionConfig, type CompositionConfig } from './node-image-composition-config';

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

export class NodeMemorialCardService {
  private readonly config: MemorialCardConfig;
  private readonly commandExecutor: CommandExecutor;
  private readonly imageConfig: NodeImageCompositionConfig;
  private readonly scriptGenerator: MagickScriptGenerator;

  constructor(config: MemorialCardConfig, projectRoot?: string) {
    this.config = config;
    // 🔴 携帯版 ImageMagick は PATH に入っていない。素材と同じルートから探す
    this.commandExecutor = new CommandExecutor(
      config.magickTimeout,
      resolveMagickCommand(projectRoot ? [projectRoot] : [])
    );
    this.imageConfig = new NodeImageCompositionConfig(config.cardBaseImagesDir, projectRoot);
    this.scriptGenerator = new MagickScriptGenerator();
  }

  /**
   * 合成の設定（土台画像・フォントの場所）を外から見る。
   * 救済ツールの --check-compose が「今この環境で合成できるか」を
   * 確かめるために使う。private を型で抜くと壊れやすいので入口を用意する。
   */
  getImageConfig(): NodeImageCompositionConfig {
    return this.imageConfig;
  }

  /**
   * 記念カード生成のメイン処理
   */
  async generateMemorialCard(resultDir: string, isDummy: boolean = false): Promise<MemorialCardResult> {
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
      
      // Step 2: 合成設定生成
      const datetime = path.basename(resultDir);
      const compositionConfig = isDummy 
        ? this.imageConfig.generateDummyCompositionConfig(gameResult, datetime, animePhotoPath)
        : this.imageConfig.generateCompositionConfig(gameResult, datetime, animePhotoPath);

      // Step 3: 設定検証
      const configValidation = this.imageConfig.validateConfig(compositionConfig);
      if (!configValidation.valid) {
        return {
          success: false,
          error: `Configuration validation failed: ${configValidation.errors.join(', ')}`,
          duration: Date.now() - startTime
        };
      }

      // Step 4: ImageMagickスクリプト生成
      const scriptPath = await this.scriptGenerator.generateScript(
        compositionConfig,
        animePhotoPath,
        resultDir
      );

      // Step 5: スクリプト検証
      const scriptValidation = await this.scriptGenerator.validateScriptFile(scriptPath);
      if (!scriptValidation.valid) {
        return {
          success: false,
          error: `Script validation failed: ${scriptValidation.error}`,
          duration: Date.now() - startTime
        };
      }

      // Step 6: デバッグ用ログ出力
      await this.scriptGenerator.logScriptContent(scriptPath);

      // Step 7: ImageMagickコマンド実行
      const executionResult = await this.commandExecutor.executeMagickScript(scriptPath);

      // Step 8: 実行結果の処理
      const result = await this.processExecutionResult(
        executionResult,
        compositionConfig,
        resultDir,
        startTime
      );

      // Step 9: 成功した回の合成スクリプトは片付ける
      // （アプリ本体の MemorialCardService.composeCard と同じ扱いに揃える）。
      // results/ は OneDrive 同期下なので、救済のたびに残る 1〜2KB のテキストが
      // 積み上がると同期が遅れ、それがカードの rename 失敗を誘発する。
      // 失敗した回は原因調査に要るので残す。
      if (result.success) {
        await this.scriptGenerator.cleanupScript(scriptPath);
      }

      return result;

    } catch (error) {
      console.error('NodeMemorialCardService - Generation error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime
      };
    }
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

      // MagickScriptGenerator は一時名（*.partial）へ書く。
      // アプリ本体と同じ確定処理を通す（検査 → 最終名へ rename）。
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
      // 失敗分岐でも一時ファイルは残る。明確に壊れているものだけ始末する
      // （検査できなかった完成品を消さないため。アプリ本体と同じ扱い）
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
   * サービスの設定を取得
   */
  getConfig(): MemorialCardConfig {
    return { ...this.config };
  }

  /**
   * サービスの状態を取得
   */
  getStatus(): { enabled: boolean; ready: boolean } {
    return {
      enabled: this.config.enabled,
      ready: true
    };
  }
}