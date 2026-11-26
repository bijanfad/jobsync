import "server-only";

import { ATS_PROVIDERS } from "@/lib/scraper/ats/registry";
import { decodeHtml } from "@/lib/scraper/html";
import type { JobBoard } from "@/models/automation.model";
import { SEARCH_LIMITS } from "@/models/jobSearch.model";
import { feedText, isoDate, matchesKeywords, matchesLocation, withinAge } from "./match";
import {
  SearchSourceError,
  type SearchHit,
  type SearchQuery,
  type SourceContext,
  type SourceRegistry,
} from "./types";

// One function per site. Every URL here is a fixed public API host; company
// slugs only ever fill a path segment or subdomain after SLUG has checked
// them, so a search can't be pointed at another server.

const TIMEOUT_MS = 20_000;
const USER_AGENT = "JobSync job search (self-hosted)";
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX = SEARCH_LIMITS.MAX_PER_SOURCE;

async function getJson<T>(ctx: SourceContext, url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await ctx.fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new SearchSourceError(`The site refused the request (${res.status}).`);
  }
  if (res.status === 404) throw new SearchSourceError("Not found (404). Check the company name.");
  if (res.status === 429) throw new SearchSourceError("The site is rate-limiting requests. The next run tries again.");
  if (!res.ok) throw new SearchSourceError(`The site answered with an error (${res.status}).`);
  return (await res.json()) as T;
}

async function getText(ctx: SourceContext, url: string): Promise<string> {
  const res = await ctx.fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) throw new SearchSourceError("Not found (404). Check the company name.");
  if (!res.ok) throw new SearchSourceError(`The site answered with an error (${res.status}).`);
  return res.text();
}

const keepWanted = (hits: SearchHit[], q: SearchQuery, ctx: SourceContext, posted: (h: SearchHit) => string | undefined) =>
  hits
    .filter(
      (h) =>
        matchesKeywords(`${h.title} ${h.skills ?? ""}`, q.keywords) &&
        matchesLocation(h.location, Boolean(h.remote), q.location) &&
        withinAge(posted(h), q, ctx.now),
    )
    .slice(0, MAX);

// ── Bundesagentur für Arbeit ───────────────────────────────────────────────
// The public Jobsuche API behind arbeitsagentur.de/jobsuche (its documented
// client key). One query per keyword, newest first, 100 per page.

interface BaJob {
  referenznummer?: string;
  chiffrenummer?: string;
  stellenangebotsTitel?: string;
  hauptberuf?: string;
  firma?: string;
  stellenlokationen?: { adresse?: { ort?: string; plz?: string } }[];
  datumErsteVeroeffentlichung?: string;
  homeofficemoeglich?: boolean;
}
interface BaResponse {
  ergebnisliste?: BaJob[];
  maxErgebnisse?: number;
}

const BA_URL = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs";
const BA_PAGE = 100;

