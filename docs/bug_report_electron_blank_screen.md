# 不具合報告：Electronビルド後の画面真っ白問題

**報告日:** 2025年8月14日

**問題の概要:**
`npm run dist` コマンドでビルドしたElectronアプリケーションを起動すると、画面が真っ白になり、アプリケーションが正常に表示されない。

**再現手順:**
1. プロジェクトのルートディレクトリで `npm install` を実行し、依存関係をインストールする。
2. `npm run dist` コマンドを実行し、Electronアプリケーションをビルドする。
3. ビルドされた実行可能ファイル（例: `release/build/KidsPGよけまくり中ゲーム Setup 1.0.0.exe`）を起動する。

**期待される結果:**
アプリケーションのUIが正常に表示され、操作可能になる。

**実際の結果:**
アプリケーションウィンドウは表示されるが、内容は真っ白で、UIが表示されない。

**原因:**
Electronのメインプロセス (`src/main/main.ts`) が、ビルドされたレンダラープロセス (`dist/renderer/index.html`) を読み込む際のパス指定が誤っていたため。

*   `package.json` の `"main": "dist/main/main/main.js"` の設定により、ビルド後のメインプロセスは `dist/main/main` ディレクトリで実行される。
*   `src/main/main.ts` 内の `__dirname` は、実行時に `dist/main/main` を指す。
*   `this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))` という記述では、`dist/main/main` から見て一つ上の階層 (`dist/main`) にある `renderer/index.html` を探してしまう。
*   しかし、`vite.config.ts` の設定 (`build.outDir: '../../dist/renderer'`) により、レンダラーのビルド成果物である `index.html` は `dist/renderer` に出力される。

このパスの不一致により、メインプロセスが `index.html` を見つけられず、画面が真っ白になっていた。

**暫定的な解決策 (コード修正が必要な場合):**
`src/main/main.ts` の該当箇所を以下のように修正することで解決する。

```typescript
// 修正前
this.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

// 修正後
this.mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
```
これにより、`dist/main/main` から二つ上の階層 (`dist`) に移動し、そこから `renderer/index.html` を正しく参照できるようになる。

## 修正状況
*   **ステータス**: 修正済み
*   **修正コミット**: 
*   **修正日**: 
*   **修正者**: 
*   **備考**: 

