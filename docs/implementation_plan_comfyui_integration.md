# ComfyUI連携機能 設計・実装計画書

## 1. 概要

本ドキュメントは、`@docs/tech_stack.md` に記載された技術スタックに基づき、ElectronアプリケーションからComfyUI APIを呼び出して顔写真をアニメ調の画像に変換する機能の設計と実装計画を定義する。

### 1.1. 目的

- ユーザーが撮影した顔写真を、ローカルで動作するComfyUIを利用してアニメ風イラストに変換する。
- 変換された画像を、後続の記念カード生成処理に利用する。
- オフライン環境で完結し、プライバシーを保護した画像変換フローを実現する。

## 2. 設計方針

Electronのメインプロセスをバックエンドとして機能させ、レンダラープロセス（React UI）からの要求に応じてComfyUI APIとの通信を仲介する。

### 2.1. システム構成

```mermaid
graph TD
    subgraph Electronアプリケーション
        subgraph レンダラープロセス (React UI)
            A[CameraPage: 写真撮影] --> B{画像データをメインプロセスへ送信};
            B --> C[ローディング表示];
            F[変換後画像をメインプロセスから受信] --> G[ResultPage: 変換後画像の表示/記念カード生成];
        end

        subgraph メインプロセス (Node.js)
            D{IPC通信で画像データ受信};
            D --> E[ComfyUI APIクライアント];
            E --> H{変換後画像をレンダラープロセスへ返却};
        end
    end

    subgraph ComfyUI (ローカルサーバー)
        I[APIエンドポイント];
    end

    E --> I;

    subgraph IPC通信 (Electron)
        B -- ipcRenderer.invoke --> D;
        H -- return --> F;
    end

    style ComfyUI fill:#f9f,stroke:#333,stroke-width:2px
```

### 2.2. データフロー

1.  **[レンダラー]** `CameraPage`にてWebRTC APIで撮影した500x500pxの画像（Data URL形式）を取得する。
2.  **[レンダラー -> メイン]** `ipcRenderer.invoke` を使用し、画像データをメインプロセスに送信する。UIはローディング状態に遷移する。
3.  **[メイン]** `ipcMain.handle` で画像データを受け取る。
4.  **[メイン]** 画像データをComfyUIの `/upload/image` APIエンドポイントにPOSTし、サーバー上の一時ディレクトリに画像をアップロードする。
5.  **[メイン]** 事前に定義されたComfyUIのワークフロー（APIフォーマットのJSON）を読み込む。このJSON内の画像入力ノードの `filename` を、ステップ4でアップロードされたファイル名に動的に書き換える。
6.  **[メイン]** `/prompt` エンドポイントに、ワークフローJSONをPOSTし、画像生成ジョブをキューに追加する。
7.  **[メイン]** WebSocketまたは `/history` エンドポイントのポーリングにより、ジョブの完了を待つ。
8.  **[メイン]** ジョブ完了後、`/view` エンドポイントから生成された画像ファイルを取得する。
9.  **[メイン -> レンダラー]** 取得した画像データ（Buffer）をData URLに変換し、レンダラープロセスに返却する。
10. **[レンダラー]** `ResultPage`で変換後の画像を画面に表示し、Canvas APIによる記念カード生成処理に渡す。

### 2.3. ComfyUIワークフロー

- **事前準備:** ComfyUI上で、入力画像をアニメ調に変換するワークフローを構築し、APIフォーマットでJSONファイルとして保存しておく。
- **ワークフロー構成例:**
    1.  `LoadImage`: API経由でアップロードされた画像を指定する入力ノード。
    2.  `FaceDetailer` / `ImpactWildcard`: (任意) 顔の検出や品質向上のための前処理。
    3.  `CheckpointLoader` / `LoraLoader`: アニメ調のスタイルを適用するためのモデル/LoRAをロードする。
    4.  `KSampler`: 画像を生成する。
    5.  `SaveImage`: 生成された画像を保存するノード。このノードの出力が最終結果となる。
- **保存場所:** エクスポートしたJSONは `src/main/comfyui_workflows/face_to_anime_workflow.json` としてプロジェクトに含める。

## 3. 実装計画（タスク分割）

### タスク1: ComfyUIワークフローの準備とテスト

- [ ] ComfyUIをローカル環境にセットアップする。
- [ ] 顔写真をアニメ調に変換するワークフローをGUIで構築・調整する。
- [ ] 完成したワークフローを「API Format」でエクスポートし、`src/main/comfyui_workflows/` に保存する。

### タスク2: メインプロセスでのComfyUIクライアント実装

- [ ] `src/main/` に `comfyui_client.ts` を作成する。
- [ ] `axios` または `node-fetch` を利用して、以下のAPIと通信する関数を実装する。
    - `uploadImage(imageData: string): Promise<string>`
    - `queuePrompt(workflow: object): Promise<string>`
    - `waitForResult(promptId: string): Promise<Buffer>`
- [ ] `main.ts` に `ipcMain.handle('transform-image', ...)` を登録し、クライアント処理を呼び出す。

### タスク3: レンダラープロセスとメインプロセスの連携

- [ ] `src/main/preload.ts` に `contextBridge` を用いて `window.api.transformImage(imageData)` を定義する。
- [ ] `src/shared/types/index.ts` に関連する型定義を追加する。
- [ ] `CameraPage.tsx` または後続ページで、撮影ボタン押下後に `transformImage` を呼び出す処理を実装する。
- [ ] API通信中はUIにスピナーなどのローディングインジケーターを表示する。

### タスク4: エラーハンドリング

- [ ] ComfyUIサーバーが起動していない、または応答しない場合のエラー処理を実装する。
- [ ] 画像のアップロードやプロンプト実行に失敗した場合のエラー処理を実装する。
- [ ] エラー発生時は、レンダラープロセスにエラー情報を返し、ユーザーに「画像変換に失敗しました」などのメッセージを表示する。

### タスク5: 統合とテスト

- [ ] 一連のフロー（撮影 → IPC通信 → 画像変換 → 結果表示）を統合する。
- [ ] 正常系・異常系の両方で動作テストを実施する。

## 4. 検討事項

- **ComfyUIの起動方法:**
  - 当面は、Electronアプリとは別に、ユーザーが手動でComfyUIサーバーを起動することを前提とする。手順をREADMEなどに明記する。
  - 将来的には、Electronアプリの起動時にComfyUIのプロセスを自動でバックグラウンド起動する仕組みを検討する可能性もある。
- **設定の管理:**
  - ComfyUIのAPIエンドポイント（例: `http://127.0.0.1:8188`）は、当面は定数としてクライアント内にハードコーディングする。
- **パフォーマンス:**
  - 画像変換処理には数秒〜数十秒かかる可能性があるため、非同期処理と明確なローディング表示を徹底し、ユーザー体験を損なわないように配慮する。適切なタイムアウト値を設定する。
