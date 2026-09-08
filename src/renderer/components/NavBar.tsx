import React, { useCallback, useRef, useState } from 'react';
import { useScreen } from '../contexts/ScreenContext';
import { useGameSession } from '../contexts/GameSessionContext';
import { playSound } from '../utils/assets';

/**
 * 画面右上に常時出す操作バー。
 *
 * 当日はマウス（タッチ）操作が主になるため、**キーボードだけでしか行えない操作を無くす**。
 * これまで TOP へ戻るのは Esc キーだけ、終了はウィンドウの × だけだった。
 *
 * ・「もどる」… Esc と同じ処理。GAME / COUNTDOWN 中は出さない
 *   （撮影済みの写真と実行中の ComfyUI ジョブを残して戻ると、
 *     result.json の無い孤児ディレクトリができる。App.tsx の Esc 処理と同じ理由）
 * ・「ランキング」… 別ウィンドウを開く（TOP のときだけ）。TOP 画面の同じ位置にあった
 *   ボタンをここへ移した（同じ右上に重なっていたため）
 * ・「終了」  … 終了確認ダイアログを出す（main プロセスの before-quit と同じ経路）
 * ・「設定」  … スタッフ用。**5回連続でクリックしたときだけ**開く。
 *   子どもが誤って触って記録を消さないようにするため、1回では反応させない。
 */

/** 設定画面を開くのに必要なクリック回数。増やすほど誤爆しにくいが、スタッフの手間も増える */
const STAFF_TAP_COUNT = 5;
/** クリック間隔がこれを超えたら数え直す（ミリ秒） */
const STAFF_TAP_WINDOW_MS = 2500;

export const NavBar: React.FC = () => {
  const { currentScreen, setCurrentScreen } = useScreen();
  const { resetGameState } = useGameSession();
  const [staffTaps, setStaffTaps] = useState(0);
  const lastTapAt = useRef(0);

  // ゲーム中・カウントダウン中は戻れないようにする（進行を壊さないため）
  const canGoBack = currentScreen !== 'TOP' && currentScreen !== 'GAME' && currentScreen !== 'COUNTDOWN';

  const handleBack = useCallback(() => {
    playSound('paltu');
    setCurrentScreen('TOP');
    resetGameState();
  }, [setCurrentScreen, resetGameState]);

  const handleExit = useCallback(() => {
    playSound('buttonClick');
    // main プロセスへ終了を要求する。確認ダイアログは main 側から出る。
    // 🔴 window.close() は使わない。close の preventDefault を貫通して
    // 確認ダイアログを飛ばしてしまう（main.ts の 'request-exit' を参照）。
    window.electronAPI?.requestExit();
  }, []);

  const handleStaffTap = useCallback(() => {
    const now = Date.now();
    const next = now - lastTapAt.current > STAFF_TAP_WINDOW_MS ? 1 : staffTaps + 1;
    lastTapAt.current = now;
    if (next >= STAFF_TAP_COUNT) {
      setStaffTaps(0);
      playSound('bell');
      setCurrentScreen('TEST');
      return;
    }
    setStaffTaps(next);
  }, [staffTaps, setCurrentScreen]);

  const remain = STAFF_TAP_COUNT - staffTaps;

  return (
    <div className="fixed top-3 right-3 z-50 flex items-center gap-2">
      {canGoBack && (
        <button
          type="button"
          onClick={handleBack}
          className="px-4 py-2 rounded-xl bg-white/90 hover:bg-white text-game-text font-bold
                     border-2 border-white shadow-lg transition-transform hover:scale-105"
          aria-label="タイトルへもどる"
        >
          ← もどる<span className="ml-1 text-xs opacity-70">(Esc)</span>
        </button>
      )}

      {currentScreen === 'TOP' && (
        <button
          type="button"
          onClick={() => { playSound('buttonClick'); window.electronAPI?.showRankingWindow(); }}
          className="px-4 py-2 rounded-xl bg-white/90 hover:bg-white text-game-text font-bold
                     border-2 border-white shadow-lg transition-transform hover:scale-105"
          aria-label="ランキングを別ウィンドウで表示"
        >
          ランキング
        </button>
      )}

      <button
        type="button"
        onClick={handleExit}
        className="px-4 py-2 rounded-xl bg-mg-brand-500 hover:bg-mg-brand-600 text-white font-bold
                   border-2 border-white shadow-lg transition-transform hover:scale-105"
        aria-label="アプリを終了する"
      >
        終了
      </button>

      {/* スタッフ用。歯車だけを小さく出し、連続クリックで設定画面へ */}
      <button
        type="button"
        onClick={handleStaffTap}
        className="w-9 h-9 rounded-xl bg-white/50 hover:bg-white/80 text-game-text
                   border border-white/70 shadow transition-transform hover:scale-105"
        title={staffTaps > 0 ? `あと ${remain} 回` : 'スタッフ用'}
        aria-label="スタッフ用の設定画面"
      >
        ⚙
      </button>
      {staffTaps > 0 && (
        <span className="text-xs font-bold text-game-text bg-white/80 rounded px-2 py-1">
          あと {remain} 回
        </span>
      )}
    </div>
  );
};

export default NavBar;
