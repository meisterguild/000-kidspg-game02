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
rem    7. 準備確認（**ゲーム画面が本当に出たか**をアプリ自身の報告で確かめる）
rem
rem  当日の運用は「モニタとPCを置く → 電源 → このバッチ → 準備完了」だけにしたい。
rem  そのため 7 が要る。6 まではアプリを**起こした**ことしか確かめていないので、
rem  起動に失敗しても「起動しました／問題なし」と表示できてしまっていた。
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
rem アプリ自身が「画面が出て遊べる状態になった」と書く印。
rem 書くのは main の app-ready（src/main/services/readiness.ts）。
set "READY_FILE=%~dp0logs\ready.json"
rem 準備が整うまで待つ秒数。Electron の起動 + アセット読み込み + カメラ初期化ぶん。
rem カメラが決着しない場合もアプリ側が 20 秒で打ち切って報告するので、
rem ここはそれより十分長くとる。
set "READY_WAIT=90"
rem ComfyUI の起動を待つ秒数（CPU実行なので初回は時間がかかる）
rem 文書は「初回はモデルの読み込みに数分」と書いている。180 秒では朝いちばん
rem （ディスクが冷えている）に足りず、後から立ち上がるのに警告が出ていた
rem （敵対的レビュー 2026-09-09 の指摘）。
set "COMFY_WAIT=300"

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
echo [1/7] 実行場所の点検
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
  echo               ＊ アプリや ComfyUI が起動しない場合は SAC が弾いています。
  echo                  対処は **オフにすることではなく**、ネットに繋いで
  echo                  ウォームアップ.bat を通し、SAC に判定を取らせることです
  echo                  （判定が返るまでの間だけ止めているため。詳細は当日手順書）。
  echo                  ブロックされた記録: イベントビューアー ^> Microsoft-Windows-CodeIntegrity/Operational
  rem 🔴 **ここで WARN を増やしてはいけない。**
  rem 当日PCは「SAC はオフにしない」方針なので、当日は常に有効。
  rem 増やすと WARN が必ず1以上になり、**★★★ 準備完了 ★★★ が原理的に出ない**。
  rem 4つの文書が「★★★ が出ることを確かめる」と指示しているものが永久に出ない、
  rem という状態だった（敵対的レビュー 2026-09-09 の指摘）。
  rem 暖機済みなら正常なので、情報として出すだけにする。
) else (
  echo        OK : Smart App Control はアプリの起動を止めません
)
echo.

rem ------------------------------------------------------------
echo [2/7] ImageMagick の確認（記念カードの合成に必要）
rem 配布版は ImageMagick を**インストールせず**、隣の bin\ImageMagick に携帯版を置く。
rem PATH を恒久的に書き換えず、この起動のあいだだけ先頭に足す。
rem
rem 🔴 **この PATH はアプリには届かない。** アプリは :launch_detached
rem （Win32_Process.Create / WMI）で起こしており、この呼び方は**呼び出し元の
rem 環境変数を一切受け継がない**（ComfyUI の OMP_NUM_THREADS で実測済み）。
rem 以前はここのコメントが「子プロセスはこの PATH を受け継ぐ」と書いていたが、
rem それは cmd から直に起こしたときの話で、当日の経路では成り立っていない。
rem 記念カードが1枚も作られない状態で「★★★ 準備完了 ★★★」と出る
rem いちばん危ない壊れ方だった（敵対的レビュー 2026-09-09 の指摘）。
rem 対策は2つ入れてある:
rem   1. アプリを起こすときも APP_ENV でコマンド行に載せる（下の [6/7]）
rem   2. アプリ自身が <app>\..\bin\ImageMagick\magick.exe を絶対パスで探す
rem      （src/main/services/magick-path.ts）——こちらが本命の保険
set "MAGICK_DIR="
if exist "%~dp0..\bin\ImageMagick\magick.exe" (
  set "MAGICK_DIR=%~dp0..\bin\ImageMagick"
  set "PATH=%~dp0..\bin\ImageMagick;!PATH!"
  echo        携帯版を使います : %~dp0..\bin\ImageMagick
)
rem ImageMagick が大きな画像で使う一時ファイルも、このフォルダの中に置く。
rem 当日PCは「1つのフォルダで完結」させる方針なので、%TEMP% に散らさない
rem （片付けはフォルダを消すだけ、持ち帰りは丸ごとコピーだけ、を保つ）。
if not exist "%~dp0tmp" mkdir "%~dp0tmp" 2>nul
if not exist "%~dp0tmp" (
  rem 作れないまま MAGICK_TEMPORARY_PATH へ向けると、大きな画像の合成だけが
  rem あとから落ちる（[2/7] は magick を OK と出したまま）。先に言う
  echo        [警告] tmp\ を作れません : %~dp0tmp
  echo               大きな画像の合成に失敗することがあります。
  echo               ディスクの空き容量と書き込み権限を確認してください。
  set /a WARN+=1
) else (
  set "MAGICK_TEMPORARY_PATH=%~dp0tmp"
)
rem 🔴 携帯版は**コーダー DLL の置き場をレジストリから引く**ので、
rem    インストールしていない当日PCでは PNG を1枚も読めない
rem    （当日PCで実測 2026-09-10: RegistryKeyLookupFailed →
rem     記念カードが0枚。しかも "magick -version" は通ってしまうため
rem     「★★★ 準備完了 ★★★」と表示していた）。
rem    置き場を環境変数で教える。アプリへも下の APP_ENV で渡す。
if defined MAGICK_DIR (
  set "MAGICK_HOME=!MAGICK_DIR!"
  if exist "!MAGICK_DIR!\modules\coders" set "MAGICK_CODER_MODULE_PATH=!MAGICK_DIR!\modules\coders"
  if exist "!MAGICK_DIR!\modules\filters" set "MAGICK_FILTER_MODULE_PATH=!MAGICK_DIR!\modules\filters"
  if exist "!MAGICK_DIR!\colors.xml" set "MAGICK_CONFIGURE_PATH=!MAGICK_DIR!"
)

