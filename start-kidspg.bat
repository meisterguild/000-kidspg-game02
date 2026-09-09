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
title KidsPG AIグミパク - 起動
cd /d "%~dp0"

rem ============================================================
rem  KidsPG「AIグミパク！」 起動用バッチ
rem
rem  やること
rem    1. 実行場所の点検（OneDrive 配下だとカード生成が失敗しうる）
rem    2. ImageMagick（記念カードの合成に必須）の確認
rem    3. アプリ本体（Electron 本体 + dist）の確認と、ビルドが古くないかの確認
rem    4. ComfyUI（AI画像変換）の確認と、止まっていれば起動
rem    5. 二重起動の確認
rem    6. アプリ起動
rem
rem  動作確認だけしたいとき（何も起動しない）:  start-kidspg.bat /dryrun
rem  別の場所の exe を使いたいとき:  set KIDSPG_APP_EXE=D:\kidspg\KidsPGグミパズル.exe
rem ============================================================

rem ComfyUI の置き場所は **config.json の comfyui...paths.root が正**。
rem ここに書いてあるのは、config.json に paths が無かったときの控え（開発機の既定）。
rem [4/6] で config.json を読んだ時点で上書きされる。2箇所に本物を持つと、
rem 当日 PC の置き場所を変えたときに片方だけ直して気づかない。
set "COMFY_DIR=C:\WORK\AI\ComfyUI_20260902_0.34.0\ComfyUI"
set "COMFY_PORT=8188"
rem ComfyUI の起動を待つ秒数（CPU実行なので初回は時間がかかる）
set "COMFY_WAIT=180"

set "WARN=0"
set "DRYRUN="
if /i "%~1"=="/dryrun" set "DRYRUN=1"

echo ============================================================
echo   KidsPG「AIグミパク！」 起動
echo   %date% %time:~0,8%
if defined DRYRUN echo   ＊ 確認のみモード（アプリも ComfyUI も起動しません）
echo ============================================================
echo.

rem ------------------------------------------------------------
echo [1/6] 実行場所の点検
echo        フォルダ : %~dp0
set "ONEDRIVE_HIT="
echo "%~dp0" | find /i "OneDrive" > nul && set "ONEDRIVE_HIT=1"
echo "%~dp0" | find /i "\WORK\MGWork\" > nul && set "ONEDRIVE_HIT=1"
if defined ONEDRIVE_HIT (
  echo        [注意] OneDrive と同期しているフォルダです。
  echo               当日はローカル（例 C:\kidspg）へコピーして実行してください。
  echo               同期のファイルロックでカードの書き込みが失敗することがあります。
  set /a WARN+=1
) else (
  echo        OK : 同期フォルダの外です
)

