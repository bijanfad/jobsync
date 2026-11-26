vi.mock("server-only", () => ({}));
vi.mock("@/lib/telemetry", () => ({ log: { info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/jobs/ranking/loadPosting", () => ({ loadPosting: vi.fn() }));
vi.mock("@/lib/jobs/ranking/score", async (orig) => ({
  ...(await orig<typeof import("@/lib/jobs/ranking/score")>()),
  prepareScorer: vi.fn(),
  scoreBatch: vi.fn(),
}));

// A tiny in-memory stand-in for the two ranking tables.
const h = vi.hoisted(() => ({
  ranking: { id: "rk-1", userId: "user-1", status: "running", error: null as string | null },
  rows: [] as any[],
}));
vi.mock("@/lib/db", () => {
  const match = (row: any, where: any) =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (k === "rankingId") return true;
      if (k === "OR") return v.some((w: any) => match(row, w));
      if (v && typeof v === "object" && "not" in v) return row[k] !== v.not;
      return row[k] === v;
    });
  return {
    default: {
      jobRanking: {
        findUnique: vi.fn(async () => ({ ...h.ranking })),
        findMany: vi.fn(async () => (h.ranking.status === "running" ? [{ id: h.ranking.id }] : [])),
        update: vi.fn(async ({ data }: any) => Object.assign(h.ranking, data)),
        updateMany: vi.fn(async ({ where, data }: any) => {
          if (where.status && where.status !== h.ranking.status) return { count: 0 };
          Object.assign(h.ranking, data);
          return { count: 1 };
        }),
      },
      jobRankingRow: {
        findMany: vi.fn(async ({ where, take }: any) =>
          h.rows.filter((r) => match(r, where)).slice(0, take).map((r) => ({ ...r })),
        ),
        update: vi.fn(async ({ where, data }: any) => Object.assign(h.rows.find((r) => r.id === where.id), data)),
        count: vi.fn(async ({ where }: any) => h.rows.filter((r) => match(r, where)).length),
      },
    },
  };
});

import { loadPosting } from "@/lib/jobs/ranking/loadPosting";
import { prepareScorer, RankingSetupError, scoreBatch } from "@/lib/jobs/ranking/score";
import { ensureRankingWorker, isRankingWorkerRunning } from "@/lib/jobs/ranking/worker";

const row = (i: number, url: string | null = `https://jobs.example${i % 3}.de/job/${i}`) => ({
  id: `row-${i}`,
  position: i,
  title: `Job ${i}`,
  url,
  loadStatus: "pending",
  scoredAt: null,
  score: null,
});

async function finish() {
  for (let i = 0; i < 200 && isRankingWorkerRunning("rk-1"); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("ranking worker", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(h.ranking, { status: "running", error: null });
    h.rows = Array.from({ length: 30 }, (_, i) => row(i));
    h.rows[3].url = null;
    (prepareScorer as any).mockResolvedValue({
      resumes: [{ id: "cv-1", title: "Security CV", text: "x" }],
      model: {},
      provider: "anthropic",
      modelName: "claude-haiku-5-5",
    });
    (loadPosting as any).mockImplementation(async (url: string) =>
      url.endsWith("/7")
        ? { status: "failed", error: "The job site blocked automatic reading of this page." }
        : { status: "loaded", description: `About ${url}`, finalUrl: url },
    );
    (scoreBatch as any).mockImplementation(async (_u: string, _s: unknown, rows: any[]) =>
      new Map(rows.map((r: any) => [r.id, { score: 50 + r.position, resumeId: "cv-1", resumeTitle: "Security CV", reason: "ok" }])),
    );
  });

  it("loads every link, scores every row in batches, and finishes", async () => {
    ensureRankingWorker("rk-1");
    await finish();
    expect(h.ranking.status).toBe("done");
    expect(loadPosting).toHaveBeenCalledTimes(29); // row 3 has no link
    expect(h.rows[3]).toMatchObject({ loadStatus: "skipped" });
    expect(h.rows[7]).toMatchObject({ loadStatus: "failed", loadError: expect.stringMatching(/blocked/) });
    expect(h.rows.every((r) => r.score === 50 + r.position && r.scoredAt)).toBe(true);
    // 30 rows in batches of 10
    expect(scoreBatch).toHaveBeenCalledTimes(3);
    expect(Math.max(...(scoreBatch as any).mock.calls.map((c: any) => c[2].length))).toBeLessThanOrEqual(10);
  });

  it("pauses with the reason when the CVs or AI aren't ready", async () => {
    (prepareScorer as any).mockRejectedValue(new RankingSetupError("Add your Anthropic key"));
    ensureRankingWorker("rk-1");
    await finish();
    expect(h.ranking).toMatchObject({ status: "paused", error: "Add your Anthropic key" });
    expect(loadPosting).not.toHaveBeenCalled();
  });

  it("pauses, leaving rows unscored, when the AI keeps failing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    (scoreBatch as any).mockRejectedValue(new Error("overloaded"));
    ensureRankingWorker("rk-1");
    await vi.runAllTimersAsync();
    await finish();
    vi.useRealTimers();
    expect(h.ranking.status).toBe("paused");
    expect(h.ranking.error).toMatch(/overloaded/);
    expect(h.rows.every((r) => r.scoredAt === null)).toBe(true);
  });

  it("stops when the user pauses it", async () => {
    // Each clock read is two seconds later, so the worker re-checks the status before every page.
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 2_000));
    (loadPosting as any).mockImplementation(async (url: string) => {
      h.ranking.status = "paused";
      return { status: "loaded", description: "d", finalUrl: url };
    });
    ensureRankingWorker("rk-1");
    await finish();
    expect(h.ranking.status).toBe("paused");
    expect(scoreBatch).not.toHaveBeenCalled();
    expect(h.rows.some((r) => r.loadStatus === "pending")).toBe(true);
  });
});
