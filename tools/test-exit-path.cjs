'use strict';

/**
 * 終了経路の配線を守るテスト。
 *
 * 2026-09-04 に実機で起きたこと:
 *   画面の「終了」ボタンが `window.close()` を呼んでいた。あれはウィンドウを
 *   即座に破棄し、`mainWindow.on('close')` の preventDefault が間に合わない。
 *   その結果
 *     ・**終了確認ダイアログが一度も出なかった**（生成中でも警告できない）
 *     ・exitConfirmed が false のまま window-all-closed へ落ち、
 *       **画面が無いのにプロセスだけ残った**
 *     ・アプリは requestSingleInstanceLock で二重起動を防ぐため、
 *       残ったプロセスがロックを握り、**start-kidspg.bat で二度と起動できなかった**
 *
 * どれも画面には何も出ないので、壊れても気づけない。動作テストの土台
 * （レンダラー用の jsdom 等）がこのリポジトリには無いため、
 * せめて配線が外れたことだけは検知できるようにしておく。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf-8');

/** コメント行を落とす（説明文に書いた語で判定を汚さないため） */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

test('レンダラーは window.close() で終了しない（確認ダイアログを飛ばすため）', () => {
  const files = ['src/renderer/components/NavBar.tsx', 'src/renderer/App.tsx'];
  for (const rel of files) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    const code = stripComments(read(rel));
    assert.ok(
      !/window\s*\.\s*close\s*\(/.test(code),
      `${rel} が window.close() を呼んでいます。main へ requestExit() を投げてください`
    );
  }
});

test('終了要求の口が main と preload の両方に配線されている', () => {
  const main = read('src/main/main.ts');
  assert.match(
    main,
    /ipcMain\.handle\(\s*'request-exit'/,
    "main.ts に 'request-exit' のハンドラがありません"
  );
  const preload = read('src/main/preload.ts');
  assert.match(
    preload,
    /requestExit:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(\s*'request-exit'/,
    'preload.ts が requestExit を公開していません'
  );
  const navBar = read('src/renderer/components/NavBar.tsx');
  assert.match(
    navBar,
    /requestExit\s*\(/,
    'NavBar.tsx の「終了」ボタンが requestExit() を呼んでいません'
  );
});

test('ウィンドウが全部閉じたら、確認の有無にかかわらず終了する', () => {
  const main = stripComments(read('src/main/main.ts'));
  const handler = main.match(/app\.on\(\s*'window-all-closed'[\s\S]*?\n {4}\}\);/);
  assert.ok(handler, "window-all-closed のハンドラを見つけられませんでした");
  const body = handler[0];
  assert.ok(
    /app\.quit\(\)/.test(body),
    'window-all-closed が app.quit() を呼んでいません'
  );
  assert.ok(
    !/if\s*\(\s*this\.exitConfirmed\s*\)/.test(body),
    'window-all-closed が exitConfirmed で終了を止めています。' +
      'ここへ来た時点で画面は無く、残るとロックを握ったままになります'
  );
});

test('終了が終わらないときの強制終了の保険が残っている', () => {
  const main = read('src/main/main.ts');
  assert.match(main, /QUIT_FORCE_EXIT_MS/, '強制終了までの猶予の定数がありません');
  assert.match(main, /app\.exit\(0\)/, 'app.exit による最後の手段がありません');
  assert.match(
    stripComments(main),
    /armForceExit\(\)/,
    'armForceExit が呼ばれていません'
  );
});
