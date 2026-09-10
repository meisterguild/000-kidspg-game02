@echo off
rem ---------------------------------------------------------------
rem  ASCII-only bootstrap. DO NOT put Japanese text above ":main".
rem  A Japanese (CP932) console mis-parses this UTF-8 file: some
rem  characters contain bytes like 0x7C '|' or 0x26 '&' in their
rem  second byte, so cmd would split the lines and run garbage.
rem  Switch the console to UTF-8 first, then re-run this same file
rem  in a child cmd so that it is parsed as UTF-8 from the start.
rem ---------------------------------------------------------------
chcp 65001 > nul
if "%KIDSPG_SETUP_BOOT%"=="1" goto :main
set "KIDSPG_SETUP_BOOT=1"
if not "%KIDSPG_SETUP_BOOT%"=="1" goto :noenv
cmd /d /c ""%~f0" %*"
exit /b %errorlevel%
:noenv
echo [ERROR] Could not set an environment variable. Aborted.
pause
exit /b 1

:main
setlocal enabledelayedexpansion
title KidsPG AIグミパク - 当日PCのセットアップ
cd /d "%~dp0"

rem ============================================================
rem  KidsPG「AIグミパク！」 当日PCのセットアップ
rem
rem  やること
rem    1. 事前点検（payload・空き容量・置き場所・VC++ ランタイム）
rem    2. USB 由来のブロック解除
rem    3. コピー（results と logs は消さない）
rem    4. 置き場所の確認（config.json の中の絶対パスと合っているか）
rem    5. 検証（ImageMagick / Node / 埋め込み Python / ComfyUI）
rem    6. まとめ
rem
rem  ＊ インストール操作はしません。すべてコピーと展開だけで済みます。
rem     （例外は VC++ ランタイムが無かった場合だけ。案内を出します）
rem
rem  確認のみ（何も書き換えない）:  0_セットアップ.bat /dryrun
rem  別の場所へ入れたい:            set KIDSPG_TARGET=D:\kidspg
rem                                 ただし config.json の中の絶対パスと
rem                                 食い違うので、パッケージを
rem                                 --target D:\kidspg で作り直すこと
rem ============================================================

set "DRYRUN="
if /i "%~1"=="/dryrun" set "DRYRUN=1"

rem 🔴 %PS% は使う前に定義する。以前は未定義のまま
rem   for /f ... in (`%PS% -Command "..."`) を書いており、
rem   "'-Command' is not recognized..." という英語のエラーが出たうえで
rem   --app-only パッケージの検出（安全網）が**完全に死んでいた**
rem   （敵対的レビュー 2026-09-09 の指摘）。
set "PS=powershell -NoProfile -ExecutionPolicy Bypass"

set "TARGET=%KIDSPG_TARGET%"
if not defined TARGET set "TARGET=C:\kidspg"

set "WARN=0"
set "STOP="

echo ============================================================
echo   KidsPG「AIグミパク！」 当日PCのセットアップ
echo   %date% %time:~0,8%
echo   USB       : %~dp0
echo   入れる先  : %TARGET%
if defined DRYRUN echo   ＊ 確認のみモード（何も書き換えません）
echo ============================================================
echo.

rem ------------------------------------------------------------
echo [1/6] 事前点検
if not exist "%~dp0payload\app\package.json" (
  echo        [中止] payload\app が見つかりません。
  echo               USB の中身が揃っていません。コピーし直してください。
  set "STOP=1"
  goto :summary
)
echo        OK : payload があります

