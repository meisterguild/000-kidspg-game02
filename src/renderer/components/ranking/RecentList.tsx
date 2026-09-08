import React from 'react';
import { RecentEntry } from '@shared/types/ranking';
import { AppConfig } from '@shared/types';
import ScrollableCardList from './ScrollableCardList';

interface RecentListProps {
  entries: RecentEntry[];
  config: AppConfig['ranking'] | undefined;
  /** 見出し横のページ番号表示のために、現在ページと総ページ数を親へ渡す */
  onPageInfo?: (current: number, total: number) => void;
}

const RecentList: React.FC<RecentListProps> = ({ entries, config, onPageInfo }) => {
  return (
    <ScrollableCardList
      entries={entries}
      config={config}
      onPageInfo={onPageInfo}
    />
  );
};

export default RecentList;
