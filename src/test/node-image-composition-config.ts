/**
 * Node.js環境用のImageCompositionConfig
 * Electronのappオブジェクトを使用せず、直接パス解決を行う
 */

import * as path from 'path';
import type { GameResult } from '../shared/types';
import { RANK_NAMES } from '../shared/utils/helpers';
import { verifyPngFileSync } from '../main/services/png-integrity';

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
   * main 側の CompositionConfig と同じ形にしておくこと。
   * ここが欠けると MagickScriptGenerator（main 側の実物を使い回している）が
   * `-font` を組み立てられず、`npm run recovery` が全件失敗する。
   */
  fontPath: string;
}

export class NodeImageCompositionConfig {
  private readonly cardBaseImagesDir: string;
  private readonly fontPath: string;
  private readonly assetsDir: string;

  constructor(cardBaseImagesDir: string = 'card_base_images', projectRoot?: string) {
    const rootDir = projectRoot || process.cwd();
    
    // Node.js環境では常に開発環境として扱う
    this.cardBaseImagesDir = path.resolve(rootDir, cardBaseImagesDir);
    this.assetsDir = path.resolve(rootDir, 'assets');
    this.fontPath = 'C:/Windows/Fonts/meiryo.ttc';
  }

  /**
   * ダミー画像のパスを取得
   */
  getDummyPhotoPath(): string {
    return path.join(this.assetsDir, 'dummy_photo.png');
  }

  /**
   * ダミー用出力ファイル名を生成
   */
  getDummyOutputFileName(datetime: string): string {
    return `memorial_card_${datetime}.dummy.png`;
  }

  /**
   * photo_anime_*.pngファイルのパスを検索
   */
  findAnimePhotoPath(resultDir: string): string | null {
    const fs = require('fs');
    
    try {
      const files = fs.readdirSync(resultDir);
      // 本体（ImageCompositionConfig）と同じ選び方にする。ここがずれると
      // 「救済で作ったカードだけ壊れた入力から作られる」ことになる
      const animeFiles = (files as string[])
        .filter((file) => file.startsWith('photo_anime_') && file.endsWith('.png'))
        .sort()
        .reverse();

      // 本体と同じ扱い。corrupt だけ除外し、unknown は候補として残す
      let fallback: string | null = null;
      for (const file of animeFiles) {
        const fullPath = path.join(resultDir, file);
        const integrity = verifyPngFileSync(fullPath);
        if (integrity.valid) return fullPath;
        if (integrity.status === 'unknown') {
          fallback = fallback ?? fullPath;
          continue;
        }
        console.warn(`AI画像が壊れているため使いません: ${file} (${integrity.status}: ${integrity.error})`);
      }
      return fallback;
    } catch (error) {
      console.error('Error finding anime photo:', error);
      return null;
    }
  }

  /**
   * 合成設定を生成（通常版）
   */
  generateCompositionConfig(
    gameResult: GameResult, 
    datetime: string, 
    _animePhotoPath: string
  ): CompositionConfig {
    // ランクに応じた背景画像を選択
    const backgroundFileName = this.getBackgroundImageForRank(gameResult.rank);
    
    return {
      backgroundImagePath: path.join(this.cardBaseImagesDir, backgroundFileName),
      foregroundPosition: {
        x: 180,
        y: 190,
        width: 650,
        height: 650
      },
      textElements: [
        {
          text: gameResult.nickname,
          x: 140,
          y: 190,
          fontSize: 50,
          color: '#d3593a',
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
          strokeWidth: 2
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
      ],
      outputFileName: `memorial_card_${datetime}.png`,
      fontPath: this.fontPath
    };
  }

  /**
   * 合成設定を生成（ダミー版）
   */
  generateDummyCompositionConfig(
    gameResult: GameResult, 
    datetime: string, 
    dummyPhotoPath: string
  ): CompositionConfig {
    const config = this.generateCompositionConfig(gameResult, datetime, dummyPhotoPath);
    config.outputFileName = this.getDummyOutputFileName(datetime);
    return config;
  }

  /**
   * 設定の妥当性を検証
   */
  validateConfig(config: CompositionConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const fs = require('fs');

    // 背景画像の存在確認
    if (!fs.existsSync(config.backgroundImagePath)) {
      errors.push(`Background image not found: ${config.backgroundImagePath}`);
    }

    // 出力ファイル名の妥当性チェック
    if (!config.outputFileName || config.outputFileName.trim().length === 0) {
      errors.push('Output filename is empty');
    }

    // フォントの存在確認（描画に使うのと同じ1か所）
    if (!config.fontPath) {
      errors.push('fontPath が設定されていません');
    } else if (!fs.existsSync(config.fontPath)) {
      errors.push(`Font file not found: ${config.fontPath}`);
    }

    // テキスト要素の妥当性チェック
    if (!config.textElements || config.textElements.length === 0) {
      errors.push('No text elements defined');
    } else {
      config.textElements.forEach((element, index) => {
        if (!element.text || element.text.trim().length === 0) {
          errors.push(`Text element ${index} is empty`);
        }
        if (element.fontSize <= 0) {
          errors.push(`Text element ${index} has invalid font size`);
        }
      });
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * フォントパスを取得
   */
  getFontPath(): string {
    return this.fontPath;
  }

  /**
   * カードベース画像ディレクトリを取得
   */
  getCardBaseImagesDir(): string {
    return this.cardBaseImagesDir;
  }

  /**
   * アセットディレクトリを取得
   */
  getAssetsDir(): string {
    return this.assetsDir;
  }

  /**
   * ランクに応じた背景画像ファイル名を取得
   */
  private getBackgroundImageForRank(rank: string): string {
    // RANK_NAMESを使用して正確にマッピング
    const rankMap: { [key: string]: string } = {
      [RANK_NAMES.BEGINNER]: 'bg-card-rank-01-beginner.png',
      [RANK_NAMES.AMATEUR]: 'bg-card-rank-02-amateur.png',
      [RANK_NAMES.ADVANCED]: 'bg-card-rank-03-advanced.png',
      [RANK_NAMES.EXPERT]: 'bg-card-rank-04-expert.png',
      [RANK_NAMES.VETERAN]: 'bg-card-rank-05-veteran.png',
      [RANK_NAMES.ELITE]: 'bg-card-rank-06-elite.png',
      [RANK_NAMES.MASTER]: 'bg-card-rank-07-master.png',
      [RANK_NAMES.LEGEND]: 'bg-card-rank-08-legend.png'
    };

    // デフォルトはビギナー（01）を使用（正規版と同じ）
    return rankMap[rank] || rankMap[RANK_NAMES.BEGINNER];
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
      console.warn('NodeImageCompositionConfig - Error formatting timestamp:', error);
      return timestamp;
    }
  }
}