where magick > nul 2>&1
if errorlevel 1 (
  echo        [警告] magick が見つかりません。記念カードが1枚も作られません。
  echo               ImageMagick をインストールし、PATH を通してから起動してください。
  set /a WARN+=1
) else (
  rem 🔴 **"-version" で確かめない。** コーダーを読み込まないので、
  rem    PNG を1枚も扱えない状態でも成功する（実測で確認）。
  rem    実際に 4x4 の PNG を書かせて、扱えることを確かめる。
  magick -size 4x4 xc:white PNG:- > nul 2>&1
  if errorlevel 1 (
    echo        [警告] magick はありますが PNG を扱えません。
    echo               記念カードが1枚も作られません。
    echo               携帯版は modules\coders が要ります（bin\ImageMagick を確認）。
    set /a WARN+=1
  ) else (
    for /f "tokens=*" %%V in ('magick -version 2^>nul ^| findstr /i "ImageMagick"') do (
      if not defined MAGICK_VER set "MAGICK_VER=%%V"
    )
    echo        OK : !MAGICK_VER!
    echo        OK : PNG を書けました
  )
)
echo.

rem ------------------------------------------------------------
echo [3/7] アプリ本体の確認
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

rem 🔴 **印の置き場所はアプリが決める。** アプリは
rem getBundleRoot()（= パッケージ版なら exe の隣、そうでなければアプリのフォルダ）
rem の logs\ready.json に書く。exe モードのときバッチが %~dp0logs を見ていると、
rem アプリが完璧に立ち上がっても印は永久に見つからない
rem （敵対的レビュー 2026-09-09 の指摘）。モードに合わせて見る場所を変える。

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
  rem ここへ来たらアプリは起きていない。まとめで「準備完了」と言わせない
  set "STOP_BEFORE_LAUNCH=1"
  goto :summary
)
for %%F in ("%APP_EXE%") do (
  set "APP_NAME=%%~nxF"
  echo        本体      : %%~fF
  echo        ビルド日時 : %%~tF
  rem 🔴 印は**アプリが書く場所**を見る。パッケージ版は exe の隣（getBundleRoot）。
  rem ここを合わせないと、アプリが立ち上がっても印が永久に見つからず、
  rem 90秒待って「準備できていません」になる（敵対的レビュー 2026-09-09 の指摘）。
  set "READY_FILE=%%~dpFlogs\ready.json"
)
echo        印の場所  : !READY_FILE!

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
  rem ここへ来たらアプリは起きていない。まとめで「準備完了」と言わせない
  set "STOP_BEFORE_LAUNCH=1"
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
  rem ここへ来たらアプリは起きていない。まとめで「準備完了」と言わせない
  set "STOP_BEFORE_LAUNCH=1"
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
echo [4/7] ComfyUI（AI画像変換）の確認
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

rem 🔴 **config.json を読めなかったことを、別の理由と混ぜない。**
rem    読めないと上の PowerShell は 'fumei;fumei;' を返すので CFG_ROOT が空になり、
rem    以前はそのまま「このプロファイルは別の機体の ComfyUI を指しているので
rem    こちらでは起こせません」と表示していた——**原因は config.json なのに
rem    案内は逆方向**で、しかも COMFY_DIR は開発機の既定が黙って残っていた
rem    （敵対的レビュー 2026-09-09 の指摘）。当日の退避手順が
rem    「activeProfile を手で書き換える」なので、綴り間違いは現実的な入力。
if /i "!PROFILE!"=="fumei" (
  echo        [警告] config.json を読めませんでした。
  echo               ファイルが壊れているか、activeProfile の綴りが違います。
  echo               このままでは AI 変換が使えません（カードの絵は全員同じ
  echo               プレースホルダになります）。
  echo               確認する場所 : %~dp0config.json の comfyui.activeProfile
  set /a WARN+=1
  goto :comfy_done
)
if not defined BASEURL (
  echo        [警告] config.json に comfyui の baseUrl がありません。
  echo               AI 変換なしで動きます（意図した構成なら問題ありません）。
  goto :comfy_done
)

rem Python の場所は2通りある。**配布版は埋め込み Python**（インストール不要）で、
rem 開発機は venv。どちらでも動くよう、あるほうを使う。
set "COMFY_PY="
if exist "!COMFY_DIR!\..\python_embeded\python.exe" set "COMFY_PY=!COMFY_DIR!\..\python_embeded\python.exe"
if not defined COMFY_PY if exist "!COMFY_DIR!\venv\Scripts\python.exe" set "COMFY_PY=!COMFY_DIR!\venv\Scripts\python.exe"
if not defined COMFY_PY set "COMFY_PY=!COMFY_DIR!\venv\Scripts\python.exe"
echo        使用プロファイル : !PROFILE!  ^(!BASEURL!^)

