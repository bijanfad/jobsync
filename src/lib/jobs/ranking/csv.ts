import Papa from "papaparse";
import { RANKING_LIMITS, type RankingRowInput } from "@/models/jobRanking.model";

// Reads a job list CSV (JobSync doesn't make these; job finder tools and
// spreadsheets do) into ranking rows. Headers are matched loosely, in English
// and German, so an export from another tool works without renaming columns.

type Field = keyof RankingRowInput;

const HEADER_ALIASES: Record<Field, string[]> = {
  title: ["title", "job title", "jobtitle", "position", "role", "stelle", "stellentitel", "titel", "jobtitel", "berufsbezeichnung"],
  company: ["company", "company name", "employer", "organization", "organisation", "unternehmen", "firma", "arbeitgeber"],
  location: ["location", "location / remote", "city", "place", "ort", "standort", "arbeitsort", "stadt"],
  url: ["url", "link", "job url", "job link", "joburl", "apply url", "application url", "stellenlink", "adresse"],
  category: ["job type", "category", "field", "kategorie", "bereich", "berufsfeld", "jobtyp"],
  datePosted: ["date posted", "posted", "date", "published", "datum", "veröffentlicht", "veroeffentlicht"],
  language: ["language", "languages", "sprache", "sprachen"],
  remote: ["remote", "home office", "homeoffice", "workplace", "workplace type"],
  experience: ["experience", "experience (years)", "years of experience", "erfahrung", "berufserfahrung"],
  skills: ["skills", "tags", "keywords", "technologies", "kenntnisse", "fähigkeiten", "faehigkeiten"],
  degree: ["degree", "education", "abschluss", "ausbildung", "bildung"],
};

const norm = (h: string) =>
  h.replace(/^﻿/, "").trim().toLowerCase().replace(/\s+/g, " ");

/** Column index for each field the header row names. */
export function mapHeaders(headers: string[]): Partial<Record<Field, number>> {
  const map: Partial<Record<Field, number>> = {};
  const normalized = headers.map(norm);
  for (const field of Object.keys(HEADER_ALIASES) as Field[]) {
    const aliases = HEADER_ALIASES[field];
    const exact = normalized.findIndex((h) => aliases.includes(h));
    if (exact >= 0 && !Object.values(map).includes(exact)) {
      map[field] = exact;
    }
  }
  // Fallback for "title"-like headers such as "Job Title (EN)"
  if (map.title == null) {
    const i = normalized.findIndex((h) => /\b(title|titel|position|stelle)\b/.test(h));
    if (i >= 0) map.title = i;
  }
  if (map.url == null) {
    const i = normalized.findIndex((h) => /\b(url|link)\b/.test(h));
    if (i >= 0) map.url = i;
  }
  return map;
}

export interface ParsedRankingCsv {
  rows: RankingRowInput[];
  /** Field → header text, for the "we found these columns" summary. */
  columns: Partial<Record<Field, string>>;
  duplicates: number;
  skipped: number;
  truncated: boolean;
  error?: string;
}

const clip = (s: string | undefined, max: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
};

function cleanUrl(raw: string | undefined): string | undefined {
  const t = (raw ?? "").trim();
  if (!t) return undefined;
  const withScheme = /^https?:\/\//i.test(t) ? t : /^www\./i.test(t) ? `https://${t}` : t;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.toString().slice(0, 2_000);
  } catch {
    return undefined;
  }
}

/** Same posting under a different tracking query or host case. */
export function urlKey(url: string): string {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) {
    if (/^(utm_|gclid|fbclid|ref$|source$|cp$|p$|tc$|jw_chl_seg$)/i.test(k)) {
      u.searchParams.delete(k);
    }
  }
  return `${u.hostname.replace(/^www\./i, "").toLowerCase()}${u.pathname.replace(/\/$/, "")}?${u.searchParams.toString()}`;
}

export function parseRankingCsv(text: string): ParsedRankingCsv {
  const result = Papa.parse<string[]>(text.replace(/^﻿/, ""), {
    skipEmptyLines: "greedy",
  });
  const [headers, ...body] = result.data;
  const empty = { rows: [], columns: {}, duplicates: 0, skipped: 0, truncated: false };
  if (!headers || body.length === 0) {
    return { ...empty, error: "The file has no rows. Export it again as CSV with a header row." };
  }
  const map = mapHeaders(headers);
  if (map.title == null) {
    return {
      ...empty,
      error: `Couldn't find a job title column. The header row has: ${headers.slice(0, 12).join(", ")}.`,
    };
  }
  const columns: Partial<Record<Field, string>> = {};
  for (const [field, i] of Object.entries(map) as [Field, number][]) {
    columns[field] = headers[i].replace(/^﻿/, "").trim();
  }

  const { FIELD_CHARS, SKILLS_CHARS, MAX_ROWS } = RANKING_LIMITS;
  const seen = new Set<string>();
  const rows: RankingRowInput[] = [];
  let duplicates = 0;
  let skipped = 0;
  let truncated = false;
  for (const cells of body) {
    const get = (f: Field) => (map[f] != null ? cells[map[f]!] : undefined);
    const title = clip(get("title"), FIELD_CHARS);
    if (!title) {
      skipped++;
      continue;
    }
    const url = cleanUrl(get("url"));
    const company = clip(get("company"), FIELD_CHARS);
    const key = url ? urlKey(url) : `${title}|${company ?? ""}|${get("location") ?? ""}`.toLowerCase();
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
    rows.push({
      title,
      company,
      location: clip(get("location"), FIELD_CHARS),
      url,
      category: clip(get("category"), FIELD_CHARS),
      datePosted: clip(get("datePosted"), 40),
      language: clip(get("language"), FIELD_CHARS),
      remote: clip(get("remote"), 100),
      experience: clip(get("experience"), 100),
      skills: clip(get("skills"), SKILLS_CHARS),
      degree: clip(get("degree"), FIELD_CHARS),
    });
  }
  return { rows, columns, duplicates, skipped, truncated };
}
