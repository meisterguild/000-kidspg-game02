import { useEffect, useState } from 'react';

/**
 * 「横に余白がある画面か」を返す。
 *
 * PC モニタ（当日の本番想定は 1200x800 以上）では、プレイエリアを縦いっぱいに使い、
 * HUD（残り時間・スコア・操作ボタン・説明）を左右の余白へ逃がす。
 * 幅が足りない・縦長の画面では従来どおり、HUD を盤面の上に重ねる。
 *
 * 閾値の根拠:
 *   - 幅 900px 未満だと左右パネル（各 200px 前後）を置くと盤面が痩せる
 *   - 縦横比 1.15 未満（ほぼ正方形〜縦長）だと左右に逃がす余白がない
 */
export const WIDE_MIN_WIDTH = 900;
export const WIDE_MIN_ASPECT = 1.15;

const matches = (): boolean => {
  if (typeof window === 'undefined') return false;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (!w || !h) return false;
  return w >= WIDE_MIN_WIDTH && w / h >= WIDE_MIN_ASPECT;
};

export function useWideLayout(): boolean {
  const [wide, setWide] = useState<boolean>(matches);

  useEffect(() => {
    const update = () => setWide(matches());
    // マウント直後にもう一度見る（SSR/初回レンダー時に窓のサイズが確定していない場合の保険）
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return wide;
}

export default useWideLayout;
