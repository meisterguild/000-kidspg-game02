import * as fs from 'fs/promises';
import * as path from 'path';
import type { ResultsData, RecentResultEntry, RankingResultEntry, GameResult, AppConfig } from '@shared/types';
import { verifyPngFile } from './png-integrity';
import { renameWithRetry } from './card-output';

const RESULTS_FILE = 'results.json';

export class ResultsManager {
  private resultsDir: string;
  private resultsFilePath: string;
  private config: AppConfig | null;
  /**
   * results.json の更新を直列化するためのキュー。
   * updateResults（ゲーム終了）と updateMemorialCardPath（ComfyUI完了）は
   * 別々の非同期経路から並行して走るため、read-modify-write が競合して
   * 片方の更新が消えたり、tmp ファイルが混線したりする。
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(resultsDir: string, config: AppConfig | null = null) {
    this.resultsDir = resultsDir;
    this.resultsFilePath = path.join(resultsDir, RESULTS_FILE);
    this.config = config;
  }

  /** 直列実行。全ての read-modify-write をこれで包む。 */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    // キュー自体は失敗しても続行させる（1件の失敗で以降が止まらないように）
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** 起動時に前回の異常終了で残った一時ファイルを掃除する。 */
  async cleanupTempFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.resultsDir);
      for (const f of files) {
        // 自分が作ったもの、または明らかに古い残骸だけを消す。
        // 二重起動時に相手の書き込み中 tmp を消すと rename が失敗して1件失われる。
        if (!f.startsWith(`${RESULTS_FILE}.`) || !f.endsWith('.tmp')) continue;
        const mine = f.startsWith(`${RESULTS_FILE}.${process.pid}-`);
        let stale = false;
        if (!mine) {
          try {
            const st = await fs.stat(path.join(this.resultsDir, f));
            stale = Date.now() - st.mtimeMs > 60_000;
          } catch { stale = false; }
        }
        if (mine || stale) {
          await fs.unlink(path.join(this.resultsDir, f)).catch(() => undefined);
        }
      }
    } catch {
      // results ディレクトリがまだ無い場合など。無視してよい
    }
  }

  /**
   * 点検用の非破壊読み取り。
   *
   * 🔴 **loadResults を点検に使ってはいけない。** あちらは JSON が壊れていると
   * results.json を .broken-<時刻> へ退避して空を返す。起動時点検がそれを踏むと、
   * 「電源断で results.json が途中まで書かれていた」だけで**当日のランキング上位10件が
   * その場で消える**（3000件の result.json から再集計する手段はツール側にしかない）。
   * 読めない・壊れているときは null を返し、点検はキャッシュを見ないだけにする。
   */
  async peekResults(): Promise<ResultsData | null> {
    try {
      const raw = await fs.readFile(this.resultsFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as ResultsData;
      if (!parsed || !Array.isArray(parsed.recent) || !Array.isArray(parsed.ranking_top)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async loadResults(): Promise<ResultsData> {
    let data: string;
    try {
      data = await fs.readFile(this.resultsFilePath, 'utf-8');
    } catch (error) {
      if ((error as { code?: string })?.code === 'ENOENT') {
        console.log('results.json not found, creating new one');
        return { recent: [], ranking_top: [] };
      }
      // I/O エラー（EBUSY / EPERM など）で「空」を返すと、
      // 次の保存でその空が本体を上書きしてしまう。読めないときは中断する。
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (parseError) {
      return this.quarantineBrokenResults(parseError);
    }

    // JSON として読めても形が壊れていることがある（recent が配列でない等）。
    // そのまま返すと後段の for...of で例外になり、**その回の記録が丸ごと落ちる**。
    const shaped = parsed as ResultsData;
    if (!shaped || !Array.isArray(shaped.recent) || !Array.isArray(shaped.ranking_top)) {
      return this.quarantineBrokenResults(new Error('results.json の形が想定と違います'));
    }
    return shaped;
  }

  /**
   * 壊れた results.json を退避して空から作り直す。
   *
   * 🔴 **ここで失われるのは「当日のトップ10と直近の履歴」**（表示キャッシュ）。
   * 記録の正本は各プレイの result.json にあるので復元できるが、それは
   * `node tools/retry-failed.cjs --apply --rebuild-index` の役目。
   * 気づかないまま終わらないよう、目印のファイルを置いて後から拾えるようにする。
   */
  private async quarantineBrokenResults(cause: unknown): Promise<ResultsData> {
    const backup = `${this.resultsFilePath}.broken-${Date.now()}`;
    try {
      await fs.rename(this.resultsFilePath, backup);
      console.error(`results.json が壊れていたため退避しました: ${backup}`, cause);
    } catch (renameError) {
      console.error('results.json の退避に失敗しました', renameError);
    }
    try {
      await fs.writeFile(
        path.join(this.resultsDir, '.index-rebuild-needed'),
        [
          `results.json が壊れていたため退避しました (${new Date().toISOString()})`,
          '表示キャッシュ（ランキング・履歴）は空から作り直されています。',
          '各プレイの result.json から作り直すには:',
          '  node tools/retry-failed.cjs --apply --rebuild-index',
        ].join('\n'),
        'utf-8'
      );
    } catch {
      // 目印が置けなくても本処理は続ける
    }
    return { recent: [], ranking_top: [] };
  }

  /**
   * 一時ファイルへ書いてから rename する（書き込み途中の電源断でファイルを壊さないため）。
   *
   * Windows ではランキング画面の監視・ウイルス対策・OneDrive 同期が対象ファイルを
   * 開いた瞬間に EPERM / EBUSY になる。**rename は必ずここを通してリトライすること。**
   * 直書きすると、一度の衝突で黙って記録を落とす。
   */
  private async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
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
  }

  async saveResults(resultsData: ResultsData): Promise<void> {
    await this.writeJsonAtomic(this.resultsFilePath, resultsData);
    console.log(`Results file saved: ${this.resultsFilePath}`);
  }

  async updateResults(resultDir: string, gameResult: GameResult): Promise<void> {
    return this.run(() => this.updateResultsInternal(resultDir, gameResult));
  }

  private async updateResultsInternal(resultDir: string, gameResult: GameResult): Promise<void> {
    const resultsData = await this.loadResults();
    
    const dirName = path.basename(resultDir);
    const resultPath = `${dirName}/result.json`;
    const memorialCardPath = `${dirName}/memorial_card_${dirName}.dummy.png`;
    
    // Format timestamp to yyyy-mm-dd hh:mm:ss
    // helpers.generateJSTTimestamp が "YYYY-MM-DD HH:MM:SS"（JST）で作っているので、
    // ここで整形し直す必要はない
    const playedAt = gameResult.timestampJST;

    // Update recent list
    const recentEntry: RecentResultEntry = {
      resultPath,
      memorialCardPath,
      score: gameResult.score,
      playedAt
    };

    const maxRecent = this.config?.results?.maxRecent || 10;
    resultsData.recent.unshift(recentEntry);
    if (resultsData.recent.length > maxRecent) {
      resultsData.recent.pop();
    }

    // Update ranking list
    this.updateRanking(resultsData, {
      resultPath,
      memorialCardPath,
      score: gameResult.score
    });

    await this.saveResults(resultsData);
  }

  private updateRanking(resultsData: ResultsData, newEntry: Omit<RankingResultEntry, 'rank'>): void {
    // Find insertion position based on score (descending)
    let insertIndex = 0;
    for (let i = 0; i < resultsData.ranking_top.length; i++) {
      if (newEntry.score >= resultsData.ranking_top[i].score) {
        insertIndex = i;
        break;
      }
      insertIndex = i + 1;
    }

    // Insert new entry
    const entryWithRank: RankingResultEntry = {
      ...newEntry,
      rank: insertIndex + 1
    };
    
    resultsData.ranking_top.splice(insertIndex, 0, entryWithRank);

    // Update ranks for all entries
    resultsData.ranking_top.forEach((entry, index) => {
      entry.rank = index + 1;
    });

    // Remove excess entries
    const maxRanking = this.config?.results?.maxRanking || 10;
    if (resultsData.ranking_top.length > maxRanking) {
      resultsData.ranking_top.splice(maxRanking);
    }
  }

  // 受け取った値をそのまま返すだけの formatTimestamp は削除した（2026-09-03）。
  // 「ここで整形している」と読めてしまうが実際には何もしていないため、
  // 表記を変えたい人がここを直しても効かない。
  // 記録される文字列は helpers.generateJSTTimestamp が作る
  // "YYYY-MM-DD HH:MM:SS"（JST）で、カードに焼く際の整形は
  // ImageCompositionConfig.formatTimestampWithoutSeconds が行う。

  /**
   * メモリアルカードのパスをダミーから正規のものに更新する。
   *
   * 🔴 **results.json の recent / ranking_top は「画面に出す分だけの表示キャッシュ」**で、
   * それぞれ maxRecent / maxRanking 件しか保持しない。3000人規模だと、AI変換が終わる頃には
   * 当人のエントリが既に押し出されている。以前はその場合に警告を出すだけで何も残さず、
   * **31人目以降のカードは results.json のどこからも参照されないまま**になっていた。
   *
   * そのため記録の正本は各プレイの `results/<日時>/result.json` 側に置く。
   * ここへ書くのは1プレイ1ファイルなので、人数が増えても競合も肥大もしない。
   * 後日のカード公開はこの result.json を集めて作る。
   */
  async updateMemorialCardPath(resultDir: string): Promise<boolean> {
    return this.run(() => this.updateMemorialCardPathInternal(resultDir));
  }

  /**
   * @returns 参照を正規カードへ向けられたか。false のときは何も書いていない
   */
  private async updateMemorialCardPathInternal(resultDir: string): Promise<boolean> {
    const dirName = path.basename(resultDir);
    const dummyPath = `${dirName}/memorial_card_${dirName}.dummy.png`;
    const regularPath = `${dirName}/memorial_card_${dirName}.png`;

    // 🔴 **実体を確かめてからパスを書く。**
    // 呼び出し側が「カードは出来た」と思っていても、合成が失敗している
    // ことがある（magick の異常終了・rename の共有違反）。存在確認なしで書くと、
    // 後日のカード公開の正本（result.json）が**実体の無いパス**を指し、
    // その子だけ公開物から欠ける。
    const integrity = await verifyPngFile(path.join(resultDir, `memorial_card_${dirName}.png`));
    // 🔴 **「読めなかった」で更新を止めない。**
    // rename 直後は OneDrive のアップロードとウイルス対策のスキャンが走るため
    // unknown は普通に起きる。ここで止めると「カードは完全な形であるのに、
    // 後日の公開の正本がプレースホルダを指したまま確定する」＝その子が公開物から欠ける。
    // 参照を書いてよいのは「実体があり、明確に壊れてはいない」とき。
    if (integrity.status === 'missing' || integrity.status === 'corrupt') {
      console.error(
        `ResultsManager - 正規カードを参照できないため更新を中止: ${dirName} (${integrity.status}: ${integrity.error})`
      );
      return false;
    }
    if (integrity.status === 'unknown') {
      console.warn(
        `ResultsManager - カードを検査できませんでしたが実体はあるので参照を更新します: ${dirName} (${integrity.error})`
      );
    }

    // 1. 正本（各プレイの result.json）へ書く。押し出されていても必ず残る。
    const wroteResultJson = await this.writeCardPathToResultJson(resultDir, regularPath);

    // 2. 表示キャッシュに残っていれば差し替える（ランキング画面がこれを見ている）
    const resultsData = await this.loadResults();

    let updatedRecent = false;
    for (const entry of resultsData.recent) {
      if (entry.memorialCardPath === dummyPath) {
        entry.memorialCardPath = regularPath;
        updatedRecent = true;
        break;
      }
    }

    let updatedRanking = false;
    for (const entry of resultsData.ranking_top) {
      if (entry.memorialCardPath === dummyPath) {
        entry.memorialCardPath = regularPath;
        updatedRanking = true;
        break;
      }
    }

    if (updatedRecent || updatedRanking) {
      await this.saveResults(resultsData);
      console.log(`ResultsManager - 表示キャッシュのカードパスを更新: ${dirName}`);
    } else if (wroteResultJson) {
      // 表示キャッシュから押し出された後に変換が終わるのは**正常**。
      // 正本には書けているので警告ではなく情報として残す。
      console.log(`ResultsManager - ${dirName} は表示キャッシュ外（result.json には記録済み）`);
    } else {
      // 正本への書き込みが失敗している。ここを見逃すと、後日のカード公開で
      // この子だけ欠ける（表示キャッシュは10件しか持たないため頼れない）。
      console.error(`ResultsManager - ${dirName} は正本への記録に失敗（表示キャッシュ外）`);
    }

    // 🔴 正本（result.json）へ書けていないなら成功と言わない。
    // 表示キャッシュは 30/10 件しか持たないので、翌日には手掛かりが消える。
    // ここで true を返すと、点検レポートも main.ts のログも「直った」と表示してしまう。
    return wroteResultJson;
  }

  /**
   * カードのパスをダミーへ戻す（起動時の整合性修復で使う）。
   *
   * 正規カードが壊れていた場合、そのまま参照し続けると
   * ギャラリー・ランキングに**上半分だけのカード**が出る。
   * 作り直しには AI 画像の再合成が必要で起動時にはできないため、
   * まず表示をプレースホルダへ戻して見た目の破綻を止める。
   * 作り直しは `node tools/retry-failed.cjs --apply` が行う。
   */
  async revertMemorialCardPathToDummy(resultDir: string): Promise<boolean> {
    return this.run(() => this.revertMemorialCardPathToDummyInternal(resultDir));
  }

  /**
   * @returns ダミーへ戻せたか。false のときは何も書いていない
   *          （プレースホルダ自体が無い／壊れている場合。空の参照を作らない）
   */
  private async revertMemorialCardPathToDummyInternal(resultDir: string): Promise<boolean> {
    const dirName = path.basename(resultDir);
    const dummyPath = `${dirName}/memorial_card_${dirName}.dummy.png`;
    const regularPath = `${dirName}/memorial_card_${dirName}.png`;

    // 🔴 **プレースホルダの実体を確かめる。**
    // ダミーが無い回は実在する（ダミー生成前にアプリが落ちた、生成が失敗した）。
    // 存在しないパスへ戻すと、ランキング・ギャラリーの枠が「画像なし」になる。
    // その場合は何もせず、壊れた参照のまま救済ツールに任せる方がまだ実害が小さい。
    const dummyIntegrity = await verifyPngFile(path.join(resultDir, `memorial_card_${dirName}.dummy.png`));
    // 実体があり明確に壊れていなければ戻してよい（unknown は読めなかっただけ）
    if (dummyIntegrity.status === 'missing' || dummyIntegrity.status === 'corrupt') {
      console.error(
        `ResultsManager - プレースホルダが使えないためダミー戻しを中止: ${dirName} (${dummyIntegrity.status}: ${dummyIntegrity.error})`
      );
      return false;
    }

    const wroteResultJson = await this.writeCardPathToResultJson(resultDir, dummyPath);

    const resultsData = await this.loadResults();
    let updated = false;
    for (const entry of [...resultsData.recent, ...resultsData.ranking_top]) {
      if (entry.memorialCardPath === regularPath) {
        entry.memorialCardPath = dummyPath;
        updated = true;
      }
    }
    if (updated) {
      await this.saveResults(resultsData);
      console.log(`ResultsManager - 壊れたカードの参照をダミーへ戻しました: ${dirName}`);
    }
    return wroteResultJson || updated;
  }

  /**
   * 各プレイの result.json に確定したカードのパスを書き戻す。
   * 読み書きは当該ディレクトリ1件だけなので、results.json のような競合は起きない。
   *
   * @returns 記録できたか（既に同じ値だった場合も true）。
   *          失敗を戻り値で返さないと、呼び出し側が「正本には記録済み」と
   *          誤ったログを出す（＝その子のカードが後日の公開で欠ける原因を隠す）。
   */
  private async writeCardPathToResultJson(resultDir: string, cardPath: string): Promise<boolean> {
    const filePath = path.join(resultDir, 'result.json');
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw) as GameResult;
      if (data.memorialCardPath === cardPath) return true;
      data.memorialCardPath = cardPath;
      // saveResults と同じアトミック書き込み（rename リトライ込み）を通す。
      // ここは 3000人規模での「記録の正本」なので、1回の EPERM で落とすと
      // 後日のカード公開でその子だけ欠ける。
      await this.writeJsonAtomic(filePath, data);
      return true;
    } catch (error) {
      // ここで失敗しても表示キャッシュ側の更新は続ける。
      // ただし黙って捨てない（後日のカード公開でこの子だけ欠ける）。
      console.error(`ResultsManager - result.json へのカードパス記録に失敗: ${filePath}`, error);
      return false;
    }
  }
}