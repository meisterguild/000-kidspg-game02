# ランキング機能 実装計画（v1.0）

対象: KidsPG「よけまくり中」ゲーム（Electron + React + PixiJS）
目的: イベント会場の外部モニターで **recent（最新順）** と **ranking_top（スコア順）** を安定・高視認で常時表示する。

---

## 8. 実装方針

> **B: メイン + Preload + IPC（推奨・デフォルト）**／**A: レンダラー直読み（代替手段）** を双方記述。状況により切替可。

### 8.1 B 方式（推奨）

* 目的: パス解決をメインで一元化し、監視 push とセキュリティを両立。
* 典型構成（**ファイル名は一例。Gemini のワークスペース都合で変更可**）

  * **メイン**: `fileService.(ts|js)`（dev/prod パス吸収, `readJson()`）, `watcher.(ts|js)`（`fs.watch`+debounce）, `ipc.(ts|js)`（`ranking:read`/`ranking:watch`/`ranking:config`）, `createRankingWindow.(ts|js)`（`fullscreen:true`）。
  * **preload**: `ranking.preload.(ts|js)`（`window.ranking.read/onWatch/config`）。
  * **renderer**: `RankingWindow.(tsx|jsx)`（上下 2 段 UI）, `useRankingData.(ts|js)`（取得/再試行/差分更新）, `TopList/RecentList/StatusBar/CardItem` 等。
* IPC API（例）

  * `ranking:read` → `RankingData`
  * `ranking:watch` → push `{ changedAt, reason }`
  * `ranking:config` → `{ tileSize, refreshIntervalSec, scrollSpeedPxSec, pinTop3, spotlightTop3Sec, ... }`

### 8.2 A 方式（代替）

* 目的: 実装最短で暫定対応。**本ウィンドウに限り** `nodeIntegration` 等を必要最小限で許可。
* 手順（最小）

  1. `RankingWindow.(tsx|jsx)` から `fs`/`path` で `results/results.json` を読み込み。
  2. **3s（±300ms）ポーリング**で再取得。画像は個別にバックオフ再試行。
  3. `tileSize` 等は `config.json` を `fs` で直接読む。
* リスク: セキュリティ低下／prod パスの脆さ／監視 push 不可。将来拡張時に負債化。

---

## 9. 設定（`config.json` 参照）

以下キーを読み取り、未定義はデフォルト適用（**追加ファイルは作らない**）。

```jsonc
{
  "ranking": {
    "refreshIntervalSec": 3,
    "imageRetryMaxSec": 120,
    "tileSize": 376,
    "scrollSpeedPxSec": 30,
    "highlightTopN": 3,
    "pinTop3": true,
    "spotlightTop3Sec": 8
  }
  // counts.recentMax / counts.rankingMax は既存仕様に従う
}
```

---

## 10. 実装タスク（Gemini に渡す粒度）

**順序は前後可。ファイル名は一例で固定しない。**

* [ ] ランキング専用ウィンドウの起動フローを追加（トップのボタン → `createRankingWindow()`）。
* [ ] B 方式: `fileService`（dev/prod パス解決, `readJson`, `readConfig`）。
* [ ] B 方式: `watcher`（`fs.watch` + debounce）→ `webContents.send('ranking:watch', ...)`。
* [ ] B 方式: `preload` で `window.ranking.read/onWatch/config` を expose。
* [ ] レンダラー: `useRankingData`（初回取得＋watch＋3sポーリング）。
* [ ] レンダラー: 上段 Top3 固定 + 4 位以降スクロール、下段 recent スクロール。**tileSize/config 駆動**。
* [ ] 画像: `dummy_photo.png` プレースホルダ → バックオフ再試行 → `decode()` 後に差替え。
* [ ] ステータス: 右上に「更新: HH\:MM\:SS」。
* [ ] 受け入れ基準を満たす e2e 確認（`win-unpacked` で `./results` 参照）。

---

## 11. テスト計画

* 単体: `fileService` のパス解決／JSON パース、バックオフロジック。
* 結合: `fs.watch` → IPC → レンダラー再描画。
* E2E: exe 同階層に `results/` を置き、JSON 差替えで 5s 以内に反映。`memorialCardPath` 遅延→自動差替え確認。

---

## 12. 運用・配布メモ

* 開発: `npm run electron:dev`（本体）→ ランキング画面も起動ボタンから確認。
* 配布: `npm run dist:win`。署名周りで失敗する場合は **sign 無効化**で回避（dev 配布想定）。
* 実行: `release/win-unpacked` を丸ごとコピーし、同階層に `results/results.json` を配置して exe を実行。

---

## 13. 既知の注意

* `electron-builder` で codesign バイナリ展開時に symlink で失敗することがある → 開発配布は **署名無効化**で回避可。

---

以上。必要があれば、コード雛形（IPC/フック/スクロールコンポーネント）まで展開します。
