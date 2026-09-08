# ランキング機能 要件定義（v1.0）

対象: KidsPG「よけまくり中」ゲーム（Electron + React + PixiJS）
目的: イベント会場の外部モニターで **recent（最新順）** と **ranking_top（スコア順）** を安定・高視認で常時表示する。

> 方針まとめ
> 
> * **常時フルスクリーン**の別ウィンドウ。
> * **上段=ranking_top／下段=recent**、いずれも**水平左流れのオートスクロール**。
> * **Top3 を固定強調**（推奨）。
> * 画像は `config.json` で **tileSize** 等を管理（ハードコード禁止）。
> * 記念カード未生成時は `assets/dummy_photo.png` をプレースホルダ表示、バックグラウンドで差替え。
> * 更新は **fs.watch→IPC push** を優先、フォールバックで **3s ポーリング（±300ms ジッター）**。

---

## 1. スコープ

* 本要件は **ランキング表示ウィンドウ** に限定。
* `results/results.json` の生成更新や ComfyUI の画像生成はスコープ外（ただし遅延を考慮した表示要件は含む）。
* 既存実装への影響は最小化。ゲーム本体の構成は変更しない。

## 2. 画面要件

### 2.1 ウィンドウ

* 起動: トップ画面右上の **「ランキング表示」ボタン**（テキストリンク不可）。
* 属性: **fullscreen: true**（本番は固定。開発時のみ F11 トグル可）。
* リフレッシュ: 既定 **3s**（ジッター ±300ms）。運用で **3–5s** に調整可。
* レスポンシブ: 想定 30 インチ／1920×1080 を最大活用。

### 2.2 レイアウト（上下 2 段）

* **上段: ranking_top（スコア順）**

  * **Top3 固定強調**（1位>2位>3位を 1.25x など）。右側で 4 位以降を**水平オートスクロール**。
  * `pinTop3` で切替可能（false なら全件スクロールし、Top3 の出現頻度を増やす）。
* **下段: recent（新着順）**

  * **水平オートスクロール**。テキストは当面なし（後日拡張）。
* **タイルサイズ**: `config.ranking.tileSize` を使用（**既定 376**）。`object-fit: cover`。CSS/JS いずれも **ハードコード禁止**。

### 2.3 画像表示

* 表示ソース: 各エントリの `memorialCardPath`。
* プレースホルダ: **`assets/dummy_photo.png`**（既存ファイルを使用）。
* 差替え: 画像は `Image.decode()` 完了後に置換し、チラつき抑制。
* キャッシュ対策: 読み込み URL に `?v={timestamp}` を付与。

### 2.4 ステータス

* 右上に「更新: HH\:MM\:SS」。異常時は小さく赤点表示。

## 3. データ要件

* 位置: **exe 同階層**の `./results/results.json`（相対パス）。
* 仕様: `@docs/results_json_specification.md`

  * `recent: { resultPath, memorialCardPath, score, playedAt }[]`
  * `ranking_top: { resultPath, memorialCardPath, score, rank }[]`
* 件数: 既存の **ルート直下 `config.json`** を参照（`counts.*` など）。UI に件数を埋め込まない。
* 文字コード: UTF-8（LF/CRLF 許容）。
* パス解決: dev=`path.resolve(process.cwd(),'results')`、prod(unpacked)=`path.join(path.dirname(process.execPath),'results')`。

## 4. 動作要件

* **自動更新**

  * 優先: メインで `fs.watch` → IPC push。
  * 補助: レンダラーで **3s（±300ms）ポーリング**。
* **画像遅延（ComfyUI 約 2 分想定）**

  * 未生成/404 は `assets/dummy_photo.png` 表示 → 2s→4s→8s… 最大 **120s** バックオフ再試行。
* **フォールバック**

  * `ranking_top` が空の場合、`recent` から暫定上位を生成し **Tmp** バッジ付与。

## 5. 非機能要件

* パフォーマンス: JSON 10〜200 件でも滑らかな水平スクロール（GPU 利用、`will-change: transform`）。
* 安定性: JSON 取得失敗時でも UI は落ちず前回表示を維持。
* セキュリティ: オフライン・単一 PC 運用。過度に厳格化しない。
* ログ: 本番は記録なし（デバッグ時のみコンソール）。
* デザイン: ゲーム本体のトーン＆マナーに準拠。フォントは本体のメインを流用。

## 6. 文言

* 見出し: **「ランキング」**, **「最近のプレイ」**
* ステータス: 「更新: HH\:MM\:SS」「画像生成待ち」

## 7. 受け入れ基準

1. `npm run lint && npm run build` が通る。
2. `npm run dist:win` → `win-unpacked` の exe 実行で `./results/results.json` を認識する。
3. ウィンドウが **起動時から全画面** で表示される。
4. **上段**に ranking_top が表示され、Top3 が固定強調される（`pinTop3=true` 既定）。
5. **下段**に recent が表示される。
6. JSON 更新から **5 秒以内**（3s ポーリング＋ジッター）に画面へ反映される。
7. `memorialCardPath` 未生成時は `assets/dummy_photo.png` 表示 → 生成後に自動差替え。
8. 異常（JSON 破損/ファイルロック）でもウィンドウは落ちず、前回表示を維持。