rem 🔴 **「ローカルで起こすべきか」をプロファイル名で決めてはいけない。**
rem    以前は !PROFILE! が "local" かどうかだけを見ていた。ところが
rem    当日手順書の退避策は「生成が間に合わない → activeProfile を
rem    local_light にしてアプリを再起動」で、local_light も
rem    baseUrl=127.0.0.1・paths.root ありの**ローカルで起こす必要がある**
rem    プロファイル。この退避を採った瞬間に ComfyUI を誰も起こさなくなり、
rem    しかも表示は「AIサーバー側の ComfyUI が動いているか確認してください」
rem    という無関係な誘導になっていた（敵対的レビュー 2026-09-09 の指摘）。
rem    activeProfile の綴り間違いや JSON 読み取り失敗（fumei）でも同じ枝に落ちる。
rem    見るのは**事実**——baseUrl がこのPCを指していて、root が分かっているか。
rem 🔴 **ポートまで見る。** ホスト名だけを見ていると、config.json が
rem    :8189 を指していても「ローカルだ」と判断して**8188 を起こし**、
rem    8188 の待受を見て「OK」と表示し、アプリだけが繋がらない——という
rem    見つけにくい壊れ方になる（このバッチの %COMFY_PORT%、生成される
rem    start-comfyui.bat の --port、再生成.bat の3か所に 8188 が書かれており、
rem    config.json とずれる余地がある。敵対的レビュー 2026-09-09 の指摘）。
set "COMFY_IS_LOCAL="
echo !BASEURL! | findstr /i /c:"//127.0.0.1:%COMFY_PORT%" /c:"//localhost:%COMFY_PORT%" /c:"//[::1]:%COMFY_PORT%" > nul 2>&1
if not errorlevel 1 if defined CFG_ROOT set "COMFY_IS_LOCAL=1"
rem ホストはこのPCなのにポートが違う場合は、黙って別のポートを起こさない
if not defined COMFY_IS_LOCAL (
  echo !BASEURL! | findstr /i /c:"//127.0.0.1:" /c:"//localhost:" /c:"//[::1]:" > nul 2>&1
  if not errorlevel 1 (
    echo        [警告] config.json の baseUrl はこのPCを指していますが、
    echo               ポートが %COMFY_PORT% 番ではありません : !BASEURL!
    echo               このバッチは %COMFY_PORT% 番でしか起こせません。
    echo               config.json を %COMFY_PORT% 番に合わせてください。
    set /a WARN+=1
    goto :comfy_done
  )
)

call :is_port_open
if "!PORT_OPEN!"=="1" (
  rem ⚠️ **待受しているだけでは「起動している」と言えない。** 前日の別プロジェクトの
  rem    ComfyUI、モデルが載っていない ComfyUI、8188 を掴んだ別プログラムでも
  rem    LISTENING にはなる。以前はここで OK と出して以後の経路を全部飛ばしていた
  rem    （敵対的レビュー 2026-09-09 の指摘）。中身を1回だけ聞いてみる。
  call :comfy_answers
  if "!COMFY_OK!"=="1" (
    echo        OK : %COMFY_PORT% 番は待受中で、応答もあります（すでに起動しています）
  ) else (
    echo        [注意] %COMFY_PORT% 番は誰かが使っていますが、ComfyUI の応答がありません。
    echo               モデル読み込み中か、別のプログラムが %COMFY_PORT% 番を
    echo               掴んでいます。カードの絵がプレースホルダになる場合は
    echo               logs\comfyui.log とタスクマネージャーを確認してください。
    set /a WARN+=1
  )
  goto :comfy_done
)

