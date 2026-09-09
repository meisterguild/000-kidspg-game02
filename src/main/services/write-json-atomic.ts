/**
 * JSON を「一時ファイルへ書いてから rename」で置き換える。
 *
 * ■ なぜ1か所に集めるのか
 * Windows ではランキング画面の監視・ウイルス対策・OneDrive 同期が対象ファイルを
 * 開いた瞬間に EPERM / EBUSY になる。**直書きすると一度の衝突で黙って記録が落ちる。**
 *
 * 🔴 とくに `results/<日時>/result.json` は**後日のカード公開の正本**で、
 * ここが書けないとその子のプレイはランキングにも履歴にも一切現れない
 * （写真だけの孤児フォルダが残り、起動時点検も「ゲーム未完了」として素通りする）。
 * にもかかわらず、以前は**その正本を最初に作る書き込みだけが直書き**で、
 * results.json とカードパスの記録（どちらも results-manager）だけが
 * この仕組みを通っていた（敵対的レビュー 2026-09-09 の指摘）。
 *
 * 実装を results-manager の中に private で持っていたのが原因なので、
 * 外へ出して両方から使う。
 */

import * as fs from 'fs/promises';

import { renameWithRetry } from './card-output';

export const writeJsonAtomic = async (filePath: string, data: unknown): Promise<void> => {
  // tmp 名は呼び出しごとに固有にする（固定名だと同時書き込みで混線する）
  const tmpPath = `${filePath}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    // ランキング画面の監視・AV・OneDrive 同期に負けると記録が落ちる。
    // カードの確定と**同じ実装**（card-output.ts の renameWithRetry）を通す。
    // ここに待ち時間の表をもう1つ持つと、片方だけ直したときに挙動がずれる。
    // また待っても直らないエラー（ENOENT など）は即座に諦めてくれるので、
    // ゲーム終了直後の記録更新を16秒も待たせずに済む。
    await renameWithRetry(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
};
