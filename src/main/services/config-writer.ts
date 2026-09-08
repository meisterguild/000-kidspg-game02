/**
 * config.json の書き戻し。
 *
 * これまで設定変更は「エディタで config.json を直接編集 → 画面の再読み込みボタン」だった。
 * 当日スタッフがテキストエディタで JSON を触るのは事故のもと（カンマ1つで起動不能になる）なので、
 * テスト・設定画面の入力欄から保存できるようにした。その受け口。
 *
 * 設計上の約束:
 *  - **レンダラから来た値を config.json へそのまま流し込まない。** 受け取るのは
 *    ここで定義したパッチ形だけで、キーごとに型と範囲を検査してから書く
 *    （レンダラが乗っ取られても、設定ファイルを任意の内容にはできないようにする）。
 *  - `_comment_*` キーは JSON の普通のキーなので、読み込み→部分差し替え→書き出しで残る。
 *    引き継ぎのために書いてある注釈を保存操作で消さないこと。
 *  - 書き込みは一時ファイル → rename の順（呼び出し側の責務）。書きかけの config.json を
 *    残さない。起動時に読めないと AI 変換なしで立ち上がってしまう。
 */

import {
  GENERATION_NUMBER_KEYS,
  GENERATION_NUMBER_RANGES,
  GENERATION_PROMPT_MAX_LENGTH,
  GENERATION_TEXT_KEYS,
  type GenerationParams,
} from '../../shared/config/generation-params';

/** 設定画面から保存できる範囲。ここに無い項目は config.json を直接編集する */
export interface ConfigPatch {
  game?: {
    timeLimitSeconds?: number;
    partialScoreRate?: number;
    levelUpScoreInterval?: number;
    maxStages?: number;
    repeatLastStage?: boolean;
    rankThresholds?: number[];
    stageProgression?: Array<{ size: number; difficulty: string; multiplier: number }>;
  };
  camera?: {
    width?: number;
    height?: number;
  };
  /** プロファイル名 → 生成パラメータ。存在しないプロファイル名は拒否する */
  comfyuiGeneration?: Record<string, GenerationParams>;
}

export const DIFFICULTIES = ['veasy', 'easy', 'normal', 'hard', 'vhard'] as const;

/** ゲーム設定の数値項目の許容範囲。設定画面の入力欄と共有する */
export const GAME_NUMBER_RANGES = {
  timeLimitSeconds: { min: 10, max: 600, integer: true },
  partialScoreRate: { min: 0, max: 1, integer: false },
  levelUpScoreInterval: { min: 1, max: 100000, integer: true },
  maxStages: { min: 0, max: 100, integer: true },
} as const;

export const STAGE_RANGES = {
  size: { min: 2, max: 8, integer: true },
  multiplier: { min: 1, max: 10000, integer: true },
} as const;

export const CAMERA_RANGES = {
  width: { min: 64, max: 2048, integer: true },
  height: { min: 64, max: 2048, integer: true },
} as const;

/** ランク閾値の個数。helpers.calculateRank が 7 個以外を無視して既定値へ倒すため固定 */
export const RANK_THRESHOLD_COUNT = 7;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * 継承したプロパティを「あった」と誤認しないための own プロパティ判定。
 *
 * `profiles['__proto__']` は Object.prototype を返すため、素の `isRecord()` だと
 * 「そのプロファイルは存在する」という検査を通ってしまう。
 * そのまま書き込むと `Object.prototype.generation` が生え、config.json は
 * 見た目上変わらないまま main プロセス内のあらゆるオブジェクトが
 * その値を持つ（＝設定ファイルから追跡できない汚染）状態になる。
 */
