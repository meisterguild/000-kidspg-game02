# ComfyUI連携機能 詳細設計書

## 1. 概要

現在のElectronアプリケーションに、ComfyUI APIを利用して顔写真をアニメ調に変換する機能を追加する。
変換された画像は記念カード生成処理に利用される。

## 2. 現状システム分析

### 2.1. 現在のファイル出力構造

main.ts:159-187で確認した現在の保存処理：

```typescript
// 写真保存処理
ipcMain.handle('save-photo', async (event, imageData: string) => {
  const dateTime = getFormattedDateTime(new Date()); // YYYYMMDD_HHMMSS形式
  const dirPath = path.join(process.cwd(), 'results', dateTime);
  await fs.mkdir(dirPath, { recursive: true });
  
  const filePath = path.join(dirPath, 'photo.png'); // 写真は固定で 'photo.png'
  // ... 保存処理
  return { success: true, dirPath: dirPath }; // ディレクトリパスを返却
});

// JSON保存処理  
ipcMain.handle('save-json', async (event, dirPath: string, jsonData: object) => {
  const filePath = path.join(dirPath, 'result.json'); // JSON は固定で 'result.json'
  // ... 保存処理
});
```

### 2.2. 現在のデータフロー

1. **CameraPage.tsx** → 写真撮影・保存（`photo.png`）→ resultDir設定
2. **CountdownPage.tsx** → カウントダウン
3. **GamePage.tsx** → ゲーム実行
4. **ResultPage.tsx** → ゲーム結果保存（`result.json`）

**重要な変更点**：
- 写真ファイル名: `photo.png` (固定)
- 結果ファイル名: `result.json` (固定)
- 保存先: `results/{YYYYMMDD_HHMMSS}/` (日時ベースのディレクトリ)

## 3. ComfyUI連携設計

### 3.1. システム構成

```
[CameraPage] → 写真撮影 → ComfyUI変換 → [CountdownPage] → [GamePage] → [ResultPage]
                ↓                ↓
        results/{datetime}/    ComfyUI処理
        ├── photo.png         input/ → processing → output/
        ├── img_generate.json      ↓
        ├── photo_anime.png   ← コピー取得
        └── result.json       
```

### 3.2. 詳細データフロー（API中心設計）

1. **写真撮影・保存**（CameraPage.tsx）
   - 500x500px写真を撮影
   - 元写真を`photo.png`として保存（既存処理）
   - resultDirを設定（既存処理）

2. **ComfyUIワークフロー生成**（Main Process）
   - `assets/ComfyUI_KidsPG_01.json`をテンプレートとして読み込み
   - 日時情報を使って動的置換を実行：
     - SaveImageノード: `filename_prefix` → `KidsPG_Player_Photo_{datetime}`
     - LoadImageノード: `image` → `{uploaded_filename}` (APIアップロード時の返却ファイル名)
   - 置換後のワークフローを`results/{datetime}/img_generate.json`として保存

3. **ComfyUI実行**（Main Process）
   - `/upload/image` APIで元写真をComfyUI内部ストレージにアップロード
   - アップロード時のレスポンスからファイル名を取得
   - ワークフローJSONの`LoadImage`ノードのファイル名を実際のアップロード名に更新
   - 更新後のワークフローを`/prompt`エンドポイントに送信
   - 生成処理をキューに追加してprompt_idを取得

4. **結果待機・取得**（Main Process）
   - `/queue`と`/history`エンドポイントで完了をポーリング監視
   - 完了後、`/history/{prompt_id}`から出力ファイル情報を取得
   - `/view` APIエンドポイントで生成画像を直接ダウンロード
   - ダウンロードした画像を`results/{datetime}/photo_anime.png`として保存

5. **ゲーム実行・結果保存**（既存フロー）
   - 変換後画像をUI表示用にGameSessionContextに保存
   - 従来通りゲーム実行
   - result.jsonにanimeImagePathを追加保存

### 3.3. API中心の画像取得戦略

#### 3.3.1. /upload/image の適切な使用
```typescript
// アップロード処理
const uploadResult = await fetch('/upload/image', {
  method: 'POST',
  body: formData // 画像ファイル
});

const { name } = await uploadResult.json();
// name: ComfyUI内部でのファイル名（例: "tmpA1B2C3.png"）

// ワークフロー内のLoadImageノードを更新
workflow["10"].inputs.image = name;
```

#### 3.3.2. /view による画像取得
```typescript
// /history から出力ファイル情報を取得
const history = await fetch(`/history/${promptId}`).then(r => r.json());
const outputs = history[promptId].outputs;

// SaveImageノードの出力ファイルを特定
const saveImageNodeId = "9"; // SaveImageノードのID
const outputFiles = outputs[saveImageNodeId]?.images || [];

if (outputFiles.length > 0) {
  const imageInfo = outputFiles[0]; // 最初の画像を使用
  
  // /view APIで画像を直接取得
  const imageResponse = await fetch(`/view?filename=${imageInfo.filename}&subfolder=${imageInfo.subfolder}&type=${imageInfo.type}`);
  const imageBuffer = await imageResponse.arrayBuffer();
  
  // ローカルファイルとして保存
  await fs.writeFile(targetPath, Buffer.from(imageBuffer));
}
```

#### 3.3.3. ファイルシステム依存の排除
- ❌ **削除**: ComfyUIのinput/outputフォルダへの直接アクセス
- ✅ **追加**: `/upload/image` → `/prompt` → `/view` の完全API化
- ✅ **利点**: ネットワーク越しのComfyUI、Docker環境対応
- ✅ **堅牢性**: ファイルシステムの権限問題回避

### 3.3. ファイル構造変更

#### 保存ファイル
```
results/{YYYYMMDD_HHMMSS}/
├── photo.png         # 元の写真（既存）
├── photo_anime.png   # 変換後アニメ画像（追加）
├── img_generate.json # ComfyUI実行用ワークフロー（追加）
└── result.json       # ゲーム結果（既存、フィールド追加）
```

#### ComfyUI内部ストレージ（API管理）
```
ComfyUI内部ストレージ（APIアクセスのみ）:
├── /upload/image → 内部temp領域      # API経由でアップロード
├── /prompt → 処理キュー              # ワークフロー実行
└── /view → 出力画像                  # API経由で取得

注意: ファイルシステムへの直接アクセスは行わない
```

#### result.json拡張
```typescript
interface GameResult {
  nickname: string;
  rank: GameRank;
  level: GameLevel;
  score: number;
  timestampJST: string;
  imagePath: string;          // 'photo.png' (既存)
  animeImagePath?: string;    // 'photo_anime.png' (追加)
}
```

## 4. 実装設計（Worker Thread中心）

### 4.1. ワーカー設計方針

**重要**: ComfyUI処理はメインプロセスをブロックしないよう、専用Worker Threadで実行します。
メインプロセスは軽量なIPC処理のみを担当し、ゲーム操作の応答性を完全に維持します。

### 4.2. メインプロセス（軽量IPC層）

```typescript
// src/main/main.ts - 軽量IPC層のみ
class ElectronApp {
  private comfyUIWorker: Worker | null = null;
  private activeJobs = new Map<string, { datetime: string; startTime: number }>();
  
  private setupComfyUIWorker(): void {
    this.comfyUIWorker = new Worker(path.join(__dirname, 'workers/comfyui_worker.js'));
    
    this.comfyUIWorker.on('message', (response: ComfyUIWorkerResponse) => {
      this.handleWorkerResponse(response);
    });
    
    this.comfyUIWorker.on('error', (error) => {
      console.error('ComfyUIワーカーエラー:', error);
      this.broadcastToRenderers('comfyui-error', { error: error.message });
    });
  }
  
  // 非ブロッキングIPC handler（即座に応答）
  private setupIPC(): void {
    ipcMain.handle('transform-image-to-anime', async (event, imageData: string, dirPath: string) => {
      if (!this.config?.comfyui?.enabled) {
        return { success: false, error: 'ComfyUI機能が無効です' };
      }
      
      const dateTime = path.basename(dirPath);
      
      // 既存ジョブのチェック
      if (this.activeJobs.size > 0) {
        return { success: false, error: '他の変換処理が実行中です' };
      }
      
      // ジョブ登録
      this.activeJobs.set(dateTime, { datetime: dateTime, startTime: Date.now() });
      
      // ワーカーに処理を委譲（非ブロッキング）
      this.comfyUIWorker?.postMessage({
        type: 'transform',
        data: { imageData, datetime: dateTime, resultDir: dirPath, config: this.config.comfyui }
      });
      
      // 即座に処理開始応答を返す
      return { success: true, processing: true, message: '変換処理を開始しました' };
    });
  }
}
```

### 4.3. プリロード拡張 (src/main/preload.ts)

