import React, { createContext, useContext, useEffect, useState } from 'react';
import { cameraService } from '../services/camera-service';
import { useConfig } from './ConfigContext';

interface CameraContextType {
  isReady: boolean;
  isUsingDummy: boolean;
  error: string | null;
  reinitialize: () => Promise<void>;
}

const CameraContext = createContext<CameraContextType | undefined>(undefined);

export const CameraProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // 🔴 **設定を渡す前に初期化してはいけない。**
  // カメラが無い場合のダミー写真は camera.width で作られるが、初期化が config より
  // 先に走ると既定値（380px）で焼かれ、config.json の撮影解像度（300px）と
  // 食い違ったサイズの画像が AI 変換とカード合成へ流れる。
  // ConfigProvider はこの Provider の親（App.tsx）なので、ここから読める。
  const { config, loading: configLoading } = useConfig();
  const [isReady, setIsReady] = useState(false);
  const [isUsingDummy, setIsUsingDummy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initializeCamera = async () => {
    try {
      setError(null);
      await cameraService.initialize();
      setIsReady(cameraService.isReady());
      setIsUsingDummy(cameraService.isUsingDummy());
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      console.error('CameraContext - Initialization failed:', err);
    }
  };

  const reinitialize = async () => {
    setIsReady(false);
    await initializeCamera();
  };

  useEffect(() => {
    // 設定の読み込みが終わるまで待つ（読めなかった場合も既定値で先へ進める）
    if (configLoading) return;
    cameraService.setConfig(config);
    initializeCamera();
    // initialize は二度目以降なにもしないので、config が入れ替わっても実害はない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configLoading, config]);

  // アプリ終了時にカメラを解放する（初期化のやり直しでは解放しない）
  useEffect(() => () => { cameraService.destroy(); }, []);

  const value = {
    isReady,
    isUsingDummy,
    error,
    reinitialize
  };

  return (
    <CameraContext.Provider value={value}>
      {children}
    </CameraContext.Provider>
  );
};

export const useCamera = (): CameraContextType => {
  const context = useContext(CameraContext);
  if (context === undefined) {
    throw new Error('useCamera must be used within a CameraProvider');
  }
  return context;
};