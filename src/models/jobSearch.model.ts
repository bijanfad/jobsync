export const SEARCH_SOURCES = [
  {
    id: "bundesagentur",
    label: "Bundesagentur für Arbeit",
    kind: "portal",
    help: "Germany's largest job portal, including many partner job boards.",
  },
  {
    id: "arbeitnow",
    label: "arbeitnow",
    kind: "portal",
    help: "Jobs in Germany, many in IT and in English.",
  },
  {
    id: "adzuna",
    label: "Adzuna",
    kind: "portal",
    help: "Collects jobs from many German job boards. Needs a free Adzuna API key.",
  },
  {
    id: "personio",
    label: "Personio",
    kind: "careers",
    help: "Company slug from the link: acme.jobs.personio.de → acme",
  },
  {
    id: "recruitee",
    label: "Recruitee",
    kind: "careers",
    help: "Company slug from the link: acme.recruitee.com → acme",
  },
  {
    id: "smartrecruiters",
    label: "SmartRecruiters",
    kind: "careers",
    help: "Company id from the link: jobs.smartrecruiters.com/BoschGroup → BoschGroup",
  },
  {
    id: "greenhouse",
    label: "Greenhouse",
    kind: "careers",
    help: "Board name from the link: job-boards.greenhouse.io/acme → acme",
  },
  {
    id: "lever",
    label: "Lever",
    kind: "careers",
    help: "Company from the link: jobs.lever.co/acme → acme",
  },
  {
    id: "ashby",
    label: "Ashby",
    kind: "careers",
    help: "Company from the link: jobs.ashbyhq.com/acme → acme",
  },
] as const;

export type SearchSourceId = (typeof SEARCH_SOURCES)[number]["id"];
export type CareerSourceId = Extract<
  (typeof SEARCH_SOURCES)[number],
  { kind: "careers" }
>["id"];

export const SEARCH_SOURCE_IDS = SEARCH_SOURCES.map((s) => s.id) as SearchSourceId[];
export const CAREER_SOURCE_IDS = SEARCH_SOURCES.filter((s) => s.kind === "careers").map(
  (s) => s.id,
) as CareerSourceId[];

export function sourceLabel(id: string): string {
  return SEARCH_SOURCES.find((s) => s.id === id)?.label ?? id;
}

export type SearchCompanies = Partial<Record<CareerSourceId, string[]>>;

export interface SearchSourceResult {
  found: number;
  added: number;
  error?: string;
}

export interface SearchRunSummary {
  at: string; // ISO
  added: number;
  sources: Partial<Record<SearchSourceId, SearchSourceResult>>;
  /** Per search title, across all sites: jobs found and new jobs added. */
  titles?: Record<string, { found: number; added: number }>;
}

export interface JobSearchView {
  id: string;
  name: string;
  keywords: string;
  location: string | null;
  radiusKm: number;
  maxAgeDays: number;
  sources: SearchSourceId[];
  companies: SearchCompanies;
  daily: boolean;
  emailAlerts: boolean;
  emailMinScore: number;
  rankingId: string | null;
  status: "idle" | "running";
  lastRunAt: Date | null;
  lastRun: SearchRunSummary | null;
}

export interface JobSearchesData {
  searches: JobSearchView[];
  hasAdzunaKey: boolean;
  /** Whether SMTP is set up in .env, and where alerts would go. */
  email: { configured: boolean; to: string | null };
}

/** Minimum score choices for "Email me new matches". */
export const EMAIL_MIN_SCORES = [40, 50, 60, 70, 80] as const;

export interface JobSearchInput {
  name: string;
  keywords: string;
  location?: string;
  radiusKm: number;
  maxAgeDays: number;
  sources: SearchSourceId[];
  companies: SearchCompanies;
  daily: boolean;
  emailAlerts?: boolean;
  emailMinScore?: number;
}

export const SEARCH_LIMITS = {
  MAX_SEARCHES: 20,
  /** A job list from the CVs can be long; each title is its own search. */
  MAX_KEYWORDS: 60,
  MAX_COMPANIES_PER_SOURCE: 50,
  /** Jobs kept per source per run. */
  MAX_PER_SOURCE: 2_000,
  /** Per title on sites searched one title at a time, so every title gets its share. */
  MIN_PER_KEYWORD: 25,
  RADIUS_OPTIONS: [10, 25, 50, 100, 200],
  AGE_OPTIONS: [1, 3, 7, 14, 30],
} as const;

/** Splits "IT-Administrator, Security; SOC" or one title per line into keywords. */
export function splitKeywords(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;\n]/)) {
    const k = part.trim().slice(0, 80);
    const key = k.toLowerCase();
    if (k.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out.slice(0, SEARCH_LIMITS.MAX_KEYWORDS);
}

/** Per-title budget on sites searched one title at a time. */
export function perKeywordLimit(keywordCount: number): number {
  return Math.max(
    SEARCH_LIMITS.MIN_PER_KEYWORD,
    Math.floor(SEARCH_LIMITS.MAX_PER_SOURCE / Math.max(1, keywordCount)),
  );
}
