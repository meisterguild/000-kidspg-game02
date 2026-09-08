import * as fs from 'fs/promises';
import * as path from 'path';
import type { GameResult, ResultsData } from '@shared/types';
import { acquireMaintenanceLock, cleanupPartialCardOutputs } from './card-output';
import { isDefinitelyCorrupt, verifyPngFile } from './png-integrity';
import type { ResultsManager } from './results-manager';

/**
 * 起動時に results/ の取りこぼしを点検し、その場で直せるものだけ直す。
 *
 * ■ なぜ要るか
 * カード生成と results.json / result.json の更新は別ステップなので、間でアプリが
 * 落ちると不整合が残る（実際に検証中、アプリ再起動で
 * 「AI画像とカードは出来ているのに参照はダミーのまま」が発生した）。
 * 当日はスタッフが CLI を叩ける状況ではないため、起動のたびに自動で整える。
 *
 * ■ ここでやること（軽い処理だけ）
 *   1. 合成中に落ちた残骸（*.partial）の始末（完成していれば最終名へ救済する）
 *   2. 壊れた正規カードを退避し、参照をプレースホルダへ戻す（見た目の破綻を止める）
 *   3. 正規カードがあるのに参照がダミーのままの回を張り直す
 *   4. 正規カードが無いのに参照が正規のままの回をプレースホルダへ戻す
 *
 * ■ ここでやらないこと
 * AI画像の再生成とカードの再合成は1枚あたり数十秒〜数分かかるため**やらない**。
 * それは `node tools/retry-failed.cjs --apply` の役目。件数だけ数えてログに出す。
 *
 * ■ 壊さないための約束
 *   ・**「検査できなかった」を「壊れている」と扱わない。** OneDrive のロックや
 *     ウイルス対策の干渉で読めないだけの完成品を退避すると、その子のカードは
 *     取り返しがつかない（`png-integrity.ts` の status を見る）
 *   ・参照をプレースホルダへ**先に**倒してから、カードの実体を退避する。
 *     逆順だと、退避成功・参照更新失敗のときに存在しないパスを指した参照が残る
 *   ・プレースホルダ自体が無い／壊れている回は**何もしない**（空の枠を作らない）
 *   ・`tools/retry-failed.cjs` と同時に走らないよう、プロセス間ロックを取る
 */

/** 起動を待たせないため、点検するのは新しい順にこの件数まで（全件は救済ツール側で見る） */
const DEFAULT_SCAN_LIMIT = 200;

/** 全体の時間予算。超えたら打ち切る。受付を止めないことを優先する */
const DEFAULT_BUDGET_MS = 10_000;

export interface ConsistencyReport {
  /** 点検したプレイ数 */
  scanned: number;
  /** 合成中の残骸から最終名へ救済できたカード */
  rescuedCards: string[];
  /** 削除した合成中の残骸 */
  removedPartials: string[];
  /** 退避した壊れたカード（日時 → 理由） */
  quarantinedCards: Array<{ datetime: string; reason: string }>;
  /** 参照を正規カードへ張り直した回 */
  relinked: string[];
  /** 参照をプレースホルダへ戻した回 */
  revertedToDummy: string[];
  /** カードの作り直しが必要な回（このツールでは直さない） */
  needsRebuild: string[];
  /** 検査できなかった回（I/Oエラー等。壊れていると断定はしない） */
  unverified: Array<{ datetime: string; reason: string }>;
  /** result.json が壊れている回（記録の正本が失われている。触らない） */
  unreadableResults: string[];
  /** 時間予算・件数上限で見送った回の数 */
  skipped: number;
  /** ロックが取れず点検自体を行わなかった場合 true */
  lockBusy: boolean;
  /** results.json を読めず表示キャッシュの点検を省略した場合 true */
  cacheUnavailable: boolean;
}

const DIR_PATTERN = /^\d{8}_\d{6}$/;

const emptyReport = (): ConsistencyReport => ({
  scanned: 0,
  rescuedCards: [],
  removedPartials: [],
  quarantinedCards: [],
  relinked: [],
  revertedToDummy: [],
  needsRebuild: [],
  unverified: [],
  unreadableResults: [],
  skipped: 0,
  lockBusy: false,
  cacheUnavailable: false,
});