rem --- Smart App Control（Windows 11）の点検。
rem     有効だと「署名の無い exe」は問答無用でブロックされる。Electron のアプリは
rem     本体（electron.exe）が未署名なので、パッケージ版も npm start も起動できない。
set "SAC="
for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command "try{ (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -ErrorAction Stop).VerifiedAndReputablePolicyState }catch{ 0 }"`) do set "SAC=%%A"
if "!SAC!"=="1" (
  echo        [注意] Smart App Control が有効です。
  echo               この起動方法（Electron 本体で dist を読む）は、SAC が有効なままでも
  echo               実績があります。まずはそのまま進めてください。
  echo               ＊ もしアプリが起動せず何も出ない場合は、SAC が弾いています。
  echo                  ブロックされた記録: イベントビューアー ^> Microsoft-Windows-CodeIntegrity/Operational
  echo                  その場合の確実な対処は SAC をオフにすること
  echo                  （Windows セキュリティ ^> アプリとブラウザーの制御 ^> スマート アプリ コントロール）。
  echo                  ※一度オフにすると、Windows を入れ直すまで戻せません。
  set /a WARN+=1
) else (
  echo        OK : Smart App Control はアプリの起動を止めません
)
echo.

rem ------------------------------------------------------------
echo [2/6] ImageMagick の確認（記念カードの合成に必要）
rem 配布版は ImageMagick を**インストールせず**、隣の bin\ImageMagick に携帯版を置く。
rem PATH を恒久的に書き換えず、この起動のあいだだけ先頭に足す。
rem 子プロセス（Electron → magick）はこの PATH を受け継ぐので、
rem アプリからの合成もこれで通る。開発機のようにインストール済みなら何も変わらない。
if exist "%~dp0..\bin\ImageMagick\magick.exe" (
  set "PATH=%~dp0..\bin\ImageMagick;!PATH!"
  echo        携帯版を使います : %~dp0..\bin\ImageMagick
)
where magick > nul 2>&1
if errorlevel 1 (
  echo        [警告] magick が見つかりません。記念カードが1枚も作られません。
  echo               ImageMagick をインストールし、PATH を通してから起動してください。
  set /a WARN+=1
) else (
  for /f "tokens=*" %%V in ('magick -version 2^>nul ^| findstr /i "ImageMagick"') do (
    if not defined MAGICK_VER set "MAGICK_VER=%%V"
  )
  echo        OK : !MAGICK_VER!
)
echo.

rem ------------------------------------------------------------
echo [3/6] アプリ本体の確認
rem 起動のしかたは2通り。
rem   electron … Electron 本体に、このフォルダのアプリ（dist\）を読ませて起動する ← 既定
rem   exe      … electron-builder が作った exe（release\win-unpacked\*.exe）を起動する
rem
rem  🔴 **既定は electron。exe は作らない方針**（2026-09-09 判断）。
rem  electron-builder が作る exe は「署名が無く、世の中に出回っていない新品の exe」に
rem  なるため、Windows 11 の Smart App Control に弾かれる。Electron 本体
rem  （node_modules\electron\dist\electron.exe）も署名は無いが、広く使われている
rem  バイナリなので評価（レピュテーション）で通る——この開発機は SAC が有効な状態で
rem  npm start が通っており、その経路の実績がある。
rem  ⚠️ ただし「評価で通る」は保証ではない。当日PCで弾かれた場合の確実な答えは
rem  SAC をオフにすること（一度オフにすると Windows を入れ直すまで戻せない）。
rem
rem  exe を試したいときだけ  set KIDSPG_MODE=exe  で切り替える。
set "LAUNCH_MODE="
if /i "%KIDSPG_MODE%"=="electron" set "LAUNCH_MODE=electron"
if /i "%KIDSPG_MODE%"=="exe" set "LAUNCH_MODE=exe"
if not defined LAUNCH_MODE set "LAUNCH_MODE=electron"

set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"
if "!LAUNCH_MODE!"=="electron" goto :check_electron

set "APP_EXE="
set "EXE_COUNT=0"
if defined KIDSPG_APP_EXE if exist "%KIDSPG_APP_EXE%" set "APP_EXE=%KIDSPG_APP_EXE%"
rem 製品名を変えると exe 名も変わり、古い exe が win-unpacked に残ることがある。
rem 先頭の1件ではなく「いちばん新しい exe」を選ぶ。
if not defined APP_EXE (
  for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command "$e=@(Get-ChildItem '%~dp0release\win-unpacked\*.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending); $e.Count; if($e.Count){$e[0].FullName}"`) do (
    if "!EXE_COUNT!"=="0" ( set "EXE_COUNT=%%A" ) else ( if not defined APP_EXE set "APP_EXE=%%A" )
  )
)
if !EXE_COUNT! GTR 1 (
  echo        [注意] win-unpacked\ に exe が !EXE_COUNT! 個あります。古いビルドが残っていませんか。
  echo               いちばん新しいものを起動します。
  set /a WARN+=1
)
if not defined APP_EXE (
  echo        [中止] アプリ本体が見つかりません。
  echo               release\win-unpacked\ に exe がありません。
  echo               先に  npm run dist:win  でパッケージを作ってください。
  set /a WARN+=1
  goto :summary
)
for %%F in ("%APP_EXE%") do (
  set "APP_NAME=%%~nxF"
  echo        本体      : %%~fF
  echo        ビルド日時 : %%~tF
)

rem --- 設定ファイルがパッケージ版と食い違っていないか
if exist "%~dp0release\win-unpacked\config.json" (
  fc /b "%~dp0config.json" "%~dp0release\win-unpacked\config.json" > nul 2>&1
  if errorlevel 1 (
    echo        [警告] config.json がパッケージ版と違います。
    echo               設定の変更（制限時間など）は反映されていません。
    echo               作り直すには  npm run dist:win
    set /a WARN+=1
  ) else (
    echo        OK : config.json はパッケージ版と一致
  )
)

