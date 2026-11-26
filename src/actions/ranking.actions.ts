"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import prisma from "@/lib/db";
import { log } from "@/lib/telemetry";
import { createJobFromNames } from "@/lib/jobs/createJobFromNames";
import { jobSourceLabelFromUrl } from "@/lib/jobs/import/jobSourceFromUrl";
import { ensureRankingWorker, isRankingWorkerRunning } from "@/lib/jobs/ranking/worker";
import {
  RANKING_LIMITS,
  type RankingRowFilter,
  type RankingRowView,
  type RankingStatus,
  type RankingSummary,
} from "@/models/jobRanking.model";
import type { ActionResult } from "@/models/action.model";
import type { Prisma } from "@/generated/prisma/client";
import { requireUser } from "./shared";

const { FIELD_CHARS, SKILLS_CHARS } = RANKING_LIMITS;
const text = (max: number) =>
  z
    .string()
    .optional()
    .transform((s) => (s ? s.trim().slice(0, max) || undefined : undefined));

const RowInputSchema = z.object({
  title: z.string().trim().min(1).transform((s) => s.slice(0, FIELD_CHARS)),
  company: text(FIELD_CHARS),
  location: text(FIELD_CHARS),
  url: z
    .string()
    .optional()
    .transform((s) => (s && /^https?:\/\//i.test(s.trim()) ? s.trim().slice(0, 2_000) : undefined)),
  category: text(FIELD_CHARS),
  datePosted: text(40),
  language: text(FIELD_CHARS),
  remote: text(100),
  experience: text(100),
  skills: text(SKILLS_CHARS),
  degree: text(FIELD_CHARS),
});

const fail = (message: string) => ({ success: false as const, message });

async function ownedRanking(id: string, userId: string) {
  return prisma.jobRanking.findFirst({
    where: { id, userId },
    select: { id: true, status: true, total: true },
  });
}

/** Step 1 of an upload: the ranking, before its rows arrive in chunks. */
export async function createRanking(
  name: string,
  total: number,
): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requireUser();
    const count = Math.floor(Number(total));
    if (!Number.isFinite(count) || count < 1 || count > RANKING_LIMITS.MAX_ROWS) {
      return fail(`A ranking can hold 1 to ${RANKING_LIMITS.MAX_ROWS.toLocaleString()} jobs.`);
    }
    const ranking = await prisma.jobRanking.create({
      data: {
        userId: user.id,
        name: (name || "Job list").trim().slice(0, 200),
        total: count,
      },
      select: { id: true },
    });
    return { success: true, data: ranking };
  } catch (error) {
    log.error("Create ranking failed", { error: String(error) });
    return fail("Couldn't start the upload. Please try again.");
  }
}

/** Step 2: one chunk of CSV rows; `start` is the first row's position. */
export async function addRankingRows(
  rankingId: string,
  start: number,
  rows: unknown[],
): Promise<ActionResult<{ added: number }>> {
  try {
    const user = await requireUser();
    const ranking = await ownedRanking(rankingId, user.id);
    if (!ranking) return fail("Ranking not found.");
    if (ranking.status !== "uploading") return fail("This upload is already finished.");
    if (!Array.isArray(rows) || rows.length > RANKING_LIMITS.UPLOAD_CHUNK) {
      return fail("Too many rows in one chunk.");
    }
    const first = Math.max(0, Math.floor(Number(start) || 0));
    if (first + rows.length > ranking.total) return fail("More rows than the upload announced.");
    const data: Prisma.JobRankingRowCreateManyInput[] = [];
    rows.forEach((raw, i) => {
      const parsed = RowInputSchema.safeParse(raw);
      if (parsed.success) data.push({ ...parsed.data, rankingId, position: first + i });
    });
    const created = await prisma.jobRankingRow.createMany({ data });
    return { success: true, data: { added: created.count } };
  } catch (error) {
    log.error("Add ranking rows failed", { error: String(error) });
    return fail("Couldn't upload part of the list. Please try again.");
  }
}

