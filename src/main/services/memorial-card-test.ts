import * as path from 'path';
import * as fs from 'fs/promises';
import { MemorialCardService, type MemorialCardConfig } from './memorial-card-service';

/**
 * 記念カード生成のUNITテスト関数
 * 指定されたresultDirに対して記念カード生成を実行します
 */
export class MemorialCardTester {
  private readonly memorialCardService: MemorialCardService;

  constructor() {
    // テスト用設定
    const testConfig: MemorialCardConfig = {
      enabled: true,
      magickTimeout: 60000,
      cardBaseImagesDir: 'card_base_images'
    };
    
    this.memorialCardService = new MemorialCardService(testConfig);
  }

  /**
   * 単一ディレクトリの記念カード生成テスト
   * 
   * @param resultDir - テスト対象のresultディレクトリパス (例: "results/20250816_172248")
   * @param cleanup - 実行前にクリーンアップするかどうか (デフォルト: true)
   * @returns 生成結果
   */
  async testMemorialCardGeneration(resultDir: string, cleanup: boolean = true): Promise<{
    success: boolean;
    outputPath?: string;
    error?: string;
    duration: number;
    scriptPath?: string;
  }> {
    console.log(`\n=== Memorial Card Test ===`);
    console.log(`Target Directory: ${resultDir}`);
    console.log(`Cleanup: ${cleanup}`);
    
    const startTime = Date.now();
    
    try {
      // 絶対パスに変換
      const absoluteResultDir = path.resolve(resultDir);
      
      // ディレクトリ存在確認
      const dirExists = await this.checkDirectoryExists(absoluteResultDir);
      if (!dirExists) {
        return {
          success: false,
          error: `Directory does not exist: ${absoluteResultDir}`,
          duration: Date.now() - startTime
        };
      }

      // 必要ファイルの存在確認
      const validation = await this.validateRequiredFiles(absoluteResultDir);
      if (!validation.valid) {
        return {
          success: false,
          error: `Required files missing: ${validation.missingFiles.join(', ')}`,
          duration: Date.now() - startTime
        };
      }

      // クリーンアップ実行
      if (cleanup) {
        await this.cleanupExistingFiles(absoluteResultDir);
      }

      // 記念カード生成実行
      console.log('Executing memorial card generation...');
      const result = await this.memorialCardService.generateMemorialCard(absoluteResultDir);
      
      const totalDuration = Date.now() - startTime;
      
      // 結果の詳細ログ
      this.logResult(result, totalDuration);
      
      return {
        success: result.success,
        outputPath: result.outputPath,
        error: result.error,
        duration: totalDuration,
        scriptPath: await this.findScriptPath(absoluteResultDir)
      };
      
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      console.error('Test execution error:', error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration: totalDuration
      };
    }
  }

  /**
   * ディレクトリ存在確認
   */
  private async checkDirectoryExists(dirPath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * 必要ファイルの存在確認
   */
  private async validateRequiredFiles(resultDir: string): Promise<{
    valid: boolean;
    missingFiles: string[];
  }> {
    const requiredFiles = [
      'result.json'
    ];
    
    const missingFiles: string[] = [];
    
    // result.jsonの確認
    for (const fileName of requiredFiles) {
      const filePath = path.join(resultDir, fileName);
      try {
        await fs.access(filePath);
      } catch {
        missingFiles.push(fileName);
      }
    }
    
    // photo_anime_*.pngの確認
    try {
      const files = await fs.readdir(resultDir);
      const animeFile = files.find(file => 
        file.startsWith('photo_anime_') && file.endsWith('.png')
      );
      
      if (!animeFile) {
        missingFiles.push('photo_anime_*.png');
      }
    } catch {
      missingFiles.push('directory read error');
    }
    
    return {
      valid: missingFiles.length === 0,
      missingFiles
    };
  }

  /**
   * 既存ファイルのクリーンアップ
   */
  private async cleanupExistingFiles(resultDir: string): Promise<void> {
    const datetime = path.basename(resultDir);
    const filesToCleanup = [
      `magick_script_${datetime}.txt`,
      `memorial_card_${datetime}.png`
    ];
    
    console.log('Cleaning up existing files...');
    
    for (const fileName of filesToCleanup) {
      const filePath = path.join(resultDir, fileName);
      try {
        await fs.unlink(filePath);
        console.log(`  Deleted: ${fileName}`);
      } catch {
        // ファイルが存在しない場合は無視
        console.log(`  Not found: ${fileName}`);
      }
    }
  }

  /**
   * スクリプトファイルパスを取得
   */
  private async findScriptPath(resultDir: string): Promise<string | undefined> {
    const datetime = path.basename(resultDir);
    // スクリプト名にはプロセス固有の印が入る（`magick_script_<日時>.<印>.txt`）ので、
    // 固定名で探すと**必ず見つからない**。前置きで一致を見る。
    // 合成が成功した回のスクリプトは片付けられるため、無いのが正常なこともある。
    const prefix = `magick_script_${datetime}.`;
    try {
      const files = await fs.readdir(resultDir);
      const hit = files.find((f) => f.startsWith(prefix) && f.endsWith('.txt'));
      return hit ? path.join(resultDir, hit) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 結果の詳細ログ出力
   */
  private logResult(result: { success: boolean; outputPath?: string; error?: string }, duration: number): void {
    console.log('\n=== Test Result ===');
    console.log(`Success: ${result.success}`);
    console.log(`Duration: ${duration}ms`);
    
    if (result.success) {
      console.log(`Output: ${result.outputPath}`);
    } else {
      console.log(`Error: ${result.error}`);
    }
    
    console.log('===================\n');
  }

  /**
   * 複数ディレクトリのバッチテスト
   */
  async testMultipleDirectories(resultDirs: string[]): Promise<void> {
    console.log(`\n=== Batch Memorial Card Test (${resultDirs.length} directories) ===`);
    
    for (let i = 0; i < resultDirs.length; i++) {
      const resultDir = resultDirs[i];
      console.log(`\n--- Test ${i + 1}/${resultDirs.length} ---`);
      
      await this.testMemorialCardGeneration(resultDir);
      
      // 次のテストまで少し待機
      if (i < resultDirs.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    console.log('\n=== Batch Test Complete ===');
  }
}

/**
 * CLIから直接実行可能なテスト関数
 */
export async function runMemorialCardTest(resultDir: string): Promise<void> {
  const tester = new MemorialCardTester();
  await tester.testMemorialCardGeneration(resultDir);
}

/**
 * 使用例
 * 
 * // 単一テスト
 * const tester = new MemorialCardTester();
 * await tester.testMemorialCardGeneration('results/20250816_172248');
 * 
 * // バッチテスト
 * await tester.testMultipleDirectories([
 *   'results/20250816_172248',
 *   'results/20250815_212728'
 * ]);
 */