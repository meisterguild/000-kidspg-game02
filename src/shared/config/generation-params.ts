/**
 * 生成パラメータ（`config.json` の `comfyui.*.generation`）の型と検証。
 *
 * ワークフロー JSON（`assets/ComfyUI_KidsPG_2026_*.json`）に直接書かれていた
 * denoise / steps / プロンプト等を、**config.json から上書きできる**ようにしたもの。
 * 当日その場でスタッフがテスト・設定画面から調整して保存できるようにするため、
 * 「テンプレート JSON を書き換える」運用をやめてここへ集約した。
 *
 * ワークフロー側の値はフォールバック（ComfyUI 単体で開いたときのために残す）。
 * 実際に ComfyUI へ投げる値は、必ずこちらが勝つ。
 */

/** 上書き可能な生成パラメータ。すべて任意（未指定の項目はテンプレート側の値が残る） */
export interface GenerationParams {
  /** KSampler.denoise。1 だと写真の潜在表現が完全に捨てられ、輪郭以外は写真と無関係になる */
  denoise?: number;
  /**
   * KSampler.steps。**denoise を下げてもサンプリング回数はこの値のまま。**
   * ComfyUI は denoise<1 のとき new_steps=int(steps/denoise) でスケジュールを
   * 引き伸ばし、その末尾 steps+1 本を使う（comfy/samplers.py の KSampler.set_steps）。
   * つまり steps を増やすとそのぶん 1 枚あたりの時間が伸びる。
   * 高速化LoRA（Hyper-SD 8steps）が前提とする 8 から動かさないこと。
   */
  steps?: number;
  /** KSampler.cfg。Hyper-SD CFG 版 LoRA 前提で 5 付近。1 にするとネガティブが無効になる */
  cfg?: number;
  /** ControlNetApplyAdvanced.strength */
  controlnetStrength?: number;
  /** ControlNetApplyAdvanced.start_percent */
  controlnetStartPercent?: number;
  /** ControlNetApplyAdvanced.end_percent。小さいほど輪郭の拘束が早く外れる */
  controlnetEndPercent?: number;
  /** Canny.low_threshold */
  cannyLowThreshold?: number;
  /** Canny.high_threshold */
  cannyHighThreshold?: number;
  /** ImageScale の width / height（正方形）。上げると生成時間が延びる */
  inputSize?: number;
  /** 正方向 CLIPTextEncode の text */
  positivePrompt?: string;
  /** 負方向 CLIPTextEncode の text */
  negativePrompt?: string;
}

/** 数値項目の許容範囲。設定画面・config.json の両方をこの1か所で縛る */
export const GENERATION_NUMBER_RANGES = {
  denoise: { min: 0.05, max: 1, integer: false },
  steps: { min: 1, max: 60, integer: true },
  cfg: { min: 1, max: 20, integer: false },
  controlnetStrength: { min: 0, max: 2, integer: false },
  controlnetStartPercent: { min: 0, max: 1, integer: false },
  controlnetEndPercent: { min: 0, max: 1, integer: false },
  cannyLowThreshold: { min: 0, max: 1, integer: false },
  cannyHighThreshold: { min: 0, max: 1, integer: false },
  inputSize: { min: 256, max: 2048, integer: true },
} as const;

export type GenerationNumberKey = keyof typeof GENERATION_NUMBER_RANGES;

export const GENERATION_NUMBER_KEYS = Object.keys(GENERATION_NUMBER_RANGES) as GenerationNumberKey[];

export const GENERATION_TEXT_KEYS = ['positivePrompt', 'negativePrompt'] as const;

export type GenerationTextKey = (typeof GENERATION_TEXT_KEYS)[number];

/** プロンプトの長さ上限。config.json が壊れるほど長い文字列を弾くための保険 */
export const GENERATION_PROMPT_MAX_LENGTH = 4000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * 未知のキーや範囲外の値を落として、GenerationParams として安全な形にする。
 *
 * 落とした理由は戻り値の `warnings` に入れて呼び出し側でログに出す。
 * 黙って既定へ倒すと「設定したつもりの値が効いていない」ことに気づけないため。
 */
export const sanitizeGenerationParams = (
  raw: unknown,
  label: string
): { params: GenerationParams; warnings: string[] } => {
  const params: GenerationParams = {};
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { params, warnings };
  if (!isRecord(raw)) {
    warnings.push(`${label}.generation がオブジェクトではありません（無視します）`);
    return { params, warnings };
  }

  for (const key of GENERATION_NUMBER_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    const range = GENERATION_NUMBER_RANGES[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      warnings.push(`${label}.generation.${key} が数値ではありません（無視します）: ${JSON.stringify(value)}`);
      continue;
    }
    if (range.integer && !Number.isInteger(value)) {
      warnings.push(`${label}.generation.${key} は整数で指定してください（無視します）: ${value}`);
      continue;
    }
    if (value < range.min || value > range.max) {
      warnings.push(
        `${label}.generation.${key} が範囲外です（無視します）: ${value}（許容 ${range.min}〜${range.max}）`
      );
      continue;
    }
    params[key] = value;
  }

  for (const key of GENERATION_TEXT_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      warnings.push(`${label}.generation.${key} が文字列ではありません（無視します）`);
      continue;
    }
    if (value.length > GENERATION_PROMPT_MAX_LENGTH) {
      warnings.push(
        `${label}.generation.${key} が長すぎます（無視します）: ${value.length} 文字（上限 ${GENERATION_PROMPT_MAX_LENGTH}）`
      );
      continue;
    }
    params[key] = value;
  }

  // `_comment` など、上のどれでもないキーは設定ファイルの注釈として許す。
  // ただし綴り違い（denoize など）を黙って無視すると気づけないので、
  // 「見た目が近いのに採用されなかったキー」だけ警告する。
  const known = new Set<string>([...GENERATION_NUMBER_KEYS, ...GENERATION_TEXT_KEYS]);
  for (const key of Object.keys(raw)) {
    if (known.has(key) || key.startsWith('_')) continue;
    warnings.push(`${label}.generation.${key} は未知の項目です（無視します）`);
  }

  return { params, warnings };
};

/**
 * 単体では範囲内でも、組み合わせとして成立しない指定を洗い出す。
 *
 * 共通側とプロファイル側にまたがって書かれることがあるため、**重ね合わせた後**に見る。
 * 設定画面（config-writer.ts）は同じ条件を保存時に弾くが、config.json を
 * 手編集された場合はここが唯一の気づき所になる。
 */
export const checkGenerationConsistency = (params: GenerationParams): string[] => {
  const warnings: string[] = [];
  const { cannyLowThreshold: low, cannyHighThreshold: high } = params;
  if (typeof low === 'number' && typeof high === 'number' && low >= high) {
    warnings.push(
      `Canny のしきい値が low >= high になっています（low=${low} / high=${high}）。輪郭がほとんど取れません`
    );
  }
  const { controlnetStartPercent: start, controlnetEndPercent: end } = params;
  if (typeof start === 'number' && typeof end === 'number' && start >= end) {
    warnings.push(
      `ControlNet が start_percent >= end_percent になっています（start=${start} / end=${end}）。輪郭の拘束が一切効きません`
    );
  }
  return warnings;
};

/** 共通側 → プロファイル側の順に重ねる（後勝ち）。undefined は上書きしない */
export const mergeGenerationParams = (
  ...layers: Array<GenerationParams | undefined>
): GenerationParams => {
  const merged: GenerationParams = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined) continue;
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
};