rem 別の実行が ComfyUI を起こして待っている最中なら、2つ目を起こさない。
rem 🔴 **ただし古い印で当日詰まないこと。** 異常終了（電源断・タスクマネージャ）で
rem    印が残ると、それだけで ComfyUI が永久に起こせなくなる——当日いちばん
rem    やってはいけない壊れ方。待ち時間（%COMFY_WAIT% 秒）＋余裕 60 秒より
rem    古い印は「前回の残骸」と見て捨てる。
set "COMFY_FLAG_FRESH=0"
if exist "%~dp0logs\comfy-starting.flag" (
  for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command "try{ $f=Get-Item -LiteralPath '%~dp0logs\comfy-starting.flag' -ErrorAction Stop; if(((Get-Date)-$f.LastWriteTime).TotalSeconds -lt (%COMFY_WAIT% + 60)){'1'}else{'0'} }catch{ '0' }"`) do set "COMFY_FLAG_FRESH=%%A"
)
if "!COMFY_FLAG_FRESH!"=="1" (
  echo        [注意] 別の実行が ComfyUI を起動中です。2つ目は起こしません。
  echo               そちらの黒い画面が「準備完了」まで進むのを待ってください。
  set /a WARN+=1
  goto :comfy_done
)
if exist "%~dp0logs\comfy-starting.flag" (
  echo        ＊ 前回の起動中の印が残っていたので捨てます
  del "%~dp0logs\comfy-starting.flag" > nul 2>&1
)

if not defined COMFY_IS_LOCAL (
  echo        [警告] このPCの %COMFY_PORT% 番は待受していません。
  echo               このプロファイル（!PROFILE! / !BASEURL!）は別の機体の
  echo               ComfyUI を指しているので、こちらでは起こせません。
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
rem 🔴 **logs に書けることを確かめる。** 書けない／満杯だと cmd.exe は即座に
rem    落ちるが Win32_Process.Create は 0 を返す（cmd の起動自体は成功する）ため、
rem    「ComfyUI を起動します」と表示したうえで 300 秒待ち、最後に
rem    **存在しないログを見ろ**と言っていた（敵対的レビュー 2026-09-09 の指摘）。
if not exist "%~dp0logs" mkdir "%~dp0logs" 2>nul
> "%~dp0logs\.write-probe" echo ok 2>nul
if not exist "%~dp0logs\.write-probe" (
  echo        [警告] logs\ に書き込めません : %~dp0logs
  echo               ディスクの空き容量と書き込み権限を確認してください。
  echo               ComfyUI のログが残らないので、失敗しても原因が追えません。
  set /a WARN+=1
) else (
  del "%~dp0logs\.write-probe" > nul 2>&1
)
echo        ComfyUI を起動します（CPU実行・画面は出ません）
echo        ログ : %~dp0logs\comfyui.log
rem ComfyUI へ渡す環境変数。**ここが唯一効く場所**（上の LD_ENV の説明）。
rem  ・OMP_NUM_THREADS … CPU 実行は全論理コアを食い尽くし、同じPCで動く
rem    ゲーム（Electron + WebGL）がカクついて操作不能になるため絞る
rem  ・HF_* / TORCH_HOME / XDG_CACHE_HOME … 既定では %USERPROFILE%.cache へ
rem    出てしまう。当日PCは1フォルダで完結させる方針なので中へ向ける
rem  ・*_OFFLINE … 当日はオフライン。外へ探しに行って待たされるのを防ぐ
set "LD_ENV=set OMP_NUM_THREADS=6&& set HF_HOME=%~dp0..\ai\cache\huggingface&& set HF_HUB_CACHE=%~dp0..\ai\cache\huggingface\hub&& set TORCH_HOME=%~dp0..\ai\cache\torch&& set XDG_CACHE_HOME=%~dp0..\ai\cache&& set HF_HUB_OFFLINE=1&& set TRANSFORMERS_OFFLINE=1"
set "LD_EXE=!COMFY_PY!"
set "LD_RAWARGS=main.py --cpu --listen 127.0.0.1 --port %COMFY_PORT% --disable-auto-launch"
set "LD_PATHARG="
set "LD_CWD=!COMFY_DIR!"
set "LD_LOG=%~dp0logs\comfyui.log"
set "LD_HIDE=1"
call :launch_detached
set "LD_HIDE="
set "LD_LOG="
set "LD_ENV="
if not "!LD_RC!"=="0" (
  echo        [警告] ComfyUI を起動できませんでした（コード !LD_RC!）
  set /a WARN+=1
  goto :comfy_done
)
rem 🔴 **起動中であることを記録する。** ComfyUI は待受を始めるまで数分かかる
rem    （COMFY_WAIT=%COMFY_WAIT% 秒という設定自体がそれを認めている）。その間に
rem    もう一度このバッチを叩くと、2本目は「まだ待受していない」と判断して
rem    **2つ目の python main.py を起こす**。torch を二重に読み込んで CPU と
rem    メモリを食い尽くし、後から bind した方は即死、ログも混ざる
rem    （敵対的レビュー 2026-09-09 の指摘）。印を置いて、次の人に伝える。
> "%~dp0logs\comfy-starting.flag" echo %DATE% %TIME% pid=%RANDOM% 2>nul
set /a WAITED=0
:wait_comfy
call :is_port_open
if "!PORT_OPEN!"=="1" (
  echo.
  echo        OK : ComfyUI が待受を始めました（%COMFY_PORT% 番）
  del "%~dp0logs\comfy-starting.flag" > nul 2>&1
  goto :comfy_done
)
if !WAITED! GEQ %COMFY_WAIT% (
  echo.
  del "%~dp0logs\comfy-starting.flag" > nul 2>&1
  echo        [警告] %COMFY_WAIT% 秒待ちましたが応答がありません。
  echo               logs\comfyui.log にエラーが出ていないか見てください。
  set /a WARN+=1
  rem Smart App Control に .pyd を止められていると、ログには
  rem 「DLL load failed ...」の1行しか出ず、原因が分からない。名前で言う
  call :report_sac
  goto :comfy_done
)
set /a WAITED+=3
< nul set /p "=."
ping -n 4 127.0.0.1 > nul
goto :wait_comfy

:comfy_done
echo.

rem ------------------------------------------------------------
echo [5/7] 二重起動の確認
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
rem 自分のインスタンスの見分け方。
rem 🔴 **フォルダ名では絞りが甘い。** 当日の置き場所は C:\kidspg\app なので
rem フォルダ名は "app" になり、'*app*' は無関係な electron.exe にも当たる。
rem 当たると「すでに生きている」と誤判定し、アプリを起こさずに準備完了と
rem 出しうる（敵対的レビュー 2026-09-09 の指摘）。フルパスで照合する。
for %%I in ("%~dp0.") do set "APPDIR=%%~fI"
if "!LAUNCH_MODE!"=="electron" (
  set "INST_FILTER=$_.Name -eq 'electron.exe' -and $_.CommandLine -like '*!APPDIR!*' -and $_.CommandLine -notlike '*--type=*'"
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
echo [6/7] アプリの起動
if defined DRYRUN (
  echo        ＊ 確認のみモードなので起動しません
  goto :launch_done
)
call :clear_ready
if defined READY_CLEAR_FAILED (
  set /a WARN+=1
  set "STOP_BEFORE_LAUNCH=1"
  goto :summary
)
if defined ALREADY_LIVE (
  rem すでに生きているので、起こしても main.ts の second-instance が
  rem 既存ウィンドウを前に出して終わる。それを狙って呼ぶ（新しい窓は開かない）。
  rem そのとき main は renderer へ「もう一度報告して」を投げるので、
  rem **消した印は測り直して書かれる**。以前はここで消さない作りだったため、
  rem 何時間前の印でも「準備完了」と読んでしまっていた
  rem （敵対的レビュー 2026-09-09 の指摘）。
  if "!LAUNCH_MODE!"=="electron" (
    start "" /b "!ELECTRON_EXE!" "%~dp0."
  ) else (
    start "" /b "!APP_EXE!"
  )
  echo        すでに起動していた画面を前に出しました（新しくは開いていません）
  goto :launch_done
)
rem （古い印は :clear_ready で消してある）
rem アプリへ渡す環境変数。**ここが唯一効く場所**（:launch_detached の説明）。
rem  ・KIDSPG_MAGICK … 携帯版 magick の絶対パス。アプリはこれを最優先で使う
rem    （src/main/services/magick-path.ts）。PATH を組み替えないのは、
rem    コマンド行に巨大な PATH を載せると引用符と ^& で壊れやすいため
rem  ・MAGICK_TEMPORARY_PATH … 合成の一時ファイルをこのフォルダの中へ。
rem    渡さないと %TEMP% に出る（当日PCは1フォルダで完結させる方針に反する）
rem  ・KIDSPG_APP_LOG … 出したログの場所。当日の調べ物の入口を1つに絞る
set "APP_ENV="
if defined MAGICK_DIR set "APP_ENV=set KIDSPG_MAGICK=!MAGICK_DIR!\magick.exe"
rem コーダーの置き場も渡す（アプリは自分でも探すが、両方から入れておく）
if defined MAGICK_CODER_MODULE_PATH set "APP_ENV=!APP_ENV!&& set MAGICK_CODER_MODULE_PATH=!MAGICK_CODER_MODULE_PATH!"
if defined MAGICK_FILTER_MODULE_PATH set "APP_ENV=!APP_ENV!&& set MAGICK_FILTER_MODULE_PATH=!MAGICK_FILTER_MODULE_PATH!"
if defined MAGICK_CONFIGURE_PATH set "APP_ENV=!APP_ENV!&& set MAGICK_CONFIGURE_PATH=!MAGICK_CONFIGURE_PATH!"
if defined MAGICK_HOME set "APP_ENV=!APP_ENV!&& set MAGICK_HOME=!MAGICK_HOME!"
if defined MAGICK_TEMPORARY_PATH (
  if defined APP_ENV (
    set "APP_ENV=!APP_ENV!&& set MAGICK_TEMPORARY_PATH=!MAGICK_TEMPORARY_PATH!"
  ) else (
    set "APP_ENV=set MAGICK_TEMPORARY_PATH=!MAGICK_TEMPORARY_PATH!"
  )
)
(
  if "!LAUNCH_MODE!"=="electron" (
    set "LD_EXE=!ELECTRON_EXE!"
    set "LD_RAWARGS="
    set "LD_PATHARG=%~dp0."
    set "LD_CWD=%~dp0"
    rem 🔴 **アプリの標準出力を残す。** 以前はログを取っていなかったため、
    rem    「当日はこのログで状況を追う」と書いてあるのに console.log /
    rem    console.error が1行も読めなかった（アセットが見つからない、
    rem    results.json の更新失敗、ComfyUI の CRITICAL など全部捨てられていた。
    rem    敵対的レビュー 2026-09-09 の指摘）。
    set "LD_LOG=%~dp0logs\app.log"
    set "LD_ENV=!APP_ENV!"
    rem ログを取るため cmd.exe /c で包む。その cmd のコンソールは隠す——
    rem 表示すると当日ずっと黒い窓が残り、スタッフが閉じるとアプリも落ちる
    set "LD_HIDE=1"
    call :launch_detached
    set "LD_HIDE="
    set "LD_LOG="
    set "LD_ENV="
    if "!LD_RC!"=="0" (
      echo        起動しました : Electron ^+ %~dp0
      echo        アプリのログ : %~dp0logs\app.log
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
    set "LD_LOG=%~dp0logs\app.log"
    set "LD_ENV=!APP_ENV!"
    set "LD_HIDE=1"
    call :launch_detached
    set "LD_HIDE="
    set "LD_LOG="
    set "LD_ENV="
    if "!LD_RC!"=="0" (
      echo        起動しました : !APP_NAME!
      echo        アプリのログ : %~dp0logs\app.log
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

rem ------------------------------------------------------------
echo [7/7] 準備確認
if defined DRYRUN (
  echo        ＊ 確認のみモードなので確かめません
  goto :ready_done
)
echo        ゲーム画面が出るのを待ちます（最大 %READY_WAIT% 秒）…
set /a RWAITED=0
:wait_ready
if exist "!READY_FILE!" goto :read_ready
if !RWAITED! GEQ %READY_WAIT% (
  echo.
  echo        [警告] %READY_WAIT% 秒待ちましたが、アプリから準備完了の報告がありません。
  echo               画面が出ているかモニタを見てください。出ていない場合の見どころ:
  echo                 ・Smart App Control に弾かれていないか
  echo                   （イベントビューアー ^> Microsoft-Windows-CodeIntegrity/Operational）
  echo                 ・logs\ready.json が作られない＝画面まで到達していない
  echo               画面は出ているのにここに来た場合は、カメラの初期化が
  echo               終わっていない可能性があります（Windows の設定 ^> プライバシー ^> カメラ）。
  set /a WARN+=1
  set "READY_NG=1"
  call :report_sac
  goto :ready_done
)
set /a RWAITED+=2
< nul set /p "=."
ping -n 3 127.0.0.1 > nul
goto :wait_ready

:read_ready
echo.
set "RCOUNT="
set "RWARNS="
rem 🔴 **いつの印かを必ず出す。** 判定は「その瞬間のスナップショット」で、
rem 報告後に ComfyUI が落ちたりカメラが抜かれたりしても印は変わらない。
rem 時刻が出ていれば、スタッフが「さっきの話か」と判断できる
rem （敵対的レビュー 2026-09-09 の指摘）。
rem 🔴 **「遊べない」と「遊べるが困る」を分けて読む。**
rem 以前は1つの warnings を見て、1件でもあれば「準備できていません」にしていた。
rem そのためカメラを挿し忘れただけ・ComfyUI が落ちただけ・AI 変換を意図して
rem 切っただけ、という**遊べる状態で開場を止めて**いた（敵対的レビュー 2026-09-09）。
for /f "usebackq tokens=1,* delims==" %%A in (`powershell -NoProfile -Command "try{ $r=(Get-Content -Raw -Encoding UTF8 '!READY_FILE!' | ConvertFrom-Json); 'RBLOCK=' + @($r.blockers).Count; 'RNOTE=' + @($r.notes).Count; 'RSCREEN=' + $r.screen; 'RAT=' + ([datetime]$r.readyAt).ToLocalTime().ToString('HH:mm:ss'); foreach($b in @($r.blockers)){ 'RB=' + $b }; foreach($n in @($r.notes)){ 'RN=' + $n } }catch{ 'RBLOCK=-1' }"`) do (
  if /i "%%A"=="RBLOCK" set "RBLOCK=%%B"
  if /i "%%A"=="RNOTE" set "RNOTE=%%B"
  if /i "%%A"=="RSCREEN" set "RSCREEN=%%B"
  if /i "%%A"=="RAT" set "RAT=%%B"
  if /i "%%A"=="RB" echo        [遊べません] %%B
  if /i "%%A"=="RN" echo        [注意] %%B
)
rem PowerShell が動かない・出力が1行も返らない場合、RBLOCK は空のままになる。
rem そのまま進むと「OK : ゲーム画面が出ました」と「準備できていません」が同時に出て、
rem さらに set /a が Missing operand で英語のエラーを吐く
rem （敵対的レビュー 2026-09-09 の指摘）。読めなかった扱いへ寄せる。
if not defined RBLOCK set "RBLOCK=-1"
if not defined RNOTE set "RNOTE=0"
if "!RBLOCK!"=="-1" (
  echo        [警告] 準備完了の報告を読めませんでした（logs\ready.json が壊れている）。
  set /a WARN+=1
  set "READY_NG=1"
  goto :ready_done
)
echo        OK : ゲーム画面が出ました（表示中: !RSCREEN! ／ 判定時刻 !RAT!）
rem 遊べないものがあるときだけ開場を止める
if not "!RBLOCK!"=="0" (
  set /a WARN+=!RBLOCK!
  set "READY_NG=1"
)
rem 遊べるが当日困ることは、止めずに必ず見せる
rem （全員ダミー写真のまま開場する、を防ぐため）
if not "!RNOTE!"=="0" set /a WARN+=!RNOTE!

:ready_done
echo.

:summary
echo ============================================================
rem 「else if」の連鎖は cmd では書き方によって黙って外れるので使わない。
rem ここを間違えると**起動していないのに「準備完了」と出る**ので goto で分ける。
if defined DRYRUN goto :sum_dryrun
if defined STOP_BEFORE_LAUNCH goto :sum_stopped
if defined READY_NG goto :sum_notready
if "!WARN!"=="0" goto :sum_ready
goto :sum_ready_warn

:sum_dryrun
if "!WARN!"=="0" (
  echo   点検 : 問題は見つかりませんでした（確認のみモード。何も起動していません）
) else (
  echo   点検 : 気になる点が !WARN! 件あります（確認のみモード）
)
goto :sum_done

:sum_stopped
echo   ★ 準備できていません。アプリは起動していません。
echo      上の [中止] を見てください。
goto :sum_done

:sum_notready
echo   ★ 準備できていません。上の [警告] を見てください。
echo      （気になる点 !WARN! 件）
goto :sum_done

:sum_ready
echo   ★★★ 準備完了 ★★★  そのまま遊べます
goto :sum_done

:sum_ready_warn
echo   ★ 準備完了（ただし気になる点が !WARN! 件あります。上の [注意] を確認）
goto :sum_done

:sum_done
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
rem LD_ENV: cmd.exe /c 経由で起こすときに前置きする set 文（"set A=1&& set B=2" の形）。
rem 🔴 **区切りの "&&" の前に空白を置かないこと。** cmd の set は
rem    行末（次の区切りまで）をそのまま値にするので、"set A=1 && ..." と
rem    書くと**値が "1 " になる**（実測: set ZZ=C:\kidspg\tmp && → "C:\kidspg\tmp "）。
rem    末尾の空白はパスの最終要素でしか無視されないため、
rem    MAGICK_TEMPORARY_PATH は**存在しないフォルダ**を指し、
rem    TRANSFORMERS_OFFLINE は "1 " になって真値として扱われなかった
rem    （敵対的レビュー 2026-09-09 の指摘）。LD_ENV の中も同じ規則で書く。
rem Win32_Process.Create は**呼び出し元の環境を受け継がない**ので、
rem バッチ側で set しただけでは子に届かない。コマンド行に載せる必要がある
rem （敵対的レビュー 2026-09-09 の指摘。ComfyUI の OMP_NUM_THREADS と
rem  キャッシュの向き先が、どちらも効いていなかった）。
rem 🔴 **LD_PATHARG は LD_LOG のある枝でも渡すこと。** 以前は $log の枝で
rem    組み立てから漏れており、ログを取りながら Electron を起こすと
rem    アプリのフォルダ引数が落ちて別のものが立ち上がる形だった。
rem    LD_ENV も $log が無いと載らなかったので、どちらか一方でも
rem    指定されていれば cmd.exe /c で包むようにまとめた。
for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command "$q=[char]34; $exe='!LD_EXE!'; $raw='!LD_RAWARGS!'; $pathArg='!LD_PATHARG!'; $log='!LD_LOG!'; $pre='!LD_ENV!'; $inner=$q+$exe+$q; if($raw){$inner+=' '+$raw}; if($pathArg){$inner+=' '+$q+$pathArg+$q}; if($log){$inner+=' >> '+$q+$log+$q+' 2>&1'}; if($pre -or $log){ if($pre){$inner=$pre+'&& '+$inner}; $cl='cmd.exe /c '+$q+$inner+$q } else { $cl=$inner }; $args=@{CommandLine=$cl; CurrentDirectory='!LD_CWD!'}; if('!LD_HIDE!'){ $args['ProcessStartupInformation']=[CimInstance](New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}) }; try{ (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $args -ErrorAction Stop).ReturnValue }catch{ 9 }"`) do set "LD_RC=%%A"
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
rem  🔴 **猶予は 90 秒。** 以前は 20 秒だった。冷えたディスクと Smart App Control の
rem  判定待ちが重なると初回のウィンドウ表示は 20 秒を超えうる（SAC 対策が
rem  必要な機体では、まさにそれが起きる）。そこを短くしていたため、
rem  二重起動やウォームアップ中に叩いたときに**1本目が起こしたばかりの
rem  Electron をゾンビ扱いして /F /T で殺す**恐れがあった
rem  （敵対的レビュー 2026-09-09 の指摘）。準備確認の待ち（READY_WAIT=90 秒）と
rem  同じ長さにしておけば、待っている最中のものを殺すことはない。
rem
rem  入力: INST_FILTER（PowerShell の Where-Object 条件式）
rem  出力: LIVE_COUNT / ZOMBIE_COUNT / ZOMBIE_PIDS（先頭に空白つきのPID列）
rem ------------------------------------------------------------
:find_instances
set "LIVE_COUNT=0"
set "ZOMBIE_COUNT=0"
set "ZOMBIE_PIDS="
for /f "usebackq tokens=1,* delims==" %%A in (`powershell -NoProfile -Command "$live=0; $z=@(); foreach($p in @(Get-CimInstance Win32_Process | Where-Object { !INST_FILTER! })){ $h=0; try{ $h=(Get-Process -Id $p.ProcessId -ErrorAction Stop).MainWindowHandle }catch{ $h=0 }; $age=((Get-Date) - $p.CreationDate).TotalSeconds; if($h -ne 0 -or $age -lt 90){ $live++ } else { $z += $p.ProcessId } }; 'LIVE=' + $live; 'ZCOUNT=' + $z.Count; if($z.Count){ 'ZPIDS=' + ($z -join ' ') }"`) do (
  if /i "%%A"=="LIVE" set "LIVE_COUNT=%%B"
  if /i "%%A"=="ZCOUNT" set "ZOMBIE_COUNT=%%B"
  if /i "%%A"=="ZPIDS" if not "%%B"=="" set "ZOMBIE_PIDS= %%B"
)
if not defined LIVE_COUNT set "LIVE_COUNT=0"
if not defined ZOMBIE_COUNT set "ZOMBIE_COUNT=0"
exit /b 0

