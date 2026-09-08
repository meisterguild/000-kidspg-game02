# Windows用Electronアプリ作成手順

## 🖥️ Windows環境での作成方法

### 前提条件
- Windows 10/11
- Node.js 18+ インストール済み
- Git インストール済み

### 🚀 ビルド手順

1. **リポジトリクローン**
   ```cmd
   git clone [your-repository-url]
   cd kidspg-game
   ```

2. **依存関係インストール**
   ```cmd
   npm install
   ```

3. **Windows用アプリ作成**
   ```cmd
   npm run dist:win
   ```

### 📦 生成されるファイル

- `release/KidsPGよけまくり中ゲーム Setup 1.0.0.exe` - インストーラー
- `release/kidspg-game-1.0.0-win.zip` - ポータブル版

### 🎯 その他のプラットフォーム

- **macOS**: `npm run dist:mac` (macOS環境が必要)
- **Linux**: `npm run dist:linux`
- **全プラットフォーム**: `npm run dist`

### 🔧 設定変更

package.jsonの`build`セクションで以下をカスタマイズ可能:
- アプリアイコン
- インストーラー設定
- 署名設定
- 自動更新設定

## ⚡ 即時利用したい場合

1. Web版（270KB）をダウンロード
2. `index.html`をダブルクリック
3. 全機能がブラウザで動作