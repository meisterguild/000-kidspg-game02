import React, { useEffect } from 'react';
import { preloadSpecificAssets, isAssetsLoaded, playSound } from './utils/assets';
import { ALL_BACKGROUND_ASSETS } from '@shared/utils/constants';
import { ScreenProvider, useScreen } from './contexts/ScreenContext';
import { GameSessionProvider, useGameSession } from './contexts/GameSessionContext';
import { ConfigProvider, useConfig } from './contexts/ConfigContext';
import { CameraProvider } from './contexts/CameraContext';

// ページコンポーネントのインポート
import TopPage from './pages/TopPage';
import CameraPage from './pages/CameraPage';
import CountdownPage from './pages/CountdownPage';
import GamePage from './pages/GamePage';
import ResultPage from './pages/ResultPage';
import { TestPage } from './test/TestPage';
import { NavBar } from './components/NavBar';

// 終了確認ダイアログ
import { ExitConfirmationDialog } from './components/ExitConfirmationDialog';
import { useExitConfirmation } from './hooks/useExitConfirmation';

// 画面のレンダリングと副作用を担当するコンポーネント
const AppContent: React.FC = () => {
  const { currentScreen, setCurrentScreen, assetsLoaded, setAssetsLoaded } = useScreen();
  const { resetGameState } = useGameSession();
  const { loading: configLoading, error: configError } = useConfig();
  
  // 終了確認フック
  const {
    isDialogOpen,
    step,
    comfyUIStatus,
    handleConfirm,
    handleCancel,
  } = useExitConfirmation();

  // アセット読み込み
  useEffect(() => {
    const initializeAssets = async () => {
      try {
        if (!isAssetsLoaded()) {
          await preloadSpecificAssets(ALL_BACKGROUND_ASSETS);
        }
        setAssetsLoaded(true);
      } catch (error) {
        console.error('バックグラウンドアセット読み込みエラー:', error);
        setAssetsLoaded(true); // エラーでも続行
      }
    };
    initializeAssets();
  }, [setAssetsLoaded]);

  // キーボードショートカット
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // ゲーム中はEscキーの処理をGamePageに委譲。
        // カウントダウン中も無視する。ここで抜けると、撮影済みの写真と
        // 実行中の ComfyUI ジョブを残したまま TOP へ戻り、
        // result.json のない孤児ディレクトリができる（昨年3件発生）。
        if (currentScreen === 'GAME' || currentScreen === 'COUNTDOWN') {
          return;
        }
        
        playSound('paltu');
        setCurrentScreen('TOP');
        resetGameState();
      } else if ((event.key === 'g' || event.key === 'G') && import.meta.env.DEV) {
        // 開発ビルドでのみ有効な確認用ショートカット（本番ビルドでは消える）。
        // カメラを使わずにゲーム画面だけを開いて 3D 表示を検証するために使う。
        setCurrentScreen('GAME');
      } else if ((event.key === 't' || event.key === 'T') && import.meta.env.DEV) {
        // 本番ビルドでは消える。プレイ中に子どもが t を押して記録を消すのを防ぐ。
        setCurrentScreen('TEST');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setCurrentScreen, resetGameState, currentScreen]);

  // アセット読み込み中の表示
  if (!assetsLoaded || configLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-black text-white">
        <div className="text-center">
          <div className="text-2xl mb-4">読み込み中...</div>
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto"></div>
        </div>
      </div>
    );
  }

  // Display error if config loading failed
  if (configError) {
    return (
      <div className="flex items-center justify-center h-screen bg-black text-red-500">
        <div className="text-center">
          <div className="text-2xl mb-4">設定ファイルの読み込みエラー:</div>
          <div className="text-lg">{configError}</div>
          <div className="text-sm text-gray-400 mt-4">アプリケーションを再起動してください。</div>
        </div>
      </div>
    );
  }

  // 現在の画面に応じたコンポーネントをレンダリング
  const renderCurrentScreen = () => {
    switch (currentScreen) {
      case 'TOP':
        return <TopPage />;
      case 'CAMERA':
        return <CameraPage />;
      case 'COUNTDOWN':
        return <CountdownPage />;
      case 'GAME':
        return <GamePage />;
      case 'RESULT':
        return <ResultPage />;
      case 'TEST':
        return <TestPage />;
      default:
        return <TopPage />;
    }
  };

  return (
    <div className="app">
      {/* マウス操作でも「もどる」「終了」ができるようにする（キーボード必須にしない）。
          ゲーム中は GamePage が独自のヘッダを持つので NavBar は出さない。 */}
      {currentScreen !== 'GAME' && <NavBar />}

      {renderCurrentScreen()}
      
      {/* 終了確認ダイアログ */}
      <ExitConfirmationDialog
        isOpen={isDialogOpen}
        step={step}
        comfyUIStatus={comfyUIStatus}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </div>
  );
};

// AppコンポーネントはProviderをまとめる役割
const App: React.FC = () => {
  return (
    <ScreenProvider>
      <GameSessionProvider>
        <ConfigProvider>
          <CameraProvider>
            <AppContent />
          </CameraProvider>
        </ConfigProvider>
      </GameSessionProvider>
    </ScreenProvider>
  );
};

export default App;