@echo off
rem ---------------------------------------------------------------
rem  ASCII-only bootstrap. DO NOT put Japanese text above ":main".
rem  A Japanese (CP932) console mis-parses this UTF-8 file: some
rem  characters contain bytes like 0x7C '|' or 0x26 '&' in their
rem  second byte, so cmd would split the lines and run garbage.
rem ---------------------------------------------------------------
chcp 65001 > nul
if "%KIDSPG_WARMUP_BOOT%"=="1" goto :main
set "KIDSPG_WARMUP_BOOT=1"
if not "%KIDSPG_WARMUP_BOOT%"=="1" goto :noenv
cmd /d /c ""%~f0" %*"
exit /b %errorlevel%
:noenv
echo [ERROR] Could not set an environment variable. Aborted.
pause
exit /b 1

:main
setlocal enabledelayedexpansion
title KidsPG AIグミパク - 暖機（Smart App Control 対策）
cd /d "%~dp0"

rem ============================================================
rem  暖機（ウォームアップ）
rem
rem  🔴 **前日までに、インターネットに繋いだ状態で1回だけ実行する。**
rem
rem  ■ 何のためか
rem  Windows 11 の Smart App Control（SAC）は、署名の無い実行ファイルを
rem  読み込むときにクラウドへ評価を問い合わせ、**判定が返るまでブロックする**。
rem  ComfyUI が読む .pyd（scipy・torch など数百個）はすべて署名が無いため、
rem  初めて読む時にこれに当たる。
rem
rem  2026-09-09 の実測:
rem    ・開発機（SAC 有効）で、新しく置いた scipy の .pyd がブロックされて
rem      ComfyUI が落ちた。**そのまま再実行したら通った**
rem    ・同じ内容（SHA256 一致）のファイルが、前から置いてあった方は
rem      問題なく動いていた
rem  つまり SAC は「中身が悪い」と言っているのではなく、
rem  **判定を取りに行っている間だけ止めている**。
rem
rem  ■ だから当日オフラインだと困る
rem  評価はクラウドへの問い合わせなので、オフラインでは判定が取れない。
rem  そこで**前日までにオンラインで一度ぜんぶ読ませ、判定を取り切っておく**。
rem  これが暖機。SAC をオフにする必要はない。
rem
rem  ■ このバッチがやること
rem    1. いまの時刻を記録する
rem    2. アプリと ComfyUI を起動して準備完了まで通す（= ほぼ全部を読ませる）
rem    3. 1枚生成する（= 生成に使う部分も読ませる）
rem    4. 記録した時刻以降に SAC がブロックしたものを一覧で出す
rem
rem  ■ 使い方
rem    1回目: ブロックが出ることがある。**出たらもう一度実行する**
rem    2回目以降: ブロックが 0 件になれば暖機できている
rem    そのあと: ネットを切って**PCを再起動**し、start-kidspg.bat で
rem              ★★★ 準備完了 ★★★ が出ることを確かめる（これが本番の形）
rem ============================================================

set "PS=powershell -NoProfile -ExecutionPolicy Bypass"
set "SACCHECK=%~dp0ops\tools\onsite\check-sac-blocks.ps1"

echo ============================================================
echo   暖機（Smart App Control に判定を取らせる）
echo   %date% %time:~0,8%
echo ============================================================
echo.
echo   🔴 このバッチは**インターネットに繋いだ状態**で実行してください。
echo      オフラインでは SAC が判定を取れないため、暖機になりません。
echo.

rem ------------------------------------------------------------
echo [1/4] 開始時刻を記録します
for /f "usebackq tokens=*" %%A in (`%PS% -Command "(Get-Date).ToString('s')"`) do set "T0=%%A"
if not defined T0 (
  echo        [中止] 時刻を取得できませんでした。
  goto :done
)
echo        %T0% 以降のブロックを見ます
echo.

rem ------------------------------------------------------------
echo [2/4] アプリと ComfyUI を起動して準備完了まで通します
if not exist "%~dp0app\start-kidspg.bat" (
  echo        [中止] app\start-kidspg.bat が見つかりません。
  echo               このバッチは C:\kidspg の直下に置いて実行してください。
  goto :done
)
call "%~dp0app\start-kidspg.bat" < nul
echo.

rem ------------------------------------------------------------
echo [3/4] 1枚生成します（生成に使う部分も読ませるため。CPU で数分）
if not exist "%~dp0ops\node\node.exe" (
  echo        [注意] ops\node\node.exe が無いので生成の暖機は飛ばします
) else (
  pushd "%~dp0ops"
  "%~dp0ops\node\node.exe" tools\comfyui-smoke.cjs --timeout-min 20
  if errorlevel 1 (
    echo        [注意] 生成が通りませんでした。下のブロック一覧を見てください
  )
  popd
)
echo.

rem ------------------------------------------------------------
echo [4/4] Smart App Control がブロックしたもの
set "SACCOUNT="
if not exist "!SACCHECK!" (
  echo        [注意] 点検スクリプトが見つかりません : !SACCHECK!
  goto :done
)
for /f "usebackq tokens=1,* delims==" %%A in (`%PS% -File "!SACCHECK!" -Since "!T0!"`) do (
  if /i "%%A"=="COUNT" ( set "SACCOUNT=%%B" ) else ( echo        %%A=%%B )
)

echo.
echo ============================================================
rem 「else if」の連鎖は cmd では書き方によって黙って外れるので使わない
if "!SACCOUNT!"=="0" goto :sac_clean
if "!SACCOUNT!"=="-1" goto :sac_unknown
goto :sac_blocked

:sac_clean
echo   ★★★ 暖機できました ★★★  ブロックは 0 件です
echo.
echo   次にやること
echo     1. インターネットを切る
echo     2. **PCを再起動する**
echo     3. app\start-kidspg.bat を実行し、★★★ 準備完了 ★★★ が出るか見る
echo        ここまで通れば当日の形（オフライン）で動くことが確かめられます
goto :sac_done

:sac_unknown
echo   ★ 確かめられませんでした（イベントログを読めません）
echo     権限のある状態で実行し直すか、当日は AI 変換なしの退避を用意してください
goto :sac_done

:sac_blocked
echo   ★ ブロックが !SACCOUNT! 件ありました
echo.
echo   **もう一度このバッチを実行してください。**
echo   SAC は判定を取りに行っている間だけ止めるので、
echo   2回目以降は通ることがあります（2026-09-09 の実測ではそうなりました）。
echo.
echo   何度やっても 0 件にならない場合:
echo     ・インターネットに繋がっているか確認してください
echo     ・それでも駄目なら、当日は AI 変換を切る退避を検討してください
echo       （config.json の comfyui セクションを外す。カードの絵は
echo         全員同じプレースホルダになりますが、ゲームとカードは動きます）

:sac_done
echo ============================================================

:done
echo.
pause
exit /b 0
