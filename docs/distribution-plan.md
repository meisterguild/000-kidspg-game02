# 当日PC向け配布パッケージの設計（2026-09-09）

開発機で USB 用のパッケージを作り、当日PCへコピーして動かすまでの決めごと。
**当日PCではインストール操作をしない**——コピーと展開だけで動く形にする。

作るコマンドは [`tools/make-onsite-package.cjs`](../tools/make-onsite-package.cjs)、
当日PCでの手順は [`docs/setup-onsite.md`](setup-onsite.md)。

---

## 前提（2026-09-09 に確定）

| 項目 | 決めたこと |
|---|---|
| ネット | **当日PCは繋がらない前提**。USB の中身だけで完結させる |
| インストール操作 | **しない**。ImageMagick / Node / Python はすべて携帯版・埋め込み版 |
| 救済ツール | **積む**（再生成・写真削除。無いと当日その場で何もできない） |
| プロファイル | **local だけ**（CPU実行・SD1.5・モデル4本 4.1GB）。server（SDXL 10.6GB）は積まない |
| 置き場所 | `C:\kidspg`（OneDrive の外） |
| **フォルダ完結** | **この1つのフォルダの中だけで済ませる。**片付けはフォルダを消すだけ、持ち帰りは丸ごとコピーだけ（2026-09-09 判断・実測で確認） |

---

## 4つの技術的な決定と、その根拠

### 1. exe は作らない（Electron 本体で `dist\` を読ませる）

`electron-builder` が作る exe は「署名が無く、世の中に出回っていない新品の exe」に
なるため、Windows 11 の Smart App Control に弾かれる。

**この開発機は Smart App Control が有効なまま `npm start`（= Electron 本体で `dist\` を
読む経路）が通っている**ので、そちらには実績がある。`electron.exe` 自体も署名は無い
（`Get-AuthenticodeSignature` は `NotSigned`）が、広く使われているバイナリなので
評価（レピュテーション）で通っている。

⚠️ 「評価で通る」は保証ではない。当日弾かれた場合の確実な対処は SAC をオフにすること
だが、**一度オフにすると Windows を入れ直すまで戻せない**ので、PCの持ち主の判断。

この方針の副産物として、`electron-builder` と `release/` は配布に使わなくなった
（開発機で exe を試したいときは `set KIDSPG_MODE=exe`）。

**実測で見つかった不具合（2026-09-08）**: `release/win-unpacked` の中で
`start-kidspg.bat /dryrun` を実行すると `[中止] Electron 本体が見つかりません` で
止まった。exe を `%~dp0release\win-unpacked\*.exe` にしか探しに行かないため、
electron-builder が win-unpacked へコピーした自分自身は隣の exe を見つけられない。
**配布の入口がこれだったので、exe 方式のままなら当日詰んでいた。**

### 2. ComfyUI の Python は venv ではなく埋め込み配布版

`venv/pyvenv.cfg` の `home` が `C:\Users\owner\AppData\Local\Programs\Python\Python312`
を指している。**ユーザー名が違うPCへコピーすると壊れる。**
これは新しい発見ではなく、`C:\WORK\AI\PINNED.md` に
「venv は絶対パスが焼かれるのでコピーせず必ず作り直す」「models はファイルコピーで
移せる。venv は移せない」と既に書かれている。ここでの判断は、**作り直しを
当日PCでやらせない**（＝インストール操作をしない）ための方式変更。

そこで ComfyUI 公式ポータブル版と同じ方式にする。

| | venv 方式 | 埋め込み方式（採用） |
|---|---|---|
| Python | インストール必須 | **zip 展開のみ・レジストリを触らない** |
| 当日PCでの作業 | Python を入れて venv 作成 + pip | **コピーだけ** |
| ユーザー名依存 | ある（壊れる） | ない |
| USB に積むもの | wheels 1.9GB + インストーラ | `python_embeded\` 1.9GB（完成品） |

> ✅ **2026-09-09 に実測で成立を確認。** requirements.lock.txt と **86/86 パッケージが
> 完全一致**（開発機の venv と同じ版）、ComfyUI 0.34.0 が起動、`/object_info` に
> モデル4本、dummy_photo で **1枚生成 122.9 秒**。踏んだ落とし穴は下に全部書いた。
>
> もう1点、torch は **VC++ 2015-2022 再頒布可能パッケージ**を要求する。Windows 11 なら
> 通常入っているが、点検を入れ、無い場合だけインストールを案内する（唯一の例外）。

#### 埋め込み Python の組み方（開発機で1回だけ）

> ✅ **2026-09-09 に実際に組んで動くことを確かめました。**
> ComfyUI 0.34.0 が起動し、`/object_info` にモデル4本が載り、生成も通りました。
> 実測でわかった落とし穴は下の「踏みやすいところ」に全部入れてあります。

**この手順はスクリプトにしてあります**（下の中身は、何をしているかを読むためのもの）。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\onsite\build-materials.ps1
```

