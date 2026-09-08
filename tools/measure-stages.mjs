/**
 * 盤面生成の実測。
 *
 * config.json の rankThresholds は「クリアした面の数がそのままランクになる」
 * ように置いてあるが、その計算は **1面あたりのグミ数** に依存する。
 * グミ数は `round(3 × N² × ratio)` を目標にするだけで、経路探索
 * （findLongPath）が目標長に届かないことがあるため、式だけでは決められない。
 * ここで実測してから閾値を出すこと。
 *
 * --deep を付けると「本当の難しさ」まで測る。
 *
 * 🔴 **経路の長さは難しさではない。** 隣接したグミの塊は端から順に食べれば
 * 抜けられることが多く、増えるのは所要時間だけ。難しさは
 * 「**間違えると詰む判断**が何回あるか」で決まる（solve.js のソルバで数える）。
 * 次数3以上のセル（分岐点）の数では代用できない。あれは「選択肢があること」
 * しか見ておらず、その選択を間違えると詰むのかを見ていないため。
 *
 * 使い方:
 *   node tools/measure-stages.mjs                    # 難易度表の全パターン（速い）
 *   node tools/measure-stages.mjs --deep             # 難所の数まで測る（推奨）
 *   node tools/measure-stages.mjs --runs 500         # 試行回数を変える
 *   node tools/measure-stages.mjs --plan --deep      # config.json の構成で1プレイ分
 *   node tools/measure-stages.mjs --deep --ratio 4:0.5/9,0.65/11
 *                                                    # ratio/難所の目標 を試す
 */

import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateStage, DIFFICULTY } from '../src/renderer/game/gummy/core.js';
import { analyseStage } from './lib/solve-stage.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const RUNS = Number(flag('runs', 200));
/**
 * --deep で「本当の難しさ」まで測る。
 *
 * 🔴 **経路の長さと分岐点の数は難しさではない。**
 * 隣接した塊は端から順に食べれば抜けられることが多く、増えるのは所要時間だけ。
 * 次数3以上のセル（分岐点）を数えても「選択肢があること」しか分からず、
 * **選択を間違えると詰むのか**は分からない。実測すると、いちばん長い盤面
 * （ratio 0.75）が致命的な判断は最も少なかった——密度を上げると解が何通りも
 * できて、どう進んでも通れてしまうため。
 * そこで tools/lib/solve-stage.mjs のソルバで
 * 「進むと詰む選択肢がある手」＝致命的な判断を数える。1盤あたり数ms。
 */
const DEEP = has('deep');
const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(here, '..', 'config.json');

/** 経路の形を測る。次数2以下＝進む先が一つしかないセル */
function analyse(st) {
  let junctions = 0;
  let forced = 0;
  for (const c of st.cells) {
    if (st.adj.get(c).length >= 3) junctions++;
    else forced++;
  }
  return { junctions, forced };
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    min: s[0],
    p50: s[Math.floor(s.length * 0.5)],
    p90: s[Math.floor(s.length * 0.9)],
    max: s[s.length - 1],
    mean: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10,
  };
};

export function measure(N, diffKey, runs = RUNS) {
  const totals = [];
  const branches = [];
  const juncs = [];
  const forcedPct = [];
  const times = [];
  const decisions = [];
  const criticals = [];
  const traps = [];
  const corridorRuns = [];
  const holes = [];
  let unknown = 0;
  let shortfall = 0;
  const ratio = DIFFICULTY[diffKey]?.ratio ?? 0;
  const target = Math.round(3 * N * N * ratio);

  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const st = generateStage(N, diffKey);
    times.push(Math.round((performance.now() - t0) * 100) / 100);
    const a = analyse(st);
    totals.push(st.stats.total);
    branches.push(st.stats.branch);
    juncs.push(a.junctions);
    forcedPct.push(pct(a.forced, st.stats.total));
    if (st.stats.total < target) shortfall++;
    if (DEEP) {
      const d = analyseStage(st, 3 * N * N);
      decisions.push(d.decisions);
      criticals.push(d.criticals);
      traps.push(d.traps);
      corridorRuns.push(d.corridorRuns);
      holes.push(d.holes);
      if (d.unknown) unknown++;
    }
  }

  return {
    N,
    diffKey,
    ratio,
    target,
    total: stat(totals),
    branch: stat(branches),
    junctions: stat(juncs),
    forcedPct: stat(forcedPct),
    ms: stat(times),
    shortfallPct: pct(shortfall, runs),
    deep: DEEP
      ? {
          decisions: stat(decisions),
          criticals: stat(criticals),
          traps: stat(traps),
          corridorRuns: stat(corridorRuns),
          holes: stat(holes),
          unknownPct: pct(unknown, runs),
        }
      : null,
  };
}

const SHALLOW_COLS = [
  ['盤', 5, (r) => r.N + 'x' + r.N],
  ['難易度', 14, (r) => r.diffKey],
  ['ratio', 5, (r) => r.ratio],
  ['グミ中央', 8, (r) => r.total.p50],
  ['グミ幅', 7, (r) => r.total.min + '-' + r.total.max],
  ['未達率', 7, (r) => r.shortfallPct + '%'],
  ['分岐', 5, (r) => r.branch.p50],
  ['ms最大', 7, (r) => r.ms.max],
];

