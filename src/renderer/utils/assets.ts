import type { AssetKey } from '@shared/utils/constants';

/** 読み込み済みのアセット。このファイルの外へは出さない（入口は下の関数だけ） */
interface AssetManager {
  sounds: Record<string, HTMLAudioElement>;
  images: Record<string, HTMLImageElement>;
  isLoaded: boolean;
}

/**
 * 先読み1件の待ち時間。
 *
 * 🔴 **ComfyUI のタイムアウト（TIMING_CONFIG.comfyuiTimeout）を流用しない。**
 * 以前は画像側がそれを使っていたため、ComfyUI の設定を縮めると
 * **開場の判定が連動して壊れる**関係になっていた（敵対的レビュー 2026-09-09 の指摘）。
 * TOP のタイトル画像は約1.9MB あり、冷えたコピー直後の当日PCでは
 * Defender / SAC の初回スキャンと競合して数秒かかる。余裕を持たせる。
 */
const ASSET_LOAD_TIMEOUT_MS = 20000;

/** 音声アセットの読み込み先。使うのはこのファイルの preloadSpecificAssets だけ */
const getSoundAssetPath = async (key: keyof typeof SOUND_ASSET_RELATIVE_PATHS): Promise<string> => {
  const relativePath = SOUND_ASSET_RELATIVE_PATHS[key];
  if (import.meta.env.PROD) {
    const electronApi = window.electronAPI;
    return await electronApi.getAssetAbsolutePath(`assets/sounds/${relativePath}`);
  }
  return new URL(`../assets/sounds/${relativePath}`, import.meta.url).href;
};

/**
 * 画像アセットの読み込み先を決める。
 *
 * 本番（パッケージ）では main プロセスに絶対パスを聞く（同梱先が開発時と違うため）。
 * 開発では Vite が配る URL を使う。
 *
 * 成功時のログは出さない。1回の起動で何度も呼ばれるうえ、当日の調べ物で見たいのは
 * 失敗した1件だけで、成功ログに埋もれると探せなくなる。
 */
export const getImageAssetPath = async (key: keyof typeof IMAGE_ASSET_RELATIVE_PATHS): Promise<string> => {
  const relativePath = IMAGE_ASSET_RELATIVE_PATHS[key];

  if (import.meta.env.PROD) {
    const electronApi = window.electronAPI;
    if (!electronApi?.getAssetAbsolutePath) {
      console.error('assets.ts: electronAPI.getAssetAbsolutePath が使えません（preload の読み込みに失敗している）');
      throw new Error('electronAPI.getAssetAbsolutePath is not available');
    }

    const assetRelativePath = `assets/images/${relativePath}`;
    try {
      return await electronApi.getAssetAbsolutePath(assetRelativePath);
    } catch (error) {
      console.error(`assets.ts: 画像パスを解決できませんでした: ${assetRelativePath}`, error);
      throw error;
    }
  }

  return new URL(`../assets/images/${relativePath}`, import.meta.url).href;
};

const SOUND_ASSET_RELATIVE_PATHS = {
  action: 'action.mp3',
  bell: 'bell.mp3',
  buttonClick: 'button_click.mp3',
  jump: 'jump.mp3',
  machine: 'machine.mp3',
  newtype: 'newtype.mp3',
  ng: 'ng.mp3',
  paltu: 'paltu.mp3',
  screenChange: 'screen_change.mp3',
  sound7: 'sound7.mp3'
} as const;

const IMAGE_ASSET_RELATIVE_PATHS = {
  titleGummy01: 'title_gummy_01.png',
  // カメラが無いときに使う写真。camera-service が使う。
  // 🔴 以前は camera-service が './assets/images/dummy_photo.png' を直に
  //    指していたが、Vite の出力は **平坦**（dist/renderer/assets/dummy_photo.png）で
  //    images/ の階層が無いため必ず 404 になり、灰色の「カメラなし」四角が
  //    全員のカードに焼かれていた（敵対的レビュー 2026-09-09 の指摘）。
  dummyPhoto: 'dummy_photo.png',



} as const;

// 画像パスオブジェクトを非同期で取得する関数
// TOP画面のタイトル表示に使う画像。
// 昨年の title_image_01〜04 は「よけまくり中」のタイトルなので参照しない
// （ファイルは残してあるが、読み込みもプリロードもしない）。
export const getImageAssets = async () => {
  return {
    titleGummy01: await getImageAssetPath('titleGummy01'),
  };
};

let globalAssetManager: AssetManager | null = null;

