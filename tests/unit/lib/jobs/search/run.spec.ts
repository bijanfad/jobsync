vi.mock("server-only", () => ({}));
vi.mock("@/lib/telemetry", () => ({ log: { info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/jobs/ranking/worker", () => ({ ensureRankingWorker: vi.fn() }));
vi.mock("@/lib/jobs/search/sources", () => ({ SEARCH_SOURCE_FNS: {} }));
vi.mock("@/lib/encryption", () => ({ decrypt: vi.fn(() => "abcd1234:secretkey123") }));

const h = vi.hoisted(() => ({
  search: null as any,
  rankings: [] as any[],
  rows: [] as any[],
}));
vi.mock("@/lib/db", () => ({
  default: {
    jobSearch: {
      findUnique: vi.fn(async () => (h.search ? { ...h.search } : null)),
      findMany: vi.fn(async () => (h.search ? [{ id: h.search.id }] : [])),
      update: vi.fn(async ({ data }: any) => Object.assign(h.search, data)),
    },
    jobRanking: {
      findFirst: vi.fn(async ({ where }: any) => h.rankings.find((r) => r.id === where.id && r.userId === where.userId) ?? null),
      create: vi.fn(async ({ data }: any) => {
        const r = { id: `rk-${h.rankings.length + 1}`, ...data };
        h.rankings.push(r);
        return { id: r.id };
      }),
      update: vi.fn(async ({ where, data }: any) => Object.assign(h.rankings.find((r) => r.id === where.id), data)),
    },
    jobRankingRow: {
      findMany: vi.fn(async ({ where }: any) => h.rows.filter((r) => r.rankingId === where.rankingId)),
      createMany: vi.fn(async ({ data }: any) => {
        h.rows.push(...data);
        return { count: data.length };
      }),
    },
    apiKey: { findUnique: vi.fn(async () => ({ encryptedKey: "x", iv: "y" })) },
  },
}));

import { ensureRankingWorker } from "@/lib/jobs/ranking/worker";
import { runJobSearch } from "@/lib/jobs/search/run";

const LONG = "Aufgaben: Windows Server, Active Directory, Netzwerke und Support. ".repeat(5);

describe("runJobSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.rankings = [];
    h.rows = [];
    h.search = {
      id: "s-1",
      userId: "user-1",
      name: "IT admin Köln",
      keywords: "IT-Administrator, SOC",
      location: "Köln",
      radiusKm: 25,
      maxAgeDays: 7,
      sources: JSON.stringify(["bundesagentur", "arbeitnow", "recruitee", "adzuna"]),
      companies: JSON.stringify({ recruitee: ["mlr"] }),
      daily: true,
      rankingId: null,
      status: "idle",
    };
  });

  const sources = () => ({
    bundesagentur: vi.fn(async () => [
      { title: "IT-Administrator (m/w/d)", company: "ACME GmbH", location: "Köln", url: "https://www.arbeitsagentur.de/jobsuche/jobdetail/1-S" },
      { title: "SOC Analyst", company: "Beta", location: "Köln", url: "https://www.arbeitsagentur.de/jobsuche/jobdetail/2-S" },
    ]),
    // The same ACME job again (other site, same title and company), plus a new one with its description
    arbeitnow: vi.fn(async () => [
      { title: "IT-Administrator (w/m/d)", company: "ACME GmbH", location: "Köln", url: "https://www.arbeitnow.com/jobs/acme" },
      { title: "IT-Administrator Linux", company: "Gamma", location: "Köln", url: "https://www.arbeitnow.com/jobs/gamma?utm_source=x", description: LONG },
    ]),
    recruitee: vi.fn(async () => {
      throw new Error("Not found (404). Check the company name.");
    }),
    adzuna: vi.fn(async (_q: any, ctx: any) => {
      expect(ctx.adzuna).toEqual({ appId: "abcd1234", appKey: "secretkey123" });
      return [];
    }),
  });

  it("adds new jobs to the search's own ranking and starts scoring", async () => {
    const fns = sources();
    const summary = await runJobSearch("s-1", { sources: fns as any, now: new Date("2026-11-26T12:00:00Z") });

    expect(fns.bundesagentur).toHaveBeenCalledWith(
      { keywords: ["IT-Administrator", "SOC"], location: "Köln", radiusKm: 25, maxAgeDays: 7 },
      expect.objectContaining({ companies: [] }),
    );
    expect((fns.recruitee as any).mock.calls[0][1].companies).toEqual(["mlr"]);
    expect(h.rankings).toEqual([
      expect.objectContaining({ id: "rk-1", userId: "user-1", name: "Find jobs: IT admin Köln", status: "running", total: 3 }),
    ]);
    expect(h.search).toMatchObject({ rankingId: "rk-1", status: "idle", lastRunAt: expect.any(Date) });
    expect(h.rows.map((r) => [r.title, r.source, r.loadStatus, r.position])).toEqual([
      ["IT-Administrator (m/w/d)", "Bundesagentur für Arbeit", "pending", 0],
      ["SOC Analyst", "Bundesagentur für Arbeit", "pending", 1],
      ["IT-Administrator Linux", "arbeitnow", "loaded", 2],
    ]);
    expect(summary).toMatchObject({
      added: 3,
      sources: {
        bundesagentur: { found: 2, added: 2 },
        arbeitnow: { found: 2, added: 1 },
        recruitee: { found: 0, added: 0, error: "Not found (404). Check the company name." },
        adzuna: { found: 0, added: 0 },
      },
    });
    expect(JSON.parse(h.search.lastRun).added).toBe(3);
    expect(ensureRankingWorker).toHaveBeenCalledWith("rk-1");
  });

  it("skips jobs found on an earlier run", async () => {
    await runJobSearch("s-1", { sources: sources() as any });
    vi.clearAllMocks();
    const again = await runJobSearch("s-1", { sources: sources() as any });
    expect(again?.added).toBe(0);
    expect(h.rows).toHaveLength(3);
    expect(h.rankings).toHaveLength(1);
    expect(ensureRankingWorker).not.toHaveBeenCalled();
  });

  it("starts a fresh ranking when the old one was deleted", async () => {
    h.search.rankingId = "rk-deleted";
    await runJobSearch("s-1", { sources: sources() as any });
    expect(h.search.rankingId).toBe("rk-1");
  });
});