rem --- パッケージがどの置き場所を前提に作られているか
set "PKG_TARGET="
for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command "try{ (Get-Content -Raw -Encoding UTF8 '%~dp0manifest.json' | ConvertFrom-Json).target }catch{ '' }"`) do set "PKG_TARGET=%%A"
rem 🔴 --app-only で作ったパッケージ（ai / bin / ops\node が入っていない）は
rem 当日使えない。以前は ImageMagick と Python が [警告] になるだけで通っていた
rem （敵対的レビュー 2026-09-09 の指摘）。manifest を見て止める。
set "PKG_APPONLY="
for /f "usebackq tokens=*" %%A in (`%PS% -Command "try{ if((Get-Content -Raw -Encoding UTF8 '%~dp0manifest.json' | ConvertFrom-Json).appOnly){'1'} }catch{ '' }"`) do set "PKG_APPONLY=%%A"
if "!PKG_APPONLY!"=="1" (
  echo        [中止] このパッケージは --app-only で作られています（反復用）。
  echo               ComfyUI・モデル・ImageMagick・Node が入っていないため
  echo               当日は使えません。開発機で作り直してください:
  echo                 node tools\make-onsite-package.cjs --out ^<出力先^>
  set "STOP=1"
  goto :summary
)

if defined PKG_TARGET (
  echo        このパッケージの前提 : !PKG_TARGET!
  if /i not "!PKG_TARGET!"=="%TARGET%" (
    echo        [中止] 入れる先がパッケージの前提と違います。
    echo               config.json の中の ComfyUI の絶対パスが !PKG_TARGET! を指しているため、
    echo               このまま入れても AI 変換が動きません。
    echo               どちらかにしてください:
    echo                 ・入れる先を !PKG_TARGET! にする
    echo                 ・パッケージを  --target %TARGET%  で作り直す
    set "STOP=1"
    goto :summary
  )
  echo        OK : 入れる先と一致しています
) else (
  echo        [注意] manifest.json を読めませんでした。前提の照合を飛ばします。
  set /a WARN+=1
)

rem --- 空き容量（payload は 7GB 前後。余裕を見て 15GB を要求する）
rem PowerShell の1行は短く保つ。bat の中で入れ子の引用符が増えるほど、
rem 「動くのに何も返ってこない」壊れ方をして原因が見えなくなる。
set "TDRIVE=%TARGET:~0,1%"
rem 🔴 **未初期化のまま比較しない。** for /f が1行も返さないと FREE_GB は
rem    未定義になり、`if  LSS 15` が文字列比較（"" LSS "15" → 真）になって
rem    空き容量が十分でも警告が出る。同じ穴は start-kidspg.bat 側では
rem    塞いだのに、ここだけ揃っていなかった（敵対的レビュー 2026-09-09 の指摘）。
set "FREE_GB=-1"
for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command "try{ [int]((Get-PSDrive %TDRIVE%).Free/1GB) }catch{ -1 }"`) do set "FREE_GB=%%A"
if not defined FREE_GB set "FREE_GB=-1"
if "!FREE_GB!"=="-1" (
  echo        [注意] 空き容量を確かめられませんでした
  set /a WARN+=1
) else (
  echo        空き容量  : !FREE_GB! GB
  if !FREE_GB! LSS 15 (
    echo        [警告] 15GB 以上あることを確認してください。
    echo               当日は results\ に写真とカードが溜まり続けます。
    set /a WARN+=1
  )
)

rem --- すでに入っている場合（results を消さないことを伝える）
if exist "%TARGET%\app\package.json" (
  echo        [注意] すでに %TARGET% に入っています。上書きします。
  echo               results\ と logs\ は消しません（当日の成果物を守るため）。
  set /a WARN+=1
)

rem --- VC++ ランタイム（torch が要求する。これだけはインストールが要る）
set "VCOK="
if exist "%SystemRoot%\System32\vcruntime140.dll" set "VCOK=1"
if exist "%SystemRoot%\System32\vcruntime140_1.dll" set "VCOK=1"
if defined VCOK (
  echo        OK : VC++ ランタイムがあります
) else (
  echo        [警告] VC++ 2015-2022 ランタイムが見つかりません。ComfyUI が起動しません。
  if exist "%~dp0prereq\VC_redist.x64.exe" (
    echo               同梱の prereq\VC_redist.x64.exe を実行してください（管理者が必要）。
  ) else (
    echo               https://aka.ms/vs/17/release/vc_redist.x64.exe から入れてください。
  )
  set /a WARN+=1
)
echo.

rem ------------------------------------------------------------
echo [2/6] ブロック解除（USB 由来のファイルに付く印を外す）
rem ダウンロード経由で受け取った場合、ファイルに「別の場所から来た」印
rem （Zone.Identifier）が付き、Electron の起動が SmartScreen に止められる。
rem USB のコピーでは通常付かないが、付いていても困らないよう毎回外す。
if defined DRYRUN (
  echo        ＊ 確認のみモードなので外しません
) else (
  powershell -NoProfile -Command "Get-ChildItem -Recurse -File '%~dp0payload' -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue" 2>nul
  echo        OK : 外しました
)
echo.

