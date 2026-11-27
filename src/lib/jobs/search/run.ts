import "server-only";

import prisma from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { log } from "@/lib/telemetry";
import { urlKey } from "@/lib/jobs/ranking/csv";
import { ensureRankingWorker } from "@/lib/jobs/ranking/worker";
import { RANKING_LIMITS } from "@/models/jobRanking.model";
import {
  CAREER_SOURCE_IDS,
  SEARCH_SOURCE_IDS,
  sourceLabel,
  splitKeywords,
  type CareerSourceId,
  type SearchCompanies,
  type SearchRunSummary,
  type SearchSourceId,
} from "@/models/jobSearch.model";
import { SEARCH_SOURCE_FNS } from "./sources";
import type { SearchHit, SearchQuery, SourceRegistry } from "./types";

// One run of a saved search: ask every chosen site, keep the jobs this
// search hasn't seen before, and hand them to the search's ranking, whose
// worker reads the pages and scores them against the CVs.

export const ADZUNA_KEY_PROVIDER = "adzuna";
/** A run that hasn't finished in this long was cut off by a restart. */
const STALE_RUN_MS = 60 * 60 * 1000;
/** Daily searches run when the last run is at least this old. */
const DAILY_EVERY_MS = 23 * 60 * 60 * 1000;
const MIN_DESCRIPTION = 200;

export function parseSources(raw: string | null | undefined): SearchSourceId[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((s): s is SearchSourceId => SEARCH_SOURCE_IDS.includes(s)) : [];
  } catch {
    return [];
  }
}

export function parseCompanies(raw: string | null | undefined): SearchCompanies {
  try {
    const v = JSON.parse(raw ?? "{}");
    const out: SearchCompanies = {};
    for (const id of CAREER_SOURCE_IDS) {
      if (Array.isArray(v?.[id])) out[id] = v[id].filter((s: unknown) => typeof s === "string");
    }
    return out;
  } catch {
    return {};
  }
}

export function parseRunSummary(raw: string | null | undefined): SearchRunSummary | null {
  try {
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" && v.sources ? (v as SearchRunSummary) : null;
  } catch {
    return null;
  }
}

async function adzunaCredentials(userId: string) {
  const key = await prisma.apiKey.findUnique({
    where: { userId_provider: { userId, provider: ADZUNA_KEY_PROVIDER } },
    select: { encryptedKey: true, iv: true },
  });
  if (!key) return undefined;
  try {
    const [appId, appKey] = decrypt(key.encryptedKey, key.iv).split(":");
    return appId && appKey ? { appId, appKey } : undefined;
  } catch {
    return undefined;
  }
}

/** Same job on two sites: title without "(m/w/d)" and the like, plus company. */
const titleKey = (h: { title: string; company?: string | null }) => {
  const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß]+/g, "");
  return `${plain(h.title.replace(/\([^)]*\)/g, ""))}|${plain(h.company ?? "")}`;
};

const safeUrlKey = (url: string | null | undefined) => {
  try {
    return url ? urlKey(url) : null;
  } catch {
    return null;
  }
};

const runState = globalThis as unknown as { __jobSearchRuns?: Set<string> };
const runs = (runState.__jobSearchRuns ??= new Set<string>());

export function isSearchRunning(searchId: string): boolean {
  return runs.has(searchId);
}

export interface RunOptions {
  fetchImpl?: typeof fetch;
  sources?: SourceRegistry;
  now?: Date;
}

export async function runJobSearch(searchId: string, opts: RunOptions = {}): Promise<SearchRunSummary | null> {
  if (runs.has(searchId)) return null;
  runs.add(searchId);
  try {
    return await runOnce(searchId, opts);
  } finally {
    runs.delete(searchId);
  }
}

async function ensureRanking(search: { id: string; userId: string; name: string; rankingId: string | null }) {
  if (search.rankingId) {
    const existing = await prisma.jobRanking.findFirst({
      where: { id: search.rankingId, userId: search.userId },
      select: { id: true },
    });
    if (existing) return existing.id;
  }
  const created = await prisma.jobRanking.create({
    data: { userId: search.userId, name: `Find jobs: ${search.name}`, status: "running", total: 0 },
    select: { id: true },
  });
  await prisma.jobSearch.update({ where: { id: search.id }, data: { rankingId: created.id } });
  return created.id;
}

