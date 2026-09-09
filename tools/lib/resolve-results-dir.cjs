/**
 * 救済ツールが results/ の場所を決める判断を、1か所に集める。
 *
 * ■ なぜ要るのか（敵対的レビュー 2026-09-09 の指摘）
 * 当日PCの形はこうなっている:
 *
 *   C:\kidspg\
 *   ├── app\results\   ← **実物はここ**
 *   └── ops\           ← 救済ツールはここから実行する（tools / dist / node）
 *
 * ツールは `path.join(ROOT, 'results')` を既定にしていたため、ops から実行すると
 * `C:\kidspg\ops\results` を見て「results フォルダがありません」で止まっていた。
 * 🔴 **当日いちばん切迫した場面で使う道具が、配布された形では1つも動かない**
 * という状態だった。しかも retry-failed は終了コード 0 で終わるため、
 * 「エラーが出ていない＝直った」と読めてしまう。
 *
 * ■ 決め方（上から順に）
 *   1. 環境変数 KIDSPG_RESULTS_DIR（テストと、明示したいとき）
 *   2. <ROOT>/results         … 開発機のリポジトリ直下
 *   3. <ROOT>/../app/results  … 配布された ops から見た実物
 *
 * 2 と 3 は**存在するほうを選ぶ**。どちらも無ければ 2 を返し、
 * 呼び出し側が「無い」と言うときに**探した場所を全部見せる**ようにする
 * （パスを出さずに「ありません」だけ出すと、当日その場で直せない）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @param {string} root ツールから見たリポジトリ（または ops）のルート
 * @returns {{ dir: string, from: string, candidates: string[] }}
 */
const resolveResultsDir = (root) => {
  if (process.env.KIDSPG_RESULTS_DIR) {
    return {
      dir: path.resolve(process.env.KIDSPG_RESULTS_DIR),
      from: 'KIDSPG_RESULTS_DIR',
      candidates: [path.resolve(process.env.KIDSPG_RESULTS_DIR)],
    };
  }
  const own = path.join(root, 'results');
  const sibling = path.join(root, '..', 'app', 'results');
  const candidates = [own, sibling];
  for (const [dir, from] of [
    [own, '<ルート>/results'],
    [sibling, '<ルート>/../app/results（配布された ops から見た実物）'],
  ]) {
    try {
      if (fs.statSync(dir).isDirectory()) return { dir, from, candidates };
    } catch {
      // 次の候補へ
    }
  }
  return { dir: own, from: '（どれも見つからず）', candidates };
};

/** 「無い」と言うときに、探した場所を全部見せる文面を作る */
const describeMissing = (resolved) =>
  [
    'results フォルダが見つかりません。探した場所:',
    ...resolved.candidates.map((c) => '  ' + c),
    '',
    '当日PCでは実物は C:\\kidspg\\app\\results です。',
    '場所を明示して実行することもできます:',
    '  set KIDSPG_RESULTS_DIR=C:\\kidspg\\app\\results',
  ].join('\n');

module.exports = { resolveResultsDir, describeMissing };
