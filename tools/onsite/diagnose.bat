@echo off
rem ---------------------------------------------------------------
rem  ASCII-only bootstrap. DO NOT put Japanese text above "chcp".
rem  A Japanese (CP932) console mis-parses this UTF-8 file: the
rem  second byte of some characters is 0x7C '|' or 0x26 '&', which
rem  splits the line and runs the fragment as a command.
rem ---------------------------------------------------------------
chcp 65001 > nul
if "%KIDSPG_DIAG%"=="1" goto :main

rem ------------------------------------------------------------
rem  1回目はここ。結果を**このバッチと同じ場所**へ残してから、
rem  同じファイルをもう一度呼ぶ。USB から実行しても USB にログが残る。
rem  🔴 中の処理では pause を使わない（出力を横取りしているので、
rem     待ち受けても画面に何も出ず固まったように見えるため）。
rem ------------------------------------------------------------
set "STAMP="
for /f "tokens=*" %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "STAMP=%%T"
if not defined STAMP set "STAMP=unknown"
set "LOG=%~dp0診断ログ_%STAMP%.txt"
rem 書けない場所（読み取り専用の USB 等）なら %TEMP% へ逃がす
> "%LOG%" echo. 2>nul
if not exist "%LOG%" set "LOG=%TEMP%\kidspg-診断ログ_%STAMP%.txt"

set "KIDSPG_DIAG=1"
cmd /d /c ""%~f0" %*" > "%LOG%" 2>&1
type "%LOG%"
echo.
echo ============================================================
echo   このログを保存しました:
echo     %LOG%
echo   うまくいかないときは、このファイルをそのまま送ってください。
echo ============================================================
echo.
pause
exit /b 0

:main
setlocal enabledelayedexpansion

rem ============================================================
rem  当日PCの「動かない」を切り分けて、直せるものはその場で直す。
rem
rem  ■ 何のためか
rem  0_セットアップ.bat は 60,000 ファイルのハッシュ照合をするので
rem  数分〜十数分かかる。**確認と微調整のたびに回すのは時間の無駄**なので、
rem  コピーも照合もせず、動作の確認と暖機だけをやるものを分けた。
rem  何度でも実行してよい（何も壊さない）。
rem
rem  ■ とくに見るもの
rem  🔴 携帯版の ImageMagick は、PNG などを読み書きする**コーダー DLL**の
rem  置き場をレジストリから引く。インストールしていない当日PCにはキーが無いので
rem  環境変数で教える必要があり、さらにその DLL は**未署名**なので
rem  Smart App Control の判定を取っていないと止められる。
rem  ウォームアップ.bat は ComfyUI しか動かしていなかったため、
rem  ImageMagick のぶんの判定が取れていなかった（2026-09-10 に実機で発覚）。
rem
rem  ■ 使い方
rem    診断と修復.bat            … 確認と暖機だけ
rem    診断と修復.bat /fix       … 失敗した回のカードも作り直す
rem
rem  ■ 置き場所
rem  既定は C:\kidspg。KIDSPG_TARGET で差し替えられる
rem  （開発機で配布物そのものを相手に通しテストするために要る）。
rem ============================================================

set "TARGET=C:\kidspg"
if defined KIDSPG_TARGET set "TARGET=%KIDSPG_TARGET%"
if not "%~1"=="" if /i "%~1"=="/fix" set "DOFIX=1"
set "NG=0"

echo ============================================================
echo   KidsPG「AIグミパク！」 診断と修復
echo   %date% %time:~0,8%
echo ============================================================
echo.
echo   ＊ コピーも照合もしません。何度でも実行して構いません。
echo   ＊ Smart App Control の判定を取り直すときは、
echo      **インターネットに繋いでから**実行してください。
echo.

rem ------------------------------------------------------------
echo [1/5] 置き場所と部品
if not exist "%TARGET%\app\start-kidspg.bat" (
  echo        [NG] %TARGET% にセットアップされていません。
  echo             先に USB の 0_セットアップ.bat を実行してください。
  rem 🔴 中止でも NG を数える。数えないと、下のまとめが
  rem    「問題は見つかりませんでした」と嘘をつく（実測で踏んだ）。
  set /a NG+=1
  goto :finish
)
echo        OK : %TARGET%

set "MAGICK=%TARGET%\bin\ImageMagick\magick.exe"
set "IMDIR=%TARGET%\bin\ImageMagick"
if not exist "!MAGICK!" (
  echo        [NG] ImageMagick がありません : !MAGICK!
  set /a NG+=1
  goto :finish
)
echo        OK : magick.exe

set "CODERS=!IMDIR!\modules\coders"
if not exist "!CODERS!" (
  echo        [NG] コーダーの置き場がありません : !CODERS!
  echo             パッケージの作り直しが要ります。
  set /a NG+=1
  goto :finish
)
set "CODERN=0"
for %%F in ("!CODERS!\IM_MOD_RL_*.dll") do set /a CODERN+=1
echo        OK : コーダー !CODERN! 個 : !CODERS!