rem --- ソースのビルド結果より exe が古くないか
set "FRESH="
for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command "try{ $d=(Get-ChildItem -Recurse -File '%~dp0dist' -ErrorAction Stop | Measure-Object LastWriteTime -Maximum).Maximum; if($d -gt (Get-Item '%APP_EXE%').LastWriteTime){'OLD'}else{'OK'} }catch{ 'OK' }"`) do set "FRESH=%%A"
if "!FRESH!"=="OLD" (
  echo        [警告] dist\ の中身より exe が古いです。最新の修正が入っていません。
  echo               作り直すには  npm run dist:win
  set /a WARN+=1
)
goto :app_checked

rem --- Electron 本体でこのフォルダのアプリを起動する場合の点検
:check_electron
echo        起動方法  : Electron 本体（exe は使いません）
if not exist "%ELECTRON_EXE%" (
  echo        [中止] Electron 本体が見つかりません : %ELECTRON_EXE%
  if exist "%~dp0src" (
    echo               開発機です。npm install を実行してください。
  ) else (
    echo               コピーが不完全です。node_modules\electron\ が丸ごと必要です。
    echo               USB から 0_セットアップ.bat をやり直してください。
  )
  set /a WARN+=1
  goto :summary
)
if not exist "%~dp0dist\main\main\main.js" (
  echo        [中止] ビルド結果がありません : dist\main\main\main.js
  if exist "%~dp0src" (
    echo               開発機です。npm run build を実行してください。
  ) else (
    echo               コピーが不完全です。USB から 0_セットアップ.bat をやり直してください。
  )
  set /a WARN+=1
  goto :summary
)
for %%F in ("%ELECTRON_EXE%") do echo        本体      : %%~fF
for %%F in ("%~dp0dist\main\main\main.js") do echo        ビルド日時 : %%~tF
echo        ＊ この起動方法では results\ はこのフォルダ直下に作られます
rem ソース（src）より dist が古くないか＝ npm run build のし忘れを拾う
set "FRESH="
for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command "try{ $s=(Get-ChildItem -Recurse -File '%~dp0src' -ErrorAction Stop | Measure-Object LastWriteTime -Maximum).Maximum; $d=(Get-ChildItem -Recurse -File '%~dp0dist' -ErrorAction Stop | Measure-Object LastWriteTime -Maximum).Maximum; if($s -gt $d){'OLD'}else{'OK'} }catch{ 'OK' }"`) do set "FRESH=%%A"
if "!FRESH!"=="OLD" (
  echo        [警告] src\ の変更が dist\ に反映されていません。
  echo               npm run build  を実行してから起動してください。
  set /a WARN+=1
) else (
  echo        OK : ビルド結果は最新です
)

:app_checked
echo.

rem ------------------------------------------------------------
echo [4/6] ComfyUI（AI画像変換）の確認
set "PROFILE="
set "BASEURL="
rem PowerShell 5.1 は BOM 無しの UTF-8 を ANSI と誤解するので -Encoding UTF8 が要る
rem paths はプロファイル側が優先。無ければ共通側（comfyui-config.ts と同じ扱い）
for /f "usebackq tokens=1,2,* delims=;" %%A in (`powershell -NoProfile -Command "try{ $c=(Get-Content -Raw -Encoding UTF8 '%~dp0config.json' | ConvertFrom-Json).comfyui; $p=$c.profiles.($c.activeProfile).paths; if(-not $p){ $p=$c.paths }; $c.activeProfile + ';' + $c.profiles.($c.activeProfile).baseUrl + ';' + $p.root }catch{ 'fumei;fumei;' }"`) do (
  set "PROFILE=%%A"
  set "BASEURL=%%B"
  set "CFG_ROOT=%%C"
)
if defined CFG_ROOT set "COMFY_DIR=!CFG_ROOT!"

rem Python の場所は2通りある。**配布版は埋め込み Python**（インストール不要）で、
rem 開発機は venv。どちらでも動くよう、あるほうを使う。
set "COMFY_PY="
if exist "!COMFY_DIR!\..\python_embeded\python.exe" set "COMFY_PY=!COMFY_DIR!\..\python_embeded\python.exe"
if not defined COMFY_PY if exist "!COMFY_DIR!\venv\Scripts\python.exe" set "COMFY_PY=!COMFY_DIR!\venv\Scripts\python.exe"
if not defined COMFY_PY set "COMFY_PY=!COMFY_DIR!\venv\Scripts\python.exe"
echo        使用プロファイル : !PROFILE!  ^(!BASEURL!^)

call :is_port_open
if "!PORT_OPEN!"=="1" (
  echo        OK : %COMFY_PORT% 番は待受中です（すでに起動しています）
  goto :comfy_done
)

