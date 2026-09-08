# ローカルPCでの ComfyUI 構築手順（2026年版）

作成: 2026-09-01 夜間作業
対象: Windows 11。AIサーバー（`ssh rag-poc`）を使わず、**ローカルPCだけ**でカード生成まで通す構成。

> このPC（作業機）の実測環境は §5。**NVIDIA GPU が無いため CPU 実行**になっている。
> 本番PCが決まったら §6 の手順で GPU 版へ切り替えること。

---

## 1. 置き場所

```
C:\WORK\AI\
├── models\                                  ← モデル（全版で共有。ここだけで 10.6GB）
│   ├── checkpoints\animagine-xl-4.0.safetensors
│   ├── controlnet\controlnet-union-sdxl-promax.safetensors
│   ├── loras\Hyper-SDXL-8steps-CFG-lora.safetensors
│   ├── loras\Hyper-SDXL-4steps-lora.safetensors
│   └── vae\sdxl_vae.safetensors
├── dl-models.sh                             ← モデル取得（sha256 照合つき）
├── requirements.lock.txt                    ← pip freeze
├── PINNED.md                                ← 動作確認した版と再現手順
└── ComfyUI_20260902_0.34.0\                 ← 版ごとに増やす
    └── ComfyUI\
        ├── venv\                            ← Python 3.12 の仮想環境（版ごとに作り直す）
        ├── extra_model_paths.yaml           ← 上の models\ を参照する設定
        ├── start-comfyui.bat                ← CPU モードで起動（このPC用）
        └── start-comfyui-gpu.bat            ← NVIDIA GPU 機用
```

**ComfyUI 本体は `ComfyUI_{yyyymmdd}_{version}` の版ごとフォルダに置く。**
新しい版へ差し替えるときに、動いている版を残したまま横へ並べられるようにするため。
モデルは `C:\WORK\AI\models` の1か所を全版で共有し、`extra_model_paths.yaml` から参照する
（10.6GB を版ごとにコピーしない）。Junction を張っても同じことができる。

**OneDrive 配下（`C:\WORK\MGWork\...`）には置かない。** 10.6GB のモデルが同期対象になり、
ファイルロック競合で読み込みが失敗する。計画書 §8 のリスク表と同じ理由。
`C:\WORK` 直下は同期対象ではない（`C:\WORK\MGWork` だけが OneDrive への Junction）。

## 2. 前提のインストール

```powershell
winget install --id Python.Python.3.12 --scope user
# git と ImageMagick は導入済みであること
```

## 3. 構築

```bash
git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git C:/WORK/AI/ComfyUI_20260902_0.34.0/ComfyUI
cd /c/WORK/AI/ComfyUI_20260902_0.34.0/ComfyUI
"$LOCALAPPDATA/Programs/Python/Python312/python.exe" -m venv venv
./venv/Scripts/python.exe -m pip install --upgrade pip wheel setuptools

# CPU 版 torch（GPU 機なら §6 のインデックスに差し替える）
./venv/Scripts/python.exe -m pip install torch torchvision torchaudio \
    --index-url https://download.pytorch.org/whl/cpu

./venv/Scripts/python.exe -m pip install -r requirements.txt
```

**カスタムノードは一切入れない。** 2026年版ワークフローは標準ノードだけで構成してある
（`assets/ComfyUI_KidsPG_2026_01.README.md` 参照）。当日PCに追加インストールを要求しないため。

## 4. モデルの取得

AIサーバーに届くなら従来どおり:

```bash
bash tools/fetch-models.sh C:/WORK/AI/ComfyUI_20260902_0.34.0/ComfyUI
```

**社外など rag-poc に届かない場所では HuggingFace から直接取る**（`C:\WORK\AI\dl-models.sh`）。
5ファイルを並列に落とす。合計約 10.6GB。

```bash
bash C:/WORK/AI/dl-models.sh C:/WORK/AI/ComfyUI_20260902_0.34.0/ComfyUI
```

