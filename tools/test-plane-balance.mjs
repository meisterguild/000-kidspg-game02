/**
 * 平面モードの構成とランク閾値の対応を守るテスト。
 *
 * 平面（正面1面）は 3面の立方体に対してセル数が 1/3 しかない。
 * 立方体側の rankThresholds をそのまま使うとランクが上がらず、
 * **上位のカード意匠が一枚も出ない**（3歳の子が常に初心者カードになる）。
 * そのため平面は専用の閾値を持っている。この対応は 1面あたりのグミ数に
 * 依存するので、plane.stageProgression / multiplier / DIFFICULTY の ratio の
 * どれかを触ると黙って崩れる。立方体側と同じ流儀で縛る
 * （test-stage-balance.mjs と対になる）。
 *
 * あわせて「上位2段（達人マスター・伝説レジェンド）は平面では到達しない」を
 * 縛る。易しいモードで最上位の意匠が出ると、立体で頑張った子の意匠が
 * 埋もれるため、意図してそう置いている。
 */

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateStage, buildAdjacency, PLANE_FACES, FACES, DIFFICULTY } from '../src/renderer/game/gummy/core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(here, '..', 'config.json'), 'utf-8'));
const plane = config.game.plane;

/** 生成を数回試して、そのステージのグミ数を得る */
const RUNS = 20;
function gummyCounts(stage) {
  const seen = new Set();
  for (let i = 0; i < RUNS; i++) {
    seen.add(generateStage(stage.size, stage.difficulty, PLANE_FACES).stats.total);
  }
  return seen;
}

test('平面の設定が config.json にある', () => {
  assert.ok(plane, 'game.plane が無い');
  assert.ok(Array.isArray(plane.stageProgression) && plane.stageProgression.length > 0);
  assert.ok(Array.isArray(plane.rankThresholds));
  assert.strictEqual(plane.rankThresholds.length, 7, '閾値は7つ（8段ぶん）でなければ既定へ倒される');
});

test('平面の隣接グラフは1面ぶんだけで、面をまたぐ辺を持たない', () => {
  const N = plane.stageProgression[0].size;
  const adj = buildAdjacency(N, PLANE_FACES);
  assert.strictEqual(adj.size, N * N, `平面は ${N * N} セルであるべき`);
  for (const [cell, near] of adj) {
    const face = cell[0];
    assert.strictEqual(face, 'F', '正面以外の面が混ざっている');
    for (const n of near) {
      assert.strictEqual(n[0], 'F', `面をまたぐ辺が残っている: ${cell} - ${n}`);
    }
  }
});

test('立方体の隣接グラフは既定のまま3面ぶん（平面対応で壊していない）', () => {
  const N = 4;
  const adj = buildAdjacency(N);
  assert.strictEqual(adj.size, FACES.length * N * N);
  // 稜線シームが残っていること（面をまたぐ辺が1本以上ある）
  let cross = 0;
  for (const [cell, near] of adj) {
    for (const n of near) if (n[0] !== cell[0]) cross += 1;
  }
  assert.ok(cross > 0, '面をまたぐ辺が消えている');
});

test('平面のグミ数は毎回同じ（スコアが引き直しで変わらない）', () => {
  for (const stage of plane.stageProgression) {
    const counts = gummyCounts(stage);
    assert.strictEqual(
      counts.size, 1,
      `平面 ${stage.size}x${stage.size} ${stage.difficulty} のグミ数が揺れている: ${[...counts].join(',')}`
    );
  }
});

/** 大きすぎる値は「到達不可」として置いてある目印 */
const UNREACHABLE = 100000;

/** n面クリアしたときの累計スコア。repeatLastStage で最終面が繰り返される */
function cumulativeAt(n) {
  const prog = plane.stageProgression;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const stage = prog[Math.min(i, prog.length - 1)];
    sum += [...gummyCounts(stage)][0] * stage.multiplier;
  }
  return sum;
}

test('平面の rankThresholds が「クリア面数＝ランク」になっている', () => {
  // 閾値は高い順なので、低い順に並べ替えて1面目から突き合わせる
  const asc = plane.rankThresholds.filter((t) => t < UNREACHABLE).sort((a, b) => a - b);
  assert.ok(asc.length > 0, '到達可能な段が1つも無い');

  for (let i = 0; i < asc.length; i++) {
    const cumulative = cumulativeAt(i + 1);
    assert.strictEqual(
      asc[i], cumulative,
      `${i + 1}面クリアの累計 ${cumulative} と閾値 ${asc[i]} が合っていない。`
      + 'plane.stageProgression か plane.rankThresholds を直すこと'
      + '（node tools/measure-stages.mjs で測り直す）'
    );
  }
});

test('平面では上位2段（マスター・レジェンド）に到達しない', () => {
  // calculateRank は [レジェンド, マスター, エリート, ...] の順に見る
  const [legend, master] = plane.rankThresholds;
  // 1プレイ120秒でクリアできる面数の上限をかなり甘く見ても届かないこと。
  // クリア演出（1.5秒）だけで見ても 120/1.5 = 80 面が絶対の上限。
  const absoluteMax = cumulativeAt(80);
  assert.ok(master > absoluteMax, `マスターの閾値 ${master} は到達可能（上限 ${absoluteMax}）`);
  assert.ok(legend > absoluteMax, `レジェンドの閾値 ${legend} は到達可能（上限 ${absoluteMax}）`);
});

test('平面の難易度は面が進むほど上がる（一本道だけにしない）', () => {
  // 一本道だけを繰り返す構成にしたら「一本道すぎる」となったため、
  // 2面目以降に判断が入っていることを縛る（2026-09-09 の指摘）。
  const prog = plane.stageProgression;
  assert.ok(prog.length >= 2, '平面が1段しかない＝ずっと同じ易しさになっている');
  const targets = prog.map((s) => DIFFICULTY[s.difficulty]?.minCriticals ?? 0);
  assert.strictEqual(targets[0], 0, '1面目は操作を覚える面なので判断ゼロであるべき');
  assert.ok(targets[targets.length - 1] > 0, '最終面に判断が無い＝ずっと一本道');
  for (let i = 1; i < targets.length; i++) {
    assert.ok(
      targets[i] >= targets[i - 1],
      `${i + 1}面目の難所目標 ${targets[i]} が前の面 ${targets[i - 1]} より下がっている`
    );
  }
});