if /i not "!PROFILE!"=="local" (
  echo        [警告] このPCの %COMFY_PORT% 番は待受していません。
  echo               AIサーバー側の ComfyUI が動いているか確認してください。
  echo               つながらない場合、カードは「本人の写真」で作られます。
  set /a WARN+=1
  goto :comfy_done
)

if not exist "!COMFY_PY!" (
  echo        [警告] ComfyUI の Python が見つかりません。
  echo               探した場所 : !COMFY_DIR!\..\python_embeded\python.exe
  echo                            !COMFY_DIR!\venv\Scripts\python.exe
  echo               config.json の comfyui...paths.root を確認してください。
  echo               このまま進めると、カードはプレースホルダで作られます。
  set /a WARN+=1
  goto :comfy_done
)

if defined DRYRUN (
  echo        ＊ 確認のみモードなので ComfyUI は起動しません
  goto :comfy_done
)

rem ComfyUI は画面を出さずに常駐させる（DOS窓を残さない）。
rem 代わりに出力はログへ落として、後から見られるようにする。
if not exist "%~dp0logs" mkdir "%~dp0logs"
echo        ComfyUI を起動します（CPU実行・画面は出ません）
echo        ログ : %~dp0logs\comfyui.log
set "LD_EXE=!COMFY_PY!"
set "LD_RAWARGS=main.py --cpu --listen 127.0.0.1 --port %COMFY_PORT% --disable-auto-launch"
set "LD_PATHARG="
set "LD_CWD=!COMFY_DIR!"
set "LD_LOG=%~dp0logs\comfyui.log"
set "LD_HIDE=1"
call :launch_detached
set "LD_HIDE="
set "LD_LOG="
if not "!LD_RC!"=="0" (
  echo        [警告] ComfyUI を起動できませんでした（コード !LD_RC!）
  set /a WARN+=1
  goto :comfy_done
)
set /a WAITED=0
:wait_comfy
call :is_port_open
if "!PORT_OPEN!"=="1" (
  echo.
  echo        OK : ComfyUI が待受を始めました（%COMFY_PORT% 番）
  goto :comfy_done
)
if !WAITED! GEQ %COMFY_WAIT% (
  echo.
  echo        [警告] %COMFY_WAIT% 秒待ちましたが応答がありません。
  echo               logs\comfyui.log にエラーが出ていないか見てください。
  set /a WARN+=1
  goto :comfy_done
)
set /a WAITED+=3
< nul set /p "=."
ping -n 4 127.0.0.1 > nul
goto :wait_comfy

:comfy_done
echo.

rem ------------------------------------------------------------
echo [5/6] 二重起動の確認
rem ------------------------------------------------------------
rem  アプリは二重起動を防いでいる（main.ts の requestSingleInstanceLock）。
rem  そのため**前のプロセスが残っていると、ここで起こしても即座に自滅する**。
rem  画面には何も出ないので「バッチが動かない」に見える。
rem
rem  残り方は2通りあり、対処が正反対なので必ず区別する。
rem    生きている … ウィンドウがある。起こすと既存の画面が前に出る（正しい挙動）
rem    ゾンビ     … ウィンドウが無いのにプロセスだけ residual。
rem                 ロックを握ったままなので、片付けないと二度と起動できない
rem ------------------------------------------------------------
for %%I in ("%~dp0.") do set "PROJ=%%~nxI"
if "!LAUNCH_MODE!"=="electron" (
  rem electron.exe は他の用途でも動きうるので、このフォルダを読んでいる親だけを見る
  set "INST_FILTER=$_.Name -eq 'electron.exe' -and $_.CommandLine -like '*!PROJ!*' -and $_.CommandLine -notlike '*--type=*'"
) else (
  rem 子プロセス（gpu-process / renderer / utility）は同じ exe なので必ず除く。
  rem 除かないと、生きているアプリの子が「ウィンドウ無し」＝ゾンビと判定されて殺される。
  set "INST_FILTER=($_.Name -like 'KidsPG*' -or $_.ExecutablePath -like '*win-unpacked*') -and $_.CommandLine -notlike '*--type=*'"
)
call :find_instances
echo        生きている : !LIVE_COUNT!  ／ ゾンビ : !ZOMBIE_COUNT!
rem 片付けで ZOMBIE_COUNT が 0 に変わるので、最初に見た状態を控えておく
set "FOUND_ANY="
if not "!LIVE_COUNT!"=="0" set "FOUND_ANY=1"
if not "!ZOMBIE_COUNT!"=="0" set "FOUND_ANY=1"
set "ALREADY_LIVE="
if not "!LIVE_COUNT!"=="0" (
  set "ALREADY_LIVE=1"
  echo        [注意] すでに起動しています。新しくは開かず、その画面を前に出します。
  echo               入れ替えたい場合は stop-kidspg.bat で落としてから実行してください。
  set /a WARN+=1
)
if not "!ZOMBIE_COUNT!"=="0" (
  echo        [注意] 前回の終了が完了せず、ウィンドウの無いプロセスが残っています。
  echo               PID!ZOMBIE_PIDS!
  echo               これが二重起動防止のロックを握っているため、片付けます。
  set /a WARN+=1
  if defined DRYRUN (
    echo        ＊ 確認のみモードなので片付けません
  ) else (
    for %%P in (!ZOMBIE_PIDS!) do taskkill /F /T /PID %%P > nul 2>&1
    ping -n 4 127.0.0.1 > nul
    call :find_instances
    if not "!ZOMBIE_COUNT!"=="0" (
      echo        [警告] 片付けられませんでした : PID!ZOMBIE_PIDS!
      echo               タスクマネージャーで終了させるか、管理者として実行してください。
      set /a WARN+=1
    ) else (
      echo        OK : 片付けました
    )
  )
)
if not defined FOUND_ANY echo        OK : まだ起動していません
echo.