/** Step 3, and Resume: hands the ranking to the background worker. */
export async function startRanking(rankingId: string): Promise<ActionResult<null>> {
  try {
    const user = await requireUser();
    const ranking = await ownedRanking(rankingId, user.id);
    if (!ranking) return fail("Ranking not found.");
    if (ranking.status === "done") return fail("This ranking is already finished.");
    if (ranking.status === "uploading") {
      const rows = await prisma.jobRankingRow.count({
        where: { rankingId, ranking: { userId: user.id } },
      });
      if (rows === 0) return fail("The upload has no rows.");
      await prisma.jobRanking.updateMany({
        where: { id: rankingId, userId: user.id },
        data: { total: rows },
      });
    }
    await prisma.jobRanking.updateMany({
      where: { id: rankingId, userId: user.id },
      data: { status: "running", error: null },
    });
    ensureRankingWorker(rankingId);
    revalidatePath("/dashboard/rank-jobs");
    return { success: true, data: null };
  } catch (error) {
    log.error("Start ranking failed", { error: String(error) });
    return fail("Couldn't start the ranking. Please try again.");
  }
}

export async function pauseRanking(rankingId: string): Promise<ActionResult<null>> {
  try {
    const user = await requireUser();
    await prisma.jobRanking.updateMany({
      where: { id: rankingId, userId: user.id, status: "running" },
      data: { status: "paused" },
    });
    revalidatePath("/dashboard/rank-jobs");
    return { success: true, data: null };
  } catch (error) {
    log.error("Pause ranking failed", { error: String(error) });
    return fail("Couldn't pause the ranking. Please try again.");
  }
}

export async function deleteRanking(rankingId: string): Promise<ActionResult<null>> {
  try {
    const user = await requireUser();
    // Rows go with it (cascade). Jobs already added to My Jobs stay.
    const deleted = await prisma.jobRanking.deleteMany({
      where: { id: rankingId, userId: user.id },
    });
    if (deleted.count === 0) return fail("Ranking not found.");
    revalidatePath("/dashboard/rank-jobs");
    return { success: true, data: null };
  } catch (error) {
    log.error("Delete ranking failed", { error: String(error) });
    return fail("Couldn't delete the ranking. Please try again.");
  }
}

async function summarize(
  userId: string,
  rankings: { id: string; name: string; status: string; error: string | null; total: number; createdAt: Date }[],
): Promise<RankingSummary[]> {
  if (rankings.length === 0) return [];
  const ids = rankings.map((r) => r.id);
  const [byLoad, scored] = await Promise.all([
    prisma.jobRankingRow.groupBy({
      by: ["rankingId", "loadStatus"],
      where: { rankingId: { in: ids }, ranking: { userId } },
      _count: { _all: true },
    }),
    prisma.jobRankingRow.groupBy({
      by: ["rankingId"],
      where: { rankingId: { in: ids }, scoredAt: { not: null }, ranking: { userId } },
      _count: { _all: true },
    }),
  ]);
  return rankings.map((r) => {
    const loads = byLoad.filter((g) => g.rankingId === r.id);
    const n = (status: string) =>
      loads.find((g) => g.loadStatus === status)?._count._all ?? 0;
    return {
      id: r.id,
      name: r.name,
      status: r.status as RankingStatus,
      error: r.error,
      total: r.total,
      loaded: n("loaded"),
      loadFailed: n("failed") + n("skipped"),
      scored: scored.find((g) => g.rankingId === r.id)?._count._all ?? 0,
      createdAt: r.createdAt,
    };
  });
}

const summarySelect = {
  id: true,
  name: true,
  status: true,
  error: true,
  total: true,
  createdAt: true,
} as const;

export async function getRankings(): Promise<ActionResult<RankingSummary[]>> {
  try {
    const user = await requireUser();
    const rankings = await prisma.jobRanking.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: summarySelect,
    });
    return { success: true, data: await summarize(user.id, rankings) };
  } catch (error) {
    log.error("Get rankings failed", { error: String(error) });
    return fail("Couldn't load your rankings.");
  }
}

const rowViewSelect = {
  id: true,
  position: true,
  title: true,
  company: true,
  location: true,
  url: true,
  category: true,
  datePosted: true,
  loadStatus: true,
  loadError: true,
  score: true,
  bestResumeTitle: true,
  reason: true,
  scoreError: true,
  scoredAt: true,
  jobId: true,
  source: true,
} as const;

export interface RankingPage {
  ranking: RankingSummary;
  rows: RankingRowView[];
  /** Rows matching the filter. */
  matching: number;
  page: number;
  pageSize: number;
}