/** 壊れたカードは消さずに退避する。原因調査に使えるうえ、CLAUDE.md の方針にも合う */
const quarantine = async (filePath: string): Promise<void> => {
  await fs.rename(filePath, `${filePath}.broken-${Date.now()}`);
};

/**
 * 前回どこまで（古い方向へ）点検したかの記録。
 * 起動ごとに「新しい順 scanLimit 件」だけを見ていると、
 * それより古い回は永久に点検されないため、続きから回すために使う。
 */
const CURSOR_FILE = '.startup-check-cursor';

const readCursor = async (resultsDir: string): Promise<string | null> => {
  try {
    const raw = (await fs.readFile(path.join(resultsDir, CURSOR_FILE), 'utf-8')).trim();
    return DIR_PATTERN.test(raw) ? raw : null;
  } catch {
    return null;
  }
};

const writeCursor = async (resultsDir: string, datetime: string | null): Promise<void> => {
  try {
    if (!datetime) {
      // 一周したので先頭へ戻す
      await fs.unlink(path.join(resultsDir, CURSOR_FILE)).catch(() => undefined);
      return;
    }
    await fs.writeFile(path.join(resultsDir, CURSOR_FILE), datetime, 'utf-8');
  } catch {
    // 記録できなくても点検自体は成立する（次回また新しい順から見る）
  }
};

/**
 * results.json（表示キャッシュ）が参照している回を集める。
 *
 * 🔴 **ranking_top はスコア順で時刻と無相関**。朝イチの高得点は終日1位に居座るので、
 * 「新しい順200件」だけを点検すると**ランキング1位の壊れたカードが終日直らない**。
 * 画面に出る回は件数上限に関係なく必ず点検する（config の maxRecent 30 + maxRanking 10 なので最大40件）。
 */
const cacheEntries = (results: ResultsData | null): Array<{ memorialCardPath?: string; resultPath?: string }> => {
  if (!results) return [];
  // 壊れた results.json（null / 配列でない / 要素が null）でも例外にしない。
  // ここで throw すると点検が1件も走らないまま終わる
  const recent = Array.isArray(results.recent) ? results.recent : [];
  const ranking = Array.isArray(results.ranking_top) ? results.ranking_top : [];
  return [...recent, ...ranking].filter((e) => e && typeof e === 'object');
};

/** results.json のパス表記を比較できる形へ揃える（バックスラッシュ混入に備える） */
const normalizeRef = (ref: string): string => ref.split('\\').join('/');

const collectReferencedDirs = (results: ResultsData | null): string[] => {
  const dirs = new Set<string>();
  for (const entry of cacheEntries(results)) {
    const ref = entry.memorialCardPath ?? entry.resultPath;
    if (!ref || typeof ref !== 'string') continue;
    const head = normalizeRef(ref).split('/')[0];
    if (DIR_PATTERN.test(head)) dirs.add(head);
  }
  return [...dirs];
};

/** 表示キャッシュがこの回のプレースホルダを指しているか（＝張り直しが必要か） */
const cacheStillPointsToDummy = (results: ResultsData | null, datetime: string): boolean => {
  const dummyPath = `${datetime}/memorial_card_${datetime}.dummy.png`;
  return cacheEntries(results)
    .some((entry) => typeof entry.memorialCardPath === 'string' && normalizeRef(entry.memorialCardPath) === dummyPath);
};

/** 表示キャッシュがこの回の正規カードを指しているか */
const cachePointsToRegular = (results: ResultsData | null, datetime: string): boolean => {
  const regularPath = `${datetime}/memorial_card_${datetime}.png`;
  return cacheEntries(results)
    .some((entry) => typeof entry.memorialCardPath === 'string' && normalizeRef(entry.memorialCardPath) === regularPath);
};

export interface ConsistencyOptions {
  /** 新しい順に点検する件数。既定 200 */
  scanLimit?: number;
  /** 全体の時間予算(ms)。既定 10000 */
  budgetMs?: number;
}

