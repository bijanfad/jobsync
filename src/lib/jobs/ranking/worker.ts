import "server-only";

import prisma from "@/lib/db";
import { log } from "@/lib/telemetry";
import { loadPosting } from "./loadPosting";
import { prepareScorer, RankingSetupError, scoreBatch, type RankScorer } from "./score";

// Runs a ranking in the background, in this server process: load each row's
// page, then score loaded rows in batches. All progress lives in the rows, so
// a restart (deploy, crash) picks up where it stopped: startup and every
// progress poll call ensureRankingWorker.

const LOAD_BATCH = 30;
const LOAD_CONCURRENCY = 6;
/** At most this many pages from one site at a time, to stay polite. */
const PER_HOST = 2;
const SCORE_BATCH = 10;
const MAX_SCORE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

const state = globalThis as unknown as { __jobRankingWorkers?: Map<string, Promise<void>> };
const workers = (state.__jobRankingWorkers ??= new Map());

export function isRankingWorkerRunning(rankingId: string): boolean {
  return workers.has(rankingId);
}

/** Starts the worker for a running ranking unless one is already going. */
export function ensureRankingWorker(rankingId: string): void {
  if (workers.has(rankingId)) return;
  const run = runRanking(rankingId)
    .catch((error) => {
      log.error("[Ranking] Worker crashed", { "ranking.id": rankingId, error: String(error) });
    })
    .finally(() => workers.delete(rankingId));
  workers.set(rankingId, run);
}

/** Restarts rankings a restart interrupted. Called once at server start. */
export async function resumeRankingWorkers(): Promise<void> {
  try {
    const running = await prisma.jobRanking.findMany({
      where: { status: "running" },
      select: { id: true },
    });
    running.forEach((r) => ensureRankingWorker(r.id));
  } catch (error) {
    log.error("[Ranking] Couldn't resume rankings", { error: String(error) });
  }
}

async function stillRunning(rankingId: string): Promise<boolean> {
  const r = await prisma.jobRanking.findUnique({
    where: { id: rankingId },
    select: { status: true },
  });
  return r?.status === "running";
}

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
};

/** Runs `work` over items, LOAD_CONCURRENCY at a time and PER_HOST per site. */
async function loadAll<T extends { url: string | null }>(
  items: T[],
  work: (item: T) => Promise<void>,
  keepGoing: () => Promise<boolean>,
): Promise<void> {
  const queue = [...items];
  const busy = new Map<string, number>();
  const next = (): T | undefined => {
    const i = queue.findIndex((it) => (busy.get(hostOf(it.url)) ?? 0) < PER_HOST);
    return i >= 0 ? queue.splice(i, 1)[0] : undefined;
  };
  const lane = async () => {
    while (queue.length > 0 && (await keepGoing())) {
      const item = next();
      if (!item) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const host = hostOf(item.url);
      busy.set(host, (busy.get(host) ?? 0) + 1);
      try {
        await work(item);
      } finally {
        busy.set(host, (busy.get(host) ?? 1) - 1);
      }
    }
  };
  await Promise.all(Array.from({ length: LOAD_CONCURRENCY }, lane));
}

async function loadNext(rankingId: string): Promise<number> {
  const rows = await prisma.jobRankingRow.findMany({
    where: { rankingId, loadStatus: "pending" },
    orderBy: { position: "asc" },
    take: LOAD_BATCH,
    select: { id: true, url: true },
  });
  // A pause takes effect within a second, not at the end of the batch.
  let checkedAt = 0;
  let running = true;
  const keepGoing = async () => {
    if (Date.now() - checkedAt > 1_000) {
      checkedAt = Date.now();
      running = await stillRunning(rankingId);
    }
    return running;
  };
  await loadAll(rows, async (row) => {
    if (!row.url) {
      await prisma.jobRankingRow.update({
        where: { id: row.id },
        data: { loadStatus: "skipped", loadError: "No link in the CSV." },
      });
      return;
    }
    const loaded = await loadPosting(row.url).catch(() => ({
      status: "failed" as const,
      error: "Couldn't read the job page.",
      description: undefined,
      finalUrl: undefined,
    }));
    await prisma.jobRankingRow.update({
      where: { id: row.id },
      data: {
        loadStatus: loaded.status,
        loadError: loaded.error ?? null,
        description: loaded.description ?? null,
        finalUrl: loaded.finalUrl ?? null,
      },
    });
  }, keepGoing);
  return rows.length;
}