rem ------------------------------------------------------------
echo [3/6] コピー
rem /E   : 空のフォルダも含めて丸ごと。/MIR は使わない
rem        （出力先を鏡にするので、当日の results\ を消してしまう）
rem /XD  : results と logs は触らない
rem 🔴 config.json は**当日書き換わっている可能性がある**。設定画面から
rem    保存できるうえ、手順書の退避策も「activeProfile を local_light にして
rem    アプリを再起動」と指示している。/E は同名を上書きするので、
rem    コピー不良でこのバッチをもう一度走らせると
rem      ・照合が「app/config.json の食い違い 1 件」を報告して誤誘導し
rem      ・当日の設定変更を**黙って元に戻す**
rem    という2つが同時に起きていた（敵対的レビュー 2026-09-09 の指摘）。
rem    退避してから上書きし、どこに退避したかを必ず言う。
rem /R:2 /W:2 : USB の一時的な失敗で止まらない程度に再試行する
if defined DRYRUN (
  echo        ＊ 確認のみモードなのでコピーしません
) else (
  echo        %~dp0payload  ==^>  %TARGET%
  echo        （数GBあります。10分ほどかかることがあります）
  rem 当日の設定を上書きする前に退避する（上の注釈）。
  rem 中身が同じなら退避しない（毎回ファイルが増えると当日見づらい）。
  if exist "%TARGET%\app\config.json" (
    fc /b "%TARGET%\app\config.json" "%~dp0payload\app\config.json" > nul 2>&1
    if errorlevel 1 (
      rem 🔴 退避名を固定にしない。2回目の実行で**初回の退避内容を上書き**する。
      rem    当日の設定を守るために作った分岐が、逆に守れなくなる
      rem    （敵対的レビュー 2026-09-09 の指摘）。
      for /f "usebackq tokens=*" %%T in (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"`) do set "CFG_STAMP=%%T"
      if not defined CFG_STAMP set "CFG_STAMP=unknown"
      set "CFG_BACKUP=%TARGET%\app\config.json.before-setup-!CFG_STAMP!"
      rem 成否は copy の終了コードで見る（if exist だと、古い退避が残っていた
      rem 場合にコピー失敗でも「退避しました」と出てしまう）
      copy /y "%TARGET%\app\config.json" "!CFG_BACKUP!" > nul 2>&1
      if not errorlevel 1 (
        echo        ＊ 当日の config.json は書き換わっています。上書きする前に退避しました:
        echo             !CFG_BACKUP!
        echo           退避策（入力解像度を 320 に下げた等）を続けたい場合は、
        echo           このファイルを config.json へ戻してください。
      ) else (
        echo        [警告] config.json を退避できませんでした。上書きすると
        echo               当日の設定変更が失われます。中止して手で控えてください。
        set "STOP=1"
        goto :summary
      )
    )
  )
  robocopy "%~dp0payload" "%TARGET%" /E /XD results logs /NFL /NDL /NJH /R:2 /W:2
  rem robocopy は成功でも 0〜7 を返す。8 以上が本当の失敗
  if errorlevel 8 (
    echo        [中止] コピーに失敗しました。
    echo               USB の抜け・空き容量・ウイルス対策の妨害を確認してください。
    set "STOP=1"
    goto :summary
  )
  if not exist "%TARGET%\app\results" mkdir "%TARGET%\app\results"
  if not exist "%TARGET%\app\logs" mkdir "%TARGET%\app\logs"
  echo        OK : コピーしました
)
echo.

rem ------------------------------------------------------------
echo [4/6] コピーの照合（SHA256SUMS）
rem 「else if」の連鎖は cmd では書き方によって黙って外れるので使わない。
rem 飛ばす条件は goto で分ける。
if not exist "%~dp0SHA256SUMS" (
  echo        [注意] SHA256SUMS がありません。照合を飛ばします。
  set /a WARN+=1
  goto :hash_done
)
if defined DRYRUN (
  echo        ＊ 確認のみモードなので照合しません
  goto :hash_done
)
echo        照合中です（数分かかります）…
rem 照合そのものは別ファイルの PowerShell に任せる。bat の中に長い1行を
rem 埋めると、入れ子の引用符で「動くのに何も返ってこない」壊れ方をする。
rem 結果は2つに分かれる（verify-copy.ps1 の注釈）。
rem   COPIED … コピー先（%TARGET%）の食い違い → 対処は「もう一度実行」
rem   MEDIA  … USB 側（prereq / bat / 手順書）の食い違い → 対処は「USB を作り直す」
rem 分けないと、当日「やり直しても直らない」ものに対してやり直しを促してしまう。
set "HASH_BAD="
set "HASH_MEDIA="
set "HASH_UNREAD="
for /f "usebackq tokens=1,* delims==" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-copy.ps1" -SumFile "%~dp0SHA256SUMS" -Target "%TARGET%"`) do (
  if /i "%%A"=="COPIED" set "HASH_BAD=%%B"
  if /i "%%A"=="MEDIA" set "HASH_MEDIA=%%B"
  if /i "%%A"=="UNREAD" set "HASH_UNREAD=%%B"
)
rem 目録そのものが壊れていた（0バイト・途中で切れている）
if "!HASH_BAD!"=="-1" (
  echo        [警告] SHA256SUMS が壊れています（中身が空です）。
  echo               照合できないので、コピー漏れを見つけられません。
  echo               USB を作り直してください。
  set /a WARN+=1
  goto :hash_done
)
if not defined HASH_BAD (
  echo        [注意] 照合を実行できませんでした
  set /a WARN+=1
  goto :hash_done
)
if "!HASH_BAD!"=="0" (
  if defined HASH_UNREAD if "!HASH_UNREAD!"=="0" echo        OK : コピーはすべて一致しました
  if defined HASH_UNREAD if not "!HASH_UNREAD!"=="0" echo        読めたぶんは一致しました（読めなかったものは下の [警告]）
) else (
  echo        [警告] 食い違い : !HASH_BAD! 件。コピーが不完全か壊れています。
  echo               まず**もう一度このバッチを実行**してください。
  echo               それでも同じ件数が出る場合は USB 側が壊れているので、
  echo               開発機でパッケージを作り直してください。
  set /a WARN+=1
)
rem 読めなかったファイルがあると「一致した」とは言えない
if defined HASH_UNREAD if not "!HASH_UNREAD!"=="0" (
  echo        [警告] !HASH_UNREAD! 件のファイルを読めませんでした（排他・スキャン中）。
  echo               ウイルス対策の初回スキャンが終わるのを待ってから、
  echo               もう一度このバッチを実行してください。
  set /a WARN+=1
)
if not defined HASH_MEDIA goto :hash_done
if "!HASH_MEDIA!"=="0" goto :hash_done
echo        [警告] USB 側のファイルが !HASH_MEDIA! 件壊れています
echo               （prereq\VC_redist.x64.exe・手順書・バッチなど）。
echo               これは**やり直しても直りません**。USB を作り直してください。
set /a WARN+=1
:hash_done
echo.