rem ------------------------------------------------------------
rem  古い「準備OK」の印を消す。**消せたことを確かめる。**
rem
rem  🔴 消せないまま進むと、起動に失敗しても [7/7] が古い印を待ち時間ゼロで
rem  読み、「★★★ 準備完了 ★★★」を出す。モニタが真っ暗なのに「速くて調子がいい」
rem  ように見える——当日いちばん危ない壊れ方（敵対的レビュー 2026-09-09 の指摘）。
rem  以前は del の結果を > nul で潰して確認していなかった。
rem  アプリ側（readiness.ts の clearReadiness）も同じ unlink なので、
rem  ロック・属性・ACL のどれか1つで**両方が同時に失敗する**。独立した防御に
rem  なっていないので、ここで必ず確かめて止める。
rem ------------------------------------------------------------
:clear_ready
set "READY_CLEAR_FAILED="
if not exist "!READY_FILE!" exit /b 0
del /f /q "!READY_FILE!" > nul 2>&1
if not exist "!READY_FILE!" exit /b 0
echo        [中止] 前回の「準備OK」の印を消せません:
echo               !READY_FILE!
echo               このまま進むと、起動に失敗しても古い印を読んで
echo               「準備完了」と表示してしまいます。
echo               読み取り専用属性・前のプロセスが握っている・同期ソフトの
echo               ロックを確認し、stop-kidspg.bat を実行してからやり直してください。
set "READY_CLEAR_FAILED=1"
exit /b 0

