import React, { createContext, useState, useContext, useMemo } from 'react';
import type { GameScreen } from '@shared/types';

interface ScreenContextType {
  currentScreen: GameScreen;
  setCurrentScreen: (screen: GameScreen) => void;
  assetsLoaded: boolean;
  setAssetsLoaded: (loaded: boolean) => void;
}

const ScreenContext = createContext<ScreenContextType | undefined>(undefined);

export const ScreenProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentScreen, setCurrentScreen] = useState<GameScreen>('TOP');
  const [assetsLoaded, setAssetsLoaded] = useState<boolean>(false);

  const value = useMemo(() => ({
    currentScreen,
    setCurrentScreen,
    assetsLoaded,
    setAssetsLoaded,
  }), [currentScreen, assetsLoaded]);

  return (
    <ScreenContext.Provider value={value}>
      {children}
    </ScreenContext.Provider>
  );
};

export const useScreen = (): ScreenContextType => {
  const context = useContext(ScreenContext);
  if (!context) {
    throw new Error('useScreen must be used within a ScreenProvider');
  }
  return context;
};
