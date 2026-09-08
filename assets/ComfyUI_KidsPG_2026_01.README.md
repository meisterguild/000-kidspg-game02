# ComfyUI_KidsPG_2026_01.json — 2026年版ワークフロー

昨年の `ComfyUI_KidsPG_03.json`（SD1.5）を SDXL 世代へ置き換えたもの。
`config.json` の `comfyui.workflow.templatePath` は既にこのファイルを指している。

## 検証状況

| 項目 | 状態 |
|---|---|
| ノード定義との整合 | **済**。AIサーバーの ComfyUI（797ノード）の `/object_info` と突き合わせ、**全ノードが存在・必須入力の欠落なし・未知の入力なし**を確認 |
| 実際に画像を生成 | **未**。モデル配置後に必ず実施すること |
| 生成時間・VRAM の実測 | **未**（本番PCが未確定） |
| 生成画像の安全性確認 | **未**。多数枚での目視確認が必須 |

## 構成

| 役割 | モデル | ライセンス | HF |
|---|---|---|---|
| Checkpoint | `animagine-xl-4.0.safetensors` | **openrail++**（CreativeML Open RAIL++-M） | `cagliostrolab/animagine-xl-4.0` |
| ControlNet | `controlnet-union-sdxl-promax.safetensors` | **apache-2.0** | `xinsir/controlnet-union-sdxl-1.0` の `diffusion_pytorch_model_promax.safetensors` |
| 高速化LoRA | `Hyper-SDXL-8steps-CFG-lora.safetensors` | **openrail++** | `ByteDance/Hyper-SD` |
| VAE | `sdxl_vae.safetensors` | **mit** | `madebyollin/sdxl-vae-fp16-fix` |

いずれも商用利用可。イベントは企業（マイスター・ギルド）の協賛出展であるため、
非商用ライセンスのモデル（例: Anima）は**採用しない**方針。

## 設計上の要点

### カスタムノードに依存しない

**すべて標準ノードだけで構成している。** 当日PCに追加インストールを要求しない。

当初は昨年と同じ `HEDPreprocessor` を使う想定だったが、これは
`comfyui_controlnet_aux` というカスタムノードパックに含まれるもので、
**素の ComfyUI には存在しない**（実サーバーで確認済み）。
そのため標準ノードの `Canny` に置き換え、ControlNet-Union の適用タイプも
`canny/lineart/anime_lineart/mlsd` に合わせている。

> より柔らかい輪郭が欲しい場合は、`comfyui_controlnet_aux` を導入した上で
> node 12 を `HEDPreprocessor`（`safe: "enable"`, `resolution: 1024`）に、
> node 16 の `type` を `hed/pidi/scribble/ted` に戻せばよい。
> ただし**当日の可搬性は落ちる**。

### プロンプトの書き方（2026-09-03 見直し）

`animagine-xl-4.0` は **Danbooru タグ**と専用の品質タグを前提に学習されている。
以前のプロンプトは自然文寄りの SD1.5 系タグ列で、モデルの作法と合っていなかった
（`open_eyes` のようなアンダースコア表記も Danbooru タグとして無効）。
そこで **「主体タグ → 一般タグ → 品質タグ（`masterpiece, high score, great score, absurdres`）」**
の順へ書き換え、ネガティブも Animagine の推奨（`low score, bad score, average score` など）を含めた。

- 性別は**指定しない**。誰が撮られるか分からないので `1girl` / `1boy` を置かず、
  `solo, child` にして輪郭（ControlNet）と入力画像に任せる
- `chibi` は**外した**。実写の頭身の輪郭と競合し、img2img 化（`denoise` < 1）すると特に破綻する
- ローカル用（`ComfyUI_KidsPG_2026_local.json` / DreamShaper 8 = SD1.5）は
  自然文寄りのままにしている。SD1.5 はそちらの方が素直に効く

安全側の指定（`nsfw` / `horror` / `bare shoulders` など）はネガティブから**外さないこと**。
設定画面はネガティブプロンプトを空にして保存できないようにしてある。

### cfg=5 とネガティブプロンプト

Hyper-SD の**通常版** LoRA は `cfg=1.0` を前提とするが、
**cfg=1.0 では classifier-free guidance が働かず、ネガティブプロンプトが一切効かない。**
`nsfw` / `horror` / `bad anatomy` といった安全側の指定がすべて無効になるため、
子ども向けイベントでは採用できない。