// 特定のアセットをプリロードする関数
export const preloadSpecificAssets = async (assetKeys: AssetKey[]): Promise<void> => {
  if (!globalAssetManager) {
    globalAssetManager = {
      sounds: {},
      images: {},
      isLoaded: false,
    };
  }

  const promises: Promise<void>[] = [];

  for (const key of assetKeys) {
    if (key in SOUND_ASSET_RELATIVE_PATHS) {
      const soundKey = key as keyof typeof SOUND_ASSET_RELATIVE_PATHS;
      if (globalAssetManager.sounds[soundKey]) continue;

      const path = await getSoundAssetPath(soundKey);
      const audio = new Audio();
      audio.preload = 'auto';
      audio.volume = 0.7;

      const promise = new Promise<void>((resolve) => {
        const timeoutId = setTimeout(() => {
          // ⚠️ **打ち切りは「読めなかった」と断じないこと。**
          //    冷えたコピー直後の当日PCでは Defender / SAC の初回スキャンが挟まり、
          //    12本の先読み（各IPC往復つき）と競合して待ち時間を超えることがある。
          //    ここを blocker に数えると**遊べるのに開場が止まる**
          //    （敵対的レビュー 2026-09-09 の指摘）。数えるのは
          //    「ファイルが見つからない・壊れている」＝ onerror のときだけ。
          console.warn(`[Specific] 音声ファイルの読み込みがタイムアウトしました（先へ進みます）: ${path}`);
          resolve();
        }, ASSET_LOAD_TIMEOUT_MS);

        const onCanPlay = () => {
          clearTimeout(timeoutId);
          if(globalAssetManager) globalAssetManager.sounds[soundKey] = audio;
          audio.removeEventListener('canplaythrough', onCanPlay);
          audio.removeEventListener('error', onError);
          resolve();
        };

        const onError = (e: Event) => {
          clearTimeout(timeoutId);
          console.error(`[Specific] 音声ファイルの読み込みに失敗しました: ${path}`, e);
          markBackgroundPreloadFailed();
          audio.removeEventListener('canplaythrough', onCanPlay);
          audio.removeEventListener('error', onError);
          resolve();
        };

        audio.addEventListener('canplaythrough', onCanPlay);
        audio.addEventListener('error', onError);

        audio.src = path;
        audio.load();
      });
      promises.push(promise);
    }
    else if (key in IMAGE_ASSET_RELATIVE_PATHS) {
      const imageKey = key as keyof typeof IMAGE_ASSET_RELATIVE_PATHS;
      if (globalAssetManager.images[imageKey]) continue;

      const path = await getImageAssetPath(imageKey);
      const img = new Image();

      const promise = new Promise<void>((resolve) => {
         const timeoutId = setTimeout(() => {
          // 打ち切りは blocker に数えない（上の音声側と同じ理由）
          console.warn(`[Specific] 画像ファイルの読み込みがタイムアウトしました（先へ進みます）: ${path}`);
          resolve();
        }, ASSET_LOAD_TIMEOUT_MS);

        img.onload = () => {
          clearTimeout(timeoutId);
          if(globalAssetManager) globalAssetManager.images[imageKey] = img;
          resolve();
        };

        img.onerror = (e) => {
          clearTimeout(timeoutId);
          console.warn(`[Specific] 画像ファイルの読み込みに失敗しました: ${path}`, e);
          markBackgroundPreloadFailed();
          resolve();
        };
        img.src = path;
      });
      promises.push(promise);
    }
  }

  await Promise.all(promises);

  const allSoundKeys = Object.keys(SOUND_ASSET_RELATIVE_PATHS);
  const allImageKeys = Object.keys(IMAGE_ASSET_RELATIVE_PATHS);
  if (globalAssetManager) {
    const loadedSoundKeys = Object.keys(globalAssetManager.sounds);
    const loadedImageKeys = Object.keys(globalAssetManager.images);

    if(allSoundKeys.every(k => loadedSoundKeys.includes(k)) && allImageKeys.every(k => loadedImageKeys.includes(k))) {
      globalAssetManager.isLoaded = true;
    }
  }
};

/**
 * 背景アセットの先読みが**失敗したか**。
 *
 * ⚠️ isAssetsLoaded() は「登録されている全アセットが揃ったか」なので、
 * 起動直後の背景先読み（ALL_BACKGROUND_ASSETS は一部）が正常に終わっても
 * false のままになる。準備確認でこれを「読み込めていない」と報告すると、
 * **正常なアプリで「遊べません」と出る**（2026-09-09 に実機でそうなった）。
 * 判定に使うのは「失敗したかどうか」であって「全部揃ったか」ではない。
 */
let backgroundPreloadFailed = false;

/** 先読みが失敗したことを記録する（App.tsx の catch から呼ぶ） */
export const markBackgroundPreloadFailed = (): void => {
  backgroundPreloadFailed = true;
};

/** 先読みが失敗していたか。準備確認はこれを見る */
export const didBackgroundPreloadFail = (): boolean => backgroundPreloadFailed;

/**
 * 失敗の記録を消す。
 *
 * 🔴 **リセット経路が無いと、一度立った blocker が二度と戻らない。**
 * これはモジュール大域なので、起動バッチを叩き直しても
 * （main が `request-ready-report` を投げても）`assetsLoaded: false` のままで、
 * **遊べているのに「準備できていません」が固定**されていた。
 * 戻す手段はレンダラの再読込かアプリの再起動だけだった
 * （敵対的レビュー 2026-09-09 の指摘）。
 * 再報告の依頼を受けたときに測り直すため、ここで消せるようにする。
 */
export const clearBackgroundPreloadFailure = (): void => {
  backgroundPreloadFailed = false;
};

