/**
 * Memorial Card Recovery Script
 * 
 * このスクリプトは、正規版メモリアルカード（memorial_card_{datetime}.png）が
 * 作成されなかった結果データをリカバリするために使用します。
 * 
 * 必要な素材が揃っているフォルダに対して、MemorialCardServiceを使用して
 * 正規版メモリアルカードを再生成します。
 * 
 * 実行方法:
 * cd C:\Users\owner\MG\PoC_base\000-kidspg-game01
 * npx ts-node src/test/memorial-card-recovery.ts
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { NodeMemorialCardService } from './node-memorial-card-service';
import { verifyPngFile } from '../main/services/png-integrity';
import { acquireMaintenanceLock } from '../main/services/card-output';
import type { GameResult } from '../shared/types';

/**
 * このツールが使う「リポジトリ（または配布された ops）のルート」と、
 * 「素材（card_base_images / assets）のあるフォルダ」を決める。
 *
 * 🔴 **__dirname からの段数で決めてはいけない。** ここは実際に踏んだ:
 *   ・tsx 実行（`npm run recovery`）    : __dirname = src/test        → ../.. = リポジトリ直下 ✅
 *   ・コンパイル済み（retry-failed が呼ぶ）: __dirname = dist/main/test → ../.. = **dist/** ❌
 * 段数が1つ足りないため、コンパイル済み経路は config.json を
 * `<root>/dist/config.json` に探して必ず ENOENT で落ちていた。
 * 2026-09-09 の敵対的レビューで指摘され、実際に再現を確認している
 * （`retry-failed.cjs` が使うのはコンパイル済みのほうだけなので、
 * **カード合成の救済が全環境で 100% 失敗していた**）。
 *
 * 🔴 **配布された当日PCでは、道具と素材が別のフォルダにある。**
 *   C:\kidspg\ops\  … tools / dist / config.json / node（ここから実行する）
 *   C:\kidspg\app\  … card_base_images / assets / results（素材と成果物）
 * そこで「上へ辿って config.json のあるフォルダ」をルートとし、
 * 素材はそこに無ければ隣の app\ を見る（tools/lib/resolve-results-dir.cjs と同じ流儀）。
 */
