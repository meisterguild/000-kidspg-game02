'use strict';

/**
 * 結果フォルダに置く「再生成.bat」のテスト。
 *
 * 🔴 **バッチは CRLF でないと動かない。**
 * 最初に LF だけで書いて実際に壊れた（2026-09-07）。cmd が行を正しく切れず、
 * `cmd /d /c` の `/d` を別のコマンドとして実行しようとし、日本語の行も
 * 途中で割れて断片がコマンドとして走った。**画面には英語のエラーが数行出るだけ**で、
 * 何が起きたのか分からない壊れ方をする。
 *
 * あわせて「手順を複製していないこと」も見る。作り直しの実処理は
 * retry-failed.cjs が持っており、バッチはそれを呼ぶだけであるべき。
 * バッチ側に手順を書き写すと、片方だけ直したときに
 * 「バッチで作り直したカードだけ違う」が起きる。
 *
 *   node --test tools/test-regen-bat.cjs
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'place-regen-bat.cjs');
const BAT_NAME = '再生成.bat';
const DT = '20260912_101112';

const makeResults = (dts = [DT]) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regenbat-test-'));
  for (const dt of dts) {
    fs.mkdirSync(path.join(dir, dt), { recursive: true });
    fs.writeFileSync(path.join(dir, dt, 'result.json'), '{}');
  }
  return dir;
};

const run = (resultsDir, args = []) =>
  execFileSync(process.execPath, [TOOL, ...args], {
    env: { ...process.env, KIDSPG_RESULTS_DIR: resultsDir },
    encoding: 'utf-8',
  });

const readBat = (dir, dt = DT) =>
  fs.readFileSync(path.join(dir, dt, BAT_NAME), 'utf-8');

test('既定はドライラン。バッチは置かれない', () => {
  const dir = makeResults();
  try {
    const out = run(dir);
    assert.match(out, /ドライラン/);
    assert.ok(!fs.existsSync(path.join(dir, DT, BAT_NAME)), 'ドライランなのに置かれました');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('改行が CRLF で書かれる（LF だと cmd が行を切れずに壊れる）', () => {
  const dir = makeResults();
  try {
    run(dir, ['--apply']);
    const raw = fs.readFileSync(path.join(dir, DT, BAT_NAME));
    const text = raw.toString('utf-8');
    const lfOnly = [...text.matchAll(/(?<!\r)\n/g)].length;
    assert.strictEqual(lfOnly, 0, `CRLF でない改行が ${lfOnly} 箇所あります`);
    assert.ok(text.includes('\r\n'), '改行が1つもありません');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('日本語は :main より下だけに置く（CP932 で先頭が壊れないように）', () => {
  const dir = makeResults();
  try {
    run(dir, ['--apply']);
    const text = readBat(dir);
    // 🔴 indexOf(':main') では駄目。冒頭のコメントに ":main" という語が出るため
    // 切り出す位置が手前になり、chcp の行まで落ちてしまう（テストの誤検知）。
    // ラベル行そのもの（行頭の :main）を探す。
    const labelAt = text.indexOf('\r\n:main\r\n');
    assert.ok(labelAt > 0, ':main ラベルの行が見つかりません');
    const head = text.slice(0, labelAt);
    // eslint-disable-next-line no-control-regex
    const nonAscii = head.match(/[^\x00-\x7F]/g);
    assert.strictEqual(
      nonAscii,
      null,
      `:main より上に非 ASCII があります: ${nonAscii && nonAscii.join('')}`
    );
    assert.match(head, /chcp 65001/, '文字コードの切り替えが先頭にありません');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('作り直しの手順を複製せず retry-failed.cjs へ委譲する', () => {
  const dir = makeResults();
  try {
    run(dir, ['--apply']);
    const text = readBat(dir);
    assert.ok(
      text.includes('retry-failed.cjs" --apply --only ' + DT),
      '委譲していません'
    );
    // 手順の複製に当たるもの（ComfyUI を直接叩く・magick を直接呼ぶ）が無いこと
    for (const forbidden of ['/prompt', 'upload/image', 'magick', 'LoadImage']) {
      assert.ok(
        !text.includes(forbidden),
        `バッチが手順を複製しています（${forbidden} が含まれています）`
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('その回の日時だけを対象にする（他の子を作り直さない）', () => {
  const other = '20260912_101200';
  const dir = makeResults([DT, other]);
  try {
    run(dir, ['--apply']);
    assert.match(readBat(dir, DT), new RegExp(`--only ${DT}`));
    assert.match(readBat(dir, other), new RegExp(`--only ${other}`));
    assert.ok(!readBat(dir, DT).includes(other), '他の回の日時が混ざっています');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('results だけコピーされた場合に備えて案内を出す', () => {
  const dir = makeResults();
  try {
    run(dir, ['--apply']);
    const text = readBat(dir);
    assert.match(text, /package\.json/, 'リポジトリを探す処理がありません');
    assert.match(text, /:notfound/, '見つからなかったときの分岐がありません');
    // 🔴 正規表現にしないこと。`tools\retry-failed` の \r が
    // 復帰文字として解釈され、いつまでも一致しない（テストの誤検知）。
    assert.ok(
      text.includes('node tools' + String.fromCharCode(92) + 'retry-failed.cjs --apply --only'),
      '手動での実行方法の案内がありません'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--remove で片付けられる', () => {
  const dir = makeResults();
  try {
    run(dir, ['--apply']);
    assert.ok(fs.existsSync(path.join(dir, DT, BAT_NAME)));
    run(dir, ['--apply', '--remove']);
    assert.ok(!fs.existsSync(path.join(dir, DT, BAT_NAME)), '片付けられていません');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('二度置いても内容が同じなら何もしない', () => {
  const dir = makeResults();
  try {
    run(dir, ['--apply']);
    const out = run(dir, ['--apply']);
    assert.match(out, /変更はありません/, '同じ内容なのに書き直しています');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
