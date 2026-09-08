# KidsPGよけまくり中ゲーム - Web版配布

## 📦 配布可能ファイル

`dist/renderer/` フォルダの全内容がスタンドアロンWebアプリとして動作します。

### 🚀 配布方法

1. **フォルダ内容をコピー**
   ```
   dist/renderer/
   ├── index.html
   └── assets/
       ├── index-CNkj-8DN.css
       ├── browserAll-9xkFGOxW.js
       ├── webworkerAll-dg7wEd54.js
       └── index-r4LdrNrI.js
   ```

2. **ローカル実行**
   - ダブルクリック: `index.html`
   - ブラウザが自動起動してゲーム開始

3. **サーバー配布**
   - WebサーバーにアップロードしてURL提供
   - 全機能が動作（カメラ、ゲーム、保存機能）

## 🎯 動作環境

- **Windows**: Chrome, Edge, Firefox
- **Mac**: Chrome, Safari, Firefox  
- **Linux**: Chrome, Firefox
- **モバイル**: Chrome, Safari（カメラ機能対応）

## ✅ 含まれる全機能

- カメラ撮影・ニックネーム選択
- PixiJSゲームエンジン
- スコア・レベル管理
- 結果保存・表示
- 8時間連続稼働対応
- メモリリーク対策済み

## 📋 Windows専用アプリが必要な場合

Windows環境で以下を実行:
```bash
git clone [repository]
cd kidspg-game
npm install
npm run dist:win
```