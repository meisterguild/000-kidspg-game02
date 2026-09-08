import { TIMING_CONFIG } from '@shared/utils/constants';
import type { AssetKey } from '@shared/utils/constants';

/** 読み込み済みのアセット。このファイルの外へは出さない（入口は下の関数だけ） */
interface AssetManager {
  sounds: Record<string, HTMLAudioElement>;
  images: Record<string, HTMLImageElement>;
  isLoaded: boolean;
}

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
          console.warn(`[Specific] 音声ファイルの読み込みがタイムアウトしました: ${path}`);
          resolve();
        }, 10000);

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
          console.warn(`[Specific] 画像ファイルの読み込みがタイムアウトしました: ${path}`);
          resolve();
        }, TIMING_CONFIG.comfyuiTimeout);

        img.onload = () => {
          clearTimeout(timeoutId);
          if(globalAssetManager) globalAssetManager.images[imageKey] = img;
          resolve();
        };

        img.onerror = (e) => {
          clearTimeout(timeoutId);
          console.warn(`[Specific] 画像ファイルの読み込みに失敗しました: ${path}`, e);
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
 */
export const playSound = async (
  soundKey: keyof typeof SOUND_ASSET_RELATIVE_PATHS,
  volume: number = 0.7,
  rate: number = 1
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
    const audio = assetManager.sounds[soundKey];

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
