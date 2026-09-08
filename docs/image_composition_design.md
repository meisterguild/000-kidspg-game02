# 記念カード画像合成機能 設計書

## 1. 概要

ゲームプレイ後に生成される結果（`result.json`）とAI変換後の画像（`photo_anime.png`）を用いて、ImageMagickを利用した記念カード画像を自動生成する機能の設計を行う。

## 2. 設計方針

- **入力**:
    - `results/{YYYYMMDD_HHMMSS}/result.json`: プレイヤーのランク、スコア等の情報が記載されたJSONファイル。
    - `results/{YYYYMMDD_HHMMSS}/photo_anime.png`: ComfyUIによって生成されたプレイヤーの顔写真（アニメ調）。
    - `card_base_images/bg-card-rank-*.png`: ランクに応じた背景カード画像。

- **処理**:
    1. `result.json` ファイルから `rank` の値を読み取る。
    2. `rank` の値に基づき、使用する背景カード画像 (`bg-card-rank-*.png`) を決定する。
    3. ImageMagickの`magick`コマンドを使用し、背景カード画像の上に `photo_anime.png` を合成する。

- **出力**:
    - `results/{YYYYMMDD_HHMMSS}/memorial_card.png`: 最終的に生成された記念カード画像。

## 3. ランクと背景画像のマッピング

`result.json` の `rank` 文字列と、`card_base_images` ディレクトリ内のファイル名の対応は以下の通り。

| `rank` の値 | 背景画像ファイル名 |
| :--- | :--- |
| "ビギナー" (beginner) | `bg-card-rank-01-beginner.png` |
| "アマチュア" (amateur) | `bg-card-rank-02-amateur.png` |
| "アドバンス" (advanced) | `bg-card-rank-03-advanced.png` |
| "エキスパート" (expert) | `bg-card-rank-04-expert.png` |
| "ベテラン" (veteran) | `bg-card-rank-05-veteran.png` |
| "エリート" (elite) | `bg-card-rank-06-elite.png` |
| "マスター" (master) | `bg-card-rank-07-master.png` |
| "レジェンド" (legend) | `bg-card-rank-08-legend.png` |

※ `result.json`内の日本語ランク名とファイル名の英語が対応する想定。

## 4. 画像合成処理

ImageMagickの `magick convert` コマンドを利用して、画像の合成を行う。

### コマンド構文

```bash
magick convert {背景画像} {前景画像} -geometry {幅}x{高さ}+{X座標}+{Y座標} -composite {出力画像}
```

- **前景画像**: `photo_anime.png`
- **背景画像**: ランクに応じて選択された `bg-card-rank-*.png`
- **-geometry**: 前景画像を配置する位置とサイズを指定する。前景画像のサイズは500x500pxを想定。背景カードのレイアウトに合わせて、中央上部に配置する。
- **出力画像**: `memorial_card.png`

---

## 5. 画像合成とテキスト描画の最終実装

度重なる試行の結果、`run_shell_command` の実行環境（Windows上のbash）におけるシェルの複雑な引数解釈の問題を回避し、かつ単一のコマンドで画像生成を完結させる、以下の手法を確立した。

### 5.1. アプローチ概要

ImageMagickの `-script` オプションを利用し、画像合成とテキスト描画の全ての操作を単一のスクリプトファイルに記述する。`magick -script <ファイル名>` を実行することで、シェルの引数解釈問題を完全に回避し、一連の処理をアトミックに実行する。

### 5.2. 実装手順

**ステップ1：操作スクリプトファイルの動的生成**

アプリケーションは、`result.json` の内容に基づき、以下の形式で操作スクリプトファイル（例: `magick_script.txt`）を動的に生成する。

- **スクリプト内容の例**:
  ```
  # Step 1: 入力画像を読み込み、合成する
  C:/.../bg-card-rank-02-amateur.png
  C:/.../photo_anime_...png
  -geometry +150+100
  -composite

  # Step 2: テキスト描画の設定を行う
  -font C:/Windows/Fonts/meiryo.ttc
  -pointsize 40
  -fill darkorange
  -gravity Center

  # Step 3: テキストを描画する
  -draw "text 0,200 '銀翼の騎士'"
  -draw "text 0,250 'アマチュア'"
  -draw "text 0,300 '80'"
  -draw "text 0,350 '2025-08-15 21:28:39'"

  # Step 4: 最終的な画像を出力する
  C:/.../memorial_card.png
  ```

**ステップ2：スクリプトの実行**

生成したスクリプトファイルを指定して、`magick -script` コマンドを一度だけ実行する。

- **実行コマンド**:
  ```bash
  magick -script C:/Users/owner/MG/PoC_base/000-kidspg-game01/results/20250815_212728/magick_script.txt
  ```

### 5.3. 結論

この `-script` を利用するアプローチにより、中間ファイルを生成することなく、単一の安定したコマンド実行で、画像の合成とテキストの描画を両立できる。これが、現在のツール環境における最善かつ最終的な解決策である。
