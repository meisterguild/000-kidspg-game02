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
if "%KIDSPG_BOOT%"=="1" goto :main
set "KIDSPG_BOOT=1"
if not "%KIDSPG_BOOT%"=="1" goto :noenv
cmd /d /c ""%~f0" %*"
exit /b %errorlevel%
:noenv
echo [ERROR] Could not set an environment variable. Aborted.
pause
exit /b 1

:main
setlocal enabledelayedexpansion
title KidsPG AIグミパク - 停止
cd /d "%~dp0"

rem ============================================================
rem  KidsPG「AIグミパク！」 停止用バッチ
rem
rem  アプリの「終了」で閉じたあと、プロセスが残っていないかを確かめて落とす。
rem  落とす順番（見つかったものだけ）
rem    1. アプリ本体
rem    2. 開発起動の Electron / Vite（npm run electron:dev を使ったとき）
rem    3. ComfyUI（AI画像変換）
rem    4. ImageMagick の残骸（カード合成が途中で止まったとき）
rem
rem  まず「閉じてください」と頼み、5秒待って残っていれば強制終了します。
rem
rem  ComfyUI は残したいとき（アプリだけ入れ直すときなど）:
rem      stop-kidspg.bat /keepcomfy
rem ============================================================

set "KEEPCOMFY="
if /i "%~1"=="/keepcomfy" set "KEEPCOMFY=1"

rem 🔴 **フォルダ名では絞りが甘い。** 当日の置き場所は C:\kidspg\app なので
rem    フォルダ名は "app" になり、'*app*' は**無関係な Electron アプリにほぼ全部
rem    当たる**（ほとんどの Electron アプリは --app-path= を持つ）。実測では
rem    この開発機で無関係な electron.exe が 3 件一致した。当たると
rem      ・それらを taskkill /PID → 5 秒後に /F /T で落とす
rem      ・最後の「残っているものの確認」も同じ条件なので、正しく止め切っても
rem        「残っています」と出続ける（誤った失敗報告）
rem    start-kidspg.bat は同じ欠陥をフルパス照合に直してあるのに、こちらだけ
rem    直っていなかった（敵対的レビュー 2026-09-09 の指摘）。フルパスで照合する。
for %%I in ("%~dp0.") do set "APPDIR=%%~fI"
rem 🔴 **自己除外は「照会プロセスを外す」でやる。**
rem    以前ここで `$PID` の親を取って SELFPID にしていたが、`for /f` の
rem    バッククォートは cmd.exe /c powershell … を挟むので `$PID` の親は
rem    **その一時 cmd.exe** で、取得直後には既に消えている（実測）。
rem    「自分の PID とその親も外す」は成立していなかった。
rem    実際に効いているのは条件側の `-notlike '*Win32_Process*'`——
rem    照会に使う PowerShell のコマンド行には必ずこの語が載るので、
rem    条件に 'start-comfyui' のような文字列を入れても自分に一致しない。
rem    ⚠️ PID を数字で外す形は、再利用された PID が実対象に当たると
rem    **黙って落とさず、残存確認も同じ条件なので「なし」と誤報する**ので使わない。
rem 表示用（人が読む見出しだけに使う）
for %%I in ("%~dp0.") do set "PROJ=%%~nxI"

echo ============================================================
echo   KidsPG「AIグミパク！」 停止
echo   %date% %time:~0,8%
echo ============================================================
echo.

echo [1/4] アプリ本体
call :stop_group "$_.Name -like 'KidsPG*' -or $_.ExecutablePath -like '*win-unpacked*'"
echo.

rem Electron 本体で起動した場合（Smart App Control が有効なPCではこちらが本番）と、
rem 開発起動（npm run electron:dev）の Vite が対象。どちらもこのフォルダ名で見分ける。
echo [2/4] Electron 起動ぶん / 開発用 Vite（%APPDIR%）
call :stop_group "($_.Name -eq 'electron.exe' -or $_.Name -eq 'node.exe') -and $_.CommandLine -like '*%APPDIR%*'"
echo.

echo [3/4] ComfyUI（AI画像変換）
if defined KEEPCOMFY (
  echo        ＊ /keepcomfy が指定されたので触りません
) else (
  rem 🔴 **監視ループを先に止める。** ComfyUI の起動経路は2つあり、
  rem    start-comfyui.bat（当日手順書の検証1で「開いたままにする」と指示して
  rem    いるもの／アプリの［ComfyUI を起動］ボタン）は
  rem    **落ちたら 5 秒後に上げ直す cmd の監視ループ**を持っている。
  rem    python だけ落とすと ping -n 6 のあとに ComfyUI が復活し、
  rem    しかも「残っているものの確認」は復活前に走るので
  rem    「なし（すべて終了しています）」と誤報していた
  rem    （敵対的レビュー 2026-09-09 の指摘）。
  echo        監視ループ（start-comfyui.bat）
  call :stop_group "($_.Name -eq 'cmd.exe' -or $_.Name -eq 'powershell.exe') -and $_.CommandLine -like '*start-comfyui*'"
  echo        ComfyUI 本体
  call :stop_group "$_.Name -eq 'python.exe' -and $_.CommandLine -like '*ComfyUI*' -and $_.CommandLine -like '*main.py*'"
  rem 監視ループが ping で待っている隙に上げ直していないかを見る。
  rem 5 秒待って、まだ居たらもう一度落とす
  ping -n 7 127.0.0.1 > nul
  call :stop_group "$_.Name -eq 'python.exe' -and $_.CommandLine -like '*ComfyUI*' -and $_.CommandLine -like '*main.py*'"
)
rem 起動中の印も片付ける（残ると start-kidspg.bat が ComfyUI を起こさなくなる）
if exist "%~dp0logs\comfy-starting.flag" (
  del /f /q "%~dp0logs\comfy-starting.flag" > nul 2>&1
  echo        ComfyUI 起動中の印も片付けました
)
echo.

