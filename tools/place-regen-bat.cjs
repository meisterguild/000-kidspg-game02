#!/usr/bin/env node
/**
 * 各結果フォルダに「AI画像を作り直す」バッチを置く（todo #12）
 *
 *   node tools/place-regen-bat.cjs            # 何を置くか表示するだけ（既定）
 *   node tools/place-regen-bat.cjs --apply    # 実際に置く
 *   node tools/place-regen-bat.cjs --apply --only 20260912_101112
 *   node tools/place-regen-bat.cjs --apply --remove   # 置いたバッチを片付ける
 *
 *   KIDSPG_RESULTS_DIR=D:\kidspg-2026\results node tools/place-regen-bat.cjs --apply
 *
 * ■ 何のためか
 * 「この子の絵がうまく出なかったので作り直したい」を、コマンドを覚えていない
 * スタッフでもできるようにする。結果フォルダを開いて `再生成.bat` を
 * ダブルクリックすれば、その回だけ作り直す。
 *
 * ■ 中身は薄いラッパにとどめる
 * 🔴 **作り直しの手順をバッチへ書き写さないこと。** 実処理は
 * tools/retry-failed.cjs が持っている（写真の上げ直し、LoadImage の差し替え、
 * カード合成、results.json の張り替え、保守ロックの取り合いまで）。
 * ここで手順を複製すると、片方だけ直したときに「バッチで作り直したカードだけ
 * 違う」が起きる。バッチは `retry-failed.cjs --apply --only <日時>` を呼ぶだけ。
 *
 * ■ リポジトリの場所
 * results/ は当日 PC やコピー先へ移動しうるので、バッチは自分の位置から
 * 上へ辿って package.json のあるフォルダを探す。見つからなければ
 * その旨を表示して止まる（黙って何もしないより分かる）。
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BAT_NAME = '再生成.bat';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const APPLY = has('apply');
const REMOVE = has('remove');
const ONLY = flag('only');

const resultsDir = process.env.KIDSPG_RESULTS_DIR
  ? path.resolve(process.env.KIDSPG_RESULTS_DIR)
  : path.join(ROOT, 'results');

/**
 * バッチの中身。
 * 先頭は ASCII だけにする（日本語のコンソールで UTF-8 のファイルを読むと、
 * 2バイト目に 0x7C '|' や 0x26 '&' を含む文字で行が割れて別のコマンドが走る。
 * start-kidspg.bat と同じ理由・同じ書き方）。
 */
const batBody = (dt) => `@echo off
rem ---------------------------------------------------------------
rem  ASCII-only bootstrap. DO NOT put Japanese text above ":main".
rem  A Japanese (CP932) console mis-parses this UTF-8 file.
rem ---------------------------------------------------------------
chcp 65001 > nul
if "%KIDSPG_REGEN%"=="1" goto :main
set "KIDSPG_REGEN=1"
cmd /d /c ""%~f0" %*"
exit /b %errorlevel%

:main
setlocal
title KidsPG - ${dt} の絵を作り直す
cd /d "%~dp0"

rem このバッチの場所から上へ辿って、package.json のあるフォルダを探す
set "REPO="
set "DIR=%~dp0"
:find
if exist "%DIR%package.json" (
  set "REPO=%DIR%"
  goto :found
)
for %%I in ("%DIR%..") do set "PARENT=%%~fI\\"
if "%PARENT%"=="%DIR%" goto :notfound
set "DIR=%PARENT%"
goto :find

:notfound
echo ============================================================
echo   アプリのフォルダが見つかりませんでした
echo ============================================================
echo.
echo   このバッチは results\\${dt}\\ の中に置かれている前提です。
echo   results フォルダだけを別の場所へコピーした場合は、
echo   アプリのフォルダで次を実行してください:
echo.
echo     node tools\\retry-failed.cjs --apply --only ${dt}
echo.
pause
exit /b 1

:found
echo ============================================================
echo   ${dt} の絵を作り直します
echo   アプリのフォルダ : %REPO%
echo ============================================================
echo.
echo   ＊ ComfyUI が起動している必要があります
echo   ＊ この機体では1枚あたり約3分かかります。閉じずに待ってください
echo.
set "KIDSPG_RESULTS_DIR=%~dp0.."
node "%REPO%tools\\retry-failed.cjs" --apply --only ${dt}
set "RC=%errorlevel%"
echo.
if "%RC%"=="0" (
  echo   終わりました。フォルダの memorial_card_${dt}.png を確認してください
) else (
  echo   [失敗] 終了コード %RC%
  echo   ComfyUI が動いているか、上のメッセージを確認してください
)
echo.
pause
endlocal
exit /b %RC%
`;

/**
 * 🔴 **バッチは必ず CRLF で書く。**
 * LF だけで書くと cmd が行を正しく切れず、`cmd /d /c` の `/d` を別の
 * コマンドとして実行しようとする（2026-09-07 に実際に踏んだ）。
 * 日本語の行も途中で割れて、断片がコマンドとして走る。
 * Git の設定や OS に依存させず、ここで明示的に CRLF へ揃える。
 */
const batContent = (dt) => batBody(dt).split('\n').join('\r\n');

const main = async () => {
  if (!fs.existsSync(resultsDir)) {
    console.error(`results フォルダがありません: ${resultsDir}`);
    process.exit(1);
  }
  console.log(`[regen-bat] 対象   : ${resultsDir}`);
  console.log(`[regen-bat] モード : ${APPLY ? (REMOVE ? '削除' : '設置') : 'ドライラン（表示のみ）'}`);

  const dirs = (await fsp.readdir(resultsDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^\d{8}_\d{6}$/.test(e.name))
    .map((e) => e.name)
    .filter((name) => !ONLY || name === ONLY)
    .sort();

  if (dirs.length === 0) {
    console.log('[regen-bat] 対象の回がありません');
    return;
  }

  let changed = 0;
  for (const dt of dirs) {
    const target = path.join(resultsDir, dt, BAT_NAME);
    if (REMOVE) {
      if (!fs.existsSync(target)) continue;
      console.log(`   削除 ${dt}\\${BAT_NAME}`);
      if (APPLY) await fsp.unlink(target);
      changed += 1;
      continue;
    }
    const content = batContent(dt);
    if (fs.existsSync(target) && (await fsp.readFile(target, 'utf-8')) === content) continue;
    console.log(`   設置 ${dt}\\${BAT_NAME}`);
    if (APPLY) await fsp.writeFile(target, content, 'utf-8');
    changed += 1;
  }

  console.log('');
  if (changed === 0) {
    console.log('[regen-bat] 変更はありません');
  } else if (APPLY) {
    console.log(`[regen-bat] 完了: ${changed} 件`);
  } else {
    console.log(`[regen-bat] ドライランなので何もしていません（${changed} 件が対象）。--apply を付けてください`);
  }
};

main().catch((error) => {
  console.error('[regen-bat] 失敗:', error.message);
  process.exit(1);
});
