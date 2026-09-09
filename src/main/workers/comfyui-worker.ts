import { parentPort } from 'worker_threads';
import * as fs from 'fs/promises';
import * as path from 'path';
import { request as httpRequest } from 'http';
import { URL } from 'url';
import FormData from 'form-data';
import { buildPartialOutputPath, renameWithRetry } from '../services/card-output';
import { verifyPngFile } from '../services/png-integrity';

interface WorkflowTemplate {
  [nodeId: string]: {
    inputs: Record<string, unknown>;
    class_type: string;
    _meta: { title: string };
  };
}

interface ComfyUIPromptResponse {
  prompt_id: string;
}

interface ComfyUIUploadResponse {
  name: string;
}

interface ComfyUIQueueResponse {
  queue_pending: Array<[number, string]>;
  queue_running: Array<[number, string]>;
}

interface ComfyUIHistoryResponse {
  [promptId: string]: {
    outputs: {
      [nodeId: string]: {
        images?: Array<{
          filename: string;
          subfolder: string;
          type: string;
        }>;
      };
    };
  };
}

interface WorkerMessage {
  type: string;
  data: Record<string, unknown>;
}

// Node.js標準のhttpモジュールを使用（上部でimport済み）

// シンプルなHTTPクライアント実装
async function electronFetch(url: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string | FormData;
  timeout?: number;
} = {}): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  json: () => Promise<unknown>;
  buffer: () => Promise<Buffer>;
}> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    
    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = httpRequest(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      
      res.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      res.on('end', () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        const buffer = Buffer.concat(chunks);
        resolve({
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
          status: res.statusCode || 0,
          statusText: res.statusMessage || '',
          headers: res.headers,
          json: async () => JSON.parse(buffer.toString()),
          buffer: async () => buffer
        });
      });
    });

    req.on('error', (error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      reject(error);
    });

    // タイムアウト設定
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (options.timeout) {
      timeoutId = setTimeout(() => {
        req.destroy();
        reject(new Error('Request timeout'));
      }, options.timeout);
    }

    // 🔴 **ヘッダ受信（response）ではタイムアウトを解除しない。**
    // 解除すると timeout が「最初の1バイトまで」の意味になり、
    // ヘッダだけ返して本文が止まった接続で永久にぶら下がる。
    // その間 poll は返らず、キュー期限（timeouts.queue）の判定にも到達しないため、
    // maxConcurrentJobs=1 ではアプリ側のキューが止まったままになる。
    // 解除は本文を読み切った res の 'end'（上）で行う。

    if (options.body) {
      if (options.body instanceof FormData) {
        // FormDataの場合
        const formHeaders = options.body.getHeaders();
        for (const [key, value] of Object.entries(formHeaders)) {
          req.setHeader(key, value);
        }
        
        // FormDataをパイプで送信
        options.body.pipe(req);
        options.body.on('error', (error) => {
          if (timeoutId) clearTimeout(timeoutId);
          reject(error);
        });
        options.body.on('end', () => {
          // FormDataの送信完了をログ出力
        });
      } else {
        req.write(options.body);
        req.end();
      }
    } else {
      req.end();
    }
  });
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

interface JobData {
  id: string;
  imageData: string;
  datetime: string;
  resultDir: string;
  preUploadedFilename?: string;
}

interface ActiveJob {
  promptId: string;
  datetime: string;
  resultDir: string;
  startTime: number;
  status: 'uploading' | 'processing' | 'completed' | 'error';
}

class ComfyUIWorker {
  private config: ComfyUIConfig;
  private activeJobs = new Map<string, ActiveJob>();
  private jobQueue: JobData[] = [];
  private isProcessing = false;

  constructor(config: ComfyUIConfig) {
    this.config = config;
  }

  // workflowTemplate フィールドと loadWorkflowTemplate() は削除した（2026-09-03）。
  //
  // 🔴 **ワーカーはテンプレートを読まない。** 投げるのは撮影時に main が
  // 変数置換と生成パラメータの焼き込みまで済ませて書き出した
  // `results/<日時>/image_generate.json`（submitPrompt が読む）。
  // ワーカー側にもう1つ読み込み経路を持つと、「テンプレートを直したのに
  // 効かない／片方だけ効く」という追いにくい食い違いのもとになる。
  // なお削除した実装は path.resolve（＝作業フォルダ基準）でテンプレートを
  // 探しており、そもそも呼ばれても正しい場所を指さなかった。