export async function searchBundesagentur(q: SearchQuery, ctx: SourceContext): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  const perKeyword = Math.max(BA_PAGE, Math.ceil(MAX / Math.max(1, q.keywords.length)));
  for (const keyword of q.keywords.length ? q.keywords : [""]) {
    for (let page = 1; page * BA_PAGE <= perKeyword + BA_PAGE - 1; page++) {
      const params = new URLSearchParams({
        angebotsart: "1",
        page: String(page),
        size: String(BA_PAGE),
        veroeffentlichtseit: String(q.maxAgeDays),
      });
      if (keyword) params.set("was", keyword);
      if (q.location) {
        params.set("wo", q.location);
        params.set("umkreis", String(q.radiusKm));
      }
      const data = await getJson<BaResponse>(ctx, `${BA_URL}?${params}`, {
        "X-API-Key": "jobboerse-jobsuche",
      });
      const list = data.ergebnisliste ?? [];
      for (const job of list) {
        const ref = job.referenznummer ?? job.chiffrenummer;
        const title = job.stellenangebotsTitel ?? job.hauptberuf;
        if (!ref || !title) continue;
        const place = job.stellenlokationen?.[0]?.adresse;
        hits.push({
          title,
          company: job.firma,
          location: place?.ort,
          url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(ref)}`,
          category: job.hauptberuf,
          datePosted: job.datumErsteVeroeffentlichung,
          remote: job.homeofficemoeglich ? "Home office possible" : undefined,
        });
      }
      if (list.length < BA_PAGE || page * BA_PAGE >= (data.maxErgebnisse ?? 0)) break;
    }
  }
  return hits.slice(0, MAX);
}

// ── arbeitnow ──────────────────────────────────────────────────────────────
// A free public feed of all its jobs, newest first, 300 per page. It has no
// search, so jobs are filtered here; pages stop once they're older than asked.

interface ArbeitnowJob {
  title: string;
  company_name?: string;
  location?: string;
  remote?: boolean;
  url: string;
  tags?: string[];
  job_types?: string[];
  description?: string;
  created_at?: number; // unix seconds
}
const ARBEITNOW_PAGES = 6;

export async function searchArbeitnow(q: SearchQuery, ctx: SourceContext): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  for (let page = 1; page <= ARBEITNOW_PAGES; page++) {
    const data = await getJson<{ data?: ArbeitnowJob[]; links?: { next?: string | null } }>(
      ctx,
      `https://www.arbeitnow.com/api/job-board-api?page=${page}`,
    );
    const list = data.data ?? [];
    for (const job of list) {
      hits.push({
        title: job.title,
        company: job.company_name,
        location: job.location,
        url: job.url,
        skills: job.tags?.join(", ") || undefined,
        remote: job.remote ? "Remote" : undefined,
        datePosted: isoDate(job.created_at ? job.created_at * 1000 : undefined),
        description: feedText(job.description),
      });
    }
    const oldest = list.at(-1)?.created_at;
    const tooOld = oldest != null && !withinAge(oldest * 1000, q, ctx.now);
    if (!data.links?.next || list.length === 0 || tooOld) break;
  }
  return keepWanted(hits, q, ctx, (h) => h.datePosted);
}

// ── Adzuna ─────────────────────────────────────────────────────────────────
// Aggregates many German boards. Needs the user's own free app id and key.
// Its descriptions are short snippets, so the posting page is still read.

interface AdzunaJob {
  title?: string;
  description?: string;
  redirect_url?: string;
  created?: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  category?: { label?: string };
}
const ADZUNA_PAGE = 50;

export async function searchAdzuna(q: SearchQuery, ctx: SourceContext): Promise<SearchHit[]> {
  if (!ctx.adzuna) {
    throw new SearchSourceError("Add your Adzuna app id and key to search Adzuna.");
  }
  const hits: SearchHit[] = [];
  const pages = Math.max(1, Math.ceil(MAX / ADZUNA_PAGE / Math.max(1, q.keywords.length)));
  for (const keyword of q.keywords.length ? q.keywords : [""]) {
    for (let page = 1; page <= pages; page++) {
      const params = new URLSearchParams({
        app_id: ctx.adzuna.appId,
        app_key: ctx.adzuna.appKey,
        results_per_page: String(ADZUNA_PAGE),
        max_days_old: String(q.maxAgeDays),
        sort_by: "date",
      });
      if (keyword) params.set("what", keyword);
      if (q.location) {
        params.set("where", q.location);
        params.set("distance", String(q.radiusKm));
      }
      const data = await getJson<{ results?: AdzunaJob[]; count?: number }>(
        ctx,
        `https://api.adzuna.com/v1/api/jobs/de/search/${page}?${params}`,
      );
      const list = data.results ?? [];
      for (const job of list) {
        if (!job.title || !job.redirect_url) continue;
        hits.push({
          title: decodeHtml(job.title).replace(/<[^>]+>/g, ""),
          company: job.company?.display_name,
          location: job.location?.display_name,
          url: job.redirect_url,
          category: job.category?.label,
          datePosted: isoDate(job.created),
          description: feedText(job.description),
        });
      }
      if (list.length < ADZUNA_PAGE) break;
    }
  }
  return hits.slice(0, MAX);
}

// ── Career pages ───────────────────────────────────────────────────────────

/** Runs `read` for each company; one bad slug doesn't sink the rest. */
async function eachCompany(
  ctx: SourceContext,
  read: (slug: string) => Promise<SearchHit[]>,
): Promise<SearchHit[]> {
  const slugs = ctx.companies.filter((s) => SLUG.test(s));
  if (slugs.length === 0) throw new SearchSourceError("Add at least one company.");
  const results = await Promise.allSettled(slugs.map(read));
  const hits = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const failed = slugs.filter((_, i) => results[i].status === "rejected");
  if (failed.length === slugs.length) {
    const first = results[0] as PromiseRejectedResult;
    throw new SearchSourceError(
      `Couldn't read ${failed.join(", ")}: ${first.reason instanceof Error ? first.reason.message : "error"}`,
    );
  }
  return hits;
}

const xmlText = (block: string, tag: string) => {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) return undefined;
  const raw = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  return decodeHtml(raw).trim() || undefined;
};

