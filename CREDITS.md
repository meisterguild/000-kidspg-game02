# CREDITS / 素材とライセンス

このアプリと、これが生成する記念カード・公開ギャラリーに含まれる素材の出典一覧。
**未確認の項目は「未確認」と明記している。当日までに埋めること。**

---

## 1. 画像生成モデル（ComfyUI）

生成された記念カード画像はこれらのモデルの出力を含む。

| 役割 | モデル | 配布元 | ライセンス |
|---|---|---|---|
| Checkpoint | Animagine XL 4.0 | `cagliostrolab/animagine-xl-4.0`（Hugging Face） | CreativeML Open RAIL++-M (`openrail++`) |
| ControlNet | ControlNet-Union SDXL 1.0 (promax) | `xinsir/controlnet-union-sdxl-1.0` | Apache-2.0 |
| 高速化LoRA | Hyper-SD (SDXL 8steps CFG) | `ByteDance/Hyper-SD` | `openrail++` |
| VAE | sdxl-vae-fp16-fix | `madebyollin/sdxl-vae-fp16-fix` | MIT |

いずれも商用利用可であることを Hugging Face のライセンス表記で確認済み（2026-09-01）。

**公開ギャラリーに掲載する際は、フッター等に上記4点の名称とライセンスを記載すること。**
Apache-2.0 は NOTICE の保持、OpenRAIL++ は利用制限条項の継承を求めている。

> 昨年（2025）の構成（`pvcFigurerizer_v30` / `White star 星極 Concept` LoRA / SD1.5 ControlNet）は
> **ライセンス未確認**。モデルの実体も手元にないため、保険としては使えない。

---

## 2. フォント

| 用途 | フォント | 状態 |
|---|---|---|
| 記念カードの文字描画 | **Meiryo**（`C:/Windows/Fonts/meiryo.ttc` / `meiryob.ttc`） | **要対応**。Windows 同梱フォントを、配布・Web公開する画像にラスタライズして焼き込んでいる。EULA 上グレーなので、**SIL OFL のフォント（Noto Sans JP / M PLUS Rounded 1c など）へ差し替えて同梱することを推奨**。変更箇所は `src/main/services/image-composition-config.ts` の `this.fontPath` 1行 |
| カード背景の「AIグミパク！」バッジ | 同上（Meiryo Bold で描画済み） | 同上。差し替える場合はバッジも作り直す |
| TOP画面のタイトル画像 | 同上（Meiryo Bold で描画済み） | 同上 |
| 画面UI | OS 標準（Tailwind の system font stack） | 問題なし |

> 本来のゲームデザイン（アーティファクト版）は Google Fonts の
> Baloo 2 / Zen Maru Gothic を使っていたが、当日のオフライン動作のため移植していない。
> ローカル同梱すれば世界観を戻せる（いずれも OFL）。

---

## 3. 効果音

`src/renderer/assets/sounds/`

| ファイル | 現在の用途 | 出典 |
|---|---|---|
| `paltu.mp3` | グミを食べる | **未確認** |
| `jump.mp3` | 面をまたぐ | **未確認** |
| `bell.mp3` | ステージクリア | **未確認** |
| `ng.mp3` | 進めないグミをタップ | **未確認** |
| `sound7.mp3` | 1手もどす | **未確認** |
| `button_click.mp3` | ボタン操作 | **未確認** |
| `screen_change.mp3` | 画面遷移 | **未確認** |
| `newtype.mp3` | 結果画面 | **未確認** |
| `action.mp3` | 未使用（2025年の遺産） | **未確認** |
| `machine.mp3` | 未使用（2025年の遺産） | **未確認** |

**すべて2025年から引き継いだもので、出典・ライセンスの記録がない。**
公開イベントで再生するため、当時の入手元を確認して本表を埋めること。
確認できないものは差し替えるか、使用をやめる判断が要る。

---

## 4. 画像

| ファイル | 用途 | 出典 |
|---|---|---|
| `card_base_images/bg-card-rank-01〜08-*.png` | 記念カード背景（2026年版・現行） | 2025年版の意匠（自社制作・要確認）へ、右上バッジのみ「AIグミパク！」へ差し替えたもの |
| `card_base_images/superseded_*/` | 差し替え前の退避（パッケージには含まない） | 同上 |
| `src/renderer/assets/images/title_gummy_01.png` | TOP画面タイトル | **本アプリで生成した暫定素材**。正式なタイトルアートができ次第 差し替えること |
| `src/renderer/assets/images/title_image_01〜04.png` | 2025年「よけまくり中」のタイトル。**このリポジトリには含めていない**（今年は参照しないため。ファイルはローカルに残置） | 自社制作（要確認） |
| `src/renderer/assets/images/sprite_items.png` / `.xcf` | 2025年のスプライト。**このリポジトリには含めていない**（同上） | 自社制作（要確認） |
| `assets/icon.ico` / `icon.png` | アプリアイコン | 自社制作（要確認） |
| `assets/dummy_photo.png` | カメラ不通時のダミー写真 | 自社制作（要確認） |

---

## 5. ソフトウェア

主要な依存（`package.json` 参照）。いずれもパーミッシブ。

- Electron — MIT
- React / React DOM — MIT
- three.js — MIT
- Vite — MIT
- Tailwind CSS — MIT
- form-data — MIT

**インストーラに三者ライセンス通知を同梱していない。**
`electron-builder` の `extraFiles` に本ファイルと各ライブラリのライセンスを含めることを推奨。

---

## 6. 生成物（記念カード）の扱い

カード画像には、来場した子どもの顔写真をもとに生成した画像が含まれる。
撮影・保存・掲示・公開の同意と保持方針は
社内の検討資料 `05_kidspg/202609/docs/個人情報とデータの取り扱い.md` に整理してある
（本リポジトリの外にあるため、この配布物には含まれない）。