export const checkResultsConsistency = async (
  resultsDir: string,
  resultsManager: ResultsManager,
  options: ConsistencyOptions | number = {}
): Promise<ConsistencyReport> => {
  // 第3引数に数値を渡す旧い呼び方（件数指定）も受ける
  const { scanLimit = DEFAULT_SCAN_LIMIT, budgetMs = DEFAULT_BUDGET_MS } =
    typeof options === 'number' ? { scanLimit: options, budgetMs: DEFAULT_BUDGET_MS } : options;

  const report = emptyReport();
  const deadline = Date.now() + budgetMs;

  let entries: string[];
  try {
    entries = await fs.readdir(resultsDir);
  } catch {
    return report; // results/ がまだ無い（初回起動）
  }

  // 救済ツールと同時に走ると、相手が作り直した正常なカードを退避してしまう
  const release = await acquireMaintenanceLock(resultsDir);
  if (!release) {
    report.lockBusy = true;
    console.warn('起動時点検 - 別のプロセスが results/ を保守中のため今回は点検を飛ばします');
    return report;
  }

  try {
    // 表示キャッシュは1回だけ読む（回ごとに読み直すと起動が遅くなる）。
    // 🔴 **loadResults は使わない。** あちらは壊れた results.json を退避して
    // 空を返すので、点検のために読むだけで**当日のランキングが消える**。
    const results = await resultsManager.peekResults();
    if (!results) {
      // 読めなかったことを黙って飲み込むと、「点検 200 件」と出るのに
      // 「result.json は正規／results.json はダミー」という肝心の中間状態を
      // 一件も見ていない、というやったつもりになる
      report.cacheUnavailable = true;
      console.error('起動時点検 - results.json を読めないため表示キャッシュの点検を省略します');
    }

    // 新しい順。日時そのままのフォルダ名なので文字列比較で並ぶ
    const all = entries.filter((d) => DIR_PATTERN.test(d)).sort().reverse();
    const referenced = collectReferencedDirs(results).filter((d) => all.includes(d));
    // 画面に出る回を先に、そのあと新しい順、さらに前回の続き（カーソル）。
    //
    // 🔴 カーソルが無いと、`scanLimit` の外に押し出された回は**何度再起動しても
    // 永久に点検されない**。「カードの実体はあるのに正本がプレースホルダを指したまま」
    // の回はその子が後日の公開物から欠けるので、古い方も順番に回していく。
    const cursor = await readCursor(resultsDir);
    const older = cursor ? all.filter((d) => d < cursor) : [];
    const resume = older.slice(0, scanLimit);
    // 🔴 **続き（resume）は「新しい順」より先に回す。**
    // 3000件・予算10秒・OneDrive の実体化では**予算切れが常態**で、
    // 新しい側を先に置くと毎回そこで使い切られ、古い回は永久に点検されない。
    // 画面に出る回（referenced）だけは最優先（表示の破綻を止めるため）。
    const newest = all.slice(0, scanLimit);
    const ordered = [...new Set([...referenced, ...resume, ...newest])];
    report.skipped = Math.max(0, all.length - ordered.length);

    // 実際に点検し終えた回だけを記録する（予定リストの末尾を書くと、
    // 予算切れで一度も見ていない数百件を飛び越えてしまう）。
    //
    // 🔴 **カーソルは「順番に回している分」からしか進めない。**
    // `referenced` は results.json の ranking_top を含み、これはスコア順なので
    // 時刻と無相関（朝イチの高得点が終日1位に居座る）。この古い1件を見ただけで
    // カーソルをそこまで飛ばすと、間に挟まった数百件が**二度と点検されない**
    // ——古い回を順に拾うためにカーソルを入れたのに、それが機能しなくなる。
    const resumeSet = new Set(resume);
    const newestSet = new Set(newest);
    let oldestResume: string | null = null;
    let oldestNewest: string | null = null;

    for (const datetime of ordered) {
      // 予算は厳格に守る（1件も見ずに終わることを許す）。この点検はウィンドウを
      // 出したあと待たずに走らせているので、ここで粘っても受付は速くならない。
      //
      // 「最低1件は見る」ようにすると古い回の掃き出しは前へ進むが、
      // 先頭にいる referenced（画面に出る回。スコア順で時刻と無相関）だけを
      // 毎回見続ける形にもなり得るため、単純な保証は入れない。
      // 予算内で回る件数は scanLimit と実測で調整すること
      // （config.json の results.startupCheckLimit / startupCheckBudgetMs）。
      if (Date.now() > deadline) {
        // 受付を止めないことを優先する。残りは救済ツールで直せる
        report.skipped += ordered.length - report.scanned;
        console.warn(`起動時点検 - 時間予算(${budgetMs}ms)を超えたため打ち切りました`);
        break;
      }

      const resultDir = path.join(resultsDir, datetime);
      report.scanned += 1;
      if (resumeSet.has(datetime) && (!oldestResume || datetime < oldestResume)) oldestResume = datetime;
      if (newestSet.has(datetime) && (!oldestNewest || datetime < oldestNewest)) oldestNewest = datetime;

      // 1. 合成中の残骸を始末する（完成していれば最終名へ救済する）。
      // 同じディレクトリを2度 readdir しない（OneDrive では readdir も安くない）
      const files = await fs.readdir(resultDir).catch(() => [] as string[]);
      const sweep = await cleanupPartialCardOutputs(resultDir, undefined, files);
      report.rescuedCards.push(...sweep.rescued);
      report.removedPartials.push(...sweep.removed);

      // result.json が無い回はゲーム未完了。壊れている回も触らない
      const resultJsonPath = path.join(resultDir, 'result.json');
      let result: GameResult;
      try {
        result = JSON.parse(await fs.readFile(resultJsonPath, 'utf-8')) as GameResult;
      } catch (error) {
        // 存在しないのはゲーム未完了なので普通。JSON が壊れている場合は
        // 記録の正本が失われているので、件数を残して気づけるようにする
        if ((error as { code?: string })?.code !== 'ENOENT') {
          report.unreadableResults.push(datetime);
        }
        continue;
      }

      const cardName = `memorial_card_${datetime}.png`;
      const cardPath = path.join(resultDir, cardName);
      const relativeCardPath = `${datetime}/${cardName}`;
      const integrity = await verifyPngFile(cardPath);

      // AI画像が無い回は「まだカードを作れない」だけなので作り直し対象に数えない。
      // ComfyUI を使わない運用ではこれが大半になり、ログが警告で埋まって
      // 本当に壊れている回が埋没する。
      const hasAnimePhoto = files.some((f) => f.startsWith('photo_anime_') && f.endsWith('.png'));

      if (integrity.status === 'missing') {
        // カードが無いのに参照が正規のまま＝実体の無いパスを指している。
        // 表示が「画像なし」になるのでプレースホルダへ戻す
        if (result.memorialCardPath === relativeCardPath || cachePointsToRegular(results, datetime)) {
          try {
            if (await resultsManager.revertMemorialCardPathToDummy(resultDir)) {
              report.revertedToDummy.push(datetime);
            }
          } catch (error) {
            // results.json は監視・同期・AV が常に触っている最も競合しやすいファイル。
            // 1件の EBUSY で点検全体を落とすと、その起動では1件も直らない
            console.error(`起動時点検 - プレースホルダへ戻せませんでした: ${datetime}`, error);
          }
        }
        if (hasAnimePhoto && !report.needsRebuild.includes(datetime)) report.needsRebuild.push(datetime);
        continue;
      }

      if (integrity.status === 'unknown') {
        // 読めなかっただけかもしれない。**何も壊さず次回に持ち越す**
        report.unverified.push({ datetime, reason: integrity.error ?? '不明' });
        continue;
      }

      if (isDefinitelyCorrupt(integrity)) {
        // 2. 壊れたカードは「参照を先に安全側へ倒してから」退避する。
        // 逆順だと、退避成功・参照更新失敗のときに存在しないパスが残る
        let reverted = false;
        try {
          reverted = await resultsManager.revertMemorialCardPathToDummy(resultDir);
        } catch (error) {
          console.error(`起動時点検 - プレースホルダへ戻せませんでした: ${datetime}`, error);
        }
        if (!reverted) {
          // プレースホルダが無い／壊れている。退避すると表示が空になるので触らない
          report.unverified.push({
            datetime,
            reason: `カードが壊れているがプレースホルダが使えないため保留: ${integrity.error ?? ''}`,
          });
          if (hasAnimePhoto && !report.needsRebuild.includes(datetime)) report.needsRebuild.push(datetime);
          continue;
        }
        report.revertedToDummy.push(datetime);
        try {
          await quarantine(cardPath);
          report.quarantinedCards.push({ datetime, reason: integrity.error ?? '不明' });
        } catch (error) {
          // 参照は既にプレースホルダへ倒してあるので表示は壊れない。
          // 実体が残るだけなので、次回の起動で再試行される
          console.error(`起動時点検 - 壊れたカードの退避に失敗: ${cardPath}`, error);
        }
        if (hasAnimePhoto && !report.needsRebuild.includes(datetime)) report.needsRebuild.push(datetime);
        continue;
      }

      // 3. 正規カードは揃っている。参照が追いついていない回を張り直す。
      //
      // 🔴 result.json だけを見て判断しない。updateMemorialCardPath は
      // 「result.json → results.json」の順に書くので、クラッシュ窓で最も起きやすい
      // 中間状態は「result.json は正規／results.json はプレースホルダのまま」。
      // result.json だけを条件にすると、この**唯一起こりうる中間状態**を素通りし、
      // ランキング画面はプレースホルダを表示し続ける（＝今回直したかった症状そのもの）。
      const needsRelink =
        result.memorialCardPath !== relativeCardPath || cacheStillPointsToDummy(results, datetime);
      if (needsRelink) {
        try {
          if (await resultsManager.updateMemorialCardPath(resultDir)) {
            report.relinked.push(datetime);
          }
        } catch (error) {
          console.error(`起動時点検 - カードパスの張り直しに失敗: ${resultDir}`, error);
        }
      }
    }
    // 次回は「今回いちばん古く点検し終えた回」より古いところから続ける。
    // 続き（resume）を1件も消化できなかった回はカーソルを動かさない
    // ＝次回また同じところから再開する（予算切れで飛ばした分を落とさない）。
    // 続きが空だった（＝一周した／初回）ときだけ、新しい側の末尾を起点にする。
    const nextCursor = oldestResume ?? (resume.length === 0 ? oldestNewest : null);
    if (nextCursor) {
      // 一周したら記録を消して先頭から回し直す
      const hasOlder = all.some((d) => d < nextCursor);
      await writeCursor(resultsDir, hasOlder ? nextCursor : null);
    }
  } finally {
    await release();
  }

  return report;
};