export async function searchPersonio(q: SearchQuery, ctx: SourceContext): Promise<SearchHit[]> {
  const hits = await eachCompany(ctx, async (slug) => {
    const base = `https://${slug.toLowerCase()}.jobs.personio.de`;
    const xml = await getText(ctx, `${base}/xml?language=de`);
    return [...xml.matchAll(/<position>([\s\S]*?)<\/position>/g)].flatMap(([, block]) => {
      const id = xmlText(block, "id");
      const title = xmlText(block, "name");
      if (!id || !title) return [];
      const sections = [...block.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/g)].map(
        ([, d]) => `${xmlText(d, "name") ?? ""}\n${xmlText(d, "value") ?? ""}`,
      );
      const office = xmlText(block, "office");
      return [
        {
          title,
          company: xmlText(block, "subcompany") ?? slug,
          location: office?.replace(/^office\s+/i, ""),
          url: `${base}/job/${encodeURIComponent(id)}`,
          category: xmlText(block, "department"),
          experience: xmlText(block, "yearsOfExperience"),
          remote: /remote/i.test(block) ? "Remote possible" : undefined,
          datePosted: isoDate(xmlText(block, "createdAt")),
          description: feedText(sections.join("\n\n")),
        },
      ];
    });
  });
  return keepWanted(hits, q, ctx, () => undefined);
}

interface RecruiteeOffer {
  title?: string;
  company_name?: string;
  careers_url?: string;
  location?: string;
  remote?: boolean;
  published_at?: string;
  description?: string;
  requirements?: string;
  department?: string;
  status?: string;
}

export async function searchRecruitee(q: SearchQuery, ctx: SourceContext): Promise<SearchHit[]> {
  const hits = await eachCompany(ctx, async (slug) => {
    const data = await getJson<{ offers?: RecruiteeOffer[] }>(
      ctx,
      `https://${slug.toLowerCase()}.recruitee.com/api/offers/`,
    );
    return (data.offers ?? [])
      .filter((o) => o.title && o.careers_url && (!o.status || o.status === "published"))
      .map((o) => ({
        title: o.title!,
        company: o.company_name ?? slug,
        location: o.location,
        url: o.careers_url!,
        category: o.department,
        remote: o.remote ? "Remote" : undefined,
        datePosted: isoDate(o.published_at?.replace(" UTC", "Z").replace(" ", "T")),
        description: feedText(`${o.description ?? ""}\n${o.requirements ?? ""}`),
      }));
  });
  return keepWanted(hits, q, ctx, (h) => h.datePosted);
}

