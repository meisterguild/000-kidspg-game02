import * as THREE from 'three';
import { countCriticals, SOLVE_NODE_BUDGET } from './solve.js';

/* ============================================================
   ゲームコア（描画非依存の純ロジック）

   立方体の3面（上面・正面・右面）に並んだグミを、
   一度ずつ通ってゴールへ到達する「一筆書き」パズル。
   ============================================================ */

export const FACES = ['U', 'F', 'R'];
/** 平面モードで使う面（正面だけ）。3歳以上を対象に加えたときに用意した */
export const PLANE_FACES = ['F'];
export const k = (f, r, c) => `${f}-${r}-${c}`;

/** セル中心座標（立方体中心を原点、1セル=1単位） */
export function cellPos(f, r, c, N) {
  const H = N / 2;
  const u = c - (N - 1) / 2;
  const v = r - (N - 1) / 2;
  if (f === 'F') return [u, -v, H];
  if (f === 'U') return [u, H, v];
  return [H, -v, -u]; // R
}

export const FACE_NORMAL = { U: [0, 1, 0], F: [0, 0, 1], R: [1, 0, 0] };

/**
 * 隣接グラフ（面内4近傍＋面をまたぐ稜線シーム）。
 *
 * @param faces 使う面。既定は3面（立方体）。`['F']` を渡すと正面だけの
 *              **平面**になる（3歳以上を対象に加えたため。稜線シームは
 *              両側の面が揃っているときだけ張るので、面を減らしても
 *              つながり方は壊れない）。
 */
export function buildAdjacency(N, faces = FACES) {
  const use = new Set(faces);
  const adj = new Map();
  const touch = (a) => { if (!adj.has(a)) adj.set(a, new Set()); return adj.get(a); };
  const link = (a, b) => { touch(a).add(b); touch(b).add(a); };

  for (const f of faces) {
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        touch(k(f, r, c));
        if (c + 1 < N) link(k(f, r, c), k(f, r, c + 1));
        if (r + 1 < N) link(k(f, r, c), k(f, r + 1, c));
      }
    }
  }
  // 稜線 1: 正面の上端 ↔ 上面の手前端
  if (use.has('F') && use.has('U')) {
    for (let c = 0; c < N; c++) link(k('F', 0, c), k('U', N - 1, c));
  }
  // 稜線 2: 正面の右端 ↔ 右面の左端
  if (use.has('F') && use.has('R')) {
    for (let r = 0; r < N; r++) link(k('F', r, N - 1), k('R', r, 0));
  }
  // 稜線 3: 上面の右端 ↔ 右面の上端
  if (use.has('U') && use.has('R')) {
    for (let r = 0; r < N; r++) link(k('U', r, N - 1), k('R', 0, N - 1 - r));
  }

  return adj;
}

/**
 * ランダム化DFS＋Warnsdorff法で長い単純路を探す。
 * 「先に解を引き、路から外れたセルを欠落にする」ので必ずクリア可能になる。
 */
export function findLongPath(adj, start, target, budget) {
  const visited = new Set([start]);
  const path = [start];
  let best = [start];
  let steps = 0;

  const openDeg = (n) => {
    let d = 0;
    for (const m of adj.get(n)) if (!visited.has(m)) d++;
    return d;
  };

  const dfs = (node) => {
    if (path.length > best.length) best = [...path];
    if (best.length >= target || steps++ > budget) return true;

    const nb = [...adj.get(node)].filter((n) => !visited.has(n));
    // 先にシャッフルしてから安定ソートする。
    // 比較関数の中で Math.random() を返すと非推移的な比較になり、
    // 並び順が偏る（仕様上も未定義）。
    for (let i = nb.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [nb[i], nb[j]] = [nb[j], nb[i]];
    }
    // Warnsdorff: 行き止まりになりやすい（残次数の少ない）方から埋める
    nb.sort((a, b) => openDeg(a) - openDeg(b));

    for (const n of nb) {
      visited.add(n);
      path.push(n);
      if (dfs(n)) return true;
      path.pop();
      visited.delete(n);
    }
    return false;
  };

  dfs(start);
  return best;
}