そこで **CFG 対応版（`Hyper-SDXL-8steps-CFG-lora`）を使い `cfg: 5`** としている。
昨年（cfg 7）と同様にネガティブが機能する。

### seed はアプリ側で振り直す

テンプレートの `seed` は固定値だが、`src/main/services/workflow-template.ts` の
`applyWorkflowVariables`（`src/main/main.ts` から呼ばれる）がプレイごとに
`KSampler` ノードの `seed` をランダム値へ書き換えてから `image_generate.json` を保存する。
（全員が同じ seed で生成されるのを防ぐため）

### 入力解像度

撮影は 300×300。SDXL は低解像度入力に弱いため、`ImageScale`（node 20）で 1024×1024 に拡大してから
Canny と VAEEncode に渡している。**上流の撮影解像度を上げる方が本質的な改善**なので、
Phase 3 で `config.json` の `camera.width/height` の引き上げを検討すること。

### denoise と img2img（2026-09-03 変更）

**このファイルの数値は「ComfyUI 単体で開いたとき用のフォールバック」であり、
アプリが実際に投げる値は `config.json` の `comfyui.profiles.<名前>.generation` が上書きする。**
調整はテスト・設定ページの入力欄から行い、このファイルを手で書き換えないこと
（上書きされるので効かない）。

対象の項目と、それが当たるノード:

| config.json の項目 | 当たる先 |
|---|---|
| `denoise` / `steps` / `cfg` | `KSampler` |
| `controlnetStrength` / `controlnetStartPercent` / `controlnetEndPercent` | `ControlNetApplyAdvanced` |
| `cannyLowThreshold` / `cannyHighThreshold` | `Canny` |
| `inputSize` | `ImageScale` の width / height |
| `positivePrompt` / `negativePrompt` | `KSampler` の positive / negative から配線を辿った `CLIPTextEncode` |

以前は `denoise = 1` だった。これは潜在表現を完全にノイズで置き換えるため、
**`VAEEncode`（node 14）の出力はサイズ情報としてしか使われず、
元の顔からの情報は ControlNet（輪郭）だけで伝わっていた**
（色・髪色・服はいっさい引き継がれない。昨年も同じ構造）。
「撮影した写真をアニメ調に変換している」つもりの見た目にならないため、
**`denoise = 0.6` の img2img へ変更した。**

**`steps` は 8 のまま据え置く（変えないこと）。**
ComfyUI の `KSampler` は `denoise < 1` のとき
`new_steps = int(steps / denoise)` でノイズスケジュールを組み、その末尾 `steps + 1` 本を使う
（`comfy/samplers.py` の `KSampler.set_steps`）。
つまり **`denoise` を下げてもサンプリング回数は `steps` のまま**で、
`steps` を増やせばそのぶん 1 枚あたりの時間がまっすぐ伸びる。
本番PCは CPU 実行で 1 枚 120〜170 秒（`config.json` の `_comment_time_limit`）なので、
ここを触るとキューの発散に直結する。

起動時の点検（`workflow-template.ts`）は次を見てスタッフへ警告する（生成自体は止めない）:
- `checkGenerationWiring`: `denoise` が 1 に戻っている／
  `latent_image` が `VAEEncode` へ繋がっていない（`EmptyLatentImage` になっている）
- `checkGenerationApplied`: `config.json` に書いた値が実際のワークフローへ**反映されなかった**
  （該当ノードが無い・その入力が配線されていて上書きできない・プロンプトの
  `CLIPTextEncode` を辿れなかった）。「保存したのに古い値が投げられ続ける」を防ぐため

### ブラウザの ComfyUI で同じ条件を再現する

テスト・設定ページの「同じワークフローを書き出す」で、
現在の設定を焼き込んだ API 形式 JSON が `tmp/comfyui-workflow-<プロファイル>.json` に出る。

1. 「ComfyUI をブラウザで開く」でブラウザを開く
2. 書き出した JSON を画面へドラッグ＆ドロップ（ComfyUI のフロントエンドは
   API 形式の JSON を落とすとグラフへ復元する。ノード配置は自動になる）
3. `LoadImage` ノードへ写真をドラッグ＆ドロップ
4. Queue

