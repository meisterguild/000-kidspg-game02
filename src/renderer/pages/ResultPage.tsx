import React, { useEffect, useState, useCallback } from 'react';
import { calculateLevel, calculateRank, generateJSTTimestamp } from '@shared/utils/helpers';
import type { GameResult, GameRank, GameLevel } from '@shared/types';
import { playSound } from '../utils/assets';
import { useScreen } from '../contexts/ScreenContext';
import { useGameSession } from '../contexts/GameSessionContext';
import { useConfig } from '../contexts/ConfigContext';
import { useSaveGameResult } from '../hooks/useSaveGameResult';

const ResultPage: React.FC = () => {
  const { setCurrentScreen } = useScreen();
  const { config } = useConfig();
  const {
    gameScore,
    selectedNickname,
    capturedImage,
    resultDir,
    resetGameState,
  } = useGameSession();

  const [level, setLevel] = useState<GameLevel | '' >('');
  const [rank, setRank] = useState<GameRank | '' >('');
  const { saveGameResult, isSaving: isSavingHook, error: saveError } = useSaveGameResult();
  const [autoRestartTimer, setAutoRestartTimer] = useState(15);
  const [hasSaved, setHasSaved] = useState(false);

  const handleRestart = useCallback(() => {
    resetGameState();
    setCurrentScreen('TOP');
  }, [resetGameState, setCurrentScreen]);

  useEffect(() => {
    if (!config) return; // configが読み込まれるまで待機
    
    const levelValue = calculateLevel(gameScore, config.game.levelUpScoreInterval);
    const rankValue = calculateRank(gameScore, config.game.rankThresholds);
    setLevel(levelValue);
    setRank(rankValue);
  }, [gameScore, config]);

  useEffect(() => {
    const performSave = async () => {
      if (!resultDir || isSavingHook || hasSaved || !selectedNickname || level === '' || rank === '') {
        return;
      }

      try {
        setHasSaved(true);
        const timestamp = generateJSTTimestamp();

        // resultDirから日時を抽出してphotoファイル名を作成
        const dirName = resultDir.split(/[/\\]/).pop() || '';
        const photoFileName = `photo_${dirName}.png`;

        const gameResult: GameResult = {
          nickname: selectedNickname,
          rank: rank,
          level: level,
          score: gameScore,
          timestampJST: timestamp,
          imagePath: photoFileName,
        };

        const resultSave = await saveGameResult(resultDir, gameResult);
        if (resultSave.success) {
          // ComfyUI変換は写真保存時に既に開始されているため、ここでは実行しない
          console.log('Result saved successfully. ComfyUI transformation was already started during photo save.');
        } else {
          console.error('結果保存エラー:', saveError || resultSave.error);
          alert(`結果の保存に失敗しました: ${saveError || resultSave.error}`);
          setHasSaved(false); // 失敗時はリトライ可能にする
        }
      } catch (error) {
        console.error('結果保存中にエラーが発生しました:', error);
        alert(`結果の保存中にエラーが発生しました: ${error}`);
        setHasSaved(false); // 失敗時はリトライ可能にする
      }
    };

    performSave();
  }, [resultDir, selectedNickname, level, rank, gameScore, hasSaved, isSavingHook, saveError, saveGameResult]);

  useEffect(() => {
    const countdown = setInterval(() => {
      setAutoRestartTimer(prev => {
        if (prev <= 1) {
          clearInterval(countdown);
          handleRestart();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(countdown);
  }, [handleRestart]);

  useEffect(() => {
    const handleKeyPress = (event: KeyboardEvent) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        playSound('buttonClick').catch(err => {
          console.warn('ボタンクリック音の再生エラー:', err);
        });
        handleRestart();
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [handleRestart]);

  return (
    <div className="screen-container">
      <h1 className="game-title">ゲーム終了！</h1>
      <div className="result-card">
        {capturedImage && (
          <div className="mb-6">
            <img 
              src={capturedImage} 
              alt="プレイヤー"
              className="w-32 h-32 rounded-full mx-auto border-4 border-white shadow-lg"
            />
          </div>
        )}
        <h2 className="text-2xl font-bold text-center mb-4 text-mg-brand-600">{selectedNickname}</h2>
        <div className="score-display text-center">スコア: {gameScore.toLocaleString()}</div>
        <div className="level-display text-center">レベル: {level}</div>
        <div className="rank-display text-center">ランク: {rank}</div>
        {isSavingHook && (
          <div className="text-center text-mg-brand-600 mt-4">記録を保存中...</div>
        )}
      </div>
      <div className="mt-8 space-y-4 text-center">
        <button 
          className="game-button"
          onClick={() => {
            playSound('buttonClick');
            handleRestart();
          }}
        >
          おしまい (Space)
        </button>
        {/* 明るいテーマ（#FFD429 の背景）では gray-400/500 は 1.9:1 で読めない。
            TopPage / CountdownPage と同じ game-text 系に揃える */}
        <p className="text-game-text/80">{autoRestartTimer}秒後に自動でトップにもどります</p>
        <p className="text-sm text-game-text/70">Escキーでいつでもトップにもどれます</p>
      </div>
    </div>
  );
};

export default ResultPage;
