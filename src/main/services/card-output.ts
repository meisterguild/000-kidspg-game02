import * as fs from 'fs/promises';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { isDefinitelyCorrupt, verifyPngFile } from './png-integrity';

/**
 * カードの「一時出力 → 検査 → 最終名へ据える」を1か所に集める。
 *
 * ImageMagick は `-write` 先へ直接書くため、最終名を直に渡すと
 * 書き込み途中で落ちたときに**壊れたPNGが最終名で残る**。
 * アプリ・ランキング・救済ツールはどれも「ファイルがあるか」で判断するので、
 * それを「出来ている」と誤認してしまう（2026-09-02 の上半分だけ表示される事象）。
 *
 * MemorialCardService（アプリ本体）と NodeMemorialCardService（救済スクリプト）は
 * 同じ MagickScriptGenerator を共有しているため、確定処理も必ず両方がここを通ること。
 */

/**
 * 合成中の出力に付ける接尾辞。
 *
 * 🔴 **`.png` で終わらせてはいけない。** カードの取りこぼしを探す仕組み
 * （`src/test/memorial-card-recovery.ts` の `/^memorial_card_.*\.png$/`、
 * `tools/retry-failed.cjs`）が「カードは出来ている」と誤認し、
 * 壊れた回が救済対象から外れてしまう。
 * 拡張子が `.png` でなくなるぶんは `-write PNG:<path>` と形式を明示して補う。
 */
const PARTIAL_SUFFIX = '.partial';

/**
 * プロセスごとに固有の印。一時ファイル名に混ぜる。
 *
 * 🔴 **一時名を固定にしてはいけない。** アプリ稼働中に
 * `tools/retry-failed.cjs` / `npm run recovery` を走らせる運用があるため
 * （起動ログでも案内している）、同じ回のカードを2プロセスが同時に合成し得る。
 * 固定名だと**同じ一時ファイルへ2つの writer が交互に書く**ことになり、
 * 「末尾は後着の IEND、途中は先着のバイト列」という**検査を通ってしまう壊れ方**が成立する。
 * IEND は「書き切った」ことしか保証しないので、名前を分けて衝突自体を無くす。
 */
const PROCESS_TOKEN = `${process.pid}-${randomBytes(3).toString('hex')}`;

/** 一時ファイル名などに使うプロセス固有の印 */
export const getProcessToken = (): string => PROCESS_TOKEN;

/**
 * 印の形。**厳格に照合すること。**
 * 緩く「最後のドット区切りを落とす」だけにすると、OneDrive が作る競合コピー
 * （`…png.12345-abc-DESKTOP-A1B2.partial`）まで最終名へ昇格させてしまい、
 * 他機で作られた別内容・別世代の画像がその子のカードとして確定する。
 */
const TOKEN_PATTERN = /^\d+-[0-9a-f]{6}$/;

/**
 * 一時出力から最終名へ戻せる対象。
 * カードとAI画像だけに限る（`.partial` で終わる無関係なファイルを
 * 最終名へ昇格させないため）。
 */
const RESCUABLE_BASENAME = /^(memorial_card_|photo_anime_)/;

/**
 * 合成中の一時出力パス。ImageMagick はここへ書き、
 * 完全性を確認できてから最終名へ rename する。
 */
export const buildPartialOutputPath = (outputPath: string): string =>
  `${outputPath}.${PROCESS_TOKEN}${PARTIAL_SUFFIX}`;

/** 一時出力の残骸かどうか。掃除・救済で使う */
export const isPartialOutput = (fileName: string): boolean => fileName.endsWith(PARTIAL_SUFFIX);

/**
 * 一時出力名から最終名へ戻す。印なしの旧い形（`<最終名>.png.partial`）も受ける。
 * 想定外の形は null を返す（触らせない）。
 */
export const resolveFinalPathFromPartial = (partialPath: string): string | null => {
  if (!partialPath.endsWith(PARTIAL_SUFFIX)) return null;
  const withoutSuffix = partialPath.slice(0, -PARTIAL_SUFFIX.length);

  const candidate = withoutSuffix.endsWith('.png')
    ? withoutSuffix // 印なしの旧形式
    : (() => {
        const match = /^(.*)\.([^.\\/]+)$/.exec(withoutSuffix);
        if (!match) return null;
        const [, base, token] = match;
        if (!TOKEN_PATTERN.test(token)) return null; // 競合コピー等は弾く
        return base.endsWith('.png') ? base : null;
      })();

  if (!candidate) return null;
  const name = candidate.slice(candidate.replace(/\\/g, '/').lastIndexOf('/') + 1);
  return RESCUABLE_BASENAME.test(name) ? candidate : null;
};

