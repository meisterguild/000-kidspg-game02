import React from 'react';
import { RecentEntry, RankingTopEntry } from '@shared/types/ranking';
import PaginatedScrollList from './PaginatedScrollList';
import { AppConfig } from '@shared/types';

interface ScrollableCardListProps {
  entries: (RecentEntry | RankingTopEntry)[];
  config: AppConfig['ranking'] | undefined;
  /** 見出し横のページ番号表示のために、現在ページと総ページ数を親へ渡す */
  onPageInfo?: (current: number, total: number) => void;
}

const ScrollableCardList: React.FC<ScrollableCardListProps> = ({
  entries,
  config,
  onPageInfo,
}) => {
  // ページネーション方式を使用する場合
  return <PaginatedScrollList entries={entries} config={config} onPageInfo={onPageInfo} />;
};

export default ScrollableCardList;