/** 起動ログ用の1行サマリ。当日スタッフが目で追える粒度にする */
export const formatConsistencyReport = (report: ConsistencyReport): string => {
  if (report.lockBusy) return '別プロセスが保守中のため点検を飛ばしました';
  const parts = [`点検 ${report.scanned} 件`];
  if (report.rescuedCards.length) parts.push(`合成中だったカードを救済 ${report.rescuedCards.length}`);
  if (report.removedPartials.length) parts.push(`残骸を削除 ${report.removedPartials.length}`);
  if (report.quarantinedCards.length) parts.push(`壊れたカードを退避 ${report.quarantinedCards.length}`);
  if (report.relinked.length) parts.push(`カードパスを張り直し ${report.relinked.length}`);
  if (report.revertedToDummy.length) parts.push(`参照をプレースホルダへ戻し ${report.revertedToDummy.length}`);
  if (report.unverified.length) parts.push(`検査できず保留 ${report.unverified.length}`);
  if (report.unreadableResults.length) parts.push(`result.json が壊れている ${report.unreadableResults.length}`);
  if (report.cacheUnavailable) parts.push('results.json を読めず表示キャッシュ未点検');
  if (report.skipped) parts.push(`未点検 ${report.skipped}（全件は retry-failed で）`);
  if (report.needsRebuild.length) {
    parts.push(`作り直しが必要 ${report.needsRebuild.length}（node tools/retry-failed.cjs --apply）`);
  }
  return parts.join(' / ');
};