set "NODEEXE=%TARGET%\ops\node\node.exe"
if exist "!NODEEXE!" (
  echo        OK : Node
) else (
  echo        [注意] Node がありません（作り直しツールが使えません）: !NODEEXE!
)
echo.

rem ------------------------------------------------------------
echo [2/5] ImageMagick に置き場を教える
rem 🔴 環境変数はレジストリより優先される（開発機で実測）。
set "MAGICK_HOME=!IMDIR!"
set "MAGICK_CODER_MODULE_PATH=!CODERS!"
if exist "!IMDIR!\modules\filters" set "MAGICK_FILTER_MODULE_PATH=!IMDIR!\modules\filters"
if exist "!IMDIR!\colors.xml" set "MAGICK_CONFIGURE_PATH=!IMDIR!"
echo        MAGICK_CODER_MODULE_PATH=!MAGICK_CODER_MODULE_PATH!
echo        MAGICK_HOME=!MAGICK_HOME!
echo.

rem ------------------------------------------------------------
echo [3/5] Smart App Control のブロック（実行前）
set "SACPS=%TARGET%\ops\tools\onsite\check-sac-blocks.ps1"
call :show_sac
echo.

rem ------------------------------------------------------------
echo [4/5] ImageMagick を実際に動かす
rem 🔴 **"-version" で確かめてはいけない。** コーダーを読み込まないので、
rem    PNG を1枚も扱えない状態でも成功する（実測）。
rem
rem 🔴 **失敗したときは「なぜ」まで出す。** 当日PCで
rem    「unable to load module ... 指定されたモジュールが見つかりません」
rem    が出たとき、原因（依存の不在／探索の届かなさ／セキュリティのブロック）を
rem    切り分けられず、実機を何度も往復させてしまった。
rem    check-imagemagick.ps1 が LoadLibrary を直に呼んで Win32 の番号で判定し、
rem    直せるもの（探索の届かなさ）はその場で直す。
set "IMCHECK=%~dp0check-imagemagick.ps1"
if not exist "!IMCHECK!" set "IMCHECK=%TARGET%\ops\tools\onsite\check-imagemagick.ps1"
set "IMRESULT="
if exist "!IMCHECK!" (
  for /f "usebackq tokens=*" %%L in (`powershell -NoProfile -ExecutionPolicy Bypass -File "!IMCHECK!" -Dir "!IMDIR!" -Fix`) do call :im_line "%%L"
) else (
  echo        ＊ 詳しい点検スクリプトがありません : !IMCHECK!
)
if defined IMRESULT echo        判定 : !IMRESULT!
echo.

set "ERRFILE=%TEMP%\kidspg-magick-err.txt"
set "PROBEPNG=%TEMP%\kidspg-probe.png"
set "TRY=0"

:im_retry
set /a TRY+=1
set "IM_OK="
del "%PROBEPNG%" > nul 2>&1
"!MAGICK!" -size 4x4 xc:white "PNG:%PROBEPNG%" 2> "%ERRFILE%"
if errorlevel 1 goto :im_failed
if not exist "%PROBEPNG%" goto :im_failed

rem 本物のカード土台（2.4MB の PNG）も読めるか
set "BASEPNG="
for %%F in ("%TARGET%\app\card_base_images\bg-card-rank-*.png") do if not defined BASEPNG set "BASEPNG=%%~fF"
if not defined BASEPNG (
  echo        [NG] カードの土台画像がありません : %TARGET%\app\card_base_images
  set /a NG+=1
  goto :im_done
)
"!MAGICK!" identify "!BASEPNG!" > nul 2> "%ERRFILE%"
if errorlevel 1 goto :im_failed
set "IM_OK=1"
echo        OK : 4x4 の PNG を書けました
echo        OK : カードの土台を読めました（%TRY% 回目）
goto :im_done

:im_failed
echo.
echo        [NG] %TRY% 回目 — ImageMagick が PNG を扱えません。エラーは次のとおり:
echo        ------------------------------------------------------------
type "%ERRFILE%" 2>nul
echo        ------------------------------------------------------------
findstr /i /c:"RegistryKeyLookupFailed" "%ERRFILE%" > nul 2>&1
if not errorlevel 1 echo        （コーダーの置き場を見つけられていません）
findstr /i /c:"ブロック" /c:"blocked" /c:"policy" /c:"アクセスが拒否" "%ERRFILE%" > nul 2>&1
if not errorlevel 1 echo        （Smart App Control に止められています）
echo.
if %TRY% GEQ 3 goto :im_give_up
echo        6 秒待ってもう一度試します（%TRY%/3 回目）
echo        ＊ Smart App Control はクラウドへ判定を問い合わせている間だけ
echo           止めるので、ネットに繋いでいれば数秒で通ることがあります。
ping -n 7 127.0.0.1 > nul
goto :im_retry

