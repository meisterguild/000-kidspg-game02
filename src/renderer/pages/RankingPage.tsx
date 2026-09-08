import React, { useCallback, useState } from 'react';
import { useRanking } from '../contexts/RankingContext';
import TopList from '../components/ranking/TopList';
import RecentList from '../components/ranking/RecentList';
import ShinyWaveBackground from '../components/ShinyWaveBackground';

/** どの状態でも同じ背景を敷く（読み込み中・エラー・データ無しでも黒画面にしない） */
const RankingShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="relative h-screen overflow-hidden">
    <ShinyWaveBackground fps={20} />
    <div className="relative h-full flex flex-col" style={{ zIndex: 1 }}>{children}</div>
  </div>
);

/** 「０１／２０」の形でページ番号を出す。1ページしか無いときは出さない */
const PageBadge: React.FC<{ page: { current: number; total: number } }> = ({ page }) => {
  if (page.total <= 1) return null;
  const zen = (n: number) =>
    String(n).padStart(2, '0').replace(/[0-9]/g, (d) => '０１２３４５６７８９'[Number(d)]);
  return (
    <span className="ml-3 align-middle text-base tracking-wider tabular-nums">
      {zen(page.current)}／{zen(page.total)}
    </span>
  );
};

const RankingPage: React.FC = () => {
  const { rankingData, rankingConfig, loading, error } = useRanking();
  const [recentPage, setRecentPage] = useState({ current: 0, total: 0 });

  // 子から毎レンダー呼ばれるので、同じ値なら state を更新しない（無駄な再描画を避ける）
  const handleRecentPage = useCallback((current: number, total: number) => {
    setRecentPage((prev) => (prev.current === current && prev.total === total ? prev : { current, total }));
  }, []);

  if (loading) {
    return (
      <RankingShell>
        <div className="flex-1 flex items-center justify-center">
          <p className="gold-heading text-2xl">ランキングを読み込み中...</p>
        </div>
      </RankingShell>
    );
  }

  if (error) {
    return (
      <RankingShell>
        <div className="flex-1 flex items-center justify-center">
          <p className="bg-white/85 rounded-2xl px-6 py-4 text-red-700 text-2xl font-bold">エラー: {error}</p>
        </div>
      </RankingShell>
    );
  }

  if (!rankingData || (!rankingData.recent.length && !rankingData.ranking_top.length)) {
    return (
      <RankingShell>
        <div className="flex-1 flex items-center justify-center">
          <p className="gold-heading text-2xl">まだ きろくが ありません</p>
        </div>
      </RankingShell>
    );
  }

  return (
    <RankingShell>
      {/* Top Ranking Section */}
      <div className="flex-1 flex flex-col overflow-hidden p-2">
        <h2 className="gold-heading text-lg text-center flex-shrink-0 py-1">
          ランキング
        </h2>
        <div className="flex-1 relative min-h-0">
          <TopList
            entries={rankingData.ranking_top}
            config={rankingConfig ?? undefined}
          />
        </div>
      </div>

      {/* Recent Plays Section */}
      <div className="flex-1 flex flex-col overflow-hidden p-2 pt-4">
        <h2 className="gold-heading text-lg text-center flex-shrink-0 py-1">
          みんなの きろく
          <PageBadge page={recentPage} />
        </h2>
        <div className="flex-1 relative min-h-0">
          <RecentList
            entries={rankingData.recent}
            config={rankingConfig ?? undefined}
            onPageInfo={handleRecentPage}
          />
        </div>
      </div>
    </RankingShell>
  );
};

export default RankingPage;
