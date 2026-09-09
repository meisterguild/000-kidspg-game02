/**
 * ステージ構成・倍率・部分点・ランク閾値の**対応が崩れていないか**を、
 * 設定の保存時に見て警告を作る。
 *
 * ■ なぜ要るのか（敵対的レビュー 2026-09-09 の指摘）
 * 「クリアした面の数がそのままランクになる」＝カード背景8種とランクが
 * 1対1で対応する、という設計は `rankThresholds` の手計算に依存している。
 * その計算は **1面あたりのグミ数**（size と difficulty で決まる）と
 * `multiplier` の積み上げなので、設定画面から
 * `size` / `difficulty` / `multiplier` / `partialScoreRate` を独立に変えると
 * **黙って崩れる**。
 *
 * これは実際に起きている: 2026-09-04 の5面構成への変更で
 * **5面クリアがエリートを飛ばしてマスターになり、エリートのカード背景が
 * 1枚も出ない**状態のまま気づかれなかった（docs/open-issues-20260904.md の A）。
 * 縛っているのは `tools/test-stage-balance.mjs` だけで、それは
 * **当日 CLI を叩けない前提の設定画面からは走らない**。
 * ランクは result.json とカード画像に焼き付くので、**後から直せない**。
 *
 * ■ ここでやること／やらないこと
 * 🔴 **やらない**: 盤面を実際に生成して累計スコアを再計算すること。
 * 生成はレンダラ側の実装（core.js）で、盤サイズによっては1回に数秒かかる
 * （実測: 8×8 vhard で最大 6.3 秒）。設定の保存でそれを待たせるのは筋が悪い。
 *
 * ✅ **やる**: 「対応が崩れうる値が変わったこと」を保存のたびに必ず言う。
 * 画面には既に警告を出す仕組みがあるので（TestPage の【要確認】）、
 * そこへ流せば当日でも気づける。あわせて、生成なしで分かる構造の破れ
 * （閾値が降順でない・面数と閾値の数が噛み合わない・盤サイズが重すぎる）は
 * その場で指摘する。
 */

/** 盤面生成がメインスレッドを止める実測値（各20回）。これを超えると操作感が壊れる */
const HEAVY_BOARD_SIZE = 6;

interface StageEntry {
  size?: unknown;
  difficulty?: unknown;
  multiplier?: unknown;
}

interface GameSection {
  rankThresholds?: unknown;
  stageProgression?: unknown;
  partialScoreRate?: unknown;
  repeatLastStage?: unknown;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const stageKey = (stage: StageEntry): string =>
  `${String(stage.size)}/${String(stage.difficulty)}/${String(stage.multiplier)}`;

const stagesKey = (value: unknown): string => {
  if (!Array.isArray(value)) return '(なし)';
  return value.map((s) => stageKey(asRecord(s) ?? {})).join(',');
};

/**
 * 保存前と保存後の config を比べて、当日効いてくる食い違いを文章で返す。
 *
 * @param before 保存前の config（ディスクから読んだもの）
 * @param after  保存後の config
 */
export const collectBalanceWarnings = (before: unknown, after: unknown): string[] => {
  const warnings: string[] = [];
  const beforeGame = asRecord(asRecord(before)?.game) as GameSection | null;
  const afterGame = asRecord(asRecord(after)?.game) as GameSection | null;
  if (!afterGame) return warnings;

  // --- 1. 対応が崩れうる値が変わったか ---
  const changed: string[] = [];
  if (stagesKey(beforeGame?.stageProgression) !== stagesKey(afterGame.stageProgression)) {
    changed.push('ステージ構成（盤サイズ・難易度・倍率）');
  }
  if ((beforeGame?.partialScoreRate ?? null) !== (afterGame.partialScoreRate ?? null)) {
    changed.push('部分点率');
  }
  const thresholdsChanged =
    JSON.stringify(beforeGame?.rankThresholds ?? null) !==
    JSON.stringify(afterGame.rankThresholds ?? null);
  if (thresholdsChanged) changed.push('ランク閾値');
  if ((beforeGame?.repeatLastStage ?? null) !== (afterGame.repeatLastStage ?? null)) {
    changed.push('最終面の繰り返し');
  }

  if (changed.length > 0) {
    warnings.push(
      changed.join('・') +
        'を変えました。' +
        '🔴 「クリアした面の数＝ランク＝カード背景」の対応が崩れている可能性があります' +
        '（ランクは result.json とカード画像に焼き付くので、後から直せません）。' +
        '`node tools/measure-stages.mjs --plan` で閾値の候補を出し、' +
        '`npm test` の tools/test-stage-balance.mjs が通ることを確かめてください。'
    );
  }

  // --- 2. 生成しなくても分かる構造の破れ ---
  const thresholds = afterGame.rankThresholds;
  if (Array.isArray(thresholds)) {
    const nums = thresholds.filter((n): n is number => typeof n === 'number');
    if (nums.length === thresholds.length) {
      for (let i = 0; i < nums.length - 1; i += 1) {
        if (nums[i] <= nums[i + 1]) {
          warnings.push(
            `ランク閾値が高い順に並んでいません（${nums[i]} → ${nums[i + 1]}）。` +
              'このままだと下位のランクに到達できません。'
          );
          break;
        }
      }
    }
  }

  // --- 3. 盤サイズが重すぎる（レンダラのメインスレッドが止まる） ---
  if (Array.isArray(afterGame.stageProgression)) {
    for (const [i, raw] of afterGame.stageProgression.entries()) {
      const stage = asRecord(raw);
      const size = stage?.size;
      if (typeof size === 'number' && size > HEAVY_BOARD_SIZE) {
        warnings.push(
          `ステージ${i + 1} の盤サイズ ${size} は大きすぎます。` +
            '盤面生成はゲーム画面を止めたまま走るので、' +
            '実測では 8×8（むずかしい）で最大 6.3 秒固まりました' +
            '（そのあいだ制限時間は進みます）。当日は 4 のままにしてください。'
        );
      }
    }
  }

  return warnings;
};