```typescript
interface ElectronAPI {
  // 既存API
  savePhoto: (imageData: string) => Promise<{ success: boolean; dirPath?: string; error?: string }>;
  saveJson: (dirPath: string, jsonData: object) => Promise<{ success: boolean; error?: string }>;
  
  // ComfyUI関連API（非ブロッキング）
  transformImageToAnime: (imageData: string, dirPath: string) => Promise<{ success: boolean; processing?: boolean; message?: string; error?: string }>;
  cancelTransform: () => Promise<{ success: boolean; message?: string }>;
  testComfyUIConnection: () => Promise<{ success: boolean; message?: string }>;
  getActiveJobs: () => Promise<Array<{ id: string; datetime: string; elapsedTime: number }>>;
  
  // イベントリスナー（進捗受信用）
  on: (channel: string, callback: (event: any, data: any) => void) => void;
  off: (channel: string, callback: (event: any, data: any) => void) => void;
}
```

### 4.4. フロントエンド拡張（非ブロッキング対応）

#### GameSessionContext拡張
```typescript
interface GameSessionState {
  // 既存フィールド
  capturedImage: string;
  selectedNickname: string;
  gameScore: number;
  resultDir: string;
  
  // ComfyUI関連フィールド
  animeImage: string;          // 変換後画像データ（Data URL）
  transformStatus: 'idle' | 'uploading' | 'processing' | 'completed' | 'error';
  transformProgress: number;   // 0-100
  transformError: string;      // 変換エラー
}
```

#### CameraPage.tsx拡張（非ブロッキング）
```typescript
const handleConfirm = useCallback(async () => {
  if (!capturedImage || isSavingHook) return;

  playSound('buttonClick');

  // 1. 写真保存（既存処理）
  const result = await savePhoto(capturedImage);
  
  if (result.success && result.dirPath) {
    setResultDir(result.dirPath);
    
    // 2. ComfyUI変換開始（非ブロッキング）
    setTransformStatus('uploading');
    setTransformError('');
    
    try {
      const transformResult = await window.api.transformImageToAnime(capturedImage, result.dirPath);
      
      if (transformResult.success && transformResult.processing) {
        // 変換開始成功 - 進捗はイベントで受信
        setTransformStatus('processing');
        setCurrentScreen('COUNTDOWN'); // ゲームはすぐ開始
      } else {
        setTransformError(transformResult.error || '画像変換の開始に失敗しました');
        setTransformStatus('error');
        setCurrentScreen('COUNTDOWN'); // エラー時も元画像でゲーム続行
      }
    } catch (error) {
      setTransformError(String(error));
      setTransformStatus('error');
      setCurrentScreen('COUNTDOWN'); // エラー時も元画像でゲーム続行
    }
  } else {
    console.error('写真の保存に失敗しました:', saveError || result.error);
    alert(`写真の保存に失敗しました: ${saveError || result.error}`);
  }
}, [capturedImage, setResultDir, setCurrentScreen, savePhoto, isSavingHook, saveError]);

// ComfyUI進捗イベントリスナー
useEffect(() => {
  const handleProgress = (event: any, progress: ComfyUIWorkerResponse) => {
    if (progress.type === 'progress') {
      setTransformStatus('processing');
      setTransformProgress(progress.data.progress || 0);
    } else if (progress.type === 'completed') {
      setTransformStatus('completed');
      setTransformProgress(100);
      if (progress.data.imageBuffer) {
        // ArrayBuffer to Data URL conversion
        const blob = new Blob([progress.data.imageBuffer], { type: 'image/png' });
        const reader = new FileReader();
        reader.onload = () => setAnimeImage(reader.result as string);
        reader.readAsDataURL(blob);
      }
    } else if (progress.type === 'error') {
      setTransformStatus('error');
      setTransformError(progress.data.error || 'Unknown error');
    }
  };

  window.api.on('comfyui-progress', handleProgress);
  return () => window.api.off('comfyui-progress', handleProgress);
}, []);
```

#### ResultPage.tsx拡張
```typescript
// GameResult生成時にanimeImagePathを追加
const gameResult: GameResult = {
  nickname: selectedNickname,
  rank: rankValue,
  level: levelValue,
  score: gameScore,
  timestampJST: timestamp,
  imagePath: 'photo.png',
  animeImagePath: transformStatus === 'completed' ? 'photo_anime.png' : undefined
};
```

### 4.5. ワーカー内ワークフロー処理

#### ワークフローテンプレート配置
```
assets/ComfyUI_KidsPG_01.json  # API形式でエクスポートしたワークフローテンプレート
```

#### ワーカー内でのワークフロー処理
```typescript
// src/main/workers/comfyui_worker.ts 内
private async generateWorkflow(datetime: string, resultDir: string): Promise<any> {
  // テンプレート読み込み
  const templatePath = path.join(process.cwd(), 'assets', 'ComfyUI_KidsPG_01.json');
  const template = JSON.parse(await fs.readFile(templatePath, 'utf-8'));
  
  // SaveImageノードのfilename_prefix更新
  template["9"].inputs.filename_prefix = `KidsPG_Player_Photo_${datetime}`;
  
  // 生成されたワークフローを保存
  const workflowPath = path.join(resultDir, 'img_generate.json');
  await fs.writeFile(workflowPath, JSON.stringify(template, null, 2));
  
  return template;
}
```

#### ワークフロー構成（ComfyUI_KidsPG_01.json）
1. **LoadImage (node 10)**: アップロードされた顔写真を読み込み
2. **HEDPreprocessor (node 27)**: エッジ検出前処理  
3. **ControlNetLoader (node 25)**: コントロールネット読み込み
4. **CheckpointLoader (node 4)**: アニメ風ベースモデル読み込み
5. **LoraLoader (node 13)**: アニメスタイルLoRA適用
6. **WD14Tagger (node 14)**: 自動タグ生成
7. **KSampler (node 3)**: 画像生成実行
8. **SaveImage (node 9)**: 結果画像保存（出力先決定）

## 5. エラーハンドリング

### 5.1. ComfyUIサーバー未起動時
- 変換処理をスキップし、元画像でゲーム続行
- ユーザーに「画像変換をスキップしました」と通知

### 5.2. 変換処理タイムアウト時
- 120秒でタイムアウト設定
- 元画像でゲーム続行

### 5.3. 変換失敗時
- エラーログ出力
- 元画像でゲーム続行
- ユーザーに簡潔なエラーメッセージ表示

## 6. TestPage拡張

### 6.1. ComfyUI管理機能追加

TestPage.tsxに以下機能を追加：

