import { useState, useCallback } from 'react';

interface SavePhotoResult {
  success: boolean;
  dirPath?: string;
  error?: string;
}

interface UseSavePhotoHook {
  savePhoto: (imageData: string, isDummy?: boolean) => Promise<SavePhotoResult>;
  isSaving: boolean;
  error: string | null;
}

export const useSavePhoto = (): UseSavePhotoHook => {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const savePhoto = useCallback(async (imageData: string, isDummy = false): Promise<SavePhotoResult> => {
    setIsSaving(true);
    setError(null);
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.savePhoto(imageData, isDummy);
        if (result.success) {
          return { success: true, dirPath: result.dirPath };
        } else {
          console.error('写真の保存に失敗しました:', result.error);
          setError(`写真の保存に失敗しました: ${result.error}`);
          return { success: false, error: result.error };
        }
      } else {
        // Simulate success for browser environment
        return { success: true, dirPath: 'browser-dummy-path' };
      }
    } catch (err) {
      console.error('写真の保存中に予期せぬエラーが発生しました:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`写真の保存中にエラーが発生しました: ${errorMessage}`);
      return { success: false, error: errorMessage };
    } finally {
      setIsSaving(false);
    }
  }, []);

  return { savePhoto, isSaving, error };
};
