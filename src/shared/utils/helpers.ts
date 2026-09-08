
// ランク定数定義
export const RANK_NAMES = {
  LEGEND: '伝説級 レジェンド',
  MASTER: '達人級 マスター', 
  ELITE: '精鋭級 エリート',
  VETERAN: '古参級 ベテラン',
  EXPERT: '熟練級 エキスパート',
  ADVANCED: '上級 アドバンス',
  AMATEUR: 'アマチュア',
  BEGINNER: '初心者'
} as const;

// 日本時間のタイムスタンプを生成
export const generateJSTTimestamp = (): string => {
  const now = new Date();
  const jstOffset = 9 * 60; // JST = UTC+9
  const jstTime = new Date(now.getTime() + (jstOffset * 60 * 1000));
  
  return jstTime.toISOString().slice(0, 19).replace('T', ' ');
};

// スコアに基づくレベル計算 (config.jsonのlevelUpScoreIntervalに基づく)
export const calculateLevel = (score: number, levelUpScoreInterval: number): string => {
  const level = Math.floor(score / levelUpScoreInterval) + 1;
  if (level >= 20) return 'MAX';
  return `Lv${level}`;
};

/**
 * ランクの既定閾値（高い順）。LEGEND / MASTER / ELITE / VETERAN / EXPERT / ADVANCED / AMATEUR。
 * これを下回れば BEGINNER。
 * ゲームが変われば得点の出方も変わるので、config.json の game.rankThresholds で上書きできる。
 */
export const DEFAULT_RANK_THRESHOLDS = [1000, 800, 600, 400, 250, 150, 80];

// スコアに基づくランク計算
export const calculateRank = (score: number, thresholds?: number[]): string => {
  const t = thresholds && thresholds.length === 7 ? thresholds : DEFAULT_RANK_THRESHOLDS;
  const names = [
    RANK_NAMES.LEGEND, RANK_NAMES.MASTER, RANK_NAMES.ELITE, RANK_NAMES.VETERAN,
    RANK_NAMES.EXPERT, RANK_NAMES.ADVANCED, RANK_NAMES.AMATEUR,
  ];
  for (let i = 0; i < t.length; i++) {
    if (score >= t[i]) return names[i];
  }
  return RANK_NAMES.BEGINNER;
};

// generateSafeFileName / sanitizeNickname は削除した（2026-09-03）。
// 呼び出し元は無く、ニックネームをファイル名に使う経路も存在しない
// （成果物の名前は results/<日時>/ の日時だけで決まる）。
// ニックネームの扱いで注意が要るのはファイル名ではなく **カードへの描画** の方で、
// そちらは magick-script-generator.ts の escapeTextForMagick が受け持っている。