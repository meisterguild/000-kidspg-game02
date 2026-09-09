# 当日PCのセットアップ手順

USB を差して `0_セットアップ.bat` を実行し、Windows の設定を4つ直せば終わりです。
**インストール操作はありません**（例外は下の「VC++ ランタイム」だけ）。

所要時間の目安: コピー 10分 ＋ 設定 5分 ＋ 検証 10分（うち AI 生成の1枚に約3分）。

---

## 0. 用意するもの

| | |
|---|---|
| USB メモリ | 16GB 以上・exFAT か NTFS（8GB では入りません） |
| 当日PC | Windows 11・空き容量 15GB 以上・Webカメラ・スピーカー |
| ネット | **不要**（USB の中身だけで完結します） |
| 管理者権限 | **不要**（VC++ ランタイムが無かった場合だけ必要） |

---

## 1. USB を差して `0_セットアップ.bat` を実行する

```
USB のルート
├── 0_セットアップ.bat                        ← これをダブルクリック
├── 1_当日手順書.md                            ← このファイル
├── 2_ComfyUI構築手順（参考・開発機向け）.md    ← 何が入っているかを知るため
├── 3_このパッケージの設計.md                   ← 判断の理由（exe を作らない等）
├── verify-copy.ps1                            ← 0_セットアップ.bat が呼ぶ
├── payload\                                   ← 中身（app / ops / ai / bin）
├── manifest.json                              ← 版と、前提にしている置き場所
└── SHA256SUMS                                 ← コピー漏れ・破損の検出用
```

> 📄 **2 と 3 は読まなくてもセットアップできます。** 何かが壊れたときに
> 「そもそも何がどう入っているのか」を追うための資料です。
>
> ⚠️ **2 は開発機での構築手順で、venv 前提で書かれています。**
> このパッケージに入っている Python は **venv ではなく埋め込み配布版**
> （インストール不要・ユーザー名に依存しない）です。Python の作り方について
> だけは **3 の「埋め込み Python の組み方」が正しい**ので、2 の §2〜§3 は
> 読み替えてください。モデルの入手先・当日運用・落とし穴（2 の §4 と §9〜§11）は
> そのまま使えます。
>
> 🔴 **当日PCで ComfyUI を作り直すことはできません**（オフラインで pip も
> 使えないため）。作り直しが必要になったら開発機で組んでパッケージを作り直します。

やることを見るだけ（何も書き換えない）なら `0_セットアップ.bat /dryrun`。

このバッチがやること:

