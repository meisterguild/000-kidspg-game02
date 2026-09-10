import type { GenerationParams } from '../config/generation-params';
import type { ComfyUIPathsConfig } from './comfyui';

// ゲーム画面状態の型定義
export type GameScreen = 'TOP' | 'CAMERA' | 'COUNTDOWN' | 'GAME' | 'RESULT' | 'TEST';

// ランク・レベルの表示文字列（helpers.calculateRank / calculateLevel の戻り値）
export type GameRank = string;
export type GameLevel = string;

/**
 * 盤面の作り。cube = 立方体3面（既定）／plane = 正面1面だけ。
 * 記録（GameResult）にも入るので、レンダラではなくここに置く。
 */
export type BoardMode = 'cube' | 'plane';

// プレイ結果データの型定義
export interface GameResult {
  nickname: string;
  rank: string;
  level: string;
  score: number;
  timestampJST: string;
  imagePath: string;
  /**
   * 確定した記念カードのパス（`<日時>/memorial_card_<日時>.png`）。
   * 保存時には無く、AI変換が終わった時点で ResultsManager が書き戻す。
   *
   * results.json の recent / ranking_top は表示件数ぶんしか保持しないため、
   * 3000人規模ではここが**記録の正本**になる。後日のカード公開はこれを集めて作る。
   */
  memorialCardPath?: string;
  /**
   * この回を遊んだ盤の種類。無い記録は立方体（この項目を足す前のもの）。
   *
   * 🔴 **後から復元できないので必ず残す。** 平面はランクの閾値が別で
   * （48/112/216/320/424 対 立方体の 88/200/392/…）、同じ「たつじん」でも
   * 中身が違う。記録側にこれが無いと、後日カードを並べたときに
   * どちらの物差しで付いたランクなのか永久に分からない。
   */
  boardMode?: BoardMode;
}

/** ステージ1面ぶんの出題設定 */
export interface StagePlan {
  size: number;
  /** core.js の DIFFICULTY のキー */
  difficulty: 'veasy' | 'easy' | 'normal' | 'hard' | 'vhard'
    // 平面モード用（平面で測り直した目標を持つ）
    | 'peasy' | 'pnormal' | 'phard';
  multiplier: number;
}

// ゲーム設定の型定義
export interface AppConfig {
  game: {
    /** 1プレイの制限時間（秒） */
    timeLimitSeconds: number;
    /** 進行中ステージの部分点率（そのステージで到達した最大の食数 × 係数 × この値） */
    partialScoreRate: number;
    /** ステージ進行。クリアごとに次の要素へ進む */
    stageProgression: StagePlan[];
    /** 1プレイで出題する最大ステージ数（repeatLastStage による青天井を防ぐ） */
    maxStages?: number;
    /** 最終ステージをクリア後も同設定で出題し続けるか */
    repeatLastStage?: boolean;
    /**
     * ランク8段階の閾値（高い順に7つ）。
     * 省略時は helpers.DEFAULT_RANK_THRESHOLDS（昨年の避けゲー用の値）。
     */
    rankThresholds?: number[];
    /** レベル表示の算出間隔（helpers.calculateLevel が参照） */
    levelUpScoreInterval: number;
    /**
     * 平面モード。立方体の3面ではなく正面1面だけを使う（3歳以上を対象に加えたため）。
     * 運営が TOP から選び、**1プレイだけ有効**で次の子には持ち越さない。
     * 省略時は平面モードを出さない。上の設定（立方体側）とは独立に持つ。
     */
    plane?: {
      stageProgression: StagePlan[];
      maxStages?: number;
      repeatLastStage?: boolean;
      /** 平面専用のランク閾値。平面は1面あたりのグミが約1/3なので立方体の値では上がらない */
      rankThresholds?: number[];
    };
  };
  /**
   * ComfyUI 設定。ローカルPC(GPU無し)と AIサーバー(GPU有り)を activeProfile で切り替える。
   * 実際にワーカーへ渡す形へ畳むのは services/comfyui-config.ts の resolveComfyUIConfig()。
   * 旧来のフラットな形（baseUrl / workflow を直に持つ）も読める。
   */
  comfyui?: {
    activeProfile?: string;
    profiles?: Record<string, {
      label?: string;
      baseUrl: string;
      templatePath: string;
      pollingInterval?: number;
      maxConcurrentJobs?: number;
      timeouts?: Partial<{ upload: number; processing: number; queue: number }>;
      /**
       * 生成パラメータ。ワークフロー JSON（assets/ComfyUI_KidsPG_2026_*.json）の
       * 同名の値を上書きする。テスト・設定画面から編集して保存できる。
       */
      generation?: GenerationParams;
      /**
       * この ComfyUI が置かれている物理絶対パス。**同一PCで動かしているときだけ書く**
       * （AI サーバー側は別の機体なので書かない）。起動バッチの実行と
       * input / output を開く用。詳細は services/comfyui-config.ts の ComfyUIPaths。
       */
      paths?: ComfyUIPathsConfig;
    }>;
    outputPrefix?: string;
    baseUrl?: string;
    pollingInterval?: number;
    maxConcurrentJobs?: number;
    timeouts?: Partial<{
      upload: number;
      processing: number;
      queue: number;
    }>;
    retry?: {
      maxAttempts: number;
      delayMs: number;
    };
    workflow?: {
      templatePath: string;
      outputPrefix: string;
    };
    /** 全プロファイル共通の生成パラメータ既定値 */
    generation?: GenerationParams;
    /** 全プロファイル共通の物理パス既定値。プロファイル側の paths で丸ごと差し替わる */
    paths?: ComfyUIPathsConfig;
  };
  camera?: {
    width: number;
    height: number;
    format: string;
  };
  memorialCard?: {
    enabled: boolean;
    magickTimeout: number;
    cardBaseImagesDir: string;
  };
  results?: {
    maxRecent: number;
    maxRanking: number;
    /** 起動時の整合性点検で、新しい順に何件まで見るか（既定 200） */
    startupCheckLimit?: number;
    /** 起動時の整合性点検にかける時間の上限(ms)。超えたら打ち切る（既定 10000） */
    startupCheckBudgetMs?: number;
  };
  ranking?: {
    pagination: {
      cardsPerPage: number;
      intervalSeconds: number;
      transitionDurationMs: number;
    };
    card: {
      tileSize: number;
    };
  };
}

// カメラ撮影用の型定義
export interface CameraCapture {
  imageData: string; // Base64エンコードされた画像データ
  timestamp: number;
}

// ニックネーム選択の型定義
export interface NicknameOption {
  id: string;
  text: string;
  category?: string;
}

// Electronメインプロセス⇔レンダラープロセス間のIPC通信用
export interface IPCMessage {
  type: string;
  payload?: unknown;
}

// ComfyUI関連の型定義をre-export
export type {
  ComfyUIPathsConfig,
  ComfyUILaunchResult,
  ComfyUIJobProgressData,
  ComfyUIStatus,
  ComfyUIActiveJob,
  ComfyUITransformResult,
  ComfyUIStatusResult,
  ComfyUIHealthResult,
  ComfyUIJobsResult,
  ComfyUIEventCallback,
  ComfyUIErrorCallback
} from './comfyui';

// Results関連の型定義をre-export
export type {
  RecentResultEntry,
  RankingResultEntry,
  ResultsData
} from './results';