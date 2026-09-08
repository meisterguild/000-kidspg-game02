import * as path from 'path';
// 同期の存在確認とディレクトリ走査に使う。関数の中で require せず、ここで1度だけ読む
// （メソッドごとに require すると、テスト差し替えや ESM 化のときに漏れが出る）
import * as fsSync from 'fs';
import { app } from 'electron';
import type { GameResult } from '../../shared/types';
import { RANK_NAMES } from '../../shared/utils/helpers';
import { verifyPngFileSync } from './png-integrity';

export interface Position {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface TextElement {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  gravity?: string;
  bold?: boolean;
  strokeWidth?: number;
}

export interface CompositionConfig {
  backgroundImagePath: string;
  foregroundPosition: Position;
  textElements: TextElement[];
  outputFileName: string;
  /**
   * カードに焼き込むフォント。
   * 以前は magick-script-generator が独自にパスを埋め込んでおり、
   * ここ（validateConfig が存在確認する側）を変えてもスクリプトは別のフォントを使う、
   * という乖離が起きていた。**フォントの出どころはこの1か所だけにする。**
   */
  fontPath: string;
}

export class ImageCompositionConfig {
  private readonly cardBaseImagesDir: string;
  private readonly fontPath: string;
  private readonly assetsDir: string;

  constructor(cardBaseImagesDir: string = 'card_base_images') {
    // 絶対パスに解決
    if (app.isPackaged) {
      // 本番環境: exeファイルと同じディレクトリ
      this.cardBaseImagesDir = path.join(path.dirname(app.getPath('exe')), cardBaseImagesDir);
      this.assetsDir = path.join(path.dirname(app.getPath('exe')), 'assets');
    } else {
      // 開発環境: プロジェクトルート相対
      // path.resolve は cwd 基準なので、exe と別のフォルダから起動すると
      // カード背景を見失う。results と同じく app.getAppPath() を基準にする。
      this.cardBaseImagesDir = path.join(app.getAppPath(), cardBaseImagesDir);
      this.assetsDir = path.join(app.getAppPath(), 'assets');
    }
    this.fontPath = 'C:/Windows/Fonts/meiryo.ttc';
  }

  /**
   * ランクに基づいて背景画像パスを取得
   */
  getBackgroundImagePath(rank: string): string {
    const rankMapping: Record<string, string> = {
      [RANK_NAMES.BEGINNER]: 'bg-card-rank-01-beginner.png',
      [RANK_NAMES.AMATEUR]: 'bg-card-rank-02-amateur.png',
      [RANK_NAMES.ADVANCED]: 'bg-card-rank-03-advanced.png',
      [RANK_NAMES.EXPERT]: 'bg-card-rank-04-expert.png',
      [RANK_NAMES.VETERAN]: 'bg-card-rank-05-veteran.png',
      [RANK_NAMES.ELITE]: 'bg-card-rank-06-elite.png',
      [RANK_NAMES.MASTER]: 'bg-card-rank-07-master.png',
      [RANK_NAMES.LEGEND]: 'bg-card-rank-08-legend.png'
    };

    const filename = rankMapping[rank] || rankMapping[RANK_NAMES.BEGINNER]; // デフォルトはビギナー
    return path.join(this.cardBaseImagesDir, filename);
  }

  /**
   * 前景画像（photo_anime.png）の配置位置を取得
   */
  getForegroundPosition(): Position {
    return {
      x: 180,
      y: 190,
      width: 650,
      height: 650
    };
  }

  /**
   * テキスト描画要素を取得
   */
  getTextElements(gameResult: GameResult): TextElement[] {
    const elements: TextElement[] = [
      {
        text: gameResult.nickname,
        x: 140,
        y: 190,
        fontSize: 50,
        color: '#d3593a',  // darkorange in RGB
        gravity: 'Center',
        bold: true,
        strokeWidth: 1
      },
      {
        text: gameResult.rank,
        x: 140,
        y: 295,
        fontSize: 50,
        color: '#d3593a',
        gravity: 'Center',
        bold: true,
        strokeWidth: 1
      },
      {
        text: gameResult.score.toString(),
        x: 140,
        y: 400,
        fontSize: 80,
        color: '#d3593a',
        gravity: 'Center',
        bold: true,
        strokeWidth: 2  // スコアは太めに
      },
      {
        text: this.formatTimestampWithoutSeconds(gameResult.timestampJST),
        x: 140,
        y: 510,
        fontSize: 50,
        color: '#d3593a',
        gravity: 'Center',
        bold: true,
        strokeWidth: 1
      }
    ];

    return elements;
  }

  /**
   * 出力ファイル名を生成
   */
  getOutputFileName(datetime: string): string {
    return `memorial_card_${datetime}.png`;
  }

  /**
   * ダミー用出力ファイル名を生成
   */
  getDummyOutputFileName(datetime: string): string {
    return `memorial_card_${datetime}.dummy.png`;
  }

  /**
   * タイムスタンプから秒を除去してフォーマット
   * "2025-08-16 17:23:54" → "2025-08-16 17:23"
   */
  private formatTimestampWithoutSeconds(timestamp: string): string {
    try {
      // "YYYY-MM-DD HH:MM:SS" 形式を想定
      const parts = timestamp.split(' ');
      if (parts.length === 2) {
        const datePart = parts[0]; // "2025-08-16"
        const timePart = parts[1]; // "17:23:54"
        
        // 時間部分から秒を除去
        const timeWithoutSeconds = timePart.substring(0, 5); // "17:23"
        
        return `${datePart} ${timeWithoutSeconds}`;
      }
      
      // フォーマットが想定と異なる場合は元のまま返す
      return timestamp;
    } catch (error) {
      console.warn('ImageCompositionConfig - Error formatting timestamp:', error);
      return timestamp;
    }
  }