rem ------------------------------------------------------------
rem  Smart App Control にブロックされたものを名前で出す。
rem
rem  🔴 **これが無いと当日は原因に辿り着けない。**
rem  SAC に .pyd を止められたときの見え方は、ComfyUI のログに
rem    ImportError: DLL load failed while importing cython_special:
rem      アプリケーション制御ポリシーによってこのファイルはブロックされました。
rem  という1行が残るだけ（2026-09-09 実測）。スタッフがこれを見て
rem  「SAC が原因」と判断するのは無理がある。
rem
rem  SAC は判定を取りに行っている間だけ止めるので、**前日までにオンラインで
rem  暖機**しておけば当日は起きない（ウォームアップ.bat）。それでも起きたときに
rem  「何が止められたか」だけは見えるようにしておく。
rem ------------------------------------------------------------
:report_sac
set "SACCHK="
if exist "%~dp0..\ops\tools\onsite\check-sac-blocks.ps1" set "SACCHK=%~dp0..\ops\tools\onsite\check-sac-blocks.ps1"
if not defined SACCHK if exist "%~dp0tools\onsite\check-sac-blocks.ps1" set "SACCHK=%~dp0tools\onsite\check-sac-blocks.ps1"
if not defined SACCHK exit /b 0
set "SACN="
for /f "usebackq tokens=1,* delims==" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -File "!SACCHK!" -Minutes 15`) do (
  if /i "%%A"=="COUNT" ( set "SACN=%%B" ) else ( set "SACLINE=%%A=%%B" )
)
if not defined SACN exit /b 0
if "!SACN!"=="0" exit /b 0
if "!SACN!"=="-1" exit /b 0
echo.
echo        🔴 Smart App Control が !SACN! 件をブロックしています（直近15分）:
rem COUNT= / OTHER= / UNKNOWN= は数なので、ブロックされたファイルの一覧に混ぜない
rem （以前は「OTHER=0 というファイルが止められている」と読めた）
for /f "usebackq tokens=*" %%L in (`powershell -NoProfile -ExecutionPolicy Bypass -File "!SACCHK!" -Minutes 15`) do (
  echo "%%L" | find "=" > nul || echo             %%L
)
echo           これが原因です。対処:
echo             1. インターネットに繋いで ウォームアップ.bat を実行する
echo                （SAC に判定を取らせる。1回で済まないことがあるので繰り返す）
echo             2. そのあとネットを切って再起動し、もう一度このバッチを実行する
echo           ＊ SAC をオフにする必要はありません。
exit /b 0

rem ------------------------------------------------------------
rem  127.0.0.1 の %COMFY_PORT% 番が待受しているかを PORT_OPEN に入れる
rem ------------------------------------------------------------
rem ------------------------------------------------------------
rem  ComfyUI が**本当に ComfyUI として応答するか**を見る。
rem
rem  ポートが LISTENING なだけでは足りない。前日の別プロジェクトの ComfyUI、
rem  モデルが載っていない ComfyUI、8188 番を掴んだ別のプログラムでも
rem  LISTENING になる（敵対的レビュー 2026-09-09 の指摘）。
rem
rem  ⚠️ モデル読み込み中は待受していても /system_stats が返らない。
rem     だから**これが 0 でも失敗とは断じない**（注意にとどめる）。
rem     アプリ側は app-ready で最大40秒待ってから判定する。
rem
rem  出力: COMFY_OK（1 なら ComfyUI として応答した）
rem ------------------------------------------------------------
:comfy_answers
set "COMFY_OK=0"
for /f "usebackq tokens=*" %%A in (`powershell -NoProfile -Command "try{ $r=Invoke-RestMethod -Uri 'http://127.0.0.1:%COMFY_PORT%/system_stats' -TimeoutSec 5 -ErrorAction Stop; if($r.system){'1'}else{'0'} }catch{ '0' }"`) do set "COMFY_OK=%%A"
exit /b 0

:is_port_open
set "PORT_OPEN=0"
netstat -ano -p tcp | findstr /r /c:"127.0.0.1:%COMFY_PORT% .*LISTENING" > nul 2>&1
if not errorlevel 1 set "PORT_OPEN=1"
if "%PORT_OPEN%"=="0" (
  netstat -ano -p tcp | findstr /r /c:"0.0.0.0:%COMFY_PORT% .*LISTENING" > nul 2>&1
  if not errorlevel 1 set "PORT_OPEN=1"
)
exit /b 0