rem ------------------------------------------------------------
echo [6/6] アプリの起動
if defined DRYRUN (
  echo        ＊ 確認のみモードなので起動しません
  goto :launch_done
)
if defined ALREADY_LIVE (
  rem すでに生きているので、起こしても main.ts の second-instance が
  rem 既存ウィンドウを前に出して終わる。それを狙って呼ぶ（新しい窓は開かない）。
  if "!LAUNCH_MODE!"=="electron" (
    start "" /b "!ELECTRON_EXE!" "%~dp0."
  ) else (
    start "" /b "!APP_EXE!"
  )
  echo        すでに起動していた画面を前に出しました（新しくは開いていません）
  goto :launch_done
)
(
  if "!LAUNCH_MODE!"=="electron" (
    set "LD_EXE=!ELECTRON_EXE!"
    set "LD_RAWARGS="
    set "LD_PATHARG=%~dp0."
    set "LD_CWD=%~dp0"
    call :launch_detached
    if "!LD_RC!"=="0" (
      echo        起動しました : Electron ^+ %~dp0
    ) else (
      echo        [警告] 切り離しての起動に失敗しました。従来の方法で起動します。
      echo               この場合、**この黒い画面を閉じるとアプリも終了します**。
      start "" "!ELECTRON_EXE!" "%~dp0."
      set /a WARN+=1
    )
  ) else (
    set "LD_EXE=!APP_EXE!"
    set "LD_RAWARGS="
    set "LD_PATHARG="
    set "LD_CWD=%~dp0"
    call :launch_detached
    if "!LD_RC!"=="0" (
      echo        起動しました : !APP_NAME!
    ) else (
      echo        [警告] 切り離しての起動に失敗しました。従来の方法で起動します。
      echo               この場合、**この黒い画面を閉じるとアプリも終了します**。
      start "" "!APP_EXE!"
      set /a WARN+=1
    )
  )
)

:launch_done
echo.

:summary
echo ============================================================
if "!WARN!"=="0" (
  echo   点検 : 問題は見つかりませんでした
) else (
  echo   点検 : 気になる点が !WARN! 件あります（上の [注意] [警告] を確認してください）
)
echo.
echo   この黒い画面は閉じてかまいません（アプリと ComfyUI は動き続けます）。
echo   終了するとき : stop-kidspg.bat を実行してください
echo                  （アプリの「終了」からでも止められます）
echo ============================================================
echo.
pause
endlocal
exit /b 0