1. **事前点検** — payload の有無・空き容量・置き場所の照合・VC++ ランタイム
2. **ブロック解除** — 「別の場所から来た」印を外す（付いていると起動が止められる）
3. **コピー** — `C:\kidspg` へ。⚠️ **`results\` と `logs\` は消しません**（当日の成果物を守るため、やり直しても安全です）
4. **照合** — `SHA256SUMS` と突き合わせ、コピー漏れと破損を見つける
5. **検証** — ImageMagick / Node / 埋め込み Python / ComfyUI 本体の存在

> 🔴 **置き場所は `C:\kidspg` から変えないでください。**
> パッケージの中の `config.json` が ComfyUI の場所を**絶対パス**で持っており、
> その値は作った時点で `C:\kidspg` に決まっています。別の場所へ入れたい場合は
> パッケージを作り直してください（開発機で `--target D:\kidspg`）。
> バッチはこの食い違いを検出して**止まります**（黙って動かない状態にはなりません）。

コピー後の姿:

```
C:\kidspg\
├── app\        アプリ本体（start-kidspg.bat / config.json / dist / node_modules）
│   ├── results\   ← 当日の成果物。**バックアップするのはここだけ**
│   └── logs\      ← ComfyUI のログ
├── ai\         ComfyUI + 埋め込み Python + モデル4本
├── bin\        ImageMagick（携帯版）
└── ops\        当日の救済ツール（Node 携帯版 + tools）
```

---

## 2. 人がやること（4つ。スクリプトでは代われません）

| # | 設定 | 場所 | 理由 |
|---|---|---|---|
| 1 | **カメラのアクセスを ON** | 設定 > プライバシーとセキュリティ > カメラ >「デスクトップ アプリがカメラにアクセスできるようにする」 | OFF だとダミー写真モードになり、**AI変換が一切走りません** |
| 2 | **スリープ・画面オフを「なし」** | 設定 > システム > 電源 | 終日稼働するため。途中で寝るとカード生成が止まります |
| 3 | **音量とスピーカー** | 通知領域 | 効果音が出るか、1プレイして耳で確かめる |
| 4 | **ディスプレイの拡大縮小** | 設定 > システム > ディスプレイ | 画面が窮屈なら 100% に。ゲーム画面は横長を前提にしています |

### Smart App Control（Windows 11）について

このアプリは **Electron 本体に `dist\` を読ませて起動**します（自前の exe は作りません）。
Electron 本体は広く使われているバイナリなので、**Smart App Control が有効なままでも
起動する実績があります**。まずはそのまま進めてください。

⚠️ もしアプリが起動せず何も表示されない場合は、Smart App Control が弾いています。
確認は「イベントビューアー > Microsoft-Windows-CodeIntegrity/Operational」。
その場合の確実な対処は Smart App Control をオフにすることですが、
**一度オフにすると Windows を入れ直すまで戻せません。** PCの持ち主の判断で行ってください。

### VC++ ランタイムが無いと言われたら

ComfyUI（torch）が要求します。Windows 11 なら通常入っていますが、無い場合だけ
`prereq\VC_redist.x64.exe` を実行してください（**ここだけ管理者権限が要ります**）。

---

## 3. 起動

```
1. C:\kidspg\ai\ComfyUI\start-comfyui.bat      ← ComfyUI（AI変換）。開いたままにする
2. C:\kidspg\app\start-kidspg.bat /dryrun      ← 点検だけ。[警告] が無いことを見る
3. C:\kidspg\app\start-kidspg.bat              ← アプリ起動
```

`start-kidspg.bat` は ComfyUI が止まっていれば自分で起こすので、
慣れたら 3 だけで足ります。ComfyUI の初回起動はモデルの読み込みに数分かかります。

**終了は `C:\kidspg\app\stop-kidspg.bat`**（アプリの「終了」からでも止まります）。

---

## 4. 検証（当日を迎える前に必ず通す）

| # | 見るもの | 期待 |
|---|---|---|
| 1 | `C:\kidspg\bin\ImageMagick\magick -version` | ImageMagick 7 が表示される |
| 2 | ブラウザで `http://127.0.0.1:8188/system_stats` | JSON が返る |
| 3 | `ops\node\node.exe ops\tools\comfyui-smoke.cjs` | モデル4本が載っていて、1枚生成できる（CPU で約3分） |
| 4 | `app\start-kidspg.bat /dryrun` | **[警告] が0件** |
| 5 | 手で1プレイ通す | `app\results\<日時>\memorial_card_<日時>.png` ができる |
| 6 | ランキング画面 | いま作ったカードが並ぶ |

3 は次のように実行します（`ops\` の中で動かします）。

```
cd C:\kidspg\ops
node\node.exe tools\comfyui-smoke.cjs
```

> 5 で**カードはできるが絵がプレースホルダ**の場合、ゲームは動いていて AI 変換だけが
> 通っていません。`app\logs\comfyui.log` を見てください。
> **カードが1枚もできない**場合は ImageMagick です（検証1へ戻る）。

---

## 5. 当日のトラブル対応

| 症状 | 見るところ |
|---|---|
| アプリが起動しない・何も出ない | `start-kidspg.bat /dryrun` の [警告]。それでも出ないなら Smart App Control（上記） |
| カードが1枚もできない | ImageMagick。`bin\ImageMagick\magick.exe` があるか |
| 絵が全員同じプレースホルダ | ComfyUI が落ちている。`app\logs\comfyui.log` |
| 生成が間に合わない | `config.json` の `activeProfile` を `local_light` にして**アプリを再起動**（画質は落ちます） |
| 前回終了しきれず起動できない | `stop-kidspg.bat` を実行してから起動。`start-kidspg.bat` も残ったプロセスを片付けます |
| この子の絵を作り直したい | 該当の結果フォルダの `再生成.bat`。無ければ `ops` で `node\node.exe tools\place-regen-bat.cjs --apply` |
| 個人写真を消したい（後片付け） | `ops` で `node\node.exe tools\purge-photos.cjs`（既定は消さずに一覧表示。消すのは `--apply`） |

### 持ち帰るもの

**`C:\kidspg\app\results\` だけ**です。ここに写真・AI画像・カード・`results.json` が
すべて入っています。⚠️ **生の顔写真（`photo_<日時>.png`）が含まれます。**
公開用に配るときは `ops` の `purge-photos.cjs` で写真だけ落としてください。