export const DIFFICULTY = {
  // 難易度は **2つの別々の軸** で決める。
  //
  //   ratio ......... 残すグミの割合＝**経路の長さ**（3×N²×ratio が目標）。
  //                   これは所要時間とスコアを決める軸で、**難しさではない**。
  //   minCriticals .. **間違えると詰む判断**の数の目標。これが難しさの軸。
  //                   solve.js のソルバで数え、届く盤面が出るまで引き直す。
  //   corridor ...... true なら分岐を持たない一本道にする（判断ゼロ）。
  //
  // 🔴 **長さを増やしても難しくはならない。**
  // 隣接したグミの塊は端から順に食べれば抜けられることが多く、増えるのは
  // 所要時間だけ。以前は「次数3以上のセル（分岐点）の数」を難易度の代わりに
  // 使っていたが、あれは**選択肢があること**しか見ておらず、その選択を
  // 間違えると詰むのかを見ていない。密度を上げると解が何通りもできるので、
  // 分岐点が増えてもどう進んでも通れてしまう。
  // 実測（2026-09-07）でも、ratio 0.75 の盤面は分岐点が最多なのに
  // 致命的な判断はグミ1個あたりでほとんど増えていなかった。
  //
  // 難しさを作るのは「右へ行くべきか上へ行くべきか」の判断であり、
  // それを生むのは**通れない場所（穴）と一本道の配置**。
  // 4×4 は3面ぶんで48セルあり、経路が短いほど穴が多く残るので、
  // 短い盤面でも十分に難しくできる。
  //
  // 実測（4×4・各200回・中央値／tools/measure-stages.mjs --deep）:
  //   難易度  グミ  穴  判断  致命的  一本道区間  致命的/グミ  生成ms最大
  //   veasy    11   37    0      0        1         0          1
  //   easy     14   34    5      5        3        0.36        5   ← 長さは据え置き
  //   normal   24   24   10      9        4        0.38        8
  //   hard     31   17   14     12        5        0.39       25
  //   vhard    36   12   17     14        5        0.39      211   ← 最終面。以降くり返し
  //
  // 変更前（2026-09-07 の朝）を同じ指標で測ると、致命的な判断は
  // **1面 0 / 2面 0 / 3面 0 / 4面 2 / 5面 6** しかなかった。
  // 115個のグミを食べる間に判断が8回だけで、残りは一本道をなぞる作業だった。
  // いまは 0 / 5 / 9 / 12 / 14 の合計40回。
  //
  // 目標値は「素の生成で出る分布の p90 の少し下」に置いてある。
  // これより上げると引き直しが増えて生成が重くなり、到達率も落ちる
  // （実測: normal を 10 にすると到達率 69%、vhard を 15 にすると 74%）。
  // 到達できなかった場合はそれまでで最良の盤面を使うので、少し易しくなるだけ。
  //
  // ⚠️ **子どもの初見クリア率は測れていない。**
  // 盤面の形は測れるが、人が解けるかは測れない。実機には Undo（z /
  // Backspace）と「やりなおし」があり、スコアは面ごとの最大到達数で持つので
  // 行き止まりでも点は減らないが、時間は失う。
  // **リハーサルで確定すること。** 難しすぎた場合は minCriticals を下げる
  // （長さ＝スコアが変わらないので rankThresholds の再計算が要らない）。
  veasy:  { label: 'Very Easy', ratio: 0.22, tries: 30,  corridor: true },
  easy:   { label: 'Easy',      ratio: 0.30, tries: 40,  minCriticals: 5 },
  normal: { label: 'Normal',    ratio: 0.50, tries: 70,  minCriticals: 9 },
  hard:   { label: 'Hard',      ratio: 0.65, tries: 110, minCriticals: 11 },
  vhard:  { label: 'Very Hard', ratio: 0.75, tries: 110, minCriticals: 13 },

  // --- 平面モード用（正面1面・既定は 5×5 の25セル）---
  // 🔴 **上の値は3面48セル前提。** 平面ではセル数が約半分なので、
  // minCriticals 5〜13 はどの盤面でも到達しない（実測 到達率0%）。
  // 到達しないと generateStage が試行回数と 400ms を毎回使い切るうえ、
  // 難易度のつまみも効かなくなる。平面は平面で測った目標を持つ。
  //
  // 実測（5×5 平面・各200回・中央値）:
  //   キー          ratio  グミ  穴  致命的
  //   pveasy(一本道) 0.22    6   19    0
  //   peasy          0.30    8   17    2
  //   pnormal        0.50   13   12    5
  //   phard          0.65   16    9    6
  peasy:   { label: 'Easy',   ratio: 0.30, tries: 40, minCriticals: 2 },
  pnormal: { label: 'Normal', ratio: 0.50, tries: 70, minCriticals: 4 },
  phard:   { label: 'Hard',   ratio: 0.65, tries: 90, minCriticals: 6 },
};

