# ランキング機能 実装計画 (Gemini実行計画 v1.0)

## 概要

ユーザー提供の要件定義書・実装計画書に基づき、Geminiが具体的な実装を進めるためのアクションプラン。
基本的な方針はユーザー案の「B方式（メインプロセスでのファイル監視 + IPC）」を踏襲しつつ、既存のプロジェクト構造（TypeScript, React Context, Tailwind CSS）に沿った具体的なファイル名と実装ステップを定義する。

---

## フェーズ1: 基盤準備とウィンドウ起動

**目標:** トップページからランキング表示用の新しいウィンドウを起動できるようにする。

1.  **トップページのボタン追加:**
    *   対象ファイル: `src/renderer/pages/TopPage.tsx`
    *   内容: 「ランキング表示」ボタンを設置する。クリック時にメインプロセスへ `ranking:open-window` チャンネルで通知する。

2.  **ウィンドウ生成ロジック:**
    *   新規ファイル: `src/main/windows/ranking-window.ts`
    *   内容: ランキング用の`BrowserWindow`を生成・管理するクラスまたは関数を作成する。全画面表示、`webPreferences`（`preload`スクリプトの指定等）を設定する。

3.  **IPCハンドラ設定:**
    *   対象ファイル: `src/main/main.ts`
    *   内容: `ranking:open-window` をリッスンし、`ranking-window.ts` の関数を呼び出してウィンドウを生成するIPCハンドラを登録する。

4.  **レンダラー側ルート設定:**
    *   新規ファイル: `src/renderer/pages/RankingPage.tsx` (プレースホルダ)
    *   対象ファイル: `src/renderer/App.tsx`
    *   内容: ランキング表示用のコンポーネントの雛形を作成し、React Router（または同等の仕組み）に `/ranking` のようなルートで登録する。`ranking-window.ts` はこのURLをロードする。

---

## フェーズ2: メインプロセス側のデータ供給ロジック

**目標:** `results.json` を監視し、データをレンダラープロセスに供給する仕組みを構築する。

1.  **共有型定義:**
    *   新規ファイル: `src/shared/types/ranking.ts`
    *   内容: `RankingData` や `GameResult` など、メインプロセスとレンダラープロセスで共有するデータ型を定義する。

2.  **ランキングサービス:**
    *   新規ファイル: `src/main/services/ranking-service.ts`
    *   内容: `results.json` と `config.json` の読み取り、解析、パス解決（dev/prod環境対応）を行う責務を持つ。
        *   `getRankingData()`: `results.json` を読み込み、`ranking_top` と `recent` のリストを返す。
        *   `getRankingConfig()`: `config.json` からランキング関連の設定を返す。
        *   `watchResults(callback)`: `fs.watch` を使用して `results.json` の変更を監視し、変更があった場合にコールバックを実行する。

3.  **IPCハンドラ拡張:**
    *   対象ファイル: `src/main/main.ts`
    *   内容: `ranking-service` を利用して以下のIPCハンドラを実装する。
        *   `ranking:get-data`: `getRankingData` の結果を返す。
        *   `ranking:get-config`: `getRankingConfig` の結果を返す。
    *   `main.ts` から `ranking-service` の `watchResults` を呼び出し、変更を検知したら `ranking-window` の `webContents` に `ranking:data-updated` を送信する。

4.  **Preloadスクリプト:**
    *   対象ファイル: `src/main/preload.ts` (または `ranking.preload.ts` を新規作成)
    *   内容: 上記IPCを呼び出す関数と、`ranking:data-updated` を受信するリスナーを `window.rankingApi` のような形でレンダラーに公開する。

---

## フェーズ3: レンダラープロセス側のUIとデータ表示

**目標:** 受け取ったデータを元に、要件通りのランキング画面を構築する。

1.  **データ管理Context:**
    *   新規ファイル: `src/renderer/contexts/RankingContext.tsx`
    *   内容: `preload` 経由で取得したランキングデータ（`data`, `config`）を保持し、配下のコンポーネントに提供するReact Contextを作成する。初期データの取得と、IPC経由での更新通知を受けてデータを再取得するロジックもここに含める。

2.  **UIコンポーネント実装:**
    *   対象ファイル: `src/renderer/pages/RankingPage.tsx`
    *   内容: `RankingContext` からデータを受け取り、画面の全体レイアウト（上段・下段・ステータスバー）を構成する。
    *   **コンポーネント分割:**
        *   `src/renderer/components/ranking/TopList.tsx`: スコア上位リスト。Top3のピン留めと、4位以降の水平スクロールを実装。
        *   `src/renderer/components/ranking/RecentList.tsx`: 最新プレイリスト。水平スクロールを実装。
        *   `src/renderer/components/ranking/CardItem.tsx`: 個々の記念カード。画像表示、`dummy_photo.png` プレースホルダ、画像生成完了後の差し替え（再試行ロジック含む）を実装。
        *   `src/renderer/components/ranking/StatusBar.tsx`: 「更新日時」などのステータス表示。
    *   **スタイリング:** 全てのコンポーネントは `Tailwind CSS` を使用してスタイリングする。

---

## フェーズ4: 仕上げと検証

**目標:** 要件定義の受け入れ基準を全て満たしていることを確認する。

1.  **リントとビルド:**
    *   コマンド: `npm run lint`, `npm run build`
    *   内容: エラーや警告が出ないことを確認する。

2.  **E2E手動テスト:**
    *   コマンド: `npm run dist:win`
    *   内容: `win-unpacked` ディレクトリで以下のシナリオをテストする。
        1.  exe実行でアプリが起動し、トップページからランキング画面が全画面で開けるか。
        2.  exeと同階層の `results/results.json` を正しく読み込んでいるか。
        3.  `ranking_top` と `recent` が正しく表示・スクロールされるか。
        4.  `results.json` を手動で更新後、5秒以内に画面が更新されるか。
        5.  `memorialCardPath` が存在しない場合にダミー画像が表示され、画像ファイルが後から配置された場合に自動で差し替わるか。
        6.  JSONファイルが不正な形式の場合や、一時的に読み取れない場合でもウィンドウがクラッシュしないか。