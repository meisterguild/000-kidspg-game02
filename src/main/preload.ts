import { contextBridge, ipcRenderer } from 'electron';
import type { AppConfig, GameResult } from '@shared/types';
import type { ConfigPatch } from './services/config-writer';
import type { RankingData } from '@shared/types/ranking';
import type { 
  ComfyUIEventCallback, 
  ComfyUIErrorCallback,
  ComfyUITransformResult,
  ComfyUIStatusResult,
  ComfyUIHealthResult,
  ComfyUIJobsResult,
  ComfyUIStatus
} from '@shared/types/comfyui';

// Renderer側で使用可能なAPI定義
const electronAPI = {
  // 写真を保存し、結果保存用のディレクトリを作成する
  savePhoto: (imageData: string, isDummy?: boolean) => ipcRenderer.invoke('save-photo', imageData, isDummy),

  // JSONデータを指定されたディレクトリに保存する
  saveJson: (dirPath: string, jsonData: GameResult) =>
    ipcRenderer.invoke('save-json', dirPath, jsonData),

  // ランキングウィンドウ制御
  showRankingWindow: () => ipcRenderer.invoke('show-ranking-window'),
  closeRankingWindow: () => ipcRenderer.invoke('close-ranking-window'),

  // 設定情報を取得
  getConfig: () => ipcRenderer.invoke('get-config'),

  // 設定ファイルを再読み込み（main 側で ComfyUI 設定も作り直す）
  reloadConfig: (): Promise<{
    success: boolean;
    config?: AppConfig;
    error?: string;
    restartRequired?: string[];
    /**
     * 生成パラメータとワークフローの配線の点検結果。
     * main はこれを返しているのに型から漏れていて、画面まで届いていなかった。
     * `denoise: 1` のように「保存はできるが絵が写真と無関係になる」設定は、
     * 起動時ダイアログを過ぎたあとはここでしか気づけない。
     */
    warnings?: string[];
  }> => ipcRenderer.invoke('reload-config'),

  // 設定を config.json へ保存する（main 側でキーごとに型と範囲を検査してから書く）
  saveConfig: (
    patch: ConfigPatch
  ): Promise<{
    success: boolean;
    config?: AppConfig;
    error?: string;
    restartRequired?: string[];
    /** 保存した値の点検結果。reloadConfig と同じ理由で必ず画面へ出す */
    warnings?: string[];
  }> => ipcRenderer.invoke('save-config', patch),

  // ランキング関連API
  getRankingData: () => ipcRenderer.invoke('ranking:get-data'),
  getRankingConfig: () => ipcRenderer.invoke('ranking:get-config'),
  onRankingDataUpdated: (callback: (data: RankingData) => void) => {
    const listener = (_: unknown, data: RankingData) => callback(data);
    ipcRenderer.on('ranking:data-updated', listener as never);
    // 呼び出し側（RankingContext）は戻り値をクリーンアップ関数として呼ぶ。
    // 以前は何も返しておらず、ランキング画面を閉じるたびに TypeError になっていた。
    return () => { ipcRenderer.removeListener('ranking:data-updated', listener as never); };
  },

  // ComfyUI API
  comfyui: {
    transform: (imageData: string, datetime: string, resultDir: string): Promise<ComfyUITransformResult> =>
      ipcRenderer.invoke('comfyui-transform', imageData, datetime, resultDir),
    getStatus: (): Promise<ComfyUIStatusResult> => ipcRenderer.invoke('comfyui-status'),
    healthCheck: (): Promise<ComfyUIHealthResult> => ipcRenderer.invoke('comfyui-health-check'),
    getActiveJobs: (): Promise<ComfyUIJobsResult> => ipcRenderer.invoke('comfyui-active-jobs'),
    // ComfyUI の画面を既定ブラウザで開く（開く先は main 側が設定から決める）
    openUI: (): Promise<{ success: boolean; url?: string; error?: string }> =>
      ipcRenderer.invoke('open-comfyui-ui'),
    // 現在の設定を焼き込んだワークフローを書き出し、エクスプローラで場所を開く。
    // ブラウザの ComfyUI へこのファイルをドラッグ＆ドロップすると、
    // ゲームが投げているのと同じグラフが開く
    exportWorkflow: (): Promise<{
      success: boolean;
      filePath?: string;
      warnings?: string[];
      error?: string;
    }> => ipcRenderer.invoke('export-comfyui-workflow'),
    cancelJob: (datetime: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('comfyui-cancel-job', datetime),
    onJobQueued: (callback: ComfyUIEventCallback) => {
      ipcRenderer.on('comfyui-job-queued', (_, data) => callback(data));
    },
    onJobStarted: (callback: ComfyUIEventCallback) => {
      ipcRenderer.on('comfyui-job-started', (_, data) => callback(data));
    },
    onJobProcessing: (callback: ComfyUIEventCallback) => {
      ipcRenderer.on('comfyui-job-processing', (_, data) => callback(data));
    },
    onJobQueueUpdate: (callback: ComfyUIEventCallback) => {
      ipcRenderer.on('comfyui-job-queue-update', (_, data) => callback(data));
    },
    onJobCompleted: (callback: ComfyUIEventCallback) => {
      ipcRenderer.on('comfyui-job-completed', (_, data) => callback(data));
    },
    onJobError: (callback: ComfyUIEventCallback) => {
      ipcRenderer.on('comfyui-job-error', (_, data) => callback(data));
    },
    onError: (callback: ComfyUIErrorCallback) => {
      ipcRenderer.on('comfyui-error', (_, data) => callback(data));
    },
    removeAllListeners: () => {
      ipcRenderer.removeAllListeners('comfyui-job-queued');
      ipcRenderer.removeAllListeners('comfyui-job-started');
      ipcRenderer.removeAllListeners('comfyui-job-processing');
      ipcRenderer.removeAllListeners('comfyui-job-queue-update');
      ipcRenderer.removeAllListeners('comfyui-job-completed');
      ipcRenderer.removeAllListeners('comfyui-job-error');
      ipcRenderer.removeAllListeners('comfyui-error');
    }
  },

  // プラットフォーム情報
  platform: process.platform,

  // 新しいAPI: アセットの絶対パスを取得
  getAssetAbsolutePath: (relativePath: string) => ipcRenderer.invoke('get-asset-absolute-path', relativePath),

  // ランキング画像取得API
  getImageDataUrl: (relativePath: string) => ipcRenderer.invoke('get-image-data-url', relativePath),

  // 終了確認関連API
  // 画面の「終了」ボタンはこれを呼ぶ。window.close() を使ってはいけない理由は
  // main.ts の 'request-exit' ハンドラのコメントを参照。
  requestExit: () => ipcRenderer.invoke('request-exit'),
  getComfyUIStatusForExit: () => ipcRenderer.invoke('get-comfyui-status-for-exit'),
  confirmExit: (confirmed: boolean) => ipcRenderer.invoke('confirm-exit', confirmed),
  onShowExitConfirmation: (callback: (comfyUIStatus: ComfyUIStatus) => void) => {
    ipcRenderer.on('show-exit-confirmation', (_, data) => callback(data));
  },
  removeExitConfirmationListener: () => {
    ipcRenderer.removeAllListeners('show-exit-confirmation');
  },
};

// contextBridgeを使ってRenderer側にAPIを公開
contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// TypeScript用の型定義を追加
declare global {
  interface Window {
    electronAPI: typeof electronAPI;
  }
}