echo [4/4] ImageMagick の残骸
call :stop_group "$_.Name -eq 'magick.exe'"
echo.

rem ------------------------------------------------------------
rem  「準備OK」の印を片付ける。
rem
rem  このバッチは強制終了なので、アプリ側の終了処理（before-quit で消す）は
rem  走らない。残しておくと**止まっているのに準備完了に見える**フォルダになる。
rem  起動バッチは起こす直前に必ず消すので実害は無いが、人が見て誤解する。
rem ------------------------------------------------------------
rem 印の置き場所は起動の仕方で変わる（start-kidspg.bat の READY_FILE と同じ）。
rem electron 起動ならこのフォルダの logs\、exe 起動なら exe の隣の logs\。
rem 片方しか消さないと、もう片方に古い印が残る
rem （いま exe は作らない方針なので実害は無いが、条件を揃えておく）。
for %%R in ("%~dp0logs\ready.json" "%~dp0release\win-unpacked\logs\ready.json") do (
  if exist "%%~fR" (
    del /f /q "%%~fR" > nul 2>&1
    echo        準備OKの印を片付けました : %%~fR
  )
)
echo.

rem ------------------------------------------------------------
echo ------------------------------------------------------------
echo 残っているものの確認
rem /keepcomfy のときは ComfyUI を「残っているもの」に数えない（意図して残しているため）
rem ⚠️ 条件は上の停止と**同じもの**にする。片方だけ直すと
rem    「止め切ったのに残っていると出る」「残っているのに無しと出る」が起きる
set "PYCOND= -or ($_.Name -eq 'python.exe' -and $_.CommandLine -like '*ComfyUI*main.py*') -or (($_.Name -eq 'cmd.exe' -or $_.Name -eq 'powershell.exe') -and $_.CommandLine -like '*start-comfyui*')"
if defined KEEPCOMFY set "PYCOND="
set "LEFT="
for /f "usebackq tokens=*" %%L in (`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -like 'KidsPG*' -or $_.ExecutablePath -like '*win-unpacked*'%PYCOND% -or $_.Name -eq 'magick.exe' -or (($_.Name -eq 'electron.exe' -or $_.Name -eq 'node.exe') -and $_.CommandLine -like '*%APPDIR%*')) -and $_.CommandLine -notlike '*Win32_Process*' } | ForEach-Object { $_.Name + '  PID=' + $_.ProcessId }"`) do (
  set "LEFT=1"
  echo        残っています : %%L
)
if not defined LEFT echo        なし（すべて終了しています）
if defined KEEPCOMFY echo        ＊ ComfyUI は動いたままです（/keepcomfy）
echo.

echo ============================================================
echo   強制終了した場合の注意
echo     カードの合成中だった回があっても、書きかけのファイルは
echo     次回起動時の点検で自動的に片付けられます（救済または削除）。
echo     それでも足りないときは  node tools\retry-failed.cjs --apply  を実行してください。
echo ============================================================
echo.
pause
endlocal
exit /b 0

rem ------------------------------------------------------------
rem  %~1 に渡した PowerShell の条件式に合うプロセスを止める
rem ------------------------------------------------------------
:stop_group
set "FILTER=%~1"
set "PIDS="
rem 🔴 **自分自身を巻き込まない。** 条件に 'start-comfyui' のような文字列を書くと、
rem    その条件を実行している powershell.exe のコマンド行にその文字列が載るので
rem    **自分が一致する**（2026-09-09 に実測。確認側が「残っています :
rem    powershell.exe」を永久に出し、停止側は自分を taskkill しかけた）。
rem    照会プロセスは必ず Win32_Process を含むので、それで外す。
rem    自分の PID とその親も念のため外す。
for /f "usebackq tokens=*" %%P in (`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { (%FILTER%) -and $_.CommandLine -notlike '*Win32_Process*' } | ForEach-Object { $_.ProcessId }"`) do set "PIDS=!PIDS! %%P"
if not defined PIDS (
  echo        なし
  exit /b 0
)
echo        見つかりました : PID!PIDS!
for %%P in (!PIDS!) do (
  taskkill /PID %%P > nul 2>&1
)
echo        終了を待っています（5秒）
ping -n 6 127.0.0.1 > nul
for %%P in (!PIDS!) do call :kill_hard %%P
exit /b 0

rem ------------------------------------------------------------
rem  まだ生きていれば強制終了する
rem ------------------------------------------------------------
:kill_hard
set "ALIVE="
for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command "if(Get-Process -Id %1 -ErrorAction SilentlyContinue){'ALIVE'}"`) do set "ALIVE=%%A"
if not defined ALIVE (
  echo        終了しました : PID %1
  exit /b 0
)
taskkill /F /T /PID %1 > nul 2>&1
if errorlevel 1 (
  echo        [警告] 落とせませんでした : PID %1 （管理者として実行してみてください）
) else (
  echo        強制終了しました : PID %1
)
exit /b 0
