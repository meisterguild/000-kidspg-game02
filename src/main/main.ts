import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { MessageBoxOptions } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ComfyUIService } from './services/comfyui-service';
import { MemorialCardService } from './services/memorial-card-service';
import { RankingService } from './services/ranking-service';
import { ResultsManager } from './services/results-manager';
import { checkResultsConsistency, formatConsistencyReport } from './services/startup-consistency';
import {
  buildPartialOutputPath,
  finalizeCardOutput,
  getProcessToken,
  withMaintenanceLock,
} from './services/card-output';
import type { AppConfig, GameResult } from '@shared/types';
import { WINDOW_CONFIG } from '../shared/utils/constants';
import { resolveResultsDir } from './paths';
import {
  applyWorkflowVariables,
  checkGenerationApplied,
  checkGenerationWiring,
  validateWorkflowTemplate,
  type WorkflowTemplate,
} from './services/workflow-template';
import { resolveComfyUIConfig, type ResolvedComfyUIConfig } from './services/comfyui-config';
import { launchComfyUI } from './services/comfyui-launcher';
import {
  buildReadinessWarnings,
  checkResultsWritable,
  clearReadiness,
  writeReadiness,
  type ReadinessReport,
  type RendererReadiness,
} from './services/readiness';
import { applyConfigPatch } from './services/config-writer';

/**
 * 終了が確定してから、強制的にプロセスを終わらせるまでの猶予（ミリ秒）。
 *
 * 片付け（ワーカーの terminate と .maintenance.lock の削除）はふつう1秒もかからない。
 * 長くするとスタッフが「終了しない」と思って電源を切りに行くので、
 * 片付けが終わる見込みより少し長い程度に留める。
 */
const QUIT_FORCE_EXIT_MS = 8000;

