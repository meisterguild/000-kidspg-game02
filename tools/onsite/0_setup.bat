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
for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command "try{ [int]((Get-PSDrive %TDRIVE%).Free/1GB) }catch{ -1 }"`) do set "FREE_GB=%%A"
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
rem /R:2 /W:2 : USB の一時的な失敗で止まらない程度に再試行する
if defined DRYRUN (
  echo        ＊ 確認のみモードなのでコピーしません
) else (
  echo        %~dp0payload  ==^>  %TARGET%
  echo        （数GBあります。10分ほどかかることがあります）
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
set "HASH_BAD="
for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-copy.ps1" -SumFile "%~dp0SHA256SUMS" -Target "%TARGET%"`) do set "HASH_BAD=%%A"
if not defined HASH_BAD (
  echo        [注意] 照合を実行できませんでした
  set /a WARN+=1
  goto :hash_done
)
if "!HASH_BAD!"=="0" (
  echo        OK : すべて一致しました
) else (
  echo        [警告] 食い違い : !HASH_BAD! 件。コピーが不完全か壊れています。
  echo               もう一度このバッチを実行してください。
  set /a WARN+=1
)
:hash_done
echo.

rem ------------------------------------------------------------
echo [5/6] 検証
set "MAGICK=%TARGET%\bin\ImageMagick\magick.exe"
if exist "!MAGICK!" (
  for /f "tokens=*" %%V in ('"!MAGICK!" -version 2^>nul ^| findstr /i "ImageMagick"') do (
    if not defined MAGICK_VER set "MAGICK_VER=%%V"
  )
  echo        OK : ImageMagick  !MAGICK_VER!
) else (
  echo        [警告] ImageMagick がありません : !MAGICK!
  echo               記念カードが1枚も作られません。
  set /a WARN+=1
)

if exist "%TARGET%\ops\node\node.exe" (
  for /f "tokens=*" %%V in ('"%TARGET%\ops\node\node.exe" -v 2^>nul') do echo        OK : Node  %%V
) else (
  echo        [注意] Node の携帯版がありません。当日の作り直しツールが使えません。
  set /a WARN+=1
)

if exist "%TARGET%\ai\python_embeded\python.exe" (
  for /f "tokens=*" %%V in ('"%TARGET%\ai\python_embeded\python.exe" -V 2^>^&1') do echo        OK : Python  %%V
) else (
  echo        [警告] 埋め込み Python がありません。AI 変換が使えません。
  set /a WARN+=1
)

if exist "%TARGET%\ai\ComfyUI\main.py" (
  echo        OK : ComfyUI 本体があります
) else (
  echo        [警告] ComfyUI 本体がありません。AI 変換が使えません。
  set /a WARN+=1
)
echo.

rem ------------------------------------------------------------
:summary
echo ============================================================
if defined STOP (
  echo   セットアップを中止しました。上の [中止] を見てください。
) else (
  echo [6/6] まとめ
  if "!WARN!"=="0" (
    echo   点検 : 問題は見つかりませんでした。
  ) else (
    echo   点検 : 気になる点が !WARN! 件あります（上の [注意] [警告]）。
  )
  echo.
  echo   このあとやること
  echo     1. Windows の設定を当日向けにする（1_当日手順書.md の「人がやること」）
  echo        ・カメラのプライバシー設定を ON
  echo        ・スリープと画面オフを「なし」に
  echo        ・音量とスピーカーの確認
  echo     2. %TARGET%\ai\ComfyUI\start-comfyui.bat を実行して ComfyUI を起こす
  echo        （初回はモデルの読み込みに数分かかります）
  echo     3. %TARGET%\app\start-kidspg.bat /dryrun で点検し、[警告] が無いことを見る
  echo     4. %TARGET%\app\start-kidspg.bat でアプリを起動し、1プレイ通す
  echo        results\^<日時^>\memorial_card_*.png ができれば成功です
)
echo ============================================================
echo.
pause
exit /b 0
