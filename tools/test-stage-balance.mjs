/**
 * ステージ構成とランク閾値の対応を守るテスト。
 *
 * rankThresholds は「クリアした面の数がそのままランクになる」ように置いてあり、
 * カード背景8種とランクが1対1で対応する設計になっている。この対応は
 * **1面あたりのグミ数**に依存するので、stageProgression / multiplier /
 * DIFFICULTY の ratio のどれかを触ると黙って崩れる。
 * 実際に 2026-09-04 の5面構成への変更で崩れ、
 * **5面クリアでエリートを飛ばしてマスターになり、エリートのカード背景が
 * 1枚も出ない**状態のまま気づかれなかった（docs/open-issues-20260904.md の A）。
 *
 * 画面には何も出ない壊れ方なので、生成器の実測とconfigを突き合わせて縛る。
 */

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateStage, DIFFICULTY } from '../src/renderer/game/gummy/core.js';
import { countCriticals } from '../src/renderer/game/gummy/solve.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(here, '..', 'config.json'), 'utf-8'));
const game = config.game;

/** 生成を数回試して、そのステージのグミ数を得る */
const RUNS = 20;
function gummyCounts(stage) {
  const seen = new Set();
  for (let i = 0; i < RUNS; i++) seen.add(generateStage(stage.size, stage.difficulty).stats.total);
  return seen;
}

test('各ステージのグミ数は毎回同じ（スコアが引き直しで変わらない）', () => {
  game.stageProgression.forEach((stage, i) => {
    const seen = gummyCounts(stage);
    assert.strictEqual(
      seen.size,
      1,
      `ステージ${i + 1}（${stage.size}x${stage.size} ${stage.difficulty}）の` +
        `グミ数が揺れています: ${[...seen].sort((a, b) => a - b).join(', ')}。` +
        '経路探索が目標長に届いていないので、ratio を下げるか tries を増やしてください'
    );
  });
});

/** クリア面数ごとの累計スコア。repeatLastStage を見て7面ぶんまで伸ばす */
function cumulativeScores() {
  const per = [];
  for (const stage of game.stageProgression) {
    const [gummies] = [...gummyCounts(stage)];
    per.push({ gummies, multiplier: stage.multiplier });
  }
  const cumulatives = [];
  let sum = 0;
  for (const p of per) {
    sum += p.gummies * p.multiplier;
    cumulatives.push(sum);
  }
  if (game.repeatLastStage) {
    const last = per[per.length - 1];
    while (cumulatives.length < 7) {
      cumulatives.push(cumulatives[cumulatives.length - 1] + last.gummies * last.multiplier);
      per.push(last);
    }
  }
  return { cumulatives, per };
}

test('rankThresholds が「クリア面数＝ランク」になっている', () => {
  const { cumulatives } = cumulativeScores();
  assert.ok(cumulatives.length >= 7, `7面ぶんの累計が出せません（${cumulatives.length}面ぶん）。` +
    'stageProgression を7件以上にするか repeatLastStage を true にしてください');
  const expected = [...cumulatives.slice(0, 7)].reverse();
  assert.deepStrictEqual(
    game.rankThresholds,
    expected,
    'config.json の rankThresholds が実測の累計スコアと合っていません。' +
      '`node tools/measure-stages.mjs --plan` で出る値に更新してください'
  );
});

test('部分点でランクを飛び越さない（面数＝ランクが崩れない）', () => {
  const { cumulatives, per } = cumulativeScores();
  const rate = game.partialScoreRate ?? 0;
  // 進行中の面は「最大到達数 - 1」に部分点率をかけた分が入る（GummyGame.jsx）。
  // クリアすればその面は満点で確定するので、部分点の最大は total-2 手ぶん。
  const maxPartial = (p) => Math.floor(Math.max(0, p.gummies - 2) * p.multiplier * rate);

  // 0面クリア（1面目の途中）で、1面クリアの閾値に届いてはいけない
  assert.ok(
    maxPartial(per[0]) < cumulatives[0],
    `1面目の部分点 最大 ${maxPartial(per[0])} が 1面クリアの閾値 ${cumulatives[0]} に届いています`
  );

  for (let i = 0; i < cumulatives.length - 1; i++) {
    const reach = cumulatives[i] + maxPartial(per[i + 1]);
    assert.ok(
      reach < cumulatives[i + 1],
      `${i + 1}面クリア ${cumulatives[i]} ＋ 次の面の部分点 最大 ${maxPartial(per[i + 1])}` +
        ` = ${reach} が次の閾値 ${cumulatives[i + 1]} に届いています。` +
        'partialScoreRate を下げるか閾値を見直してください'
    );
  }
});

