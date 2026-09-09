import { WINDOW_CONFIG } from '@shared/utils/constants';
import type { AppConfig } from '@shared/types';
import { getImageAssetPath } from '../utils/assets';

export class CameraService {
  private stream: MediaStream | null = null;
  private isDummyMode: boolean = false;
  private dummyImageData: string | null = null;
  private isInitialized: boolean = false;
  private config: AppConfig | null = null;

  setConfig(config: AppConfig | null): void {
    this.config = config;
  }

  private getCameraConfig() {
    // デフォルト値を設定
    const defaultConfig = { width: 380, height: 380, format: 'image/png' };
    return this.config?.camera || defaultConfig;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      console.log('CameraService - Initializing camera...');
      
      // 実カメラの初期化を試行
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { 
          width: WINDOW_CONFIG.video.width, 
          height: WINDOW_CONFIG.video.height 
        }
      });
      
      this.stream = mediaStream;
      this.isDummyMode = false;
      this.isInitialized = true;
      console.log('CameraService - Real camera initialized successfully');
      
    } catch (error) {
      console.warn('CameraService - Real camera unavailable, switching to dummy mode:', error);
      
      // カメラが使用できない場合はダミーモードに切り替え
      this.isDummyMode = true;
      await this.loadDummyImage();
      this.isInitialized = true;
      console.log('CameraService - Dummy mode initialized');
    }
  }

  private async loadDummyImage(): Promise<void> {
    try {
      // dummy_photo.png を canvas で base64 に変換
      const img = new Image();
      img.crossOrigin = 'anonymous';
      
      // 🔴 **相対 URL で指さない。** Vite の出力は平坦（images/ の階層が無い）で、
      //    './assets/images/dummy_photo.png' は必ず 404 になっていた。その結果
      //    createFallbackImage() の灰色の「カメラなし」四角が全員のカードに
      //    焼かれる——カメラ無し運用がまるごと壊れていた
      //    （敵対的レビュー 2026-09-09 の指摘）。
      //    場所の判断は utils/assets.ts → main の locateAsset に集約する。
      const dummySrc = await getImageAssetPath('dummyPhoto');
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`ダミー写真を読み込めません: ${dummySrc}`));
        img.src = dummySrc;
      });

      // Canvas でリサイズして base64 に変換
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Canvas context not available');
      }

      // 正方形にリサイズ
      const cameraConfig = this.getCameraConfig();
      const size = cameraConfig.width;
      canvas.width = size;
      canvas.height = size;

      // 画像を正方形にリサイズして描画
      const aspectRatio = img.width / img.height;
      let drawWidth, drawHeight, offsetX = 0, offsetY = 0;

      if (aspectRatio > 1) {
        // 横長の場合
        drawHeight = size;
        drawWidth = size * aspectRatio;
        offsetX = -(drawWidth - size) / 2;
      } else {
        // 縦長の場合
        drawWidth = size;
        drawHeight = size / aspectRatio;
        offsetY = -(drawHeight - size) / 2;
      }

      ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);
      this.dummyImageData = canvas.toDataURL('image/png');
      
      console.log('CameraService - Dummy image loaded and resized');
    } catch (error) {
      console.error('CameraService - Failed to load dummy image:', error);
      // dummy_photo.pngが読み込めない場合はフォールバック画像を生成
      this.createFallbackImage();
    }
  }

  private createFallbackImage(): void {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cameraConfig = this.getCameraConfig();
    const size = cameraConfig.width;
    canvas.width = size;
    canvas.height = size;

    // グレーの背景
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, size, size);

    // "カメラなし" テキスト
    ctx.fillStyle = '#ffffff';
    ctx.font = '24px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('カメラなし', size / 2, size / 2);

    this.dummyImageData = canvas.toDataURL('image/png');
    console.log('CameraService - Fallback image created');
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  getDummyImageData(): string | null {
    return this.dummyImageData;
  }

  isUsingDummy(): boolean {
    return this.isDummyMode;
  }

  isReady(): boolean {
    return this.isInitialized;
  }

  destroy(): void {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    this.isInitialized = false;
    console.log('CameraService - Destroyed');
  }

  // カメラの再初期化（エラー復旧用）
  async reinitialize(): Promise<void> {
    this.destroy();
    this.isDummyMode = false;
    this.dummyImageData = null;
    this.isInitialized = false;
    await this.initialize();
  }
}

// シングルトンインスタンス
export const cameraService = new CameraService();