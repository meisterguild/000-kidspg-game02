/**
 * ComfyUI 接続先とワークフローの「プロファイル」解決。
 *
 * ローカルPC（GPU 無し・低スペック）と AI サーバー（GPU あり）では、
 * 使えるワークフローも現実的なタイムアウトも違う。当日の状況で切り替えられるよう、
 * config.json では両方を書いておき、`activeProfile` の1語だけで選ぶ形にした。
 *
 * ここで**旧来のフラットな形へ畳んで**から ComfyUIService / comfyui-worker へ渡す。
 * そうすることで、切り替えの都合がワーカー側へ漏れない
 * （ワーカーは「1つの baseUrl と1つのテンプレート」だけを知っていればよい）。
 *
 * `outputPrefix` はプロファイルに置かない。`image-composition-config.ts` が
 * `photo_anime_` をハードコードで探すため、プロファイルごとに変えられると壊れる。
 */

import {
  checkGenerationConsistency,
  mergeGenerationParams,
  sanitizeGenerationParams,
  type GenerationParams,
} from '../../shared/config/generation-params';

export interface ComfyUITimeouts {
  upload: number;
  processing: number;
  queue: number;
}

/** プロファイル1つぶんの設定。省略された項目は共通側から埋める。 */
export interface ComfyUIProfile {
  /** 画面やログに出す説明。動作には影響しない */
  label?: string;
  baseUrl: string;
  /** このプロファイルで使うワークフロー JSON（リポジトリルートからの相対） */
  templatePath: string;
  pollingInterval?: number;
  maxConcurrentJobs?: number;
  timeouts?: Partial<ComfyUITimeouts>;
  /**
   * このプロファイルの生成パラメータ。共通側 (comfyui.generation) を上書きする。
   * 生の設定ファイル由来なので unknown で受け、sanitizeGenerationParams で
   * 型と範囲を検査してから使う（_comment など注釈キーが混ざるため）。
   */
  generation?: unknown;
}

/** config.json の comfyui セクション（プロファイル形式・旧フラット形式の両方を受ける） */
export interface RawComfyUIConfig {
  activeProfile?: string;
  profiles?: Record<string, ComfyUIProfile>;
  outputPrefix?: string;
  baseUrl?: string;
  pollingInterval?: number;
  maxConcurrentJobs?: number;
  timeouts?: Partial<ComfyUITimeouts>;
  retry?: { maxAttempts: number; delayMs: number };
  workflow?: { templatePath: string; outputPrefix: string };
  /** 全プロファイル共通の生成パラメータ既定値（検査前なので unknown） */
  generation?: unknown;
}

/** ワーカーへ渡す、畳んだあとの設定。 */
export interface ResolvedComfyUIConfig {
  /** どのプロファイルを選んだか（ログ・画面表示用。旧形式なら 'legacy'） */
  profileName: string;
  profileLabel: string;
  baseUrl: string;
  pollingInterval: number;
  maxConcurrentJobs: number;
  timeouts: ComfyUITimeouts;
  retry: { maxAttempts: number; delayMs: number };
  workflow: { templatePath: string; outputPrefix: string };
  /**
   * 共通側とプロファイル側を重ねた生成パラメータ。
   * ここに入っている項目は、ワークフロー JSON の同名の値を上書きする。
   */
  generation: GenerationParams;
  /**
   * 解決の途中で捨てた設定の説明（範囲外の値・未知のキーなど）。
   * 例外にはしないが、黙って無視すると気づけないので呼び出し側でログへ出す。
   */
  warnings: string[];
}

const DEFAULT_TIMEOUTS: ComfyUITimeouts = {
  upload: 60_000,
  processing: 600_000,
  queue: 900_000,
};

/**
 * プロファイルを解決する。解決できない場合は理由を添えて例外を投げる。
 *
 * 黙って既定へ倒さないのは、「サーバー向けの重いワークフローをローカルPCで回してしまい、
 * 1枚に数十分かかっているのに誰も気づかない」という壊れ方を防ぐため。
 */
export const resolveComfyUIConfig = (raw: RawComfyUIConfig): ResolvedComfyUIConfig => {
  const outputPrefix = raw.outputPrefix ?? raw.workflow?.outputPrefix;
  if (!outputPrefix) {
    throw new Error('comfyui.outputPrefix がありません');
  }

  const common = sanitizeGenerationParams(raw.generation, 'comfyui');

  // 旧形式（profiles 無し）。既存の config.json をそのまま読めるようにしておく。
  if (!raw.profiles) {
    if (!raw.baseUrl || !raw.workflow?.templatePath) {
      throw new Error('comfyui の baseUrl / workflow.templatePath がありません');
    }
    return {
      profileName: 'legacy',
      profileLabel: '旧形式（プロファイル未使用）',
      baseUrl: raw.baseUrl,
      pollingInterval: raw.pollingInterval ?? 2000,
      maxConcurrentJobs: raw.maxConcurrentJobs ?? 1,
      timeouts: { ...DEFAULT_TIMEOUTS, ...(raw.timeouts ?? {}) },
      retry: raw.retry ?? { maxAttempts: 3, delayMs: 1000 },
      workflow: { templatePath: raw.workflow.templatePath, outputPrefix },
      generation: common.params,
      warnings: [...common.warnings, ...checkGenerationConsistency(common.params)],
    };
  }

  const names = Object.keys(raw.profiles);
  const active = raw.activeProfile;
  if (!active) {
    throw new Error(`comfyui.activeProfile がありません（候補: ${names.join(', ')}）`);
  }
  const profile = raw.profiles[active];
  if (!profile) {
    throw new Error(`comfyui.activeProfile "${active}" が profiles にありません（候補: ${names.join(', ')}）`);
  }
  if (!profile.baseUrl) throw new Error(`プロファイル "${active}" に baseUrl がありません`);
  if (!profile.templatePath) throw new Error(`プロファイル "${active}" に templatePath がありません`);

  const profileGeneration = sanitizeGenerationParams(profile.generation, `comfyui.profiles.${active}`);
  const mergedGeneration = mergeGenerationParams(common.params, profileGeneration.params);

  return {
    profileName: active,
    profileLabel: profile.label ?? active,
    baseUrl: profile.baseUrl,
    pollingInterval: profile.pollingInterval ?? raw.pollingInterval ?? 2000,
    maxConcurrentJobs: profile.maxConcurrentJobs ?? raw.maxConcurrentJobs ?? 1,
    timeouts: { ...DEFAULT_TIMEOUTS, ...(raw.timeouts ?? {}), ...(profile.timeouts ?? {}) },
    retry: raw.retry ?? { maxAttempts: 3, delayMs: 1000 },
    workflow: { templatePath: profile.templatePath, outputPrefix },
    generation: mergedGeneration,
    warnings: [
      ...common.warnings,
      ...profileGeneration.warnings,
      ...checkGenerationConsistency(mergedGeneration),
    ],
  };
};