  private sendMessage(type: string, data: Record<string, unknown>): void {
    parentPort?.postMessage({ type, data });
  }

  private sendJobProgress(datetime: string, type: string, data: Record<string, unknown>): void {
    parentPort?.postMessage({ 
      type, 
      data: { 
        ...data, 
        jobId: datetime,
        timestamp: new Date().toISOString()
      } 
    });
  }

  async preUploadImage(imageData: string, datetime: string): Promise<void> {
    try {
      const buffer = Buffer.from(imageData, 'base64');
      const filename = `photo_${datetime}.png`;
      
      const formData = new FormData();
      formData.append('image', buffer, { filename, contentType: 'image/png' });

      const response = await electronFetch(`${this.config.baseUrl}/upload/image`, {
        method: 'POST',
        body: formData,
        timeout: this.config.timeouts.upload
      });

      if (!response.ok) {
        const errorText = await response.buffer().then(buf => buf.toString()).catch(() => 'Unknown error');
        console.error(`ComfyUI Worker - Upload error response: ${errorText}`);
        throw new Error(`画像アップロードエラー: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const result = await response.json() as ComfyUIUploadResponse;
      const uploadedFilename = result.name || filename;
      
      this.sendMessage('pre-upload-completed', { 
        datetime, 
        uploadedFilename 
      });

    } catch (error) {
      console.error(`ComfyUI Worker - Pre-upload failed for ${datetime}:`, error);
      this.sendMessage('pre-upload-completed', { 
        datetime, 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }

  async addJob(jobData: JobData): Promise<void> {
    this.jobQueue.push(jobData);
    this.sendJobProgress(jobData.datetime, 'job-queued', { 
      position: this.jobQueue.length,
      message: 'ジョブがキューに追加されました' 
    });
    
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  async cancelJob(datetime: string): Promise<void> {
    
    // キューから削除
    const queueIndex = this.jobQueue.findIndex(job => job.datetime === datetime);
    if (queueIndex !== -1) {
      this.jobQueue.splice(queueIndex, 1);
    }
    
    // アクティブジョブから削除し、ComfyUIサーバーからも削除
    const activeJob = this.activeJobs.get(datetime);
    if (activeJob) {
      try {
        // ComfyUIサーバーのキューから削除
        await this.cancelJobOnServer(activeJob.promptId);
      } catch (error) {
        console.warn(`ComfyUI Worker - Failed to cancel job on server: ${error}`);
      }
      
      this.settleJob(datetime);
    }
    
    this.sendJobProgress(datetime, 'job-canceled', { 
      message: 'ジョブがキャンセルされました' 
    });
  }

  /** キャンセル系リクエストの HTTP タイムアウト。
   *  ここを無制限にすると、「ComfyUI が無応答」というまさに打ち切りたい状況で
   *  キャンセル自体が返らず、呼び出し側の await が解けずにジョブが宙吊りになる。 */
  private static readonly CANCEL_TIMEOUT_MS = 10000;

  private async cancelJobOnServer(promptId: string): Promise<void> {
    const timeout = ComfyUIWorker.CANCEL_TIMEOUT_MS;
    try {

      // まず現在のキューを取得
      const queueResponse = await electronFetch(`${this.config.baseUrl}/queue`, { timeout });
      if (!queueResponse.ok) {
        throw new Error(`Failed to get queue: ${queueResponse.status}`);
      }

      const queueData = await queueResponse.json() as ComfyUIQueueResponse;

      // キューにジョブが存在するかチェック
      const allJobs = [...(queueData.queue_running || []), ...(queueData.queue_pending || [])];
      const jobExists = allJobs.some(([, id]) => id === promptId);

      if (jobExists) {

        // キューからジョブを削除
        const deleteResponse = await electronFetch(`${this.config.baseUrl}/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            delete: [promptId]
          }),
          timeout
        });

