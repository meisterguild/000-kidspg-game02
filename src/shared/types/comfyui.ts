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