rem ------------------------------------------------------------
rem  ウィンドウに連動して落ちないようにプロセスを起こす。
rem
rem  cmd の start で起こすと、このバッチの黒い画面を閉じたときに
rem  **一緒に終了させられる**（コンソールにぶら下がった子プロセスがまとめて片付けられる）。
rem  WMI 経由で起こすと親が WmiPrvSE になり、画面を閉じても動き続ける。
rem
rem  入力: LD_EXE（実行ファイル）/ LD_RAWARGS（そのまま渡す引数）/
rem        LD_PATHARG（引用符で囲んで渡すパス）/ LD_CWD（作業フォルダ）/
rem        LD_LOG（指定すると cmd 経由で出力をこのファイルへ追記する）/
rem        LD_HIDE（1 なら画面を出さない）
rem  出力: LD_RC（0 なら成功）
rem
rem  ※ 引用符の組み立ては PowerShell 側で行う。バッチ変数に引用符を入れると
rem     解釈がややこしく壊れやすいため、変数には素のパスと引数だけを入れること。
rem ------------------------------------------------------------
:launch_detached
set "LD_RC=9"
for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command "$q=[char]34; $exe='!LD_EXE!'; $raw='!LD_RAWARGS!'; $log='!LD_LOG!'; if($log){ $inner=$q+$exe+$q; if($raw){$inner+=' '+$raw}; $inner+=' >> '+$q+$log+$q+' 2>&1'; $cl='cmd.exe /c '+$q+$inner+$q } else { $cl=$q+$exe+$q; if($raw){$cl+=' '+$raw}; if('!LD_PATHARG!'){ $cl+=' '+$q+'!LD_PATHARG!'+$q } }; $args=@{CommandLine=$cl; CurrentDirectory='!LD_CWD!'}; if('!LD_HIDE!'){ $args['ProcessStartupInformation']=[CimInstance](New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}) }; try{ (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $args -ErrorAction Stop).ReturnValue }catch{ 9 }"`) do set "LD_RC=%%A"
exit /b 0

rem ------------------------------------------------------------
rem  INST_FILTER に合う「アプリ本体のプロセス」を数える。
rem
rem  ウィンドウの有無で分けるのが要点。MainWindowHandle が 0 のものは
rem  画面が無い＝ユーザーには終了済みに見えるのに、二重起動防止の
rem  ロックだけ握っている状態。これを片付けないと次が起動できない。
rem
rem  ただし**起動直後はまだウィンドウが無い**（Electron の初期化に数秒かかる）。
rem  立ち上がりかけを巻き込んで殺さないよう、若いプロセスは生きている側に数える。
rem
rem  入力: INST_FILTER（PowerShell の Where-Object 条件式）
rem  出力: LIVE_COUNT / ZOMBIE_COUNT / ZOMBIE_PIDS（先頭に空白つきのPID列）
rem ------------------------------------------------------------
:find_instances
set "LIVE_COUNT=0"
set "ZOMBIE_COUNT=0"
set "ZOMBIE_PIDS="
for /f "usebackq tokens=1,* delims==" %%A in (`powershell -NoProfile -Command "$live=0; $z=@(); foreach($p in @(Get-CimInstance Win32_Process | Where-Object { !INST_FILTER! })){ $h=0; try{ $h=(Get-Process -Id $p.ProcessId -ErrorAction Stop).MainWindowHandle }catch{ $h=0 }; $age=((Get-Date) - $p.CreationDate).TotalSeconds; if($h -ne 0 -or $age -lt 20){ $live++ } else { $z += $p.ProcessId } }; 'LIVE=' + $live; 'ZCOUNT=' + $z.Count; if($z.Count){ 'ZPIDS=' + ($z -join ' ') }"`) do (
  if /i "%%A"=="LIVE" set "LIVE_COUNT=%%B"
  if /i "%%A"=="ZCOUNT" set "ZOMBIE_COUNT=%%B"
  if /i "%%A"=="ZPIDS" if not "%%B"=="" set "ZOMBIE_PIDS= %%B"
)
if not defined LIVE_COUNT set "LIVE_COUNT=0"
if not defined ZOMBIE_COUNT set "ZOMBIE_COUNT=0"
exit /b 0

rem ------------------------------------------------------------
rem  127.0.0.1 の %COMFY_PORT% 番が待受しているかを PORT_OPEN に入れる
rem ------------------------------------------------------------
:is_port_open
set "PORT_OPEN=0"
netstat -ano -p tcp | findstr /r /c:"127.0.0.1:%COMFY_PORT% .*LISTENING" > nul 2>&1
if not errorlevel 1 set "PORT_OPEN=1"
if "%PORT_OPEN%"=="0" (
  netstat -ano -p tcp | findstr /r /c:"0.0.0.0:%COMFY_PORT% .*LISTENING" > nul 2>&1
  if not errorlevel 1 set "PORT_OPEN=1"
)
exit /b 0
