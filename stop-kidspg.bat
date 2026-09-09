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

rem このフォルダの名前を、開発用プロセスの見分けに使う
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
echo [2/4] Electron 起動ぶん / 開発用 Vite（%PROJ%）
call :stop_group "($_.Name -eq 'electron.exe' -or $_.Name -eq 'node.exe') -and $_.CommandLine -like '*%PROJ%*'"
echo.

echo [3/4] ComfyUI（AI画像変換）
if defined KEEPCOMFY (
  echo        ＊ /keepcomfy が指定されたので触りません
) else (
  call :stop_group "$_.Name -eq 'python.exe' -and $_.CommandLine -like '*ComfyUI*' -and $_.CommandLine -like '*main.py*'"
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
if exist "%~dp0logs\ready.json" (
  del /f /q "%~dp0logs\ready.json" > nul 2>&1
  echo        準備OKの印（logs\ready.json）を片付けました
  echo.
)

rem ------------------------------------------------------------
echo ------------------------------------------------------------
echo 残っているものの確認
rem /keepcomfy のときは ComfyUI を「残っているもの」に数えない（意図して残しているため）
set "PYCOND= -or ($_.Name -eq 'python.exe' -and $_.CommandLine -like '*ComfyUI*main.py*')"
if defined KEEPCOMFY set "PYCOND="
set "LEFT="
for /f "usebackq tokens=*" %%L in (`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'KidsPG*' -or $_.ExecutablePath -like '*win-unpacked*'%PYCOND% -or $_.Name -eq 'magick.exe' -or (($_.Name -eq 'electron.exe' -or $_.Name -eq 'node.exe') -and $_.CommandLine -like '*%PROJ%*') } | ForEach-Object { $_.Name + '  PID=' + $_.ProcessId }"`) do (
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
for /f "usebackq tokens=*" %%P in (`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { %FILTER% } | ForEach-Object { $_.ProcessId }"`) do set "PIDS=!PIDS! %%P"
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
