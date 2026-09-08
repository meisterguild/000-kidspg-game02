import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { AppConfig } from '@shared/types';
import type { ConfigPatch } from '@main/services/config-writer';
// ブラウザ検証時のフォールバックは config.json そのものを読む。
// 手で書き写すと必ず本体とずれる（実際に制限時間が 90 と 120 で食い違った）。
import fallbackConfig from '../../../config.json';

interface ConfigContextType {
  config: AppConfig | null;
  loading: boolean;
  error: string | null;
  /**
   * config.json を読み直す。反映にアプリの再起動が要る項目があれば
   * restartRequired に入って返る（画面で伝えないと半適用に気づけない）。
   */
  reloadConfig: () => Promise<SaveConfigResult>;
  /**
   * 設定を config.json へ保存する。
   * 値の検査は main 側（services/config-writer.ts）で行い、入力の誤りは
   * 戻り値の error に日本語の説明として返る（そのときは保存されない）。
   */
  saveConfig: (patch: ConfigPatch) => Promise<SaveConfigResult>;
}

export interface SaveConfigResult {
  success: boolean;
  error?: string;
  /** 反映にアプリの再起動が要る項目（接続先URLなど）。空なら即時反映済み */
  restartRequired?: string[];
  /**
   * 生成パラメータとワークフローの配線の点検結果。
   * 🔴 **画面に出すこと。** `denoise: 1` のように「保存はできるが、絵が
   * 写真と無関係になる」設定はここでしか気づけない
   * （起動時の警告ダイアログはもう過ぎている）。
   */
  warnings?: string[];
}

const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

interface ConfigProviderProps {
  children: ReactNode;
}

export const ConfigProvider: React.FC<ConfigProviderProps> = ({ children }) => {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      if (window.electronAPI) {
        const fetchedConfig = await window.electronAPI.getConfig();
        setConfig(fetchedConfig);
      } else {
        // ブラウザ環境でのフォールバック（開発用）
        console.warn('Electron API not available. Using dummy config for browser environment.');
        setConfig(fallbackConfig as unknown as AppConfig);
      }
    } catch (err) {
      console.error('Failed to load config:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadConfig = useCallback(async (): Promise<SaveConfigResult> => {
    try {
      setLoading(true);
      setError(null);
      if (!window.electronAPI) {
        // ブラウザ環境では再読み込みをスキップ
        console.warn('Config reload not available in browser environment.');
        return { success: false, error: 'ブラウザ検証中は再読み込みできません' };
      }
      const result = await window.electronAPI.reloadConfig();
      if (result.success) {
        // config.json が読めなかった場合 main は config: null を返す。
        // undefined を state へ入れると「読み込み中」と区別できなくなるので null へ寄せる
        setConfig(result.config ?? null);
        return { success: true, restartRequired: result.restartRequired, warnings: result.warnings };
      }
      const message = result.error || '設定ファイルの再読み込みに失敗しました';
      setError(message);
      return { success: false, error: message };
    } catch (err) {
      console.error('Failed to reload config:', err);
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, []);

  const saveConfig = useCallback(async (patch: ConfigPatch): Promise<SaveConfigResult> => {
    if (!window.electronAPI) {
      // ブラウザ検証では config.json を書き換えられない（Electron の main が居ない）
      return { success: false, error: 'ブラウザ検証中は設定を保存できません（Electron アプリから操作してください）' };
    }
    try {
      setError(null);
      const result = await window.electronAPI.saveConfig(patch);
      if (result.success && result.config) {
        // main が書き込んだ後の内容をそのまま反映する。
        // 画面側で組み立て直すと、検査で丸められた値と表示がずれる
        setConfig(result.config);
        return { success: true, restartRequired: result.restartRequired, warnings: result.warnings };
      }
      const message = result.error || '設定の保存に失敗しました';
      setError(message);
      return { success: false, error: message };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to save config:', err);
      setError(message);
      return { success: false, error: message };
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  return (
    <ConfigContext.Provider value={{ config, loading, error, reloadConfig, saveConfig }}>
      {children}
    </ConfigContext.Provider>
  );
};

export const useConfig = () => {
  const context = useContext(ConfigContext);
  if (context === undefined) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
};
