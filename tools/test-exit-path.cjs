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
  // 🔴 `armForceExit()` は**定義行 `private armForceExit(): void {` 自身**にも
  //    一致する。実測（3巡目）: 呼び出し2か所を両方消しても4件すべて緑だった。
  //    保険が武装されないと、2026-09-04 に起きた「プロセスが残って単一インスタンス
  //    ロックを握り、start-kidspg.bat で二度と起動できない」がそのまま戻る。
  const calls = (stripComments(main).match(/this\.armForceExit\(\)/g) || []).length;
  assert.ok(
    calls >= 2,
    'armForceExit が呼ばれていません（' + calls + ' か所。終了要求と window-all-closed の2経路が要ります）'
  );
  // 🔴 呼ばれていても本体が空なら保険にならない（実測: 先頭に return; を
  //    入れても4件すべて緑だった）。本体まで見る。
  const defAt = main.indexOf('private armForceExit(');
  assert.ok(defAt > 0, 'armForceExit の定義がありません');
  const end = main.slice(defAt).search(/\r?\n {2}\}/);
  assert.ok(end > 0, 'armForceExit の本体を切り出せません');
  const body = main.slice(defAt, defAt + end);
  assert.match(body, /setTimeout/, 'armForceExit が猶予を置いていません');
  assert.match(body, /app\.exit\(0\)/, 'armForceExit が強制終了していません');
  // 本体の**最初の文**が return; だと、呼ばれても何もしない（実測で素通りした）
  const first = body.slice(body.indexOf('{') + 1).trim().split(/\r?\n/)[0].trim();
  assert.ok(!/^return;?$/.test(first), 'armForceExit の本体が潰されています: ' + first);
});
