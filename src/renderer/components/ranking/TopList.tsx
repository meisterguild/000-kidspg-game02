import React from 'react';
import { RankingTopEntry } from '@shared/types/ranking';
import { AppConfig } from '@shared/types';
import ScrollableCardList from './ScrollableCardList';

interface TopListProps {
  entries: RankingTopEntry[];
  config: AppConfig['ranking'] | undefined;
  /** 見出し横のページ番号表示のために、現在ページと総ページ数を親へ渡す */
  onPageInfo?: (current: number, total: number) => void;
}

const TopList: React.FC<TopListProps> = ({ entries, config, onPageInfo }) => {
  return (
    <ScrollableCardList
      entries={entries}
      config={config}
      onPageInfo={onPageInfo}
    />
  );
};

export default TopList;