/** 目標に届く盤面を探すために引き直す上限 */
const GENERATE_TRIES = 24;

/**
 * 引き直しに使ってよい時間（ミリ秒）。
 *
 * 難所の数を数えるのはソルバを回すので、密な盤面では1回あたり数十msかかる
 * （実測: ratio 0.75 で最大 89ms）。上限回数だけだと最悪ケースで
 * ステージ切り替えが目に見えて詰まるため、時間でも打ち切る。
 * 打ち切った場合はそれまでで最良の盤面を使う。
 */
const SELECT_BUDGET_MS = 400;

const now = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

/**
 * ステージを生成する。
 *
 * corridor 指定なら分岐を持たない盤面を、minCriticals 指定なら
 * 「間違えると詰む判断」がその数以上ある盤面を、引き直して選ぶ。
 * どちらも届かなければ、それまでで最も条件に近いものを返す。
 * **返す盤面は必ず解ける**（生成時の経路がそのまま解になっている）。
 */
export function generateStage(N, diffKey, faces = FACES) {
  const diff = DIFFICULTY[diffKey] || DIFFICULTY.normal;

  if (diff.corridor) {
    // 分岐の無い盤面（進む先が常に一つ）。難所の数を数える必要がないので安い
    let best = null;
    for (let i = 0; i < GENERATE_TRIES; i++) {
      const st = generateStageOnce(N, diffKey, faces);
      if (st.stats.branch === 0) return st;
      if (!best || st.stats.branch < best.stats.branch) best = st;
    }
    return best;
  }

  const target = diff.minCriticals ?? 0;
  if (target <= 0) return generateStageOnce(N, diffKey, faces);

  const deadline = now() + SELECT_BUDGET_MS;
  let best = null;
  let bestScore = -1;
  for (let i = 0; i < GENERATE_TRIES; i++) {
    const st = generateStageOnce(N, diffKey, faces);
    const { criticals } = countCriticals(st, SOLVE_NODE_BUDGET);
    st.stats.criticals = criticals;
    if (criticals >= target) return st;
    if (criticals > bestScore) {
      best = st;
      bestScore = criticals;
    }
    if (now() >= deadline) break;
  }
  return best;
}

function generateStageOnce(N, diffKey, faces = FACES) {
  const diff = DIFFICULTY[diffKey] || DIFFICULTY.normal;
  const full = buildAdjacency(N, faces);
  const all = [...full.keys()];
  const target = Math.round(all.length * diff.ratio);

  let best = [];
  for (let t = 0; t < diff.tries; t++) {
    const start = all[(Math.random() * all.length) | 0];
    const p = findLongPath(full, start, target, 3000);
    if (p.length > best.length) best = p;
    if (best.length >= target) break;
  }

  // 路上のセルだけを残す＝残りは「欠落」
  const cells = best;
  const cellSet = new Set(cells);
  const adj = new Map();
  for (const c of cells) {
    adj.set(c, [...full.get(c)].filter((n) => cellSet.has(n)));
  }

  // 難易度の実測値（分岐の多さ・面跨ぎ回数）。
  // ゲーム側が読むのは total（スコアの元）だけで、残りは
  // 生成の点検とツール向けの報告。難所の数（criticals）は
  // ここでは分からないので、盤面を選ぶ generateStage が足す。
  let branch = 0;
  for (const c of cells) branch += Math.max(0, adj.get(c).length - 2);
  let crossFace = 0;
  for (let i = 1; i < cells.length; i++) {
    if (cells[i][0] !== cells[i - 1][0]) crossFace++;
  }

  const pos = new Map();
  const nrm = new Map();
  for (const c of cells) {
    const [f, r, cc] = c.split('-');
    pos.set(c, new THREE.Vector3(...cellPos(f, +r, +cc, N)));
    nrm.set(c, new THREE.Vector3(...FACE_NORMAL[f]));
  }

  return {
    N, cells, cellSet, adj, pos, nrm,
    start: cells[0],
    goal: cells[cells.length - 1],
    stats: { total: cells.length, branch, crossFace, difficulty: diff.label },
  };
}

/** 現在位置から進めるセル（ゴールは最後の1手だけ解禁） */
export function movableFrom(stage, path) {
  const cur = path[path.length - 1];
  const done = new Set(path);
  const isLastMove = path.length === stage.cells.length - 1;
  const out = new Set();
  for (const n of stage.adj.get(cur)) {
    if (done.has(n)) continue;
    if (n === stage.goal && !isLastMove) continue;
    out.add(n);
  }
  return out;
}
