import { htmlToReadableText } from "@/lib/jobs/import/extractPageContent";
import { decodeHtml } from "@/lib/scraper/html";
import type { SearchQuery } from "./types";

// Sources without a search of their own (arbeitnow's feed, company career
// pages) list every job; these keep the ones the search asked for.

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss");

/** The first keyword the title (or tags) names. "IT-Admin" matches "IT Administrator". */
export function matchingKeyword(text: string, keywords: string[]): string | undefined {
  const hay = fold(text).replace(/[-_/]+/g, " ");
  return keywords.find((k) => hay.includes(fold(k).replace(/[-_/]+/g, " ").trim()));
}

/** True when the title (or tags) names any keyword; no keywords match everything. */
export function matchesKeywords(text: string, keywords: string[]): boolean {
  return keywords.length === 0 || matchingKeyword(text, keywords) !== undefined;
}

/**
 * True when the job is in the place asked for, or remote. No place asked
 * means anywhere. Career pages state places loosely ("Office Köln",
 * "Munich, Bayern"), so this is a contains check with München/Munich,
 * Köln/Cologne and Nürnberg/Nuremberg folded together.
 */
const CITY_ALIASES: [string, string][] = [
  ["munchen", "munich"],
  ["koln", "cologne"],
  ["nurnberg", "nuremberg"],
  ["frankfurt am main", "frankfurt"],
];
export function matchesLocation(
  jobLocation: string | undefined,
  remote: boolean,
  wanted: string | undefined,
): boolean {
  if (!wanted?.trim()) return true;
  if (remote) return true;
  let place = fold(jobLocation ?? "");
  let want = fold(wanted.trim());
  for (const [a, b] of CITY_ALIASES) {
    place = place.replaceAll(a, b);
    want = want.replaceAll(a, b);
  }
  if (!place) return false;
  if (/\b(remote|deutschlandweit|bundesweit|germany-wide)\b/.test(place)) return true;
  return place.includes(want) || want.includes(place);
}

export function withinAge(posted: Date | string | number | undefined, query: SearchQuery, now: Date): boolean {
  if (posted == null || posted === "") return true;
  const d = typeof posted === "number" ? new Date(posted) : new Date(posted);
  if (Number.isNaN(d.getTime())) return true;
  return now.getTime() - d.getTime() <= query.maxAgeDays * 86_400_000;
}

/** HTML from a job feed as plain text for the scorer. */
export function feedText(html: string | undefined | null): string | undefined {
  if (!html) return undefined;
  const text = htmlToReadableText(decodeHtml(html));
  return text || undefined;
}

export function isoDate(d: Date | string | number | undefined): string | undefined {
  if (d == null || d === "") return undefined;
  const date = new Date(d);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}