rem ------------------------------------------------------------
echo [5/6] 検証
set "MAGICK=%TARGET%\bin\ImageMagick\magick.exe"
rem 🔴 携帯版 ImageMagick は**コーダー DLL（PNG などを読み書きする部品）の
rem    置き場をレジストリから引く**。インストーラがそのキーを書くためで、
rem    フォルダをコピーしただけのこのPCにはキーが無い。その状態だと
rem      magick.exe: RegistryKeyLookupFailed `CoderModulesPath'
rem      magick.exe: no decode delegate for this image format `...png'
rem    となり、**記念カードが1枚も作られない**（当日PCで実測 2026-09-10）。
rem    しかも "magick -version" はコーダーを読まないので**通ってしまう**ため、
rem    「★★★ 準備完了 ★★★」と表示していた。置き場を教え、実際に PNG を書かせる。
set "IMDIR=%TARGET%\bin\ImageMagick"
if exist "!IMDIR!\modules\coders" set "MAGICK_CODER_MODULE_PATH=!IMDIR!\modules\coders"
if exist "!IMDIR!\modules\filters" set "MAGICK_FILTER_MODULE_PATH=!IMDIR!\modules\filters"
if exist "!IMDIR!\colors.xml" set "MAGICK_CONFIGURE_PATH=!IMDIR!"
set "MAGICK_HOME=!IMDIR!"

if not exist "!MAGICK!" goto :magick_missing
"!MAGICK!" -size 4x4 xc:white PNG:- > nul 2>&1
if errorlevel 1 goto :magick_no_png
rem ⚠️ 引用符を4個（"!MAGICK!" と "ImageMagick"）にすると cmd の引用符処理で
rem for /f が**必ず空**になる（実測）。findstr を挟まず、1行目だけを取る。
for /f "usebackq tokens=*" %%V in (`"!MAGICK!" -version 2^>nul`) do (
  if not defined MAGICK_VER set "MAGICK_VER=%%V"
)
if not defined MAGICK_VER goto :magick_no_version
echo        OK : ImageMagick  !MAGICK_VER!
echo        OK : PNG を書けました
goto :magick_done