**「ComfyUI をブラウザで開く」だけでは、ゲームが使っているワークフローは見えない。**
ブラウザが最初に表示するのは、そのブラウザで最後に編集したグラフ
（ComfyUI の localStorage 由来）であって、アプリとは無関係。

## 昨年からの変更点

| | 2025 (`_03`) | 2026 (`_2026_01`) |
|---|---|---|
| 世代 | SD1.5 (`pvcFigurerizer_v30`) | SDXL (`Animagine XL 4.0`) |
| 入力解像度 | 300×300 のまま | `ImageScale` で 1024×1024 へ拡大 |
| 前処理 | `HEDPreprocessor`（カスタムノード） | **`Canny`（標準ノード）** |
| ControlNet | `control_v11p_sd15_softedge` | ControlNet-Union promax ＋ `SetUnionControlNetType` |
| ステップ / cfg | 17 / 7 | **8 / 5**（Hyper-SD CFG版 8steps LoRA） |
| LoRA | 定義はあるが **KSampler へ未接続**（＝効いていなかった） | 正しく接続 |
| seed | 固定 | プレイごとにアプリが振り直す |
| プロンプト | ghibli style, chibi emote … | グミの世界観へ寄せた（2026-09-03 に Animagine XL 4.0 のタグ作法へ書き換え） |
| denoise | 1（＝写真は輪郭だけ） | **0.6（img2img）**。2026-09-03 変更。`steps` は 8 のまま |

> 昨年のワークフローは `LoraLoader`(node 18) の出力を KSampler が使わず `["4",0]` を直接参照しており、
> **LoRA は実質無効だった**。

## アプリ側との約束（絶対に守る）

`src/main/services/workflow-template.ts` の `applyWorkflowVariables` がテンプレートを走査して
文字列置換するため、次を変更しないこと。`validateWorkflowTemplate` が起動時にこの約束を検査する。

1. `LoadImage` ノードの `inputs.image` に `${photo_png}` を残す
2. `SaveImage` ノードの `inputs.filename_prefix` に `${filename_prefix}` を残す
3. `SaveImage` は **ノードID `9`**（`comfyui-worker.ts` が `9` → `8` の順で優先探索する）。
   `SaveImage` を2つ以上置かないこと。全ノードが同じ `filename_prefix` に潰され、
   カードに載る画像がどちらになるか不定になる
4. プロンプトや `denoise` などをこのファイルで変えても、`config.json` の
   `generation` があればそちらが勝つ。変えるなら `config.json` 側（＝設定画面）
5. `config.json` の `comfyui.outputPrefix`（`photo_anime`）は**変更しない**。
   プロファイル（`profiles.local` / `profiles.server`）側には置かないこと
   （`image-composition-config.ts` が `photo_anime_` をハードコードで探すため）

## モデル配置先（ComfyUI）

```
models/checkpoints/animagine-xl-4.0.safetensors
models/controlnet/controlnet-union-sdxl-promax.safetensors   ← promax と分かる名前へリネーム
models/loras/Hyper-SDXL-8steps-CFG-lora.safetensors
models/vae/sdxl_vae.safetensors
```

AIサーバー（`ssh rag-poc`）の共有ストア `/srv/llm/hf` へ取得済み。
ローカルへは `bash tools/fetch-models.sh` で取り込む。

## 実機確認で見るポイント

- [ ] 1枚あたりの生成時間・VRAM ピーク（**本番PCで実測**）
- [ ] **顔の同一性**。Canny の `low_threshold`(0.25) / `high_threshold`(0.6) と
      ControlNet `strength`(0.85)、必要なら `denoise` を下げて調整
- [ ] **安全性**。多数枚での目視確認（子ども向けイベントとして必須）
- [ ] 男女・年齢が入力に応じて変わるか（昨年は誰を入れても同系統の顔が出ていた）
- [ ] 8steps と 4steps LoRA の速度・品質比較（4steps 版も取得済み）

## 旧構成へ戻せるか

**戻せない。** `assets/ComfyUI_KidsPG_03.json` が要求する
`pvcFigurerizer_v30` / `White star 星極 Concept` LoRA / SD1.5 ControlNet は
**手元にモデルの実体が無く、ライセンス（商用可否）も未検証**。
「保険として旧構成に戻す」という選択肢は事実上存在しないので、
この 2026 版を確実に動かすことに集中すること。