冪等なので、途中で失敗したら直して同じコマンドをもう一度。
ComfyUI 本体・モデル4本・ImageMagick・Node もまとめて用意します。

作る場所は資材置き場の中（`<materials>/ai/python_embeded`）。
できたものは**そのままコピーするだけ**なので、当日PCでは何もしません。

```powershell
$M = "C:\WORK\AI\onsite-materials"
$PY = "$M\ai\python_embeded"

# 1. 埋め込み配布版の Python 3.12 を展開する
#    https://www.python.org/downloads/windows/ の "Windows embeddable package (64-bit)"
#    ※ インストーラ（*-amd64.exe）ではなく zip のほう
Expand-Archive python-3.12.10-embed-amd64.zip -DestinationPath $PY

# 2. _pth を**2箇所**直す（両方必要。2026-09-09 に実測で判明）
#    (a) `import site` を有効にする
#        🔴 embeddable 版は既定で site を読まない。直さないと pip で入れたものを
#        まったく import できず、「pip は成功するのに torch が無い」状態になる。
#        なお site-packages が sys.path に出るのは pip を入れた**あと**（手順3）。
#        フォルダが無いうちは site が追加しないので、ここで確認しても出てこない。
#    (b) `..\ComfyUI` の行を足す
#        🔴 **_pth を使うと sys.path はその中身だけになる。**
#        スクリプトのフォルダも cwd も追加されないため、これが無いと main.py の
#        1行目 `import comfy.options` が ModuleNotFoundError で落ちる（実測）。
#        相対指定は python.exe のあるフォルダ基準なので、丸ごとコピーしても壊れない。
$fixed = @()
foreach ($line in Get-Content "$PY\python312._pth") {
    if ($line -eq '.') { $fixed += $line; $fixed += '..\ComfyUI' }
    elseif ($line -match '^#\s*import site') { $fixed += 'import site' }
    else { $fixed += $line }
}
$fixed | Set-Content "$PY\python312._pth" -Encoding ASCII

# 3. pip を入れる（embeddable 版には同梱されていない）
Invoke-WebRequest https://bootstrap.pypa.io/get-pip.py -OutFile "$PY\get-pip.py"
& "$PY\python.exe" "$PY\get-pip.py" --no-warn-script-location

# 4. torch は CPU 版を明示して入れる（既定のインデックスだと CUDA 版が来る）
& "$PY\python.exe" -m pip install torch torchvision torchaudio `
    --index-url https://download.pytorch.org/whl/cpu

# 5. ComfyUI の依存
#    🔴 **requirements.txt ではなく requirements.lock.txt を使う。**
#    lock は開発機で動作確認した 86 パッケージの pip freeze（版が全部固定されている）。
#    requirements.txt（37行・版が緩い）だと、そのとき解決された版が入り、
#    「開発機では動いたのに当日PCでは違う版」になる。
#    ⚠️ **torch より後に入れること。** 先に requirements を入れると、その中の
#    torch 指定が PyPI 版で torch を上書きしてしまう（C:\WORK\AI\PINNED.md の注記）。
& "$PY\python.exe" -m pip install -r C:\WORK\AI\requirements.lock.txt