const hasOwn = (target: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(target, key);

/** プロトタイプ汚染に使えるキー。設定の名前として受け付けない */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

interface Range {
  min: number;
  max: number;
  integer: boolean;
}

const checkNumber = (
  label: string,
  value: unknown,
  range: Range,
  errors: string[]
): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${label}: 数値を入力してください`);
    return undefined;
  }
  if (range.integer && !Number.isInteger(value)) {
    errors.push(`${label}: 整数を入力してください`);
    return undefined;
  }
  if (value < range.min || value > range.max) {
    errors.push(`${label}: ${range.min}〜${range.max} の範囲で入力してください（入力値 ${value}）`);
    return undefined;
  }
  return value;
};

const ensureRecord = (
  parent: Record<string, unknown>,
  key: string
): Record<string, unknown> => {
  // own プロパティでなければ「無い」として作り直す。
  // 継承分（Object.prototype 由来）へ書き込まないため
  const existing = hasOwn(parent, key) ? parent[key] : undefined;
  if (isRecord(existing)) return existing;
  const created: Record<string, unknown> = {};
  Object.defineProperty(parent, key, {
    value: created,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return created;
};

/**
 * パッチを検証して、既存の設定へ重ねた新しいオブジェクトを返す。
 * `errors` が空でないときは書き込んではいけない（`config` は使わない）。
 *
 * Electron に依存しない純粋関数にしてあるので、単体テスト
 * （tools/test-config-writer.cjs）から同じロジックを確かめられる。
 */
export const applyConfigPatch = (
  current: unknown,
  patch: unknown
): { config: Record<string, unknown>; errors: string[] } => {
  const errors: string[] = [];
  if (!isRecord(current)) {
    return { config: {}, errors: ['現在の config.json が読めません（オブジェクトではありません）'] };
  }
  if (!isRecord(patch)) {
    return { config: {}, errors: ['保存内容が不正です'] };
  }

  // 深いコピー。呼び出し元が保持している this.config を巻き込んで壊さないため
  const next = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;

  if (patch.game !== undefined) {
    if (!isRecord(patch.game)) {
      errors.push('game: 形式が不正です');
    } else {
      const game = ensureRecord(next, 'game');
      const src = patch.game;

      for (const [key, range] of Object.entries(GAME_NUMBER_RANGES)) {
        if (!hasOwn(src, key) || src[key] === undefined) continue;
        const value = checkNumber(`game.${key}`, src[key], range, errors);
        if (value !== undefined) game[key] = value;
      }

      if (src.repeatLastStage !== undefined) {
        if (typeof src.repeatLastStage !== 'boolean') {
          errors.push('game.repeatLastStage: true / false で指定してください');
        } else {
          game.repeatLastStage = src.repeatLastStage;
        }
      }

      if (src.rankThresholds !== undefined) {
        const list = src.rankThresholds;
        if (!Array.isArray(list) || list.length !== RANK_THRESHOLD_COUNT) {
          errors.push(`game.rankThresholds: ${RANK_THRESHOLD_COUNT} 個で指定してください`);
        } else {
          const parsed: number[] = [];
          for (let i = 0; i < list.length; i += 1) {
            const value = checkNumber(
              `game.rankThresholds[${i + 1}番目]`,
              list[i],
              { min: 0, max: 1000000, integer: true },
              errors
            );
            if (value !== undefined) parsed.push(value);
          }
          if (parsed.length === RANK_THRESHOLD_COUNT) {
            // 高い順でないと calculateRank が上位ランクを先に判定できず、
            // 意図しないランク（＝カード背景）になる
            const descending = parsed.every((v, i) => i === 0 || parsed[i - 1] > v);
            if (!descending) {
              errors.push('game.rankThresholds: 高い順（左が最大）に並べてください');
            } else {
              game.rankThresholds = parsed;
            }
          }
        }
      }

      if (src.stageProgression !== undefined) {
        const list = src.stageProgression;
        if (!Array.isArray(list) || list.length === 0 || list.length > 20) {
          errors.push('game.stageProgression: 1〜20 件で指定してください');
        } else {
          const parsed: Array<{ size: number; difficulty: string; multiplier: number }> = [];
          list.forEach((entry, i) => {
            if (!isRecord(entry)) {
              errors.push(`ステージ${i + 1}: 形式が不正です`);
              return;
            }
            const size = checkNumber(`ステージ${i + 1} の盤サイズ`, entry.size, STAGE_RANGES.size, errors);
            const multiplier = checkNumber(
              `ステージ${i + 1} の倍率`,
              entry.multiplier,
              STAGE_RANGES.multiplier,
              errors
            );
            const difficulty = entry.difficulty;
            if (
              typeof difficulty !== 'string' ||
              !(DIFFICULTIES as readonly string[]).includes(difficulty)
            ) {
              errors.push(`ステージ${i + 1} の難易度: ${DIFFICULTIES.join(' / ')} から選んでください`);
              return;
            }
            if (size === undefined || multiplier === undefined) return;
            parsed.push({ size, difficulty, multiplier });
          });
          // 1件でも弾かれたら、その行だけ落ちた状態で保存されないように全体を捨てる
          if (parsed.length === list.length) game.stageProgression = parsed;
        }
      }
    }
  }

  if (patch.camera !== undefined) {
    if (!isRecord(patch.camera)) {
      errors.push('camera: 形式が不正です');
    } else {
      const camera = ensureRecord(next, 'camera');
      for (const [key, range] of Object.entries(CAMERA_RANGES)) {
        if (!hasOwn(patch.camera, key) || patch.camera[key] === undefined) continue;
        const value = checkNumber(`camera.${key}`, patch.camera[key], range, errors);
        if (value !== undefined) camera[key] = value;
      }
    }
  }

  if (patch.comfyuiGeneration !== undefined) {
    if (!isRecord(patch.comfyuiGeneration)) {
      errors.push('comfyuiGeneration: 形式が不正です');
    } else if (!isRecord(next.comfyui)) {
      errors.push('config.json に comfyui セクションがありません');
    } else {
      const profiles = next.comfyui.profiles;
      for (const [profileName, rawParams] of Object.entries(patch.comfyuiGeneration)) {
        if (FORBIDDEN_KEYS.has(profileName)) {
          errors.push(`プロファイル名 "${profileName}" は使えません`);
          continue;
        }
        // 存在しないプロファイル名を受けると、効かない設定を書き込んでしまう。
        // own プロパティで確かめること（"__proto__" は継承分を返して素通りする）
        if (!isRecord(profiles) || !hasOwn(profiles, profileName) || !isRecord(profiles[profileName])) {
          errors.push(`プロファイル "${profileName}" が config.json にありません`);
          continue;
        }
        if (!isRecord(rawParams)) {
          errors.push(`プロファイル "${profileName}" の生成パラメータの形式が不正です`);
          continue;
        }
        const target = ensureRecord(profiles[profileName] as Record<string, unknown>, 'generation');

        for (const key of GENERATION_NUMBER_KEYS) {
          if (!hasOwn(rawParams, key) || rawParams[key] === undefined) continue;
          const value = checkNumber(
            `${profileName}.${key}`,
            rawParams[key],
            GENERATION_NUMBER_RANGES[key],
            errors
          );
          if (value !== undefined) target[key] = value;
        }
        for (const key of GENERATION_TEXT_KEYS) {
          const value = hasOwn(rawParams, key) ? rawParams[key] : undefined;
          if (value === undefined) continue;
          if (typeof value !== 'string') {
            errors.push(`${profileName}.${key}: 文字列で指定してください`);
            continue;
          }
          if (value.trim().length === 0) {
            // 空のプロンプトは事故と区別できない。特にネガティブを空にすると
            // nsfw / horror といった安全側の指定がすべて消える
            errors.push(`${profileName}.${key}: 空にはできません`);
            continue;
          }
          if (value.length > GENERATION_PROMPT_MAX_LENGTH) {
            errors.push(`${profileName}.${key}: ${GENERATION_PROMPT_MAX_LENGTH} 文字以内にしてください`);
            continue;
          }
          target[key] = value;
        }

        // 単体では範囲内でも、組み合わせとして成立しない指定を弾く。
        // 保存後の値（既存値＋今回の入力）で判定する
        const low = target.cannyLowThreshold;
        const high = target.cannyHighThreshold;
        if (typeof low === 'number' && typeof high === 'number' && low >= high) {
          errors.push(`${profileName}: Canny のしきい値は low < high にしてください`);
        }
        const start = target.controlnetStartPercent;
        const end = target.controlnetEndPercent;
        if (typeof start === 'number' && typeof end === 'number' && start >= end) {
          errors.push(`${profileName}: ControlNet は start_percent < end_percent にしてください`);
        }
      }
    }
  }

  return { config: next, errors };
};