/** Windows で一時的に rename が弾かれる代表的なコード。これ以外は待っても直らない */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'UNKNOWN']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 一時ファイルを最終名へ据える。
 *
 * Windows ではランキング画面の監視・ウイルス対策・OneDrive 同期が対象を
 * 開いた瞬間に EPERM / EBUSY（共有違反）になる。**ここで諦めると、
 * 検査に通った完成品を捨てることになる**ので、指数バックオフで十数秒粘る。
 * 1枚あたり最大でも約16秒で、当日のサイクル（1人150〜183秒）には収まる。
 */
export const renameWithRetry = async (from: string, to: string): Promise<void> => {
  const waits = [50, 100, 250, 500, 1000, 2000, 4000, 8000]; // 合計およそ16秒
  let lastError: unknown = null;
  for (let i = 0; i <= waits.length; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string })?.code;
      // ENOENT のような待っても直らないものは即座に諦める（無駄に待たない）
      if (code && !TRANSIENT_CODES.has(code)) break;
      if (i < waits.length) await sleep(waits[i]);
    }
  }
  throw lastError;
};

/**
 * 書き込んだ中身をディスクへ確定させる。
 * NTFS では rename が先に永続化され「リネーム済みなのに中身が途中」というファイルが
 * 電源断で残り得るため、rename の前に fsync を通す。
 * 失敗しても致命ではない（次の検査で拾える）ので、握って続行する。
 */
