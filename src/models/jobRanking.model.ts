export const RANKING_STATUSES = [
  "uploading",
  "running",
  "paused",
  "done",
  "failed",
] as const;
export type RankingStatus = (typeof RANKING_STATUSES)[number];

export type RankingLoadStatus = "pending" | "loaded" | "failed" | "skipped";

/** One CSV row, as the browser sends it to the server. */
export interface RankingRowInput {
  title: string;
  company?: string;
  location?: string;
  url?: string;
  category?: string;
  datePosted?: string;
  language?: string;
  remote?: string;
  experience?: string;
  skills?: string;
  degree?: string;
}

export interface RankingSummary {
  id: string;
  name: string;
  status: RankingStatus;
  error: string | null;
  total: number;
  loaded: number;
  loadFailed: number;
  scored: number;
  createdAt: Date;
}

export interface RankingRowView {
  id: string;
  position: number;
  title: string;
  company: string | null;
  location: string | null;
  url: string | null;
  category: string | null;
  datePosted: string | null;
  loadStatus: RankingLoadStatus;
  loadError: string | null;
  score: number | null;
  bestResumeTitle: string | null;
  reason: string | null;
  scoreError: string | null;
  scoredAt: Date | null;
  jobId: string | null;
}

export interface RankingRowFilter {
  minScore?: number;
  search?: string;
  /** Only rows whose page was read. */
  loadedOnly?: boolean;
  /** Hide rows already added to My Jobs. */
  hideAdded?: boolean;
}

export const RANKING_LIMITS = {
  MAX_ROWS: 10_000,
  UPLOAD_CHUNK: 500,
  PAGE_SIZE: 50,
  MAX_ADD_AT_ONCE: 100,
  FIELD_CHARS: 500,
  SKILLS_CHARS: 1_000,
  DESCRIPTION_CHARS: 8_000,
} as const;
