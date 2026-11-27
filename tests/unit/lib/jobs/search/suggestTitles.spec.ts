vi.mock("server-only", () => ({}));
vi.mock("ai", async (orig) => ({ ...(await orig<typeof import("ai")>()), generateText: vi.fn() }));
vi.mock("@/lib/aiUsage/tracker", () => ({ startAiCall: vi.fn(() => ({ finish: vi.fn() })) }));
vi.mock("@/lib/jobs/ranking/score", () => ({ prepareScorer: vi.fn() }));

import { generateText } from "ai";
import { prepareScorer } from "@/lib/jobs/ranking/score";
import { cleanSearchTitle, suggestTitlesFromCvs } from "@/lib/jobs/search/suggestTitles";

describe("suggestTitlesFromCvs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prepareScorer as any).mockResolvedValue({
      resumes: [
        { id: "cv-1", title: "Admin CV", text: "Windows Server, Active Directory" },
        { id: "cv-2", title: "Security CV", text: "ISO 27001, SIEM" },
      ],
      model: {},
      provider: "anthropic",
      modelName: "claude-haiku-5-5",
    });
  });

  it("reads every CV and returns clean, unique titles, main fits first", async () => {
    (generateText as any).mockResolvedValue({
      output: {
        titles: [
          { title: "IT Security Engineer", fit: "adjacent", why: "ISO 27001" },
          { title: "Systemadministrator (m/w/d)", fit: "core", why: "Windows Server" },
          { title: "System-Administrator", fit: "core", why: "same title with a hyphen" },
          { title: "systemadministrator", fit: "core", why: "duplicate" },
          { title: "IT-Administrator, Windows", fit: "core", why: "AD" },
          { title: "x", fit: "core", why: "too short" },
        ],
      },
      usage: {},
      finishReason: "stop",
    });
    const titles = await suggestTitlesFromCvs("user-1");
    expect(prepareScorer).toHaveBeenCalledWith("user-1", 6000);
    const prompt: string = (generateText as any).mock.calls[0][0].prompt;
    expect(prompt).toContain('Resume 1: "Admin CV"');
    expect(prompt).toContain('Resume 2: "Security CV"');
    expect(titles.map((t) => [t.title, t.fit])).toEqual([
      ["Systemadministrator", "core"],
      ["IT-Administrator Windows", "core"],
      ["IT Security Engineer", "adjacent"],
    ]);
  });

  it("cleans titles for a job search", () => {
    expect(cleanSearchTitle("  SOC Analyst (w/m/d) ")).toBe("SOC Analyst");
    expect(cleanSearchTitle('"Pentester" (all genders)')).toBe("Pentester");
  });
});
