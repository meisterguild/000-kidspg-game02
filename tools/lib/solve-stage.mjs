/**
 * 盤面の難しさの報告用ラッパ。
 *
 * 🔴 **判定そのものはアプリ側（src/renderer/game/gummy/solve.js）を使う。**
 * 難しさの数え方を2箇所に持つと、片方だけ直したときに
 * 「ツールでは難しいのに実機では易しい」というずれが起きる。
 * ここに置くのは、ツールでしか使わない報告用の指標だけ。
 */

import { countCriticals } from '../../src/renderer/game/gummy/solve.js';

export { canFinish, countCriticals, SOLVE_NODE_BUDGET } from '../../src/renderer/game/gummy/solve.js';

/**
 * 盤面の姿を測る。
 *
 * holes ......... 通れない場所の数（盤のセル数 − グミ数）
 * corridorRuns .. 一本道（進む先が1つだけ）が続く区間の数
 * longestCorridor 一本道の最長
 */
export function analyseStage(stage, boardCells, nodeBudget) {
  const counted = countCriticals(stage, nodeBudget);

  let corridorRuns = 0;
  let longestCorridor = 0;
  let run = 0;
  for (const c of stage.cells) {
    if (stage.adj.get(c).length <= 2) {
      run++;
      if (run > longestCorridor) longestCorridor = run;
    } else {
      if (run > 0) corridorRuns++;
      run = 0;
    }
  }
  if (run > 0) corridorRuns++;

  return {
    ...counted,
    gummies: stage.cells.length,
    holes: boardCells - stage.cells.length,
    corridorRuns,
    longestCorridor,
  };
}
