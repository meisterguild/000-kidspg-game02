import React, { useEffect, useState, useCallback } from 'react';
import { calculateLevel, calculateRank, generateJSTTimestamp } from '@shared/utils/helpers';
import type { GameResult, GameRank, GameLevel } from '@shared/types';
import { playSound } from '../utils/assets';
import { useScreen } from '../contexts/ScreenContext';
import { useGameSession } from '../contexts/GameSessionContext';
import { useConfig } from '../contexts/ConfigContext';
import { useSaveGameResult } from '../hooks/useSaveGameResult';

/** 記録の保存を何回まで試すか（Windows の共有違反は待てば通ることが多い） */
const SAVE_MAX_ATTEMPTS = 4;
/** 再試行までの待ち。即座に戻すと effect が回り続けてしまう */
const SAVE_RETRY_DELAY_MS = 1500;

const ResultPage: React.FC = () => {
  const { setCurrentScreen } = useScreen();
  const { config } = useConfig();
  const {
    gameScore,
    selectedNickname,
    capturedImage,
    resultDir,
    resetGameState,
    boardMode,
  } = useGameSession();

  const [level, setLevel] = useState<GameLevel | '' >('');
  const [rank, setRank] = useState<GameRank | '' >('');
  const { saveGameResult, isSaving: isSavingHook, error: saveError } = useSaveGameResult();
  const [autoRestartTimer, setAutoRestartTimer] = useState(15);
  const [hasSaved, setHasSaved] = useState(false);
  /**
   * 記録の保存に失敗した回数と、その文面。
   *
   * 🔴 **alert で知らせて即座に再試行してはいけない。**
   * 以前は失敗するたびに `alert` を出して `setHasSaved(false)` で戻していたが、
   * 依存配列に `hasSaved` があるので effect が即再実行され、
   * **alert が連続して出る**（しかもそれを消すのは目の前の子ども）。
   * そのあいだ 15 秒の自動復帰タイマーは動き続けるので、
   * **十数秒後に TOP へ戻り、その子の記録は残らない**
   * （敵対的レビュー 2026-09-09 の指摘）。
   * ここでは
   *   ・少し待ってから数回だけ静かに再試行する
   *   ・画面に消えない文で出す（alert は使わない）
   *   ・失敗しているあいだは自動復帰を止める（スタッフが気づくまで残す）
   * の3つにする。main 側もスタッフ向けの帯に出す。
   */
  const [saveFailure, setSaveFailure] = useState<string | null>(null);
  const [saveAttempts, setSaveAttempts] = useState(0);

  const handleRestart = useCallback(() => {
    resetGameState();
    setCurrentScreen('TOP');
  }, [resetGameState, setCurrentScreen]);

  useEffect(() => {
    if (!config) return; // configが読み込まれるまで待機
    
    const levelValue = calculateLevel(gameScore, config.game.levelUpScoreInterval);
    // 平面は1面あたりのグミが立方体の約1/3なので、立方体の閾値だとランクが上がらず
    // 上位のカード意匠が一枚も出ない。平面専用の閾値へ切り替える
    // （config.game.plane.rankThresholds。無ければ立方体の値に倒す）。
    const thresholds = boardMode === 'plane'
      ? (config.game.plane?.rankThresholds ?? config.game.rankThresholds)
      : config.game.rankThresholds;
    const rankValue = calculateRank(gameScore, thresholds);
    setLevel(levelValue);
    setRank(rankValue);
  }, [gameScore, config, boardMode]);

  /**
   * 保存の失敗を受けたときの振る舞い。
   * 待ってから数回だけ静かに再試行し、それでも駄目なら画面に出したまま残す。
   */
  const handleSaveFailure = useCallback((reason: string) => {
    setSaveFailure(reason);
    setSaveAttempts((n) => {
      const next = n + 1;
      if (next < SAVE_MAX_ATTEMPTS) {
        // Windows の共有違反（OneDrive・ウイルス対策・ランキング画面の監視）は
        // 待てば通ることが多い。即座に戻すと alert 連打になるので間を置く
        setTimeout(() => setHasSaved(false), SAVE_RETRY_DELAY_MS);
      }
      return next;
    });
  }, []);

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
          boardMode,
        };

        const resultSave = await saveGameResult(resultDir, gameResult);
        if (resultSave.success) {
          // ComfyUI変換は写真保存時に既に開始されているため、ここでは実行しない
          console.log('Result saved successfully. ComfyUI transformation was already started during photo save.');
          setSaveFailure(null);
        } else {
          const reason = String(saveError || resultSave.error || '(理由不明)');
          console.error('結果保存エラー:', reason);
          handleSaveFailure(reason);
        }
      } catch (error) {
        console.error('結果保存中にエラーが発生しました:', error);
        handleSaveFailure(String(error));
      }
    };

    performSave();
    // boardMode も依存に入れる。RESULT 画面では変わらない（切り替えボタンは TOP でしか
    // 描画されない）が、入れても hasSaved の番で早期 return するので二重保存にはならない。
  }, [resultDir, selectedNickname, level, rank, gameScore, hasSaved, isSavingHook, saveError, saveGameResult, handleSaveFailure, boardMode]);

  useEffect(() => {
    // 🔴 保存に失敗しているあいだは自動で TOP へ戻さない。
    // 戻してしまうと「記録が残っていない」ことに誰も気づけない
    if (saveFailure) return;
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
  }, [handleRestart, saveFailure]);

  useEffect(() => {
    const handleKeyPress = (event: KeyboardEvent) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        // 🔴 キーリピートを無視する（CameraPage と同じ理由）。
        // 押しっぱなしにすると画面を次々に進んでしまい、
        // 結果画面 → TOP → 次のプレイ開始まで一気に走る
        if (event.repeat) return;
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
        {saveFailure ? (
          <div className="mx-auto max-w-2xl rounded border-2 border-red-400 bg-red-950/60 p-4 text-left">
            <p className="font-bold text-red-200">
              ⚠️ この回の記録を保存できませんでした（{saveAttempts}回試しました）
            </p>
            <p className="mt-1 text-sm text-red-100">
              スタッフへ知らせてください。このままだとランキングに出ません。
            </p>
            <p className="mt-1 break-all text-xs text-red-200/80">{saveFailure}</p>
            <p className="mt-2 text-xs text-red-100/80">
              自動でトップへは戻りません（気づかずに次へ進まないため）。
              スペースキーか下のボタンで進めます。
            </p>
          </div>
        ) : (
          <p className="text-game-text/80">{autoRestartTimer}秒後に自動でトップにもどります</p>
        )}
        <p className="text-sm text-game-text/70">Escキーでいつでもトップにもどれます</p>
      </div>
    </div>
  );
};

export default ResultPage;