export async function getRanking(
  rankingId: string,
  page = 1,
  filter: RankingRowFilter = {},
): Promise<ActionResult<RankingPage>> {
  try {
    const user = await requireUser();
    const ranking = await prisma.jobRanking.findFirst({
      where: { id: rankingId, userId: user.id },
      select: summarySelect,
    });
    if (!ranking) return fail("Ranking not found.");
    // A restart stops the worker; the first look at a running ranking revives it.
    if (ranking.status === "running" && !isRankingWorkerRunning(ranking.id)) {
      ensureRankingWorker(ranking.id);
    }

    const where: Prisma.JobRankingRowWhereInput = {};
    if (filter.minScore != null && Number.isFinite(filter.minScore)) {
      where.score = { gte: Math.floor(filter.minScore) };
    }
    if (filter.loadedOnly) where.loadStatus = "loaded";
    if (filter.hideAdded) where.jobId = null;
    const search = filter.search?.trim().slice(0, 100);
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { company: { contains: search, mode: "insensitive" } },
        { location: { contains: search, mode: "insensitive" } },
      ];
    }
    const pageSize = RANKING_LIMITS.PAGE_SIZE;
    const current = Math.max(1, Math.floor(Number(page) || 1));
    const [summary, rows, matching] = await Promise.all([
      summarize(user.id, [ranking]),
      prisma.jobRankingRow.findMany({
        where: { rankingId: ranking.id, ranking: { userId: user.id }, AND: [where] },
        orderBy: [{ score: { sort: "desc", nulls: "last" } }, { position: "asc" }],
        skip: (current - 1) * pageSize,
        take: pageSize,
        select: rowViewSelect,
      }),
      prisma.jobRankingRow.count({
        where: { rankingId: ranking.id, ranking: { userId: user.id }, AND: [where] },
      }),
    ]);
    return {
      success: true,
      data: {
        ranking: summary[0],
        rows: rows as RankingRowView[],
        matching,
        page: current,
        pageSize,
      },
    };
  } catch (error) {
    log.error("Get ranking failed", { error: String(error) });
    return fail("Couldn't load this ranking.");
  }
}

function descriptionFor(row: {
  description: string | null;
  url: string | null;
  skills: string | null;
  experience: string | null;
  language: string | null;
  degree: string | null;
  category: string | null;
}): string {
  if (row.description) return row.description;
  const facts = [
    ["Field", row.category],
    ["Skills", row.skills],
    ["Experience (years)", row.experience],
    ["Languages", row.language],
    ["Degree", row.degree],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `- **${k}:** ${v}`);
  return [
    "_The posting couldn't be read automatically. Open the link and use Fill with AI or Paste posting text to add the full description._",
    "",
    ...facts,
  ].join("\n");
}

/** Adds ranked rows to My Jobs, with the description that was loaded and the best CV score. */
export async function addRankedJobsToMyJobs(
  rowIds: string[],
): Promise<ActionResult<{ added: number; duplicates: number }>> {
  try {
    const user = await requireUser();
    const ids = [...new Set(Array.isArray(rowIds) ? rowIds : [])].slice(
      0,
      RANKING_LIMITS.MAX_ADD_AT_ONCE,
    );
    if (ids.length === 0) return fail("Pick at least one job.");
    const rows = await prisma.jobRankingRow.findMany({
      where: { id: { in: ids }, jobId: null, ranking: { userId: user.id } },
      orderBy: { position: "asc" },
    });
    let added = 0;
    let duplicates = 0;
    for (const row of rows) {
      const result = await createJobFromNames(
        {
          jobTitle: row.title,
          company: row.company || "Unknown company",
          location: row.location || undefined,
          jobDescription: descriptionFor(row),
          jobUrl: row.finalUrl || row.url || undefined,
          source: row.url ? jobSourceLabelFromUrl(row.finalUrl || row.url) : undefined,
        },
        user.id,
      );
      const jobId = result.jobId ?? result.duplicateOf?.id;
      if (result.created && result.jobId && row.score != null && row.bestResumeTitle) {
        await prisma.job.updateMany({
          where: { id: result.jobId, userId: user.id },
          data: {
            bestResumeScore: row.score,
            bestResumeTitle: row.bestResumeTitle,
            resumeComparedAt: row.scoredAt,
          },
        });
      }
      if (result.created) added++;
      else duplicates++;
      if (jobId) {
        await prisma.jobRankingRow.updateMany({
          where: { id: row.id, ranking: { userId: user.id } },
          data: { jobId },
        });
      }
    }
    revalidatePath("/dashboard/myjobs");
    return { success: true, data: { added, duplicates } };
  } catch (error) {
    log.error("Add ranked jobs failed", { error: String(error) });
    return fail("Couldn't add the jobs. Please try again.");
  }
}
