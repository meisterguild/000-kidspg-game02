/**
 * Memorial Card Collector Script
 *
 * このスクリプトは、`results`配下のすべての日時フォルダから
 * 正規のメモリアルカード（memorial_card_*.png）のみを
 * `results/card_images`フォルダに集約します。
 *
 * 実行方法:
 * cd C:\Users\owner\MG\PoC_base\000-kidspg-game01
 * npx ts-node --compiler-options '{"module": "CommonJS"}' src/test/collect-cards.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { verifyPngFileSync } from '../main/services/png-integrity';

interface CopyTarget {
  sourcePath: string;
  destinationPath: string;
}

interface CollectionStats {
  foundCards: number;
  copiedCards: number;
  skippedCards: number;
  /** 壊れていたため集めなかったカード（公開物に混ぜない） */
  brokenCards: number;
  failedCopies: number;
}

class MemorialCardCollector {
  private resultsDir: string;
  private destinationDir: string;
  private stats: CollectionStats = {
    foundCards: 0,
    copiedCards: 0,
    skippedCards: 0,
    brokenCards: 0,
    failedCopies: 0,
  };

  constructor(resultsDir: string) {
    this.resultsDir = path.resolve(resultsDir);
    this.destinationDir = path.join(this.resultsDir, 'card_images');
  }

  /**
   * メインの実行メソッド
   */
  async run(): Promise<void> {
    console.log('🚀 Starting Memorial Card Collector...');
    
    try {
      await fs.mkdir(this.destinationDir, { recursive: true });
      console.log(`- Destination directory: ${this.destinationDir}`);

      const targets = await this.findTargets();
      
      if (targets.length === 0) {
        console.log('✅ No new memorial cards found to copy.');
        return;
      }

      console.log(`🎯 Found ${targets.length} cards to copy.\n`);
      await this.copyFiles(targets);
      this.displayFinalResults();

    } catch (error) {
      console.error('❌ An unexpected error occurred:', error);
      process.exit(1);
    }
  }

  /**
   * コピー対象のファイルを検索
   */
  private async findTargets(): Promise<CopyTarget[]> {
    const targets: CopyTarget[] = [];
    const entries = await fs.readdir(this.resultsDir, { withFileTypes: true });
    const directories = entries.filter(entry => entry.isDirectory() && /^[0-9]{8}_[0-9]{6}$/.test(entry.name));

    for (const dir of directories) {
      const resultDir = path.join(this.resultsDir, dir.name);
      const files = await fs.readdir(resultDir);

      const cards = files.filter(file => 
        file.startsWith('memorial_card_') && 
        file.endsWith('.png') && 
        !file.includes('.dummy.')
      );

      this.stats.foundCards += cards.length;

      for (const card of cards) {
        const sourcePath = path.join(resultDir, card);

        // 🔴 **ファイル名だけで「出来ている」と判断しない。**
        // 書き込み途中で切れた PNG が最終名で残ることがある
        // （2026-09-02: ギャラリーでカードの上半分しか出ない事象）。
        // ここは**後日ネットで公開する成果物を集める最後の関門**なので、
        // 器だけ揃った壊れたカードを公開物へ混ぜてはいけない。
        // 「検査できなかっただけ」（OneDrive のロック等）は集める側に倒す
        // ——公開から漏らすより、あとで目視で気づける方がまだよい。
        const integrity = verifyPngFileSync(sourcePath);
        if (integrity.status === 'corrupt') {
          this.stats.brokenCards++;
          console.warn(
            `⚠️  壊れているため集めません: ${dir.name}/${card} (${integrity.error})`
            + '\n     → node tools/retry-failed.cjs --apply で作り直してください'
          );
          continue;
        }
        if (integrity.status === 'unknown') {
          console.warn(`?? 検査できませんでしたが集めます: ${dir.name}/${card} (${integrity.error})`);
        }

        const destinationPath = path.join(this.destinationDir, card);
        targets.push({ sourcePath, destinationPath });
      }
    }
    return targets;
  }

  /**
   * ファイルをコピーする
   */
  private async copyFiles(targets: CopyTarget[]): Promise<void> {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const progress = `[${i + 1}/${targets.length}]`;
      const fileName = path.basename(target.sourcePath);

      try {
        await fs.copyFile(target.sourcePath, target.destinationPath);
        console.log(`${progress} ✅ Copied ${fileName}`);
        this.stats.copiedCards++;
      } catch (error) {
        console.error(`${progress} ❌ Failed to copy ${fileName}:`, error);
        this.stats.failedCopies++;
      }
    }
  }

  /**
   * 最終結果を表示
   */
  private displayFinalResults(): void {
    console.log('\n🏁 File collection completed!');
    console.log('\n📊 Final Results:');
    console.log(`├── Total memorial cards found: ${this.stats.foundCards}`);
    console.log(`├── Successfully copied: ${this.stats.copiedCards}`);
    console.log(`├── Failed copies: ${this.stats.failedCopies}`);
    console.log(`└── Broken (not collected): ${this.stats.brokenCards}`);
    if (this.stats.brokenCards > 0) {
      console.log('\n⚠️  壊れたカードがあります。公開前に作り直してください:');
      console.log('   node tools/retry-failed.cjs --apply');
    }
  }
}

/**
 * スクリプト実行部分
 */
async function main() {
  const projectRoot = path.resolve(__dirname, '../../');
  // 救済ツール（memorial-card-recovery / retry-failed）と同じく KIDSPG_RESULTS_DIR を見る。
  // 後日のカード公開は、イベントPCから results/ をコピーした別の場所で回すことがあるため。
  // ここだけリポジトリ直下に固定されていると、そのコピーに対して実行できない。
  const resultsDir = process.env.KIDSPG_RESULTS_DIR
    ? path.resolve(process.env.KIDSPG_RESULTS_DIR)
    : path.join(projectRoot, 'results');
  
  const collector = new MemorialCardCollector(resultsDir);
  await collector.run();
}

if (require.main === module) {
  main();
}

