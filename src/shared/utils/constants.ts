import type { NicknameOption } from '../types';

// 昨年（よけまくり中／PixiJS 版）の名残で、参照が1つも無くなっていた定数は
// 削除した（2026-09-03）。
//   GAME_CONFIG   … laneWidth / levelUpScoreInterval。後者は config.json の
//                   game.levelUpScoreInterval が正で、こちらは誰も見ていなかった
//   GAME_CANVAS   … 2D 描画のサイズ。3Dグミパズルはコンテナに合わせる
//   FILE_PATHS    … 出力先は main の paths.ts が唯一の出どころ
//   SPRITE_CONFIG / UI_CONFIG / PIXI_ASSETS … PixiJS 版の設定
// 「定数はあるが誰も見ていない」状態は、当日そこを直せば効くという誤解を生む。

/**
 * 撮影画面で選ぶニックネーム。カードにもそのまま焼き込まれる。
 *
 * ■ 8文字を超えないこと
 * カード上のニックネーム欄で使える幅は約496px、フォント50pxでの実測は
 * 8文字=401px / 9文字=451px。9文字以上は枠から出るか他の項目に重なる。
 *
 * ■ ImageMagick を壊す文字を入れないこと
 * シングルクォート・ダブルクォート・％・バックスラッシュは MVG の text プリミティブで
 * エスケープできず、混ざるとそのプレイのカードが1枚も出ない
 * （magick-script-generator.ts の escapeTextForMagick が全角へ逃がすが、
 * そもそも入れない方が安全）。
 *
 * ■ 2026年の方向性
 * 「バトル系ファンタジー」から「グミを食べるかわいいパズル」へコンセプトが
 * 変わったため全面差し替えた（2026-09-02）。旧リスト（68個）は
 * docs/nickname-2026.md に残してある。
 * category は表示に使っていない（分類の記録用）。
 */
export const NICKNAME_OPTIONS: NicknameOption[] = [
  { id: 'random', text: 'ランダム', category: 'special' },
  // グミ系
  { id: 'gummy-master', text: 'グミマスター', category: 'gummy' },
  { id: 'gummy-taisho', text: 'グミたいしょう', category: 'gummy' },
  { id: 'gummy-hakase', text: 'グミはかせ', category: 'gummy' },
  { id: 'gummy-ouji', text: 'グミおうじ', category: 'gummy' },
  { id: 'gummy-hime', text: 'グミひめ', category: 'gummy' },
  { id: 'gummy-senshi', text: 'グミせんし', category: 'gummy' },
  { id: 'gummy-daisuki', text: 'グミだいすき', category: 'gummy' },
  { id: 'gummy-collector', text: 'グミコレクター', category: 'gummy' },
  { id: 'gummy-tatsujin', text: 'グミの達人', category: 'gummy' },
  { id: 'gummy-puni', text: 'ぷにぷにグミ', category: 'gummy' },
  { id: 'gummy-niji', text: 'にじいろグミ', category: 'gummy' },
  { id: 'gummy-yama', text: 'グミの山', category: 'gummy' },
  // お菓子系
  { id: 'ame-ouji', text: 'あめだまおうじ', category: 'sweets' },
  { id: 'choco-daisuki', text: 'チョコだいすき', category: 'sweets' },
  { id: 'candy-hime', text: 'キャンディひめ', category: 'sweets' },
  { id: 'donut-hakase', text: 'ドーナツはかせ', category: 'sweets' },
  { id: 'macaron', text: 'マカロンマニア', category: 'sweets' },
  { id: 'pudding', text: 'プリンだいすき', category: 'sweets' },
  { id: 'jelly', text: 'ゼリーようせい', category: 'sweets' },
  { id: 'cookie', text: 'クッキー名人', category: 'sweets' },
  { id: 'ramune', text: 'ラムネはかせ', category: 'sweets' },
  { id: 'wataame', text: 'わたあめだいじん', category: 'sweets' },
  { id: 'cake', text: 'ケーキだいすき', category: 'sweets' },
  // 食べる系
  { id: 'mogumogu', text: 'もぐもぐ名人', category: 'eat' },
  { id: 'pakupaku', text: 'ぱくぱく大王', category: 'eat' },
  { id: 'hitokuchi', text: 'ひとくち勇者', category: 'eat' },
  { id: 'manpuku', text: 'まんぷく王', category: 'eat' },
  { id: 'okawari', text: 'おかわり名人', category: 'eat' },
  { id: 'hayagui', text: 'はやぐいチャンプ', category: 'eat' },
  { id: 'nokosazu', text: 'のこさずたべる', category: 'eat' },
  { id: 'amaimono', text: 'あまいものすき', category: 'eat' },
  { id: 'tabehodai', text: 'たべほうだい', category: 'eat' },
  { id: 'gokugoku', text: 'ごくごく大臣', category: 'eat' },
  // ひらめき・パズル系
  { id: 'hirameki', text: 'ひらめき名人', category: 'puzzle' },
  { id: 'nazotoki', text: 'なぞときマスター', category: 'puzzle' },
  { id: 'ippitsu', text: 'いっぴつがき王', category: 'puzzle' },
  { id: 'tsunageru', text: 'つなげる天才', category: 'puzzle' },
  { id: 'puzzle-hakase', text: 'パズルはかせ', category: 'puzzle' },
  { id: 'hitofude', text: 'ひとふで名人', category: 'puzzle' },
  { id: 'atama-kirari', text: 'あたまキラリ', category: 'puzzle' },
  { id: 'logic', text: 'ロジックマン', category: 'puzzle' },
  { id: 'hirameki-hoshi', text: 'ひらめきの星', category: 'puzzle' },
  { id: 'clear-tatsujin', text: 'クリアの達人', category: 'puzzle' },
  { id: 'sentsunagi', text: 'せんつなぎ名人', category: 'puzzle' },
  { id: 'combo', text: 'コンボマスター', category: 'puzzle' },
  // 色系
  { id: 'niji', text: 'にじいろマスター', category: 'color' },
  { id: 'ao', text: 'あおいひらめき', category: 'color' },
  { id: 'pink', text: 'ピンクのちから', category: 'color' },
  { id: 'kiiro', text: 'きいろいゆうき', category: 'color' },
  { id: 'midori', text: 'みどりのかぜ', category: 'color' },
  { id: 'murasaki', text: 'むらさきの星', category: 'color' },
  { id: 'orange', text: 'オレンジ元気', category: 'color' },
  { id: 'shiro', text: 'しろいきらめき', category: 'color' },
  // かわいい系
  { id: 'puni', text: 'ぷにぷに名人', category: 'cute' },
  { id: 'fuwafuwa', text: 'ふわふわ王子', category: 'cute' },
  { id: 'kirakira', text: 'きらきらひめ', category: 'cute' },
  { id: 'mochimochi', text: 'もちもち大将', category: 'cute' },
  { id: 'pyonpyon', text: 'ぴょんぴょん王', category: 'cute' },
  { id: 'nikoniko', text: 'にこにこ名人', category: 'cute' },
  { id: 'yuruyuru', text: 'ゆるゆるヒーロー', category: 'cute' },
  { id: 'poyopoyo', text: 'ぽよぽよ戦士', category: 'cute' },
  { id: 'korokoro', text: 'ころころ勇者', category: 'cute' },
  { id: 'suyasuya', text: 'すやすや博士', category: 'cute' }
];