:magick_missing
echo        [警告] ImageMagick がありません : !MAGICK!
echo               記念カードが1枚も作られません。
set "MISSING_CORE=1"
set /a WARN+=1
goto :magick_done

:magick_no_png
echo        [警告] ImageMagick はありますが PNG を扱えません : !MAGICK!
echo               記念カードが1枚も作られません。
echo               携帯版はコーダーの置き場が要ります。
echo               bin\ImageMagick\modules\coders があるか確認してください。
set "MISSING_CORE=1"
set /a WARN+=1
goto :magick_done

:magick_no_version
echo        [警告] magick.exe はありますが版数を取れません : !MAGICK!
echo               VC++ ランタイム、または Smart App Control のブロックを疑ってください。
set "MISSING_CORE=1"
set /a WARN+=1

:magick_done

rem Node は当日PCではこれ1つだけ（PATH には無い）。無い／起動できないと
rem 作り直し（再生成.bat）と、当日手順書の検証4（comfyui-smoke）が動かない。
rem 以前は [注意] にしていたが、他の実行ファイルと同じ [警告] に揃える
rem （敵対的レビュー 2026-09-09 の指摘）。
if exist "%TARGET%\ops\node\node.exe" (
  for /f "tokens=*" %%V in ('"%TARGET%\ops\node\node.exe" -v 2^>nul') do (
    if not defined NODE_VER set "NODE_VER=%%V"
  )
  if defined NODE_VER (
    echo        OK : Node  !NODE_VER!
  ) else (
    echo        [警告] node.exe はありますが起動できません。
    echo               作り直しツールと、当日手順書の検証4が使えません。
    echo               Smart App Control のブロックを疑ってください。
    set /a WARN+=1
  )
) else (
  echo        [警告] Node の携帯版がありません。当日の作り直しツールが使えません。
  set /a WARN+=1
)

if exist "%TARGET%\ai\python_embeded\python.exe" (
  for /f "tokens=*" %%V in ('"%TARGET%\ai\python_embeded\python.exe" -V 2^>^&1') do (
    if not defined PY_VER set "PY_VER=%%V"
  )
  if defined PY_VER (
    echo        OK : Python  !PY_VER!
  ) else (
    echo        [警告] python.exe はありますが起動できません。AI 変換が使えません。
    echo               Smart App Control のブロックを疑ってください。
    set /a WARN+=1
  )
) else (
  echo        [警告] 埋め込み Python がありません。AI 変換が使えません。
  set /a WARN+=1
)

if exist "%TARGET%\ai\ComfyUI\main.py" (
  echo        OK : ComfyUI 本体があります
) else (
  echo        [警告] ComfyUI 本体がありません。AI 変換が使えません。
  set "MISSING_CORE=1"
  set /a WARN+=1
)

rem 🔴 **モデル4本（合計 4.1GB）を確かめる。** ここはいちばんコピーが
rem    失敗しやすいのに、以前は1つも見ていなかった。SHA256SUMS があれば
rem    拾えるが、無い場合（--no-hash で作った等）は
rem    「照合を飛ばします」の注意1件だけで通り、
rem    **当日1枚目の生成で初めて分かる**状態だった
rem    （敵対的レビュー 2026-09-09 の指摘）。
set "MODEL_MISSING=0"
for %%M in (
  "checkpoints\DreamShaper_8_pruned.safetensors"
  "vae\sd-vae-ft-mse.safetensors"
  "controlnet\control_v11p_sd15_canny.safetensors"
  "loras\Hyper-SD15-8steps-CFG-lora.safetensors"
) do (
  if not exist "%TARGET%\ai\models\%%~M" (
    echo        [警告] モデルがありません : ai\models\%%~M
    set /a MODEL_MISSING+=1
  )
)
if "!MODEL_MISSING!"=="0" (
  echo        OK : モデル4本があります
) else (
  echo               AI 変換が使えません（カードの絵が全員同じになります）。
  set /a WARN+=1
)

if exist "%TARGET%\app\node_modules\electron\dist\electron.exe" (
  echo        OK : Electron 本体があります
) else (
  echo        [警告] Electron 本体がありません : app\node_modules\electron\dist\electron.exe
  echo               **ゲームが起動しません。**
  set "MISSING_CORE=1"
  set /a WARN+=1
)
echo.

