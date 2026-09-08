// src/shared/types/ranking.ts
//
// ランキング画面が読む results.json の型。
//
// 🔴 **形は results.ts の1か所だけで定義する。**
// ここには同じ形（resultPath / memorialCardPath / score / playedAt|rank）が
// 別名でもう一度書かれていた。書き手は main（ResultsManager が results.ts の型で書く）、
// 読み手はレンダラ（この型で読む）なので、片方に項目を足したときに
// もう片方が黙って食い違う——という壊れ方をする形になっていた。
// 呼び出し側の import を壊さないため、名前だけ別に保って再輸出する。
//
// なお、ここにあった `GameResult` は削除した（2026-09-03）。
// 「仕様に定義が無いので推測で置いた」という注記つきの独自定義で、実際の
// result.json とは食い違っていた（timestampJST ではなく timestamp、rank や
// imagePath が無い）。誤ってこちらを import すると、型は通るのに中身が
// 合わないという追いにくい不具合になる。プレイ結果の型は `@shared/types` の
// GameResult が正で、main・レンダラ・救済ツールはすべてそちらを使っている。

import type { RecentResultEntry, RankingResultEntry, ResultsData } from './results';

export type RecentEntry = RecentResultEntry;
export type RankingTopEntry = RankingResultEntry;
export type RankingData = ResultsData;