// アセット管理用の定数
// 型定義のみ（実際のアセット管理は renderer/utils/assets.ts で行う）
export type AssetKey = 
  // SOUND_ASSETS
  | 'action' | 'bell' | 'buttonClick' | 'jump' | 'machine' 
  | 'newtype' | 'ng' | 'paltu' | 'screenChange' | 'sound7'
  // IMAGE_ASSETS  
  | 'titleGummy01';

export const TOP_PAGE_ASSETS: AssetKey[] = [
  'buttonClick',
  'newtype', // ウェルカム音声
  'titleGummy01',
];

export const RESULT_PAGE_ASSETS: AssetKey[] = [
  'newtype',
];

export const SCREEN_TRANSITION_ASSETS: AssetKey[] = [
  'screenChange',
];

export const GAME_ASSETS: AssetKey[] = [
  'bell',
  'jump',
  'ng',
  'paltu',
  'sound7',
];

/**
 * 起動時にまとめて先読みするもの。
 *
 * 🔴 **画像も入れる。** 以前は音だけで、準備確認の
 * 「背景アセットを読み込めていません」が**画像の欠落を1枚も見ていなかった**
 * （敵対的レビュー 2026-09-09 の指摘）。TOP のタイトル画像が読めない状態は
 * 当日いちばん最初に目に入る不具合なので、ここに載せて起動時に確かめる。
 */
export const ALL_BACKGROUND_ASSETS: AssetKey[] = [
  ...GAME_ASSETS,
  ...SCREEN_TRANSITION_ASSETS,
  ...RESULT_PAGE_ASSETS,
  ...TOP_PAGE_ASSETS,
];

// タイミング関連の定数
export const TIMING_CONFIG = {
  /** カメラのストリームを video へ差すまでの待ち（撮影画面） */
  cameraStartDelay: 500,
  /**
   * ワーカー／ComfyUI への問い合わせ1件を待つ上限。
   * **生成そのものの上限ではない**（そちらは config.json の comfyui.timeouts.queue）。
   */
  comfyuiTimeout: 5000,
  /** カウントダウンの「スタート‼」を見せてからゲーム画面へ移るまで */
  countdownInterval: 500,
} as const;

// パフォーマンス関連の定数
export const PERFORMANCE_CONFIG = {
  /** 撮影画像のリサイズで受け付ける最大辺（useImageResize の上限チェック） */
  imageMaxSize: 4096
} as const;

// ウィンドウ・画面サイズ関連の定数。
// 🔴 **ここが実際のウィンドウサイズの唯一の出どころ。**
// main.ts が幅 1200 を、ランキング側が高さ 768 を直書きしていたため、
// この定数を直しても片方しか変わらない状態になっていた（2026-09-03 修正）。
export const WINDOW_CONFIG = {
  main: {
    width: 1200,
    height: 800
  },
  ranking: {
    width: 1024,
    height: 768
  },
  video: {
    width: 640,
    height: 480
  },
  gameContainer: {
    maxWidth: 800
  }
} as const;
