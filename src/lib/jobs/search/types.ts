import type { RankingRowInput } from "@/models/jobRanking.model";
import type { SearchSourceId } from "@/models/jobSearch.model";

export interface SearchQuery {
  keywords: string[];
  location?: string;
  radiusKm: number;
  maxAgeDays: number;
}

/** One job a source found. A description long enough to score skips page loading. */
export interface SearchHit extends RankingRowInput {
  url: string;
  description?: string;
  /** The search title that found it, for the per-title counts. */
  keyword?: string;
}

export interface SourceContext {
  fetchImpl: typeof fetch;
  /** Career-page sources: the company slugs to read. */
  companies: string[];
  adzuna?: { appId: string; appKey: string };
  now: Date;
}

export type SearchSourceFn = (query: SearchQuery, ctx: SourceContext) => Promise<SearchHit[]>;

export class SearchSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchSourceError";
  }
}

export type SourceRegistry = Record<SearchSourceId, SearchSourceFn>;