# 6. 確かめる
& "$PY\python.exe" -c "import torch, torchvision; print(torch.__version__, torch.cuda.is_available())"
```

`torch.cuda.is_available()` が `False` で正しい（CPU 実行）。

**踏みやすいところ**

| | |
|---|---|
| `python312._pth` の `import site` | コメントのままだと pip で入れたものを一切 import できない。**手順2(a)を飛ばすと必ず詰む** |
| `python312._pth` の `..\ComfyUI` | 無いと `import comfy.options` が失敗する。**_pth を使うと sys.path はその中身だけ**で、スクリプトのフォルダも cwd も入らない（2026-09-09 実測） |
| `robocopy /XD input` | **名前一致**なので深い階層の `comfy_api\input` まで消える。実際にそれで ComfyUI が起動しなくなった。**フルパスで指定する** |
| ComfyUI の `input/` `output/` | 🔴 検証で使った**実際の子どもの顔写真**とその変換結果が溜まっている（2026-09-09 の時点で 44 件 / 51 件）。**持ち出さない。** 混入は `make-onsite-package.cjs` が機械的に止める |
| ImageMagick の携帯版 | **配布が無くなっている**（GitHub のリリース資産は Windows 向けはインストーラのみ）。インストール済みフォルダの複製で動く（実測） |
| `Scripts\*.exe` | embeddable 版では当てにできない。`python.exe -m pip` の形で呼ぶこと |
| `venv` / `tkinter` | embeddable 版には無い。ComfyUI は使わないので問題ないが、`-m venv` は通らない |
| torch のサイズ | CPU 版でも約1.9GB。ダウンロードに時間がかかる |
| VC++ ランタイム | torch が要求する。当日PCで無い場合だけインストールが要る（唯一の例外） |
| 版を固定する | `C:\WORK\AI\requirements.lock.txt`（86 パッケージ・pip freeze 実測）と `C:\WORK\AI\PINNED.md` が正。**当日PCで pip は使えない**ので、後から差分を埋められない |
| 動作確認済みの版 | Python 3.12.10 / torch 2.13.0+cpu / ComfyUI コミット 3216c62e（v0.34.0 + 21commit）。開発機の venv で実測した組み合わせ |

最後に、資材置き場のまま ComfyUI を起こして通しを確かめる。

```powershell
& "$PY\python.exe" "$M\ai\ComfyUI\main.py" --cpu --listen 127.0.0.1 --port 8188 --disable-auto-launch
# 別の窓で: /system_stats が JSON を返し、/object_info にモデル4本が載っていること
```

#### 🔴 Smart App Control は ComfyUI の DLL もブロックする（2026-09-09 実測）

埋め込み Python を組んで最初に ComfyUI を起こしたとき、こうなって落ちました。

```
ImportError: DLL load failed while importing cython_special:
  アプリケーション制御ポリシーによってこのファイルはブロックされました。
