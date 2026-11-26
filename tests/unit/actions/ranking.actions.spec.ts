vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/actions/shared", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "user-1" }),
}));
vi.mock("@/lib/jobs/ranking/worker", () => ({
  ensureRankingWorker: vi.fn(),
  isRankingWorkerRunning: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/jobs/createJobFromNames", () => ({ createJobFromNames: vi.fn() }));
vi.mock("@/lib/db", () => ({
  default: {
    jobRanking: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    jobRankingRow: {
      createMany: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
      updateMany: vi.fn(),
    },
    job: { updateMany: vi.fn() },
  },
}));

import prisma from "@/lib/db";
import { createJobFromNames } from "@/lib/jobs/createJobFromNames";
import { ensureRankingWorker } from "@/lib/jobs/ranking/worker";
import {
  addRankedJobsToMyJobs,
  addRankingRows,
  createRanking,
  getRanking,
  startRanking,
} from "@/actions/ranking.actions";

const db = prisma as any;

describe("ranking actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.jobRankingRow.groupBy.mockResolvedValue([]);
  });

  it("creates a ranking for the signed-in user and rejects impossible sizes", async () => {
    db.jobRanking.create.mockResolvedValue({ id: "rk-1" });
    expect(await createRanking("export.csv", 5000)).toEqual({ success: true, data: { id: "rk-1" } });
    expect(db.jobRanking.create.mock.calls[0][0].data).toMatchObject({ userId: "user-1", total: 5000 });
    expect((await createRanking("x", 0)).success).toBe(false);
    expect((await createRanking("x", 10_001)).success).toBe(false);
  });

  it("adds rows only to the user's own upload, cleaning each row", async () => {
    db.jobRanking.findFirst.mockResolvedValue({ id: "rk-1", status: "uploading", total: 3 });
    db.jobRankingRow.createMany.mockImplementation(async ({ data }: any) => ({ count: data.length }));
    const res = await addRankingRows("rk-1", 1, [
      { title: "  Admin ", url: "https://a.de/1", company: "" },
      { title: "" },
    ]);
    expect(db.jobRanking.findFirst.mock.calls[0][0].where).toEqual({ id: "rk-1", userId: "user-1" });
    expect(res).toEqual({ success: true, data: { added: 1 } });
    expect(db.jobRankingRow.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ title: "Admin", url: "https://a.de/1", company: undefined, rankingId: "rk-1", position: 1 }),
    ]);
  });

  it("refuses rows for someone else's or a finished upload", async () => {
    db.jobRanking.findFirst.mockResolvedValue(null);
    expect((await addRankingRows("rk-x", 0, [{ title: "A" }])).success).toBe(false);
    db.jobRanking.findFirst.mockResolvedValue({ id: "rk-1", status: "running", total: 3 });
    expect((await addRankingRows("rk-1", 0, [{ title: "A" }])).success).toBe(false);
    expect(db.jobRankingRow.createMany).not.toHaveBeenCalled();
  });

  it("starts the worker", async () => {
    db.jobRanking.findFirst.mockResolvedValue({ id: "rk-1", status: "uploading", total: 3 });
    db.jobRankingRow.count.mockResolvedValue(3);
    expect((await startRanking("rk-1")).success).toBe(true);
    expect(db.jobRanking.updateMany).toHaveBeenLastCalledWith({
      where: { id: "rk-1", userId: "user-1" },
      data: { status: "running", error: null },
    });
    expect(ensureRankingWorker).toHaveBeenCalledWith("rk-1");
  });

  it("lists rows best first, scoped to the owner, and revives a stopped worker", async () => {
    db.jobRanking.findFirst.mockResolvedValue({
      id: "rk-1", name: "Export", status: "running", error: null, total: 2, createdAt: new Date(),
    });
    db.jobRankingRow.findMany.mockResolvedValue([]);
    db.jobRankingRow.count.mockResolvedValue(0);
    const res = await getRanking("rk-1", 2, { minScore: 65, search: "admin" });
    expect(res.success).toBe(true);
    const args = db.jobRankingRow.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ rankingId: "rk-1", ranking: { userId: "user-1" } });
    expect(args.where.AND[0]).toMatchObject({ score: { gte: 65 } });
    expect(args.orderBy[0]).toEqual({ score: { sort: "desc", nulls: "last" } });
    expect(args.skip).toBe(50);
    expect(ensureRankingWorker).toHaveBeenCalledWith("rk-1");
  });

  it("adds ranked rows to My Jobs with the loaded description and best CV", async () => {
    const scoredAt = new Date("2026-11-26T10:00:00Z");
    db.jobRankingRow.findMany.mockResolvedValue([
      {
        id: "row-1", title: "IT-Administrator", company: "ACME", location: "Köln",
        url: "https://www.arbeitsagentur.de/jobsuche/jobdetail/1-S", finalUrl: "https://jobs.acme.de/42",
        description: "Full posting text", score: 77, bestResumeTitle: "Admin CV", scoredAt,
      },
      {
        id: "row-2", title: "SOC Analyst", company: null, location: null, url: "https://germantechjobs.de/jobs/x",
        finalUrl: null, description: null, skills: "SIEM", score: null, bestResumeTitle: null, scoredAt: null,
      },
    ]);
    (createJobFromNames as any)
      .mockResolvedValueOnce({ created: true, jobId: "job-1" })
      .mockResolvedValueOnce({ created: false, duplicateOf: { id: "job-9" } });

    const res = await addRankedJobsToMyJobs(["row-1", "row-2", "row-1"]);
    expect(res).toEqual({ success: true, data: { added: 1, duplicates: 1 } });
    expect(db.jobRankingRow.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ["row-1", "row-2"] }, jobId: null, ranking: { userId: "user-1" },
    });
    expect((createJobFromNames as any).mock.calls[0]).toEqual([
      expect.objectContaining({ jobTitle: "IT-Administrator", jobDescription: "Full posting text", jobUrl: "https://jobs.acme.de/42" }),
      "user-1",
    ]);
    const second = (createJobFromNames as any).mock.calls[1][0];
    expect(second.company).toBe("Unknown company");
    expect(second.jobDescription).toMatch(/couldn't be read automatically/);
    expect(second.jobDescription).toContain("SIEM");
    expect(db.job.updateMany).toHaveBeenCalledWith({
      where: { id: "job-1", userId: "user-1" },
      data: { bestResumeScore: 77, bestResumeTitle: "Admin CV", resumeComparedAt: scoredAt },
    });
    expect(db.jobRankingRow.updateMany).toHaveBeenCalledWith({
      where: { id: "row-2", ranking: { userId: "user-1" } }, data: { jobId: "job-9" },
    });
  });
});
