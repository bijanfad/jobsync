vi.mock("server-only", () => ({}));
vi.mock("@/actions/shared", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "user-1" }),
}));
vi.mock("@/lib/ai/rate-limiter", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 9, resetIn: 0 }),
}));
vi.mock("@/lib/scraper/automation-run/aiSettings", () => ({
  getUserAiSettings: vi.fn().mockResolvedValue({ provider: "anthropic", model: "claude-haiku-5-5" }),
  getDefaultModelForProvider: vi.fn(),
}));
vi.mock("@/lib/ai/providers", () => ({ getModel: vi.fn() }));
vi.mock("ai", async (orig) => ({
  ...(await orig<typeof import("ai")>()),
  generateText: vi.fn(),
}));
vi.mock("@/lib/aiUsage/tracker", () => ({
  startAiCall: vi.fn(() => ({ finish: vi.fn(), markFirstToken: vi.fn() })),
}));
vi.mock("@/lib/ai/tools/preprocessing-job", () => ({ preprocessJob: vi.fn() }));
vi.mock("@/lib/ai/tools/preprocessing", () => ({ preprocessResume: vi.fn() }));
vi.mock("@/lib/db", () => ({
  default: {
    job: { findFirst: vi.fn() },
    resume: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

import { generateText } from "ai";
import prisma from "@/lib/db";
import { compareResumesForJob } from "@/actions/job/compareResumes";
import { preprocessJob } from "@/lib/ai/tools/preprocessing-job";
import { preprocessResume } from "@/lib/ai/tools/preprocessing";
import { getModel } from "@/lib/ai/providers";
import { MissingCredentialError } from "@/lib/ai/tools/errors";

const db = prisma as any;
const resumes = [
  { id: "r-sec", title: "Security CV" },
  { id: "r-dev", title: "Developer CV" },
  { id: "r-empty", title: "Empty draft" },
];

describe("compareResumesForJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.job.findFirst.mockResolvedValue({ id: "job-1", resumeId: "r-dev" });
    db.resume.findMany.mockResolvedValue(resumes);
    db.user.findUnique.mockResolvedValue({ defaultResumeId: "r-sec" });
    (preprocessJob as any).mockResolvedValue({
      success: true,
      data: { normalizedText: "IT Consultant Security: Firewalls, SIEM" },
    });
    (preprocessResume as any).mockImplementation(async (r: any) =>
      r.id === "r-empty"
        ? { success: false, error: { code: "TOO_SHORT", message: "short" } }
        : { success: true, data: { normalizedText: `${r.title} text` } },
    );
    (getModel as any).mockResolvedValue({});
    (generateText as any).mockResolvedValue({
      output: {
        results: [
          { resumeNumber: 2, score: 48, verdict: "Developer focus.", strengths: ["Python"], gaps: ["SIEM", "Firewalls"] },
          { resumeNumber: 1, score: 81.6, verdict: "Strong security fit.", strengths: ["SIEM", "Firewalls", "ISO 27001", "extra"], gaps: [] },
        ],
      },
      usage: {},
      finishReason: "stop",
    });
  });

  it("ranks every usable CV, best first, and flags default and job CVs", async () => {
    const result = await compareResumesForJob("job-1");
    expect(result.success).toBe(true);
    const { results, skipped } = (result as any).data;
    expect(results.map((r: any) => [r.title, r.score])).toEqual([
      ["Security CV", 82],
      ["Developer CV", 48],
    ]);
    expect(results[0]).toMatchObject({ isDefault: true, isJobResume: false });
    expect(results[1]).toMatchObject({ isDefault: false, isJobResume: true });
    expect(results[0].strengths).toHaveLength(3);
    expect(skipped).toEqual(["Empty draft"]);
  });

  it("only reads the caller's own job and resumes", async () => {
    await compareResumesForJob("job-1");
    expect(db.job.findFirst.mock.calls[0][0].where).toEqual({ id: "job-1", userId: "user-1" });
    expect(db.resume.findMany.mock.calls[0][0].where).toEqual({ profile: { userId: "user-1" } });
  });

  it("sends each CV to the AI once, numbered, inside delimiters", async () => {
    await compareResumesForJob("job-1");
    const { prompt } = (generateText as any).mock.calls[0][0];
    expect(prompt).toContain('Resume 1: "Security CV"');
    expect(prompt).toContain('Resume 2: "Developer CV"');
    expect(prompt).not.toContain("Empty draft");
  });

  it("returns not found for someone else's job", async () => {
    db.job.findFirst.mockResolvedValue(null);
    expect(await compareResumesForJob("job-x")).toEqual({ success: false, message: "Job not found." });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("asks for a description when the job has none", async () => {
    (preprocessJob as any).mockResolvedValue({ success: false, error: { code: "TOO_SHORT", message: "" } });
    const result = await compareResumesForJob("job-1");
    expect((result as any).message).toContain("description is too short");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("explains when there are no resumes", async () => {
    db.resume.findMany.mockResolvedValue([]);
    expect((await compareResumesForJob("job-1") as any).message).toContain("don't have any resumes");
  });

  it("points to API Keys when the provider has no key", async () => {
    (getModel as any).mockRejectedValue(new MissingCredentialError("Anthropic (Claude)"));
    expect((await compareResumesForJob("job-1") as any).message).toContain("Anthropic (Claude) key");
  });

  it("reports an AI failure", async () => {
    (generateText as any).mockRejectedValue(new Error("overloaded"));
    expect((await compareResumesForJob("job-1") as any).message).toContain("couldn't compare");
  });

  it("lists a CV the AI left out as not compared", async () => {
    (generateText as any).mockResolvedValue({
      output: { results: [{ resumeNumber: 1, score: 70, verdict: "", strengths: [], gaps: [] }] },
    });
    const { results, skipped } = (await compareResumesForJob("job-1") as any).data;
    expect(results).toHaveLength(1);
    expect(skipped).toEqual(["Empty draft", "Developer CV"]);
  });
});
