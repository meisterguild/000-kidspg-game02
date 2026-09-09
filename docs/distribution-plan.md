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

---

## 3つの技術的な決定と、その根拠

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

そこで ComfyUI 公式ポータブル版と同じ方式にする。

| | venv 方式 | 埋め込み方式（採用） |
|---|---|---|
| Python | インストール必須 | **zip 展開のみ・レジストリを触らない** |
| 当日PCでの作業 | Python を入れて venv 作成 + pip | **コピーだけ** |
| ユーザー名依存 | ある（壊れる） | ない |
| USB に積むもの | wheels 1.9GB + インストーラ | `python_embeded\` 1.9GB（完成品） |

> ⚠️ **未検証。** この構成（ComfyUI 0.34.0 + torch CPU）で埋め込み Python が動くことを
> まだ確かめていない。公式ポータブルが同じ方式なので通る見込みだが、**開発機で一度
> 組んで1枚生成できることを見てから**配布に使う。詰まった場合の退避は「当日PCへ
> 事前に Python 3.12 を入れ、wheels から venv を作る」。
>
> もう1点、torch は **VC++ 2015-2022 再頒布可能パッケージ**を要求する。Windows 11 なら
> 通常入っているが、点検を入れ、無い場合だけインストールを案内する（唯一の例外）。

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