const flushToDisk = async (filePath: string): Promise<void> => {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r+');
    await handle.sync();
  } catch (error) {
    // ウイルス対策や OneDrive が掴んでいると開けないことがある。
    // 検査には通っているので続行するが、**黙って飛ばさない**
    // （電源断で「名前はあるが中身が途中」が残り得るのはこの経路）。
    console.warn(`カードの fsync を飛ばしました（電源断時に中身が途中で残る可能性）: ${filePath}`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/**
 * 合成直後に呼ぶ。一時出力が完全なら最終名へ据え、そうでなければ理由を返す。
 *
 * @returns null なら成功。文字列ならその理由で失敗（最終名は作られていない）
 */
export const finalizeCardOutput = async (outputPath: string): Promise<string | null> => {
  const partialPath = buildPartialOutputPath(outputPath);

  // 🔴 **最終名に完全なカードがあるなら踏み潰さない。**
  // 稼働中に救済ツールが同じ回を作り直していることがある。古い一時ファイルで
  // 上書きすると、ツールが作った新しいカードを消してしまう。
  const existing = await verifyPngFile(outputPath);
  if (existing.valid) {
    const partial = await verifyPngFile(partialPath);
    if (partial.status !== 'missing') {
      await fs.unlink(partialPath).catch(() => undefined);
    }
    return null;
  }

  // 🔴 **magick の exit code 0 だけでカードを「出来た」と扱わない。**
  // 実体を検査してから最終名へ据える。
  const integrity = await verifyPngFile(partialPath);
  if (!integrity.valid) {
    if (isDefinitelyCorrupt(integrity)) {
      // 明確に壊れているものだけ消す。最終名を作らないので、
      // 取りこぼし検出（recovery / retry-failed）が正しく拾える。
      await fs.unlink(partialPath).catch(() => undefined);
      return `カードの出力が不完全です: ${integrity.error}`;
    }
    // 「検査できなかった」だけの可能性がある（OneDrive のロック等）。
    // 完成品を消してしまわないよう残し、掃除側の救済に委ねる。
    return `カードの出力を確認できませんでした（一時ファイルは残します）: ${integrity.error}`;
  }

  await flushToDisk(partialPath);

  try {
    await renameWithRetry(partialPath, outputPath);
  } catch (error) {
    // 完成品は消さずに残す。cleanupPartialCardOutputs が後で最終名へ据え直す
    return `カードの確定（rename）に失敗しました。一時ファイルを残したので後で救済されます: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  return null;
};

/**
 * 合成が失敗したときに、自分が出した一時ファイルを始末する。
 *
 * 失敗分岐（magick の異常終了・タイムアウト）でも一時ファイルは残る。
 * results/ は OneDrive 同期下なので、放置すると壊れた2.5MBが同期に乗り、
 * そのロックが次のカードの rename 失敗を誘発する。
 * ただし**明確に壊れているときだけ消す**（検査できなかった完成品を消さないため）。
 */
export const discardFailedPartial = async (outputPath: string): Promise<void> => {
  const partialPath = buildPartialOutputPath(outputPath);
  const integrity = await verifyPngFile(partialPath);
  if (integrity.status === 'missing') return;
  if (isDefinitelyCorrupt(integrity)) {
    await fs.unlink(partialPath).catch(() => undefined);
  }
  // valid / unknown は残す。cleanupPartialCardOutputs が救済または掃除する
};

export interface PartialSweepResult {
  /** 完成していたので最終名へ据え直したもの（＝カードを救済できた） */
  rescued: string[];
  /** 壊れていたので消したもの */
  removed: string[];
}

/**
 * 前回の異常終了で残った合成中ファイル（*.partial）を始末する。
 *
 * 🔴 **中身を見ずに消してはいけない。** rename が共有違反で失敗したときの
 * 一時ファイルは**検査に通った完成品**なので、消すとその子のカードが失われる。
 * ここでは完全なものは最終名へ据え直し（救済）、壊れているものだけ消す。
 *
 * 二重起動中の相手が書いている最中のものを消さないよう、**古い残骸だけ**を対象にする
 * （カード1枚の合成は数秒。既定5分放置されているものは残骸と見なす）。
 */
export const cleanupPartialCardOutputs = async (
  resultDir: string,
  staleMs: number = 5 * 60 * 1000,
  /**
   * 呼び出し側がすでに readdir している場合はその一覧を渡す。
   * OneDrive 同期下では readdir も安くないため、同じディレクトリを2度読まない
   * （起動時点検は時間予算の中で回れる件数が変わる）。
   */
  knownFiles?: string[]
): Promise<PartialSweepResult> => {
  const result: PartialSweepResult = { rescued: [], removed: [] };
  let files: string[];
  if (knownFiles) {
    files = knownFiles;
  } else {
    try {
      files = await fs.readdir(resultDir);
    } catch {
      return result;
    }
  }

  for (const file of files) {
    if (!isPartialOutput(file)) continue;
    const full = path.join(resultDir, file);
    try {
      const stat = await fs.stat(full);
      if (Date.now() - stat.mtimeMs <= staleMs) continue;

      const integrity = await verifyPngFile(full);

      if (integrity.valid) {
        const finalPath = resolveFinalPathFromPartial(full);
        if (!finalPath) continue; // 想定外の名前。触らない

        const existing = await verifyPngFile(finalPath);
        if (existing.valid) {
          // 最終名に完全なカードがある＝この一時ファイルは役目を終えている
          await fs.unlink(full).catch(() => undefined);
          result.removed.push(full);
          continue;
        }
        if (existing.status === 'unknown') continue; // 判断できないときは触らない

        // 最終名が無い／壊れている。完成している一時ファイルで置き換える
        await renameWithRetry(full, finalPath);
        result.rescued.push(finalPath);
        continue;
      }

      if (isDefinitelyCorrupt(integrity)) {
        await fs.unlink(full);
        result.removed.push(full);
      }
      // unknown は次回に持ち越す
    } catch {
      // 消せなくても致命ではない（最終名ではないので誤認は起きない）
    }
  }
  return result;
};

/**
 * results/ を書き換える保守処理（起動時点検・救済ツール）を**プロセスを越えて**排他する。
 *
 * ResultsManager の直列化キューはプロセス内にしか効かない。
 * アプリの起動時点検と `tools/retry-failed.cjs` が同時に走ると、
 * 「点検が古いバイト列で壊れていると判定した直後に、ツールが正常なカードを完成させ、
 * その正常なカードを点検が退避する」という取り返しのつかない事故が起きる。
 *
 * @returns 取得できたら release 関数。誰かが持っていたら null
 */
/**
 * 保守ロックを取ってから処理を走らせる。取れなければ何もせず `busy` を返す。
 *
 * 稼働中のアプリ側の修復（カードの確定のやり直し・参照の張り直し）も
 * ここを通すこと。ロックを取らずに走ると、救済ツールが
 * 「壊れている」と判断した直後にアプリが同じ回を書き戻し、
 * ツールがその新しいカードを退避する——という取り返しのつかない
 * 競合になる（当日「稼働中にツールを走らせる」運用がある）。
 */
export const withMaintenanceLock = async <T>(
  resultsDir: string,
  task: () => Promise<T>,
  options: { waitMs?: number } = {}
): Promise<{ ok: true; value: T } | { ok: false; reason: 'busy' }> => {
  const waitMs = options.waitMs ?? 2000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const release = await acquireMaintenanceLock(resultsDir);
    if (release) {
      try {
        return { ok: true, value: await task() };
      } finally {
        await release();
      }
    }
    if (Date.now() >= deadline) return { ok: false, reason: 'busy' };
    await sleep(250);
  }
};

export const acquireMaintenanceLock = async (
  resultsDir: string,
  staleMs: number = 10 * 60 * 1000
): Promise<(() => Promise<void>) | null> => {
  const lockPath = path.join(resultsDir, '.maintenance.lock');
  const payload = JSON.stringify({ pid: process.pid, token: PROCESS_TOKEN, at: new Date().toISOString() });

  const tryCreate = async (): Promise<boolean> => {
    try {
      await fs.writeFile(lockPath, payload, { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as { code?: string })?.code !== 'EEXIST') throw error;
      return false;
    }
  };

  try {
    if (!(await tryCreate())) {
      // 異常終了で残ったロックは、十分に古ければ引き継ぐ。
      // ただし**生きているプロセスのロックを奪ってはいけない**ので、
      // 保持側は下の heartbeat で mtime を更新し続ける。
      const stat = await fs.stat(lockPath).catch(() => null);
      // mtime が未来のロック（他機から同期されたもの・時計補正）は
      // 差が負になって永久に stale と判定されない。未来側も古いものとして扱う。
      const age = stat ? Date.now() - stat.mtimeMs : 0;
      const stale = !!stat && (age > staleMs || age < -staleMs);
      if (!stat || !stale) return null;
      console.warn(`保守ロックが ${Math.round(staleMs / 60000)} 分以上更新されていないため引き継ぎます: ${lockPath}`);
      await fs.unlink(lockPath).catch(() => undefined);
      if (!(await tryCreate())) return null;
    }
  } catch (error) {
    // 🔴 ロックを作れない（権限・ディスク・同期の干渉）ときは**排他できていない**。
    // ゲームを止めないために処理は続けるが、黙って続けると
    // 「ロックがあるから安全」と誤解したまま事故が起きるので必ず記録する。
    console.error(
      `保守ロックを作成できませんでした。排他なしで続行します（同時実行は避けてください）: ${lockPath}`,
      error
    );
    return async () => undefined;
  }

  // 保持している間は mtime を更新し続ける。これが無いと、長時間かかる救済ツールの
  // ロックが staleMs で「古い」と判定され、生きているプロセスから横取りされる。
  //
  // 🔴 更新の前に**持ち主が自分か確かめる**。横取りされた後も更新し続けると、
  // 他プロセスのロックを永久に新鮮なまま保ってしまい（そのプロセスが死んでも）
  // 誰もロックを引き継げなくなる。
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const raw = await fs.readFile(lockPath, 'utf-8');
        const owner = JSON.parse(raw) as { token?: string };
        if (owner.token !== PROCESS_TOKEN) {
          clearInterval(heartbeat);
          return;
        }
        const now = new Date();
        await fs.utimes(lockPath, now, now);
      } catch {
        // 読めない・消えた場合は更新をやめる（他人のものを触らない）
        clearInterval(heartbeat);
      }
    })();
  }, Math.max(1_000, Math.floor(staleMs / 4)));
  // Electron/Node の終了を妨げない
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  return async () => {
    clearInterval(heartbeat);
    // 🔴 **自分のロックだけを消す。** 横取りされた後に unlink すると、
    // 次に取得した別プロセスのロックを消してしまい、排他が実質無効になる。
    try {
      const raw = await fs.readFile(lockPath, 'utf-8');
      const owner = JSON.parse(raw) as { token?: string };
      if (owner.token !== PROCESS_TOKEN) {
        console.warn(`保守ロックの持ち主が変わっているため解放しません: ${lockPath}`);
        return;
      }
    } catch {
      // 読めない・すでに無い場合は消しに行かない（他人のものを消さない）
      return;
    }
    await fs.unlink(lockPath).catch(() => undefined);
  };
};
