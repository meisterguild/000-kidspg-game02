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
        // 🔴 **「保存できた」と嘘をついてはいけない。**
        // 以前はここで success を返していた（ブラウザで開いたときの都合）。
        // しかし本番でも `window.electronAPI` が undefined になることはある——
        // preload.js の読み込みに失敗した／置き場所が違った場合で、そのとき
        //   ・画面は完全に通常どおり進み（設定は同梱の既定へ、カメラはダミーへ）
        //   ・結果は1件もディスクに書かれない
        // ため、**その日の全員の記録が消える**（敵対的レビュー 2026-09-09 の指摘）。
        // ビルドで分岐していないので本番でもこの経路は生きている。
        // 失敗として返し、画面に出す。
        const message =
          'アプリの内部接続（preload）が読み込めていません。' +
          '記録を保存できないので、スタッフへ知らせてください。';
        console.error(message);
        setError(message);
        return { success: false, error: message };
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
