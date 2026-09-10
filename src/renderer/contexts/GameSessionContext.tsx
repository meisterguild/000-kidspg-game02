import React, { createContext, useState, useContext, useCallback, useMemo } from 'react';
import { useScreen } from './ScreenContext'; // ScreenContextからフックをインポート
import type { BoardMode } from '@shared/types';

// 定義は shared/types（記録にも入るため）。既存の import 元を変えずに済むよう再輸出する
export type { BoardMode };

interface GameSessionContextType {
  capturedImage: string;
  setCapturedImage: (image: string) => void;
  selectedNickname: string;
  setSelectedNickname: (nickname: string) => void;
  gameScore: number;
  setGameScore: (score: number) => void;
  resultDir: string | null;
  setResultDir: (dir: string | null) => void;
  /**
   * 盤面の作り。3歳以上向けに運営が TOP から平面へ切り替える。
   * 🔴 **1プレイだけ有効**（resetGameState で cube へ戻す）。
   * 持続するトグルにすると「戻し忘れで午後ずっと平面のまま」が起きうるし、
   * 誤って押した場合の被害も次の子へ持ち越してしまう。
   */
  boardMode: BoardMode;
  setBoardMode: (mode: BoardMode) => void;
  resetGameState: () => void;
  handleGameEnd: (score: number) => void;
}

const GameSessionContext = createContext<GameSessionContextType | undefined>(undefined);

export const GameSessionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { setCurrentScreen } = useScreen(); // 画面遷移のためにuseScreenフックを使用

  const [capturedImage, setCapturedImage] = useState<string>('');
  const [selectedNickname, setSelectedNickname] = useState<string>('');
  const [gameScore, setGameScore] = useState<number>(0);
  const [resultDir, setResultDir] = useState<string | null>(null);
  const [boardMode, setBoardMode] = useState<BoardMode>('cube');

  const resetGameState = useCallback(() => {
    setCapturedImage('');
    setSelectedNickname('');
    setGameScore(0);
    setResultDir(null);
    // 平面は1プレイだけ。次の子は既定の立方体から始める
    setBoardMode('cube');
  }, []);

  const handleGameEnd = useCallback((score: number) => {
    setGameScore(score);
    setCurrentScreen('RESULT');
  }, [setCurrentScreen]);

  const value = useMemo(() => ({
    capturedImage,
    setCapturedImage,
    selectedNickname,
    setSelectedNickname,
    gameScore,
    setGameScore,
    resultDir,
    setResultDir,
    boardMode,
    setBoardMode,
    resetGameState,
    handleGameEnd,
  }), [
    capturedImage,
    selectedNickname,
    gameScore,
    resultDir,
    boardMode,
    resetGameState,
    handleGameEnd,
  ]);

  return (
    <GameSessionContext.Provider value={value}>
      {children}
    </GameSessionContext.Provider>
  );
};

export const useGameSession = (): GameSessionContextType => {
  const context = useContext(GameSessionContext);
  if (!context) {
    throw new Error('useGameSession must be used within a GameSessionProvider');
  }
  return context;
};