        if (!deleteResponse.ok) {
          throw new Error(`Failed to delete from queue: ${deleteResponse.status}`);
        }
      }

      // 実行中の場合は割り込み処理も試行。
      // /interrupt は promptId を指定できず「いま実行中のもの」を止めるため、
      // 上のスナップショット取得から実際の送信までの間に別ジョブへ切り替わっていると
      // 巻き添えになる。maxConcurrentJobs=1 かつ ComfyUI を本アプリ専用にしている前提で
      // 許容しているが、ComfyUI の Web UI から手動で流すと巻き添えが起こりうる。
      if (queueData.queue_running?.some(([, id]) => id === promptId)) {
        const interruptResponse = await electronFetch(`${this.config.baseUrl}/interrupt`, {
          method: 'POST',
          timeout
        });

        if (!interruptResponse.ok) {
          console.warn(`ComfyUI Worker - Failed to send interrupt: ${interruptResponse.status}`);
        }
      }

    } catch (error) {
      console.error(`ComfyUI Worker - Error canceling job on server:`, error);
      throw error;
    }
  }

  /**
   * ジョブが終わった（完了・失敗・キャンセル）ときは必ずここを通す。
   *
   * activeJobs から消すだけだと、maxConcurrentJobs に達して return した
   * processQueue を誰も起こし直さず、**待ち行列が二度と進まない**。
   * maxConcurrentJobs が 50 のうちは上限に触れないので表面化しなかったが、
   * ComfyUI が prompt を直列実行する以上、上限は 1 が正しい。
   * その 1 にした瞬間に「2人目以降が永久に投入されない」となるため、ここで起こす。
   */
  private settleJob(datetime: string): void {
    this.activeJobs.delete(datetime);
    if (this.jobQueue.length > 0) {
      setTimeout(() => this.processQueue(), 0);
    }
  }

  private async processQueue(): Promise<void> {

    if (this.isProcessing || this.jobQueue.length === 0) {
      return;
    }
    if (this.activeJobs.size >= this.config.maxConcurrentJobs) {
      // 実行中の枠が空くのを待つ。空いたら settleJob が呼び直す。
      return;
    }

    this.isProcessing = true;

    while (this.jobQueue.length > 0 && this.activeJobs.size < this.config.maxConcurrentJobs) {
      const job = this.jobQueue.shift();
      if (!job) continue;
      try {
        await this.processJob(job);
      } catch (error) {
        console.error(`ComfyUI Worker - processQueue error for job ${job.id}:`, error);
      }
    }

    this.isProcessing = false;

    if (this.jobQueue.length > 0 && this.activeJobs.size < this.config.maxConcurrentJobs) {
      setTimeout(() => this.processQueue(), 1000);
    }
  }

  private async processJob(job: JobData): Promise<void> {
    try {
      this.sendJobProgress(job.datetime, 'job-started', { message: '画像変換を開始します' });

      
      let uploadedFilename: string;
      if (job.preUploadedFilename) {
        uploadedFilename = job.preUploadedFilename;
      } else {
        uploadedFilename = await this.uploadImage(job);
      }
      
      const promptId = await this.submitPrompt(job, uploadedFilename);
      
      this.activeJobs.set(job.datetime, {
        promptId,
        datetime: job.datetime,
        resultDir: job.resultDir,
        startTime: Date.now(),
        status: 'processing'
      });

      this.sendJobProgress(job.datetime, 'job-processing', { 
        promptId,
        message: 'ComfyUIで処理中です' 
      });

      this.monitorJob(job.datetime);

    } catch (error) {
      console.error(`ComfyUI Worker - processJob failed for ${job.id}:`, error);
      this.sendJobProgress(job.datetime, 'job-error', { 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }

  private async uploadImage(job: JobData): Promise<string> {
    try {
      const buffer = Buffer.from(job.imageData, 'base64');
      const filename = `photo_${job.datetime}.png`;
      
      const formData = new FormData();
      formData.append('image', buffer, { filename, contentType: 'image/png' });

      const response = await electronFetch(`${this.config.baseUrl}/upload/image`, {
        method: 'POST',
        body: formData,
        timeout: this.config.timeouts.upload
      });

      if (!response.ok) {
        const errorText = await response.buffer().then(buf => buf.toString()).catch(() => 'Unknown error');
        console.error(`ComfyUI Worker - uploadImage error response body: ${errorText}`);
        throw new Error(`画像アップロードエラー: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const result = await response.json() as ComfyUIUploadResponse;
      return result.name || filename;

    } catch (error) {
      console.error(`ComfyUI Worker - uploadImage failed for ${job.id}:`, error);
      throw new Error(`画像アップロード失敗: ${error}`);
    }
  }

  private async submitPrompt(job: JobData, uploadedFilename: string): Promise<string> {
    try {
      
      // 結果フォルダからimage_generate.jsonを読み込み
      const imageGeneratePath = path.join(job.resultDir, 'image_generate.json');
      
      let workflow: WorkflowTemplate;
      try {
        const workflowContent = await fs.readFile(imageGeneratePath, 'utf-8');
        workflow = JSON.parse(workflowContent);

      } catch (error) {
        throw new Error(`image_generate.json読み込み失敗: ${error}`);
      }

      // ComfyUI 側でリネームされた場合に備え、実際にアップロードされた
      // ファイル名で LoadImage を上書きする（テンプレートに焼いた名前は当てにしない）
      if (uploadedFilename) {
        for (const node of Object.values(workflow as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>)) {
          if (node && node.class_type === 'LoadImage' && node.inputs) {
            node.inputs.image = uploadedFilename;
          }
        }
      }

      // ワークフローテンプレートは既に正しいファイル名で設定済み

      const promptData = {
        prompt: workflow,
        client_id: `kidspg-${Date.now()}`,
        extra_pnginfo: {
          workflow: workflow,
          ds: {
            seed: Math.floor(Math.random() * 1000000),
            version: "0.0.1"
          }
        }
      };

      
      const response = await electronFetch(`${this.config.baseUrl}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(promptData),
        timeout: this.config.timeouts.processing
      });

      if (!response.ok) {
        const errorText = await response.buffer().then(buf => buf.toString()).catch(() => 'Unknown error');
        console.error(`ComfyUI Worker - Prompt error response body: ${errorText}`);
        throw new Error(`プロンプト送信エラー: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const result = await response.json() as ComfyUIPromptResponse;
      
      return result.prompt_id;

    } catch (error) {
      throw new Error(`プロンプト送信失敗: ${error}`);
    }
  }

  private async monitorJob(datetime: string): Promise<void> {
    const job = this.activeJobs.get(datetime);
    if (!job) return;

    const startTime = Date.now();
    const timeoutMs = this.config.timeouts.queue;

    // ポーリング用の HTTP タイムアウト。付けないと ComfyUI が TCP レベルで
    // 無応答（スワップ中など）になったとき poll が返らず、下のタイムアウト判定にすら
    // 到達せずにジョブが永久に宙吊りになる。
    //
    // 🔴 **短くしすぎないこと。** ComfyUI は推論を自分のメインスレッドで回すため、
    // CPU 実行（local プロファイル、1枚183秒）では**1ステップの間 HTTP 応答が
    // 数十秒止まる**ことがある。以前は 6秒で、これを通信エラーと見なして
    // 「まさに生成中のジョブをサーバから削除する」動きになっていた。
    const pollTimeout = Math.max(30_000, this.config.pollingInterval * 3);

    // ポーリングの失敗は即座に致命としない。連続で続いたときだけ諦める。
    // 1回の失敗でジョブを殺すと、その子のAI変換だけが無くなる。
    const maxConsecutivePollFailures = 5;
    let consecutivePollFailures = 0;

    // キュー期限の超過だけは通信エラーと区別する（前者は諦める、後者は粘る）
    let expired = false;

    /**
     * 🔴 **「queue にも history にも無い」を検出する。**
     *
     * ComfyUI を再起動すると（当日「重くなったので ComfyUI だけ入れ直す」は
     * 現実に起きる）、投入済みのプロンプトは queue からも history からも消える。
     * 以前はこの状態が例外にならず、2秒ごとに poll が回り続けて
     * **キュー期限（15分）まで唯一の実行枠を占有**していた。1枚170秒なので
     * およそ5人ぶんのAI変換が失われる（敵対的レビュー 2026-09-09 の指摘）。
     *
     * 投入直後は ComfyUI 側の反映に一瞬かかるので、1回では諦めない。
     * 連続で続いたときだけ「消えた」と判断する。
     */
    const maxConsecutiveVanished = 5;
    let consecutiveVanished = 0;

    const poll = async () => {
      try {
        // 🔴 **もう自分のジョブでなくなっていたら、そこで監視をやめる。**
        // cancelJob（終了確認・Esc からの中断）は activeJobs から消して
        // サーバ側のキューからも抜くが、この poll ループは何も知らないまま
        // キュー期限（既定15分）まで回り続け、最後に「job-error」を投げる。
        // 無駄な HTTP が続くうえ、キャンセル済みの回について
        // レンダラーへ嘘の失敗通知が飛ぶ。
        if (this.activeJobs.get(datetime) !== job) {
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          // 期限切れは「もう待てない」ので、下の catch で必ずジョブを消す
          expired = true;
          // 監視をやめるだけだと、ComfyUI 側にはジョブが残って実行され続ける。
          // 当日は「誰も受け取らない画像」のために CPU/GPU が占有され、
          // 後続の子の生成がさらに遅れる。キューからの削除は下の catch でまとめて行う
          // （ここで呼ぶと throw した先の catch でもう一度呼ばれ、二重にリクエストが飛ぶ）。
          throw new Error(`処理タイムアウト（${Math.round(timeoutMs / 1000)}秒）`);
        }

        const queueResponse = await electronFetch(`${this.config.baseUrl}/queue`, { timeout: pollTimeout });
        const queueData = await queueResponse.json() as ComfyUIQueueResponse;

        // ⚠️ **ここで数え直してはいけない。** 以前は /queue の応答が返った時点で
        // consecutivePollFailures = 0 にしていたため、「/queue は返るが /history が
        // 毎回タイムアウトする」場合に 1 と 0 を往復し、
        // maxConsecutivePollFailures に**永久に届かなかった**
        // （敵対的レビュー 2026-09-09 の指摘）。
        // 数え直すのは**その周回を最後まで通せたとき**だけ（下の2か所）。

        const position = this.findQueuePosition(queueData, job.promptId);

        if (position !== null) {
          // キューに居ることが分かった＝この周回は最後まで通った
          consecutivePollFailures = 0;
          consecutiveVanished = 0;
          this.sendJobProgress(datetime, 'job-queue-update', {
            position,
            message: position === 0 ? '処理中' : `キュー位置: ${position}`
          });

          setTimeout(poll, this.config.pollingInterval);
          return;
        }

        const historyResponse = await electronFetch(`${this.config.baseUrl}/history/${job.promptId}`, {
          timeout: pollTimeout,
        });

        if (historyResponse.ok) {
          const historyData = await historyResponse.json() as ComfyUIHistoryResponse;

          if (historyData[job.promptId]) {
            consecutiveVanished = 0;
            await this.completeJob(datetime, historyData[job.promptId]);
            return;
          }
        }

        // /queue と /history の両方を聞き切った＝この周回は最後まで通った
        consecutivePollFailures = 0;

        // ここに来たのは「queue に居ない」かつ「history にも無い」。
        // ComfyUI 側からプロンプトが消えている（再起動された等）。
        // 期限まで回し続けると実行枠を握ったままになるので、続いたら諦める。
        consecutiveVanished += 1;
        if (consecutiveVanished >= maxConsecutiveVanished) {
          throw new Error(
            'ComfyUI 側にプロンプトが見つかりません（キューにも履歴にも無い）。' +
              'ComfyUI が再起動された可能性があります'
          );
        }

        setTimeout(poll, this.config.pollingInterval);

      } catch (error) {
        // 通信の失敗は「生成が重くて応答が返らない」ことが多い。
        // 数回までは待ち、続いたときだけ諦める（1回で殺すとその子の変換が消える）。
        if (!expired) {
          consecutivePollFailures += 1;
          if (consecutivePollFailures < maxConsecutivePollFailures) {
            console.warn(
              `ComfyUI Worker - ポーリング失敗 ${consecutivePollFailures}/${maxConsecutivePollFailures}（生成中の可能性があるので継続します）: `
              + `${error instanceof Error ? error.message : String(error)}`
            );
            setTimeout(poll, this.config.pollingInterval);
            return;
          }
        }

        // 監視をやめる以上、理由がタイムアウトでも通信エラーでも
        // サーバ側のジョブは必ず消す。残すと「誰も回収しない画像」を作り続けて
        // 次の子の生成をさらに遅らせるうえ、settleJob が直後に次のジョブを
        // 投入するのでキューが二重に膨らむ。
        await this.cancelJobOnServer(job.promptId).catch((e) => {
          console.warn(`ComfyUI Worker - キュー削除に失敗: ${e}`);
        });
        this.settleJob(datetime);
        this.sendJobProgress(datetime, 'job-error', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    };

    poll();
  }

  private findQueuePosition(queue: ComfyUIQueueResponse, promptId: string): number | null {
    const pending = queue.queue_pending || [];
    const running = queue.queue_running || [];
    
    for (let i = 0; i < running.length; i++) {
      if (running[i][1] === promptId) {
        return 0;
      }
    }
    
    for (let i = 0; i < pending.length; i++) {
      if (pending[i][1] === promptId) {
        return i + 1;
      }
    }
    
    return null;
  }

  private async completeJob(datetime: string, historyData: ComfyUIHistoryResponse[string]): Promise<void> {
    try {
      const job = this.activeJobs.get(datetime);
      if (!job) return;

      const outputs = historyData.outputs;
      let imageUrl: string | null = null;
      let actualFilename: string | null = null;

      
      // SaveImageノード（通常はnode 9）を優先的に探す
      const saveImageNodeIds = ['9', '8']; // SaveImageノードの可能性があるID
      let selectedNodeId: string | null = null;
      
      // 最初にSaveImageノードを探す
      for (const nodeId of saveImageNodeIds) {
        if (outputs[nodeId] && outputs[nodeId].images && outputs[nodeId].images.length > 0) {
          selectedNodeId = nodeId;
          break;
        }
      }
      
      // SaveImageノードが見つからない場合、他のノードを探す
      if (!selectedNodeId) {
        for (const nodeId in outputs) {
          const nodeOutput = outputs[nodeId];
          if (nodeOutput.images && nodeOutput.images.length > 0) {
            selectedNodeId = nodeId;
            break;
          }
        }
      }
      
      if (selectedNodeId) {
        const nodeOutput = outputs[selectedNodeId];
        if (nodeOutput.images && nodeOutput.images.length > 0) {
          const image = nodeOutput.images[0];
          imageUrl = `${this.config.baseUrl}/view?filename=${image.filename}&subfolder=${image.subfolder}&type=${image.type}`;
          actualFilename = image.filename;
        }
      }

      if (!imageUrl || !actualFilename) {
        throw new Error('出力画像が見つかりません');
      }

      const savedFilePath = await this.downloadAndSaveResult(job, imageUrl, actualFilename);
      // image_generate.jsonが既に存在するため、workflow.json保存は不要

      this.settleJob(datetime);
      this.sendJobProgress(datetime, 'job-completed', { 
        message: '画像変換が完了しました',
        resultPath: savedFilePath,
        actualFilename: actualFilename
      });

    } catch (error) {
      this.settleJob(datetime);
      this.sendJobProgress(datetime, 'job-error', { 
        error: error instanceof Error ? error.message : String(error) 
      });
    }
  }

  /**
   * ComfyUI が作った画像を results/<日時>/ へ保存する。
   *
   * 🔴 **最終名へ直書きしてはいけない。**
   * ダウンロードが途中で切れると、切れた `photo_anime_*.png` が最終名で残る。
   * カード合成は入力画像を検査しないため、ImageMagick が部分デコードして exit 0 になり、
   * **IEND 付き（＝以後どの検査も通ってしまう）「上半分がグレーのカード」**が
   * その子の納品物として確定する。カード側の検査では永久に検出できない壊れ方。
   *
   * そのため一時名（プロセス固有の印つき）へ書き、
   *   1. Content-Length と本文長の一致
   *   2. PNG として完全か（IEND まで）
   * を確かめてから最終名へ rename する。カードの確定処理と同じ考え方。
   */
  private async downloadAndSaveResult(job: ActiveJob, imageUrl: string, actualFilename: string): Promise<string> {
    const outputPath = path.join(job.resultDir, actualFilename);
    const partialPath = buildPartialOutputPath(outputPath);

    try {
      // 本文が止まった接続で永久にぶら下がらないよう、必ずタイムアウトを付ける。
      //
      // ⚠️ **POST 用の timeouts.processing（既定10分）を流用しないこと。**
      // ここは 127.0.0.1 から 200KB 前後を受け取るだけで、10分は明らかに過大。
      // しかも settleJob はこの**後**に呼ばれるので、本文が途中で止まると
      // その間ずっと唯一の実行枠（maxConcurrentJobs=1）が空かず、
      // 次の子のジョブが1件も投入されない（敵対的レビュー 2026-09-09 の指摘）。
      // upload と同じ尺度（既定60秒）にしておく。
      const downloadTimeout = Math.min(
        this.config.timeouts.upload,
        this.config.timeouts.processing
      );
      const response = await electronFetch(imageUrl, { timeout: downloadTimeout });
      if (!response.ok) {
        throw new Error(`画像ダウンロードエラー: ${response.status}`);
      }

      const buffer = await response.buffer();

      const contentLength = response.headers['content-length'];
      const expected = Number(Array.isArray(contentLength) ? contentLength[0] : contentLength);
      if (Number.isFinite(expected) && expected > 0 && buffer.length !== expected) {
        throw new Error(`画像が途中で切れています (${buffer.length}/${expected} バイト)`);
      }

      await fs.writeFile(partialPath, buffer);

      const integrity = await verifyPngFile(partialPath);
      if (!integrity.valid) {
        if (integrity.status === 'corrupt') {
          // 明確に壊れているものだけ消す
          await fs.unlink(partialPath).catch(() => undefined);
        }
        // unknown（読めなかっただけ）は残す。掃除・救済が後で拾う
        throw new Error(`ダウンロードした画像が不完全です (${integrity.status}: ${integrity.error})`);
      }

      // 🔴 **rename は必ずリトライを通す。** results/ は OneDrive 同期下で、
      // 書いた直後は同期のアップロードとウイルス対策のスキャンが走るため
      // EPERM / EBUSY（共有違反）が普通に起きる。1回で諦めて
      // **検査に通った完成品を消す**と、その子のAI画像は永久に無くなる
      // （アプリ内に再投入の経路は無く、救済は1枚3分のCPU再生成しかない）。
      await renameWithRetry(partialPath, outputPath);
      return outputPath;

    } catch (error) {
      // 🔴 **完成している一時ファイルは消さない。**
      // `photo_anime_*` は救済（cleanupPartialCardOutputs）の対象なので、
      // 残しておけば最終名へ据え直される。ここで消すとその救済経路を自分で潰す。
      const leftover = await verifyPngFile(partialPath);
      if (leftover.status === 'corrupt') {
        await fs.unlink(partialPath).catch(() => undefined);
      } else if (leftover.valid) {
        console.warn(`ComfyUI Worker - 完成した画像を一時名で残します（後で救済されます）: ${partialPath}`);
      }
      throw new Error(`結果保存失敗: ${error}`);
    }
  }


  async getStatus(): Promise<Record<string, unknown>> {
    try {
      // 実際のComfyUIサーバーのキュー状況を取得。
      // 🔴 タイムアウトを付けないと、ComfyUI が無応答のとき（＝まさに状況を
      // 知りたいとき）この fetch が返らず、ソケットを掴んだまま残る。
      // 呼び出し側（ComfyUIService.getStatus）は別に期限を持っているので
      // 画面は待たされないが、掴んだ接続だけが積み上がる。
      const queueResponse = await electronFetch(`${this.config.baseUrl}/queue`, {
        timeout: ComfyUIWorker.CANCEL_TIMEOUT_MS,
      });
      const queueData = await queueResponse.json() as ComfyUIQueueResponse;
      
      return {
        activeJobs: Array.from(this.activeJobs.entries()).map(([datetime, job]) => ({
          datetime,
          status: job.status,
          promptId: job.promptId,
          duration: Date.now() - job.startTime
        })),
        internalQueueLength: this.jobQueue.length,
        serverQueueRunning: (queueData.queue_running || []).length,
        serverQueuePending: (queueData.queue_pending || []).length,
        maxConcurrentJobs: this.config.maxConcurrentJobs
      };
    } catch (error) {
      console.error('Failed to get server queue status:', error);
      return {
        activeJobs: Array.from(this.activeJobs.entries()).map(([datetime, job]) => ({
          datetime,
          status: job.status,
          promptId: job.promptId,
          duration: Date.now() - job.startTime
        })),
        internalQueueLength: this.jobQueue.length,
        serverQueueRunning: 0,
        serverQueuePending: 0,
        maxConcurrentJobs: this.config.maxConcurrentJobs,
        error: 'サーバーキュー取得失敗'
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await electronFetch(`${this.config.baseUrl}/system_stats`, {
        timeout: 5000
      });
      return response.ok;
    } catch (error) {
      console.error('ComfyUI health check error:', error);
      return false;
    }
  }
}

let worker: ComfyUIWorker | null = null;

parentPort?.on('message', async (message: WorkerMessage) => {
  const { type, data } = message;

  try {
    
    switch (type) {
      case 'init':
        worker = new ComfyUIWorker(data.config as ComfyUIConfig);
        parentPort?.postMessage({ type: 'ready', data: {} });
        break;

      case 'pre-upload-image':
        if (worker) {
          const { imageData, datetime } = data as { imageData: string; datetime: string };
          await worker.preUploadImage(imageData, datetime);
        } else {
          console.error('ComfyUI Worker - Worker not initialized for pre-upload-image');
        }
        break;

      case 'add-job':
        if (worker) {
          const jobData = data as unknown as JobData;
          await worker.addJob(jobData);
        } else {
          console.error('ComfyUI Worker - Worker not initialized for add-job');
        }
        break;

      case 'cancel-job':
        if (worker) {
          const { datetime } = data as { datetime: string };
          await worker.cancelJob(datetime);
        } else {
          console.error('ComfyUI Worker - Worker not initialized for cancel-job');
        }
        break;

      case 'get-status':
        if (worker) {
          const status = await worker.getStatus();
          parentPort?.postMessage({ type: 'status', data: status });
        } else {
          console.error('ComfyUI Worker - Worker not initialized for get-status');
        }
        break;

      case 'health-check':
        if (worker) {
          const isHealthy = await worker.healthCheck();
          parentPort?.postMessage({ type: 'health-check-result', data: { isHealthy } });
        } else {
          console.error('ComfyUI Worker - Worker not initialized for health-check');
        }
        break;

      default:
        console.warn('ComfyUI Worker - Unknown message type:', type);
    }
  } catch (error) {
    console.error(`ComfyUI Worker - Message handling error for type ${type}:`, error);
    parentPort?.postMessage({ 
      type: 'error', 
      data: { 
        message: error instanceof Error ? error.message : String(error),
        messageType: type
      } 
    });
  }
});

// Uncaught exception handler
process.on('uncaughtException', (error) => {
  console.error('ComfyUI Worker - Uncaught exception:', error);
  parentPort?.postMessage({ 
    type: 'error', 
    data: { 
      message: `Uncaught exception: ${error.message}`,
      stack: error.stack
    } 
  });
  process.exit(1);
});

// Unhandled rejection handler  
process.on('unhandledRejection', (reason, promise) => {
  console.error('ComfyUI Worker - Unhandled rejection at:', promise, 'reason:', reason);
  parentPort?.postMessage({ 
    type: 'error', 
    data: { 
      message: `Unhandled rejection: ${reason}`,
      promise: String(promise)
    } 
  });
});