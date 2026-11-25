import { decodeHtml } from "@/lib/scraper/html";

// Turns a fetched job page into what the AI reads: any schema.org JobPosting
// the page embeds (most ATSs do, and it survives sites that render the rest
// with JavaScript), the page title, and the readable text.

const MAX_TEXT_CHARS = 40_000;
const MAX_JSONLD_CHARS = 30_000;

function findJobPostings(node: unknown, out: Record<string, unknown>[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((n) => findJobPostings(n, out));
    return;
  }
  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === "string" && t.toLowerCase() === "jobposting")) {
    out.push(obj);
    return;
  }
  if (obj["@graph"]) findJobPostings(obj["@graph"], out);
}

export function extractJobPostingJsonLd(html: string): Record<string, unknown> | null {
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  const found: Record<string, unknown>[] = [];
  for (const match of html.matchAll(re)) {
    try {
      findJobPostings(JSON.parse(match[1].trim()), found);
    } catch {
      // Malformed JSON-LD is common; skip the block.
    }
  }
  return found[0] ?? null;
}

function metaContent(html: string, key: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${key}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
    "i",
  );
  const alt = new RegExp(
    `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${key}["']`,
    "i",
  );
  const m = html.match(re) ?? html.match(alt);
  return m ? decodeHtml(m[1]).trim() || undefined : undefined;
}

export function htmlToReadableText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, " ");
  s = s
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|li|ul|ol|tr|table|header|main)>/gi, "\n")
    .replace(/<h[1-6]\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  s = decodeHtml(s);
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line, i, arr) => line !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .trim();
}

export interface PageContent {
  title?: string;
  siteName?: string;
  jsonLd: string | null;
  text: string;
}

export function extractPageContent(html: string): PageContent {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title =
    metaContent(html, "og:title") ??
    (titleMatch ? decodeHtml(titleMatch[1]).trim() || undefined : undefined);
  const posting = extractJobPostingJsonLd(html);
  return {
    title,
    siteName: metaContent(html, "og:site_name"),
    jsonLd: posting ? JSON.stringify(posting).slice(0, MAX_JSONLD_CHARS) : null,
    text: htmlToReadableText(html).slice(0, MAX_TEXT_CHARS),
  };
}

/** Too little to fill a job from: a JS-only shell, a login wall, a captcha. */
export function hasUsableContent(content: PageContent): boolean {
  return Boolean(content.jsonLd) || content.text.length >= 300;
}
