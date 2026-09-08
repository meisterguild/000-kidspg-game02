# アプリケーション終了前2段階確認機能 設計・実装計画

## 要件分析

### 機能要件
1. **2段階確認プロセス**
2. **ComfyUI未処理キュー情報表示**
3. **専用ポップアップウィンドウ**
4. **キーボード・マウス操作制御**

### 操作要件
- **Escキー**: キャンセル側に反応
- **マウスクリック**: OK側のみ反応
- **キーボードのEnter/Space**: 無効化

### 背景・目的
- exeを不意に終了するとComfyUI側との通信が切れる
- photo_anime_*.pngの生成とメモリアルカード生成処理が中断される
- ユーザーの意図しない終了を防ぐため、2段階の確認を実装

---

## 設計

### 確認フロー

```
ユーザーがアプリ終了を試行
    ↓
┌─────────────────────────┐
│ 1回目確認ダイアログ      │
│ ・未処理キュー情報表示   │
│ ・[はい] [いいえ]        │
└─────────────────────────┘
    ↓               ↓
  [はい]         [いいえ] → アプリに戻る
    ↓
┌─────────────────────────┐
│ 2回目確認ダイアログ      │
│ ・最終確認メッセージ     │
│ ・[問題ない] [やっぱりやめます] │
└─────────────────────────┘
    ↓               ↓
[問題ない]    [やっぱりやめます] → アプリに戻る
    ↓
  アプリ終了
```

### 技術設計

#### 1. ダイアログコンポーネント
- **React Modal形式**
- **専用コンポーネント**: `ExitConfirmationDialog.tsx`
- **2つのステップ**: `step1`, `step2`

#### 2. ComfyUI状態取得
- **未処理キュー数**: `comfyUIService.getActiveJobs()`
- **進行中ジョブ**: 処理中のjobId一覧
- **キュー待ち**: 待機中のjobId一覧

#### 3. 終了制御
- **Electronメインプロセス**: `before-quit`イベントフック
- **終了阻止**: `event.preventDefault()`
- **レンダラー通信**: IPCで確認ダイアログ表示要求

---

## 実装計画

### Phase 1: Electronメインプロセス側

#### 1. 終了イベントハンドリング
```typescript
// main.ts
app.on('before-quit', async (event) => {
  if (!this.exitConfirmed) {
    event.preventDefault();
    await this.showExitConfirmation();
  }
});
```

#### 2. ComfyUI状態取得API
```typescript
// main.ts
ipcMain.handle('get-comfyui-status-for-exit', async () => {
  if (this.comfyUIService) {
    return await this.comfyUIService.getActiveJobs();
  }
  return { activeJobs: [], queueLength: 0 };
});
```

#### 3. 終了確認結果ハンドリング
```typescript
// main.ts
ipcMain.handle('confirm-exit', async (event, confirmed: boolean) => {
  if (confirmed) {
    this.exitConfirmed = true;
    app.quit();
  }
});
```

### Phase 2: レンダラープロセス側

#### 1. ダイアログコンポーネント作成
```typescript
// src/renderer/components/ExitConfirmationDialog.tsx
interface ExitConfirmationDialogProps {
  isOpen: boolean;
  step: 1 | 2;
  comfyUIStatus: ComfyUIStatus;
  onConfirm: () => void;
  onCancel: () => void;
}
```

#### 2. キーボード・マウス制御
```typescript
// キーボードイベント制御
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
    }
    // Enter, Space無効化
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
    }
  };
}, []);

// マウスのみでOK可能
<button onClick={onConfirm} tabIndex={-1}>
```

#### 3. IPCハンドリング
```typescript
// src/renderer/hooks/useExitConfirmation.ts
useEffect(() => {
  window.electronAPI?.onExitConfirmationRequest?.((data) => {
    setComfyUIStatus(data);
    setIsDialogOpen(true);
    setStep(1);
  });
}, []);
```

### Phase 3: UIデザイン

#### 1. 1回目ダイアログ
```
┌─────────────────────────────────────┐
│   よけまくり中アプリを終了しますか？   │
├─────────────────────────────────────┤
│ 未処理のComfyUIジョブ:              │
│ ・処理中: 2件                       │
│ ・待機中: 1件                       │
│ ・合計: 3件                         │
│                                     │
│ ⚠️ 終了すると処理が中断されます      │
├─────────────────────────────────────┤
│           [はい]    [いいえ]         │
└─────────────────────────────────────┘
```

#### 2. 2回目ダイアログ
```
┌─────────────────────────────────────┐
│    よけまくり中アプリを本当に終了？    │
├─────────────────────────────────────┤
│ この操作は取り消せません             │
│                                     │
│ 📷 画像生成処理が中断される可能性が   │
│    あります                         │
├─────────────────────────────────────┤
│     [問題ない]  [やっぱりやめます]    │
└─────────────────────────────────────┘
```

---

## 実装ステップ

### Step 1: メインプロセス終了制御
- `before-quit`イベントハンドリング
- ComfyUI状態取得API

### Step 2: IPCインターフェース
- preload.ts拡張
- レンダラー↔メイン通信

### Step 3: ダイアログコンポーネント
- ExitConfirmationDialog作成
- キーボード・マウス制御

### Step 4: 統合テスト
- 2段階確認フロー
- ComfyUI状態表示
- キー操作テスト

### Step 5: エラーハンドリング
- ComfyUI通信エラー時
- ダイアログ表示失敗時

---

## 技術的な考慮事項

### セキュリティ
- IPCチャンネルの適切な分離
- レンダラープロセスでの入力検証

### パフォーマンス
- ダイアログ表示の応答性
- ComfyUI状態取得の非同期処理

### ユーザビリティ
- 明確なメッセージ表示
- 誤操作防止（キーボード制御）
- 視覚的フィードバック

### 拡張性
- 将来的な確認項目追加対応
- 設定可能な確認レベル

---

## テスト計画

### 単体テスト
- ダイアログコンポーネントの動作
- キーボード・マウスイベント処理
- IPC通信の正常性

### 統合テスト
- 2段階確認フローの完全動作
- ComfyUI状態取得の精度
- 異常系での動作確認

### ユーザビリティテスト
- 実際の終了シナリオでの操作確認
- 誤操作防止の効果測定
- メッセージの分かりやすさ

---

## 実装優先度

### 高優先度
1. 基本的な2段階確認機能
2. ComfyUI状態表示
3. キーボード・マウス制御

### 中優先度
1. エラーハンドリング
2. UIデザインの洗練
3. 設定可能な確認レベル

### 低優先度
1. アニメーション効果
2. 詳細な統計情報表示
3. カスタマイズ可能なメッセージ