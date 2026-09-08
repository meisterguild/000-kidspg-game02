'use strict';

/**
 * 写真削除ツールのテスト。
 *
 * 🔴 **消すツールなので、テスト無しで当日に持ち込めない。**
 * 間違って消すもの・消し忘れるものの両方が取り返しのつかない結果になる。
 *   ・AI画像やカードまで消す → 後日の公開物が失われる
 *   ・カード未完成の回の写真を消す → 二度と作り直せない
 *   ・ドライランで消してしまう → 確認のつもりが本番
 *
 * 本物の results/ には触らず、一時フォルダを KIDSPG_RESULTS_DIR で渡して確かめる。
 *
 *   npm run build && node --test tools/test-purge-photos.cjs
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'purge-photos.cjs');

/** 中身のある本物の PNG（1x1）。png-integrity が完全と判定できるもの */
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
/** 末尾（IEND）を落とした壊れた PNG */
const BROKEN_PNG = VALID_PNG.subarray(0, VALID_PNG.length - 8);

const makeResults = (plays) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-test-'));
  for (const play of plays) {
    const d = path.join(dir, play.dt);
    fs.mkdirSync(d, { recursive: true });
    if (play.photo !== false) fs.writeFileSync(path.join(d, `photo_${play.dt}.png`), VALID_PNG);
    if (play.anime !== false) {
      fs.writeFileSync(path.join(d, `photo_anime_${play.dt}_00001_.png`), VALID_PNG);
    }
    if (play.card === 'broken') {
      fs.writeFileSync(path.join(d, `memorial_card_${play.dt}.png`), BROKEN_PNG);
    } else if (play.card !== false) {
      fs.writeFileSync(path.join(d, `memorial_card_${play.dt}.png`), VALID_PNG);
    }
    fs.writeFileSync(path.join(d, 'image_generate.json'), '{}');
    if (play.result !== false) {
      fs.writeFileSync(
        path.join(d, 'result.json'),
        JSON.stringify({ nickname: 'てすと', score: 100, imagePath: `photo_${play.dt}.png` }, null, 2)
      );
    }
  }
  return dir;
};

const run = (resultsDir, args = []) =>
  execFileSync(process.execPath, [TOOL, ...args], {
    env: { ...process.env, KIDSPG_RESULTS_DIR: resultsDir },
    encoding: 'utf-8',
  });

const exists = (dir, dt, name) => fs.existsSync(path.join(dir, dt, name));

test('既定はドライラン。何も消えない', () => {
  const dir = makeResults([{ dt: '20260912_101112' }]);
  try {
    const out = run(dir);
    assert.match(out, /ドライラン/, '出力にドライランの表示がありません');
    assert.ok(
      exists(dir, '20260912_101112', 'photo_20260912_101112.png'),
      'ドライランなのに写真が消えました'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--apply で生の写真だけが消え、AI画像とカードは残る', () => {
  const dt = '20260912_101112';
  const dir = makeResults([{ dt }]);
  try {
    run(dir, ['--apply']);
    assert.ok(!exists(dir, dt, `photo_${dt}.png`), '生の写真が消えていません');
    assert.ok(exists(dir, dt, `photo_anime_${dt}_00001_.png`), 'AI画像まで消えました');
    assert.ok(exists(dir, dt, `memorial_card_${dt}.png`), 'カードまで消えました');
    assert.ok(exists(dir, dt, 'result.json'), 'result.json まで消えました');
    assert.ok(exists(dir, dt, 'image_generate.json'), 'image_generate.json まで消えました');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('カードが無い回の写真は残す（再生成できなくなるため）', () => {
  const dt = '20260912_101112';
  const dir = makeResults([{ dt, card: false }]);
  try {
    const out = run(dir, ['--apply']);
    assert.ok(exists(dir, dt, `photo_${dt}.png`), 'カード未完成なのに写真を消しました');
    assert.match(out, /見送り/, '見送った旨が出ていません');
    assert.match(out, /retry-failed/, '作り直しの案内が出ていません');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('カードが壊れている回の写真も残す', () => {
  const dt = '20260912_101112';
  const dir = makeResults([{ dt, card: 'broken' }]);
  try {
    run(dir, ['--apply']);
    assert.ok(exists(dir, dt, `photo_${dt}.png`), 'カードが壊れているのに写真を消しました');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--include-incomplete を付けたときだけ未完成の回も消す', () => {
  const dt = '20260912_101112';
  const dir = makeResults([{ dt, card: false }]);
  try {
    run(dir, ['--apply', '--include-incomplete']);
    assert.ok(!exists(dir, dt, `photo_${dt}.png`), '--include-incomplete が効いていません');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--only で指定した回だけを対象にする', () => {
  const a = '20260912_101112';
  const b = '20260912_101200';
  const dir = makeResults([{ dt: a }, { dt: b }]);
  try {
    run(dir, ['--apply', '--only', a]);
    assert.ok(!exists(dir, a, `photo_${a}.png`), '指定した回が消えていません');
    assert.ok(exists(dir, b, `photo_${b}.png`), '指定していない回まで消えました');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('result.json の写真への参照を外す（実体の無いパスを残さない）', () => {
  const dt = '20260912_101112';
  const dir = makeResults([{ dt }]);
  try {
    run(dir, ['--apply']);
    const data = JSON.parse(fs.readFileSync(path.join(dir, dt, 'result.json'), 'utf-8'));
    assert.strictEqual(data.imagePath, undefined, '消した写真への参照が残っています');
    assert.ok(data.photoPurgedAt, '消した記録（photoPurgedAt）がありません');
    assert.strictEqual(data.nickname, 'てすと', '他の項目まで壊しています');
    assert.strictEqual(data.score, 100, '他の項目まで壊しています');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('すでに写真が無い回は何もしない（二度目の実行が安全）', () => {
  const dt = '20260912_101112';
  const dir = makeResults([{ dt }]);
  try {
    run(dir, ['--apply']);
    const out = run(dir, ['--apply']);
    assert.match(out, /消せる写真はありません/, '2回目の実行で対象が残っています');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('日時の形をしていないフォルダは触らない', () => {
  const dir = makeResults([{ dt: '20260912_101112' }]);
  try {
    const odd = path.join(dir, 'superseded_20260902');
    fs.mkdirSync(odd, { recursive: true });
    fs.writeFileSync(path.join(odd, 'photo_20260101_000000.png'), VALID_PNG);
    run(dir, ['--apply']);
    assert.ok(
      fs.existsSync(path.join(odd, 'photo_20260101_000000.png')),
      '結果フォルダ以外のフォルダに手を出しています'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('result.json が壊れていても写真は消せる（消すのが目的なので止めない）', () => {
  const dt = '20260912_101112';
  const dir = makeResults([{ dt }]);
  try {
    fs.writeFileSync(path.join(dir, dt, 'result.json'), '{ こわれた');
    run(dir, ['--apply']);
    assert.ok(!exists(dir, dt, `photo_${dt}.png`), 'result.json の破損で削除が止まっています');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