> レジューム（`curl -C -`）は使っていない。HF の CDN が Range を無視して
> 全体を追記してくることがあり、**サイズ超過の壊れたファイル**ができた（実際に踏んだ）。
> 中断したら該当ファイルを消して取り直すこと。スクリプトは毎回サイズを検証する。

期待サイズ:

| ファイル | bytes |
|---|---|
| `animagine-xl-4.0.safetensors` | 6,938,434,056 |
| `controlnet-union-sdxl-promax.safetensors` | 2,513,342,408 |
| `Hyper-SDXL-8steps-CFG-lora.safetensors` | 787,359,648 |
| `Hyper-SDXL-4steps-lora.safetensors` | 787,359,648 |
| `sdxl_vae.safetensors` | 334,641,162 |

## 5. 起動と検証

```
C:\WORK\AI\ComfyUI_20260902_0.34.0\ComfyUI\start-comfyui.bat        (CPU モード)
```

起動後、アプリ側リポジトリで:

```bash
npm run build                       # dist を作る（検証ツールが dist を使う）
node tools/comfyui-smoke.cjs        # ComfyUI 単体の検証と生成時間の実測
node tools/e2e-local-play.cjs       # アプリ込みの通し（撮影→カード→results.json）
node tools/e2e-local-play.cjs --no-ai   # ComfyUI 抜き（計画書 §7 撤退判断①の経路）
```

`comfyui-smoke.cjs` はノード定義との整合だけでなく、
**ワークフローが要求するモデルが実際に配置されているか**（`/object_info` の enum に載っているか）
まで見る。「ノードは合っているのにモデルが無い」で数十分溶かさないため。

## 6. 本番PC（NVIDIA GPU）へ移すとき

```powershell
cd C:\WORK\AI\ComfyUI_20260902_0.34.0\ComfyUI
venv\Scripts\python.exe -m pip uninstall -y torch torchvision torchaudio
venv\Scripts\python.exe -m pip install torch torchvision torchaudio `
    --index-url https://download.pytorch.org/whl/cu126
```

起動は `start-comfyui-gpu.bat`。`models\` はそのままコピーで移せる。

## 7. アプリ側の設定

`config.json` の `comfyui.baseUrl` は `http://127.0.0.1:8188`。
同一PCで ComfyUI を動かす前提なので変更不要。

AI変換をやめる（計画書 §7 撤退判断①）場合は `comfyui` セクションを外すだけでよい。
その場合カードの前景は**固定のプレースホルダ**になる。
撮影した本人の写真は前景に使わない（カードを後日ネットで公開する方針のため。2026-09-02 判断）。
`node tools/e2e-local-play.cjs --no-ai` でこの経路を検証済み。

## 8. 起動確認チェックリスト（毎回これを通す）

```bash
# 1. ComfyUI が上がっているか・どのデバイスで動いているか
curl -s http://127.0.0.1:8188/system_stats

# 2. ワークフローが要求するモデルが全部見えているか（ここで落ちたら生成しても無駄）
node tools/comfyui-smoke.cjs

# 3. アプリ込みの通し
node tools/e2e-local-play.cjs
```

`system_stats` の `devices[0].type` が `cpu` なら CPU 実行。本番PCで `cuda` になっていない場合は
torch が CPU 版のままなので §6 をやり直すこと。

## 9. 既知の落とし穴（今夜踏んだもの）

| 症状 | 原因 | 対処 |
|---|---|---|
| カードが1枚も生成されない。`no decode delegate for this image format 'C:/Users/owner/OneDrive'` | `magick -script` に渡すパスが引用符で囲われておらず、空白で分断されていた | 修正済み（`magick-script-generator.ts`）。パスは必ず `quotePathForMagick` を通すこと |
| モデルが読み込めない／サイズが期待値より大きい | `curl -C -` のレジュームで CDN が Range を無視し本体を追記していた | レジュームを使わない。`dl-models.sh` は `.part` に落としてサイズ一致時だけ本採用する |
| `save-photo` が "No handler registered" | main プロセスの非同期初期化が終わる前に IPC を叩いた | `get-config` が通るまで待つ（E2E 実装済み） |
| ComfyUI の初回起動が数分間無反応 | 大量ダウンロードでディスクが飽和し、`comfy_extras` の import が遅い | 待つ。`/system_stats` が 200 を返すまでが起動完了 |