rem ------------------------------------------------------------
:summary
echo ============================================================
rem 🔴 **括弧ブロックの中にラベルを置かないこと。**
rem    cmd は "( ... )" の中にラベルがあるとブロック全体を構文エラーにする
rem    （実測: ") was unexpected at this time." で終了コード 255）。
rem    以前ここを if/else の括弧で書いたまま :missing_core / :summary_done を
rem    足したため、**まとめ・警告・「このあとやること」・pause が1行も出ず、
rem    窓が即閉じて上の [警告] すら読めなかった**（敵対的レビュー 2026-09-09 の指摘）。
rem    このファイルの他の分岐と同じく goto で分ける。
if defined STOP goto :sum_stopped

echo [6/6] まとめ
if "!WARN!"=="0" (
  echo   点検 : 問題は見つかりませんでした。
) else (
  echo   点検 : 気になる点が !WARN! 件あります（上の [注意] [警告]）。
)
echo.

rem 🔴 **ゲームが動かない欠落があるときに「このあとやること」を出さない。**
rem    以前は ImageMagick / Electron / ComfyUI が全部無くても
rem    それぞれ [警告] を出すだけで、まとめは「気になる点が 4 件」と表示し、
rem    そのまま「暖機して再起動して ★★★ 準備完了 ★★★ を確かめる」という
rem    前向きな手順へ進んでいた（敵対的レビュー 2026-09-09 の指摘）。
rem    コピーが部分的に失敗した場合（ウイルス対策のブロックなど、robocopy が
rem    8 未満で返るケース）は中止にならないので、ここで受け止める。
if defined MISSING_CORE goto :sum_missing_core

echo   このあとやること
echo     1. Windows の設定を当日向けにする（1_当日手順書.md の「人がやること」）
echo        ・カメラのプライバシー設定を ON
echo        ・スリープと画面オフを「なし」に
echo        ・音量とスピーカーの確認
echo.
echo     2. 🔴 **インターネットに繋いだ状態で** %TARGET%\ウォームアップ.bat を実行する
echo        Windows 11 の Smart App Control は、署名の無いファイルを初めて読むとき
echo        クラウドへ判定を問い合わせ、返るまでブロックします。ComfyUI が読む
echo        .pyd は全部署名がないので、当日オフラインだとこれに当たり得ます。
echo        前日までに一度オンラインで読ませ、判定を取り切っておきます。
echo        ＊ SAC をオフにする必要はありません。
echo        ＊ ブロックが 0 件になるまで繰り返してください（数回かかることがあります）。
echo.
echo     3. 🔴 **インターネットに繋いだまま** %TARGET%\診断と修復.bat を実行し、
echo        ★★★ 問題は見つかりませんでした ★★★ が出ることを確かめる
echo        ウォームアップと起動バッチが書くのは 4x4 の PNG だけです。
echo        本物のカード土台の読み込み・合成の経路・そしてコーダーの隣へ
echo        足りない DLL を複製する修復は、ここでしか通りません
echo        （2026-09-10 の実機では、この修復でカードが作れるようになりました）。
echo        ＊ [NG] が出たらネットに繋いだまま繰り返してください。
echo        ＊ 会場でオフラインになってからでは取り返せません。
echo.
echo     4. インターネットを切り、**PCを再起動**する
echo.
echo     5. %TARGET%\app\start-kidspg.bat を実行し、
echo        ★★★ 準備完了 ★★★ が出ることを確かめる（これが当日の形）
echo.
echo     6. 1プレイ通し、results\^<日時^>\memorial_card_*.png ができれば成功です
goto :sum_done

:sum_stopped
echo   セットアップを中止しました。上の [中止] を見てください。
goto :sum_done

:sum_missing_core
echo   🔴 **このままでは当日ゲームが動きません。**
echo      上の [警告] のうち、次のどれかが出ています:
echo        ・ImageMagick が無い／起動できない  … 記念カードが1枚も作られません
echo        ・Electron 本体が無い              … ゲームが起動しません
echo        ・ComfyUI 本体が無い               … AI 変換が使えません
echo.
echo      やること
echo        1. USB がきちんと差さっているか確認し、**もう一度このバッチを実行**する
echo        2. それでも直らない場合、ウイルス対策ソフトがコピーを止めていないか見る
echo        3. 直らなければ開発機でパッケージを作り直してください
echo.
echo      ＊ Windows の設定や暖機は、これが直ってから行ってください。
goto :sum_done

:sum_done
echo ============================================================
echo.
pause
exit /b 0
