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
  rankingId: string | null;
  status: "idle" | "running";
  lastRunAt: Date | null;
  lastRun: SearchRunSummary | null;
}

export interface JobSearchInput {
  name: string;
  keywords: string;
  location?: string;
  radiusKm: number;
  maxAgeDays: number;
  sources: SearchSourceId[];
  companies: SearchCompanies;
  daily: boolean;
}

export const SEARCH_LIMITS = {
  MAX_SEARCHES: 20,
  MAX_KEYWORDS: 10,
  MAX_COMPANIES_PER_SOURCE: 50,
  /** Jobs kept per source per run. */
  MAX_PER_SOURCE: 1_000,
  RADIUS_OPTIONS: [10, 25, 50, 100, 200],
  AGE_OPTIONS: [1, 3, 7, 14, 30],
} as const;

/** Splits "IT-Administrator, Security; SOC" into keywords. */
export function splitKeywords(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,;\n]/)
        .map((k) => k.trim())
        .filter((k) => k.length >= 2),
    ),
  ].slice(0, SEARCH_LIMITS.MAX_KEYWORDS);
}
