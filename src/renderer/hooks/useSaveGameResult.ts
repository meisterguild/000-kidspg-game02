import { useState, useCallback } from 'react';
import type { GameResult } from '@shared/types';

interface SaveGameResultResponse {
  success: boolean;
  filePath?: string;
  error?: string;
}

interface UseSaveGameResultHook {
  saveGameResult: (dirPath: string, gameResult: GameResult) => Promise<SaveGameResultResponse>;
  isSaving: boolean;
  error: string | null;
}

export const useSaveGameResult = (): UseSaveGameResultHook => {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveGameResult = useCallback(async (dirPath: string, gameResult: GameResult): Promise<SaveGameResultResponse> => {
    setIsSaving(true);
    setError(null);
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.saveJson(dirPath, gameResult);
        if (result.success) {
          return { success: true, filePath: result.filePath };
        } else {
          console.error('結果保存エラー:', result.error);
          setError(`結果の保存に失敗しました: ${result.error}`);
          return { success: false, error: result.error };
        }
      } else {
        // Simulate success for browser environment
        return { success: true, filePath: 'browser-dummy-path/result.json' };
      }
    } catch (err) {
      console.error('結果保存中にエラーが発生しました:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`結果の保存中にエラーが発生しました: ${errorMessage}`);
      return { success: false, error: errorMessage };
    } finally {
      setIsSaving(false);
    }
  }, []);

  return { saveGameResult, isSaving, error };
};