/** --deep のときだけ出す列。ここが「本当の難しさ」 */
const DEEP_COLS = [
  ['穴', 4, (r) => r.deep.holes.p50],
  ['判断', 5, (r) => r.deep.decisions.p50],
  ['致命的', 6, (r) => r.deep.criticals.p50],
  ['罠', 4, (r) => r.deep.traps.p50],
  ['一本道区間', 10, (r) => r.deep.corridorRuns.p50],
  ['致命的/グミ', 11, (r) =>
    Math.round((r.deep.criticals.p50 / Math.max(1, r.total.p50)) * 100) / 100],
  ['判定不能', 8, (r) => r.deep.unknownPct + '%'],
];

const COLS = DEEP ? [...SHALLOW_COLS, ...DEEP_COLS] : SHALLOW_COLS;

export const header = () => COLS.map(([h, w]) => String(h).padStart(w)).join(' ');
export const row = (r) => COLS.map(([, w, f]) => String(f(r)).padStart(w)).join(' ');

/** config.json の stageProgression で1プレイ分の累計スコアと閾値の候補を出す */
function plan(runs) {
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const game = config.game;
  const stages = game.stageProgression;
  console.log('config.json の stageProgression（各 ' + runs + ' 回）\n');
  console.log(header());

  const perStage = [];
  const cumulatives = [];
  let cumulative = 0;
  for (const s of stages) {
    const r = measure(s.size, s.difficulty, runs);
    console.log(row(r));
    perStage.push({ gummies: r.total.p50, multiplier: s.multiplier });
    cumulative += r.total.p50 * s.multiplier;
    cumulatives.push(cumulative);
  }

  const lastPer = perStage[perStage.length - 1];
  if (game.repeatLastStage) {
    while (cumulatives.length < 7) {
      cumulatives.push(cumulatives[cumulatives.length - 1] + lastPer.gummies * lastPer.multiplier);
      perStage.push(lastPer);
    }
  }

  console.log('\nクリア面数ごとの累計スコア（グミ数は中央値）:');
  cumulatives.forEach((v, i) => console.log('  ' + String(i + 1).padStart(2) + '面 : ' + v));

  console.log('\n「面数＝ランク」にする rankThresholds（降順・7段）:');
  console.log('  ' + JSON.stringify([...cumulatives.slice(0, 7)].reverse()));

  // 部分点で次の段へ飛び込まないかを確かめる。
  // 進行中の面は「最大到達数 - 1」に部分点率をかけた分が入る（GummyGame.jsx）。
  // クリアすればその面は満点で確定するので、部分点の最大は total-2 手ぶん。
  const rate = game.partialScoreRate ?? 0;
  console.log('\n部分点（partialScoreRate=' + rate + '）の点検:');
  let ok = true;
  for (let i = 0; i < cumulatives.length - 1; i++) {
    const next = perStage[i + 1];
    const maxPartial = Math.floor(Math.max(0, next.gummies - 2) * next.multiplier * rate);
    const reach = cumulatives[i] + maxPartial;
    const bad = reach >= cumulatives[i + 1];
    if (bad) ok = false;
    console.log(
      '  ' + (i + 1) + '面クリア ' + String(cumulatives[i]).padStart(5) +
        ' ＋ 次の面の部分点 最大 ' + String(maxPartial).padStart(4) +
        ' → ' + String(reach).padStart(5) +
        '   次の閾値 ' + String(cumulatives[i + 1]).padStart(5) +
        '   ' + (bad ? '★超える（面数=ランクが崩れる）' : 'OK')
    );
  }
  console.log(ok
    ? '\n判定: 部分点があっても「面数＝ランク」は崩れない'
    : '\n判定: ★崩れる。閾値か部分点率を見直すこと');
}

/**
 * 長さ（ratio）と難しさ（minCriticals）を差し替えて試す。
 *   --ratio 4:0.30/5,0.50/9
 *          盤サイズ : ratio/難所の目標 をカンマ区切りで並べる
 *   難所の目標を省略すると「選ばずに素のまま」＝その ratio の地の難しさが出る。
 *   地の分布を見てから目標値を決めるとよい（p90 の少し下が目安）。
 */
function tryRatios(spec, runs) {
  const sep = spec.indexOf(':');
  const N = Number(spec.slice(0, sep));
  const list = spec.slice(sep + 1);
  console.log(N + 'x' + N + ' で 長さと難しさを振る（各 ' + runs + ' 回）');
  if (!DEEP) console.log('（--deep が無いと難所の数は出ません）');
  console.log('');
  console.log(header());
  for (const item of list.split(',')) {
    const [rr, target] = item.split('/');
    const key = 'p_' + item;
    DIFFICULTY[key] = {
      label: key,
      ratio: Number(rr),
      tries: 110,
      minCriticals: target === undefined ? 0 : Number(target),
    };
    console.log(row(measure(N, key, runs)));
    delete DIFFICULTY[key];
  }
}

if (has('plan')) {
  plan(RUNS);
} else if (flag('ratio')) {
  tryRatios(flag('ratio'), RUNS);
} else {
  console.log('難易度表の全パターン（各 ' + RUNS + ' 回）');
  console.log(DEEP
    ? '「致命的」＝進むと詰む選択肢がある手の数。これが難しさ。「穴」は通れない場所の数\n'
    : '（--deep を付けると「間違えると詰む判断」の数まで測ります）\n');
  console.log(header());
  for (const N of [4, 5]) {
    for (const d of Object.keys(DIFFICULTY)) console.log(row(measure(N, d)));
  }
}