```typescript
interface ComfyUITestState {
  connectionStatus: 'unknown' | 'connected' | 'disconnected' | 'testing';
  systemStats: any;
  queueData: {
    queue_running: any[];
    queue_pending: any[];
    last_updated: string;
  } | null;
  historyData: any;
  activeJobs: any[];
  lastTransformResult: any;
  autoRefresh: boolean;
}

export const ComfyUITestSection: React.FC = () => {
  const [testState, setTestState] = useState<ComfyUITestState>({
    connectionStatus: 'unknown',
    systemStats: null,
    queueData: null,
    historyData: null,
    activeJobs: [],
    lastTransformResult: null,
    autoRefresh: false
  });

  const [refreshInterval, setRefreshInterval] = useState<NodeJS.Timeout | null>(null);

  // === /system_stats で接続テスト ===
  const testConnection = async () => {
    setTestState(prev => ({ ...prev, connectionStatus: 'testing' }));
    
    try {
      const startTime = Date.now();
      const response = await fetch('http://127.0.0.1:8188/system_stats');
      const responseTime = Date.now() - startTime;
      
      if (response.ok) {
        const stats = await response.json();
        setTestState(prev => ({ 
          ...prev, 
          connectionStatus: 'connected',
          systemStats: {
            ...stats,
            response_time_ms: responseTime,
            last_checked: new Date().toISOString()
          }
        }));
      } else {
        setTestState(prev => ({ 
          ...prev, 
          connectionStatus: 'disconnected',
          systemStats: {
            error: `HTTP ${response.status}: ${response.statusText}`,
            response_time_ms: responseTime,
            last_checked: new Date().toISOString()
          }
        }));
      }
    } catch (error) {
      setTestState(prev => ({ 
        ...prev, 
        connectionStatus: 'disconnected',
        systemStats: {
          error: error instanceof Error ? error.message : String(error),
          last_checked: new Date().toISOString()
        }
      }));
    }
  };

  // === /queue でキュー状況取得 ===  
  const refreshQueueStatus = async () => {
    try {
      const response = await fetch('http://127.0.0.1:8188/queue');
      if (response.ok) {
        const queueData = await response.json();
        setTestState(prev => ({ 
          ...prev, 
          queueData: {
            queue_running: queueData.queue_running || [],
            queue_pending: queueData.queue_pending || [],
            last_updated: new Date().toISOString()
          }
        }));
      } else {
        console.error('キュー取得失敗:', response.status);
      }
    } catch (error) {
      console.error('キュー状況取得エラー:', error);
    }
  };

  // === /history で履歴取得 ===
  const refreshHistory = async () => {
    try {
      const response = await fetch('http://127.0.0.1:8188/history');
      if (response.ok) {
        const historyData = await response.json();
        setTestState(prev => ({ ...prev, historyData }));
      } else {
        console.error('履歴取得失敗:', response.status);
      }
    } catch (error) {
      console.error('履歴取得エラー:', error);
    }
  };

  // === すべての状況を更新 ===
  const refreshAllStatus = async () => {
    await Promise.all([
      refreshQueueStatus(),
      refreshHistory(),
      // アプリ側のアクティブジョブも取得
      (async () => {
        try {
          const jobs = await window.api.getActiveJobs();
          setTestState(prev => ({ ...prev, activeJobs: jobs }));
        } catch (error) {
          console.error('アクティブジョブ取得エラー:', error);
        }
      })()
    ]);
  };

  // === 自動リフレッシュ切り替え ===
  const toggleAutoRefresh = () => {
    if (testState.autoRefresh) {
      // 停止
      if (refreshInterval) {
        clearInterval(refreshInterval);
        setRefreshInterval(null);
      }
      setTestState(prev => ({ ...prev, autoRefresh: false }));
    } else {
      // 開始
      const interval = setInterval(refreshAllStatus, 3000); // 3秒間隔
      setRefreshInterval(interval);
      setTestState(prev => ({ ...prev, autoRefresh: true }));
      refreshAllStatus(); // 即座に1回実行
    }
  };

  // クリーンアップ
  useEffect(() => {
    return () => {
      if (refreshInterval) {
        clearInterval(refreshInterval);
      }
    };
  }, [refreshInterval]);

  // === ダミー画像変換テスト ===
  const testDummyTransform = async () => {
    // 500x500のダミー画像生成
    const canvas = document.createElement('canvas');
    canvas.width = 500;
    canvas.height = 500;
    const ctx = canvas.getContext('2d')!;
    
    // グラデーション背景
    const gradient = ctx.createLinearGradient(0, 0, 500, 500);
    gradient.addColorStop(0, '#ff6b6b');
    gradient.addColorStop(1, '#4ecdc4');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 500, 500);
    
    // テキスト描画
    ctx.fillStyle = 'white';
    ctx.font = '48px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('TEST IMAGE', 250, 220);
    ctx.fillText(new Date().toLocaleTimeString(), 250, 280);
    
    const dummyImageData = canvas.toDataURL('image/png');
    
    try {
      const dateTime = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const testDir = `test_${dateTime}`;
      
      const result = await window.api.transformImageToAnime(dummyImageData, testDir);
      setTestState(prev => ({ ...prev, lastTransformResult: result }));
      
      if (result.success) {
        alert('ダミー画像変換テストを開始しました');
      } else {
        alert(`変換テスト失敗: ${result.error}`);
      }
    } catch (error) {
      alert(`変換テストエラー: ${error}`);
    }
  };

  // === 変換キャンセル ===
  const cancelTransform = async () => {
    try {
      const result = await window.api.cancelTransform();
      if (result.success) {
        alert('変換処理をキャンセルしました');
        refreshQueueStatus();
      }
    } catch (error) {
      alert(`キャンセルエラー: ${error}`);
    }
  };

  // ComfyUI進捗監視
  useEffect(() => {
    const handleProgress = (event: any, progress: ComfyUIWorkerResponse) => {
      console.log('ComfyUI進捗:', progress);
      // 進捗に応じたUI更新
    };

    window.api.on('comfyui-progress', handleProgress);
    return () => window.api.off('comfyui-progress', handleProgress);
  }, []);

  return (
    <div className="comfyui-test-section">
      <h3>ComfyUI 接続・管理テスト</h3>
      
      {/* 接続状況 */}
      <div className="connection-status">
        <span>接続状況: </span>
        <span className={`status-${testState.connectionStatus}`}>
          {testState.connectionStatus === 'connected' && '✅ 接続中'}
          {testState.connectionStatus === 'disconnected' && '❌ 切断'}
          {testState.connectionStatus === 'testing' && '🔄 テスト中'}
          {testState.connectionStatus === 'unknown' && '❓ 不明'}
        </span>
      </div>

      {/* システム統計情報表示 */}
      {testState.systemStats && (
        <div className="system-stats">
          <h4>ComfyUI システム情報</h4>
          <div className="stats-grid">
            {testState.connectionStatus === 'connected' ? (
              <>
                <div>応答時間: {testState.systemStats.response_time_ms}ms</div>
                <div>メモリ使用量: {(testState.systemStats.system?.ram_used / 1024 / 1024 / 1024).toFixed(2)}GB</div>
                <div>GPU: {testState.systemStats.devices?.[0]?.name || 'N/A'}</div>
                <div>VRAM: {(testState.systemStats.devices?.[0]?.vram_used / 1024 / 1024).toFixed(2)}MB / {(testState.systemStats.devices?.[0]?.vram_total / 1024 / 1024).toFixed(2)}MB</div>
              </>
            ) : (
              <div className="error">エラー: {testState.systemStats.error}</div>
            )}
            <div>最終確認: {new Date(testState.systemStats.last_checked).toLocaleTimeString()}</div>
          </div>
        </div>
      )}

      {/* テストボタン群 */}
      <div className="test-buttons">
        <button onClick={testConnection}>
          {testState.connectionStatus === 'testing' ? '確認中...' : '/system_stats 接続テスト'}
        </button>
        <button onClick={refreshAllStatus}>
          /queue + /history 更新
        </button>
        <button 
          onClick={toggleAutoRefresh}
          className={testState.autoRefresh ? 'active' : ''}
        >
          {testState.autoRefresh ? '⏸️ 自動更新停止' : '▶️ 自動更新開始(3秒間隔)'}
        </button>
        <button onClick={testDummyTransform}>ダミー画像変換テスト</button>
        <button onClick={cancelTransform}>変換キャンセル</button>
      </div>

      {/* キュー状況表示 */}
      {testState.queueData && (
        <div className="queue-status">
          <h4>ComfyUI キュー状況</h4>
          <div className="queue-info">
            <span>最終更新: {new Date(testState.queueData.last_updated).toLocaleTimeString()}</span>
          </div>
          
          {/* 実行中 */}
          <div className="queue-section">
            <h5>🔄 実行中 ({testState.queueData.queue_running.length}件)</h5>
            {testState.queueData.queue_running.length === 0 ? (
              <p>実行中のジョブはありません</p>
            ) : (
              <div className="queue-list">
                {testState.queueData.queue_running.map((job, index) => (
                  <div key={job[1]} className="queue-item running">
                    <span>ID: {job[1]}</span>
                    <span>ノード数: {Object.keys(job[2]).length}</span>
                    <span>実行中</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 待機中 */}
          <div className="queue-section">
            <h5>⏳ 待機中 ({testState.queueData.queue_pending.length}件)</h5>
            {testState.queueData.queue_pending.length === 0 ? (
              <p>待機中のジョブはありません</p>
            ) : (
              <div className="queue-list">
                {testState.queueData.queue_pending.map((job, index) => (
                  <div key={job[1]} className="queue-item pending">
                    <span>#{index + 1}</span>
                    <span>ID: {job[1]}</span>
                    <span>ノード数: {Object.keys(job[2]).length}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 実行履歴表示 */}
      {testState.historyData && (
        <div className="history-status">
          <h4>ComfyUI 実行履歴</h4>
          <div className="history-list">
            {Object.entries(testState.historyData)
              .slice(0, 10) // 最新10件表示
              .map(([promptId, historyItem]: [string, any]) => (
              <div key={promptId} className="history-item">
                <div className="history-header">
                  <span>ID: {promptId}</span>
                  <span className={`status ${historyItem.status?.completed ? 'completed' : 'error'}`}>
                    {historyItem.status?.completed ? '✅ 完了' : '❌ エラー'}
                  </span>
                </div>
                <div className="history-details">
                  <span>ノード数: {Object.keys(historyItem.prompt?.[0] || {}).length}</span>
                  {historyItem.outputs && Object.keys(historyItem.outputs).length > 0 && (
                    <span>出力: {Object.keys(historyItem.outputs).length}ファイル</span>
                  )}
                  {historyItem.status?.messages && historyItem.status.messages.length > 0 && (
                    <span className="error-msg">
                      エラー: {historyItem.status.messages[0]?.[1] || 'Unknown'}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* アクティブジョブ表示 */}
      {testState.activeJobs.length > 0 && (
        <div className="active-jobs">
          <h4>実行中ジョブ</h4>
          {testState.activeJobs.map(job => (
            <div key={job.id} className="job-item">
              <span>ID: {job.datetime}</span>
              <span>経過時間: {Math.floor(job.elapsedTime / 1000)}秒</span>
            </div>
          ))}
        </div>
      )}

      {/* 最後の変換結果 */}
      {testState.lastTransformResult && (
        <div className="last-result">
          <h4>最後の変換結果</h4>
          <pre>{JSON.stringify(testState.lastTransformResult, null, 2)}</pre>
        </div>
      )}
    </div>
  );
};
```

