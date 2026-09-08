// src/main/services/ranking-service.ts

import { app } from 'electron';
import * as path from 'path';
import { resolveResultsDir } from '../paths';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import { RankingData } from '@shared/types/ranking';
import { AppConfig } from '@shared/types'; // Import AppConfig from existing types

export class RankingService {
  private resultsPath: string;
  private configPath: string;
  private config: AppConfig | null = null;
  private lastModified: number = 0;

  constructor() {
    // Determine results.json path based on environment
    this.resultsPath = path.join(resolveResultsDir(), 'results.json');

    // Determine config.json path based on environment
    this.configPath = app.isPackaged
      ? path.join(path.dirname(app.getPath('exe')), 'config.json')
      : path.join(app.getAppPath(), 'config.json');
  }

  private async loadJsonFile<T>(filePath: string): Promise<T | null> {
    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof (error as { code: unknown }).code === 'string' &&
        (error as { code: string }).code === 'ENOENT'
      ) {
        console.warn(`File not found: ${filePath}. Returning empty data.`);
        return null; // Or return an empty object/array based on T
      }
      console.error(`Failed to load JSON file ${filePath}:`, error);
      return null;
    }
  }

  public async getRankingData(): Promise<RankingData | null> {
    try {
      // ファイルの最終更新時刻を確認
      const stats = await fsPromises.stat(this.resultsPath);
      this.lastModified = stats.mtime.getTime();
      
      const data = await this.loadJsonFile<RankingData>(this.resultsPath);
      // Ensure data has 'recent' and 'ranking_top' arrays, even if empty
      return data || { recent: [], ranking_top: [] };
    } catch {
      console.warn(`getRankingData: File not found or inaccessible: ${this.resultsPath}`);
      return { recent: [], ranking_top: [] };
    }
  }

  /**
   * ランキング画面へ渡す設定。
   *
   * 🔴 **一度読んだ内容を持ち続けてはいけない。** 設定画面からの保存や
   * 「config.json 再読み込み」でページ送りの間隔・タイル寸法を変えても、
   * ここがキャッシュを返すとランキング画面だけ古い値で動き続ける。
   * 画面には何も出ないので、当日は「効かない」としか分からない。
   *
   * 呼ばれるのはランキング画面を開いたときだけなので、毎回読み直しても費用はない。
   * 読めなかったときに限り、直前に読めた内容を返す（画面を空にしない）。
   */
  public async getRankingConfig(): Promise<AppConfig | null> {
    const loaded = await this.loadJsonFile<AppConfig>(this.configPath);
    if (loaded) this.config = loaded;
    return loaded ?? this.config;
  }

  public watchResults(callback: (data: RankingData) => void): () => void {
    const resultsDir = path.dirname(this.resultsPath);
    const resultsFileName = path.basename(this.resultsPath);
    let watcher: fs.FSWatcher | null = null;
    let pollingInterval: ReturnType<typeof setInterval> | null = null;
    let isWatcherActive = false;
    
    // ファイル監視を設定
    const setupFileWatcher = () => {
      try {
        // ディレクトリレベルで監視して、ファイル作成も検知
        watcher = fs.watch(resultsDir, async (eventType, filename) => {
          // results.jsonファイルの変更または作成を監視
          if (filename === resultsFileName && (eventType === 'change' || eventType === 'rename')) {
            console.log(`RankingService: ${this.resultsPath} has ${eventType}d. Reloading ranking data.`);
            
            // ファイル存在確認後にデータ読み込み
            try {
              await fsPromises.access(this.resultsPath);
              const data = await this.getRankingData();
              if (data) {
                callback(data);
              }
            } catch (accessError) {
              console.warn(`RankingService: Results file not accessible: ${this.resultsPath}`, accessError);
            }
          }
        });

        isWatcherActive = true;
        console.log(`RankingService: Started watching directory: ${resultsDir} for file: ${resultsFileName}`);
      } catch (error) {
        console.error(`RankingService: Failed to watch directory ${resultsDir}:`, error);
        isWatcherActive = false;
        
        // ディレクトリが存在しない場合は作成を試行
        try {
          fs.mkdirSync(resultsDir, { recursive: true });
          console.log(`RankingService: Created results directory: ${resultsDir}`);
          
          // 再帰的に再試行
          setupFileWatcher();
        } catch (mkdirError) {
          console.error(`RankingService: Failed to create results directory: ${resultsDir}`, mkdirError);
        }
      }
    };
    
    // ポーリングによる監視を設定（フォールバック）
    const setupPolling = () => {
      pollingInterval = setInterval(async () => {
        try {
          const stats = await fsPromises.stat(this.resultsPath);
          const currentModified = stats.mtime.getTime();
          
          if (currentModified > this.lastModified) {
            console.log('RankingService: File change detected via polling. Reloading ranking data.');
            const data = await this.getRankingData();
            if (data) {
              callback(data);
            }
          }
        } catch {
          // ファイルが存在しない場合は静かに無視
        }
      }, 1000); // 1秒間隔でポーリング
    };
    
    // ファイル監視を開始
    setupFileWatcher();
    
    // ファイル監視が失敗した場合のフォールバックとしてポーリングを開始
    if (!isWatcherActive) {
      console.log('RankingService: File watcher failed, using polling as fallback');
      setupPolling();
    }
    
    // 初回データ読み込み
    setTimeout(async () => {
      try {
        const data = await this.getRankingData();
        if (data) {
          callback(data);
        }
      } catch (error) {
        console.warn('RankingService: Initial data load failed:', error);
      }
    }, 100);

    return () => {
      if (watcher) {
        watcher.close();
        console.log('RankingService: Stopped file watcher');
      }
      if (pollingInterval) {
        clearInterval(pollingInterval);
        console.log('RankingService: Stopped polling watcher');
      }
    };
  }
}