// 日付を YYYYMMDD_HHMMSS 形式の文字列にフォーマットする
const getFormattedDateTime = (date: Date): string => {
  const Y = date.getFullYear();
  const M = String(date.getMonth() + 1).padStart(2, '0');
  const D = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${Y}${M}${D}_${h}${m}${s}`;
};


// Electronメインプロセス
class ElectronApp {
  private mainWindow: BrowserWindow | null = null;
  private rankingWindow: BrowserWindow | null = null;
  private config: AppConfig | null = null;
  private comfyUIService: ComfyUIService | null = null;
  /** activeProfile を解決した後の ComfyUI 設定。config.comfyui を直接読まずこちらを使う */
  private comfyUI: ResolvedComfyUIConfig | null = null;
  private memorialCardService: MemorialCardService | null = null;
  private resultsManager: ResultsManager | null = null;
  private rankingService: RankingService | null = null; // ADDED
  private memorialCardGenerationFlags = new Map<string, 'dummy_inprogress' | 'dummy_completed' | 'ai_inprogress' | 'ai_completed'>(); // 生成状態管理フラグ
  private exitConfirmed = false; // 終了確認済みフラグ
  /**
   * ComfyUI の変換完了が、ダミーカード生成より先に来た場合の保留分。
   * 変換は「撮影直後」に始まり、ダミーカードのフラグは「結果保存時」
   * （＝プレイ後、約90秒後）に立つ。生成が速いと必ず先着するため、
   * 以前はここで AI カードを捨てており、全員がダミー写真のカードになっていた。
   * dateTime -> jobId
   */
  private pendingAICompletions = new Map<string, string>();
  /**
   * カードの確定（rename）に失敗した回の再試行タイマー。
   * 同じ回に何本も張らない／成功したら残りを止める、ために保持する。
   */
  private cardFinalizeRetries = new Map<string, ReturnType<typeof setTimeout>[]>();
  /** 起動時点検が走っている間 true（終了時のロック解放で他人のロックを消さないため） */
  private startupCheckRunning = false;
  /** 終了時にロックを片付けるための results ディレクトリ */
  private resultsDirForCleanup: string | null = null;

  constructor() {
    this.initializeApp();
  }

  /**
   * config.json の場所。読み込みと保存で必ず同じ場所を指すよう1か所に集約する
   * （別々に組み立てていると、保存したのに読み込まれない事故が起きる）。
   */
  private getConfigPath(): string {
    return app.isPackaged
      // 本番環境: exeファイルと同じディレクトリにあるconfig.json
      ? path.join(path.dirname(app.getPath('exe')), 'config.json')
      // 開発環境: プロジェクトルートにあるconfig.json
      : path.join(app.getAppPath(), 'config.json');
  }

  /** assets などの同梱物を指すルート。config.json と同じ流儀で解決する */
  private getBundleRoot(): string {
    return app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
  }

  private async loadConfig(): Promise<AppConfig | null> {
    try {
      const configPath = this.getConfigPath();

      const configContent = await fs.readFile(configPath, 'utf-8');

      return JSON.parse(configContent);
    } catch (error) {
      console.error('設定ファイルの読み込みに失敗しました:', error);
      return null;
    }
  }

  /**
   * ワークフローテンプレートを読み、「アプリ側との約束」を満たしているか確認して返す。
   *
   * 検査を飛ばすと、たとえば ComfyUI の UI エクスポート形式（{nodes:[], links:[]}）を
   * 誤って指した場合に置換が1件も起きず、${photo_png} が残ったままの
   * image_generate.json を投げてしまい、原因が分かりにくい失敗になる。
   */
  private async loadWorkflowTemplate(
    comfy: ResolvedComfyUIConfig
  ): Promise<{ template: WorkflowTemplate; templatePath: string }> {
    const templatePath = path.join(this.getBundleRoot(), comfy.workflow.templatePath);
    const template = JSON.parse(await fs.readFile(templatePath, 'utf-8')) as WorkflowTemplate;
    const templateErrors = validateWorkflowTemplate(template);
    if (templateErrors.length > 0) {
      throw new Error(`ワークフローテンプレートが不正です (${templatePath}): ${templateErrors.join(' / ')}`);
    }
    return { template, templatePath };
  }

  /**
   * config.json を読み直したあと、解決済みの ComfyUI 設定を作り直す。
   *
   * 生成パラメータ（generation）は撮影のたびにテンプレートへ適用するため、
   * ここを差し替えるだけで次の撮影から効く。
   * 一方 baseUrl / templatePath / timeouts は ComfyUIService の初期化時に渡してあるので、
   * 変えるならアプリの再起動が必要。**再起動が要る項目名を戻り値で返す**
   * （画面が「保存したのに変わらない」と誤解されないように伝えるため）。
   */
  private refreshResolvedComfyUI(): string[] {
    if (!this.config?.comfyui) return [];
    const previous = this.comfyUI;
    let resolved: ResolvedComfyUIConfig;
    try {
      resolved = resolveComfyUIConfig(this.config.comfyui);
    } catch (error) {
      console.error('[ComfyUI] 設定の再解決に失敗:', error);
      return [];
    }
    for (const warning of resolved.warnings) {
      console.warn('[ComfyUI] 設定の警告:', warning);
    }

    if (!previous) {
      this.comfyUI = resolved;
      return [];
    }

    // ComfyUIService は初期化時に受けた設定をそのままワーカーへ渡し、以後保持し続ける
    // （comfyui-service.ts の 'init' postMessage）。**generation 以外はすべて
    // 再起動しないと変わらない**ため、差分をひとつずつ名前で挙げる。
    const restartRequired: string[] = [];
    const compare = (label: string, a: unknown, b: unknown): void => {
      if (JSON.stringify(a) !== JSON.stringify(b)) restartRequired.push(label);
    };
    compare('接続先URL', previous.baseUrl, resolved.baseUrl);
    compare('プロファイル', previous.profileName, resolved.profileName);
    compare('ワークフロー', previous.workflow.templatePath, resolved.workflow.templatePath);
    compare('出力プレフィックス', previous.workflow.outputPrefix, resolved.workflow.outputPrefix);
    compare('タイムアウト', previous.timeouts, resolved.timeouts);
    compare('ポーリング間隔', previous.pollingInterval, resolved.pollingInterval);
    compare('最大同時ジョブ数', previous.maxConcurrentJobs, resolved.maxConcurrentJobs);
    compare('リトライ設定', previous.retry, resolved.retry);

    // **半分だけ適用された状態を作らない。**
    // 例えばプロファイルを local → server に書き換えて再読み込みした場合、
    // 生成パラメータだけ server 用（1024px・別チェックポイント向けプロンプト）を
    // 取り込むと、ローカルCPUの ComfyUI へ 1024px を投げ続けることになる
    // （キューが発散し、プロンプトもモデルに合わない）。
    // 再起動が要る変更が1つでもあるなら、generation も含めて据え置く。
    if (restartRequired.length > 0) {
      console.warn(
        '[ComfyUI] 再起動しないと反映できない変更があるため、設定を据え置きます: ' +
          restartRequired.join(' / ')
      );
      this.comfyUI = { ...previous, warnings: resolved.warnings };
      return restartRequired;
    }

    this.comfyUI = resolved;
    return [];
  }

  /**
   * いまの設定でワークフローを組み立て、点検結果（警告）だけを返す。
   * 保存直後にその場で伝えるために使う。起動時ダイアログはもう過ぎているため、
   * ここで返さないと `denoise: 1` のような致命的な設定が黙って通る。
   */
  private async collectGenerationWarnings(): Promise<string[]> {
    const comfy = this.comfyUI;
    if (!comfy) return [];
    try {
      const { template } = await this.loadWorkflowTemplate(comfy);
      const workflow = applyWorkflowVariables(template, {
        outputPrefix: comfy.workflow.outputPrefix,
        photoFileName: 'settings-check.png',
        generation: comfy.generation,
      });
      return [
        ...checkGenerationWiring(workflow),
        ...checkGenerationApplied(workflow, comfy.generation),
      ];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return ['ワークフローを点検できませんでした: ' + message];
    }
  }

  private initializeApp(): void {
    // 二重起動を防ぐ。ResultsManager の直列化はプロセス内にしか効かないため、
    // 2インスタンス立つと results.json の競合が復活する。
    // カメラの二重占有・ComfyUI への二重投入も防げる。
    if (!app.requestSingleInstanceLock()) {
      console.warn('すでに起動しています。このインスタンスは終了します。');
      app.quit();
      return;
    }
    app.on('second-instance', () => {
      if (this.mainWindow) {
        if (this.mainWindow.isMinimized()) this.mainWindow.restore();
        this.mainWindow.focus();
      }
    });

    // 終了前確認イベントハンドラー
    app.on('before-quit', async (event) => {
      if (!this.exitConfirmed) {
        event.preventDefault();
        await this.showExitConfirmation();
        return;
      }
      // 終了が確定した。ここから先は必ずプロセスが死ぬようにする
      this.armForceExit();
    });

    // GPU プロセス クラッシュ対策のコマンドラインスイッチ
    app.commandLine.appendSwitch('disable-gpu-process-crash-limit');
    app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor');
    
    app.whenReady().then(async () => {
      // 🔴 **前回の「準備OK」の印を必ず消す。**
      // 残っていると、今回起動に失敗しても起動バッチが即座に準備完了と言ってしまう。
      // バッチ側でも消しているが、片方に頼らない（詳細は services/readiness.ts）。
      await clearReadiness(this.getBundleRoot());

      // 設定ファイルを読み込む
      this.config = await this.loadConfig();

      // Media権限の設定（カメラ・マイクアクセスを許可）
      app.on('web-contents-created', (event, contents) => {
        contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
          if (permission === 'media') {
            callback(true); // カメラ・マイクアクセスを許可
          } else {
            callback(false);
          }
        });
      });

      // ResultsManagerを初期化
      const resultsDir = resolveResultsDir();
      
      // resultsフォルダの存在を確認・作成（正しいパスで）
      await this.ensureDirectoryExistsAbsolute(resultsDir);
      
      this.resultsManager = new ResultsManager(resultsDir, this.config);
      // 前回の異常終了で残った results.json.*.tmp を掃除する
      await this.resultsManager.cleanupTempFiles();

      await this.createMainWindow();
      this.setupIPC();
      await this.initializeServices();
      await this.checkImageMagick();
      await this.checkComfyUI();

      // 前回の異常終了で残った不整合（合成中の残骸・壊れたカード・
      // プレースホルダのままの参照）を直す。
      //
      // 🔴 **ウィンドウを出したあとに、待たずに走らせる。**
      // results/ は OneDrive 同期ツリーの中にあり、点検のためにカードの末尾を読むと
      // クラウド専用ファイルの実体化（1枚2.5MB）が走る。これを起動前に await すると、
      // 画面が1枚も出ないまま数十秒〜数分かかることがあり、
      // スタッフには「起動しない」に見えて受付が詰まる（例外は catch できても
      // ハングは catch できない）。時間予算で打ち切る作りにもしてある。
      this.resultsDirForCleanup = resultsDir;
      this.runStartupConsistencyCheck(resultsDir);
    });

    app.on('window-all-closed', async () => {
      if (process.platform === 'darwin') return;

      // 🔴 **ウィンドウが1枚も無くなったら、確認の有無にかかわらず終了する。**
      //
      // 以前は exitConfirmed が false のとき「取り消されたのだろう」と何もしなかった。
      // ところが取り消した場合はそもそも close を preventDefault しているので
      // ウィンドウは閉じていない。**ここへ来た時点で画面は無い。**
      // その状態で残ると、確認を出す相手も取り消す手段も無いまま
      // **プロセスだけが生き続ける**。
      //
      // このアプリは requestSingleInstanceLock で二重起動を防いでいるため、
      // 残ったプロセスがロックを握り続け、次に start-kidspg.bat で起こしても
      // 新しいインスタンスが即座に自滅する＝**「終了したのに二度と起動できない」**。
      // 当日これが起きると受付が止まる（2026-09-04 に実機で発生）。
      this.exitConfirmed = true;
      this.armForceExit();

      try {
        // 落ちているのに準備OKの印が残らないようにする
        await clearReadiness(this.getBundleRoot());
        if (this.comfyUIService) {
          await this.comfyUIService.destroy();
        }
        if (this.resultsDirForCleanup) {
          await this.releaseMaintenanceLockOnExit(this.resultsDirForCleanup);
        }
      } catch (error) {
        // 片付けに失敗しても終了は続ける。ここで止まるほうが害が大きい
        console.error('終了時の片付けに失敗しましたが、終了を続けます', error);
      }
      app.quit();
    });

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await this.createMainWindow();
      }
    });
  }

  private async createMainWindow(): Promise<void> {
    this.mainWindow = new BrowserWindow({
      width: WINDOW_CONFIG.main.width,
      height: WINDOW_CONFIG.main.height,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        webSecurity: true,
        // 音声自動再生を許可
        autoplayPolicy: 'no-user-gesture-required',
        // カメラとマイクアクセスを許可
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        // GPU プロセス クラッシュ対策
        backgroundThrottling: false
      },
      icon: path.join(__dirname, '../../../assets/icon.ico'),
      title: 'KidsPG - AIグミパク！'
    });

    // 開発環境ではViteサーバー、本番環境では静的ファイルを読み込み
    if (process.env.NODE_ENV === 'development') {
      this.mainWindow.loadURL('http://localhost:3000');
      this.mainWindow.webContents.openDevTools();
    } else {
      // 複数のパスを試行してindex.htmlを見つける
      const indexPaths = [
        path.join(__dirname, '../../renderer/index.html'),  // dist/main/main -> dist/renderer/index.html
        path.join(__dirname, '../renderer/index.html'),     // dist/main -> dist/renderer/index.html
        path.join(__dirname, 'renderer/index.html'),        // 直接
      ];
      
      let indexLoaded = false;
      
      for (const indexPath of indexPaths) {
        try {
          await fs.access(indexPath);
          await this.mainWindow.loadFile(indexPath);
          console.log(`Successfully loaded index.html from: ${indexPath}`);
          indexLoaded = true;
          break;
        } catch {
          console.log(`Failed to load from path: ${indexPath}`);
        }
      }
      
      if (!indexLoaded) {
        console.error('Could not find index.html in any expected location');
        this.mainWindow?.loadURL('data:text/html,<h1>アプリケーション読み込み中...</h1>');
      }
    }

    // ウィンドウのXボタンクリック時に終了確認を表示
    this.mainWindow.on('close', async (event) => {
      if (!this.exitConfirmed) {
        event.preventDefault();
        await this.showExitConfirmation();
      }
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });
  }

  private createRankingWindow(): void {
    if (this.rankingWindow) {
      this.rankingWindow.focus();
      return;
    }

    this.rankingWindow = new BrowserWindow({
      width: WINDOW_CONFIG.ranking.width,
      height: WINDOW_CONFIG.ranking.height,
      autoHideMenuBar: true,
      parent: this.mainWindow || undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
      title: 'ランキング表示'
    });

    // 開発環境ではViteサーバー、本番環境では静的ファイルを読み込み
    if (process.env.NODE_ENV === 'development') {
      this.rankingWindow.loadURL('http://localhost:3000/ranking.html');
      this.rankingWindow.webContents.openDevTools();
    } else {
      const rankingPath = path.join(__dirname, '../../renderer/ranking.html');
      this.rankingWindow.loadFile(rankingPath).catch((error) => {
        console.error(`Ranking file not found: ${rankingPath}`, error);
        // ファイルが存在しない場合はプレースホルダーを表示
        this.rankingWindow?.loadURL('data:text/html,<h1>ランキング準備中...</h1>');
      });
    }

    this.rankingWindow.on('closed', () => {
      this.rankingWindow = null;
    });
  }

  private setupIPC(): void {
    // 写真を保存し、結果保存用のディレクトリを作成する
    ipcMain.handle('save-photo', async (event, imageData: string, isDummy: boolean = false) => {
      try {
        const dateTime = getFormattedDateTime(new Date());
        const dirPath = path.join(resolveResultsDir(), dateTime);
        await fs.mkdir(dirPath, { recursive: true });

        const photoFileName = `photo_${dateTime}.png`;
        const filePath = path.join(dirPath, photoFileName);
        const base64Data = imageData.replace(/^data:image\/png;base64,/, '');
        
        if (isDummy) {
          // ダミー画像の場合、dummy_photo.pngを直接コピー
          let dummyPhotoPath: string;
          if (app.isPackaged) {
            // 本番環境: exeファイルと同じディレクトリの assets フォルダ
            dummyPhotoPath = path.join(path.dirname(app.getPath('exe')), 'assets', 'dummy_photo.png');
          } else {
            // 開発環境: プロジェクトルートの assets フォルダ
            dummyPhotoPath = path.join(app.getAppPath(), 'src', 'renderer', 'assets', 'images', 'dummy_photo.png');
          }
          
          try {
            await fs.copyFile(dummyPhotoPath, filePath);
            // ダミー画像用のphoto_anime_*.pngも即座に作成
            const animePhotoPath = path.join(dirPath, `photo_anime_${dateTime}.png`);
            await fs.copyFile(dummyPhotoPath, animePhotoPath);
          } catch (copyError) {
            console.warn('Failed to copy dummy_photo.png, using generated image:', copyError);
            await fs.writeFile(filePath, base64Data, 'base64');
            
            // catchブロックでもphoto_anime_*.pngを作成
            try {
              const animePhotoPath = path.join(dirPath, `photo_anime_${dateTime}.png`);
              await fs.writeFile(animePhotoPath, base64Data, 'base64');
            } catch (animeError) {
              console.error('Failed to create photo_anime file:', animeError);
            }
          }
        } else {
          // 実画像の場合、通常通り保存
          await fs.writeFile(filePath, base64Data, 'base64');
        }
        
        if (isDummy) {
          // ダミー画像の場合：メモリアルカード生成はresult.json保存後に実行
        } else {
          // 実画像の場合：通常のComfyUI処理
          if (this.comfyUI) {
            const comfy = this.comfyUI;
            try {
              const { template } = await this.loadWorkflowTemplate(comfy);

              // 変数置換（${filename_prefix} / ${photo_png} / seed の振り直し）と
              // config.json の生成パラメータの焼き込み。
              // 実装は services/workflow-template.ts に集約してある。
              // 検証ツール（tools/comfyui-smoke.cjs）も同じ関数を使うため、ここに再実装を戻さないこと。
              const workflowTemplate = applyWorkflowVariables(template, {
                outputPrefix: `${comfy.workflow.outputPrefix}_${dateTime}`,
                photoFileName,
                generation: comfy.generation,
              });

              // 設定と配線が噛み合っていない場合はログに残す（生成自体は続ける）。
              // 起動時にも同じ点検をしてスタッフへ知らせている。
              const generationWarnings = [
                ...checkGenerationWiring(workflowTemplate),
                ...checkGenerationApplied(workflowTemplate, comfy.generation),
              ];
              for (const warning of generationWarnings) {
                console.warn('[ComfyUI] 生成パラメータの警告:', warning);
              }

              const imageGeneratePath = path.join(dirPath, 'image_generate.json');
              await fs.writeFile(imageGeneratePath, JSON.stringify(workflowTemplate, null, 2));

              // ComfyUIが有効な場合、即座に画像をアップロード＆変換開始
              if (this.comfyUIService) {
                try {
                  // 1. プリアップロード
                  await this.comfyUIService.preUploadImage(base64Data, dateTime);
                  
                  // 2. 即座に変換開始
                  await this.comfyUIService.transformImage({
                    imageData: base64Data,
                    datetime: dateTime,
                    resultDir: dirPath
                  });
                } catch (error) {
                  console.warn('Pre-upload or transform failed, will handle later:', error);
                }
              }
            } catch (error) {
              console.error('[ComfyUI] CRITICAL - Failed to process template or start transformation:', error);
              console.error('[ComfyUI] Template path attempted:', comfy.workflow.templatePath);
              console.error('[ComfyUI] Error details:', {
                type: typeof error,
                name: error instanceof Error ? error.name : 'Unknown',
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : 'No stack'
              });
              
              // ComfyUIが利用できない場合でも、ゲーム自体は継続する
              console.warn('[ComfyUI] ComfyUI処理をスキップして続行します。画像生成は行われません。');
            }
          }
        }

        return { success: true, dirPath: dirPath };
      } catch (error) {
        console.error('Failed to save photo:', error);
        return { success: false, error: String(error) };
      }
    });

    // JSONデータを指定されたディレクトリに保存する
    ipcMain.handle('save-json', async (event, dirPath: string, jsonData: object) => {
      try {
        const filePath = path.join(dirPath, 'result.json');
        await fs.writeFile(filePath, JSON.stringify(jsonData, null, 2));
        
        const dateTime = path.basename(dirPath);
        
        if (this.memorialCardService) {
          // 既に何らかの処理が進行中の場合は警告を出してスキップ
          if (this.memorialCardGenerationFlags.has(dateTime)) {
            console.warn(`ElectronApp - Memorial card generation already in progress for: ${dateTime}`);
            return { success: true, filePath: filePath };
          }
          
          // ダミーカード生成処理を開始
          this.memorialCardGenerationFlags.set(dateTime, 'dummy_inprogress');
          
          setTimeout(async () => {
            try {
              if (this.memorialCardService) {
                const result = await this.memorialCardService.generateDummyMemorialCard(
                  dateTime,
                  dirPath,
                  jsonData as GameResult
                );
                
                if (result.success) {
                  // ダミーカード生成完了
                  this.memorialCardGenerationFlags.set(dateTime, 'dummy_completed');
                  console.log(`ElectronApp - Dummy memorial card generated successfully: ${result.outputPath}`);

                  // AI変換が先に終わっていた場合、ここで消化する
                  const pendingJobId = this.pendingAICompletions.get(dateTime);
                  if (pendingJobId) {
                    console.log(`ElectronApp - Consuming pending AI completion for ${dateTime}`);
                    await this.runAIMemorialCard(pendingJobId, dirPath, dateTime);
                  }
                } else {
                  console.error(`ElectronApp - Dummy memorial card generation failed: ${result.error}`);
                  // エラー時はフラグを削除してリトライ可能にする
                  this.memorialCardGenerationFlags.delete(dateTime);
                  // ダミーが作れなくても、AI画像が届いているなら本カードは作る
                  const pendingJobId = this.pendingAICompletions.get(dateTime);
                  if (pendingJobId) {
                    await this.runAIMemorialCard(pendingJobId, dirPath, dateTime);
                  }
                }
              }
            } catch (error) {
              console.error('ElectronApp - Dummy memorial card generation error:', error);
              // エラー時はフラグを削除してリトライ可能にする
              this.memorialCardGenerationFlags.delete(dateTime);
              // 🔴 **保留中のAI完了を必ず消化する。**
              // 消化はこのコールバックの中にしか無いので、ここで抜けると
              // 「AI画像は届いているのにカードが1枚も作られない」まま誰も気づかない
              // （ダミーも失敗しているので、その子のカードは存在しなくなる）。
              const pendingJobId = this.pendingAICompletions.get(dateTime);
              if (pendingJobId) {
                await this.runAIMemorialCard(pendingJobId, dirPath, dateTime).catch((e) => {
                  console.error('ElectronApp - Pending AI card generation failed:', e);
                });
              }
            }
          }, 100);
        }
        
        // Update results.json
        if (this.resultsManager) {
          // ここで失敗すると、その子のプレイがランキングにも履歴にも一切現れない。
          // OneDrive 同期やランキング画面の監視と競合して EBUSY/EPERM になり得るのでリトライする。
          let indexed = false;
          for (let attempt = 1; attempt <= 3 && !indexed; attempt++) {
            try {
              console.log(`Updating results index for: ${dirPath} (attempt ${attempt})`);
              await this.resultsManager.updateResults(dirPath, jsonData as GameResult);
              console.log('Results index updated successfully');
              indexed = true;
            } catch (error) {
              console.error(`Failed to update results index (attempt ${attempt}):`, error);
              if (attempt < 3) await new Promise((r) => setTimeout(r, 500));
            }
          }
          if (!indexed) {
            console.error('CRITICAL: results.json を更新できませんでした。このプレイはランキングに出ません:', dirPath);
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
              this.mainWindow.webContents.send('startup-warning', {
                kind: 'results-index-failed',
                message: `記録の保存に失敗しました（${path.basename(dirPath)}）。スタッフへ知らせてください。`,
              });
            }
          }
        } else {
          console.error('ResultsManager not initialized');
        }
        
        return { success: true, filePath: filePath };
      } catch (error) {
        console.error('Failed to save JSON:', error);
        return { success: false, error: String(error) };
      }
    });

    // ランキングウィンドウ表示
    ipcMain.handle('show-ranking-window', () => {
      this.createRankingWindow();
    });

    // ランキングウィンドウ閉じる
    ipcMain.handle('close-ranking-window', () => {
      if (this.rankingWindow) {
        this.rankingWindow.close();
      }
    });

    // ランキングデータ取得
    ipcMain.handle('ranking:get-data', async () => {
      if (!this.rankingService) {
        console.error('RankingService not initialized.');
        return null;
      }
      return await this.rankingService.getRankingData();
    });

    // ランキング設定取得
    ipcMain.handle('ranking:get-config', async () => {
      if (!this.rankingService) {
        console.error('RankingService not initialized.');
        return null;
      }
      return await this.rankingService.getRankingConfig();
    });

    // 設定情報を取得
    /**
     * renderer から「画面が出て、カメラの初期化まで終わった」と報告が来たときに、
     * main 側の事実（ComfyUI の疎通・results に書けるか）を足して ready.json を書く。
     *
     * これが起動バッチの「準備完了」の根拠になる。**アプリを起こしたことと、
     * 準備できたことは別**で、以前はそこを区別していなかったため、起動に失敗しても
     * バッチが「問題なし」と表示できてしまっていた。
     */
    ipcMain.handle('app-ready', async (event, info: unknown) => {
      try {
        const renderer = info as RendererReadiness;
        const resultsDir = resolveResultsDir();
        const base: Omit<ReadinessReport, 'warnings'> = {
          assetsLoaded: !!renderer?.assetsLoaded,
          cameraReady: !!renderer?.cameraReady,
          usingDummyCamera: !!renderer?.usingDummyCamera,
          screen: typeof renderer?.screen === 'string' ? renderer.screen : '(不明)',
          readyAt: new Date().toISOString(),
          appVersion: app.getVersion(),
          packaged: app.isPackaged,
          pid: process.pid,
          comfyui: this.comfyUI
            ? {
                profile: this.comfyUI.profileName,
                baseUrl: this.comfyUI.baseUrl,
                // 疎通は起動時にも見ているが、ここでもう一度見る。
                // 起動の途中で ComfyUI が落ちた場合に気づけるようにするため
                healthy: this.comfyUIService ? await this.comfyUIService.healthCheck() : false,
              }
            : null,
          results: { dir: resultsDir, writable: await checkResultsWritable(resultsDir) },
        };
        const report: ReadinessReport = { ...base, warnings: buildReadinessWarnings(base) };
        await writeReadiness(this.getBundleRoot(), report);
        if (report.warnings.length === 0) {
          console.log('[準備確認] 準備OK');
        } else {
          for (const w of report.warnings) console.warn('[準備確認] ' + w);
        }
        return { success: true, warnings: report.warnings };
      } catch (error) {
        // 印を書けなくてもゲームは動く。バッチが「確かめられなかった」と言うだけにする
        console.error('[準備確認] ready.json を書けませんでした:', error);
        return { success: false, error: String(error) };
      }
    });

    ipcMain.handle('get-config', () => {
      return this.config;
    });

    // 設定ファイルを再読み込み
    ipcMain.handle('reload-config', async () => {
      try {
        this.config = await this.loadConfig();
        // 解決済みの ComfyUI 設定も作り直す。ここを忘れると、手で config.json を
        // 編集して再読み込みしても生成パラメータが古いまま使われる
        const restartRequired = this.refreshResolvedComfyUI();
        const warnings = await this.collectGenerationWarnings();
        return { success: true, config: this.config, restartRequired, warnings };
      } catch (error) {
        console.error('設定ファイルの再読み込みに失敗しました:', error);
        return { success: false, error: String(error) };
      }
    });

    // 設定を config.json へ書き戻す。
    //
    // 受け取るのは config-writer.ts の ConfigPatch 形だけで、キーごとに型と範囲を
    // 検査してから書く（レンダラ由来の値をそのまま設定ファイルへ流し込まない）。
    // 保存直前にディスクから読み直すのは、アプリ起動中に手でエディタから
    // 編集された分を、画面が抱えている古い値で踏み潰さないため。
    ipcMain.handle('save-config', async (event, patch: unknown) => {
      try {
        const configPath = this.getConfigPath();
        const currentRaw = JSON.parse(await fs.readFile(configPath, 'utf-8'));

        const { config: nextConfig, errors } = applyConfigPatch(currentRaw, patch);
        if (errors.length > 0) {
          return { success: false, error: '入力に誤りがあります:\n' + errors.map((e) => '・' + e).join('\n') };
        }

        // 解決できない設定を書き込まない。ここで弾けば、次回起動時に
        // 「AI変換なし」で立ち上がる状態を保存してしまうのを防げる
        if (nextConfig.comfyui) {
          try {
            resolveComfyUIConfig(nextConfig.comfyui as Parameters<typeof resolveComfyUIConfig>[0]);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, error: 'ComfyUI 設定が不正なため保存しませんでした: ' + message };
          }
        }

        // 一時ファイルへ書いてから rename。途中で落ちても、
        // 読めない config.json が残らない（起動できなくなるのを防ぐ）
        const tempPath = `${configPath}.tmp-${process.pid}`;
        await fs.writeFile(tempPath, JSON.stringify(nextConfig, null, 2) + '\n', 'utf-8');
        await fs.rename(tempPath, configPath);

        this.config = nextConfig as unknown as AppConfig;

        // 生成パラメータは撮影のたびにテンプレートを読み直して適用するため、
        // ここで解決結果を差し替えるだけで次のプレイから効く。
        // 一方 baseUrl / templatePath / timeouts は ComfyUIService の初期化時に
        // 渡してあるので、変えるならアプリの再起動が必要（画面にもそう出している）。
        const restartRequired = this.refreshResolvedComfyUI();
        const warnings = [
          ...(this.comfyUI?.warnings ?? []),
          ...(await this.collectGenerationWarnings()),
        ];
        for (const warning of warnings) {
          console.warn('[ComfyUI] 生成パラメータの警告:', warning);
        }

        return { success: true, config: this.config, restartRequired, warnings };
      } catch (error) {
        console.error('設定ファイルの保存に失敗しました:', error);
        return { success: false, error: String(error) };
      }
    });

    // 現在の設定を焼き込んだワークフローを、ComfyUI のブラウザ画面へ
    // ドラッグ＆ドロップできる JSON として書き出す。
    //
    // 「ComfyUI をブラウザで開く」だけでは、画面に出るのはそのブラウザが
    // 最後に編集していたグラフであって、ゲームが投げているものではない。
    // ComfyUI のフロントエンドは API 形式（各値が class_type を持つ JSON）を
    // 落とすとグラフへ復元してくれるため、ゲームと同一の内容をそのまま渡せる。
    ipcMain.handle('export-comfyui-workflow', async () => {
      try {
        const comfy = this.comfyUI;
        if (!comfy) return { success: false, error: 'ComfyUI の設定が読めていません' };

        const { template } = await this.loadWorkflowTemplate(comfy);
        const workflow = applyWorkflowVariables(template, {
          outputPrefix: `${comfy.workflow.outputPrefix}_manual`,
          // ブラウザ側では写真をこのノードへドラッグ＆ドロップして差し替える。
          // 実在しないファイル名を入れておくと LoadImage が赤くなり、
          // 「ここに写真を落とす」と分かる
          photoFileName: 'ここに写真をドラッグしてください.png',
          generation: comfy.generation,
        });

        // 本番は exe と同じ場所（Program Files 配下だと EPERM で書けない）を避け、
        // OS のテンポラリへ出す。開く場所は showItemInFolder が案内する。
        const outDir = app.isPackaged
          ? path.join(app.getPath('temp'), 'kidspg-workflow')
          : path.join(this.getBundleRoot(), 'tmp');
        await fs.mkdir(outDir, { recursive: true });
        const outPath = path.join(outDir, `comfyui-workflow-${comfy.profileName}.json`);
        await fs.writeFile(outPath, JSON.stringify(workflow, null, 2) + '\n', 'utf-8');

        shell.showItemInFolder(outPath);
        return {
          success: true,
          filePath: outPath,
          warnings: [
            ...checkGenerationWiring(workflow),
            ...checkGenerationApplied(workflow, comfy.generation),
          ],
        };
      } catch (error) {
        console.error('ワークフローの書き出しに失敗しました:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    // ComfyUI の画面を既定ブラウザで開く。
    // 当日その場でプロンプトや KSampler の値を見たいときのための入口。
    // **任意の URL は開かない**。設定で解決した ComfyUI の接続先と同じ生成元のみ許す
    // （レンダラが乗っ取られても、外部サイトを開かせる踏み台にしない）。
    ipcMain.handle('open-comfyui-ui', async () => {
      try {
        const baseUrl = this.comfyUI?.baseUrl;
        if (!baseUrl) return { success: false, error: 'ComfyUI の接続先が設定されていません' };
        const url = new URL(baseUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return { success: false, error: '対応していないプロトコルです: ' + url.protocol };
        }
        await shell.openExternal(url.toString());
        return { success: true, url: url.toString() };
      } catch (error) {
        console.error('ComfyUI の画面を開けませんでした:', error);
        return { success: false, error: String(error) };
      }
    });

    // ComfyUI を起動する（起動バッチを、開いたままの PowerShell ウィンドウで走らせる）。
    // **叩くのは config.json で解決したパスだけ**。画面からパスは受け取らない。
    ipcMain.handle('comfyui-launch', async () => {
      const paths = this.comfyUI?.paths;
      if (!paths) {
        return {
          success: false,
          error:
            'いま選ばれているプロファイル（' +
            (this.comfyUI?.profileName ?? '不明') +
            '）には ComfyUI の物理パスが設定されていません。' +
            '別の機体で動かしている場合はそちらで起動してください',
        };
      }
      // すでに応答しているなら起動しない。二重に立てるとポートが埋まっていて
      // 後から立てたほうが即座に落ちるだけだが、窓が増えてどれが本体か分からなくなる。
      if (this.comfyUIService && (await this.comfyUIService.healthCheck())) {
        return { success: true, alreadyRunning: true, startBat: paths.startBat };
      }
      const outcome = await launchComfyUI(paths);
      if (!outcome.success) {
        console.error('[ComfyUI] 起動に失敗:', outcome.error);
      } else {
        console.log('[ComfyUI] 起動バッチを実行しました:', outcome.startBat);
      }
      return { ...outcome, alreadyRunning: false };
    });

    // ComfyUI の input / output フォルダをエクスプローラーで開く。
    // 当日「写真が上がっているか」「絵が出ているか」を目で確かめるための入口。
    ipcMain.handle('comfyui-open-folder', async (event, which: unknown) => {
      const paths = this.comfyUI?.paths;
      if (!paths) {
        return { success: false, error: 'ComfyUI の物理パスが設定されていません' };
      }
      // 開けるのは2箇所だけ。レンダラから任意のパスは受け取らない
      if (which !== 'input' && which !== 'output') {
        return { success: false, error: '開けるのは input / output だけです' };
      }
      const target = which === 'input' ? paths.input : paths.output;
      const failure = await shell.openPath(target);
      // openPath は失敗を**例外ではなく文字列**で返す（空文字なら成功）
      if (failure) {
        console.error('[ComfyUI] フォルダを開けませんでした:', target, failure);
        return { success: false, error: target + ' を開けませんでした: ' + failure };
      }
      return { success: true, path: target };
    });

    // ComfyUI画像変換リクエスト
    ipcMain.handle('comfyui-transform', async (event, imageData: string, datetime: string, resultDir: string) => {
      try {
        if (!this.comfyUIService) {
          return { success: false, error: 'ComfyUI service not initialized' };
        }

        // 既存のジョブをdatetimeで重複チェック
        const activeJobs = this.comfyUIService.getActiveJobs();
        const existingJob = activeJobs.find(job => job.datetime === datetime);
        if (existingJob) {
          return { success: false, error: `Job already exists for ${datetime}` };
        }

        const jobId = await this.comfyUIService.transformImage({
          imageData,
          datetime,
          resultDir
        });

        return { success: true, jobId };
      } catch (error) {
        console.error('ComfyUI transformation failed:', error);
        return { success: false, error: String(error) };
      }
    });

    // ComfyUIステータス取得
    ipcMain.handle('comfyui-status', async () => {
      try {
        if (!this.comfyUIService) {
          return { success: false, error: 'ComfyUI service not initialized' };
        }

        const status = await this.comfyUIService.getStatus();
        return { success: true, status };
      } catch (error) {
        console.error('ComfyUI status check failed:', error);
        return { success: false, error: String(error) };
      }
    });

    // ComfyUIヘルスチェック
    ipcMain.handle('comfyui-health-check', async () => {
      try {
        if (!this.comfyUIService) {
          return { success: false, isHealthy: false };
        }

        const isHealthy = await this.comfyUIService.healthCheck();
        return { success: true, isHealthy };
      } catch (error) {
        console.error('ComfyUI health check failed:', error);
        return { success: false, isHealthy: false };
      }
    });

    // ComfyUIアクティブジョブ取得
    ipcMain.handle('comfyui-active-jobs', async () => {
      try {
        if (!this.comfyUIService) {
          return { success: false, jobs: [] };
        }

        const jobs = this.comfyUIService.getActiveJobs();
        return { success: true, jobs };
      } catch (error) {
        console.error('ComfyUI active jobs check failed:', error);
        return { success: false, jobs: [] };
      }
    });

    // ComfyUIジョブキャンセル
    ipcMain.handle('comfyui-cancel-job', async (event, datetime: string) => {
      try {
        if (!this.comfyUIService) {
          return { success: false, error: 'ComfyUI service not initialized' };
        }

        const canceled = await this.comfyUIService.cancelJob(datetime);
        return { success: canceled };
      } catch (error) {
        console.error('ComfyUI job cancel failed:', error);
        return { success: false, error: String(error) };
      }
    });

    // 新しいIPCハンドラ: アセットの絶対パスを取得
    ipcMain.handle('get-asset-absolute-path', async (event, relativePath: string) => {
      
      try {
        let assetPath: string;
        
        if (app.isPackaged) {
          // 本番環境: ASARパッケージ内のdist/renderer/assetsフォルダのアセットにアクセス
          // relativePath例: "assets/sounds/action.mp3" -> "dist/renderer/assets/action.mp3"
          const assetFileName = relativePath.replace(/^assets\/(sounds|images)\//, '');
          
          assetPath = path.join(__dirname, '../../renderer/assets', assetFileName);
          
          // ファイル存在確認
          try {
            await fs.access(assetPath);
          } catch (accessError) {
            console.error(`main.ts: [PACKAGED] ❌ Asset file NOT FOUND: ${assetPath}`);
            console.error(`main.ts: [PACKAGED] Access error:`, accessError);
            
            // 代替パスをいくつか試行
            const alternativePaths = [
              path.join(__dirname, '../renderer/assets', assetFileName),
              path.join(__dirname, 'renderer/assets', assetFileName),
              path.join(__dirname, '../../assets', assetFileName),
              path.join(path.dirname(app.getPath('exe')), 'resources', relativePath)
            ];
            
            let foundAlternative = false;
            
            for (const altPath of alternativePaths) {
              try {
                await fs.access(altPath);
                assetPath = altPath;
                foundAlternative = true;
                break;
              } catch {
                // Continue to next alternative
              }
            }
            
            if (!foundAlternative) {
              console.error(`main.ts: [PACKAGED] CRITICAL - No valid asset path found for: ${relativePath}`);
            }
          }
        } else {
          // 開発環境: src/renderer/assetsフォルダのアセットにアクセス
          assetPath = path.join(app.getAppPath(), 'src/renderer', relativePath);
          
          // 開発環境でもファイル存在確認
          try {
            await fs.access(assetPath);
          } catch (accessError) {
            console.error(`main.ts: [DEV] ❌ Asset file NOT FOUND: ${assetPath}`);
            console.error(`main.ts: [DEV] Access error:`, accessError);
          }
        }
        
        return assetPath;
        
      } catch (error) {
        console.error('main.ts: CRITICAL - Error resolving asset path:', error);
        console.error('main.ts: Error details:', {
          type: typeof error,
          name: error instanceof Error ? error.name : 'Unknown',
          message: error instanceof Error ? error.message : String(error)
        });
        
        // フォールバック: 従来の方法
        const appPath = app.isPackaged
          ? path.dirname(app.getPath('exe'))
          : app.getAppPath();

        const resourcesPath = app.isPackaged
          ? path.join(appPath, 'resources')
          : appPath;

        const absoluteAssetPath = path.join(resourcesPath, relativePath);
        
        // フォールバックパスも存在確認
        try {
          await fs.access(absoluteAssetPath);
        } catch (fallbackError) {
          console.error(`main.ts: [FALLBACK] ❌ Fallback path also not found: ${absoluteAssetPath}`, fallbackError);
        }
        
        return absoluteAssetPath;
      }
    });

    // 画像のデータURLを取得する
    ipcMain.handle('get-image-data-url', async (event, relativePath: string) => {
      try {
        const resultsDir = resolveResultsDir();
        
        const imagePath = path.join(resultsDir, relativePath);
        // レンダラー由来のパスなので results 配下から出ないことを確認する
        const rel = path.relative(resultsDir, imagePath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          console.warn(`results の外を指すパスを拒否しました: ${relativePath}`);
          return null;
        }

        // ファイル存在確認を事前に実行
        try {
          await fs.access(imagePath);
        } catch {
          // ファイルが存在しない場合は静かにnullを返す
          return null;
        }

        const data = await fs.readFile(imagePath);
        const base64 = Buffer.from(data).toString('base64');
        return `data:image/png;base64,${base64}`;
      } catch (error) {
        // 予期しないエラーのみログ出力
        console.error(`Unexpected error getting image data url for ${relativePath}:`, error);
        return null;
      }
    });

    /**
     * 画面の「終了」ボタンからの終了要求。
     *
     * 🔴 **レンダラーで window.close() を呼んではいけない。**
     * あれはウィンドウを即座に破棄し、`mainWindow.on('close')` の
     * preventDefault が間に合わない（2026-09-04 に実機で確認。
     * **終了確認ダイアログが一度も出ないまま画面が消え**、
     * 生成中のジョブがあっても警告できていなかった）。
     * さらに exitConfirmed が false のまま window-all-closed へ落ちるため、
     * 以前はプロセスだけが residual になっていた。
     *
     * main 側から app.quit() を呼べば before-quit を通るので、
     * ウィンドウの × と同じ確認ダイアログが出る。
     */
    ipcMain.handle('request-exit', () => {
      app.quit();
    });

    // 終了確認関連のIPCハンドラー
    ipcMain.handle('get-comfyui-status-for-exit', async () => this.collectExitStatus());

    ipcMain.handle('confirm-exit', async (event, confirmed: boolean) => {
      if (confirmed) {
        this.exitConfirmed = true;
        app.quit();
      }
    });
  }

  /**
   * ImageMagick(magick) が PATH にあるか起動時に1度だけ確認する。
   * 無いと記念カードが全員ダミーのまま、かつ画面上は何も起きないので、
   * ランキングが全部ダミー写真になるまで気付けない。
   */
  private async checkImageMagick(): Promise<void> {
    try {
      const { spawn } = await import('child_process');
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('magick', ['-version'], { shell: true });
        proc.on('error', reject);
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });
      console.log('ImageMagick: OK');
    } catch (error) {
      console.error('ImageMagick(magick) が見つかりません。記念カードは生成されません。', error);
      this.warnAtStartup(
        'imagemagick-missing',
        'ImageMagick が見つかりません。記念カードが作られません。PATH を確認してください。'
      );
    }
  }

  /**
   * ComfyUI が起動しているかを開店前に確かめる。
   *
   * 起動を忘れていても、カードの前景は固定のプレースホルダへ自動で退避するため
   * アプリは何事もなく動いてしまう。つまり**気づかないまま全員が同じ絵のカード**になる。
   * 静かに劣化するのが一番まずいので、ここで能動的に確認して知らせる。
   */
  private async checkComfyUI(): Promise<void> {
    if (!this.config?.comfyui || !this.comfyUI) {
      console.log('ComfyUI: 設定が無効（AI変換なしで動作します）');
      return;
    }
    const comfy = this.comfyUI;
    if (!this.comfyUIService) {
      this.warnAtStartup(
        'comfyui-unavailable',
        'ComfyUI サービスを初期化できませんでした。AI変換なし（全員が同じプレースホルダ画像）でカードを作ります。'
      );
      return;
    }
    // 設定（config.json の generation）とワークフローの配線が噛み合っているかを開店前に点検する。
    // denoise=1 のままだと「写真をアニメ調に変換している」つもりで、実際には
    // 輪郭以外まったく反映されていない絵が全員に出る。静かに劣化するので必ず知らせる。
    await this.checkGenerationSettings(comfy);

    const healthy = await this.comfyUIService.healthCheck();
    if (healthy) {
      console.log(`ComfyUI: OK (${comfy.baseUrl} / プロファイル ${comfy.profileName})`);
      return;
    }
    console.error(`ComfyUI に接続できません: ${comfy.baseUrl}`);
    this.warnAtStartup(
      'comfyui-unavailable',
      [
        `ComfyUI に接続できません（${comfy.baseUrl} / プロファイル「${comfy.profileLabel}」）。`,
        'このままでも遊べますが、カードの絵は全員同じプレースホルダになります（撮影した写真は使いません）。',
        'AI変換を使うなら ComfyUI を起動してから、このアプリを起動し直してください。',
      ].join('\n')
    );
  }

  /**
   * 生成パラメータとワークフローの配線を開店前に点検する。
   * 生成そのものは止めない（多少ずれた絵でもカードが1枚できる方がよい）が、
   * スタッフには必ず知らせる。
   */
  private async checkGenerationSettings(comfy: ResolvedComfyUIConfig): Promise<void> {
    try {
      const { template } = await this.loadWorkflowTemplate(comfy);
      const workflow = applyWorkflowVariables(template, {
        outputPrefix: comfy.workflow.outputPrefix,
        photoFileName: 'startup-check.png',
        generation: comfy.generation,
      });
      const warnings = [
        ...checkGenerationWiring(workflow),
        ...checkGenerationApplied(workflow, comfy.generation),
      ];
      if (warnings.length === 0) return;
      for (const warning of warnings) {
        console.warn('[ComfyUI] 生成パラメータの警告:', warning);
      }
      this.warnAtStartup(
        'comfyui-generation-params',
        ['生成パラメータの設定を確認してください。', ...warnings.map((w) => '・' + w)].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ComfyUI] ワークフローの点検に失敗:', message);
      this.warnAtStartup(
        'comfyui-template-invalid',
        ['ワークフローを読めませんでした。AI変換なしでカードを作ります。', message].join('\n')
      );
    }
  }

  /** 起動時警告のダイアログを直列に出すためのキュー。 */
  private startupWarningChain: Promise<unknown> = Promise.resolve();

  /**
   * 起動時の警告をスタッフに届ける。
   *
   * renderer への 'startup-warning' は現状どの画面も購読していないため、
   * それだけでは誰にも見えない。確実に気づけるよう OS のダイアログも出す。
   *
   * ・親ウィンドウを渡してモーダルにする。渡さないと独立ウィンドウとして開き、
   *   スタッフが気づく前に子どもがそのまま遊び始められる。
   * ・await せずチェーンに積むのは、ダイアログを閉じるまでアプリの初期化を止めないため。
   *   複数の警告（ImageMagick 欠落と ComfyUI 未接続）が同時に出ても重ならないよう直列化する。
   */
  private warnAtStartup(kind: string, message: string): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('startup-warning', { kind, message });
    }
    const options: MessageBoxOptions = {
      type: 'warning',
      title: 'KidsPG AIグミパク！ - 起動時の確認',
      message,
      buttons: ['OK'],
      noLink: true,
    };
    this.startupWarningChain = this.startupWarningChain
      .then(() => (this.mainWindow && !this.mainWindow.isDestroyed()
        ? dialog.showMessageBox(this.mainWindow, options)
        : dialog.showMessageBox(options)))
      .catch((error) => { console.error('起動時警告の表示に失敗しました:', error); });
  }

  private async initializeServices(): Promise<void> {
    // メモリアルカードサービスは常に初期化（ComfyUIに依存しない）
    await this.initializeMemorialCardService();
    
    // ComfyUIサービスは設定がある場合のみ初期化
    await this.initializeComfyUI();

    // RankingServiceを初期化
    this.rankingService = new RankingService();
    this.setupRankingWatcher();
  }

  private async initializeMemorialCardService(): Promise<void> {
    try {
      if (!this.config?.memorialCard) {
        return;
      }

      this.memorialCardService = new MemorialCardService(
        this.config.memorialCard,
        this.mainWindow || undefined
      );
    } catch (error) {
      console.error('Memorial Card Service initialization failed:', error);
      this.memorialCardService = null;
    }
  }

  private async initializeComfyUI(): Promise<void> {
    try {
      if (!this.config?.comfyui) {
        return;
      }

      // activeProfile を解決して、ワーカーが理解できるフラットな形へ畳む。
      // 解決に失敗したら黙って既定へ倒さず、AI変換なしで進める（理由はスタッフに見せる）。
      try {
        this.comfyUI = resolveComfyUIConfig(this.config.comfyui);
        console.log(`[ComfyUI] プロファイル: ${this.comfyUI.profileName} (${this.comfyUI.profileLabel})`);
        console.log(`[ComfyUI] baseUrl=${this.comfyUI.baseUrl} template=${this.comfyUI.workflow.templatePath}`);
        console.log('[ComfyUI] 生成パラメータ（config.json が上書きする分）:', this.comfyUI.generation);
        for (const warning of this.comfyUI.warnings) {
          console.warn('[ComfyUI] 設定の警告:', warning);
        }
      } catch (error) {
        this.comfyUI = null;
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ComfyUI] プロファイルの解決に失敗:', message);
        this.warnAtStartup('comfyui-profile-invalid',
          `ComfyUI の設定（config.json の comfyui）が読めません。
${message}
AI変換なしで動作します。`);
        return;
      }

      // ComfyUIServiceは画像変換のみを担当
      this.comfyUIService = new ComfyUIService(
        this.comfyUI,
        this.config.memorialCard, // メモリアルカード設定を渡す
        this.mainWindow || undefined
      );
      await this.comfyUIService.initialize();
      
      // ComfyUI完了時のメモリアルカード生成コールバックを設定
      this.comfyUIService.setMemorialCardCallback(this.handleComfyUICompletion.bind(this));
      
    } catch (error) {
      console.error('[ComfyUI] Service initialization failed:', error);
      console.error('[ComfyUI] Config details:', {
        hasConfig: !!this.config?.comfyui,
        activeProfile: this.config?.comfyui?.activeProfile,
        baseUrl: this.comfyUI?.baseUrl,
        templatePath: this.comfyUI?.workflow?.templatePath
      });
      console.error('[ComfyUI] Error details:', {
        type: typeof error,
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error)
      });
      this.comfyUIService = null;
      console.warn('[ComfyUI] ComfyUI機能は無効化されました。ゲームは画像生成なしで動作します。');
    }
  }

  private setupRankingWatcher(): void { // ADDED
    if (this.rankingService) {
      this.rankingService.watchResults((data) => {
        console.log('Ranking data updated, sending to renderer');
        if (this.rankingWindow && !this.rankingWindow.isDestroyed()) {
          this.rankingWindow.webContents.send('ranking:data-updated', data);
        }
      });
    }
  } // ADDED


  private async handleComfyUICompletion(jobId: string, resultDir: string): Promise<void> {
    if (!this.memorialCardService) {
      console.warn('ElectronApp - Memorial card service not available for ComfyUI completion');
      return;
    }

    const dateTime = path.basename(resultDir);
    const currentState = this.memorialCardGenerationFlags.get(dateTime);

    if (currentState === 'ai_inprogress' || currentState === 'ai_completed') {
      return; // すでに処理済み／処理中
    }

    if (currentState !== 'dummy_completed') {
      // ダミーカードがまだできていない＝AI変換が先に終わった。
      // 捨てずに保持しておき、ダミー完成後に必ず消化する。
      this.pendingAICompletions.set(dateTime, jobId);
      console.log(`ElectronApp - AI card completion is pending until the dummy card is ready: ${dateTime} (state: ${currentState})`);
      return;
    }

    await this.runAIMemorialCard(jobId, resultDir, dateTime);
  }

  /**
   * AI画像から記念カードを生成し、成功したときだけ results.json のパスを差し替える。
   *
   * 🔴 **合成の成否を必ず見ること。**
   * 以前は `generateFromAIImage` が void で失敗を握り潰していたため、
   * 合成が失敗しても `ai_completed` を立てて `updateMemorialCardPath` を呼び、
   * **実体の無い正規カードのパス**を result.json（後日のカード公開の正本）と
   * results.json に書いていた。表示は「画像なし」になり、後日の公開でもその子が欠ける。
   * 「カードが出来ていると誤認する」という直したかった不具合が、ここに残っていた。
   */
  private async runAIMemorialCard(jobId: string, resultDir: string, dateTime: string): Promise<void> {
    if (!this.memorialCardService) return;
    this.pendingAICompletions.delete(dateTime);
    try {
      // AIカード生成処理を開始
      this.memorialCardGenerationFlags.set(dateTime, 'ai_inprogress');
      const result = await this.memorialCardService.generateFromAIImage(jobId, resultDir);

      if (!result.success) {
        // プレースホルダ版カードの参照が残るので表示は破綻しない。
        // 🔴 フラグは**消す**（ai_inprogress のまま固定すると、このセッション中
        // 二度と作り直せない）。そのうえで、その場で数回リトライする。
        // 「一時ファイルを残したので後で救済されます」は、稼働中に誰も掃除を
        // 走らせないため、そのままでは救済されない。
        this.memorialCardGenerationFlags.delete(dateTime);
        console.error(
          `ElectronApp - AI memorial card generation failed for ${dateTime}: ${result.error}`
        );
        this.scheduleCardFinalizeRetries(resultDir, dateTime);
        return;
      }

      // AIカード生成完了
      this.memorialCardGenerationFlags.set(dateTime, 'ai_completed');
      console.log(`ElectronApp - AI memorial card generated successfully for: ${dateTime}`);

      // AI画像でのメモリアルカード生成完了後、results.jsonのパスを更新
      if (this.resultsManager) {
        try {
          const updated = await this.resultsManager.updateMemorialCardPath(resultDir);
          if (updated) {
            console.log(`ElectronApp - Memorial card path updated for AI image completion: ${dateTime}`);
          } else {
            // 🔴 **ここを放置してはいけない。**
            // カードは完全な形でディスクにあるのに、後日の公開の正本（result.json）が
            // プレースホルダを指したまま確定する経路。EPERM や読み取り失敗で普通に起きる。
            // 起動時点検でも救えるが、3000件・件数上限・時間予算では順番が来る保証がない。
            console.error(`ElectronApp - Memorial card path was not updated for: ${dateTime}`);
            this.scheduleCardFinalizeRetries(resultDir, dateTime);
          }
        } catch (pathUpdateError) {
          console.error('ElectronApp - Failed to update memorial card path:', pathUpdateError);
          this.scheduleCardFinalizeRetries(resultDir, dateTime);
        }
      }
    } catch (error) {
      console.error('ElectronApp - Memorial card generation failed after ComfyUI completion:', error);
      // 🔴 フラグを ai_inprogress のまま残すと、このセッション中は二度と
      // 作り直せない（handleComfyUICompletion も消化できない）。消して再試行に賭ける。
      this.memorialCardGenerationFlags.delete(dateTime);
      this.scheduleCardFinalizeRetries(resultDir, dateTime);
    }
  }

  // process.cwd() を基準にディレクトリを作る ensureDirectoryExists は削除した。
  // 呼び出し元は無く、かつ「作業フォルダ基準でパスを組む」のは
  // paths.ts のコメントにある通り results/ を見失う原因そのものなので、
  // 似た関数を再び置かないこと（必ず ensureDirectoryExistsAbsolute を使う）。

  private async ensureDirectoryExistsAbsolute(dirPath: string): Promise<void> {
    try {
      await fs.access(dirPath);
    } catch {
      await fs.mkdir(dirPath, { recursive: true });
      console.log(`Created directory: ${dirPath}`);
    }
  }

  /**
   * カードの確定（rename）に失敗した回を、稼働中に自分で救済する。
   *
   * 🔴 これが無いと「一時ファイルを残したので後で救済されます」が嘘になる。
   * 掃除（cleanupPartialCardOutputs）は起動時と救済ツールしか呼ばず、5分の
   * 経過ガードもあるため、**稼働中は誰もその完成品を最終名へ据えない**。
   * 3000人規模だと、夕方の再起動時にはそのフォルダは点検範囲の外に押し出されている。
   *
   * 合成し直すのではなく確定だけをやり直すので、1回あたりの費用はほぼゼロ。
   */
  private scheduleCardFinalizeRetries(resultDir: string, dateTime: string): void {
    // 同じ回に何本も張らない。失敗が続くと 3本・6本・9本と増え、
    // そのぶん嘘のエラーログが積み上がる
    if (this.cardFinalizeRetries.has(dateTime)) return;

    const delays = [30_000, 120_000, 300_000]; // 30秒 / 2分 / 5分
    const timers: ReturnType<typeof setTimeout>[] = [];
    this.cardFinalizeRetries.set(dateTime, timers);

    const stop = () => {
      for (const t of this.cardFinalizeRetries.get(dateTime) ?? []) clearTimeout(t);
      this.cardFinalizeRetries.delete(dateTime);
    };

    delays.forEach((delay, index) => {
      const timer = setTimeout(async () => {
        try {
          const outputPath = path.join(resultDir, `memorial_card_${dateTime}.png`);
          const resultsDir = path.dirname(resultDir);

          // 🔴 救済ツールと同時に走らせない。ツールが「壊れている」と判断した直後に
          // ここが書き戻すと、ツールはその新しいカードを退避してしまう。
          const locked = await withMaintenanceLock(resultsDir, async () => {
            // すでに最終名に完全なカードがあるなら、参照の張り直しだけ確かめる
            // （別プロセスの救済ツールが先に作り直していることがある）
            return finalizeCardOutput(outputPath);
          });
          if (!locked.ok) {
            console.warn(`ElectronApp - 保守中のため確定のやり直しを見送ります: ${dateTime}`);
            return; // 次の再試行に任せる
          }
          const error = locked.value;
          if (error) {
            // 一時ファイルが無いなら、確定のやり直しでは直らない原因
            // （magick の失敗・AI画像が無い等）。嘘の「諦めました」を出さない
            const partialExists = await fs.access(buildPartialOutputPath(outputPath))
              .then(() => true)
              .catch(() => false);
            if (!partialExists) {
              stop();
              console.warn(`ElectronApp - 確定のやり直しでは直らないため中止します: ${dateTime}`);
              return;
            }
            if (index === delays.length - 1) {
              console.error(`ElectronApp - カードの確定を諦めました（救済ツールで作り直してください）: ${dateTime} (${error})`);
              stop();
            }
            return;
          }

          console.log(`ElectronApp - カードの確定を確認しました（再試行 ${index + 1}）: ${dateTime}`);
          this.memorialCardGenerationFlags.set(dateTime, 'ai_completed');
          if (this.resultsManager) {
            const manager = this.resultsManager;
            const relinked = await withMaintenanceLock(resultsDir, () => manager.updateMemorialCardPath(resultDir));
            if (!relinked.ok) {
              console.warn(`ElectronApp - 保守中のため参照の張り直しを見送ります: ${dateTime}`);
              return;
            }
            const updated = relinked.value;
            if (!updated) {
              console.error(`ElectronApp - 確定後のパス更新に失敗: ${dateTime}`);
              return; // 次の再試行に任せる（stop しない）
            }
          }
          // 成功したので残りのタイマーを止める（止めないと嘘のエラーが後から出る）
          stop();
        } catch (e) {
          console.error(`ElectronApp - カード確定の再試行でエラー: ${dateTime}`, e);
        }
      }, delay);
      // アプリの終了を妨げない
      if (typeof timer.unref === 'function') timer.unref();
      timers.push(timer);
    });
  }

  /**
   * 起動時の整合性点検を、ウィンドウを止めずに走らせる。
   *
   * 待たない代わりに、結果はログに残す（当日はこのログで状況を追う）。
   * 件数上限と時間予算は config.json の results で調整できる
   * ＝当日 CLI を叩けない状況でも設定ファイルで手当てできる。
   */
  private runStartupConsistencyCheck(resultsDir: string): void {
    const manager = this.resultsManager;
    if (!manager) return;

    this.startupCheckRunning = true;
    void checkResultsConsistency(resultsDir, manager, {
      scanLimit: this.config?.results?.startupCheckLimit,
      budgetMs: this.config?.results?.startupCheckBudgetMs,
    })
      .then((report) => {
        console.log(`起動時点検 - ${formatConsistencyReport(report)}`);
        for (const { datetime, reason } of report.quarantinedCards) {
          console.warn(`起動時点検 - 壊れたカードを退避: ${datetime} (${reason})`);
        }
        for (const { datetime, reason } of report.unverified) {
          console.warn(`起動時点検 - 検査できず保留: ${datetime} (${reason})`);
        }
        for (const datetime of report.unreadableResults) {
          console.error(`起動時点検 - result.json が壊れています（記録の正本）: ${datetime}`);
        }
      })
      .catch((error) => {
        // 点検で落ちてもゲームは続けられる（当日の受付を止めない）
        console.error('起動時点検 - 失敗しましたが起動を続行します', error);
      })
      .finally(() => {
        this.startupCheckRunning = false;
      });
  }

  /**
   * 終了時に保守ロックを片付ける。
   *
   * 🔴 点検の途中でアプリを閉じる／落ちると、heartbeat で mtime が更新された
   * 「新鮮な」ロックが残る。以後10分間、起動時点検は毎回スキップされ、
   * 救済ツールも「別のプロセスが保守中です」で拒否される。
   * 当日に再起動を繰り返す状況では、唯一の救済手段が繰り返し塞がれる。
   */
  private async releaseMaintenanceLockOnExit(resultsDir: string): Promise<void> {
    if (this.startupCheckRunning) {
      // 点検自身が finally で解放する。ここで消すと他人のロックを消す恐れがある
      return;
    }
    const lockPath = path.join(resultsDir, '.maintenance.lock');
    try {
      const raw = await fs.readFile(lockPath, 'utf-8');
      // 🔴 **持ち主の判定は pid ではなく token で行う。**
      // card-output.ts の取得／解放はどちらも token で照合している。ここだけ pid
      // で見ていたため、Windows が pid を使い回した後だと**他プロセスの保守ロックを
      // 消してしまう**（前回の異常終了で残ったロックの pid と一致し得る）。
      // ロックが消えれば救済ツールと起動時点検が同時に走り、
      // 「点検が壊れていると判断した直後に相手が正常なカードを完成させ、
      // それを点検が退避する」という取り返しのつかない競合になる。
      const owner = JSON.parse(raw) as { token?: string };
      if (owner.token === getProcessToken()) {
        await fs.unlink(lockPath).catch(() => undefined);
        console.log('保守ロックを解放しました');
      }
    } catch {
      // 無い・読めないなら何もしない
    }
  }

  /**
   * 終了確認ダイアログに出す「未処理のジョブ」の内訳。
   *
   * 🔴 **件数の内訳を 0 で埋めてはいけない。** 以前は serverQueueRunning /
   * serverQueuePending を常に 0 で返していたため、実際に1枚生成している最中でも
   * 画面には「処理中: 0件 / 待機中: 1件」と出ていた。閉店時にスタッフが
   * 「いま止めても大丈夫か」を判断する唯一の材料なので、実態を出す。
   *
   * ComfyUI サーバへ問い合わせに行くと最大5秒待つことになり、その間ダイアログが
   * 出ない（× を押しても無反応に見える）。そのため**手元が知っている**
   * ジョブの状態（ワーカーからの進捗通知で更新される status）から数える。
   * activeJobs に待機中も実行中も入っているので、internalQueueLength は
   * 二重に数えないよう 0 にする。
   */
  private collectExitStatus(): {
    activeJobs: Array<{ datetime: string; status: string; duration: number }>;
    internalQueueLength: number;
    serverQueueRunning: number;
    serverQueuePending: number;
  } {
    const empty = {
      activeJobs: [] as Array<{ datetime: string; status: string; duration: number }>,
      internalQueueLength: 0,
      serverQueueRunning: 0,
      serverQueuePending: 0,
    };
    if (!this.comfyUIService) return empty;
    try {
      const activeJobs = this.comfyUIService.getActiveJobs();
      return {
        activeJobs,
        internalQueueLength: 0,
        serverQueueRunning: activeJobs.filter((job) => job.status === 'processing').length,
        serverQueuePending: activeJobs.filter((job) => job.status !== 'processing').length,
      };
    } catch (error) {
      console.error('Failed to get ComfyUI status for exit:', error);
      return empty;
    }
  }

  /**
   * 終了が確定したあと、一定時間たっても終わらなければプロセスを強制的に終わらせる。
   *
   * 🔴 **app.quit() を呼んだだけでは終わらないことがある。**
   * このアプリは GPU プロセスのクラッシュ対策で
   * `disable-gpu-process-crash-limit` と `disable-features=VizDisplayCompositor` を
   * 付けており、Chromium の終了処理が完了せず、**ウィンドウが消えたのに
   * メインプロセスと GPU / utility プロセスだけが残る**ことが実機で起きた
   * （2026-09-04）。残ると二重起動防止のロックを握ったままになり、
   * 次の起動ができない。
   *
   * 記録は result.json / results.json へ rename で確定済みなので、
   * ここで打ち切ってもデータは失わない。
   * タイマーは unref する（これ自体が終了を引き止めないように）。
   */
  private forceExitTimer: ReturnType<typeof setTimeout> | null = null;
  private armForceExit(): void {
    if (this.forceExitTimer) return;
    this.forceExitTimer = setTimeout(() => {
      console.warn(
        `終了が ${QUIT_FORCE_EXIT_MS}ms で完了しませんでした。プロセスを強制的に終わらせます。`
      );
      app.exit(0);
    }, QUIT_FORCE_EXIT_MS);
    this.forceExitTimer.unref();
  }

  /**
   * 終了確認をレンダラーへ依頼する。
   *
   * 🔴 **ウィンドウが無い場合に「何もしない」で抜けてはいけない。**
   * before-quit / close は `exitConfirmed` が立つまで preventDefault し続けるので、
   * 確認ダイアログを出せる相手が居ないまま黙って戻ると
   * **アプリを二度と終了できない**（× もタスクバーからの終了も効かない）。
   * レンダラーが落ちた・ウィンドウが破棄済み、という状況で実際に起こる。
   * その場合は確認する相手が居ない＝止めるべきものも無いので、そのまま終了させる。
   */
  private async showExitConfirmation(): Promise<void> {
    try {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) {
        console.warn('終了確認を出せるウィンドウがないため、そのまま終了します');
        this.exitConfirmed = true;
        app.quit();
        return;
      }

      // レンダラープロセスに終了確認ダイアログの表示を要求
      this.mainWindow.webContents.send('show-exit-confirmation', this.collectExitStatus());
    } catch (error) {
      console.error('Failed to show exit confirmation:', error);
      // エラー時は強制終了を許可
      this.exitConfirmed = true;
      app.quit();
    }
  }

}

// アプリケーション開始
new ElectronApp();