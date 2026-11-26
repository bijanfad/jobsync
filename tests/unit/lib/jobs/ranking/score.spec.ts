vi.mock("server-only", () => ({}));
vi.mock("ai", async (orig) => ({
  ...(await orig<typeof import("ai")>()),
  generateText: vi.fn(),
}));
vi.mock("@/lib/aiUsage/tracker", () => ({
  startAiCall: vi.fn(() => ({ finish: vi.fn() })),
}));
vi.mock("@/lib/ai/providers", () => ({ getModel: vi.fn() }));
vi.mock("@/lib/ai/tools/preprocessing", () => ({ preprocessResume: vi.fn() }));
vi.mock("@/lib/scraper/automation-run/aiSettings", () => ({
  getUserAiSettings: vi.fn().mockResolvedValue({ provider: "anthropic", model: "claude-haiku-5-5" }),
  getDefaultModelForProvider: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ default: { resume: { findMany: vi.fn() } } }));

import { generateText } from "ai";
import prisma from "@/lib/db";
import { getModel } from "@/lib/ai/providers";
import { preprocessResume } from "@/lib/ai/tools/preprocessing";
import { MissingCredentialError } from "@/lib/ai/tools/errors";
import { prepareScorer, RankingSetupError, scoreBatch, type RankRow } from "@/lib/jobs/ranking/score";

const scorer = {
  resumes: [
    { id: "cv-sec", title: "Security CV", text: "SIEM, firewalls" },
    { id: "cv-admin", title: "Admin CV", text: "Windows Server" },
  ],
  model: {} as any,
  provider: "anthropic",
  modelName: "claude-haiku-5-5",
};

const rankRow = (id: string, extra: Partial<RankRow> = {}): RankRow => ({
  id,
  title: `Title ${id}`,
  company: "ACME",
  location: "Köln",
  category: "IT-Administration",
  language: "Unbekannt",
  remote: null,
  experience: "3",
  skills: "Windows, Active Directory",
  degree: null,
  description: null,
  ...extra,
});

describe("scoreBatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps the model's numbers back to rows and CVs", async () => {
    (generateText as any).mockResolvedValue({
      output: {
        results: [
          { jobNumber: 2, resumeNumber: 1, score: 83.4, reason: " Strong SIEM fit. " },
          { jobNumber: 1, resumeNumber: 2, score: 140, reason: "Admin role." },
          { jobNumber: 1, resumeNumber: 1, score: 10, reason: "duplicate" },
          { jobNumber: 9, resumeNumber: 1, score: 50, reason: "no such job" },
        ],
      },
      usage: {},
      finishReason: "stop",
    });
    const rows = [rankRow("a"), rankRow("b", { description: "SOC analyst, SIEM" }), rankRow("c")];
    const scores = await scoreBatch("user-1", scorer, rows);
    expect(Object.fromEntries(scores)).toEqual({
      a: { score: 100, resumeId: "cv-admin", resumeTitle: "Admin CV", reason: "Admin role." },
      b: { score: 83, resumeId: "cv-sec", resumeTitle: "Security CV", reason: "Strong SIEM fit." },
    });

    const prompt: string = (generateText as any).mock.calls[0][0].prompt;
    expect(prompt).toContain("Resume 2: \"Admin CV\"");
    expect(prompt).toContain("Job 2: Title b");
    expect(prompt).toContain("Description:\nSOC analyst, SIEM");
    expect(prompt).toContain("Description: (not available)");
    // "Unbekannt" says nothing, so it isn't sent
    expect(prompt).not.toContain("Unbekannt");
  });

  it("throws when the AI call fails, so the worker can retry", async () => {
    (generateText as any).mockRejectedValue(new Error("overloaded"));
    await expect(scoreBatch("user-1", scorer, [rankRow("a")])).rejects.toThrow("overloaded");
  });
});

describe("prepareScorer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("explains a missing API key", async () => {
    (prisma as any).resume.findMany.mockResolvedValue([{ id: "cv-1", title: "CV" }]);
    (preprocessResume as any).mockResolvedValue({ success: true, data: { normalizedText: "text" } });
    (getModel as any).mockRejectedValue(new MissingCredentialError("anthropic"));
    await expect(prepareScorer("user-1")).rejects.toThrow(RankingSetupError);
  });

  it("needs at least one usable CV", async () => {
    (prisma as any).resume.findMany.mockResolvedValue([]);
    await expect(prepareScorer("user-1")).rejects.toThrow(/don't have any resumes/);
  });
});
