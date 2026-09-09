import React, { useEffect, useState } from 'react';

/**
 * スタッフ向けの注意を画面の上端に出す。
 *
 * ■ なぜ要るのか（敵対的レビュー 2026-09-09 の指摘）
 * main は `startup-warning` を renderer へ送っていたが、**購読者が1件も無かった**。
 * つまり「記録の保存に失敗しました（この回はランキングに出ません）。
 * スタッフへ知らせてください」という**その子の記録が消えた通知が、
 * 誰にも表示されないまま捨てられていた**。
 *
 * OS のモーダルにしないのは、プレイ中に出ると子どもの操作を止めてしまうため。
 * 画面の上端に細く出し、スタッフが押して消せる形にする。
 *
 * 同じ kind は1件にまとめる（同じ失敗が続いたときに帯が積み上がらないように）。
 */

interface Notice {
  kind: string;
  message: string;
}

export const StaffNoticeBanner: React.FC = () => {
  const [notices, setNotices] = useState<Notice[]>([]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onStartupWarning) return;
    api.onStartupWarning((notice) => {
      setNotices((prev) => {
        // 同じ kind が既にあれば文面だけ更新する（帯を積み上げない）
        const found = prev.findIndex((n) => n.kind === notice.kind);
        if (found >= 0) {
          const next = [...prev];
          next[found] = notice;
          return next;
        }
        return [...prev, notice];
      });
    });
    return () => api.removeStartupWarningListener?.();
  }, []);

  if (notices.length === 0) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-50 flex flex-col">
      {notices.map((n) => (
        <div
          key={n.kind}
          className="flex items-center gap-3 bg-amber-500 px-4 py-2 text-sm font-bold text-black shadow"
        >
          <span aria-hidden="true">⚠️</span>
          <span className="flex-1">{n.message}</span>
          <button
            type="button"
            className="rounded bg-black/20 px-2 py-1 text-xs"
            onClick={() => setNotices((prev) => prev.filter((x) => x.kind !== n.kind))}
          >
            閉じる
          </button>
        </div>
      ))}
    </div>
  );
};
