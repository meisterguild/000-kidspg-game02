#!/usr/bin/env node
/**
 * 起動時の整合性点検（startup-consistency）の単体テスト
 *
 *   npm run build && node --test tools/test-startup-consistency.cjs
 *
 * ■ 何を守っているか
 * カード生成と results.json / result.json の更新は別ステップなので、
 * 間でアプリが落ちると不整合が残る（検証中に実際に発生した）。
 * 当日スタッフは CLI を叩けないため、起動時に自動で整えることにした。
 * ここでは「直すべきものを直す」ことと、**それ以上に触らない**ことの両方を固定する。
 * 起動時にデータを壊すと、その子の記念カードが失われて取り返しがつかない。
 *
 * ■ 敵対的レビューで挙がった、点検自体が事故になる経路も固定する
 *   ・検査できなかった（I/Oエラー）だけの正常カードを退避してしまう
 *   ・result.json だけを見て判断し、results.json がプレースホルダのまま残る
 *     （＝クラッシュ窓で最も起きやすい中間状態を素通りする）
 *   ・ランキング上位（スコア順・時刻と無相関）の壊れたカードが件数上限の外で放置される
 *   ・プレースホルダが無い回でダミーへ戻し、表示が「画像なし」になる
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'main', 'main', 'services');
for (const m of ['startup-consistency.js', 'results-manager.js']) {
  if (!fs.existsSync(path.join(DIST, m))) {
    throw new Error('dist が見つかりません。先に `npm run build` を実行してください: ' + path.join(DIST, m));
  }
}
const { checkResultsConsistency, formatConsistencyReport } = require(path.join(DIST, 'startup-consistency.js'));
const { ResultsManager } = require(path.join(DIST, 'results-manager.js'));
const { acquireMaintenanceLock } = require(path.join(DIST, 'card-output.js'));

const makePng = (filePath) => {
  execFileSync('magick', ['-size', '32x32', 'xc:blue', 'PNG:' + filePath], { stdio: 'pipe' });
  return fs.readFileSync(filePath);
};

/** 1プレイぶんの成果物を作る。card: 'valid' | 'broken' | 'none' | 'unreadable' */
const makePlay = (resultsDir, datetime, options = {}) => {
  const {
    card = 'valid',
    cardPathInJson = null,
    dummy = true,
    anime = true,
  } = options;
  const dir = path.join(resultsDir, datetime);
  fs.mkdirSync(dir, { recursive: true });
  const cardName = `memorial_card_${datetime}.png`;
  const dummyName = `memorial_card_${datetime}.dummy.png`;
  if (dummy) makePng(path.join(dir, dummyName));
  if (anime) makePng(path.join(dir, `photo_anime_${datetime}_00001_.png`));

  if (card === 'valid') {
    makePng(path.join(dir, cardName));
  } else if (card === 'broken') {
    const src = path.join(dir, 'src.tmp');
    const buf = makePng(src);
    fs.rmSync(src);
    // 先頭のシグネチャは揃っているが IEND が無い = 書き込み途中で落ちた形
    fs.writeFileSync(path.join(dir, cardName), buf.subarray(0, buf.length - 20));
  } else if (card === 'unreadable') {
    // 検査できない状態を作る（ディレクトリ）。「壊れている」とは違う扱いになるべき
    fs.mkdirSync(path.join(dir, cardName));
  }

  fs.writeFileSync(
    path.join(dir, 'result.json'),
    JSON.stringify({
      nickname: 'グミマスター',
      score: 480,
      timestampJST: '2026-09-12 10:11:12',
      memorialCardPath: cardPathInJson ?? `${datetime}/${dummyName}`,
    }, null, 2),
    'utf-8'
  );
  return dir;
};

const writeResultsJson = (resultsDir, data) => {
  fs.writeFileSync(path.join(resultsDir, 'results.json'), JSON.stringify(data, null, 2), 'utf-8');
};

const readResultJson = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf-8'));
const readResultsJson = (resultsDir) => JSON.parse(fs.readFileSync(path.join(resultsDir, 'results.json'), 'utf-8'));

const cacheEntry = (datetime, kind, score = 480) => ({
  resultPath: `${datetime}/result.json`,
  memorialCardPath: `${datetime}/memorial_card_${datetime}.${kind === 'dummy' ? 'dummy.png' : 'png'}`,
  score,
  playedAt: '2026-09-12 10:11:12',
});