  // getFontSettings() は削除した（2026-09-03）。呼び出し元が無く、返していた
  // defaultSize / defaultColor は getTextElements が要素ごとに持つ値と重複していて、
  // 「ここを直せばカードの文字が変わる」という誤解のもとだった。
  // フォントの出どころは this.fontPath（CompositionConfig.fontPath）1本に絞ってある。

  /**
   * 合成設定を組み立てる。
   *
   * 正規カードとプレースホルダ版で違うのは**出力ファイル名だけ**（背景・配置・
   * 文字はスコアとランクから決まるので同じ）。以前は同じ内容の関数が2つ並び、
   * さらに MemorialCardService 側でも「正規版を作ってから出力名だけ差し替える」
   * 三つ目の書き方をしていたため、配置を変えるときに直し漏れが起きる形になっていた。
   */
  private buildCompositionConfig(gameResult: GameResult, outputFileName: string): CompositionConfig {
    return {
      backgroundImagePath: this.getBackgroundImagePath(gameResult.rank),
      foregroundPosition: this.getForegroundPosition(),
      textElements: this.getTextElements(gameResult),
      outputFileName,
      fontPath: this.fontPath
    };
  }

  /** 正規カード（AI変換画像を前景に使う）の合成設定 */
  generateCompositionConfig(gameResult: GameResult, datetime: string): CompositionConfig {
    return this.buildCompositionConfig(gameResult, this.getOutputFileName(datetime));
  }

  /** プレースホルダ版カードの合成設定 */
  generateDummyCompositionConfig(gameResult: GameResult, datetime: string): CompositionConfig {
    return this.buildCompositionConfig(gameResult, this.getDummyOutputFileName(datetime));
  }

  // 撮影した本人の写真を前景に使う findOriginalPhotoPath() は削除した（2026-09-02）。
  // カードは後日ネットで公開する方針のため、生の顔写真を焼き込むと
  // そのまま公開物になってしまう。AI変換が無い場合の前景は
  // 人物ではない固定のプレースホルダ（getDummyPhotoPath）に限る。

  /**
   * photo_anime.pngファイルを検索して取得
   */
  findAnimePhotoPath(resultDir: string): string | null {
    try {
      const files = fsSync.readdirSync(resultDir);

      const animeFiles = (files as string[])
        .filter((file) => file.startsWith('photo_anime_') && file.endsWith('.png'))
        // ComfyUI の出力は `..._00001_.png` `..._00002_.png` と増える。
        // 再投入した回では新しい方（末尾の番号が大きい方）を優先する
        .sort()
        .reverse();

      // 🔴 **最初に見つかった1件をそのまま使ってはいけない。**
      // 切れた `_00001_` が残っている回で再投入すると `_00002_` が増えるため、
      // 「検査したファイル」と「合成に使うファイル」がずれる。切れた画像から
      // 合成すると ImageMagick が部分デコードして exit 0 になり、
      // IEND 付きの「上半分がグレーのカード」が完成して以後検出できない。
      // 🔴 **「読めなかった」を「使えない」にしない。**
      // results/ は OneDrive 同期下で、クラウド専用ファイルやAVのロックで
      // 一瞬読めないことがある。従来はパスを返して ImageMagick が開く時点で
      // 実体化されていたので合成できていた。ここで null にすると
      // **完全なAI画像があるのにカードが作られない**。
      // 除外するのは「明確に壊れている（corrupt）」ものだけ。
      let fallback: string | null = null;
      for (const file of animeFiles) {
        const fullPath = path.join(resultDir, file);
        const integrity = verifyPngFileSync(fullPath);
        if (integrity.valid) return fullPath;
        if (integrity.status === 'unknown') {
          fallback = fallback ?? fullPath;
          console.warn(
            `ImageCompositionConfig - AI画像を検査できませんでした（候補として保持）: ${file} (${integrity.error})`
          );
          continue;
        }
        console.warn(
          `ImageCompositionConfig - AI画像が壊れているため使いません: ${file} (${integrity.status}: ${integrity.error})`
        );
      }
      if (fallback) return fallback;

      console.warn(`ImageCompositionConfig - 使える photo_anime がありません: ${resultDir}`);
      console.warn(`ImageCompositionConfig - Files in directory:`, files);
      return null;
    } catch (error) {
      console.error('ImageCompositionConfig - Error reading result directory:', error);
      return null;
    }
  }

  /**
   * 設定値の検証
   */
  validateConfig(config: CompositionConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    // 背景画像の存在確認
    if (!fsSync.existsSync(config.backgroundImagePath)) {
      errors.push(`Background image not found: ${config.backgroundImagePath}`);
    }

    // フォントファイルの存在確認。検証するのも描画に使うのも config.fontPath 一つ
    if (!config.fontPath) {
      errors.push('fontPath が設定されていません');
    } else if (!fsSync.existsSync(config.fontPath)) {
      errors.push(`Font file not found: ${config.fontPath}`);
    }

    // テキスト要素の検証
    if (!config.textElements || config.textElements.length === 0) {
      errors.push('No text elements defined');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * ダミー画像のパスを取得
   */
  getDummyPhotoPath(): string {
    return path.join(this.assetsDir, 'dummy_photo.png');
  }
}