```

イベントログ（Microsoft-Windows-CodeIntegrity/Operational）に **ID 3118
「Smart App Control Block Details」**と ID 3077 / 3033 が残っており、
`scipy\special\cython_special.cp312-win_amd64.pyd` の読み込みが拒否されていました。
この開発機の SAC は有効（`VerifiedAndReputablePolicyState = 1`）です。

**そのまま再実行したら通りました。** SAC はクラウドへ評価を問い合わせ、
**判定が出るまでのあいだ未署名ファイルをブロックする**ためです。

これが当日にとって意味すること:

| | |
|---|---|
| 影響範囲 | アプリ（Electron）だけでなく、**ComfyUI が読む未署名の .pyd 群**（scipy・torch など数百個）も対象 |
| ⚠️ **当日PCはオフライン** | SAC の評価はクラウド問い合わせに依るため、**オフラインだと判定が出ず、ブロックが解けない可能性がある** |
| いまの緩和策 | `start-comfyui.bat` は落ちても5秒後に上げ直す（オンラインなら判定が出て通る） |
| 🔴 **推奨** | **当日PCでは Smart App Control をオフにしておく。** 一度オフにすると Windows を入れ直すまで戻せないので、PCの持ち主の判断で**前日までに**行う |

> これは「exe を作らない」判断だけでは避けられない問題です。exe を捨てても、
> ComfyUI が読む未署名の .pyd は残るためです。
> **別PCでの検証（オフライン状態で）が必要な最大の理由がこれです。**

### 4. 1つのフォルダの中だけで完結させる

**片付けはフォルダを消すだけ、持ち帰りは丸ごとコピーだけ**にしたい（2026-09-09 判断）。
ところが既定では次のものが `C:\kidspg` の外へ出ていました。

| 出ていたもの | どこへ | 実測 | 対処 |
|---|---|---|---|
| Electron の実行時データ | `%APPDATA%\kidspg-game-2026` | **6.8MB**（Cache / GPUCache / Local Storage / Network / Preferences） | `app.setPath('userData' ほか)` でアプリ配下へ。🔴 **ready より前に呼ぶ**（後では効かない） |
| ワークフローの書き出し | `%TEMP%\kidspg-workflow` | — | アプリ配下の `tmp\` へ |
| ImageMagick の一時ファイル | `%TEMP%` | — | `MAGICK_TEMPORARY_PATH` を `app\tmp` へ（start-kidspg.bat） |
| Python ライブラリのキャッシュ | `%USERPROFILE%\.cache` | 現状は作られていない | `HF_HOME` / `TORCH_HOME` / `XDG_CACHE_HOME` を `ai\cache` へ（start-comfyui.bat）。あわせて `HF_HUB_OFFLINE=1` |

ComfyUI 自身は既に完結していました（`temp` / `input` / `output` / `user` は
既定で ComfyUI のフォルダ配下）。

**実測での確認**（2026-09-09）: アプリを起動すると `app\appdata` に 6.8MB ができ、
`%APPDATA%\kidspg-game-2026` の更新時刻は**変わりませんでした**。

> ⚠️ カメラ権限の許可状態も Electron の userData に入ります。**`appdata` を消すと
> 当日また確認が出うる**ので、当日の片付けで消すのは results の写真だけにしてください
> （`ops` の `purge-photos.cjs`）。

### 3. 場所の書き換えは「当日PC」ではなく「作るとき」にやる

ComfyUI の置き場所は3箇所に現れる。

| 場所 | 何を持つか |
|---|---|
| `config.json` の `comfyui...paths` | root / input / output / startBat |
| `ai/ComfyUI/extra_model_paths.yaml` | `base_path`（モデルの置き場所） |
| `ai/ComfyUI/start-comfyui.bat` | Python の場所 |

これを当日PC上で書き換えるのは危ない。`config.json` は 1 行に数百文字の日本語注釈を
持つ 19KB のファイルで、`ConvertFrom-Json` → `ConvertTo-Json` で往復させると
**字下げが全体で変わる**（実測: 216行すべて同じ内容だが、profiles 配下が 6 → 8 桁に
なる）。当日PCの bat でやると、失敗しても気づけない。

そこで **作るときに `--target` を確定させ、開発機で書き換えて目で確かめる**。
`config.json` は古いルート文字列だけを置換し、そのあと必ず `JSON.parse` し直して
壊れていないことと置換件数を確かめる。

当日PCの `0_セットアップ.bat` は書き換えず、**`manifest.json` の `target` と実際の
コピー先を突き合わせて、違ったら止まる**。黙って動かない状態にはしない。

`start-kidspg.bat` からも重複を1つ消した（`COMFY_DIR` のハードコードをやめ、
`config.json` の `comfyui...paths.root` を読む。ハードコードは config に paths が
無かったときの控えに格下げ）。

---

## パッケージの中身

```
KidsPG2026_setup\                （USB のルート）
├── 0_セットアップ.bat            ← 当日PCでこれを実行
├── verify-copy.ps1               ← 上のバッチが呼ぶ照合スクリプト
├── 1_当日手順書.md
├── manifest.json                 ← 版・コミット・前提の置き場所・サイズ
├── SHA256SUMS                    ← コピー漏れ・破損の検出用
├── prereq\VC_redist.x64.exe      ← 点検で不足していたときだけ
└── payload\
    ├── app\                      アプリ（Electron 本体 + dist。exe は無い）
    ├── ops\                      救済ツール（Node 携帯版 + tools + dist/main）
    ├── ai\                       ComfyUI + python_embeded + models（4本）
    └── bin\ImageMagick\          携帯版