const withResultsDir = (fn) => async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-consistency-'));
  const resultsDir = path.join(base, 'results');
  fs.mkdirSync(resultsDir);
  try {
    return await fn(resultsDir);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
};

test('正規カードがあるのに参照がプレースホルダのままの回を張り直す', withResultsDir(async (resultsDir) => {
  const dir = makePlay(resultsDir, '20260912_101112', { card: 'valid' });
  const manager = new ResultsManager(resultsDir, null);

  const report = await checkResultsConsistency(resultsDir, manager);

  assert.deepStrictEqual(report.relinked, ['20260912_101112']);
  assert.strictEqual(
    readResultJson(dir).memorialCardPath,
    '20260912_101112/memorial_card_20260912_101112.png'
  );
}));

test('result.json は正規なのに results.json がプレースホルダのままの回も張り直す', withResultsDir(async (resultsDir) => {
  // 🔴 これがクラッシュ窓で最も起きやすい中間状態。
  // result.json だけを条件にすると素通りし、ランキングはプレースホルダを出し続ける
  const dt = '20260912_101112';
  makePlay(resultsDir, dt, { card: 'valid', cardPathInJson: `${dt}/memorial_card_${dt}.png` });
  writeResultsJson(resultsDir, { recent: [cacheEntry(dt, 'dummy')], ranking_top: [cacheEntry(dt, 'dummy')] });
  const manager = new ResultsManager(resultsDir, null);

  const report = await checkResultsConsistency(resultsDir, manager);

  assert.deepStrictEqual(report.relinked, [dt]);
  const results = readResultsJson(resultsDir);
  assert.strictEqual(results.recent[0].memorialCardPath, `${dt}/memorial_card_${dt}.png`);
  assert.strictEqual(results.ranking_top[0].memorialCardPath, `${dt}/memorial_card_${dt}.png`);
}));

test('すでに正しい回は触らない（result.json を書き換えない）', withResultsDir(async (resultsDir) => {
  const dt = '20260912_101112';
  const dir = makePlay(resultsDir, dt, { card: 'valid', cardPathInJson: `${dt}/memorial_card_${dt}.png` });
  writeResultsJson(resultsDir, { recent: [cacheEntry(dt, 'regular')], ranking_top: [] });
  const before = fs.readFileSync(path.join(dir, 'result.json'), 'utf-8');
  const manager = new ResultsManager(resultsDir, null);

  const report = await checkResultsConsistency(resultsDir, manager);

  assert.deepStrictEqual(report.relinked, []);
  assert.deepStrictEqual(report.quarantinedCards, []);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'result.json'), 'utf-8'), before);
}));

test('壊れたカードは参照をプレースホルダへ戻してから退避する', withResultsDir(async (resultsDir) => {
  const dt = '20260912_101112';
  const dir = makePlay(resultsDir, dt, { card: 'broken', cardPathInJson: `${dt}/memorial_card_${dt}.png` });
  const manager = new ResultsManager(resultsDir, null);

  const report = await checkResultsConsistency(resultsDir, manager);

  assert.strictEqual(report.quarantinedCards.length, 1);
  assert.strictEqual(report.quarantinedCards[0].datetime, dt);
  // 最終名は消えている（＝救済ツールが「カードが無い回」として拾える）
  assert.ok(!fs.existsSync(path.join(dir, `memorial_card_${dt}.png`)));
  // 退避先は残っている（原因調査のため消さない）
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.png.broken-')));
  // 表示はプレースホルダへ戻す
  assert.strictEqual(readResultJson(dir).memorialCardPath, `${dt}/memorial_card_${dt}.dummy.png`);
  assert.ok(report.revertedToDummy.includes(dt));
  assert.ok(report.needsRebuild.includes(dt));
}));

