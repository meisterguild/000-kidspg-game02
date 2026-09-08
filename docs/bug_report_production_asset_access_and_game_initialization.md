# バグレポート: 本番環境でのアセットアクセスとゲーム初期化問題

## 概要

Electronアプリケーション本番環境（パッケージ済み）において、音声・画像アセットの読み込みとPixiJSゲームエンジンの初期化に関する複数の問題が発生。開発環境では正常に動作するが、本番環境で機能しない状態。

**発生日時**: 2025年8月17日
**環境**: Windows 10/11, Electron本番パッケージ
**症状**: ゲーム画面で無限ローディング、音声・画像読み込み失敗

## 問題の詳細

### 1. アセットパス解決問題

#### 症状
- 本番環境で音声ファイル・画像ファイルが `[object Promise]` として認識される
- `net::ERR_FILE_NOT_FOUND` エラーが発生
- 開発環境では正常に動作

#### 原因分析
- `getSoundAssetPath()` と `getImageAssetPath()` 関数が同期関数として定義されているが、本番環境では `electronAPI.getAssetAbsolutePath()` が Promise を返す
- 呼び出し側で `await` 処理が不足

#### ログ例
```
[Specific] 音声ファイルの読み込みに失敗しました: [object Promise] 
[object%20Promise]:1 Failed to load resource: net::ERR_FILE_NOT_FOUND
```

#### 実装された修正
1. **非同期関数化**:
   ```typescript
   // Before
   export const getSoundAssetPath = (key): string => { ... }
   
   // After  
   export const getSoundAssetPath = async (key): Promise<string> => { ... }
   ```

2. **await処理追加**:
   ```typescript
   // loadAssets関数内
   const path = await getSoundAssetPath(key as keyof typeof SOUND_ASSET_RELATIVE_PATHS);
   ```

3. **IMAGE_ASSETS定数を関数化**:
   ```typescript
   // Before
   export const IMAGE_ASSETS = { ... }
   
   // After
   export const getImageAssets = async () => { ... }
   ```

### 2. ASARパッケージ内パス解決問題

#### 症状
- メインプロセスでのアセットパス解決が不正確
- ASARファイル内の正しいパスが特定できない

#### 調査結果
ASARファイル構造確認:
```
\dist\renderer\assets\
├── action.mp3
├── bell.mp3
├── sprite_items.png
├── title_image_01.png
└── ...
```

#### 実装された修正
```typescript
// main.ts内のgetAssetAbsolutePath修正
if (app.isPackaged) {
  const assetFileName = relativePath.replace(/^assets\/(sounds|images)\//, '');
  assetPath = path.join(__dirname, '../../renderer/assets', assetFileName);
}
```

### 3. PixiJSスプライト読み込み問題

#### 症状
- PixiGameEngineで静的インポートを使用していたため、本番環境でスプライト画像が読み込めない

#### 実装された修正
```typescript
// Before
import spriteSheetUrl from '../assets/images/sprite_items.png';

// After
import { getImageAssetPath } from '../utils/assets';
const spriteSheetUrl = await getImageAssetPath('spriteItems');
```

### 4. GPU プロセス クラッシュ問題

#### 症状
重要なログで発見:
```
GPU process exited unexpectedly: exit_code=-1073740791
```

#### 原因分析
- PixiJSのWebGL初期化時にGPUプロセスがクラッシュ
- ゲーム初期化の無限ローディングの根本原因と推測

#### 実装された対策

1. **PixiJS レンダリング フォールバック**:
   ```typescript
   try {
     // WebGL初期化を試行
     await this.app.init({
       preference: 'webgl',
       failIfMajorPerformanceCaveat: false
     });
   } catch (webglError) {
     // Canvas フォールバック
     await this.app.init({
       preference: 'webgpu-fallback',
       powerPreference: 'low-power'
     });
   }
   ```

2. **Electron GPU設定**:
   ```typescript
   // main.ts内
   app.commandLine.appendSwitch('disable-gpu-process-crash-limit');
   app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor');
   ```

## 現在の状況

### 解決済み問題
- ✅ アセットパス解決の非同期化
- ✅ ASARパッケージ内正しいパス解決  
- ✅ PixiJSスプライト読み込みの動的パス対応
- ✅ GPU クラッシュ対策の実装

### 未解決問題
- ❌ ゲーム初期化の無限ローディング（根本原因不明）
- ❌ GPU プロセス クラッシュの完全回避

### 現在のログ状況
```
[PACKAGED] Asset path resolved: assets/images/sprite_items.png -> C:\...\dist\renderer\assets\sprite_items.png
```
- アセットパス解決は正常に動作
- しかし、PixiJSの初期化ログが一切表示されない

## デバッグ実装状況

### 追加されたログ
1. **GamePage レベル**:
   ```
   GamePage: Component initialized
   GamePage: Config loading: [状態]
   ```

2. **PixiGameEngine レベル**:
   ```
   PixiGameEngine: initialize() called!
   PixiGameEngine: Starting initialization...
   PixiGameEngine: PIXI application initialized with WebGL/Canvas
   ```

3. **タイムアウト設定**:
   - 3秒でデバッグ用タイムアウト

## 次回の調査方針

### 1. 初期化到達確認
現在のログで以下を確認:
- `GamePage: Component initialized` が表示されるか
- `PixiGameEngine: initialize() called!` が表示されるか

### 2. 考えられる原因
1. **ルーティング問題**: ゲーム画面に到達していない
2. **React/Context問題**: GamePageコンポーネントが正しく描画されていない
3. **Promise解決問題**: async/await 処理で無限待機状態
4. **GPU問題**: GPUクラッシュ対策が不十分

### 3. 追加調査項目
1. **タイムアウトエラー確認**: 3秒後にエラーが表示されるか
2. **コンポーネント描画確認**: GamePageが実際に描画されているか
3. **設定読み込み確認**: configの読み込みが完了しているか
4. **GPU代替手段**: PixiJS以外のCanvas実装検討

## 技術的詳細

### ファイル変更履歴
- `src/renderer/utils/assets.ts`: 非同期関数化
- `src/main/main.ts`: パス解決とGPU設定
- `src/renderer/game/PixiGameEngine.ts`: 動的パス読み込みとフォールバック
- `src/renderer/pages/GamePage.tsx`: デバッグログ追加
- `src/renderer/components/TitleImageCarousel.tsx`: 非同期アセット対応

### 使用技術
- Electron v33.0.0
- PixiJS v8.4.0
- Vite v6.0.0
- TypeScript

### ビルド設定
- ASAR パッケージング有効
- Windows NSIS インストーラー
- 自動更新機能対応

## 参考資料

### 関連エラーコード
- `exit_code=-1073740791`: Windows GPU プロセス クラッシュ
- `net::ERR_FILE_NOT_FOUND`: ファイルパス解決失敗

### 関連ドキュメント
- [Electron ASAR パッケージング](https://www.electronjs.org/docs/latest/tutorial/asar-archives)
- [PixiJS v8 初期化方法](https://pixijs.com/8.x/guides/basics/getting-started)
- [Windows GPU プロセス問題](https://github.com/electron/electron/issues/gpu-process-crashes)