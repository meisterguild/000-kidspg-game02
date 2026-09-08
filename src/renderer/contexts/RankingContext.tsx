import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { RankingData } from '@shared/types/ranking';
import { AppConfig } from '@shared/types';

interface RankingContextType {
  rankingData: RankingData | null;
  rankingConfig: AppConfig['ranking'] | null;
  loading: boolean;
  error: string | null;
}

const RankingContext = createContext<RankingContextType | undefined>(undefined);

interface RankingProviderProps {
  children: ReactNode;
}

export const RankingProvider: React.FC<RankingProviderProps> = ({ children }) => {
  const [rankingData, setRankingData] = useState<RankingData | null>(null);
  const [rankingConfig, setRankingConfig] = useState<AppConfig['ranking'] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchRankingData = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await window.electronAPI?.getRankingData?.();
        setRankingData(data);
      } catch (err) {
        console.error('Failed to fetch ranking data:', err);
        setError('Failed to load ranking data.');
      } finally {
        setLoading(false);
      }
    };

    const fetchRankingConfig = async () => {
      try {
        const config = await window.electronAPI?.getRankingConfig?.();
        setRankingConfig(config?.ranking || null); // Assuming ranking config is under 'ranking' key
      } catch (err) {
        console.error('Failed to fetch ranking config:', err);
        // Don't set error for config, as data might still load
      }
    };

    fetchRankingData();
    fetchRankingConfig();

    // Set up listener for data updates from main process。
    // 🔴 electronAPI が無い環境（ブラウザでの表示確認、preload の読み込み失敗）で
    // ここが例外になると、**ランキング画面が丸ごと落ちて真っ白**になる。
    // 画面を出したまま「データなし」を見せるほうが当日は安全なので、素通りさせる。
    const cleanup = window.electronAPI?.onRankingDataUpdated?.((data) => {
      console.log('Received ranking data update from main process:', data);
      setRankingData(data);
    });

    // Clean up listener on unmount
    return () => {
      // The onRankingDataUpdated returns a cleanup function from ipcRenderer.on
      // This function should be called to remove the listener.
      cleanup?.();
    };
  }, []);

  return (
    <RankingContext.Provider value={{ rankingData, rankingConfig, loading, error }}>
      {children}
    </RankingContext.Provider>
  );
};

export const useRanking = () => {
  const context = useContext(RankingContext);
  if (context === undefined) {
    throw new Error('useRanking must be used within a RankingProvider');
  }
  return context;
};
