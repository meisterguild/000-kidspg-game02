import { Worker } from 'worker_threads';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import type { ComfyUIJobProgressData, ComfyUIStatus } from '@shared/types/comfyui';
import { TIMING_CONFIG } from '../../shared/utils/constants';

interface ComfyUIJobRequest {
  imageData: string;
  datetime: string;
  resultDir: string;
}

interface ComfyUIConfig {
  baseUrl: string;
  pollingInterval: number;
  maxConcurrentJobs: number;
  timeouts: {
    upload: number;
    processing: number;
    queue: number;
  };
  retry: {
    maxAttempts: number;
    delayMs: number;
  };
  workflow: {
    templatePath: string;
    outputPrefix: string;
  };
}

export class ComfyUIService {
  private worker: Worker | null = null;
  private config: ComfyUIConfig;
  private mainWindow: BrowserWindow | null = null;
  private activeJobs = new Map<string, {
    datetime: string;
    resultDir: string;
    status: 'queued' | 'processing' | 'completed' | 'error';
    startTime: number;
  }>();
  private preUploadedImages = new Map<string, string>(); // datetime -> uploaded filename
  private memorialCardCallback: ((jobId: string, resultDir: string) => Promise<void>) | null = null;
  private memorialCardEnabled: boolean = true; // メモリアルカード機能の有効/無効状態
  /**
   * destroy() による終了処理中か。
   * 終了時の terminate() でも 'exit' は飛ぶので、これが無いと
   * 毎回「ワーカーが停止しました」という**嘘のエラー**を出してしまう
   * （当日ログを追う人が、正常終了と異常終了を見分けられなくなる）。
   */
  private destroying = false;
  constructor(config: ComfyUIConfig, memorialCardConfig?: { enabled: boolean }, mainWindow?: BrowserWindow) {
    this.config = config;
    this.mainWindow = mainWindow || null;
    this.memorialCardEnabled = memorialCardConfig?.enabled ?? true;
  }

  async initialize(): Promise<void> {
    try {
      const workerPath = path.join(__dirname, '..', 'workers', 'comfyui-worker.js');
      this.worker = new Worker(workerPath);

      this.worker.on('message', (message) => {
        this.handleWorkerMessage(message);
      });

      this.worker.on('error', (error) => {
        console.error('ComfyUI Worker Error:', error);
        this.sendToRenderer('comfyui-error', { 
          message: `Worker Error: ${error.message}` 
        });
      });

      this.worker.on('exit', (code) => {
        // 🔴 **ワーカーが死んだら参照を捨てる。**
        // comfyui-worker.ts は uncaughtException で process.exit(1) する。
        // 参照を持ったままだと以後の postMessage は例外も出さずに捨てられ、
        // 「撮影は通るのに AI 画像だけが一枚も来ない」という無言の劣化になる。
        // null にしておけば、preUploadImage / transformImage が
        // 「not initialized」で失敗し、ログとカードのダミー退避で気づける。
        this.worker = null;
        if (this.destroying) {
          // アプリ終了時の terminate()。異常ではないので騒がない
          console.log('ComfyUI Worker terminated (shutdown)');
          return;
        }
        console.error(`ComfyUI Worker stopped unexpectedly with exit code ${code}`);
        this.sendToRenderer('comfyui-error', {
          message: `ComfyUI ワーカーが停止しました (exit ${code})。AI変換は行われません。`,
        });
      });

      this.worker.postMessage({
        type: 'init',
        data: { config: this.config }
      });

      await this.waitForReady();

    } catch (error) {
      throw new Error(`ComfyUI Service initialization failed: ${error}`);
    }
  }