test('検査できなかったカードは退避しない（正常品を壊さない）', withResultsDir(async (resultsDir) => {
  const dt = '20260912_101112';
  const dir = makePlay(resultsDir, dt, { card: 'unreadable', cardPathInJson: `${dt}/memorial_card_${dt}.png` });
  const manager = new ResultsManager(resultsDir, null);

  const report = await checkResultsConsistency(resultsDir, manager);

  assert.deepStrictEqual(report.quarantinedCards, []);
  assert.strictEqual(report.unverified.length, 1);
  assert.strictEqual(report.unverified[0].datetime, dt);
  // 実体も参照もそのまま（次回に持ち越す）
  assert.ok(fs.existsSync(path.join(dir, `memorial_card_${dt}.png`)));
  assert.strictEqual(readResultJson(dir).memorialCardPath, `${dt}/memorial_card_${dt}.png`);
}));

test('プレースホルダが無い回では壊れたカードを退避しない（表示を空にしない）', withResultsDir(async (resultsDir) => {
  const dt = '20260912_101112';
  const dir = makePlay(resultsDir, dt, { card: 'broken', dummy: false, cardPathInJson: `${dt}/memorial_card_${dt}.png` });
  const manager = new ResultsManager(resultsDir, null);

  const report = await checkResultsConsistency(resultsDir, manager);

  assert.deepStrictEqual(report.quarantinedCards, []);
  assert.deepStrictEqual(report.revertedToDummy, []);
  assert.strictEqual(report.unverified.length, 1);
  assert.ok(fs.existsSync(path.join(dir, `memorial_card_${dt}.png`)), '退避してはいけない');
  assert.ok(report.needsRebuild.includes(dt));
}));

test('カードが無いのに参照が正規のままの回はプレースホルダへ戻す', withResultsDir(async (resultsDir) => {
  const dt = '20260912_101112';
  const dir = makePlay(resultsDir, dt, { card: 'none', cardPathInJson: `${dt}/memorial_card_${dt}.png` });
  writeResultsJson(resultsDir, { recent: [cacheEntry(dt, 'regular')], ranking_top: [] });
  const manager = new ResultsManager(resultsDir, null);

  const report = await checkResultsConsistency(resultsDir, manager);

  assert.deepStrictEqual(report.revertedToDummy, [dt]);
  assert.strictEqual(readResultJson(dir).memorialCardPath, `${dt}/memorial_card_${dt}.dummy.png`);
  assert.strictEqual(readResultsJson(resultsDir).recent[0].memorialCardPath, `${dt}/memorial_card_${dt}.dummy.png`);
}));

test('AI画像が無い回は「作り直しが必要」に数えない（ログを埋めない）', withResultsDir(async (resultsDir) => {
  const dt = '20260912_101112';
  makePlay(resultsDir, dt, { card: 'none', anime: false });
  const manager = new ResultsManager(resultsDir, null);

  const report = await checkResultsConsistency(resultsDir, manager);

  assert.deepStrictEqual(report.needsRebuild, []);
}));

test('合成中の残骸は古いものだけ消す（書き込み中の相手を消さない）', withResultsDir(async (resultsDir) => {
  const dt = '20260912_101112';
  const dir = makePlay(resultsDir, dt, { card: 'none' });
  const stale = path.join(dir, `memorial_card_${dt}.png.1234-a1b2c3.partial`);
  const fresh = path.join(dir, `memorial_card_${dt}.png.5678-d4e5f6.partial`);
  fs.writeFileSync(stale, 'x');
  fs.writeFileSync(fresh, 'x');
  const old = (Date.now() - 10 * 60 * 1000) / 1000;
  fs.utimesSync(stale, old, old);
  const manager = new ResultsManager(resultsDir, null);

  const report = await checkResultsConsistency(resultsDir, manager);

  assert.deepStrictEqual(report.removedPartials.map((p) => path.basename(p)), [path.basename(stale)]);
  assert.ok(fs.existsSync(fresh), '書き込み中かもしれない残骸を消してはいけない');
}));

test('合成中に落ちた完成品は最終名へ救済する', withResultsDir(async (resultsDir) => {
  const dt = '20260912_101112';
  const dir = makePlay(resultsDir, dt, { card: 'none' });
  const stale = path.join(dir, `memorial_card_${dt}.png.1234-a1b2c3.partial`);
  makePng(stale);
  const old = (Date.now() - 10 * 60 * 1000) / 1000;
  fs.utimesSync(stale, old, old);
  const manager = new ResultsManager(resultsDir, null);

  const report = await checkResultsConsistency(resultsDir, manager);

  assert.strictEqual(report.rescuedCards.length, 1);
  assert.ok(fs.existsSync(path.join(dir, `memorial_card_${dt}.png`)));
  // 救済したカードは、そのまま参照の張り直しまで進む
  assert.deepStrictEqual(report.relinked, [dt]);
}));

