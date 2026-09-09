/**
 * config.json の `comfyui.paths` / `comfyui.profiles.*.paths` に書く形。
 *
 * **同一PCで ComfyUI を動かしているときだけ書く。** アプリと ComfyUI のやり取りは
 * HTTP（`baseUrl`）で足りていて、ここは「起動バッチをアプリから叩く」
 * 「当日 input / output を直に開く」ためだけに使う。AI サーバー側のプロファイルは
 * 別の機体なので書かない。
 *
 * `root` は絶対パス必須。`input` / `output` / `startBat` は省略か `root` からの
 * 相対でよい（版フォルダを差し替えるときに `root` の 1 行で済むように）。
 * 検査と既定値の埋めは main/services/comfyui-config.ts の resolveComfyUIPaths。
 */
export interface ComfyUIPathsConfig {
  root?: string;
  input?: string;
  output?: string;
  startBat?: string;
}

/** 「ComfyUI を起動する」の結果。すでに動いていた場合は `alreadyRunning` で返る */
export interface ComfyUILaunchResult {
  success: boolean;
  /** すでに ComfyUI が応答していたので起動しなかった */
  alreadyRunning?: boolean;
  /** 実際に叩いた起動バッチ（画面へ出して、当日どこを起動したか分かるように） */
  startBat?: string;
  error?: string;
}

export interface ComfyUIJobProgressData {
  jobId: string;
  timestamp: string;
  message: string;
  position?: number;
  promptId?: string;
  error?: string;
  resultPath?: string;
  actualFilename?: string;
}

export interface ComfyUIStatus {
  activeJobs: Array<{
    datetime: string;
    status: string;
    promptId: string;
    duration: number;
  }>;
  // comfyui-worker.getStatus() が実際に返す形に合わせている
  internalQueueLength: number;
  serverQueueRunning: number;
  serverQueuePending: number;
  maxConcurrentJobs: number;
  error?: string;
}

export interface ComfyUIActiveJob {
  datetime: string;
  status: string;
  duration: number;
}

export interface ComfyUITransformResult {
  success: boolean;
  jobId?: string;
  error?: string;
}

export interface ComfyUIStatusResult {
  success: boolean;
  status?: ComfyUIStatus;
  error?: string;
}

export interface ComfyUIHealthResult {
  success: boolean;
  isHealthy: boolean;
}

export interface ComfyUIJobsResult {
  success: boolean;
  jobs: ComfyUIActiveJob[];
}

export type ComfyUIEventCallback = (data: ComfyUIJobProgressData) => void;
export type ComfyUIErrorCallback = (data: { message: string }) => void;