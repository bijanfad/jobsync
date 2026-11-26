vi.mock("server-only", () => ({}));
vi.mock("@/actions/shared", () => ({
  requireUser: vi.fn().mockResolvedValue({ id: "user-1" }),
}));
vi.mock("@/lib/ai/rate-limiter", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 9, resetIn: 0 }),
}));
vi.mock("@/lib/jobs/import/fetchJobPage", async (orig) => ({
  ...(await orig<typeof import("@/lib/jobs/import/fetchJobPage")>()),
  fetchJobPage: vi.fn(),
}));
vi.mock("@/lib/scraper/automation-run/aiSettings", () => ({
  getUserAiSettings: vi.fn().mockResolvedValue({ provider: "anthropic", model: "claude-sonnet-5-5" }),
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
vi.mock("@/lib/jobs/resolve", () => ({
  resolveJobTitle: vi.fn(async (label: string) => ({ id: "title-1", label, created: true })),
  resolveCompany: vi.fn(async (label: string) => ({ id: "company-1", label, created: false })),
  resolveLocation: vi.fn(async (label: string) => ({ id: "loc-1", label, created: true })),
  resolveJobSource: vi.fn(async (label: string) => ({ id: "src-1", label, created: false })),
  resolveTag: vi.fn(async (label: string) => ({
    id: `tag-${label}`,
    label,
    value: label.toLowerCase(),
    createdBy: "user-1",
    created: true,
  })),
}));
vi.mock("@/lib/db", () => {
  const row = (where: { id: string; createdBy: string }) =>
    where.createdBy !== "user-1" ? Promise.resolve(null) :
    Promise.resolve({ id: where.id, label: `label-${where.id}`, value: `value-${where.id}` });
  const table = { findFirst: vi.fn(({ where }) => row(where)) };
  return {
    default: { jobTitle: table, company: table, location: table, jobSource: table },
  };
});

import { generateText } from "ai";
import { importJobFromText, importJobFromUrl } from "@/actions/job/importFromUrl";
import { fetchJobPage, JobPageFetchError } from "@/lib/jobs/import/fetchJobPage";
import { getModel } from "@/lib/ai/providers";
import { MissingCredentialError } from "@/lib/ai/tools/errors";
import { resolveCompany, resolveJobSource, resolveJobTitle } from "@/lib/jobs/resolve";

const PAGE = `<html><body>${"<p>Build data pipelines with Python and SAP.</p>".repeat(20)}</body></html>`;

const aiOutput = {
  isJobPosting: true,
  jobTitle: "Data Engineer",
  company: "thyssenkrupp",
  location: "Essen, Germany",
  salaryRange: "",
  workplaceType: "Hybrid",
  jobType: "Full-time",
  skills: ["Python", "SAP", "Python"],
  description: "## Your tasks\n\n- Build pipelines",
};

describe("importJobFromUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fetchJobPage as any).mockResolvedValue({
      finalUrl: "https://jobs.thyssenkrupp.com/en/job/1",
      html: PAGE,
    });
    (getModel as any).mockResolvedValue({});
    (generateText as any).mockResolvedValue({
      output: aiOutput,
      usage: {},
      finishReason: "stop",
    });
  });

  it("fills every field the posting provides", async () => {
    const result = await importJobFromUrl("https://jobs.thyssenkrupp.com/en/job/1");
    expect(result.success).toBe(true);
    const data = (result as any).data;
    expect(data.title.id).toBe("title-1");
    expect(data.company.id).toBe("company-1");
    expect(data.location.id).toBe("loc-1");
    expect(data.source.id).toBe("src-1");
    expect(data.workplaceType).toBe("HYBRID");
    expect(data.jobType).toBe("FT");
    expect(data.salaryRange).toBeUndefined();
    expect(data.tags.map((t: any) => t.label)).toEqual(["Python", "SAP"]);
    expect(data.description).toContain("<h2>Your tasks</h2>");
    expect(data.description).toContain("<li>Build pipelines</li>");
    expect(data.filled).not.toContain("salary");
    expect(data.descriptionTooShort).toBe(true);
  });

  it("fills a German posting, preferring the page's own description", async () => {
    const items = Array.from(
      { length: 12 },
      (_, i) => `<li>Aufgabe ${i + 1}: Beratung unserer Kunden zu IT-Sicherheit</li>`,
    ).join("");
    (fetchJobPage as any).mockResolvedValue({
      finalUrl: "https://jobs.bechtle.com/job/Neckarsulm-IT-Consultant-Security-%28wmd%29-74172/78743-de_DE/",
      html: `<h1>IT Consultant Security (wmd)</h1><span itemprop="description"><h2>Ihre Aufgaben</h2><ul>${items}</ul></span>`,
    });
    (generateText as any).mockResolvedValue({
      output: {
        ...aiOutput,
        jobTitle: "IT Consultant Security (wmd)",
        company: "Bechtle",
        location: "Neckarsulm, Deutschland",
        workplaceType: "Homeoffice",
        jobType: "Vollzeit",
        description: "## Ihre Aufgaben\n- Beratung",
      },
    });
    const result = await importJobFromUrl(
      "https://jobs.bechtle.com/job/Neckarsulm-IT-Consultant-Security-%28wmd%29-74172/78743-de_DE/",
    );
    const data = (result as any).data;
    expect(resolveJobTitle).toHaveBeenCalledWith("IT Consultant Security", "user-1");
    expect(data.workplaceType).toBe("REMOTE");
    expect(data.jobType).toBe("FT");
    expect(data.description).toContain("Aufgabe 12: Beratung");
    expect(data.descriptionTooShort).toBe(false);
  });

  it("leaves out fields the posting doesn't state", async () => {
    (generateText as any).mockResolvedValue({
      output: { ...aiOutput, company: "", location: "", skills: [], workplaceType: "" },
    });
    const result = await importJobFromUrl("https://jobs.example.com/1");
    const data = (result as any).data;
    expect(data.company).toBeUndefined();
    expect(data.location).toBeUndefined();
    expect(data.workplaceType).toBeUndefined();
    expect(data.tags).toEqual([]);
    expect(resolveCompany).not.toHaveBeenCalled();
  });

  it("escapes raw HTML the model echoes into the description", async () => {
    (generateText as any).mockResolvedValue({
      output: { ...aiOutput, description: "<script>alert(1)</script>" },
    });
    const result = await importJobFromUrl("https://jobs.example.com/1");
    expect((result as any).data.description).not.toContain("<script>");
  });

  it("refuses a page that isn't a single posting", async () => {
    (generateText as any).mockResolvedValue({ output: { ...aiOutput, isJobPosting: false } });
    const result = await importJobFromUrl("https://jobs.thyssenkrupp.com/en");
    expect(result).toEqual({
      success: false,
      message: expect.stringContaining("doesn't look like a single job posting"),
    });
  });

  it("reports a page fetch failure without calling the AI", async () => {
    (fetchJobPage as any).mockRejectedValue(
      new JobPageFetchError("The job site blocked automatic reading of this page."),
    );
    const result = await importJobFromUrl("https://www.linkedin.com/jobs/view/1");
    expect(result).toEqual({
      success: false,
      message: "The job site blocked automatic reading of this page.",
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("explains a JavaScript-only page", async () => {
    (fetchJobPage as any).mockResolvedValue({
      finalUrl: "https://x.example.com",
      html: '<div id="root"></div>',
    });
    const result = await importJobFromUrl("https://x.example.com");
    expect((result as any).message).toContain("JavaScript");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("points to API Keys when the provider has no key", async () => {
    (getModel as any).mockRejectedValue(new MissingCredentialError("Anthropic (Claude)"));
    const result = await importJobFromUrl("https://jobs.example.com/1");
    expect((result as any).message).toContain("Anthropic (Claude) key");
  });

  it("reports an AI failure", async () => {
    (generateText as any).mockRejectedValue(new Error("overloaded"));
    const result = await importJobFromUrl("https://jobs.example.com/1");
    expect((result as any).message).toContain("couldn't read this posting");
  });
});

describe("importJobFromText", () => {
  const PASTED = [
    "Bechtle – Karriere | Jobs | Login",
    "IT Consultant Security (w/m/d)",
    "Neckarsulm · Vollzeit",
    "Ihre Aufgaben",
    ...Array.from({ length: 10 }, (_, i) => `• Aufgabe ${i + 1}: Beratung unserer Kunden zu IT-Sicherheit`),
    "Impressum · Datenschutz",
  ].join("\n");

  beforeEach(() => {
    vi.clearAllMocks();
    (getModel as any).mockResolvedValue({});
  });

  it("fills the form from pasted text without fetching anything", async () => {
    const cleaned =
      "## Ihre Aufgaben\n\n" +
      Array.from({ length: 10 }, (_, i) => `- Aufgabe ${i + 1}: Beratung unserer Kunden zu IT-Sicherheit`).join("\n");
    (generateText as any).mockResolvedValue({
      output: {
        ...aiOutput,
        jobTitle: "IT Consultant Security (w/m/d)",
        company: "Bechtle",
        jobType: "Vollzeit",
        description: cleaned,
      },
    });
    const result = await importJobFromText(PASTED);
    const data = (result as any).data;
    expect(fetchJobPage).not.toHaveBeenCalled();
    expect(resolveJobTitle).toHaveBeenCalledWith("IT Consultant Security", "user-1");
    expect(data.jobType).toBe("FT");
    // The model's cleaned copy wins over the raw paste with its menus
    expect(data.description).toContain("<h2>Ihre Aufgaben</h2>");
    expect(data.description).not.toContain("Impressum");
    expect(data.descriptionTooShort).toBe(false);
    // No link: the source is left for the user
    expect(data.source).toBeUndefined();
    expect(resolveJobSource).not.toHaveBeenCalled();
    const prompt = (generateText as any).mock.calls[0][0].prompt as string;
    expect(prompt).toContain("text the user copied");
    expect(prompt).toContain("Aufgabe 10");
  });

  it("falls back to the pasted text when the model cuts the description", async () => {
    (generateText as any).mockResolvedValue({
      output: { ...aiOutput, description: "Kurz." },
    });
    const result = await importJobFromText(PASTED);
    expect((result as any).data.description).toContain("Aufgabe 10");
  });

  it("uses the job link, when there is one, for the source", async () => {
    (generateText as any).mockResolvedValue({ output: aiOutput });
    const result = await importJobFromText(PASTED, "https://www.linkedin.com/jobs/view/1");
    expect(resolveJobSource).toHaveBeenCalledWith("Linkedin", "user-1");
    expect((result as any).data.source.id).toBe("src-1");
  });

  it("asks for the whole posting when the paste is too short", async () => {
    const result = await importJobFromText("IT Consultant");
    expect((result as any).message).toContain("Paste the whole job posting");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("refuses text that isn't a posting", async () => {
    (generateText as any).mockResolvedValue({ output: { ...aiOutput, isJobPosting: false } });
    const result = await importJobFromText(PASTED);
    expect((result as any).message).toContain("doesn't look like a job posting");
  });
});