test('result.json が無い／壊れている回は触らない（壊れている件数だけ残す）', withResultsDir(async (resultsDir) => {
  const noJson = path.join(resultsDir, '20260912_101112');
  fs.mkdirSync(noJson);
  makePng(path.join(noJson, 'memorial_card_20260912_101112.png'));

  const brokenJson = path.join(resultsDir, '20260912_101113');
  fs.mkdirSync(brokenJson);
  makePng(path.join(brokenJson, 'memorial_card_20260912_101113.png'));
  fs.writeFileSync(path.join(brokenJson, 'result.json'), '{ こわれた', 'utf-8');

  const manager = new ResultsManager(resultsDir, null);
  const report = await checkResultsConsistency(resultsDir, manager);

  assert.deepStrictEqual(report.relinked, []);
  assert.deepStrictEqual(report.quarantinedCards, []);
  assert.strictEqual(report.scanned, 2);
  assert.deepStrictEqual(report.unreadableResults, ['20260912_101113']);
}));

test('日時形式でないフォルダは対象にしない', withResultsDir(async (resultsDir) => {
  fs.mkdirSync(path.join(resultsDir, 'superseded'));
  fs.mkdirSync(path.join(resultsDir, 'backup_20260912'));
  makePlay(resultsDir, '20260912_101112', { card: 'valid' });

  const manager = new ResultsManager(resultsDir, null);
  const report = await checkResultsConsistency(resultsDir, manager);

  assert.strictEqual(report.scanned, 1);
}));

test('点検件数の上限は新しい順に効く（古い回は起動時には見ない）', withResultsDir(async (resultsDir) => {
  makePlay(resultsDir, '20260912_100000', { card: 'valid' }); // 古い
  makePlay(resultsDir, '20260912_120000', { card: 'valid' }); // 新しい

  const manager = new ResultsManager(resultsDir, null);
  const report = await checkResultsConsistency(resultsDir, manager, { scanLimit: 1 });

  assert.strictEqual(report.scanned, 1);
  assert.deepStrictEqual(report.relinked, ['20260912_120000']);
  assert.strictEqual(report.skipped, 1);
}));

test('ランキングに出ている回は件数上限の外でも必ず点検する', withResultsDir(async (resultsDir) => {
  // 🔴 ranking_top はスコア順で時刻と無相関。朝イチの高得点は終日1位に居座るため、
  // 「新しい順」だけで絞ると壊れたカードが1位に出続ける
  const oldHighScore = '20260912_100000';
  makePlay(resultsDir, oldHighScore, { card: 'broken', cardPathInJson: `${oldHighScore}/memorial_card_${oldHighScore}.png` });
  makePlay(resultsDir, '20260912_120000', { card: 'valid' });
  writeResultsJson(resultsDir, {
    recent: [],
    ranking_top: [cacheEntry(oldHighScore, 'regular', 1112)],
  });

  const manager = new ResultsManager(resultsDir, null);
  const report = await checkResultsConsistency(resultsDir, manager, { scanLimit: 1 });

  assert.strictEqual(report.quarantinedCards.length, 1, 'ランキング上位の壊れたカードを見逃している');
  assert.strictEqual(report.quarantinedCards[0].datetime, oldHighScore);
  assert.strictEqual(
    readResultsJson(resultsDir).ranking_top[0].memorialCardPath,
    `${oldHighScore}/memorial_card_${oldHighScore}.dummy.png`
  );
}));

test('保守中のロックがあれば何もしない（救済ツールと衝突させない）', withResultsDir(async (resultsDir) => {
  makePlay(resultsDir, '20260912_101112', { card: 'broken' });
  const release = await acquireMaintenanceLock(resultsDir);
  assert.ok(release);
  try {
    const manager = new ResultsManager(resultsDir, null);
    const report = await checkResultsConsistency(resultsDir, manager);
    assert.strictEqual(report.lockBusy, true);
    assert.strictEqual(report.scanned, 0);
    assert.match(formatConsistencyReport(report), /保守中/);
  } finally {
    await release();
  }
}));