```

### 容量

| 中身 | サイズ |
|---|---:|
| `ai/models`（4本） | 4.18 GB |
| `ai/python_embeded`（torch CPU 込み） | 約 1.9 GB |
| `ai/ComfyUI`（本体） | 約 0.15 GB |
| `app` | 約 0.30 GB |
| `bin` + `ops` | 約 0.18 GB |
| **合計** | **約 6.8 GB** |

**USB は 16GB 以上・exFAT か NTFS**（8GB では入らない。最大ファイルは 2.1GB なので
FAT32 の 4GB 制限そのものには当たらないが、総量が入らない）。

### `app` に何を入れ、何を入れないか

入れるもの: `dist\`（main と renderer）・`config.json`・`assets\`・
`card_base_images\`（`superseded_*` は除く）・`start/stop-kidspg.bat`・
`package.json`（**当日向けに絞った版**）・`node_modules\electron\dist`・
`form-data` とその依存20パッケージ。

`node_modules` は 719MB あるが、**実行時に要るのは electron と form-data だけ**。
`react` / `react-dom` / `three`（29MB）は Vite が `dist/renderer` へ焼き込むので
要らない。`package.json` は devDependencies と build 系 scripts を落とす——
当日PCには道具が無いので、書いてあるだけでスタッフが `npm start` を試して
失敗し「壊れている」と判断する経路になる。

積み忘れは動かすまで気づけない（`form-data` を落としても**起動はする**。ComfyUI へ
画像を上げる瞬間に初めて落ちる）ので、作成スクリプトが `dist/main` の
`require` を全部拾って解決できるか確かめる。

### 配布物を太らせていたもの（2026-09-09 に解消）

`dist/renderer` の 23MB のうち 18.6MB が昨年の未参照画像だった。
`assets.ts` が ``new URL(`../assets/images/${relativePath}`, import.meta.url)`` という
動的パターンで画像を読むため、**Vite はあのフォルダの全ファイルを出力する**。
コードから参照されていなくても、置いてあるだけで配布物に載る。
`superseded_2025/` へ移して 4.4MB になった。作成スクリプトは、これらが戻ってきたら
警告を出す。

---

## GitHub 管理 / ローカルのみ

| 管理する | 管理しない（ローカルのみ） |
|---|---|
| `tools/make-onsite-package.cjs`（作成スクリプト） | `ai/models` / `ai/python_embeded` |
| `tools/onsite-package-lib.cjs`（組み立ての決めごと） | ImageMagick・Node の携帯版 |
| `tools/onsite-materials.json`（外部資材の入手元と期待サイズ） | 完成した USB イメージ |
| `tools/onsite/0_setup.bat`・`verify-copy.ps1` | `VC_redist.x64.exe` |
| `docs/setup-onsite.md`・この文書 | |
| `tools/test-onsite-package.cjs`（単体テスト） | |

外部資材は既定で `C:/WORK/AI/onsite-materials` に集める（`--materials` で変更可）。
**欠けていたら入手元と期待サイズを表示して止まる**——穴あきパッケージを配って
当日PCで初めて足りないと分かるのがいちばん高くつく。

---

## 作り方

```bash
# 反復用（app と ops だけ。外部資材が無くても通る）
node tools/make-onsite-package.cjs --out tmp/pkg --app-only --skip-check --no-hash

# 本番
node tools/make-onsite-package.cjs --out D:\KidsPG2026_setup
```

順序: 事前点検 → 資材の確認 → `npm run check` → `app` → `ops` → `ai`/`bin` →
置き場所へ合わせる → 入口と手順書 → `manifest.json` / `SHA256SUMS` / 自己検証。
再実行できる（大きいものは robocopy `/MIR`）。

`npm run check` が通らなければ**作らない**。

---

## 残っていること

| # | 内容 | 必要なもの |
|---|---|---|
| 1 | 埋め込み Python を組んで1枚生成できることを確かめる | 開発機のネット（約2GB） |
| 2 | ImageMagick と Node の携帯版を集める | 同上 |
| 3 | `--app-only` でない本番パッケージを作り、USB へ入れる | 16GB 以上の USB |
| 4 | **別PCで通しの検証** | 当日PC（または別の Windows 機）1台 |

4 は開発機だけでは終わらない。**別PCで一度通さないと「コピーして実行できる」は
確認できない**（特に Smart App Control と埋め込み Python の挙動）。
