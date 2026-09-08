/**
 * 難易度を決めるソルバのテスト。
 *
 * 🔴 **ここが間違うと難易度の目標が意味を失う。**
 * generateStage は「間違えると詰む判断」の数を目標に盤面を選ぶので、
 * canFinish の判定が甘い（詰むのに解けると言う）と難所を数え落とし、
 * 逆に厳しい（解けるのに詰むと言う）と実際より難しいと誤認する。
 * どちらも画面には何も出ない。
 *
 * 実際の盤面は 3面×N² の立方体で人手では検算できないので、
 * **正解が自明な小さなグラフを手で組んで**判定を確かめる。
 *
 *   node --test tools/test-solve-stage.mjs
 */

import test from 'node:test';
import assert from 'node:assert';
import { canFinish, countCriticals, SOLVE_NODE_BUDGET } from '../src/renderer/game/gummy/solve.js';

/**
 * 隣接リストから stage 相当のものを作る。
 * @param {Record<string,string[]>} edges 双方向でなくてよい（ここで対称化する）
 * @param {string[]} cells 生成時の経路（先頭が start、末尾が goal）
 */
const makeStage = (edges, cells) => {
  const adj = new Map();
  const touch = (a) => {
    if (!adj.has(a)) adj.set(a, []);
    return adj.get(a);
  };
  for (const [a, list] of Object.entries(edges)) {
    for (const b of list) {
      if (!touch(a).includes(b)) touch(a).push(b);
      if (!touch(b).includes(a)) touch(b).push(a);
    }
  }
  for (const c of cells) touch(c);
  return { cells, adj, goal: cells[cells.length - 1], start: cells[0] };
};

const budget = () => ({ nodes: SOLVE_NODE_BUDGET });

test('一本道は最後まで食べきれる', () => {
  //  A - B - C - D
  const st = makeStage({ A: ['B'], B: ['C'], C: ['D'] }, ['A', 'B', 'C', 'D']);
  assert.strictEqual(canFinish(st.adj, new Set(['B', 'C', 'D']), 'A', 'D', budget()), true);
});

test('残りが1つも無ければ、いまいるセルがゴールかどうかで決まる', () => {
  const st = makeStage({ A: ['B'] }, ['A', 'B']);
  assert.strictEqual(canFinish(st.adj, new Set(), 'B', 'B', budget()), true);
  assert.strictEqual(canFinish(st.adj, new Set(), 'A', 'B', budget()), false);
});

test('ゴールを先に踏む道は詰みと判定する（ゴールは最後の1手だけ）', () => {
  //  A - G - C     G がゴール。A から G を通って C へ行くと C で終わってしまう
  const st = makeStage({ A: ['G'], G: ['C'] }, ['A', 'G', 'C']);
  // A にいて残り {G, C}、ゴールは C。G→C の順なら食べきれる
  assert.strictEqual(canFinish(st.adj, new Set(['G', 'C']), 'A', 'C', budget()), true);
  // ゴールを G にすると、G を通らずに C へ行けないので詰む
  assert.strictEqual(canFinish(st.adj, new Set(['G', 'C']), 'A', 'G', budget()), false);
});

test('取り残しが出る道は詰みと判定する（分断の枝刈り）', () => {
  //      B
  //      |
  //  A - C - D     C で分岐。A→C→B へ行くと D が残る（B は行き止まり）
  const st = makeStage({ A: ['C'], C: ['B', 'D'] }, ['A', 'C', 'B']);
  // A にいて残り {B, C, D}、ゴールを D とすると B を通ってから D へは戻れない
  assert.strictEqual(canFinish(st.adj, new Set(['B', 'C', 'D']), 'A', 'D', budget()), false);
  // ゴールを B にしても、D を通った後に C へ戻れないので詰む
  assert.strictEqual(canFinish(st.adj, new Set(['B', 'C', 'D']), 'A', 'B', budget()), false);
});

test('分岐があっても、正しい順なら食べきれる', () => {
  //  A - B - C
  //      |   |
  //      D - E     A から全部通って E で終われる: A B D E C ではなく A B C E D…
  const st = makeStage(
    { A: ['B'], B: ['C', 'D'], C: ['E'], D: ['E'] },
    ['A', 'B', 'C', 'E', 'D']
  );
  // ゴール D。A B C E D で食べきれる
  assert.strictEqual(canFinish(st.adj, new Set(['B', 'C', 'D', 'E']), 'A', 'D', budget()), true);
  // 同じ盤でゴールを C にすると A B D E C で食べきれる
  assert.strictEqual(canFinish(st.adj, new Set(['B', 'C', 'D', 'E']), 'A', 'C', budget()), true);
});