async function runOnce(searchId: string, opts: RunOptions): Promise<SearchRunSummary | null> {
  const now = opts.now ?? new Date();
  const search = await prisma.jobSearch.findUnique({ where: { id: searchId } });
  if (!search) return null;
  await prisma.jobSearch.update({ where: { id: searchId }, data: { status: "running" } });

  const summary: SearchRunSummary = { at: now.toISOString(), added: 0, sources: {}, titles: {} };
  const tally = (keyword: string | undefined, field: "found" | "added") => {
    if (!keyword) return;
    const t = (summary.titles![keyword] ??= { found: 0, added: 0 });
    t[field]++;
  };
  try {
    const rankingId = await ensureRanking(search);
    const existing = await prisma.jobRankingRow.findMany({
      where: { rankingId },
      select: { url: true, finalUrl: true, title: true, company: true },
    });
    const seenUrls = new Set(existing.flatMap((r) => [safeUrlKey(r.url), safeUrlKey(r.finalUrl)]).filter(Boolean));
    const seenTitles = new Set(existing.map(titleKey));
    let room = RANKING_LIMITS.MAX_ROWS - existing.length;

    const query: SearchQuery = {
      keywords: splitKeywords(search.keywords),
      location: search.location?.trim() || undefined,
      radiusKm: search.radiusKm,
      maxAgeDays: search.maxAgeDays,
    };
    // Every title shows in the results, also those that found nothing.
    for (const k of query.keywords) summary.titles![k] = { found: 0, added: 0 };
    const companies = parseCompanies(search.companies);
    const sources = opts.sources ?? SEARCH_SOURCE_FNS;
    const adzuna = parseSources(search.sources).includes("adzuna")
      ? await adzunaCredentials(search.userId)
      : undefined;

    let position = existing.length;
    for (const sourceId of parseSources(search.sources)) {
      let hits: SearchHit[];
      try {
        hits = await sources[sourceId](query, {
          fetchImpl: opts.fetchImpl ?? fetch,
          companies: companies[sourceId as CareerSourceId] ?? [],
          adzuna,
          now,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summary.sources[sourceId] = { found: 0, added: 0, error: message.slice(0, 300) };
        log.error("[Find jobs] Source failed", { "search.id": searchId, source: sourceId, error: message });
        continue;
      }
      hits.forEach((h) => tally(h.keyword, "found"));
      const fresh = hits.filter((h) => {
        const key = safeUrlKey(h.url);
        const tk = titleKey(h);
        if (!key || seenUrls.has(key) || seenTitles.has(tk)) return false;
        seenUrls.add(key);
        seenTitles.add(tk);
        return true;
      });
      const kept = fresh.slice(0, Math.max(0, room));
      room -= kept.length;
      kept.forEach((h) => tally(h.keyword, "added"));
      if (kept.length > 0) {
        await prisma.jobRankingRow.createMany({
          data: kept.map((h) => {
            const loaded = (h.description?.length ?? 0) >= MIN_DESCRIPTION;
            return {
              rankingId,
              position: position++,
              source: sourceLabel(sourceId),
              title: h.title.slice(0, RANKING_LIMITS.FIELD_CHARS),
              company: h.company?.slice(0, RANKING_LIMITS.FIELD_CHARS),
              location: h.location?.slice(0, RANKING_LIMITS.FIELD_CHARS),
              url: h.url.slice(0, 2_000),
              category: h.category?.slice(0, RANKING_LIMITS.FIELD_CHARS),
              datePosted: h.datePosted?.slice(0, 40),
              language: h.language?.slice(0, RANKING_LIMITS.FIELD_CHARS),
              remote: h.remote?.slice(0, 100),
              experience: h.experience?.slice(0, 100),
              skills: h.skills?.slice(0, RANKING_LIMITS.SKILLS_CHARS),
              degree: h.degree?.slice(0, RANKING_LIMITS.FIELD_CHARS),
              description: h.description?.slice(0, RANKING_LIMITS.DESCRIPTION_CHARS),
              loadStatus: loaded ? "loaded" : "pending",
              finalUrl: loaded ? h.url.slice(0, 2_000) : null,
            };
          }),
        });
      }
      summary.sources[sourceId] = { found: hits.length, added: kept.length };
      summary.added += kept.length;
    }

    if (summary.added > 0) {
      await prisma.jobRanking.update({
        where: { id: rankingId },
        data: { total: position, status: "running", error: null },
      });
      ensureRankingWorker(rankingId);
    }
    return summary;
  } finally {
    await prisma.jobSearch.update({
      where: { id: searchId },
      data: { status: "idle", lastRunAt: now, lastRun: JSON.stringify(summary) },
    });
    log.info("[Find jobs] Run finished", { "search.id": searchId, added: summary.added });
  }
}

/** Called by the hourly scheduler: runs each daily search once a day. */
export async function runDueJobSearches(now = new Date()): Promise<void> {
  try {
    const due = await prisma.jobSearch.findMany({
      where: {
        daily: true,
        OR: [{ lastRunAt: null }, { lastRunAt: { lt: new Date(now.getTime() - DAILY_EVERY_MS) } }],
        AND: [
          {
            OR: [{ status: "idle" }, { updatedAt: { lt: new Date(now.getTime() - STALE_RUN_MS) } }],
          },
        ],
      },
      select: { id: true },
      orderBy: { lastRunAt: { sort: "asc", nulls: "first" } },
    });
    for (const s of due) await runJobSearch(s.id);
  } catch (error) {
    log.error("[Find jobs] Scheduled runs failed", { error: String(error) });
  }
}