---

## 10. 当日運用（本番PCで必ず設定すること）

このPCで検証しただけでは足りない項目。**本番PCが決まったら上から順に潰す。**

### 10.1 起動と監視

- 起動は `start-comfyui.bat`（CPU）／`start-comfyui-gpu.bat`（GPU）。
  どちらも **出力を `logs\comfyui.log` に落とし、落ちたら5秒後に自動で上げ直す**。
  - コンソールに垂れ流さないのは、Windows のコンソールが既定で QuickEdit モードで、
    **ウィンドウ内をクリックすると出力がブロックされて ComfyUI が止まる**ため。
    子どもが触る現場で最も起きやすい事故。
  - 自動再起動が要るのは、ComfyUI が落ちてもアプリは固定プレースホルダへ退避してしまい、
    **誰も気づかないまま全員が同じ絵のカードになる**ため。
- ゲームアプリは起動時に ComfyUI へ疎通確認し、繋がらなければダイアログで警告する（実装済み）。
  **朝いちで必ずこの警告が出ないことを確認する。**

### 10.2 電源・OS 設定

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0      # 電源が抜けた瞬間に DC 設定へ落ちる。既定は10分でスリープ
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0
powercfg /h off                            # 高速スタートアップ無効
```

- Windows Update を **9/15 まで一時停止**し、アクティブ時間を 08:00–20:00 に。
  前日 9/11 に手動で更新を当てきってから凍結する。
- ウイルス対策の除外に `C:\WORK\AI`、`results\`、venv の `python.exe` を追加する。
  6.9GB の safetensors を読むたびにスキャンが走るとモデルロードが数分伸びる。

### 10.3 同一PCで生成とゲームを同時に回す場合

- ComfyUI は全論理コアを使い切る。`start-comfyui.bat` は `OMP_NUM_THREADS=6` で絞ってあるが、
  **9/5 の連続耐久は必ず ComfyUI を動かした状態で実施すること。**
  生成が走っている裏で 3D パズルがカクついて操作不能になるかは、止めた状態では分からない。
- ノートPCなら底面の吸気を塞がない。5.5時間フルロードは熱でクロックが落ちる。

### 10.4 AI変換を当日オフにする

`config.json` の `comfyui` セクションをまるごと外して**アプリを再起動**する。
カードの前景は**人物ではない固定のプレースホルダ**になる（撮影した写真は使わない）。
ゲーム・ランキング・カード生成はそのまま動く。

### 10.5 生成が間に合わないときの挙動（設定の意味）

- `comfyui.maxConcurrentJobs` は **1**。ComfyUI は prompt を1件ずつ直列に実行するため、
  ここを増やしても速くならず、来場者全員分がキューに積まれるだけになる。
- `comfyui.timeouts.queue`（15分）を超えたジョブは**監視をやめると同時に ComfyUI のキューからも削除**する。
  削除しないと、誰も受け取らない画像のために CPU/GPU が占有され続ける。
- `comfyui.retry` は **未実装**。参照しているコードが無い。

## 11. まだ埋まっていない前提

| 項目 | 状態 |
|---|---|
| 本番PCの GPU 型番・VRAM・台数 | **未確定**（計画書 §6 判断#1） |
| 生成画像の安全性（多数枚の目視） | 未実施 |
| 顔の同一性の調整 | 未実施。実際の顔写真での確認が要る |
| 同時多重（前の子の生成中に次の子が撮影） | 未検証 |
| ランキング画面の実描画 | **検証済**（`e2e-local-play.cjs` が実描画まで確認する） |
| 31人目以降 | **対応済**。カードのパスは各プレイの `results/<日時>/result.json` に書き戻すため、表示キャッシュから溢れても失われない |