### 6.2. 変換履歴・統計表示

```typescript
// 変換履歴管理
interface TransformHistory {
  datetime: string;
  status: 'success' | 'error' | 'cancelled';
  duration: number;
  errorMessage?: string;
  originalImageSize: number;
  resultImageSize?: number;
}

// results フォルダをスキャンして履歴を表示
const loadTransformHistory = async (): Promise<TransformHistory[]> => {
  // resultsフォルダから過去の変換結果を読み込み
  // photo.png, photo_anime.png, result.json の存在チェック
  // 変換成功・失敗の判定
};

export const TransformHistorySection: React.FC = () => {
  const [history, setHistory] = useState<TransformHistory[]>([]);
  
  return (
    <div className="transform-history">
      <h3>変換履歴 ({history.length}件)</h3>
      
      <div className="history-stats">
        <span>成功: {history.filter(h => h.status === 'success').length}</span>
        <span>失敗: {history.filter(h => h.status === 'error').length}</span>
        <span>平均時間: {calculateAverageTime(history)}秒</span>
      </div>
      
      <div className="history-list">
        {history.map(item => (
          <div key={item.datetime} className="history-item">
            <span>{item.datetime}</span>
            <span className={`status-${item.status}`}>
              {item.status === 'success' && '✅'}
              {item.status === 'error' && '❌'}
              {item.status === 'cancelled' && '⚠️'}
            </span>
            <span>{item.duration}秒</span>
            {item.errorMessage && <span>{item.errorMessage}</span>}
          </div>
        ))}
      </div>
    </div>
  );
};
```

## 7. 設定管理

### 7.1. ComfyUI設定 (config.json拡張)

```json
{
  "game": { /* 既存のゲーム設定 */ },
  "_comment_comfyui_settings": "ComfyUI連携機能の設定",
  "comfyui": {
    "_comment_enabled": "ComfyUI機能の有効/無効切り替え",
    "enabled": true,
    "_comment_api_settings": "ComfyUI APIサーバーの設定",
    "api": {
      "baseUrl": "http://127.0.0.1:8188",
      "timeout": 120000,
      "endpoints": {
        "upload": "/upload/image",
        "prompt": "/prompt",
        "view": "/view",
        "history": "/history"
      }
    },
    "_comment_paths": "ComfyUI設定",
    "paths": {
      "workflowTemplate": "assets/ComfyUI_KidsPG_01.json"
    },
    "_comment_workflow_settings": "ワークフロー生成時の設定",
    "workflow": {
      "filenamePrefix": "KidsPG_Player_Photo",
      "replacements": [
        {
          "nodePath": "9.inputs.filename_prefix",
          "template": "${kidspg_prefix}",
          "value": "KidsPG_Player_Photo_${datetime}"
        },
        {
          "nodePath": "10.inputs.image",
          "template": "${input_image}",
          "value": "${uploaded_filename}"
        }
      ]
    },
    "_comment_polling": "ポーリング設定",
    "polling": {
      "pollInterval": 2000,
      "maxRetries": 60
    }
  }
}
```

### 7.2. ワークフローテンプレート処理

#### 7.2.1. テンプレート置換設定

ComfyUI_KidsPG_01.jsonから以下の項目を動的に置換：

1. **SaveImageノード（node 9）**
   - `"filename_prefix": "ComfyUI"` → `"filename_prefix": "KidsPG_Player_Photo_20250815_143022"`

2. **LoadImageノード（node 10）**  
   - `"image": "shibatasan.png"` → `"image": "{uploaded_filename}"` (APIアップロード時の返却名)

#### 7.2.2. API中心の処理フロー

```
assets/ComfyUI_KidsPG_01.json (テンプレート)
           ↓ (動的置換)
results/{datetime}/img_generate.json (実行用ワークフロー)
           ↓ (/upload/image)
ComfyUI内部ストレージ (uploaded_filename)
           ↓ (/prompt)
ComfyUI処理キュー (prompt_id)
           ↓ (/view)
API経由で画像取得 → results/{datetime}/photo_anime.png
```

### 7.3. 無効化時の動作

- `comfyui.enabled: false` 時は変換処理をスキップ
- 開発・テスト時の便利機能として活用

## 8. 非同期処理とワーカー分離

### 8.1. 設計方針

**重要**: ComfyUI処理中もゲーム本体は完全に操作可能にする必要がある。そのためにComfyUI制御を専用ワーカーに分離する。

### 8.2. ワーカー分離アーキテクチャ

```
メインプロセス (Electron Main)
├── UI Thread (応答性維持)
└── ComfyUI Worker (Node.js Worker Thread)
    ├── ワークフロー生成
    ├── ComfyUI API通信
    ├── WebSocket監視
    └── ファイル完了検知・コピー
```

### 8.3. 実装設計

#### 8.3.1. ComfyUIワーカー (src/main/workers/comfyui_worker.ts)

