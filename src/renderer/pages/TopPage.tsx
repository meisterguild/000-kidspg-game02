import React, { useEffect, useCallback } from 'react';
import { playSound, preloadSpecificAssets, initializeAudioSystem } from '../utils/assets';
import TitleImageCarousel from '../components/TitleImageCarousel';
import { TOP_PAGE_ASSETS } from '@shared/utils/constants';
import { useScreen } from '../contexts/ScreenContext';
import { useGameSession } from '../contexts/GameSessionContext';
import ShinyWaveBackground from '../components/ShinyWaveBackground';

const TopPage: React.FC = () => {
  const { setCurrentScreen } = useScreen();
  const { boardMode } = useGameSession();

  // トップページアセットのプリロード
  useEffect(() => {
    preloadSpecificAssets(TOP_PAGE_ASSETS);
  }, []);

  // TOP 表示時のウェルカム音（newtype）は鳴らさない。
  // 自動再生ポリシーでユーザー操作前は弾かれるうえ、会場は騒がしく、
  // 次の子が来るたびに鳴ると受付の声が通らない。音を出すのは
  // 「スタート」を押した瞬間から（handleStart）。
  //
  // ゲーム用アセットの追加プリロードも不要（3Dグミパズルは Three.js の
  // ジオメトリを都度作るだけで、事前に読む画像・スプライトが無い）。
  // 音声は上の preloadSpecificAssets で読み終えている。

  const handleStart = useCallback(async () => {
    try {
      await initializeAudioSystem();
      await playSound('buttonClick');
    } catch (err) {
      console.warn('スタート時の音声再生エラー:', err);
    } finally {
      setCurrentScreen('CAMERA');
    }
  }, [setCurrentScreen]);


  // Spaceキーでスタート
  useEffect(() => {
    const handleKeyPress = (event: KeyboardEvent) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        // 🔴 キーリピートを無視する（CameraPage と同じ理由）。
        // 押しっぱなしにすると画面を次々に進んでしまい、
        // 結果画面 → TOP → 次のプレイ開始まで一気に走る
        if (event.repeat) return;
        handleStart();
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [handleStart]);

  return (
    <>
      {/* 背景（三角の面が波打つ金色のきらめき）。ランキング画面と同じもの */}
      <ShinyWaveBackground />
      <div className="screen-container relative" style={{ zIndex: 1 }}>
      <TitleImageCarousel />
      
      {/* 背景が動くきらめきになったので、文字は半透明の白パネルに載せて読めるようにする */}
      <div className="text-center space-y-6 mt-4 bg-white/80 rounded-3xl border-4 border-white shadow-xl px-8 py-6">
        <p className="text-xl md:text-2xl font-bold text-game-text">
          つながったグミを ぜんぶ食べてカードをゲット！
        </p>

        <div className="space-y-3">
          <p className="text-lg font-bold text-mg-brand-600">
            操作方法
          </p>
          <div className="text-base text-game-text space-y-2">
            <p>ひかっているグミを タップ／クリック で すすむ</p>
            <p>Space : スタート・すすむ・さつえい</p>
            <p>ぜんぶ食べて ゴールのグミへ！</p>
          </div>
        </div>

        {/* 平面モードを選んでいることを、押した本人がその場で気づけるように出す。
            誤って押した場合の取り返しがつくのはここだけ（次の1プレイに効いてしまう）。 */}
        {boardMode === 'plane' && (
          <p className="text-lg font-bold text-amber-950 bg-amber-300/90 border-2 border-amber-500
                        rounded-2xl px-4 py-2">
            へいめんモードで はじめます
          </p>
        )}

        <button 
          className="game-button"
          onClick={handleStart}
        >
          スタート（Spaceキー）
        </button>
        
        {/* 「ランキング表示」は NavBar（右上の操作バー）へ移した。
            同じ位置に置くと重なるため。 */}
      </div>
      </div>
    </>
  );
};

export default TopPage;