/**
 * 失敗の記録を消して、**実際に読み直してから**測り直す。
 *
 * 🔴 フラグを消すだけでは「読めていないのに読めたと言う」ことになる。
 * preloadSpecificAssets は既に読めているものを飛ばすので、
 * ここを呼ぶと**失敗した分だけ**が再試行される。
 * それでも駄目なら blocker は立ったままになる（それが正しい）。
 */
export const retryBackgroundPreload = async (assetKeys: AssetKey[]): Promise<void> => {
  clearBackgroundPreloadFailure();
  try {
    await preloadSpecificAssets(assetKeys);
  } catch (error) {
    console.error('[準備確認] 素材の読み直しに失敗しました:', error);
    markBackgroundPreloadFailed();
  }
};

// アセットマネージャーを取得する（このファイルの中だけで使う）。
//
// 全アセットを一括で読む loadAssets、画像を引く getImage、PixiJS 互換の no-op
// （preloadPixiAssets / isPixiAssetsPreloaded）は呼び出し元が無くなったので
// 削除した（2026-09-03）。いま生きている入口は
// preloadSpecificAssets → playSound / isAssetsLoaded だけ。
const getAssetManager = (): AssetManager | null => {
  return globalAssetManager;
};

// AudioContextの管理
let audioContext: AudioContext | null = null;
let audioInitialized = false;

const getAudioContext = (): AudioContext | null => {
  if (audioContext) return audioContext;
  
  const AudioCtx = window.AudioContext || (window as Window & typeof globalThis).webkitAudioContext;
  if (AudioCtx) {
    audioContext = new AudioCtx();
    return audioContext;
  }
  
  console.warn('AudioContext is not supported in this browser.');
  return null;
};

// 音声システムを初期化する関数（最初のユーザーインタラクション時に呼び出し）
export const initializeAudioSystem = async (): Promise<void> => {
  if (audioInitialized) {
    return;
  }

  const context = getAudioContext();
  if (context && context.state === 'suspended') {
    try {
      await context.resume();
      audioInitialized = true;
    } catch (e) {
      console.error('❌ Failed to resume AudioContext:', e);
    }
  } else if (context) {
    // 状態が 'running' または 'closed' の場合
    audioInitialized = true;
  }
};

/**
 * 音声を再生する。
 *
 * `rate` は再生速度＝音の高さ。同じ音でも連続で少しずつ上げると
 * 「食べ進めている」感じが出る（グミを食べる音で使っている）。
 * 音声要素はキーごとに1つを使い回すので、毎回明示的に設定しておく。
 * 指定しなければ従来どおり等速。
 *
 * `overlap` を立てると、**使い回しの要素ではなく複製を鳴らす**。
 * 通常の経路は `currentTime = 0` で巻き戻すため、鳴り終わる前に次を鳴らすと
 * 前の音が切れる。一本道の盤面では選択肢が1つなので子どもが連打でき、
 * 音が鳴り切る前に巻き戻り続けて**効果音が出ていないように聞こえた**
 * （2026-09-09 の指摘）。連続で鳴らす短い効果音だけ複製して重ねる。
 * 複製は再生が終われば参照が切れて回収される。
 */
export const playSound = async (
  soundKey: keyof typeof SOUND_ASSET_RELATIVE_PATHS,
  volume: number = 0.7,
  rate: number = 1,
  overlap: boolean = false
): Promise<void> => {
  
  // ユーザー操作によるAudioContextの初期化を試みる
  await initializeAudioSystem();

  if (!audioInitialized) {
    console.warn(`⚠️ 音声システムが初期化されていません。ユーザー操作後に再試行してください。`);
    // 初期化に失敗しても、play()を試みる（一部ブラウザでは動作するため）
  }

  const assetManager = getAssetManager();
  if (!assetManager || !assetManager.sounds || !assetManager.sounds[soundKey]) {
    console.error(`❌ 音声アセットが見つかりません: ${soundKey}`);
    return;
  }

  try {
    const shared = assetManager.sounds[soundKey];
    // 重ねて鳴らす場合は複製を使う（使い回しの要素を巻き戻すと前の音が切れる）
    const audio = overlap ? (shared.cloneNode() as HTMLAudioElement) : shared;

    audio.muted = false;
    audio.volume = Math.max(0, Math.min(1, volume)); // 0も許容
    // 極端な値は音が壊れるので常識的な範囲に収める
    audio.playbackRate = Math.max(0.5, Math.min(2, rate));
    audio.currentTime = 0;

    
    await audio.play();

  } catch (error) {
    const e = error as Error;
    console.error(`❌ 音声再生に失敗しました: ${soundKey}`, {
      errorName: e.name,
      errorMessage: e.message,
    });
    
    if (e.name === 'NotAllowedError') {
      console.warn('👉 ブラウザの自動再生ポリシーによりブロックされました。ユーザーの操作（クリックなど）を待ってから再度試行してください。');
    }
  }
};

// アセットの事前読み込み状況を確認する関数
export const isAssetsLoaded = (): boolean => {
  return globalAssetManager?.isLoaded ?? false;
};
