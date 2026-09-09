import React, { useEffect, useRef, useState, useCallback } from 'react';
import { GummyGameEngine } from '../game/GummyGameEngine';
import { playSound } from '../utils/assets';
import { useGameSession } from '../contexts/GameSessionContext';
import { useConfig } from '../contexts/ConfigContext';
import { useScreen } from '../contexts/ScreenContext';
import { WINDOW_CONFIG } from '@shared/utils/constants';
import { useWideLayout } from '../hooks/useWideLayout';

const GamePage: React.FC = () => {
  
  const { handleGameEnd, resultDir, resetGameState } = useGameSession();
  const { config, loading: configLoading, error: configError } = useConfig();
  const { setCurrentScreen } = useScreen();
  // 横に余白のある画面（PCモニタ）ではプレイエリアを縦いっぱいに使い、HUD は左右へ逃がす
  const wide = useWideLayout();
  
  const gameContainerRef = useRef<HTMLDivElement>(null);
  const gameEngineRef = useRef<GummyGameEngine | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // ゲーム終了→結果画面へ移る遅延タイマー。
  // 保持しておかないと、Esc でTOPへ戻った後に発火して
  // ニックネームも resultDir も空のまま結果画面へ飛び、記録が保存されずに終わる。
  const endTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // スコア・レベル状態管理
  const [gameScore, setGameScore] = useState(0);
  const [gameLevel, setGameLevel] = useState(0);

  // ヘッダー表示のためのbody overflow制御
  useEffect(() => {
    // GamePage表示時にbodyのoverflow設定を一時的に変更
    const originalBodyOverflow = document.body.style.overflow;
    const originalHtmlOverflow = document.documentElement.style.overflow;
    
    document.body.style.overflow = 'visible';
    document.documentElement.style.overflow = 'visible';
    
    return () => {
      // コンポーネント終了時に元に戻す
      document.body.style.overflow = originalBodyOverflow;
      document.documentElement.style.overflow = originalHtmlOverflow;
    };
  }, []);

  // Escキーでゲーム中断・ComfyUIキャンセル処理
  const handleEscapeKey = useCallback(async () => {
    // ComfyUIジョブをキャンセル
    if (resultDir && window.electronAPI?.comfyui) {
      try {
        const dirName = resultDir.split(/[/\\]/).pop() || '';
        await window.electronAPI.comfyui.cancelJob(dirName);
      } catch (error) {
        console.warn('Failed to cancel ComfyUI job:', error);
      }
    }
    
    // ゲーム状態をリセットしてTOP画面に戻る
    resetGameState();
    setCurrentScreen('TOP');
  }, [resultDir, resetGameState, setCurrentScreen]);

  /**
   * 🔴 **ゲームが始まる前は、ここで Esc を受ける。**
   *
   * App は GAME 画面の Esc を GamePage へ委譲している（ゲーム中に抜けると
   * 写真と ComfyUI ジョブを残した孤児フォルダができるため）。ところが
   * 委譲先の配線は**ゲームエンジンが出来てから**（setEscapeCallback）なので、
   * config が読めない・初期化に失敗した場合は
   *   ・App は Esc を無視する
   *   ・NavBar は GAME 画面では出さない
   *   ・エンジンが無いので Esc ハンドラも無い
   * となり、**アプリを強制終了する以外に戻れなくなる**
   * （敵対的レビュー 2026-09-09 の指摘。エラー画面の
   * 「Escキーでトップにもどることもできます」も事実と違っていた）。
   * ゲームが動き出す前だけ受けるので、ゲーム中の誤脱出は起きない。
   */
  useEffect(() => {
    if (!isLoading && !error) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      void handleEscapeKey();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isLoading, error, handleEscapeKey]);

  useEffect(() => {
    // gameContainerRef.current が利用可能になってから処理を開始
    if (!gameContainerRef.current) {
      // このエラーは通常発生しないはずですが、念のため残します
      setError('ゲーム描画エリアの準備に失敗しました。');
      setIsLoading(false);
      return;
    }

    // configがまだロードされていない、またはエラーがある場合は処理を中断
    if (configLoading || configError || !config) {
      if (configError) {
        setIsLoading(false);
        setError(`設定の読み込みエラー: ${configError}`);
        return;
      }
      // 🔴 **読み込みが終わったのに config が無い場合を「読み込み中」にしない。**
      // loadConfig は失敗すると null を返し、get-config はそれをそのまま返す。
      // ConfigContext は invoke が成功しているので error を立てないため、
      // 以前はここで永久に「ゲームを読み込み中...」のまま止まっていた
      // （config.json のカンマを1つ余らせるだけで起きる。
      // 敵対的レビュー 2026-09-09 の指摘）。理由を出して出口を見せる。
      if (!configLoading && !config) {
        setIsLoading(false);
        setError(
          '設定（config.json）を読み込めませんでした。ファイルが壊れている可能性があります。' +
            'スタッフへ知らせてください。'
        );
        return;
      }
      setIsLoading(true); // configがロードされるまでローディング状態を維持
      return;
    }

    const initializeGame = async () => {
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      // 成功しても止め忘れないよう、初期化タイムアウトのタイマーIDは finally から見える場所に置く。
      // （止め忘れると初期化成功の15秒後に誤ったエラーログが出て、レースに負けた
      //   Promise の reject が未処理のまま残る）
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      try {
        
        const initPromise = new Promise<GummyGameEngine>((resolve, reject) => {
          (async () => {
            if (abortController.signal.aborted) {
              reject(new Error('初期化がキャンセルされました'));
              return;
            }
            try {
              const gameEngine = new GummyGameEngine(config);
              
              // gameContainerRef.current はこの時点で存在するはず
              const container = gameContainerRef.current;
              if (!container) {
                reject(new Error('ゲームコンテナが見つかりません'));
                return;
              }
              
              await gameEngine.initialize(container);
              
              if (abortController.signal.aborted) {
                gameEngine.destroy();
                reject(new Error('初期化がキャンセルされました'));
                return;
              }
              resolve(gameEngine);
            } catch (err) {
              reject(err);
            }
          })();
        });
        
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            console.error('GamePage: CRITICAL - Initialization timeout reached (15 seconds)');
            console.error('GamePage: This indicates a fundamental initialization failure');
            console.error('GamePage: Check console for detailed error messages from GummyGameEngine and assets');
            reject(new Error('初期化が15秒でタイムアウトしました - Three.js の初期化に失敗した可能性があります'));
          }, 15000); // 15秒でタイムアウト（本番デバッグ用に延長）
          abortController.signal.addEventListener('abort', () => clearTimeout(timeoutId));
        });
        
        const gameEngine = await Promise.race([initPromise, timeoutPromise]);
        clearTimeout(timeoutId);
        
        if (abortController.signal.aborted) {
          gameEngine.destroy();
          return;
        }
        
        gameEngine.setGameOverCallback((score: number) => {
          if (abortController.signal.aborted) return;
          const t1 = setTimeout(() => {
            if (abortController.signal.aborted) return;
            playSound('screenChange').catch(err => {
              console.warn('結果画面遷移音の再生エラー:', err);
            });
            const t2 = setTimeout(() => {
              if (abortController.signal.aborted) return;
              handleGameEnd(score);
            }, 100);
            endTimersRef.current.push(t2);
          }, 1400);
          endTimersRef.current.push(t1);
        });

        gameEngine.setEscapeCallback(() => {
          if (!abortController.signal.aborted) {
            handleEscapeKey();
          }
        });

        gameEngineRef.current = gameEngine;
        
        // スコア・レベル更新のポーリング開始
        const updateInterval = setInterval(() => {
          if (!abortController.signal.aborted && gameEngine) {
            setGameScore(gameEngine.getScore());
            setGameLevel(gameEngine.getLevel());
          }
        }, 100); // 100msごとに更新
        
        abortController.signal.addEventListener('abort', () => {
          clearInterval(updateInterval);
        });
        setError(null);
      } catch (error) {
        if (!abortController.signal.aborted) {
          console.error('ゲーム初期化エラー:', error);
          const errorMessage = error instanceof Error ? error.message : String(error);
          setError(`ゲームの初期化に失敗しました: ${errorMessage}`);
        }
      } finally {
        clearTimeout(timeoutId);
        if (!abortController.signal.aborted) {
          setIsLoading(false);
        }
      }
    };

    initializeGame();

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (gameEngineRef.current) {
        gameEngineRef.current.destroy();
        gameEngineRef.current = null;
      }
      for (const t of endTimersRef.current) clearTimeout(t);
      endTimersRef.current = [];
    };
  }, [handleGameEnd, config, configError, configLoading, handleEscapeKey]);

  return (
    <div className="relative min-h-screen" style={{ overflow: 'hidden' }}>
      {/* スコア・レベル表示（常時表示ヘッダー）。
          横に余白のある画面（PCモニタ）ではプレイエリアを縦いっぱいに使いたいので、
          スコアとクリア数はゲーム内の左サイドHUDへ移し、このヘッダーは出さない。 */}
      {!wide && (
        <div
          className="absolute top-0 left-0 right-0 w-full bg-black bg-opacity-90 text-white py-2 px-4 border-b border-gray-600"
          style={{
            zIndex: 9999,
            position: 'fixed',
            transform: 'translateZ(0)' // GPU加速で確実に最前面表示
          }}
        >
          <div className="flex justify-between items-center max-w-4xl mx-auto">
            <div className="text-sm sm:text-base font-medium">
              スコア: <span className="font-bold text-yellow-300">{gameScore}</span>
            </div>
            <div className="text-sm sm:text-base font-medium">
              クリア: <span className="font-bold text-green-300">{gameLevel}</span> ステージ
            </div>
          </div>
        </div>
      )}

      {/* メインコンテンツエリア */}
      <div className="flex flex-col items-center justify-center" style={{
        minHeight: '100vh',
        padding: wide ? '0' : '8px',
        // 重ねレイアウトのときだけ、上のヘッダーぶんを空ける
        paddingTop: wide ? '0' : '50px',
        paddingBottom: wide ? '0' : '8px',
        // 通常時は中央配置、制約時は下端要素を優先表示
        boxSizing: 'border-box'
      }}>

        {/* メインゲーム画面 */}
      <div
        className="w-full flex flex-col items-center"
        style={{ zIndex: 1, maxWidth: wide ? '100%' : `${WINDOW_CONFIG.gameContainer.maxWidth + 96}px` }}
      >
        <div className={`relative w-full flex justify-center ${wide ? '' : 'mb-2'}`}>
          {/* ローディングとエラー表示のオーバーレイ */}
          {(isLoading || error) && (
            <div className="absolute inset-0 bg-black bg-opacity-80 flex flex-col items-center justify-center z-20 rounded-lg">
              {isLoading && (
                <>
                  <div className="text-2xl text-gray-300 mb-4">ゲームを読み込み中...</div>
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
                  <div className="text-sm text-gray-500 mt-4">
                    初期化中... (最大15秒)
                  </div>
                </>
              )}
              {error && !isLoading && (
                <div className="flex flex-col items-center justify-center h-full space-y-4 text-center">
                  <div className="text-2xl text-red-400 mb-4">⚠️ ゲームエラー</div>
                  <div className="text-gray-300 max-w-md">{error}</div>
                  <button
                    onClick={() => window.location.reload()}
                    className="mt-4 bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg transition-colors"
                  >
                    ゲームを再読み込み
                  </button>
                  <div className="text-sm text-gray-500 mt-2">Escキーでトップにもどることもできます</div>
                </div>
              )}
            </div>
          )}

          {/* ゲームコンテナ */}
          <div
            ref={gameContainerRef}
            className={`overflow-hidden w-full ${wide ? '' : 'border-4 border-white rounded-2xl shadow-lg'}`}
            style={{
              // PCモニタでは画面いっぱい（HUDはゲーム側で左右へ配置される）
              maxWidth: wide ? '100%' : `${WINDOW_CONFIG.gameContainer.maxWidth}px`,
              width: '100%',
              // メッセージ見切れ対策: ヘッダー(60px) + 余白(10px) + ボタン・メッセージ(180px) = 250px
              // 大画面: calc(100vh - 240px) = メッセージ領域確保したプレイエリア
              // 小画面: 350px最小保証、必要に応じてヘッダーめり込み
              height: wide ? '100vh' : 'max(350px, calc(100vh - 240px))',
              // ヘッダーより低いz-indexでヘッダーの裏に潜り込み可能（必要時のみ）
              zIndex: 1,
              // 初期化中はコンテナを非表示にするが、レイアウトは維持
              visibility: isLoading ? 'hidden' : 'visible'
            }}
          />
        </div>

        {/* ゲーム説明メッセージ（下部）。
            PCモニタではゲーム内の右サイドHUDに同じ案内を出すので、ここには置かない。 */}
        {!wide && (
          <div className="text-center text-gray-400 space-y-2">
            <div className="text-white text-base font-semibold mb-1">
              つながったグミをぜんぶ食べて、ゴールをめざそう！
            </div>
            <div className="text-sm space-y-1">
              <p>光っているグミを タップ（クリック）で すすむ</p>
              <p>まちがえたら「1手もどす」、こまったら「やりなおす」</p>
              <p>とちゅうでやめるときは「おわる」</p>
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
};

export default GamePage;