```typescript
import { WebSocket } from 'ws';
import FormData from 'form-data';

// Worker Thread で実行される処理
export interface ComfyUIWorkerMessage {
  type: 'transform' | 'cancel' | 'status' | 'health_check';
  data: {
    imageData?: string;
    datetime?: string;
    resultDir?: string;
    config?: ComfyUIConfig;
  };
}

export interface ComfyUIWorkerResponse {
  type: 'progress' | 'completed' | 'error' | 'health_status';
  data: {
    progress?: number;
    imageBuffer?: ArrayBuffer;  
    error?: string;
    status?: string;
    queuePosition?: number;
    estimatedTime?: number;
    nodeProgress?: { current: number; total: number };
  };
}

export class ComfyUIWorker {
  private config: ComfyUIConfig;
  private baseUrl: string;
  private activeJobs = new Map<string, {
    promptId: string;
    datetime: string;
    resultDir: string;
    startTime: number;
    status: 'uploading' | 'processing' | 'completed' | 'error';
  }>();
  private jobQueue: Array<{
    id: string;
    imageData: string;
    datetime: string;
    resultDir: string;
  }> = [];
  private isProcessing = false;
  
  constructor(config: ComfyUIConfig) {
    this.config = config;
    this.baseUrl = config.api.baseUrl;
  }
  
  // === メイン処理フロー（キューイング対応） ===
  async transformImage(imageData: string, datetime: string, resultDir: string): Promise<void> {
    // ジョブをキューに追加
    const jobId = `job_${datetime}_${Date.now()}`;
    this.jobQueue.push({
      id: jobId,
      imageData,
      datetime,
      resultDir
    });
    
    this.sendProgress('progress', { 
      status: 'queued', 
      progress: 0,
      message: `キューに追加されました (位置: ${this.jobQueue.length})` 
    });
    
    // プロセッサーを開始（まだ動いていない場合）
    if (!this.isProcessing) {
      this.processJobQueue();
    }
  }
  
  private async processJobQueue(): Promise<void> {
    if (this.isProcessing || this.jobQueue.length === 0) {
      return;
    }
    
    this.isProcessing = true;
    
    while (this.jobQueue.length > 0) {
      const job = this.jobQueue.shift()!;
      
      try {
        await this.processJob(job);
      } catch (error) {
        this.sendJobProgress(job.datetime, 'error', { error: String(error) });
      }
    }
    
    this.isProcessing = false;
  }
  
  private async processJob(job: { id: string; imageData: string; datetime: string; resultDir: string }): Promise<void> {
    try {
      // ジョブ開始
      this.sendJobProgress(job.datetime, 'progress', { status: 'processing_start', progress: 5 });
      
      // 1. サーバー状態確認
      await this.checkServerHealth();
      
      // 2. 画像アップロード
      const uploadedFilename = await this.uploadImage(job.imageData, job.datetime);
      
      // 3. ワークフロー生成・実行
      const promptId = await this.executeWorkflow(uploadedFilename, job.datetime, job.resultDir);
      
      // アクティブジョブとして登録
      this.activeJobs.set(job.datetime, {
        promptId,
        datetime: job.datetime,
        resultDir: job.resultDir,
        startTime: Date.now(),
        status: 'processing'
      });
      
      // 4. ポーリングで完了待機・ダウンロード
      await this.waitForCompletionByPolling(promptId, job.datetime, job.resultDir);
      
      // 完了後、アクティブジョブから削除
      this.activeJobs.delete(job.datetime);
      
    } catch (error) {
      // エラー時もアクティブジョブから削除
      this.activeJobs.delete(job.datetime);
      throw error;
    }
  }
  
  // === API通信メソッド ===
  
  // /system_stats - サーバー稼働状況確認
  private async checkServerHealth(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/system_stats`);
    if (!response.ok) {
      throw new Error(`ComfyUIサーバーに接続できません: ${response.status}`);
    }
    
    const stats = await response.json();
    this.sendProgress('health_status', { 
      status: 'connected',
      systemStats: stats 
    });
  }
  
  // /upload/image - 画像ファイルアップロード（API中心）
  private async uploadImage(imageData: string, datetime: string): Promise<string> {
    this.sendProgress('progress', { status: 'uploading', progress: 10 });
    
    // Base64データをBufferに変換
    const base64Data = imageData.replace(/^data:image\/png;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');
    
    // FormDataでファイルアップロード
    const formData = new FormData();
    formData.append('image', imageBuffer, {
      filename: `photo_${datetime}.png`,
      contentType: 'image/png'
    });
    
    const response = await fetch(`${this.baseUrl}/upload/image`, {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      throw new Error(`画像アップロード失敗: ${response.status}`);
    }
    
    const result = await response.json();
    this.sendProgress('progress', { status: 'uploaded', progress: 20 });
    
    // ComfyUI内部でのファイル名を返却（例: "tmpA1B2C3.png"）
    return result.name;
  }
  
  // /prompt - ワークフロー実行リクエスト（アップロードファイル名で更新）
  private async executeWorkflow(uploadedFilename: string, datetime: string, resultDir: string): Promise<string> {
    this.sendProgress('progress', { status: 'preparing_workflow', progress: 25 });
    
    // ワークフローテンプレート生成
    const workflow = await this.generateWorkflow(datetime, resultDir);
    
    // LoadImageノードのファイル名を実際のアップロード名で更新
    workflow["10"].inputs.image = uploadedFilename;
    
    // プロンプト送信
    const response = await fetch(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow })
    });
    
    if (!response.ok) {
      throw new Error(`ワークフロー実行失敗: ${response.status}`);
    }
    
    const result = await response.json();
    const promptId = result.prompt_id;
    
    this.sendJobProgress(datetime, 'progress', { 
      status: 'queued', 
      progress: 30,
      promptId: promptId 
    });
    
    return promptId;
  }
  
  // /queue - キュー状況確認
  private async getQueueStatus(): Promise<any> {
    const response = await fetch(`${this.baseUrl}/queue`);
    if (!response.ok) {
      throw new Error(`キュー状況取得失敗: ${response.status}`);
    }
    
    return await response.json();
  }
  
  // /history/{prompt_id} - 実行履歴確認
  private async getExecutionHistory(promptId: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/history/${promptId}`);
    if (!response.ok) {
      throw new Error(`実行履歴取得失敗: ${response.status}`);
    }
    
    return await response.json();
  }
  
  // === ポーリング完了待機 ===
  
  private async waitForCompletionByPolling(promptId: string, datetime: string, resultDir: string): Promise<void> {
    const maxRetries = this.config.polling.maxRetries;
    const pollInterval = this.config.polling.pollInterval;
    let progressValue = 30; // 実行開始時点
    
    this.sendJobProgress(datetime, 'progress', { 
      status: 'polling_started', 
      progress: progressValue,
      promptId: promptId 
    });
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        // 1. キュー状況確認（まだキューに残っているか）
        const queue = await this.getQueueStatus();
        const queuePosition = this.findQueuePosition(queue, promptId);
        
        if (queuePosition !== null) {
          // まだキューにある = 実行待ちまたは実行中
          this.sendJobProgress(datetime, 'progress', { 
            status: 'in_queue',
            progress: Math.min(progressValue + (i * 2), 70), // 徐々に進捗を上げる
            queuePosition: queuePosition 
          });
        } else {
          // キューにない = 完了または失敗の可能性
          
          // 2. 履歴確認で最終状態を確認
          const history = await this.getExecutionHistory(promptId);
          
          if (history[promptId]?.status?.completed === true) {
            // 正常完了
            this.sendJobProgress(datetime, 'progress', { status: 'execution_completed', progress: 85 });
            await this.downloadGeneratedImage(promptId, resultDir, datetime);
            return;
          } else if (history[promptId]?.status?.status_str === 'error') {
            // エラー完了
            throw new Error(`ComfyUI実行エラー: ${history[promptId]?.status?.messages || 'Unknown error'}`);
          } else {
            // 履歴にまだ反映されていない可能性 - 継続して待機
            this.sendJobProgress(datetime, 'progress', { 
              status: 'checking_completion',
              progress: Math.min(progressValue + (i * 2), 75)
            });
          }
        }
        
        // 進捗値を徐々に上げる（最大80%まで）
        progressValue = Math.min(30 + (i * 50 / maxRetries), 80);
        
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        
      } catch (error) {
        console.error(`ポーリング中エラー (試行 ${i + 1}/${maxRetries}):`, error);
        
        // 最後の試行でエラーの場合のみthrow
        if (i === maxRetries - 1) {
          throw error;
        }
        
        // エラーでも継続（一時的なネットワークエラーの可能性）
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }
    
    throw new Error(`処理がタイムアウトしました (${maxRetries * pollInterval / 1000}秒)`);
  }
  
  // /view API で生成画像を取得（API中心）
  private async downloadGeneratedImage(promptId: string, resultDir: string, datetime: string): Promise<void> {
    this.sendJobProgress(datetime, 'progress', { status: 'downloading', progress: 95 });
    
    // /history から出力ファイル情報を取得
    const history = await this.getExecutionHistory(promptId);
    const outputs = history[promptId]?.outputs;
    
    if (!outputs) {
      throw new Error('実行履歴に出力情報が見つかりません');
    }
    
    // SaveImageノードの出力ファイルを特定
    const saveImageNodeId = "9"; // SaveImageノードのID
    const outputFiles = outputs[saveImageNodeId]?.images || [];
    
    if (outputFiles.length === 0) {
      throw new Error('生成画像が見つかりません');
    }
    
    const imageInfo = outputFiles[0]; // 最初の画像を使用
    
    // /view APIで画像を直接取得
    const viewUrl = `${this.baseUrl}/view?filename=${imageInfo.filename}&subfolder=${imageInfo.subfolder || ''}&type=${imageInfo.type || 'output'}`;
    const imageResponse = await fetch(viewUrl);
    
    if (!imageResponse.ok) {
      throw new Error(`画像取得失敗: ${imageResponse.status}`);
    }
    
    const imageBuffer = await imageResponse.arrayBuffer();
    
    // ローカルファイルとして保存
    const targetPath = path.join(resultDir, 'photo_anime.png');
    await fs.writeFile(targetPath, Buffer.from(imageBuffer));
    
    this.sendJobProgress(datetime, 'completed', { 
      status: 'completed', 
      progress: 100,
      imageBuffer: imageBuffer
    });
  }
  
  // === ユーティリティメソッド ===
  
  private findQueuePosition(queue: any, promptId: string): number | null {
    const pending = queue.queue_pending || [];
    const running = queue.queue_running || [];
    
    // 実行中キューをチェック（position 0）
    for (let i = 0; i < running.length; i++) {
      if (running[i][1] === promptId) {
        return 0; // 実行中（最優先）
      }
    }
    
    // 待機中キューをチェック（position 1以降）
    for (let i = 0; i < pending.length; i++) {
      if (pending[i][1] === promptId) {
        return i + 1; // 待機位置（1から開始）
      }
    }
    
    return null; // キューに見つからない（完了または失敗）
  }
  
  private sendProgress(type: string, data: any): void {
    // メインプロセスに進捗送信
    process.parentPort?.postMessage({ type, data });
  }
  
  private sendJobProgress(datetime: string, type: string, data: any): void {
    // 特定ジョブの進捗送信（ジョブ識別用にdatetimeを追加）
    process.parentPort?.postMessage({ 
      type, 
      data: { 
        ...data, 
        jobId: datetime,
        timestamp: new Date().toISOString()
      } 
    });
  }
}
```

#### 8.3.2. メインプロセス統合

```typescript
// main.ts
import { Worker } from 'worker_threads';
import { ComfyUIWorkerResponse } from './workers/comfyui_worker';

class ElectronApp {
  private comfyUIWorker: Worker | null = null;
  private activeJobs = new Map<string, { datetime: string; startTime: number }>();
  
  private setupComfyUIWorker(): void {
    this.comfyUIWorker = new Worker(path.join(__dirname, 'workers/comfyui_worker.js'));
    
    this.comfyUIWorker.on('message', (response: ComfyUIWorkerResponse) => {
      this.handleWorkerResponse(response);
    });
    
    this.comfyUIWorker.on('error', (error) => {
      console.error('ComfyUIワーカーエラー:', error);
      this.broadcastToRenderers('comfyui-error', { error: error.message });
    });
  }
  
  private handleWorkerResponse(response: ComfyUIWorkerResponse): void {
    // すべてのレンダラープロセスに進捗を通知
    this.broadcastToRenderers('comfyui-progress', response);
    
    // ジョブ管理（複数ジョブ対応）
    const jobId = response.data.jobId; // ワーカーから送信されるjobId（datetime）
    
    if (response.type === 'completed' && jobId) {
      // 完了時の処理
      const job = this.activeJobs.get(jobId);
      if (job) {
        const duration = Date.now() - job.startTime;
        console.log(`ComfyUI変換完了: ${job.datetime} (${duration}ms)`);
        this.activeJobs.delete(jobId);
      }
    } else if (response.type === 'error' && jobId) {
      // エラー時の処理
      console.error(`ComfyUI変換エラー (${jobId}):`, response.data.error);
      this.activeJobs.delete(jobId);
    }
  }
  
  private broadcastToRenderers(channel: string, data: any): void {
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send(channel, data);
    });
  }
  
  // 非ブロッキングIPC handler
  private setupIPC(): void {
    // ComfyUI変換開始
    ipcMain.handle('transform-image-to-anime', async (event, imageData: string, dirPath: string) => {
      if (!this.config?.comfyui?.enabled) {
        return { success: false, error: 'ComfyUI機能が無効です' };
      }
      
      const dateTime = path.basename(dirPath);
      
      // 同一ジョブIDの重複チェック（複数ジョブ対応）
      if (this.activeJobs.has(dateTime)) {
        return { success: false, error: `同じID（${dateTime}）の変換処理が既に実行中です` };
      }
      
      // ジョブ登録
      this.activeJobs.set(dateTime, { datetime: dateTime, startTime: Date.now() });
      
      // ワーカーに処理を委譲（非ブロッキング）
      this.comfyUIWorker?.postMessage({
        type: 'transform',
        data: { imageData, datetime: dateTime, resultDir: dirPath, config: this.config.comfyui }
      });
      
      // 即座に処理開始応答を返す
      return { 
        success: true, 
        processing: true, 
        message: `変換処理を開始しました（ID: ${dateTime}）`,
        jobId: dateTime,
        activeJobs: this.activeJobs.size
      };
    });
    
    // ComfyUI変換キャンセル（特定ジョブまたは全ジョブ）
    ipcMain.handle('cancel-transform', async (event, jobId?: string) => {
      if (jobId) {
        // 特定ジョブのキャンセル
        if (this.activeJobs.has(jobId)) {
          this.comfyUIWorker?.postMessage({ type: 'cancel', data: { jobId } });
          this.activeJobs.delete(jobId);
          return { success: true, message: `変換処理をキャンセルしました（ID: ${jobId}）` };
        } else {
          return { success: false, error: `指定されたジョブ（${jobId}）が見つかりません` };
        }
      } else {
        // 全ジョブのキャンセル
        this.comfyUIWorker?.postMessage({ type: 'cancel_all', data: {} });
        const canceledCount = this.activeJobs.size;
        this.activeJobs.clear();
        return { success: true, message: `全ての変換処理をキャンセルしました（${canceledCount}件）` };
      }
    });
    
    // ComfyUI接続テスト
    ipcMain.handle('test-comfyui-connection', async () => {
      if (!this.config?.comfyui?.enabled) {
        return { success: false, error: 'ComfyUI機能が無効です' };
      }
      
      this.comfyUIWorker?.postMessage({ 
        type: 'health_check', 
        data: { config: this.config.comfyui } 
      });
      
      return { success: true, message: '接続テストを開始しました' };
    });
    
    // アクティブジョブ状況取得
    ipcMain.handle('get-active-jobs', async () => {
      return Array.from(this.activeJobs.entries()).map(([id, job]) => ({
        id,
        datetime: job.datetime,
        elapsedTime: Date.now() - job.startTime
      }));
    });
  }
}
```

#### 8.3.3. 非ブロッキング処理フロー

```mermaid
sequenceDiagram
    participant UI as CameraPage
    participant Main as メインプロセス(軽量IPC)
    participant Worker as ComfyUIワーカー
    participant API as ComfyUI Server
    
    UI->>Main: transform-image-to-anime(imageData, dirPath)
    Main->>Main: ジョブ管理・重複チェック
    Main->>Worker: postMessage({type: 'transform', data: {...}})
    Main->>UI: {success: true, processing: true} (即座に応答)
    
    Note over UI: ゲーム操作可能状態継続・CountdownPageに遷移
    
    Worker->>API: GET /system_stats
    API->>Worker: サーバー状態確認
    Worker->>Main: postMessage({type: 'progress', data: {...}})
    Main->>UI: comfyui-progress(health_status)
    
    Worker->>API: POST /upload/image(formData)
    API->>Worker: {name: "tmpA1B2C3.png"}
    Worker->>Worker: workflow["10"].inputs.image = uploadedName
    Worker->>Main: postMessage({type: 'progress', data: {progress: 20}})
    
    Worker->>API: POST /prompt(updatedWorkflow)
    API->>Worker: {prompt_id: "xyz123"}
    Worker->>Main: postMessage({type: 'progress', data: {progress: 30}})
    
    loop ポーリング監視（2秒間隔・Worker内）
        Worker->>API: GET /queue
        API->>Worker: キュー状況
        
        alt まだキューにある
            Worker->>Main: postMessage({type: 'progress', data: {status: 'in_queue'}})
        else キューにない
            Worker->>API: GET /history/xyz123
            API->>Worker: 実行履歴
            
            alt 完了
                Worker->>API: GET /view?filename=...&type=output
                API->>Worker: 画像バイナリ
                Worker->>Worker: fs.writeFile(targetPath, imageBuffer)
                Worker->>Main: postMessage({type: 'completed', data: {imageBuffer}})
                Main->>UI: comfyui-progress(completed)
                break
            else エラー
                Worker->>Main: postMessage({type: 'error', data: {...}})
                break
            end
        end
        
        Worker->>Worker: await sleep(2秒)
    end
    
    Note over UI: 変換完了時・ゲーム中でもイベント受信
```

### 8.4. シンプルなポーリング完了検知

#### 8.4.1. /queue での存在確認

```typescript
// キューにまだ存在するかチェック
async checkIfInQueue(promptId: string): Promise<number | null> {
  const response = await fetch(`${this.config.baseUrl}/queue`);
  const queue = await response.json();
  
  // findQueuePositionメソッドを再利用
  return this.findQueuePosition(queue, promptId);
}
```

#### 8.4.2. /history での完了確認

```typescript
async checkJobCompletion(promptId: string): Promise<'completed' | 'error' | 'processing'> {
  const response = await fetch(`${this.config.baseUrl}/history/${promptId}`);
  const history = await response.json();
  
  const jobHistory = history[promptId];
  if (!jobHistory) {
    return 'processing'; // まだ履歴にない
  }
  
  if (jobHistory.status?.completed === true) {
    return 'completed'; // 正常完了
  } else if (jobHistory.status?.status_str === 'error') {
    return 'error'; // エラー完了
  } else {
    return 'processing'; // まだ処理中
  }
}
```

#### 8.4.3. 統合ポーリングロジック

```typescript
async pollForCompletion(promptId: string): Promise<'completed' | 'error'> {
  for (let i = 0; i < maxRetries; i++) {
    // 1. キューチェック
    const queuePosition = await this.checkIfInQueue(promptId);
    
    if (queuePosition !== null) {
      // まだキューにある
      this.sendProgress('progress', { 
        status: queuePosition === 0 ? 'running' : 'waiting',
        queuePosition: queuePosition 
      });
    } else {
      // キューにない → 履歴確認
      const completionStatus = await this.checkJobCompletion(promptId);
      
      if (completionStatus === 'completed') {
        return 'completed';
      } else if (completionStatus === 'error') {
        return 'error';
      }
      // 'processing' の場合は継続
    }
    
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  
  throw new Error('タイムアウト');
}
```

### 8.5. ファイル破損防止

#### 8.5.1. 安定性チェック

```typescript
private async waitForFileStability(filePath: string, maxWaitMs: number = 10000): Promise<boolean> {
  let lastSize = 0;
  let stableCount = 0;
  const requiredStableChecks = 3; // 3回連続でサイズが同じなら安定とみなす
  
  for (let i = 0; i < maxWaitMs / 1000; i++) {
    try {
      const stats = await fs.stat(filePath);
      
      if (stats.size === lastSize && stats.size > 0) {
        stableCount++;
        if (stableCount >= requiredStableChecks) {
          return true; // ファイル安定
        }
      } else {
        stableCount = 0;
        lastSize = stats.size;
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      // ファイルがまだ存在しない
      continue;
    }
  }
  
  return false; // タイムアウト
}
```

#### 8.5.2. 排他制御付きコピー

```typescript
private async safeFileCopy(sourcePath: string, targetPath: string): Promise<boolean> {
  try {
    // 1. ファイル安定性確認
    const isStable = await this.waitForFileStability(sourcePath);
    if (!isStable) {
      throw new Error('ファイルが安定しません');
    }
    
    // 2. 一時ファイルにコピー
    const tempPath = `${targetPath}.tmp`;
    await fs.copyFile(sourcePath, tempPath);
    
    // 3. 一時ファイルの整合性確認
    const sourceStats = await fs.stat(sourcePath);
    const tempStats = await fs.stat(tempPath);
    
    if (sourceStats.size !== tempStats.size) {
      throw new Error('ファイルサイズが一致しません');
    }
    
    // 4. 原子的リネーム
    await fs.rename(tempPath, targetPath);
    
    return true;
  } catch (error) {
    console.error('ファイルコピーエラー:', error);
    return false;
  }
}
```

### 8.6. ユーザー体験

#### 8.6.1. プログレス表示

```typescript
// GameSessionContext拡張
interface GameSessionState {
  // 既存フィールド
  isTransforming: boolean;
  transformProgress: number;    // 0-100
  transformStatus: string;      // "preparing" | "uploading" | "processing" | "downloading" | "completed"
  transformError: string;
}
```

#### 8.6.2. ゲーム中の通知

- ゲーム画面の端に小さなプログレスバー表示
- 変換完了時に控えめな通知
- エラー時は非侵入的なメッセージ

## 9. パフォーマンス考慮事項

### 9.1. メモリ管理
- Worker Thread内でのメモリ適切な解放
- 大きなBuffer使用時のリーク防止

### 9.2. タイムアウト設定
- WebSocket接続タイムアウト: 30秒
- ジョブ実行タイムアウト: 120秒  
- ファイル安定性チェック: 10秒

## 9. 今後の拡張可能性

### 9.1. 複数スタイル対応
- アニメ以外のスタイル変換
- ユーザーによるスタイル選択機能

### 9.2. ComfyUI自動起動
- Electronアプリ起動時のComfyUI自動起動
- プロセス管理機能

### 9.3. 変換履歴管理
- 過去の変換結果保存・閲覧
- 変換設定の保存・復元

## 10. TestPage機能概要

### 10.1. 通信確認機能

#### `/system_stats` 接続テスト
```typescript
// 機能詳細
- ComfyUIサーバーへの接続確認
- 応答時間測定
- システム情報取得（メモリ・GPU・VRAM使用状況）
- エラーメッセージ表示（接続失敗時）
- 最終確認時刻の記録
```

#### リアルタイム状況監視
```typescript
// 自動リフレッシュ機能
- 3秒間隔での自動更新
- /queue + /history + アプリ内ジョブの同期取得
- ワンクリックでの手動更新
- 開始/停止の切り替え可能
```

### 10.2. 処理状況一覧機能

#### `/queue` キュー監視
```typescript
// 表示内容
実行中ジョブ (queue_running):
- ジョブID
- ワークフローのノード数
- 実行状態

待機中ジョブ (queue_pending):
- キュー位置 (#1, #2, ...)
- ジョブID  
- ワークフローのノード数
```

#### `/history` 実行履歴
```typescript
// 表示内容（最新10件）
- ジョブID
- 完了状態（✅完了 / ❌エラー）
- ワークフローのノード数
- 出力ファイル数
- エラーメッセージ（失敗時）
```

### 10.3. 運用・テスト支援

#### ダミー画像テスト
- Canvas APIで生成したテスト画像
- グラデーション背景 + タイムスタンプ
- 実際の変換フローをテスト

#### 変換制御
- アクティブジョブの表示
- 変換処理のキャンセル
- 変換結果の確認

## 11. 実装優先順位

### Phase 1: 基盤整備
1. **config.json拡張** - ComfyUI設定の追加
2. **ワークフローテンプレート配置** - `assets/ComfyUI_KidsPG_01.json`
3. **型定義拡張** - `src/shared/types/index.ts`にComfyUI関連型追加

### Phase 2: コア機能実装  
4. **WorkflowGenerator実装** - テンプレート置換処理
5. **ComfyUIClient実装** - シンプルポーリング方式のAPI通信
6. **メインプロセス拡張** - Worker Thread + IPC handler追加

### Phase 3: フロントエンド統合
7. **GameSessionContext拡張** - アニメ画像状態管理
8. **CameraPage拡張** - 変換処理呼び出し・UI更新
9. **ResultPage拡張** - result.json保存フィールド追加

### Phase 4: テスト・運用機能
10. **TestPage拡張** - ComfyUI完全監視・制御機能
11. **エラーハンドリング強化** - タイムアウト・フォールバック処理
12. **設定管理・最適化** - パフォーマンス調整・設定UI

### 実装の注意点
- **段階的テスト**: 各Phaseごとに動作確認
- **WebSocket不使用**: シンプルポーリングでコスト削減
- **フォールバック確保**: ComfyUI無効時も既存機能が動作
- **ファイル管理**: 一時ファイルの適切な削除・管理

## 12. 短時間ゲームプレイでのキュー管理設計

### 12.1. 問題設定

短時間のゲームプレイ（1-3分程度）で複数のプレイヤーが連続してプレイする環境では、以下のシナリオが発生します：

```
時刻    プレイヤー     アクション                ComfyUIキュー状況
10:00   Player A      写真撮影→変換開始          [A処理中]
10:01   Player B      写真撮影→変換開始          [A処理中, B待機]
10:02   Player C      写真撮影→変換開始          [A処理中, B待機, C待機]
10:03   Player A      ゲーム終了・変換完了        [B処理中, C待機]
10:04   Player D      写真撮影→変換開始          [B処理中, C待機, D待機]
```

### 12.2. キュー管理戦略

#### 12.2.1. 複数ジョブ並行管理

```typescript
interface JobQueueManager {
  private maxConcurrentJobs: number = 3; // 同時実行数制限
  private jobQueue: TransformJob[] = [];
  private activeJobs: Map<string, ActiveJob> = new Map();
  
  // ジョブ受付時のキュー状況判定
  async acceptJob(imageData: string, datetime: string, resultDir: string): Promise<QueueResponse> {
    const totalJobs = this.activeJobs.size + this.jobQueue.length;
    
    if (totalJobs >= 10) { // キュー上限
      return {
        success: false,
        error: 'キューが満杯です。しばらく時間をおいてから再試行してください。',
        retryAfterSeconds: 60
      };
    }
    
    const queuePosition = this.jobQueue.length + 1;
    const estimatedWaitTime = this.calculateEstimatedWaitTime(queuePosition);
    
    return {
      success: true,
      message: `変換処理をキューに追加しました`,
      queuePosition: queuePosition,
      estimatedWaitTime: estimatedWaitTime,
      activeJobs: this.activeJobs.size
    };
  }
  
  // 待機時間予測
  private calculateEstimatedWaitTime(queuePosition: number): number {
    const avgProcessingTime = 90; // 秒（実測データベース）
    const currentActiveJobs = this.activeJobs.size;
    
    // 保守的な見積もり: 現在実行中の最長時間 + 待機ジョブ × 平均時間
    return (queuePosition * avgProcessingTime) + 30; // バッファ30秒
  }
}
```

#### 12.2.2. ゲームフロー連携

```typescript
// CameraPage.tsx での対応
const handlePhotoConfirm = async () => {
  try {
    // 写真保存（既存）
    const result = await savePhoto(capturedImage);
    
    // ComfyUI変換開始（非ブロッキング・キュー対応）
    const transformResult = await window.api.transformImageToAnime(capturedImage, result.dirPath);
    
    if (transformResult.success) {
      // キュー登録成功
      setTransformStatus('queued');
      setQueuePosition(transformResult.queuePosition);
      setEstimatedWaitTime(transformResult.estimatedWaitTime);
      
      // すぐにゲーム開始（変換完了を待たない）
      setCurrentScreen('COUNTDOWN');
      
      // キュー状況をユーザーに通知
      if (transformResult.queuePosition > 1) {
        toast(`画像変換がキューに追加されました (待機位置: ${transformResult.queuePosition})`);
      }
    } else {
      // キュー満杯・エラー時の処理
      setTransformError(transformResult.error);
      setTransformStatus('error');
      
      // 元画像でゲーム続行
      setCurrentScreen('COUNTDOWN');
      
      if (transformResult.retryAfterSeconds) {
        toast(`変換サーバーが混雑しています。${transformResult.retryAfterSeconds}秒後に再試行してください。`);
      }
    }
  } catch (error) {
    // エラー時も元画像でゲーム続行
    handleTransformError(error);
  }
};
```

#### 12.2.3. プログレス通知最適化

```typescript
// 短時間ゲーム向けの非侵入的な進捗表示
interface GameProgressUI {
  showQueueStatus: boolean;    // キュー状況表示の有無
  showDetailedProgress: boolean; // 詳細進捗の有無
  position: 'corner' | 'hidden'; // 表示位置
}

// ゲーム中の控えめな通知
const GameProgressIndicator: React.FC = () => {
  const { transformStatus, queuePosition, estimatedWaitTime } = useGameSession();
  
  if (transformStatus === 'idle' || transformStatus === 'completed') {
    return null; // 非表示
  }
  
  return (
    <div className="fixed top-2 right-2 bg-black/70 text-white text-xs p-2 rounded z-50">
      {transformStatus === 'queued' && (
        <div>
          🎨 画像変換待機中 (位置: {queuePosition})
          <div className="text-xs opacity-70">
            予想: {Math.ceil(estimatedWaitTime / 60)}分
          </div>
        </div>
      )}
      {transformStatus === 'processing' && (
        <div>🔄 画像変換中...</div>
      )}
    </div>
  );
};
```

### 12.3. パフォーマンス最適化

#### 12.3.1. ComfyUIサーバー負荷分散

```typescript
// 複数ComfyUIインスタンス対応（将来拡張）
interface ComfyUICluster {
  instances: ComfyUIInstance[];
  loadBalancer: LoadBalancer;
  
  // 負荷が最も少ないインスタンスを選択
  async selectOptimalInstance(): Promise<ComfyUIInstance> {
    return this.loadBalancer.getOptimalInstance(this.instances);
  }
}

// 現在の設計では単一インスタンス前提だが、設定で切り替え可能
interface ComfyUIConfig {
  // ... 既存設定
  clustering?: {
    enabled: boolean;
    instances: Array<{
      baseUrl: string;
      weight: number;
    }>;
  };
}
```

#### 12.3.2. 優先度管理

```typescript
// 将来拡張: プレイヤー種別による優先度
interface TransformJob {
  id: string;
  imageData: string;
  datetime: string;
  resultDir: string;
  priority: 'low' | 'normal' | 'high'; // VIPプレイヤー等
  createdAt: number;
}

// 優先度つきキュー処理
class PriorityJobQueue {
  private highPriorityQueue: TransformJob[] = [];
  private normalPriorityQueue: TransformJob[] = [];
  private lowPriorityQueue: TransformJob[] = [];
  
  addJob(job: TransformJob): void {
    switch (job.priority) {
      case 'high':
        this.highPriorityQueue.push(job);
        break;
      case 'normal':
        this.normalPriorityQueue.push(job);
        break;
      case 'low':
        this.lowPriorityQueue.push(job);
        break;
    }
  }
  
  getNextJob(): TransformJob | null {
    return this.highPriorityQueue.shift() || 
           this.normalPriorityQueue.shift() || 
           this.lowPriorityQueue.shift() || 
           null;
  }
}
```

### 12.4. 運用監視機能

#### 12.4.1. TestPage拡張

```typescript
// 短時間プレイシナリオでの運用監視
export const ShortGameScenarioMonitor: React.FC = () => {
  const [queueMetrics, setQueueMetrics] = useState({
    totalProcessed: 0,
    averageWaitTime: 0,
    peakQueueLength: 0,
    successRate: 0,
    lastHourActivity: []
  });
  
  const [stressTestRunning, setStressTestRunning] = useState(false);
  
  // 短時間シナリオのストレステスト
  const runShortGameStressTest = async () => {
    setStressTestRunning(true);
    
    // 1分間隔で5つのダミー変換ジョブを送信
    for (let i = 0; i < 5; i++) {
      const dummyImage = generateDummyImage(`Player${i + 1}`);
      const dateTime = new Date(Date.now() + i * 1000).toISOString().replace(/[:.]/g, '-').slice(0, 19);
      
      setTimeout(async () => {
        try {
          const result = await window.api.transformImageToAnime(dummyImage, `stress_test_${dateTime}`);
          console.log(`ストレステスト ${i + 1}/5:`, result);
        } catch (error) {
          console.error(`ストレステスト ${i + 1} エラー:`, error);
        }
      }, i * 12000); // 12秒間隔
    }
    
    setTimeout(() => setStressTestRunning(false), 65000); // 65秒後に終了
  };
  
  return (
    <div className="short-game-monitor">
      <h3>短時間ゲームシナリオ監視</h3>
      
      {/* キューメトリクス */}
      <div className="queue-metrics">
        <div>処理済み総数: {queueMetrics.totalProcessed}</div>
        <div>平均待機時間: {queueMetrics.averageWaitTime}秒</div>
        <div>最大キュー長: {queueMetrics.peakQueueLength}</div>
        <div>成功率: {queueMetrics.successRate}%</div>
      </div>
      
      {/* ストレステスト */}
      <div className="stress-test">
        <button 
          onClick={runShortGameStressTest}
          disabled={stressTestRunning}
          className="bg-orange-600 text-white px-4 py-2 rounded"
        >
          {stressTestRunning ? '🔄 ストレステスト実行中...' : '⚡ 短時間プレイ ストレステスト'}
        </button>
        <p className="text-sm text-gray-600">
          12秒間隔で5つの変換ジョブを送信し、キュー管理をテストします
        </p>
      </div>
      
      {/* アクティビティ履歴 */}
      <div className="activity-history">
        <h4>直近1時間のアクティビティ</h4>
        <div className="activity-timeline">
          {queueMetrics.lastHourActivity.map((activity, index) => (
            <div key={index} className="activity-item">
              <span>{activity.time}</span>
              <span>{activity.action}</span>
              <span>{activity.duration}秒</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
```

#### 12.4.2. アラート機能

```typescript
// 運用アラート設定
interface QueueAlerts {
  maxQueueLength: number;      // キュー長上限
  maxWaitTime: number;         // 待機時間上限
  lowSuccessRate: number;      // 成功率下限
  
  onQueueLengthExceeded: (length: number) => void;
  onWaitTimeExceeded: (waitTime: number) => void;
  onSuccessRateDropped: (rate: number) => void;
}

// アラート監視
class QueueMonitor {
  private alerts: QueueAlerts;
  
  checkAlerts(currentMetrics: QueueMetrics): void {
    if (currentMetrics.queueLength > this.alerts.maxQueueLength) {
      this.alerts.onQueueLengthExceeded(currentMetrics.queueLength);
    }
    
    if (currentMetrics.averageWaitTime > this.alerts.maxWaitTime) {
      this.alerts.onWaitTimeExceeded(currentMetrics.averageWaitTime);
    }
    
    if (currentMetrics.successRate < this.alerts.lowSuccessRate) {
      this.alerts.onSuccessRateDropped(currentMetrics.successRate);
    }
  }
}
```

### 12.5. 設定調整指針

#### 12.5.1. config.json拡張

```json
{
  "comfyui": {
    "queue": {
      "maxConcurrentJobs": 1,
      "maxQueueLength": 10,
      "jobTimeoutSeconds": 180,
      "estimatedProcessingTimeSeconds": 90,
      "priorityEnabled": false
    },
    "shortGameOptimization": {
      "enabled": true,
      "showQueuePosition": true,
      "showEstimatedTime": true,
      "nonIntrusiveNotifications": true,
      "autoRetryOnQueueFull": false
    }
  }
}
```

#### 12.5.2. 調整パラメータ

- **maxConcurrentJobs**: ComfyUIサーバーの性能に応じて調整（通常1、高性能サーバーでは2-3）
- **maxQueueLength**: 想定同時プレイヤー数の2-3倍
- **jobTimeoutSeconds**: ワークフローの複雑さに応じて調整
- **estimatedProcessingTimeSeconds**: 実測データに基づいて定期更新

### 12.6. まとめ

短時間ゲームプレイでの複数キューイング対応により、以下が実現されます：

1. **ゲーム体験の維持**: 変換処理によるゲーム中断なし
2. **適切な期待値設定**: キュー位置・待機時間の明示
3. **サーバー負荷分散**: キュー上限による過負荷防止
4. **運用監視**: メトリクス収集とアラート機能
5. **フォールバック対応**: 変換失敗時も元画像でゲーム続行

この設計により、複数プレイヤーの短時間連続プレイシナリオでも安定したゲーム運用が可能になります。