  /**
   * ワーカーからの応答を1件だけ待つ。
   *
   * 🔴 **タイムアウトしたときも必ずリスナーを外すこと。**
   * 以前は解除がハンドラ側にしか無く、タイムアウトした分の待ち受けが
   * ワーカーに残り続けていた。プリアップロードは1プレイに1回走るため、
   * ComfyUI が重い日には待ち受けが積み上がって
   * MaxListenersExceededWarning（既定10件）に達する。
   * 待ち受けの管理をこの1か所に集約して、解除漏れが起きない形にする。
   *
   * @param match  受け取ったメッセージが目的のものなら値を包んで返す。違うなら null
   */
  private waitForWorkerMessage<T>(
    match: (message: { type: string; data?: unknown }) => { value: T } | null,
    timeoutMs: number,
    timeoutMessage: string,
    beforeWait?: () => void
  ): Promise<T> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('ComfyUI Service not initialized'));

    return new Promise<T>((resolve, reject) => {
      const settle = (action: () => void) => {
        clearTimeout(timer);
        worker.off('message', handler);
        action();
      };
      const handler = (message: { type: string; data?: unknown }) => {
        const hit = match(message);
        if (hit) settle(() => resolve(hit.value));
      };
      const timer = setTimeout(() => settle(() => reject(new Error(timeoutMessage))), timeoutMs);

      worker.on('message', handler);
      // 待ち受けを張ってから投げる（先に投げると速い応答を取りこぼす）
      beforeWait?.();
    });
  }

  private waitForReady(): Promise<void> {
    return this.waitForWorkerMessage<void>(
      (message) => (message.type === 'ready' ? { value: undefined } : null),
      10000,
      'Worker initialization timeout'
    );
  }

  private handleWorkerMessage(message: { type: string; data: ComfyUIJobProgressData | ComfyUIStatus | { message: string; isHealthy?: boolean; datetime?: string; uploadedFilename?: string; error?: string } }): void {
    const { type, data } = message;

    switch (type) {
      case 'ready':
        break;

      case 'pre-upload-completed':
        break;

      case 'job-queued':
        this.updateJobStatus((data as ComfyUIJobProgressData).jobId, 'queued');
        this.sendToRenderer('comfyui-job-queued', data);
        break;

      case 'job-started':
        this.updateJobStatus((data as ComfyUIJobProgressData).jobId, 'processing');
        this.sendToRenderer('comfyui-job-started', data);
        break;

      case 'job-processing':
        this.sendToRenderer('comfyui-job-processing', data);
        break;

      case 'job-queue-update':
        this.sendToRenderer('comfyui-job-queue-update', data);
        break;

      case 'job-completed': {
        this.updateJobStatus((data as ComfyUIJobProgressData).jobId, 'completed');
        this.sendToRenderer('comfyui-job-completed', data);
        
        // メモリアルカード生成をトリガー
        const jobData = data as ComfyUIJobProgressData;
        const job = this.activeJobs.get(jobData.jobId);
        if (job && this.memorialCardCallback) {
          this.memorialCardCallback(jobData.jobId, job.resultDir)
            .catch(error => {
              console.error('ComfyUIService - Memorial card generation error:', error);
            });
        } else if (job && !this.memorialCardCallback) {
          console.warn('ComfyUIService - Memorial card callback not set, skipping card generation');
        }
        break;
      }

      case 'job-error':
        this.updateJobStatus((data as ComfyUIJobProgressData).jobId, 'error');
        this.sendToRenderer('comfyui-job-error', data);
        break;

      case 'job-canceled':
        this.updateJobStatus((data as ComfyUIJobProgressData).jobId, 'error'); // canceledをerrorとして扱う
        this.sendToRenderer('comfyui-job-canceled', data);
        break;

      case 'status':
        this.sendToRenderer('comfyui-status', data);
        break;

      case 'health-check-result':
        this.sendToRenderer('comfyui-health-check', data);
        break;

      case 'error':
        console.error('ComfyUI Worker Error:', data);
        this.sendToRenderer('comfyui-error', data);
        break;

      default:
        console.warn('Unknown worker message type:', type);
    }
  }

  private updateJobStatus(jobId: string, status: 'queued' | 'processing' | 'completed' | 'error'): void {
    const job = this.activeJobs.get(jobId);
    if (job) {
      job.status = status;
      
      // 完了またはエラー時の削除処理
      if (status === 'completed' || status === 'error') {
        // メモリアルカード生成が無効、またはcallbackが設定されていない場合は即座に削除
        if (!this.memorialCardEnabled || !this.memorialCardCallback) {
          console.log(`ComfyUIService - Removing completed job immediately: ${jobId} (memorial card disabled or callback not set)`);
          this.activeJobs.delete(jobId);
        } else {
          // メモリアルカード生成時間を考慮して遅延削除
          console.log(`ComfyUIService - Scheduling delayed removal of completed job: ${jobId} (memorial card enabled)`);
          setTimeout(() => {
            if (this.activeJobs.has(jobId)) {
              console.log(`ComfyUIService - Removing completed job after delay: ${jobId}`);
              this.activeJobs.delete(jobId);
            }
          }, 5000); // 5秒後に削除
        }
      }
    }
  }

  private sendToRenderer(channel: string, data: ComfyUIJobProgressData | ComfyUIStatus | { message: string; isHealthy?: boolean }): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  async preUploadImage(imageData: string, datetime: string): Promise<string> {
    const worker = this.worker;
    if (!worker) {
      throw new Error('ComfyUI Service not initialized');
    }

    const result = await this.waitForWorkerMessage<{ uploadedFilename?: string; error?: string }>(
      (message) => {
        if (message.type !== 'pre-upload-completed') return null;
        const data = message.data as { datetime?: string; uploadedFilename?: string; error?: string };
        return data?.datetime === datetime ? { value: data } : null;
      },
      this.config.timeouts.upload,
      'Pre-upload timeout',
      () => worker.postMessage({ type: 'pre-upload-image', data: { imageData, datetime } })
    );

    if (!result.uploadedFilename) {
      throw new Error(result.error || 'Pre-upload failed');
    }
    this.preUploadedImages.set(datetime, result.uploadedFilename);
    return result.uploadedFilename;
  }

  async transformImage(request: ComfyUIJobRequest): Promise<string> {
    if (!this.worker) {
      throw new Error('ComfyUI Service not initialized');
    }

    // 🔴 **ジョブの識別子は日時（results/<日時> のフォルダ名）に揃える。**
    // ワーカーは進捗を `jobId: datetime` で返し（comfyui-worker.ts の sendJobProgress）、
    // activeJobs も datetime で引く。ここだけ `job-<時刻>-<乱数>` を作って返していたため、
    // 呼び出し側へ渡る値とワーカーが名乗る値が食い違い、
    // 「どのジョブの話なのか」がログから追えなくなっていた。
    const jobId = request.datetime;

    this.activeJobs.set(request.datetime, {
      datetime: request.datetime,
      resultDir: request.resultDir,
      status: 'queued',
      startTime: Date.now()
    });

    const preUploadedFilename = this.preUploadedImages.get(request.datetime);
    
    this.worker.postMessage({
      type: 'add-job',
      data: {
        id: jobId,
        imageData: request.imageData,
        datetime: request.datetime,
        resultDir: request.resultDir,
        preUploadedFilename
      }
    });

    return jobId;
  }

  async getStatus(): Promise<ComfyUIStatus> {
    const worker = this.worker;
    if (!worker) {
      throw new Error('ComfyUI Service not initialized');
    }

    return this.waitForWorkerMessage<ComfyUIStatus>(
      (message) => (message.type === 'status' ? { value: message.data as ComfyUIStatus } : null),
      TIMING_CONFIG.comfyuiTimeout,
      'Status request timeout',
      () => worker.postMessage({ type: 'get-status', data: {} })
    );
  }

  async healthCheck(): Promise<boolean> {
    const worker = this.worker;
    if (!worker) {
      return false;
    }

    try {
      return await this.waitForWorkerMessage<boolean>(
        (message) =>
          message.type === 'health-check-result'
            ? { value: !!(message.data as { isHealthy?: boolean })?.isHealthy }
            : null,
        TIMING_CONFIG.comfyuiTimeout,
        'Health check timeout',
        () => worker.postMessage({ type: 'health-check', data: {} })
      );
    } catch {
      // 応答が無い＝繋がっていない。起動時の警告はこの false から出る
      return false;
    }
  }

  getActiveJobs(): Array<{datetime: string, status: string, duration: number}> {
    return Array.from(this.activeJobs.entries()).map(([datetime, job]) => ({
      datetime,
      status: job.status,
      duration: Date.now() - job.startTime
    }));
  }

  setMemorialCardCallback(callback: (jobId: string, resultDir: string) => Promise<void>): void {
    this.memorialCardCallback = callback;
  }


  async cancelJob(datetime: string): Promise<boolean> {
    if (!this.worker) {
      return false;
    }

    
    // アクティブジョブから削除
    const job = this.activeJobs.get(datetime);
    if (job) {
      this.activeJobs.delete(datetime);
    }

    // プリアップロード済み画像も削除
    if (this.preUploadedImages.has(datetime)) {
      this.preUploadedImages.delete(datetime);
    }

    // Workerにキャンセル通知（サーバー側のキューからも削除）
    this.worker.postMessage({
      type: 'cancel-job',
      data: { datetime }
    });

    return true;
  }

  async destroy(): Promise<void> {
    // 'exit' ハンドラが「異常停止」と誤って知らせないよう、先に印を立てる
    this.destroying = true;
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
    this.activeJobs.clear();
    this.preUploadedImages.clear();
  }
}