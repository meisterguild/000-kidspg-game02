'use strict';

/**
 * ランクとレベルの計算のテスト。
 *
 * 🔴 **ここは全員のランクを決める箱で、これまで1件もテストが無かった。**
 * カード背景8種はランクと1対1で対応しているので、境界の扱いを1つ間違えると
 * 「その閾値の子だけ背景が1段ずれる」という、画面に何も出ない壊れ方をする。
 * config.json の rankThresholds が実測と合っているかは
 * tools/test-stage-balance.mjs が見ているが、**閾値を渡された後の判定**は
 * ここでしか守れない。
 *
 *   npm run build && node --test tools/test-rank-and-level.cjs
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'dist', 'main', 'shared', 'utils', 'helpers.js');
if (!fs.existsSync(MODULE_PATH)) {
  throw new Error(`dist が見つかりません。先に \`npm run build\` を実行してください: ${MODULE_PATH}`);
}
const {
  calculateRank,
  calculateLevel,
  generateJSTTimestamp,
  DEFAULT_RANK_THRESHOLDS,
  RANK_NAMES,
} = require(MODULE_PATH);

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));

test('閾値ちょうどの点はその段に入る（境界は「以上」）', () => {
  const t = [1000, 800, 600, 400, 250, 150, 80];
  assert.strictEqual(calculateRank(1000, t), RANK_NAMES.LEGEND);
  assert.strictEqual(calculateRank(999, t), RANK_NAMES.MASTER);
  assert.strictEqual(calculateRank(80, t), RANK_NAMES.AMATEUR);
  assert.strictEqual(calculateRank(79, t), RANK_NAMES.BEGINNER);
  assert.strictEqual(calculateRank(0, t), RANK_NAMES.BEGINNER);
});

test('8段すべてに到達できる（カード背景8種と1対1）', () => {
  const t = [1000, 800, 600, 400, 250, 150, 80];
  const got = [1200, 900, 700, 500, 300, 200, 100, 0].map((s) => calculateRank(s, t));
  assert.deepStrictEqual(got, [
    RANK_NAMES.LEGEND,
    RANK_NAMES.MASTER,
    RANK_NAMES.ELITE,
    RANK_NAMES.VETERAN,
    RANK_NAMES.EXPERT,
    RANK_NAMES.ADVANCED,
    RANK_NAMES.AMATEUR,
    RANK_NAMES.BEGINNER,
  ]);
  assert.strictEqual(new Set(got).size, 8, '8段すべてが別のランクになっていません');
});

test('config.json の実際の閾値で8段すべてに到達できる', () => {
  // 当日使う値で確かめる。1段でも飛ぶと、その背景のカードが1枚も出ない
  const t = config.game.rankThresholds;
  assert.strictEqual(t.length, 7, 'rankThresholds は7個であるべきです');
  const names = new Set();
  // 各段の「ちょうど」と「1点下」を見る
  names.add(calculateRank(t[0] + 1, t));
  for (const threshold of t) {
    names.add(calculateRank(threshold, t));
  }
  names.add(calculateRank(t[t.length - 1] - 1, t));
  assert.strictEqual(
    names.size,
    8,
    `到達できたランクが ${names.size} 段しかありません（8段であるべき）: ${[...names].join(', ')}`
  );
});

test('壊れた閾値を渡されたら既定へ倒す（7個でなければ無視）', () => {
  // config.json を手編集して個数を間違えたときに、黙って全員 初心者 に
  // ならないようにしてある。その挙動を固定する。
  for (const bad of [undefined, [], [100], [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6, 7, 8]]) {
    assert.strictEqual(
      calculateRank(DEFAULT_RANK_THRESHOLDS[0], bad),
      RANK_NAMES.LEGEND,
      `閾値 ${JSON.stringify(bad)} のときに既定へ倒れていません`
    );
  }
});

test('スコアが上がるほどランクは下がらない（単調）', () => {
  const t = config.game.rankThresholds;
  const order = [
    RANK_NAMES.BEGINNER,
    RANK_NAMES.AMATEUR,
    RANK_NAMES.ADVANCED,
    RANK_NAMES.EXPERT,
    RANK_NAMES.VETERAN,
    RANK_NAMES.ELITE,
    RANK_NAMES.MASTER,
    RANK_NAMES.LEGEND,
  ];
  const rankOf = (score) => order.indexOf(calculateRank(score, t));
  let prev = -1;
  for (let score = 0; score <= t[0] + 200; score += 7) {
    const at = rankOf(score);
    assert.notStrictEqual(at, -1, `未知のランク名が返りました（score=${score}）`);
    assert.ok(at >= prev, `score=${score} でランクが下がりました`);
    prev = at;
  }
});

test('レベルは間隔ごとに1つ上がり、20 で MAX に張り付く', () => {
  const interval = 60;
  assert.strictEqual(calculateLevel(0, interval), 'Lv1');
  assert.strictEqual(calculateLevel(59, interval), 'Lv1');
  assert.strictEqual(calculateLevel(60, interval), 'Lv2');
  assert.strictEqual(calculateLevel(60 * 18, interval), 'Lv19');
  assert.strictEqual(calculateLevel(60 * 19, interval), 'MAX');
  assert.strictEqual(calculateLevel(999999, interval), 'MAX');
});

test('config.json の設定でも、実際に出るスコアでレベルが壊れない', () => {
  const interval = config.game.levelUpScoreInterval;
  assert.ok(interval > 0, 'levelUpScoreInterval が正の数ではありません');
  const top = config.game.rankThresholds[0];
  for (const score of [0, 1, interval - 1, interval, top, top * 2]) {
    const level = calculateLevel(score, interval);
    assert.match(level, /^(Lv\d+|MAX)$/, `レベル表記が壊れています（score=${score}）: ${level}`);
  }
});

test('JST の時刻は "YYYY-MM-DD HH:MM:SS" で、カードの整形が期待する形', () => {
  const stamp = generateJSTTimestamp();
  assert.match(
    stamp,
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    `形が違います: ${stamp}。ImageCompositionConfig.formatTimestampWithoutSeconds がこの形を切り出します`
  );
  // UTC ではなく JST であること（+9時間ぶんずれている）
  const utc = new Date().toISOString().slice(0, 13);
  const jstHour = Number(stamp.slice(11, 13));
  const utcHour = Number(utc.slice(11, 13));
  assert.strictEqual(
    (utcHour + 9) % 24,
    jstHour,
    `JST になっていません（UTC ${utcHour}時 / 返り値 ${jstHour}時）`
  );
});
