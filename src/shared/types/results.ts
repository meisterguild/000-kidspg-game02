export interface RecentResultEntry {
  resultPath: string;
  memorialCardPath: string;
  score: number;
  playedAt: string; // yyyy-mm-dd hh:mm:ss format
}

export interface RankingResultEntry {
  resultPath: string;
  memorialCardPath: string;
  score: number;
  rank: number;
}

export interface ResultsData {
  recent: RecentResultEntry[];
  ranking_top: RankingResultEntry[];
}