:im_give_up
echo        [NG] 3 回試しましたが通りませんでした。
echo.
echo        🔴 **インターネットに繋いでから、このバッチをもう一度実行してください。**
echo           コーダーの DLL は未署名なので、Smart App Control が
echo           判定を取り切るまで止められます。判定は一度取れば残ります。
set /a NG+=1

:im_done
del "%PROBEPNG%" > nul 2>&1
echo.

rem ------------------------------------------------------------
echo [5/5] カードの合成が通るか（アプリと同じ経路）
if not defined IM_OK (
  echo        ＊ ImageMagick が通っていないので飛ばします（上の [NG] を先に直す）
  goto :after_fix
)
if not exist "!NODEEXE!" (
  echo        ＊ Node が無いので飛ばします（作り直しツールが使えません）
  set /a NG+=1
  goto :after_fix
)
pushd "%TARGET%\ops"
"!NODEEXE!" dist\main\test\memorial-card-recovery.js --check-compose
if errorlevel 1 (
  echo        [NG] 合成の点検が通りませんでした（上の行を確認してください）
  set /a NG+=1
) else (
  echo        OK : 合成に必要なものは揃っています
)
popd
echo.

if not defined DOFIX goto :after_fix
echo        失敗した回のカードを作り直します（/fix が指定されました）
pushd "%TARGET%\ops"
"!NODEEXE!" tools\retry-failed.cjs --apply
popd
echo.

:after_fix

rem ------------------------------------------------------------
echo [おまけ] Smart App Control のブロック（実行後）
call :show_sac
echo.

:finish
echo ============================================================
if "!NG!"=="0" (
  echo   ★★★ 問題は見つかりませんでした ★★★
  echo.
  echo   次にやること
  echo     1. インターネットを切る（Wi-Fi をオフ。「手動」で戻す設定に）
  echo     2. %TARGET%\app\start-kidspg.bat を実行
  echo     3. ★★★ 準備完了 ★★★ が出たら 1 プレイ通す
  echo     4. results\^<日時^>\memorial_card_*.png ができていれば成功
  echo.
  echo   ＊ 失敗した回のカードを作り直すなら、このバッチに /fix を付けて実行
) else (
  echo   気になる点が !NG! 件あります（上の [NG] を確認してください）。
  echo.
  echo   よくある原因
  echo     ・Smart App Control … ネットに繋いでこのバッチをもう一度実行する
  echo     ・コピー漏れ        … USB の 0_セットアップ.bat をやり直す
  echo.
  echo   直らないときは、このログと %TARGET%\app\logs\app.log を送ってください。
)
echo ============================================================
endlocal
exit /b 0

rem ------------------------------------------------------------
rem  Smart App Control のブロックを表示する。
rem  読めない環境もあるので、読めなくても止めない。
rem
rem  🔴 このサブルーチンは exit /b 0 の後ろに置くこと。
rem     前に置くと通常の流れが通り抜けて勝手に走る。
rem ------------------------------------------------------------
:show_sac
if not exist "!SACPS!" (
  echo        ＊ 点検スクリプトがありません : !SACPS!
  exit /b 0
)
set "SACC="
set "SACO="
set "SACU="
set "SACLIST="
for /f "usebackq tokens=1,* delims==" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -File "!SACPS!" -Minutes 180`) do call :sac_line "%%A" "%%B"
if not defined SACC (
  echo        ＊ 読み取れませんでした
  exit /b 0
)
if "!SACC!"=="-1" (
  echo        ＊ イベントログを読めません（権限）
  exit /b 0
)
echo        自分たちのファイルのブロック : !SACC! 件（無関係 !SACO! 件／不明 !SACU! 件）
exit /b 0

rem ------------------------------------------------------------
rem  check-imagemagick.ps1 の出力をそのまま見せつつ、
rem  末尾の RESULT= の行だけ覚えておく。
rem ------------------------------------------------------------
:im_line
set "L=%~1"
echo        !L!
echo !L! | findstr /b /c:"RESULT=" > nul 2>&1
if not errorlevel 1 set "IMRESULT=!L!"
goto :eof

rem ------------------------------------------------------------
rem  点検スクリプトの出力を1行ずつ振り分ける。
rem  一覧は echo !K! で出す（%%K%% だと、パスに ^& が入っていたときに
rem  展開後の文字がコマンドとして再解釈される）。
rem ------------------------------------------------------------
:sac_line
set "K=%~1"
set "V=%~2"
if /i "!K!"=="COUNT" set "SACC=!V!" & goto :eof
if /i "!K!"=="OTHER" set "SACO=!V!" & goto :eof
if /i "!K!"=="UNKNOWN" set "SACU=!V!" & goto :eof
if "!K!"=="" goto :eof
if not defined SACLIST echo        ブロックされたファイル: & set "SACLIST=1"
echo          !K!
goto :eof
