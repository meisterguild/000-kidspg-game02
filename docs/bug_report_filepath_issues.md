# 不具合報告：Vite/Electron環境におけるファイルパスの不備（更新版）

## 報告日
2025年8月14日（初回）  
2025年8月13日（レビュー更新）

## 報告者
Gemini CLI（初回）  
Claude Code（レビュー）

## 現象
Vite開発環境とElectronビルド環境において、一部のファイルパスの指定に不備があり、アセットの読み込み失敗や画面表示の問題が発生する可能性がある。コードレビューの結果、一部の問題は既に修正済みだが、未修正の重要な問題が残存している。

## 期待される動作
Vite開発環境とElectronビルド環境の両方で、全てのアセット、HTMLファイル、アイコンなどが正しく参照され、アプリケーションが期待通りに動作すること。

## 現状分析と修正状況

### 1. メインウィンドウのHTML読み込みパス ✅ **修正済み**
*   **箇所**: `src/main/main.ts:51`
*   **現状**: `this.mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));`
*   **ステータス**: **正常** - 正しいパスが設定されている
*   **備考**: 元の報告書で指摘された `../renderer/index.html` の問題は既に修正済み

### 2. アプリケーションアイコンのパス ⚠️ **要修正**
*   **箇所**: `src/main/main.ts:42`
*   **現状**: `icon: path.join(__dirname, '../../assets/icon.png')`
*   **問題**: 
     - `__dirname` は `dist/main/main` を指すため、パスは `dist/assets/icon.png` を参照
     - しかし実際のアイコンは `assets/icon.png`（プロジェクトルート）に存在
     - Viteビルドでは `src/renderer/assets` は `dist/renderer/assets` に出力される
*   **影響**: Electronアプリケーションのアイコンが表示されない
*   **推奨修正**: `path.join(__dirname, '../../../assets/icon.png')` または適切なアイコン配置戦略の実装

### 3. ランキングウィンドウのHTML読み込み ❌ **問題確認**
*   **箇所**: `src/main/main.ts:77`
*   **現状**: `const rankingPath = path.join(process.cwd(), 'public', 'index.html');`
*   **問題**: 
     - `public` ディレクトリが存在しない
     - `package.json` の `build.files` に `public/**/*` は含まれているが、ソースに対応する `public` ディレクトリが無い
*   **影響**: ランキングウィンドウが機能しない（フォールバック処理でプレースホルダー表示）
*   **推奨修正**: 
     1. `public/index.html` を作成する、または
     2. 既存の `ranking.html`（プロジェクトルート）を使用するようパスを修正する

### 4. package.json build設定 ✅ **適切**
*   **現状**: `build.files` に適切な設定が含まれている
     - `dist/**/*`
     - `dist/renderer/assets/**/*`
     - `public/**/*`
*   **ステータス**: 設定は適切、ただし `public` ディレクトリの実体が必要

## 緊急度分類
- **高**: アイコンパス問題（ユーザー体験に影響）
- **中**: ランキングウィンドウ問題（機能的な欠陥、ただしフォールバック有り）

## 修正推奨順序
1. アイコンパスの修正
2. ランキング機能のHTML設定
3. テスト実行による動作確認

## 関連ファイル/コード
*   `src/main/main.ts` (main)
*   `package.json` (build設定)
*   `vite.config.ts` (ビルド出力設定)
*   `assets/icon.png` (アイコンファイル)
*   `ranking.html` (ランキング用HTML - 要確認)

## 修正状況
*   **ステータス**: ✅ **全て修正完了**
*   **修正コミット**: 未記録
*   **修正日**: 2025年8月13日
*   **修正者**: Claude Code
*   **備考**: 
    - SpriteViewerTest.tsx: Vite静的アセットimport使用に変更
    - main.ts アイコンパス: `../../../assets/icon.png` に修正
    - main.ts ランキングパス: `ranking.html` 直接参照に変更

## 追加修正項目

### 4. スプライトテストページの画像読み込み ✅ **修正済み**
*   **箇所**: `src/renderer/test/SpriteViewerTest.tsx:3,112`
*   **修正前**: `IMAGE_ASSETS.spriteItems` 使用
*   **修正後**: `import spriteSheetUrl from '../assets/images/sprite_items.png';` + `PIXI.Assets.load(spriteSheetUrl)`
*   **効果**: Viteの静的アセット最適化により、開発・本番環境で確実に動作
*   **ステータス**: 最適解で実装完了
