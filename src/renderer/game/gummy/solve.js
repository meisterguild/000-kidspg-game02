/* ============================================================
   盤面の「本当の難しさ」を測る（描画非依存の純ロジック）

   🔴 **経路の長さは難しさではない。**
   隣接したグミの塊は、端から順に食べていけば抜けられることが多い。
   その場合に増えるのは所要時間だけで、考える回数は増えない。
   次数3以上のセル（分岐点）を数えても「選択肢があること」しか分からず、
   **選択を間違えると詰むのか**は分からない。実測では、いちばん長い盤面
   （ratio 0.75）でも致命的な判断の数は長さに比例していなかった——
   密度を上げると解が何通りもできて、どう進んでも通れてしまうため。

   難しさは「**間違えると詰む判断**が何回あるか」で決まる。
   そこで「いまの局面から最後まで食べきれるか」を判定できるようにして、
     ・進める先が2つ以上ある手 …… 判断
     ・そのうち1つでも「進むと詰む」ものがある手 …… **致命的な判断**
   を数える。致命的でない判断はどちらを選んでも解けるので、考える必要がない。

   generateStage はこの数を目標にして盤面を選ぶ（core.js）。
   ============================================================ */

/**
 * 打ち切りまでに辿るノード数。
 *
 * 越えたら「判定できなかった」として **詰まない側に倒す**。
 * 難しさを過大に見積もらないほうが安全（見積もりが甘いぶん易しくなるだけで、
 * 解けない盤面が出ることはない。盤面は生成時の経路が必ず解になっている）。
 */
export const SOLVE_NODE_BUDGET = 20000;

/**
 * cur にいて remaining を全部通り、ゴールで終われるか。
 *
 * ゴールは最後の1手だけ解禁される（movableFrom と同じ規則）。
 *
 * @param {Map<string,string[]>} adj 盤面の隣接（経路上のセルだけ）
 * @param {Set<string>} remaining まだ食べていないセル（cur を含まない）
 * @param {string} cur いまいるセル
 * @param {string} goal ゴール
 * @param {{nodes:number}} budget 残りノード数。呼び出し側で使い回さないこと
 * @returns {boolean|null} true=食べきれる / false=詰む / null=判定できなかった
 */
export function canFinish(adj, remaining, cur, goal, budget) {
  let unknown = false;
  const rest = new Set(remaining);

  /** rest 全部が node から rest 経由で繋がっているか */
  const allReachable = (node) => {
    const seen = new Set();
    const stack = [node];
    while (stack.length) {
      const at = stack.pop();
      for (const n of adj.get(at)) {
        if (seen.has(n) || !rest.has(n)) continue;
        seen.add(n);
        stack.push(n);
      }
    }
    return seen.size === rest.size;
  };

  /**
   * 一筆書きの端は「いまいるセル」と「ゴール」の2つだけ。
   * それ以外に次数1以下のセルがあれば、そこで行き止まるので解けない。
   */
  const hasDeadEnd = (node) => {
    for (const v of rest) {
      if (v === goal) continue;
      let deg = 0;
      for (const n of adj.get(v)) {
        if (n === node || rest.has(n)) {
          deg++;
          if (deg >= 2) break;
        }
      }
      if (deg <= 1) return true;
    }
    return false;
  };

  const dfs = (node) => {
    if (budget.nodes-- <= 0) {
      unknown = true;
      return false;
    }
    if (rest.size === 0) return node === goal;
    if (!rest.has(goal)) return false;
    if (hasDeadEnd(node)) return false;
    if (!allReachable(node)) return false;

    for (const next of adj.get(node)) {
      if (!rest.has(next)) continue;
      // ゴールは最後の1手でしか踏めない
      if (next === goal && rest.size > 1) continue;
      rest.delete(next);
      if (dfs(next)) return true;
      rest.add(next);
    }
    return false;
  };

  const ok = dfs(cur);
  if (ok) return true;
  return unknown ? null : false;
}

/**
 * 盤面に「間違えると詰む判断」が何回あるかを数える。
 *
 * 生成時の経路（stage.cells の順）を正解として辿り、各手で
 * 「その先へ進むと詰む選択肢」がいくつあるかを調べる。
 *
 * @param {{cells:string[], adj:Map<string,string[]>, goal:string}} stage
 * @param {number} nodeBudget 1回の判定に使えるノード数
 * @returns {{decisions:number, criticals:number, traps:number, unknown:boolean}}
 *   decisions ... 進める先が2つ以上あった手の数
 *   criticals ... そのうち詰む選択肢が1つ以上あった手の数（＝本当の難所）
 *   traps ...... 詰む選択肢の総数
 *   unknown .... 予算切れで判定できない箇所があったか
 */
export function countCriticals(stage, nodeBudget = SOLVE_NODE_BUDGET) {
  const { cells, adj, goal } = stage;
  const eaten = new Set([cells[0]]);
  let decisions = 0;
  let criticals = 0;
  let traps = 0;
  let unknown = false;

  for (let i = 0; i < cells.length - 1; i++) {
    const cur = cells[i];
    const isLastMove = i === cells.length - 2;
    const options = adj
      .get(cur)
      .filter((n) => !eaten.has(n) && (n !== goal || isLastMove));

    if (options.length >= 2) {
      decisions++;
      let fatal = 0;
      for (const opt of options) {
        // 正解の手は必ず解けるので調べない
        if (opt === cells[i + 1]) continue;
        const remaining = new Set();
        for (const c of cells) if (!eaten.has(c) && c !== opt) remaining.add(c);
        const verdict = canFinish(adj, remaining, opt, goal, { nodes: nodeBudget });
        if (verdict === null) unknown = true;
        else if (verdict === false) fatal++;
      }
      if (fatal > 0) criticals++;
      traps += fatal;
    }

    eaten.add(cells[i + 1]);
  }

  return { decisions, criticals, traps, unknown };
}