test('予算を使い切ったら null（判定できなかった）を返す', () => {
  // 解ける盤でも予算 0 なら判定させない
  const st = makeStage({ A: ['B'], B: ['C'] }, ['A', 'B', 'C']);
  const verdict = canFinish(st.adj, new Set(['B', 'C']), 'A', 'C', { nodes: 0 });
  assert.strictEqual(verdict, null, '予算切れが null になっていません');
});

test('一本道には判断も難所も無い', () => {
  const st = makeStage({ A: ['B'], B: ['C'], C: ['D'] }, ['A', 'B', 'C', 'D']);
  const got = countCriticals(st);
  assert.strictEqual(got.decisions, 0);
  assert.strictEqual(got.criticals, 0);
  assert.strictEqual(got.traps, 0);
  assert.strictEqual(got.unknown, false);
});

test('間違えると詰む分岐を1回数える', () => {
  //  S - A - B - C - D - G      A-D の近道つき。ゴールは G
  //      |           |
  //      +--- 近道 --+
  //
  // 手で追うと:
  //   S では A だけ（1手）
  //   A では B と D の2択。D へ行くと B が孤立して詰む
  //     （D→C→B まで行けるが、そこから G へ戻れない）
  //   以降は選択肢1つずつ
  // よって 判断1回・難所1回・詰む選択肢1つ。
  const st = makeStage(
    { S: ['A'], A: ['B', 'D'], B: ['C'], C: ['D'], D: ['G'] },
    ['S', 'A', 'B', 'C', 'D', 'G']
  );
  const got = countCriticals(st);
  assert.deepStrictEqual(
    { decisions: got.decisions, criticals: got.criticals, traps: got.traps },
    { decisions: 1, criticals: 1, traps: 1 },
    `手計算と合いません: ${JSON.stringify(got)}`
  );
  assert.strictEqual(got.unknown, false, '予算切れが起きています');
});

test('どちらを選んでも解ける分岐は判断に数えるが難所には数えない', () => {
  //  S - A - B - C - D - E      A-C と B-D の近道つき。ゴールは E
  //
  // 手で追うと:
  //   A では B と C の2択。**どちらでも食べきれる**
  //     B なら S A B C D E ／ C なら S A C B D E
  //     → 判断だが難所ではない
  //   B では C と D の2択。D へ行くと C が孤立して詰む
  //     → 難所
  // よって 判断2回・難所1回。
  const st = makeStage(
    { S: ['A'], A: ['B', 'C'], B: ['C', 'D'], C: ['D'], D: ['E'] },
    ['S', 'A', 'B', 'C', 'D', 'E']
  );
  const got = countCriticals(st);
  assert.strictEqual(got.decisions, 2, `判断は2回であるべき: ${JSON.stringify(got)}`);
  assert.strictEqual(got.criticals, 1, `難所は1回であるべき: ${JSON.stringify(got)}`);
  assert.ok(
    got.criticals < got.decisions,
    '「選択肢はあるがどちらでも解ける」手が難所に数えられています'
  );
});

test('難所は判断より多くならない／詰む選択肢は正解を含まない', () => {
  // 数え方の不変条件。どんな盤でもこれは崩れない。
  const boards = [
    makeStage({ S: ['A'], A: ['B', 'D'], B: ['C'], C: ['D'], D: ['G'] }, ['S', 'A', 'B', 'C', 'D', 'G']),
    makeStage({ S: ['A'], A: ['B', 'C'], B: ['C', 'D'], C: ['D'], D: ['E'] }, ['S', 'A', 'B', 'C', 'D', 'E']),
    makeStage({ A: ['B'], B: ['C'], C: ['D'] }, ['A', 'B', 'C', 'D']),
  ];
  for (const st of boards) {
    const got = countCriticals(st);
    assert.ok(got.criticals <= got.decisions, `難所 ${got.criticals} > 判断 ${got.decisions}`);
    assert.ok(got.traps >= got.criticals, `詰む選択肢 ${got.traps} < 難所 ${got.criticals}`);
    // 各手で調べる選択肢は「正解以外」なので、詰む選択肢は
    // 「判断のあった手で分岐していた数-1」の合計を超えない
    assert.ok(got.traps <= st.cells.length, '詰む選択肢の数が盤の大きさを超えています');
  }
});