const findUpContaining = (start: string, marker: string): string | null => {
  let dir = path.resolve(start);
  for (;;) {
    if (fsSync.existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

export interface RecoveryRoots {
  /** config.json のあるフォルダ */
  toolRoot: string;
  /** config.json の絶対パス */
  configPath: string;
  /** card_base_images と assets のあるフォルダ（NodeMemorialCardService に渡す） */
  materialRoot: string;
  /** 探した場所。見つからないと言うときに全部見せる */
  searched: string[];
}

export const resolveRecoveryRoots = (from: string = __dirname): RecoveryRoots => {
  const searched: string[] = [];
  const toolRoot = findUpContaining(from, 'config.json');
  if (!toolRoot) {
    // 見つからないときも「探した起点」を返して、呼び出し側が言えるようにする
    return {
      toolRoot: path.resolve(from, '../..'),
      configPath: path.resolve(from, '../..', 'config.json'),
      materialRoot: path.resolve(from, '../..'),
      searched: [from + ' から上へ辿って config.json を探しました'],
    };
  }
  const candidates = [toolRoot, path.resolve(toolRoot, '..', 'app')];
  let materialRoot = toolRoot;
  for (const c of candidates) {
    searched.push(path.join(c, 'card_base_images'));
    if (fsSync.existsSync(path.join(c, 'card_base_images'))) { materialRoot = c; break; }
  }
  return { toolRoot, configPath: path.join(toolRoot, 'config.json'), materialRoot, searched };
};

/** 正規版カードのファイル名。`.partial`（合成中）はここに合致しない */
const REGULAR_CARD_PATTERN = /^memorial_card_.*\.png$/;

interface RecoveryTarget {
  datetime: string;
  resultDir: string;
  hasPhotoAnime: boolean;
  hasResultJson: boolean;
  hasMagickScript: boolean;
  hasRegularCard: boolean;
  hasRecoveryMark: boolean;
  recoverable: boolean;
  lastRecoveryAttempt?: string;
  recoveryStatus?: 'success' | 'failed' | 'in_progress';
}

interface RecoveryStats {
  totalDirectories: number;
  missingRegularCards: number;
  recoverableTargets: number;
  retryTargets: number;
  successfulRecoveries: number;
  failedRecoveries: number;
  skippedTargets: number;
}

class MemorialCardRecovery {
  private resultsDir: string;
  private memorialCardService: NodeMemorialCardService | null = null;
  private stats: RecoveryStats = {
    totalDirectories: 0,
    missingRegularCards: 0,
    recoverableTargets: 0,
    retryTargets: 0,
    successfulRecoveries: 0,
    failedRecoveries: 0,
    skippedTargets: 0
  };

  constructor(resultsDir: string) {
    this.resultsDir = path.resolve(resultsDir);
  }

  /**
   * リカバリマークファイルのパスを取得
   */
  private getRecoveryMarkPath(resultDir: string): string {
    return path.join(resultDir, '.recovery_mark.json');
  }

  /**
   * リカバリマークファイルを作成
   */
  private async createRecoveryMark(resultDir: string, status: 'success' | 'failed' | 'in_progress'): Promise<void> {
    const markPath = this.getRecoveryMarkPath(resultDir);
    const markData = {
      timestamp: new Date().toISOString(),
      status,
      version: '1.0',
      recoveredBy: 'memorial-card-recovery-script'
    };

    try {
      await fs.writeFile(markPath, JSON.stringify(markData, null, 2), 'utf-8');
    } catch (error) {
      console.warn(`Failed to create recovery mark: ${error}`);
    }
  }

  /**
   * リカバリマークファイルを読み取り
   */
  private async readRecoveryMark(resultDir: string): Promise<{
    exists: boolean;
    timestamp?: string;
    status?: 'success' | 'failed' | 'in_progress';
  }> {
    const markPath = this.getRecoveryMarkPath(resultDir);
    
    try {
      const content = await fs.readFile(markPath, 'utf-8');
      const data = JSON.parse(content);
      return {
        exists: true,
        timestamp: data.timestamp,
        status: data.status
      };
    } catch {
      return { exists: false };
    }
  }

  /**
   * リカバリマークファイルを削除（リセット用）
   */
  private async removeRecoveryMark(resultDir: string): Promise<void> {
    const markPath = this.getRecoveryMarkPath(resultDir);
    
    try {
      await fs.unlink(markPath);
    } catch {
      // ファイルが存在しない場合は無視
    }
  }

  /**
   * MemorialCardServiceを初期化
   */
  private async initializeMemorialCardService(): Promise<void> {
    try {
      // 設定ファイルと素材の場所は resolveRecoveryRoots が決める（上の注釈を参照）
      const roots = resolveRecoveryRoots();
      const configContent = await fs.readFile(roots.configPath, 'utf-8');
      const config = JSON.parse(configContent);

      if (!config.memorialCard) {
        throw new Error(`Memorial card configuration not found in ${roots.configPath}`);
      }

      // 素材が本当にあるかを、合成に入る前に見る。
      // 無いまま進むと「壊れたカードを退避したのに作り直せない」で終わる
      const baseDir = path.resolve(
        roots.materialRoot,
        config.memorialCard.cardBaseImagesDir ?? 'card_base_images'
      );
      if (!fsSync.existsSync(baseDir)) {
        throw new Error(
          `カードの土台画像フォルダがありません: ${baseDir}` +
          `\n   探した場所: ${roots.searched.join(' / ')}` +
          `\n   当日PCでは実物は C:\\kidspg\\app\\card_base_images です`
        );
      }

      this.memorialCardService = new NodeMemorialCardService(
        config.memorialCard,
        roots.materialRoot
      );
      console.log(`   設定 : ${roots.configPath}`);
      console.log(`   素材 : ${roots.materialRoot}`);

      console.log('✅ NodeMemorialCardService initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize MemorialCardService:', error);
      throw error;
    }
  }

  /**
   * 結果フォルダをスキャンして復旧対象を特定
   */
  private async scanResultsDirectories(only: string | null = null, forceAll = false): Promise<RecoveryTarget[]> {
    console.log('🔍 Scanning results directories...');
    
    const targets: RecoveryTarget[] = [];
    
    try {
      const entries = await fs.readdir(this.resultsDir, { withFileTypes: true });
      const directories = entries.filter(entry =>
        entry.isDirectory() && /^[0-9]{8}_[0-9]{6}$/.test(entry.name)
        // --only は「1件だけ直す」ためのもの。当日、稼働中のアプリと
        // CPU / ディスクを奪い合わないよう、対象を絞れることが重要
        && (!only || entry.name === only)
      );

      this.stats.totalDirectories = directories.length;
      console.log(`📁 Found ${directories.length} result directories`);

      for (const dir of directories) {
        const datetime = dir.name;
        const resultDir = path.join(this.resultsDir, datetime);
        
        try {
          const files = await fs.readdir(resultDir);
          
          // 🔴 **AI画像の完全性も見る。**
          // 切れた photo_anime から合成すると、ImageMagick が部分デコードして
          // exit 0 になり「IEND 付きの、上半分がグレーのカード」が出来上がる。
          // カード側の検査は器しか見ないので、これは以後**永久に検出できない**。
          const animeFiles = files.filter(file => file.startsWith('photo_anime_') && file.endsWith('.png'));
          let hasPhotoAnime = false;
          for (const file of animeFiles) {
            const integrity = await verifyPngFile(path.join(resultDir, file));
            if (integrity.valid) {
              hasPhotoAnime = true;
            } else {
              console.warn(`⚠️  AI画像が使えないため合成しません: ${datetime}/${file} (${integrity.status}: ${integrity.error})`);
            }
          }
          const hasResultJson = files.includes('result.json');
          const hasMagickScript = files.some(file => file.startsWith('magick_script_') && file.endsWith('.txt'));
          // 🔴 **「ファイルがある」だけでは出来ていると判断しない。**
          // 書き込み途中で切れたPNGが最終名で残っていることがある
          // （2026-09-02: ギャラリーでカードの上半分しか出ない事象）。存在だけで判定すると
          // その回が復旧対象から外れ、壊れたカードが本番まで残ってしまう。
          const regularCards = files.filter(file => REGULAR_CARD_PATTERN.test(file) && !file.includes('.dummy.'));
          let hasRegularCard = false;
          for (const file of regularCards) {
            const integrity = await verifyPngFile(path.join(resultDir, file));
            if (integrity.valid) {
              hasRegularCard = true;
            } else {
              console.warn(`⚠️  壊れたカードを検出したため未生成として扱います: ${datetime}/${file} (${integrity.error})`);
            }
          }

          // リカバリマーク情報を取得
          const recoveryMark = await this.readRecoveryMark(resultDir);
          const hasRecoveryMark = recoveryMark.exists;

          if (!hasRegularCard) {
            this.stats.missingRegularCards++;
          }

          // 復旧可能性の判定。--force-all のときは完全なカードがあっても作り直す
          const basicRecoverable = (forceAll || !hasRegularCard) && hasPhotoAnime && hasResultJson;
          let recoverable = basicRecoverable;

          // 統計カウント
          if (basicRecoverable) {
            if (hasRecoveryMark && recoveryMark.status === 'success') {
              // 🔴 **success マークで「対象外」にしてはいけない。**
              // 一度復旧に成功した回のカードが再び壊れる（アプリの強制終了など）と、
              // マークだけを見て弾いてしまい、**二度と作り直せなくなる**。
              // 実体が無い／壊れている以上、マークは古い情報として無視する。
              this.stats.retryTargets++;
              recoverable = true;
              console.warn(`⚠️  復旧済みマークがありますがカードが無い／壊れているため作り直します: ${datetime}`);
            } else if (hasRecoveryMark && recoveryMark.status === 'failed') {
              this.stats.retryTargets++;
              recoverable = true; // 失敗したものは再試行対象
            } else if (!hasRecoveryMark) {
              this.stats.recoverableTargets++;
              recoverable = true; // 未処理は対象
            }
          }

          targets.push({
            datetime,
            resultDir,
            hasPhotoAnime,
            hasResultJson,
            hasMagickScript,
            hasRegularCard,
            hasRecoveryMark,
            recoverable,
            lastRecoveryAttempt: recoveryMark.timestamp,
            recoveryStatus: recoveryMark.status
          });

        } catch (error) {
          console.warn(`⚠️  Failed to scan directory ${datetime}:`, error);
        }
      }

      return targets;

    } catch (error) {
      console.error('❌ Failed to scan results directory:', error);
      throw error;
    }
  }

  /**
   * 復旧統計を表示
   */
  private displayStats(targets: RecoveryTarget[]): void {
    console.log('\n📊 Recovery Analysis:');
    console.log(`├── Total directories: ${this.stats.totalDirectories}`);
    console.log(`├── Missing regular cards: ${this.stats.missingRegularCards}`);
    console.log(`├── New recoverable targets: ${this.stats.recoverableTargets}`);
    console.log(`├── Failed retry targets: ${this.stats.retryTargets}`);
    console.log(`└── Non-recoverable: ${this.stats.missingRegularCards - this.stats.recoverableTargets - this.stats.retryTargets}\n`);

    // 「復旧済みマーク（success）があるので飛ばした」件数は出さない。
    // カードが無い／壊れている回はマークに関係なく作り直す方針にしたため
    // この件数は常に 0 で、表示すると「飛ばされている」と誤読させる。
    // 実際に作り直す対象は下の New recoverable targets と Retry targets に出る。

    // 失敗からのリトライ対象を表示
    if (this.stats.retryTargets > 0) {
      console.log(`🔄 Retry targets (${this.stats.retryTargets} failed attempts) - will be retried`);
      const retryTargets = targets.filter(t => t.hasRecoveryMark && t.recoveryStatus === 'failed');
      retryTargets.slice(0, 5).forEach(target => {
        const lastAttempt = target.lastRecoveryAttempt ? new Date(target.lastRecoveryAttempt).toLocaleString() : 'unknown';
        console.log(`   ${target.datetime} (last failed: ${lastAttempt})`);
      });
      if (retryTargets.length > 5) {
        console.log(`   ... and ${retryTargets.length - 5} more`);
      }
      console.log('');
    }

    // 非復旧可能な理由を分析
    const nonRecoverable = targets.filter(t => !t.hasRegularCard && !t.recoverable && !t.hasRecoveryMark);
    if (nonRecoverable.length > 0) {
      console.log('❌ Non-recoverable targets:');
      nonRecoverable.forEach(target => {
        const reasons: string[] = [];
        if (!target.hasPhotoAnime) reasons.push('missing photo_anime');
        if (!target.hasResultJson) reasons.push('missing result.json');
        console.log(`   ${target.datetime}: ${reasons.join(', ')}`);
      });
      console.log('');
    }
  }

  /**
   * 単一のメモリアルカードを復旧
   */
  private async recoverSingleCard(target: RecoveryTarget): Promise<boolean> {
    if (!this.memorialCardService) {
      throw new Error('NodeMemorialCardService not initialized');
    }

    try {
      console.log(`🔧 Recovering ${target.datetime}...`);

      // 処理開始マークを作成
      await this.createRecoveryMark(target.resultDir, 'in_progress');

      // result.json が読める形かどうかを先に確かめる。
      // 壊れていると NodeMemorialCardService が中で失敗するが、ここで見ておけば
      // 「なぜ直らないのか」がログの1行で分かる（合成に入る前に落とす）。
      const resultJsonPath = path.join(target.resultDir, 'result.json');
      const resultContent = await fs.readFile(resultJsonPath, 'utf-8');
      const gameResult = JSON.parse(resultContent) as GameResult;
      if (!gameResult || typeof gameResult.rank !== 'string') {
        throw new Error('result.json の内容が想定と違います（rank がありません）');
      }

      // AI画像を使用したメモリアルカード生成（非ダミー）
      const result = await this.memorialCardService.generateMemorialCard(
        target.resultDir, 
        false // isDummy = false（正規版）
      );

      if (result.success) {
        console.log(`✅ Successfully recovered: ${target.datetime} (${result.duration}ms)`);
        await this.createRecoveryMark(target.resultDir, 'success');
        this.stats.successfulRecoveries++;
        return true;
      } else {
        console.log(`❌ Failed to recover ${target.datetime}: ${result.error}`);
        await this.createRecoveryMark(target.resultDir, 'failed');
        this.stats.failedRecoveries++;
        return false;
      }

    } catch (error) {
      console.error(`❌ Error recovering ${target.datetime}:`, error);
      await this.createRecoveryMark(target.resultDir, 'failed');
      this.stats.failedRecoveries++;
      return false;
    }
  }

  /**
   * バッチ復旧を実行
   */
  private async performBatchRecovery(targets: RecoveryTarget[], dryRun: boolean = false): Promise<void> {
    const recoverableTargets = targets.filter(t => t.recoverable);
    
    if (recoverableTargets.length === 0) {
      console.log('ℹ️  No recoverable targets found.');
      return;
    }

    console.log(`🚀 Starting ${dryRun ? 'DRY RUN' : 'RECOVERY'} for ${recoverableTargets.length} targets...\n`);

    for (let i = 0; i < recoverableTargets.length; i++) {
      const target = recoverableTargets[i];
      const progress = `[${i + 1}/${recoverableTargets.length}]`;
      
      console.log(`${progress} Processing ${target.datetime}...`);

      if (dryRun) {
        console.log(`${progress} DRY RUN: Would recover ${target.datetime}`);
        this.stats.skippedTargets++;
      } else {
        await this.recoverSingleCard(target);
      }

      // 進捗表示のため少し待機
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log('\n🏁 Recovery completed!');
  }

  /**
   * 最終結果を表示
   */
  private displayFinalResults(): void {
    console.log('\n📈 Final Results:');
    console.log(`├── Successful recoveries: ${this.stats.successfulRecoveries}`);
    console.log(`├── Failed recoveries: ${this.stats.failedRecoveries}`);
    console.log(`├── Skipped (dry run): ${this.stats.skippedTargets}`);
    
    const totalTargets = this.stats.recoverableTargets + this.stats.retryTargets;
    const recoveryRate = totalTargets > 0 ? 
      Math.round((this.stats.successfulRecoveries / totalTargets) * 100) : 0;
    
    console.log(`└── Recovery rate: ${recoveryRate}%`);

    if (this.stats.failedRecoveries > 0) {
      console.log('\n💡 Tip: Failed recoveries can be retried after fixing issues. Just run the script again!');
      console.log('   Each result directory has a .recovery_mark.json file tracking the status.');
    }
  }

  /**
   * メイン実行メソッド
   */
  async run(options: { dryRun?: boolean; reset?: boolean; forceAll?: boolean; only?: string | null } = {}): Promise<void> {
    const { dryRun = false, reset = false, forceAll = false, only = null } = options;

    console.log('🎯 Memorial Card Recovery Script');
    console.log(`📂 Results directory: ${this.resultsDir}`);
    
    let mode = 'RECOVERY (will modify files)';
    if (dryRun) mode = 'DRY RUN (no changes)';
    if (reset) mode += ' + RESET (clear all marks)';
    if (forceAll) mode += ' + FORCE ALL (rebuild even if a valid card exists)';
    if (only) mode += ` + ONLY ${only}`;
    
    console.log(`🔄 Mode: ${mode}\n`);

    // 🔴 **results/ を書き換える前にプロセス間の排他を取る。**
    // このツールはアプリを起動したまま走らせる運用がある（起動ログでも案内している）。
    // 排他なしだと、アプリの起動時点検が「壊れている」と判断した直後にこちらが
    // 正常なカードを完成させ、点検側がその新しいカードを退避する——という
    // 取り返しのつかない競合が起きる。card-output.ts が同じロックを使っている。
    //
    // ただし `tools/retry-failed.cjs --apply` はロックを取ってからこのスクリプトを
    // 呼ぶため、そこから来た場合（KIDSPG_MAINTENANCE_LOCK_HELD=1）は取り直さない。
    // 取りに行くと親のロックで自分が弾かれ、1件も直せなくなる。
    const lockHeldByParent = process.env.KIDSPG_MAINTENANCE_LOCK_HELD === '1';
    let release: (() => Promise<void>) | null = null;
    if (!dryRun && !lockHeldByParent) {
      release = await acquireMaintenanceLock(this.resultsDir);
      if (!release) {
        console.error(
          '\n❌ 別のプロセスが results/ を保守中です（アプリの起動時点検・救済ツールなど）。'
          + '\n   少し待ってから再実行してください。'
        );
        process.exitCode = 1;
        return;
      }
      // Ctrl-C で finally を通らずに終わると、ロックが残って
      // 「アプリの起動時点検が毎回スキップされる」「再実行も拒否される」状態になる
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.once(sig, () => {
          void (async () => {
            console.log('\n中断されました。保守ロックを解放します');
            try { await release?.(); } catch { /* 解放できなくても終了する */ }
            process.exit(130);
          })();
        });
      }
    }

    try {
      // 結果ディレクトリの存在確認
      await fs.access(this.resultsDir);

      // リセットオプションが指定された場合、すべてのマークファイルを削除。
      // ロックを取った後に行う（点検・救済ツールと同時に results/ を触らない）
      if (reset && !dryRun) {
        console.log('🔄 Resetting all recovery marks...');
        await this.resetAllMarks();
        console.log('✅ All recovery marks cleared.\n');
      }

      // MemorialCardService初期化
      if (!dryRun) {
        await this.initializeMemorialCardService();
      }

      // ディレクトリスキャン
      const targets = await this.scanResultsDirectories(only, forceAll);

      // 統計表示
      this.displayStats(targets);

      // 復旧実行
      await this.performBatchRecovery(targets, dryRun);

      // 最終結果表示
      this.displayFinalResults();

    } catch (error) {
      console.error('\n💥 Recovery script failed:', error);
      process.exitCode = 1;
    } finally {
      // 🔴 process.exit(1) で抜けると解放が走らない。上で exitCode に変えたのはこのため
      if (release) await release();
    }
  }

  /**
   * すべてのリカバリマークをリセット
   */
  private async resetAllMarks(): Promise<void> {
    try {
      const entries = await fs.readdir(this.resultsDir, { withFileTypes: true });
      const directories = entries.filter(entry => 
        entry.isDirectory() && /^[0-9]{8}_[0-9]{6}$/.test(entry.name)
      );

      for (const dir of directories) {
        const resultDir = path.join(this.resultsDir, dir.name);
        await this.removeRecoveryMark(resultDir);
      }
    } catch (error) {
      console.error('Failed to reset recovery marks:', error);
    }
  }
}

/**
 * 「カードの合成が今この環境で本当に使えるか」を確かめる。
 *
 * 🔴 **--dry-run で代用してはいけない。** run() は `if (!dryRun)` の中でしか
 * 初期化しないので、--dry-run は config.json も土台画像も ImageMagick も
 * 一切触らずに終了コード 0 を返す。以前 tools/retry-failed.cjs はこれを
 * 「合成が使える」の根拠にしていたため、**合成が絶対に失敗する環境でも
 * canRebuild = true** になり、壊れたカードを退避して参照をプレースホルダへ
 * 倒したうえで作り直しに失敗する——純粋な劣化で終わっていた
 * （2026-09-09 の敵対的レビュー指摘）。
 *
 * ここで見るのは合成が実際に必要とする4つ:
 *   1. config.json が読めて memorialCard がある
 *   2. 土台画像フォルダがあり、背景が1枚以上ある
 *   3. フォントのある場所が分かる（無ければ magick が文字を置けない）
 *   4. magick が**起動できる**（PATH と VC++ と Smart App Control の実地確認）
 */
export const checkCompose = async (): Promise<{ ok: boolean; lines: string[] }> => {
  const lines: string[] = [];
  const roots = resolveRecoveryRoots();
  lines.push(`設定 : ${roots.configPath}`);
  lines.push(`素材 : ${roots.materialRoot}`);

  let config: { memorialCard?: { cardBaseImagesDir?: string; magickTimeout?: number } };
  try {
    config = JSON.parse(await fs.readFile(roots.configPath, 'utf-8'));
  } catch (error) {
    lines.push(`NG : config.json が読めません（${String(error)}）`);
    return { ok: false, lines };
  }
  if (!config.memorialCard) {
    lines.push('NG : config.json に memorialCard がありません');
    return { ok: false, lines };
  }

  const baseDir = path.resolve(roots.materialRoot, config.memorialCard.cardBaseImagesDir ?? 'card_base_images');
  let backgrounds = 0;
  try {
    backgrounds = (await fs.readdir(baseDir)).filter((f) => /^bg-card-rank-.*\.png$/i.test(f)).length;
  } catch {
    lines.push(`NG : 土台画像フォルダがありません : ${baseDir}`);
    lines.push(`     探した場所 : ${roots.searched.join(' / ')}`);
    return { ok: false, lines };
  }
  if (backgrounds === 0) {
    lines.push(`NG : 土台画像が1枚もありません : ${baseDir}`);
    return { ok: false, lines };
  }
  lines.push(`OK : 土台画像 ${backgrounds} 枚 : ${baseDir}`);

  // ここまで通ったら本物の service を組む（NodeImageCompositionConfig の解決も通る）
  const service = new NodeMemorialCardService(
    config.memorialCard as never,
    roots.materialRoot
  );
  // フォントは magick の -font に渡る。無いと文字が置けず、絵だけのカードになる
  const fontPath = service.getImageConfig().getFontPath();
  if (fontPath && !fsSync.existsSync(fontPath)) {
    lines.push(`注意 : フォントが見つかりません : ${fontPath}（文字が置けない可能性）`);
  } else {
    lines.push(`OK : フォント : ${fontPath || '(既定)'}`);
  }

  // 🔴 magick は**起動できるか**まで見る。「ファイルがある」では足りない
  //    （携帯版の PATH が届いていない / VC++ が無い / SAC に止められた、が全部ここに出る）
  const probe = spawnSync('magick', ['-version'], { encoding: 'utf8', shell: false, timeout: 30_000 });
  if (probe.error || probe.status !== 0) {
    lines.push(`NG : magick を起動できません（${probe.error ? probe.error.message : 'exit ' + probe.status}）`);
    lines.push('     PATH に ImageMagick が入っているか、当日PCなら bin\\ImageMagick を確認してください');
    return { ok: false, lines };
  }
  lines.push(`OK : ${(probe.stdout || '').split(/\r?\n/)[0]}`);
  return { ok: true, lines };
};

/**
 * スクリプト実行部分
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-d');
  const reset = args.includes('--reset') || args.includes('-r');
  const forceAll = args.includes('--force-all') || args.includes('-f');
  const help = args.includes('--help') || args.includes('-h');
  // 合成が使えるかだけを確かめて終わる（retry-failed の事前確認が使う）
  if (args.includes('--check-compose')) {
    const { ok, lines } = await checkCompose();
    for (const l of lines) console.log('   ' + l);
    process.exit(ok ? 0 : 1);
  }
  // --only <日時> で1件だけ直す。当日、稼働中のアプリと CPU / ディスクを
  // 奪い合わないために必要（全件走ると数十分〜数時間かかる）
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] ?? null : null;
  if (onlyIndex >= 0 && !only) {
    console.error('--only には対象の日時フォルダ名を指定してください（例: --only 20260912_101112）');
    process.exit(1);
  }

  if (help) {
    console.log(`
Memorial Card Recovery Script with Retry Support

Usage:
  npx ts-node src/test/memorial-card-recovery.ts [options]

Options:
  --dry-run, -d     Run in dry-run mode (no changes will be made)
  --reset, -r       Reset all recovery marks (clear history)
  --force-all, -f   Force recovery of all targets (rebuild even if a valid card exists)
  --only <日時>     Recover only that result directory (e.g. --only 20260912_101112)
  --check-compose   合成が今この環境で使えるかだけを確かめて終わる（何も書き換えない）
  --help, -h        Show this help message

Recovery Status Management:
  • A card that is missing or broken is always rebuilt, even if a success mark exists
    （復旧済みマークだけを見て弾くと、再び壊れた回が二度と直せなくなる）
  • Failed marks allow automatic retry on next run
  • Use --reset to clear all marks and start fresh
  • Use --force-all to re-process everything regardless of marks

Examples:
  npx ts-node src/test/memorial-card-recovery.ts --dry-run    # Preview what will be done
  npx ts-node src/test/memorial-card-recovery.ts             # Run recovery (skips completed)
  npx ts-node src/test/memorial-card-recovery.ts --reset     # Clear marks and run fresh
  npx ts-node src/test/memorial-card-recovery.ts --force-all # Force re-process everything

Mark Files:
  Each processed directory gets a .recovery_mark.json file with status and timestamp.
`);
    process.exit(0);
  }

  // 結果ディレクトリのパス（プロジェクトルートからの相対パス）
  // 🔴 KIDSPG_RESULTS_DIR を見ること。retry-failed から委譲されるとき、
  // 呼び出し側が別のツリーを見ていると「点検はツリーX・合成はリポジトリ本体」に
  // ずれる。テストが本物の results/ を書き換える事故にも直結する。
  const resultsDir = process.env.KIDSPG_RESULTS_DIR
    ? path.resolve(process.env.KIDSPG_RESULTS_DIR)
    : path.join(resolveRecoveryRoots().materialRoot, 'results');
  
  const recovery = new MemorialCardRecovery(resultsDir);
  await recovery.run({ dryRun, reset, forceAll, only });
}

// スクリプトが直接実行された場合のみmainを実行
if (require.main === module) {
  main().catch(error => {
    console.error('💥 Unhandled error:', error);
    process.exit(1);
  });
}

export { MemorialCardRecovery };