const rankRowSelect = {
  id: true,
  title: true,
  company: true,
  location: true,
  category: true,
  language: true,
  remote: true,
  experience: true,
  skills: true,
  degree: true,
  description: true,
} as const;

async function scoreReady(
  rankingId: string,
  userId: string,
  scorer: RankScorer,
  /** Score a last partial batch; otherwise wait for a full one. */
  final: boolean,
): Promise<void> {
  while (await stillRunning(rankingId)) {
    const rows = await prisma.jobRankingRow.findMany({
      where: { rankingId, scoredAt: null, loadStatus: { not: "pending" } },
      orderBy: { position: "asc" },
      take: SCORE_BATCH,
      select: rankRowSelect,
    });
    if (rows.length === 0 || (rows.length < SCORE_BATCH && !final)) return;

    let scores = null;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_SCORE_ATTEMPTS && !scores; attempt++) {
      try {
        scores = await scoreBatch(userId, scorer, rows);
      } catch (error) {
        lastError = error;
        log.error("[Ranking] Scoring batch failed", {
          "ranking.id": rankingId,
          attempt,
          error: String(error),
        });
        if (attempt < MAX_SCORE_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
        }
      }
    }
    if (!scores) {
      // The rows stay unscored, so resuming retries them.
      const detail = String((lastError as Error)?.message ?? lastError).slice(0, 200);
      await prisma.jobRanking.updateMany({
        where: { id: rankingId, status: "running" },
        data: {
          status: "paused",
          error: `The AI calls keep failing (${detail}). Check your AI Settings and API key, then resume the ranking.`,
        },
      });
      return;
    }
    const now = new Date();
    await Promise.all(
      rows.map((row) => {
        const s = scores.get(row.id);
        return prisma.jobRankingRow.update({
          where: { id: row.id },
          data: s
            ? {
                score: s.score,
                bestResumeId: s.resumeId,
                bestResumeTitle: s.resumeTitle,
                reason: s.reason,
                scoreError: null,
                scoredAt: now,
              }
            : { scoreError: "The AI skipped this job.", scoredAt: now },
        });
      }),
    );
  }
}

async function runRanking(rankingId: string): Promise<void> {
  const ranking = await prisma.jobRanking.findUnique({
    where: { id: rankingId },
    select: { userId: true, status: true },
  });
  if (!ranking || ranking.status !== "running") return;

  let scorer: RankScorer;
  try {
    scorer = await prepareScorer(ranking.userId);
  } catch (error) {
    const message =
      error instanceof RankingSetupError
        ? error.message
        : "Couldn't start the AI. Check your AI Settings, then resume the ranking.";
    await prisma.jobRanking.update({
      where: { id: rankingId },
      data: { status: "paused", error: message },
    });
    return;
  }
  log.info("[Ranking] Worker started", { "ranking.id": rankingId });

  while (await stillRunning(rankingId)) {
    const loaded = await loadNext(rankingId);
    await scoreReady(rankingId, ranking.userId, scorer, loaded === 0);
    if (loaded === 0) {
      const left = await prisma.jobRankingRow.count({
        where: { rankingId, OR: [{ loadStatus: "pending" }, { scoredAt: null }] },
      });
      if (left === 0) {
        await prisma.jobRanking.updateMany({
          where: { id: rankingId, status: "running" },
          data: { status: "done", error: null },
        });
        log.info("[Ranking] Done", { "ranking.id": rankingId });
        return;
      }
    }
  }
}