interface SmartRecruitersPosting {
  id?: string;
  name?: string;
  company?: { identifier?: string; name?: string };
  releasedDate?: string;
  location?: { city?: string; fullLocation?: string; remote?: boolean };
  department?: { label?: string };
  experienceLevel?: { label?: string };
}
const SR_PAGE = 100;

export async function searchSmartRecruiters(q: SearchQuery, ctx: SourceContext): Promise<SearchHit[]> {
  const hits = await eachCompany(ctx, async (slug) => {
    const out: SearchHit[] = [];
    // Its own full-text search, one keyword at a time, keeps big employers fast.
    for (const keyword of q.keywords.length ? q.keywords : [""]) {
      for (let offset = 0; offset < MAX; offset += SR_PAGE) {
        const params = new URLSearchParams({ limit: String(SR_PAGE), offset: String(offset) });
        if (keyword) params.set("q", keyword);
        const data = await getJson<{ content?: SmartRecruitersPosting[]; totalFound?: number }>(
          ctx,
          `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?${params}`,
        );
        for (const p of data.content ?? []) {
          if (!p.id || !p.name) continue;
          out.push({
            title: p.name,
            company: p.company?.name ?? slug,
            location: p.location?.fullLocation ?? p.location?.city,
            url: `https://jobs.smartrecruiters.com/${encodeURIComponent(p.company?.identifier ?? slug)}/${encodeURIComponent(p.id)}`,
            category: p.department?.label,
            experience: p.experienceLevel?.label,
            remote: p.location?.remote ? "Remote" : undefined,
            datePosted: isoDate(p.releasedDate),
          });
        }
        if ((data.content ?? []).length < SR_PAGE || offset + SR_PAGE >= (data.totalFound ?? 0)) break;
      }
    }
    return out;
  });
  // The API's search also matches descriptions; keep its matches, filter place and age here.
  return hits
    .filter((h) => matchesLocation(h.location, Boolean(h.remote), q.location) && withinAge(h.datePosted, q, ctx.now))
    .slice(0, MAX);
}

/** Greenhouse, Lever and Ashby reuse the Automations fetchers. */
function atsSource(board: JobBoard) {
  return async (q: SearchQuery, ctx: SourceContext): Promise<SearchHit[]> => {
    const provider = ATS_PROVIDERS[board];
    if (!provider) throw new SearchSourceError("This source isn't available.");
    const slugs = ctx.companies.filter((s) => SLUG.test(s));
    if (slugs.length === 0) throw new SearchSourceError("Add at least one company.");
    let { jobs, errors } = await provider.search(slugs.map((s) => ({ name: s, token: s })));
    // Lever hosts EU companies separately; retry those there.
    if (board === "lever" && errors.length > 0) {
      const eu = await provider.search(errors.map((e) => ({ name: e.token, token: e.token, host: "eu" })));
      jobs = [...jobs, ...eu.jobs];
      errors = eu.errors;
    }
    if (jobs.length === 0 && errors.length > 0) {
      throw new SearchSourceError(`Couldn't read ${errors.map((e) => e.token).join(", ")}: ${errors[0].reason}`);
    }
    const hits: SearchHit[] = jobs
      .filter((j) => j.title && j.url)
      .map((j) => ({
        title: j.title,
        company: j.company,
        location: j.location,
        url: j.url,
        remote: j.isRemote || /remote/i.test(j.workplaceType ?? "") ? "Remote" : undefined,
        datePosted: isoDate(j.postedDate),
        description: feedText(j.description),
      }));
    return keepWanted(hits, q, ctx, (h) => h.datePosted);
  };
}

export const SEARCH_SOURCE_FNS: SourceRegistry = {
  bundesagentur: searchBundesagentur,
  arbeitnow: searchArbeitnow,
  adzuna: searchAdzuna,
  personio: searchPersonio,
  recruitee: searchRecruitee,
  smartrecruiters: searchSmartRecruiters,
  greenhouse: atsSource("greenhouse"),
  lever: atsSource("lever"),
  ashby: atsSource("ashby"),
};