test('1面目は一本道（進む先が常に一つ）に固定されている', () => {
  // 初めて触る子が確実に1面抜けられるようにしてある。ここに判断が入ると
  // 「1面も抜けられない子」が出て、記念カードのランクが全員 初心者 になりうる。
  //
  // 設定そのものを見る。生成のサンプリングだけで判定すると、
  // 引き直しても一本道にならない稀な盤面でテストが揺れる。
  const first = game.stageProgression[0];
  const diff = DIFFICULTY[first.difficulty];
  assert.ok(diff, `1面目の難易度 ${first.difficulty} が DIFFICULTY にありません`);
  assert.strictEqual(
    diff.corridor,
    true,
    `1面目（${first.difficulty}）に corridor:true がありません。1面目は判断を入れないでください`
  );

  // 生成器が corridor を見ていることも確かめる。上限は緩めに取る
  // （引き直しで届かなかったときの保険で分岐が1つ出ることがあるため）
  let worst = 0;
  for (let i = 0; i < RUNS; i++) {
    const st = generateStage(first.size, first.difficulty);
    const c = countCriticals(st).criticals;
    if (c > worst) worst = c;
  }
  assert.ok(
    worst <= 1,
    `1面目に「間違えると詰む判断」が最大 ${worst} 回ありました。generateStage が corridor を見ていない可能性があります`
  );
});

test('2面目以降は狙った数の「間違えると詰む判断」がある', () => {
  // 🔴 **ここが難易度の本体。**
  // 経路の長さ（ratio）は所要時間とスコアの軸で、難しさではない。
  // 隣接した塊は端から順に食べれば抜けられるので、長くしても
  // 増えるのは時間だけ。難しさは「間違えると詰む判断」の数で決まる。
  //
  // 目標に届かなかった場合は generateStage がそれまでで最良の盤面を返すので
  // （実測で到達率 97〜100%）、中央値で見る。中央値なら外れ値に揺れない。
  const stages = game.stageProgression.slice(1);
  assert.ok(stages.length > 0, 'stageProgression が1件しかありません');

  for (const [i, stage] of stages.entries()) {
    const diff = DIFFICULTY[stage.difficulty];
    assert.ok(diff, `難易度 ${stage.difficulty} が DIFFICULTY にありません`);
    const target = diff.minCriticals;
    assert.ok(
      typeof target === 'number' && target > 0,
      `${i + 2}面目（${stage.difficulty}）に minCriticals がありません。` +
        '長さだけ増やしても難しくはならないので、難所の目標を置いてください'
    );

    const got = [];
    for (let n = 0; n < RUNS; n++) {
      got.push(countCriticals(generateStage(stage.size, stage.difficulty)).criticals);
    }
    got.sort((a, b) => a - b);
    const median = got[Math.floor(got.length / 2)];
    assert.ok(
      median >= target,
      `${i + 2}面目（${stage.difficulty}）の難所が目標に届いていません: ` +
        `中央値 ${median} < 目標 ${target}（実測 ${got[0]}〜${got[got.length - 1]}）。` +
        'ratio に対して目標が高すぎるか、生成器が壊れています'
    );
  }
});

test('難易度は面が進むほど上がる（長さではなく難所の数で）', () => {
  const targets = game.stageProgression.map((st) => {
    const d = DIFFICULTY[st.difficulty];
    return d.corridor ? 0 : (d.minCriticals ?? 0);
  });
  for (let i = 1; i < targets.length; i++) {
    assert.ok(
      targets[i] >= targets[i - 1],
      `${i + 1}面目の難所の目標 ${targets[i]} が ${i}面目の ${targets[i - 1]} より少ないです`
    );
  }
  assert.ok(
    targets[targets.length - 1] > targets[0],
    '最終面と1面目の難しさが同じです'
  );
});
