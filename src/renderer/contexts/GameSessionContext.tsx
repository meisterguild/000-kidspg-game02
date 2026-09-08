import React, { createContext, useState, useContext, useCallback, useMemo } from 'react';
import { useScreen } from './ScreenContext'; // ScreenContextからフックをインポート

interface GameSessionContextType {
  capturedImage: string;
  setCapturedImage: (image: string) => void;
  selectedNickname: string;
  setSelectedNickname: (nickname: string) => void;
  gameScore: number;
  setGameScore: (score: number) => void;
  resultDir: string | null;
  setResultDir: (dir: string | null) => void;
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

  const resetGameState = useCallback(() => {
    setCapturedImage('');
    setSelectedNickname('');
    setGameScore(0);
    setResultDir(null);
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
    resetGameState,
    handleGameEnd,
  }), [
    capturedImage,
    selectedNickname,
    gameScore,
    resultDir,
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
