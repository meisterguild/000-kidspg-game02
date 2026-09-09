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

import * as path from 'path';

import type { ComfyUIPathsConfig } from '../../shared/types/comfyui';

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

/**
 * ComfyUI が実際に置かれている**物理絶対パス**。
 *
 * アプリと ComfyUI のやり取り自体は HTTP（`baseUrl`）で足りているので、
 * ここは「手元の PC で ComfyUI を動かしているとき」だけ意味を持つ:
 *
 *   ・起動バッチをアプリから叩く（テスト・設定ページの「ComfyUI を起動する」）
 *   ・当日 input / output を直に開いて中を見る、溜まった画像を片付ける
 *
 * そのため**省略できる**。AI サーバー側のプロファイルは別の機体なので、
 * ここに書いても手元からは触れない（書かない）。
 */
export interface ComfyUIPaths {
  /** ComfyUI 本体のフォルダ。`main.py` と起動バッチがある場所 */
  root: string;
  /** LoadImage が読むフォルダ。省略時は `rootinput` */
  input: string;
  /** SaveImage が書くフォルダ。省略時は `rootoutput` */
  output: string;
  /**
   * 起動バッチ。`root` からの相対で書いてもよい（`start-comfyui.bat` など）。
   * 省略するとアプリからは起動できない（接続先の確認だけになる）。
   */
  startBat?: string;
}

/**
 * config.json に書かれたままの `paths`（検査前なので省略・相対ともに受ける）。
 * 形は renderer と共有する（設定画面も同じものを表示するため）。
 */
export type RawComfyUIPaths = ComfyUIPathsConfig;

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
  /** この ComfyUI が動いている場所（同一PCのときだけ書く）。共通側を上書きする */
  paths?: RawComfyUIPaths;
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
  /** 全プロファイル共通の物理パス既定値。プロファイル側の paths で上書きされる */
  paths?: RawComfyUIPaths;
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
   * ComfyUI が置かれている物理絶対パス。**同一PCで動かしていないときは undefined**。
   * これが無いと「ComfyUI を起動する」も input / output を開くこともできないが、
   * 生成そのものは HTTP だけで通るのでエラーにはしない。
   */
  paths?: ComfyUIPaths;
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
 * 物理パスを解決する。**書かれていなければ undefined を返す**（同一PCで動かして
 * いないプロファイルでは正常な状態なので、警告も出さない）。
 *
 * 書いてあるのに使えない形だったときは、`undefined` にして理由を warnings へ積む。
 * ここで例外にしないのは、物理パスが無くても生成そのものは HTTP で通るため。
 * 逆に黙って相対パスのまま渡すと、**Electron の作業フォルダを基準に解決されて
 * 見当違いの場所を掘る**（当日それに気づくのは難しい）ので、必ず絶対パスを要求する。
 *
 * ファイルの存在は見ない。config を読む時点ではまだ ComfyUI を入れていないことも
 * あるし、config 解決が I/O で失敗するようにはしたくない
 * （起動バッチが本当にあるかは、起動する直前に main.ts が確かめる）。
 */
export const resolveComfyUIPaths = (
  raw: RawComfyUIPaths | undefined,
  source: string
): { paths?: ComfyUIPaths; warnings: string[] } => {
  const warnings: string[] = [];
  const pick = (value: unknown, key: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || value.trim() === '') {
      warnings.push(`${source}.paths.${key} は文字列で書いてください（無視します）`);
      return undefined;
    }
    return value.trim();
  };

  if (!raw) return { warnings };
  const root = pick(raw.root, 'root');
  const input = pick(raw.input, 'input');
  const output = pick(raw.output, 'output');
  const startBat = pick(raw.startBat, 'startBat');

  if (!root) {
    if (input || output || startBat) {
      warnings.push(`${source}.paths.root がないため物理パスを使いません（root だけは必須）`);
    }
    return { warnings };
  }
  if (!path.win32.isAbsolute(root) && !path.posix.isAbsolute(root)) {
    warnings.push(`${source}.paths.root は絶対パスで書いてください（無視します）: ${root}`);
    return { warnings };
  }

  // input / output / startBat は root からの相対でも書ける（版フォルダを差し替える
  // ときに 1 行で済むように）。絶対で書いてあればそのまま使う。
  const under = (value: string | undefined, fallback?: string): string | undefined => {
    const target = value ?? fallback;
    if (target === undefined) return undefined;
    return path.win32.isAbsolute(target) || path.posix.isAbsolute(target)
      ? path.normalize(target)
      : path.resolve(root, target);
  };

  return {
    paths: {
      root: path.normalize(root),
      input: under(input, 'input') as string,
      output: under(output, 'output') as string,
      startBat: under(startBat),
    },
    warnings,
  };
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

  const commonPaths = resolveComfyUIPaths(raw.paths, 'comfyui');

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
      paths: commonPaths.paths,
      warnings: [
        ...common.warnings,
        ...commonPaths.warnings,
        ...checkGenerationConsistency(common.params),
      ],
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

  // 物理パスは項目ごとに重ねない。**プロファイル側に書いてあればそちらを丸ごと使う**。
  // root だけ差し替えて input を共通側から拾うと、別の版フォルダの input を
  // 掘りにいく組み合わせができてしまう（当日それに気づけない）。
  const profilePaths = resolveComfyUIPaths(profile.paths, `comfyui.profiles.${active}`);
  const resolvedPaths = profile.paths ? profilePaths : commonPaths;

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
    paths: resolvedPaths.paths,
    warnings: [
      ...common.warnings,
      ...profileGeneration.warnings,
      ...resolvedPaths.warnings,
      ...checkGenerationConsistency(mergedGeneration),
    ],
  };
};
