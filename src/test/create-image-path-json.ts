/**
 * Image Path JSON Generator Script
 *
 * このスクリプトは、`results`ディレクトリ内をスキャンし、
 * 画像ギャラリー表示に必要な画像ファイルのパス（サムネイル含む）をまとめたJSONファイルを生成します。
 *
 * 実行方法:
 * cd C:\Users\owner\MG\PoC_base\000-kidspg-game01
 * npx ts-node --compiler-options '{\"module\": \"CommonJS\"}' src/test/create-image-path-json.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { verifyPngFileSync } from '../main/services/png-integrity';

interface ImageSet {
  directory: string;
  memorial_card: string | null;
  dummy_memorial_card: string | null;
  photo: string | null;
  anime_photo: string | null;
  photo_thumb: string | null; // サムネイル用のパスを追加
}

class ImagePathJsonGenerator {
  private resultsDir: string;
  private outputJsonPath: string;

  constructor(resultsDir: string, outputJsonPath: string) {
    this.resultsDir = path.resolve(resultsDir);
    this.outputJsonPath = path.resolve(outputJsonPath);
  }

  /**
   * メインの実行メソッド
   */
  async run(): Promise<void> {
    console.log('🚀 Starting Image Path JSON Generator...');
    console.log(`🔍 Scanning directory: ${this.resultsDir}`);

    try {
      const imageSets = await this.scanDirectories();
      await this.writeJsonFile(imageSets);

      console.log(`✅ Successfully generated ${path.basename(this.outputJsonPath)} with ${imageSets.length} entries.`);
      console.log(`   Output file located at: ${this.outputJsonPath}`);

    } catch (error) {
      console.error('❌ An error occurred during JSON generation:', error);
      process.exit(1);
    }
  }

  /**
   * ディレクトリをスキャンして画像セットを収集
   */
  private async scanDirectories(): Promise<ImageSet[]> {
    const entries = await fs.readdir(this.resultsDir, { withFileTypes: true });
    const directories = entries
      .filter(entry => entry.isDirectory() && /^[0-9]{8}_[0-9]{6}$/.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name)); // 日付が新しい順にソート

    const imageSets: ImageSet[] = [];

    for (const dir of directories) {
      const resultDir = path.join(this.resultsDir, dir.name);
      const files = await fs.readdir(resultDir);

      const imageSet: ImageSet = {
        directory: dir.name,
        // 🔴 **壊れたカードを一覧に載せない。**
        // 書き込み途中で切れた PNG は最終名のまま残ることがあり、名前だけで選ぶと
        // ギャラリーに「上半分だけのカード」が並ぶ（2026-09-02 の事象そのもの）。
        // 完全性を確かめ、駄目なら null にして「（なし）」と出させる
        // ——半分だけ映すより、欠けていると分かる方が作り直しにつながる。
        memorial_card: this.findValidPng(
          resultDir,
          files,
          dir.name,
          /^memorial_card_.*\.png$/,
          (name) => !name.includes('.dummy.')
        ),
        dummy_memorial_card: this.findFile(files, dir.name, /^memorial_card_.*\.dummy\.png$/),
        photo: this.findFile(files, dir.name, /^photo_.*\.png$/, name => !name.includes('_anime_') && !name.endsWith('.thumb.png')),
        // AI画像は `..._00001_` `..._00002_` と増える。再投入した回では新しい方が正しいので
        // **新しい順に、完全なものを選ぶ**
        // （image-composition-config.findAnimePhotoPath と同じ扱い）。
        // 先頭1件をそのまま採ると、切れた _00001_ が残っている回で古い方を載せてしまう。
        anime_photo: this.findValidPng(resultDir, files, dir.name, /^photo_anime_.*\.png$/),
        photo_thumb: this.findFile(files, dir.name, /^photo_.*\.thumb\.png$/) // サムネイル画像を検索
      };

      imageSets.push(imageSet);
    }
    return imageSets;
  }

  /**
   * ファイルリストから特定のパターンに一致するファイルを探す
   */
  private findFile(files: string[], dirName: string, pattern: RegExp, additionalCheck?: (name: string) => boolean): string | null {
    const found = files.find(file => {
        const match = pattern.test(file);
        return additionalCheck ? match && additionalCheck(file) : match;
    });
    return found ? path.join(dirName, found).replace(/\\/g, '/') : null;
  }

  /**
   * 一致するファイルのうち、**新しい順に見て最初に完全だったPNG**を返す。
   *
   * 「検査できなかっただけ」（OneDrive のロック等）は載せる側に倒す
   * ——完成しているのに一覧から落とすと、その回は作り直しの対象にもならず
   * 気づかれないまま終わる。明確に壊れているものだけを外す。
   */
  private findValidPng(
    resultDir: string,
    files: string[],
    dirName: string,
    pattern: RegExp,
    additionalCheck?: (name: string) => boolean
  ): string | null {
    const candidates = files
      .filter((file) => pattern.test(file) && (additionalCheck ? additionalCheck(file) : true))
      .sort()
      .reverse();

    let fallback: string | null = null;
    for (const file of candidates) {
      const integrity = verifyPngFileSync(path.join(resultDir, file));
      if (integrity.valid) return path.join(dirName, file).replace(/\\/g, '/');
      if (integrity.status === 'unknown') {
        fallback = fallback ?? path.join(dirName, file).replace(/\\/g, '/');
        console.warn(`?? 検査できませんでした（候補として保持）: ${dirName}/${file} (${integrity.error})`);
        continue;
      }
      console.warn(`⚠️  壊れているため一覧に載せません: ${dirName}/${file} (${integrity.error})`);
    }
    return fallback;
  }

  /**
   * 収集した画像セットをJSONファイルに書き出す
   */
  private async writeJsonFile(data: ImageSet[]): Promise<void> {
    const jsonContent = JSON.stringify(data, null, 2);
    await fs.writeFile(this.outputJsonPath, jsonContent, 'utf-8');
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
  const outputJsonPath = path.join(resultsDir, 'image-paths.json');

  const generator = new ImagePathJsonGenerator(resultsDir, outputJsonPath);
  await generator.run();
}

if (require.main === module) {
  main();
}