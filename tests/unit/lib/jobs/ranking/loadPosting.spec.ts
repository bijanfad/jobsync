vi.mock("server-only", () => ({}));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

import { lookup } from "node:dns/promises";
import { findOnwardLink, loadPosting } from "@/lib/jobs/ranking/loadPosting";

const html = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

const LONG = "Wir suchen eine erfahrene Administratorin für unsere Windows- und Linux-Server. ".repeat(6);
const jsonLd = (description: string) =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    "@type": "JobPosting",
    title: "IT-Administrator",
    description,
  })}</script></head><body><div id="app"></div></body></html>`;

const shell = (extra = "") => `<html><head><title>Job</title></head><body><div id="root"></div>${extra}</body></html>`;

describe("loadPosting", () => {
  beforeEach(() => {
    (lookup as any).mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  it("reads the description from the page's JSON-LD", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(html(jsonLd(`<p>${LONG}</p>`)));
    const result = await loadPosting("https://www.arbeitsagentur.de/jobsuche/jobdetail/1-S", fetchImpl);
    expect(result.status).toBe("loaded");
    expect(result.description).toContain("erfahrene Administratorin");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows a listing page on to the employer's posting", async () => {
    const listing = shell(
      `<script id="ng-state" type="application/json">{"jobdetail":{"externeUrl":"https:\\/\\/jobs.acme.de\\/job\\/42"}}</script>`,
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(html(listing))
      .mockResolvedValueOnce(html(jsonLd(LONG)));
    const result = await loadPosting("https://www.arbeitsagentur.de/jobsuche/jobdetail/2-S", fetchImpl);
    expect(result).toMatchObject({ status: "loaded", finalUrl: "https://jobs.acme.de/job/42" });
    expect(String(fetchImpl.mock.calls[1][0])).toBe("https://jobs.acme.de/job/42");
  });

  it("gives up on a JavaScript-only page with nowhere to go", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(html(shell()));
    const result = await loadPosting("https://germantechjobs.de/jobs/x", fetchImpl);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/JavaScript/);
  });

  it("reports a blocked site", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("no", { status: 403 }));
    const result = await loadPosting("https://example.com/job/1", fetchImpl);
    expect(result).toEqual({ status: "failed", error: expect.stringMatching(/blocked/) });
  });
});

describe("findOnwardLink", () => {
  const page = "https://www.jobboard.de/stelle/1";

  it("picks the link to the original ad", () => {
    const body = `<a href="https://facebook.com/share">Teilen</a>
      <a href="/impressum">Impressum</a>
      <a class="btn" href="https://karriere.acme.de/job/7">Zur Stellenanzeige</a>`;
    expect(findOnwardLink(body, page)).toBe("https://karriere.acme.de/job/7");
  });

  it("uses an apply link's title when its text is an icon", () => {
    const body = `<a href="/stelle/1/apply" title="Apply for Data Scientist"><svg></svg></a>`;
    expect(findOnwardLink(body, page)).toBe("https://www.jobboard.de/stelle/1/apply");
  });

  it("follows a meta refresh", () => {
    const body = `<meta http-equiv="refresh" content="0; url=https://jobs.acme.de/9">`;
    expect(findOnwardLink(body, page)).toBe("https://jobs.acme.de/9");
  });

  it("skips social links and links back to the same page", () => {
    const body = `<a href="https://www.linkedin.com/x">Apply on LinkedIn</a><a href="${page}#apply">Jetzt bewerben</a>`;
    expect(findOnwardLink(body, page)).toBeNull();
  });
});
