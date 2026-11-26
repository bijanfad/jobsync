import "server-only";

import { decodeHtml } from "@/lib/scraper/html";
import { fetchJobPage, JobPageFetchError } from "@/lib/jobs/import/fetchJobPage";
import {
  extractPageContent,
  htmlToReadableText,
} from "@/lib/jobs/import/extractPageContent";
import { RANKING_LIMITS } from "@/models/jobRanking.model";

// Reads one ranked row's job page without AI: nearly every job board puts the
// posting in schema.org JSON-LD or a description element, and that is all the
// scorer needs. A listing page that only points on to the employer's posting
// (Arbeitsagentur's external offers, aggregators) is followed for up to two
// more pages.

const MAX_HOPS = 2;
/** Page text this long is taken as the description when the page has no markup for one. */
const MIN_TEXT_FALLBACK = 1_200;

// Link text that points to the original posting.
const ONWARD_TEXT =
  /(zur (original-?)?(stellen)?anzeige|zum (stellen)?angebot|zur stelle|originalanzeige|stellenanzeige (ansehen|öffnen)|vollständige anzeige|jetzt bewerben|zur bewerbung|hier bewerben|bewerben|apply( now| here| on| for)?|view (the )?(full )?(job|posting)|see (the )?job|to the job|original (job|posting|ad))/i;

const SKIP_HOSTS =
  /(^|\.)(facebook|linkedin|twitter|x|instagram|youtube|xing-news|google|apple|paypal|tiktok|whatsapp|pinterest|kununu|glassdoor|wikipedia)\.[a-z.]+$/i;

export interface LoadedPosting {
  status: "loaded" | "failed";
  description?: string;
  finalUrl?: string;
  error?: string;
}

function jsStringValue(raw: string): string | null {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return null;
  }
}

/**
 * Where a listing page sends the reader for the full posting, or null.
 * Exported for tests.
 */
export function findOnwardLink(html: string, pageUrl: string): string | null {
  const base = new URL(pageUrl);
  const candidates: string[] = [];

  // Arbeitsagentur: the external offer's link sits in Angular's state blob.
  for (const m of html.matchAll(/"(externeUrl|externalUrl|stellenangebotsUrl)"\s*:\s*"((?:[^"\\]|\\.)+)"/g)) {
    const v = jsStringValue(m[2]);
    if (v) candidates.push(v);
  }

  // <meta http-equiv="refresh" content="0; url=...">
  const refresh = html.match(
    /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["'][^"']*url\s*=\s*([^"'>\s]+)/i,
  );
  if (refresh) candidates.push(decodeHtml(refresh[1]));

  // A tiny page that only redirects with script
  if (html.length < 5_000) {
    const js = html.match(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/);
    if (js) candidates.push(js[1]);
  }

  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,400}?)<\/a>/gi)) {
    const attrs = m[1];
    const href = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    const label = `${htmlToReadableText(m[2])} ${attrs.match(/\b(?:title|aria-label)\s*=\s*["']([^"']+)["']/i)?.[1] ?? ""}`;
    if (ONWARD_TEXT.test(label)) candidates.push(decodeHtml(href));
  }

  for (const c of candidates) {
    let next: URL;
    try {
      next = new URL(c, base);
    } catch {
      continue;
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") continue;
    if (SKIP_HOSTS.test(next.hostname)) continue;
    if (next.href.split("#")[0] === base.href.split("#")[0]) continue;
    return next.toString();
  }
  return null;
}

function descriptionOf(html: string): string | null {
  const content = extractPageContent(html);
  if (content.description) return content.description;
  const text = htmlToReadableText(html);
  return text.length >= MIN_TEXT_FALLBACK ? text : null;
}

export async function loadPosting(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LoadedPosting> {
  let current = url;
  let firstError: string | undefined;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let page;
    try {
      page = await fetchJobPage(current, fetchImpl);
    } catch (error) {
      const message =
        error instanceof JobPageFetchError ? error.message : "Couldn't read the job page.";
      return { status: "failed", error: firstError ?? message };
    }
    const description = descriptionOf(page.html);
    if (description) {
      return {
        status: "loaded",
        description: description.slice(0, RANKING_LIMITS.DESCRIPTION_CHARS),
        finalUrl: page.finalUrl,
      };
    }
    firstError ??=
      "The page loads its job details with JavaScript, so there was no description to read.";
    const next = findOnwardLink(page.html, page.finalUrl);
    if (!next) break;
    current = next;
  }
  return { status: "failed", error: firstError };
}