test('時間予算を過ぎたら打ち切る（受付を止めない）', withResultsDir(async (resultsDir) => {
  makePlay(resultsDir, '20260912_100000', { card: 'valid' });
  makePlay(resultsDir, '20260912_110000', { card: 'valid' });
  makePlay(resultsDir, '20260912_120000', { card: 'valid' });

  const manager = new ResultsManager(resultsDir, null);
  // 予算 0ms = 最初の判定で打ち切り
  const report = await checkResultsConsistency(resultsDir, manager, { budgetMs: 0 });

  assert.strictEqual(report.scanned, 0);
  assert.ok(report.skipped >= 3);
}));

test('results/ がまだ無い初回起動でも落ちない', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-consistency-none-'));
  try {
    const resultsDir = path.join(base, 'results');
    const manager = new ResultsManager(resultsDir, null);
    const report = await checkResultsConsistency(resultsDir, manager);
    assert.strictEqual(report.scanned, 0);
    assert.match(formatConsistencyReport(report), /点検 0 件/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('results.json が壊れていても、点検で読むだけでは退避しない', withResultsDir(async (resultsDir) => {
  // 🔴 loadResults は壊れた results.json を退避して空を返す。点検が**読むだけ**で
  // それを踏むと、電源断で途中まで書かれていただけで当日のランキング上位が消える。
  // 点検は peekResults（非破壊）を使うこと。
  const dt = '20260912_101112';
  makePlay(resultsDir, dt, { card: 'valid', cardPathInJson: `${dt}/memorial_card_${dt}.png` });
  fs.writeFileSync(path.join(resultsDir, 'results.json'), '{ "recent": [ こわれた', 'utf-8');
  const manager = new ResultsManager(resultsDir, null);

  const report = await checkResultsConsistency(resultsDir, manager);

  assert.strictEqual(report.cacheUnavailable, true, '読めなかったことを報告していない');
  // 直すべきものが無い（result.json は既に正規）ので、書き込みは発生しない＝退避もされない
  assert.deepStrictEqual(report.relinked, []);
  assert.ok(fs.existsSync(path.join(resultsDir, 'results.json')), '読むだけで退避してはいけない');
  assert.match(formatConsistencyReport(report), /表示キャッシュ未点検/);
}));

test('壊れた results.json へ書き込む必要が出たら、退避して目印を残す（後から作り直せる）', withResultsDir(async (resultsDir) => {
  // 参照の張り直しには書き込みが必要で、壊れたままでは書けない。
  // 退避は避けられないが、**気づかないまま終わらせない**（.index-rebuild-needed）
  const dt = '20260912_101112';
  const dir = makePlay(resultsDir, dt, { card: 'valid' }); // 参照はプレースホルダのまま
  fs.writeFileSync(path.join(resultsDir, 'results.json'), '{ "recent": [ こわれた', 'utf-8');
  const manager = new ResultsManager(resultsDir, null);

  const report = await checkResultsConsistency(resultsDir, manager);

  assert.deepStrictEqual(report.relinked, [dt]);
  assert.strictEqual(readResultJson(dir).memorialCardPath, `${dt}/memorial_card_${dt}.png`);
  assert.ok(
    fs.readdirSync(resultsDir).some((f) => f.startsWith('results.json.broken-')),
    '壊れた索引は退避されるべき'
  );
  const marker = path.join(resultsDir, '.index-rebuild-needed');
  assert.ok(fs.existsSync(marker), '作り直しの目印が無いと誰も気づけない');
  assert.match(fs.readFileSync(marker, 'utf-8'), /--rebuild-index/);
}));

test('results.json が想定外の形でも例外にしない', withResultsDir(async (resultsDir) => {
  const dt = '20260912_101112';
  makePlay(resultsDir, dt, { card: 'valid' });
  // recent が配列でない／null 要素が混ざる
  fs.writeFileSync(
    path.join(resultsDir, 'results.json'),
    JSON.stringify({ recent: {}, ranking_top: [null] }),
    'utf-8'
  );
  const manager = new ResultsManager(resultsDir, null);

  const report = await checkResultsConsistency(resultsDir, manager);

  // 例外で全件が止まらないこと（止まると1件も点検されない）
  assert.strictEqual(report.scanned, 1);
}));

test('件数上限の外でも、再起動を重ねれば古い回まで点検が回る', withResultsDir(async (resultsDir) => {
  // 🔴 カーソルが無いと、上限の外に押し出された回は何度再起動しても
  // 永久に点検されない（＝カードはあるのに正本がプレースホルダのまま）
  const olds = ['20260912_100000', '20260912_110000', '20260912_120000'];
  for (const dt of olds) makePlay(resultsDir, dt, { card: 'valid' });
  const manager = new ResultsManager(resultsDir, null);

  const scannedAll = new Set();
  for (let i = 0; i < 3; i += 1) {
    const report = await checkResultsConsistency(resultsDir, manager, { scanLimit: 1 });
    for (const dt of report.relinked) scannedAll.add(dt);
  }

  assert.deepStrictEqual([...scannedAll].sort(), olds, '古い回が点検されていない');
}));

test('時間予算で打ち切られても、カーソルは未点検の回を飛び越えない', withResultsDir(async (resultsDir) => {
  // 🔴 カーソルに「点検する予定だった末尾」を書くと、予算切れで一度も見ていない
  // 数百件を飛び越える。3000件・予算10秒・OneDrive では予算切れが常態なので、
  // 「再起動を重ねれば必ず回る」が成立しなくなる。
  const times = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'];
  const dirs = times.map((t) => `202609${'12'}_${t}0000`);
  for (const dt of dirs) makePlay(resultsDir, dt, { card: 'valid' }); // 参照はプレースホルダのまま
  const manager = new ResultsManager(resultsDir, null);

  const relinked = new Set();
  // 🔴 budgetMs を 1 にしてはいけない（2026-09-04）。
  // 予算の起点は checkResultsConsistency の入口で、ループに入るまでに保守ロックの
  // 取得（ファイル作成）と results.json の読み取りが挟まる。1ms だとその時点で
  // 予算切れになり、**1件も見ないまま終わる起動**が混ざる。
  // 負荷の高いマシンでは毎回そうなり、このテストが落ちる（実際にフレークしていた）。
  // 1周あたりの件数は scanLimit=2 が縛るので、予算はループに入れる程度あればよい。
  for (let boot = 0; boot < 60 && relinked.size < dirs.length; boot += 1) {
    const report = await checkResultsConsistency(resultsDir, manager, { scanLimit: 2, budgetMs: 200 });
    for (const dt of report.relinked) relinked.add(dt);
  }

  assert.deepStrictEqual([...relinked].sort(), [...dirs].sort(),
    '予算切れの起動を繰り返しても点検されない回が残っている');
}));

test('ランキング上位（古い回）を点検しても、カーソルは間の未点検の回を飛び越えない', withResultsDir(async (resultsDir) => {
  // 🔴 `referenced`（results.json が参照している回）は ranking_top を含み、
  // これは**スコア順で時刻と無相関**。朝イチの高得点は終日1位に居座る。
  // この古い1件を点検しただけでカーソルをそこまで進めてしまうと、
  // 間に挟まった回が**何度再起動しても永久に点検されない**
  // （＝カードの実体はあるのに、後日の公開の正本がプレースホルダを指したまま）。
  const times = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'];
  const dirs = times.map((t) => `20260912_${t}0000`);
  for (const dt of dirs) makePlay(resultsDir, dt, { card: 'valid' });

  // いちばん古い回が「ランキング1位」として居座っている状態を作る
  const oldest = dirs[0];
  writeResultsJson(resultsDir, {
    recent: [],
    ranking_top: [cacheEntry(oldest, 'dummy', 9999)],
  });

  const manager = new ResultsManager(resultsDir, null);
  const relinked = new Set();
  // 毎回「新しい順2件 + 参照分」しか見られない状況で起動を繰り返す
  for (let boot = 0; boot < 40 && relinked.size < dirs.length; boot += 1) {
    const report = await checkResultsConsistency(resultsDir, manager, { scanLimit: 2 });
    for (const dt of report.relinked) relinked.add(dt);
  }

  assert.deepStrictEqual([...relinked].sort(), [...dirs].sort(),
    '起動を繰り返しても点検されない回が残っている（カーソルが飛び越えた）');
}));
