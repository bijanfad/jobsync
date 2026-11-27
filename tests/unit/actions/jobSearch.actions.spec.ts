vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/actions/shared", () => ({ requireUser: vi.fn().mockResolvedValue({ id: "user-1" }) }));
vi.mock("@/lib/jobs/search/run", async (orig) => ({
  ...(await orig<typeof import("@/lib/jobs/search/run")>()),
  runJobSearch: vi.fn().mockResolvedValue(null),
  isSearchRunning: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/jobs/search/sources", () => ({ SEARCH_SOURCE_FNS: {} }));
vi.mock("@/lib/jobs/ranking/worker", () => ({ ensureRankingWorker: vi.fn() }));
vi.mock("@/lib/encryption", () => ({
  encrypt: vi.fn(() => ({ encrypted: "ENC", iv: "IV" })),
  decrypt: vi.fn(),
  getLast4: (s: string) => s.slice(-4),
}));
vi.mock("@/lib/db", () => ({
  default: {
    jobSearch: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    apiKey: { count: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  },
}));

import prisma from "@/lib/db";
import { runJobSearch } from "@/lib/jobs/search/run";
import { getJobSearches, runJobSearchNow, saveAdzunaKey, saveJobSearch } from "@/actions/jobSearch.actions";

const db = prisma as any;
const input = (extra: any = {}) => ({
  name: "IT admin",
  keywords: "IT-Administrator, , SOC",
  location: "Köln",
  radiusKm: 25,
  maxAgeDays: 7,
  sources: ["bundesagentur", "personio", "smartrecruiters"],
  companies: {
    personio: ["https://proact.jobs.personio.de/job/2529696", "acme"],
    smartrecruiters: ["https://jobs.smartrecruiters.com/BoschGroup/744000163844654", "not a slug!"],
    recruitee: ["ignored because recruitee isn't ticked"],
  },
  daily: true,
  ...extra,
});

describe("job search actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.jobSearch.count.mockResolvedValue(0);
    db.jobSearch.create.mockResolvedValue({ id: "s-1" });
  });

  it("saves a search, turning career links into company slugs", async () => {
    const res = await saveJobSearch(input() as any);
    expect(res).toEqual({ success: true, data: { id: "s-1", ignoredCompanies: ["not a slug!"] } });
    const data = db.jobSearch.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      userId: "user-1",
      keywords: "IT-Administrator\nSOC",
      sources: JSON.stringify(["bundesagentur", "personio", "smartrecruiters"]),
    });
    expect(JSON.parse(data.companies)).toEqual({ personio: ["proact", "acme"], smartrecruiters: ["BoschGroup"] });
  });

  it("rejects a search without keywords, sites or companies", async () => {
    expect((await saveJobSearch(input({ keywords: " , " }) as any)).success).toBe(false);
    expect((await saveJobSearch(input({ sources: [] }) as any)).success).toBe(false);
    expect(
      (await saveJobSearch(input({ sources: ["recruitee"], companies: { recruitee: [] } }) as any)).success,
    ).toBe(false);
    expect(db.jobSearch.create).not.toHaveBeenCalled();
  });

  it("edits only the user's own search", async () => {
    db.jobSearch.updateMany.mockResolvedValue({ count: 0 });
    const res = await saveJobSearch(input() as any, "s-other");
    expect(res.success).toBe(false);
    expect(db.jobSearch.updateMany.mock.calls[0][0].where).toEqual({ id: "s-other", userId: "user-1" });
  });

  it("runs the user's own search in the background", async () => {
    db.jobSearch.findFirst.mockResolvedValue(null);
    expect((await runJobSearchNow("s-x")).success).toBe(false);
    db.jobSearch.findFirst.mockResolvedValue({ id: "s-1" });
    expect((await runJobSearchNow("s-1")).success).toBe(true);
    expect(runJobSearch).toHaveBeenCalledWith("s-1");
  });

  it("stores the Adzuna key encrypted", async () => {
    expect((await saveAdzunaKey("bad id!", "x")).success).toBe(false);
    expect((await saveAdzunaKey("abcd1234", "0123456789abcdef")).success).toBe(true);
    expect(db.apiKey.upsert.mock.calls[0][0]).toMatchObject({
      where: { userId_provider: { userId: "user-1", provider: "adzuna" } },
      create: { encryptedKey: "ENC", iv: "IV", last4: "cdef" },
    });
  });

  it("lists searches with their last run", async () => {
    db.jobSearch.findMany.mockResolvedValue([
      {
        id: "s-1", name: "IT admin", keywords: "IT-Administrator", location: null, radiusKm: 25, maxAgeDays: 7,
        sources: '["bundesagentur","bogus"]', companies: "{}", daily: true, rankingId: "rk-1", status: "idle",
        lastRunAt: null, lastRun: '{"at":"2026-11-26T10:00:00Z","added":4,"sources":{"bundesagentur":{"found":4,"added":4}}}',
      },
    ]);
    db.apiKey.count.mockResolvedValue(1);
    const res = await getJobSearches();
    expect(res.success && res.data?.hasAdzunaKey).toBe(true);
    expect(res.success && res.data?.searches[0]).toMatchObject({ sources: ["bundesagentur"], lastRun: { added: 4 } });
    expect(db.jobSearch.findMany.mock.calls[0][0].where).toEqual({ userId: "user-1" });
  });
});
