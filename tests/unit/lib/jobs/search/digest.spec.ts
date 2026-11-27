vi.mock("server-only", () => ({}));
vi.mock("@/lib/telemetry", () => ({ log: { info: vi.fn(), error: vi.fn() } }));

const h = vi.hoisted(() => ({
  configured: true,
  searches: [] as any[],
  rows: [] as any[],
  sendMail: vi.fn(async () => {}),
}));
vi.mock("@/lib/email/mailer", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/mailer")>()),
  isEmailConfigured: () => h.configured,
  alertRecipient: (email: string | null) => email,
  appBaseUrl: () => "https://jobs.example.com",
  sendMail: h.sendMail,
}));

const matches = (r: any, where: any) =>
  r.rankingId === where.rankingId &&
  r.foundAt >= where.foundAt.gte &&
  (where.scoredAt !== null || r.scoredAt == null) &&
  (!where.score || (r.score ?? -1) >= where.score.gte);

vi.mock("@/lib/db", () => ({
  default: {
    jobSearch: {
      findMany: vi.fn(async () => h.searches.filter((s) => s.emailAlerts && s.digestPendingSince)),
      update: vi.fn(async ({ where, data }: any) => Object.assign(h.searches.find((s) => s.id === where.id), data)),
    },
    jobRankingRow: {
      count: vi.fn(async ({ where }: any) => h.rows.filter((r) => matches(r, where)).length),
      findMany: vi.fn(async ({ where, take }: any) =>
        h.rows
          .filter((r) => matches(r, where))
          .sort((a, b) => b.score - a.score)
          .slice(0, take),
      ),
    },
  },
}));

import { buildDigestEmail, DIGEST_MAX_WAIT_MS, sendDueDigests } from "@/lib/jobs/search/digest";

const since = new Date("2026-11-27T06:30:00Z");
const row = (title: string, score: number | null, extra: any = {}) => ({
  rankingId: "rk-1",
  foundAt: since,
  title,
  company: "ACME",
  location: "Köln",
  url: `https://x.de/${title}`,
  score,
  scoredAt: score == null ? null : since,
  bestResumeTitle: "CV IT",
  reason: "Fits well",
  source: "Bundesagentur für Arbeit",
  ...extra,
});

describe("sendDueDigests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.configured = true;
    h.searches = [
      {
        id: "s-1",
        name: "IT admin Köln",
        rankingId: "rk-1",
        emailAlerts: true,
        emailMinScore: 60,
        digestPendingSince: since,
        user: { email: "me@gmail.com" },
      },
    ];
    h.rows = [
      row("Old job", 95, { foundAt: new Date("2026-11-20T06:30:00Z") }),
      row("Admin", 72),
      row("SOC Lead", 88),
      row("Helpdesk", 40),
    ];
  });

  it("emails the new jobs at or above the minimum score, best first, then clears the mark", async () => {
    await sendDueDigests(new Date("2026-11-27T07:00:00Z"));
    expect(h.sendMail).toHaveBeenCalledTimes(1);
    const mail = (h.sendMail.mock.calls[0] as any)[0];
    expect(mail.to).toBe("me@gmail.com");
    expect(mail.subject).toBe("JobSync: 2 new job matches for “IT admin Köln”");
    expect(mail.text.indexOf("SOC Lead")).toBeLessThan(mail.text.indexOf("Admin"));
    expect(mail.text).not.toContain("Helpdesk");
    expect(mail.text).not.toContain("Old job");
    expect(mail.text).toContain("3 new jobs found, 2 with a score of 60 or more.");
    expect(mail.html).toContain("https://jobs.example.com/dashboard/rank-jobs/rk-1?new=1");
    expect(h.searches[0].digestPendingSince).toBeNull();
  });

  it("waits while new jobs are still being scored", async () => {
    h.rows.push(row("Waiting", null));
    await sendDueDigests(new Date("2026-11-27T07:00:00Z"));
    expect(h.sendMail).not.toHaveBeenCalled();
    expect(h.searches[0].digestPendingSince).toBe(since);
  });

  it("sends what is scored once it has waited long enough", async () => {
    h.rows.push(row("Waiting", null));
    await sendDueDigests(new Date(since.getTime() + DIGEST_MAX_WAIT_MS + 1));
    expect(h.sendMail).toHaveBeenCalledTimes(1);
    expect(h.searches[0].digestPendingSince).toBeNull();
  });

  it("sends nothing on a day without matches, and still clears the mark", async () => {
    h.searches[0].emailMinScore = 90;
    await sendDueDigests(new Date("2026-11-27T07:00:00Z"));
    expect(h.sendMail).not.toHaveBeenCalled();
    expect(h.searches[0].digestPendingSince).toBeNull();
  });

  it("keeps the mark to retry when sending fails", async () => {
    h.sendMail.mockRejectedValueOnce(new Error("Could not reach the mail server."));
    await sendDueDigests(new Date("2026-11-27T07:00:00Z"));
    expect(h.searches[0].digestPendingSince).toBe(since);
  });

  it("does nothing when email is not set up", async () => {
    h.configured = false;
    await sendDueDigests(new Date("2026-11-27T07:00:00Z"));
    expect(h.sendMail).not.toHaveBeenCalled();
    expect(h.searches[0].digestPendingSince).toBe(since);
  });
});

describe("buildDigestEmail", () => {
  it("escapes job text in the HTML", () => {
    const { html } = buildDigestEmail({
      searchName: "A <b>",
      rows: [row("<script>x</script>", 80)],
      matches: 1,
      found: 1,
      minScore: 60,
      resultsUrl: "https://jobs.example.com/r",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &lt;b&gt;");
  });

  it("says when there are more matches than it shows", () => {
    const { text } = buildDigestEmail({
      searchName: "S",
      rows: [row("One", 80)],
      matches: 45,
      found: 100,
      minScore: 60,
      resultsUrl: "u",
    });
    expect(text).toContain("Showing the best 1. See all in JobSync.");
  });
});
