vi.mock("server-only", () => ({}));
vi.mock("@/lib/scraper/ats/registry", () => ({
  ATS_PROVIDERS: { greenhouse: { search: vi.fn() }, lever: { search: vi.fn() }, ashby: { search: vi.fn() } },
}));

import { ATS_PROVIDERS } from "@/lib/scraper/ats/registry";
import {
  searchAdzuna,
  searchArbeitnow,
  searchBundesagentur,
  searchPersonio,
  searchRecruitee,
  searchSmartRecruiters,
  SEARCH_SOURCE_FNS,
} from "@/lib/jobs/search/sources";
import type { SearchQuery, SourceContext } from "@/lib/jobs/search/types";

const now = new Date("2026-11-26T12:00:00Z");
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ctx = (fetchImpl: any, extra: Partial<SourceContext> = {}): SourceContext => ({
  fetchImpl,
  companies: [],
  now,
  ...extra,
});
const query = (q: Partial<SearchQuery> = {}): SearchQuery => ({
  keywords: ["IT-Administrator"],
  location: "Köln",
  radiusKm: 25,
  maxAgeDays: 7,
  ...q,
});
const LONG = "<p>Wir suchen eine IT-Administratorin für Windows Server und Active Directory.</p>".repeat(4);

describe("searchBundesagentur", () => {
  it("queries the Jobsuche API per keyword and links each job's detail page", async () => {
    const fetchImpl: any = vi.fn(async () =>
      json({
        maxErgebnisse: 2,
        ergebnisliste: [
          {
            referenznummer: "10001-1003303354-S",
            stellenangebotsTitel: "IT-Administrator (m/w/d)",
            hauptberuf: "IT-Systemadministrator/in",
            firma: "SEJ GmbH",
            stellenlokationen: [{ adresse: { ort: "Köln", plz: "50670" } }],
            datumErsteVeroeffentlichung: "2026-11-25",
            homeofficemoeglich: true,
          },
          { stellenangebotsTitel: "no reference, skipped" },
        ],
      }),
    );
    const hits = await searchBundesagentur(query({ keywords: ["IT-Administrator", "SOC"] }), ctx(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      was: "IT-Administrator",
      wo: "Köln",
      umkreis: "25",
      veroeffentlichtseit: "7",
      angebotsart: "1",
      size: "100",
      page: "1",
    });
    expect(init.headers["X-API-Key"]).toBe("jobboerse-jobsuche");
    expect(hits[0]).toEqual({
      keyword: "IT-Administrator",
      title: "IT-Administrator (m/w/d)",
      company: "SEJ GmbH",
      location: "Köln",
      url: "https://www.arbeitsagentur.de/jobsuche/jobdetail/10001-1003303354-S",
      category: "IT-Systemadministrator/in",
      datePosted: "2026-11-25",
      remote: "Home office possible",
    });
  });

  it("pages until the results run out", async () => {
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ referenznummer: `r-${n}-${i}`, stellenangebotsTitel: "Admin" }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ maxErgebnisse: 150, ergebnisliste: page(100) }))
      .mockResolvedValueOnce(json({ maxErgebnisse: 150, ergebnisliste: page(50) }));
    const hits = await searchBundesagentur(query(), ctx(fetchImpl));
    expect(hits).toHaveLength(150);
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get("page")).toBe("2");
  });

  it("explains a refusal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 403 }));
    await expect(searchBundesagentur(query(), ctx(fetchImpl))).rejects.toThrow(/refused/);
  });
});

describe("searchArbeitnow", () => {
  it("keeps matching jobs from the feed, with their description", async () => {
    const t = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        data: [
          { title: "IT Administrator (m/w/d)", company_name: "ACME", location: "Cologne", url: "https://www.arbeitnow.com/jobs/a", tags: ["Windows"], description: LONG, created_at: t("2026-11-25T08:00:00Z") },
          { title: "Remote IT-Administrator", company_name: "Beta", location: "Berlin", remote: true, url: "https://www.arbeitnow.com/jobs/b", created_at: t("2026-11-24T08:00:00Z") },
          { title: "IT-Administrator", company_name: "Gamma", location: "Hamburg", url: "https://www.arbeitnow.com/jobs/c", created_at: t("2026-11-24T08:00:00Z") },
          { title: "Koch", company_name: "Delta", location: "Köln", url: "https://www.arbeitnow.com/jobs/d", created_at: t("2026-11-24T08:00:00Z") },
          { title: "IT-Administrator", company_name: "Old", location: "Köln", url: "https://www.arbeitnow.com/jobs/e", created_at: t("2026-10-01T08:00:00Z") },
        ],
        links: { next: "https://www.arbeitnow.com/api/job-board-api?page=2" },
      }),
    );
    const hits = await searchArbeitnow(query(), ctx(fetchImpl));
    expect(hits.map((h) => h.company)).toEqual(["ACME", "Beta"]);
    expect(hits[0].description).toContain("Active Directory");
    expect(hits[0].skills).toBe("Windows");
    // The last job on page 1 is older than asked, so page 2 isn't read.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("searchAdzuna", () => {
  it("needs the user's key", async () => {
    await expect(searchAdzuna(query(), ctx(vi.fn()))).rejects.toThrow(/Adzuna app id/);
  });

  it("searches Germany with the key, place and radius", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        results: [
          { title: "<strong>IT-Administrator</strong> (m/w/d)", redirect_url: "https://www.adzuna.de/land/ad/1", company: { display_name: "ACME" }, location: { display_name: "Köln, NRW" }, created: "2026-11-25T08:00:00Z", description: "Short snippet" },
        ],
      }),
    );
    const hits = await searchAdzuna(query(), ctx(fetchImpl, { adzuna: { appId: "abcd1234", appKey: "k".repeat(32) } }));
    const u = new URL(fetchImpl.mock.calls[0][0]);
    expect(u.pathname).toBe("/v1/api/jobs/de/search/1");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      app_id: "abcd1234",
      what: "IT-Administrator",
      where: "Köln",
      distance: "25",
      max_days_old: "7",
    });
    expect(hits[0]).toMatchObject({ title: "IT-Administrator (m/w/d)", company: "ACME", datePosted: "2026-11-25" });
  });
});

describe("career pages", () => {
  it("reads a Personio XML feed", async () => {
    const xml = `<?xml version="1.0"?><workzag-jobs>
      <position><id>2529696</id><subcompany>Proact Deutschland GmbH</subcompany><office>Office Köln</office>
        <department>IT</department><name>IT-Administrator (m/w/d)</name>
        <jobDescriptions><jobDescription><name>Deine Aufgaben</name><value><![CDATA[${LONG}]]></value></jobDescription></jobDescriptions>
        <createdAt>2026-11-20T16:07:18+00:00</createdAt></position>
      <position><id>2</id><office>Office Köln</office><name>Vertrieb</name><createdAt>2026-11-20T16:07:18+00:00</createdAt></position>
    </workzag-jobs>`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(xml, { status: 200 }));
    const hits = await searchPersonio(query(), ctx(fetchImpl, { companies: ["Proact"] }));
    expect(fetchImpl.mock.calls[0][0]).toBe("https://proact.jobs.personio.de/xml?language=de");
    expect(hits).toEqual([
      expect.objectContaining({
        title: "IT-Administrator (m/w/d)",
        company: "Proact Deutschland GmbH",
        location: "Köln",
        url: "https://proact.jobs.personio.de/job/2529696",
        datePosted: "2026-11-20",
      }),
    ]);
    expect(hits[0].description).toContain("Deine Aufgaben");
  });

  it("reads Recruitee offers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        offers: [
          { title: "IT Administrator", company_name: "ML Reply", careers_url: "https://mlr.recruitee.com/o/it-admin", location: "Köln, NRW, Germany", published_at: "2026-11-23 16:37:26 UTC", description: LONG, requirements: "<p>Linux</p>", status: "published" },
          { title: "GenAI Engineer", careers_url: "https://mlr.recruitee.com/o/genai", location: "Köln", published_at: "2026-11-23 16:37:26 UTC" },
        ],
      }),
    );
    const hits = await searchRecruitee(query(), ctx(fetchImpl, { companies: ["mlr"] }));
    expect(hits.map((h) => h.url)).toEqual(["https://mlr.recruitee.com/o/it-admin"]);
    expect(hits[0].datePosted).toBe("2026-11-23");
    expect(hits[0].description).toContain("Linux");
  });

  it("searches SmartRecruiters with its own keyword search", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        totalFound: 1,
        content: [
          { id: "744000163844654", name: "Systemadministrator Windows", company: { identifier: "BoschGroup", name: "Bosch Group" }, releasedDate: "2026-11-26T10:35:44.361Z", location: { city: "Köln", fullLocation: "Köln, NW, Germany", remote: false } },
        ],
      }),
    );
    const hits = await searchSmartRecruiters(query(), ctx(fetchImpl, { companies: ["BoschGroup"] }));
    const u = new URL(fetchImpl.mock.calls[0][0]);
    expect(u.pathname).toBe("/v1/companies/BoschGroup/postings");
    expect(u.searchParams.get("q")).toBe("IT-Administrator");
    expect(hits[0]).toMatchObject({ url: "https://jobs.smartrecruiters.com/BoschGroup/744000163844654", company: "Bosch Group" });
  });

  it("never builds a URL from a company name that isn't a plain slug", async () => {
    const fetchImpl = vi.fn();
    await expect(
      searchRecruitee(query(), ctx(fetchImpl, { companies: ["evil.com/x?", "127.0.0.1:8080"] })),
    ).rejects.toThrow(/at least one company/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the companies that answered when one fails", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("good") ? json({ offers: [{ title: "IT-Administrator", careers_url: "https://good.recruitee.com/o/1", location: "Köln" }] }) : new Response("", { status: 404 }),
    );
    const hits = await searchRecruitee(query(), ctx(fetchImpl, { companies: ["good", "gone"] }));
    expect(hits).toHaveLength(1);
  });

  it("reuses the Greenhouse fetcher and filters its jobs", async () => {
    (ATS_PROVIDERS.greenhouse!.search as any).mockResolvedValue({
      jobs: [
        { title: "IT Administrator", company: "Celonis", location: "Cologne", url: "https://job-boards.greenhouse.io/celonis/jobs/1", description: LONG, postedDate: "2026-11-25" },
        { title: "Sales", company: "Celonis", location: "Cologne", url: "https://job-boards.greenhouse.io/celonis/jobs/2", description: "", postedDate: "2026-11-25" },
      ],
      errors: [],
    });
    const hits = await SEARCH_SOURCE_FNS.greenhouse(query(), ctx(vi.fn(), { companies: ["celonis"] }));
    expect(ATS_PROVIDERS.greenhouse!.search).toHaveBeenCalledWith([{ name: "celonis", token: "celonis" }]);
    expect(hits.map((h) => h.url)).toEqual(["https://job-boards.greenhouse.io/celonis/jobs/1"]);
  });
});

describe("long job lists", () => {
  it("searches every title on its own, each with a share of the budget", async () => {
    const titles = Array.from({ length: 40 }, (_, i) => `Title ${i}`);
    const fetchImpl: any = vi.fn(async (url: string) => {
      const was = new URL(url).searchParams.get("was");
      return json({
        maxErgebnisse: 500,
        ergebnisliste: Array.from({ length: 50 }, (_, i) => ({ referenznummer: `${was}-${i}`, stellenangebotsTitel: `${was} job` })),
      });
    });
    const hits = await searchBundesagentur(query({ keywords: titles }), ctx(fetchImpl));
    // 2,000 jobs over 40 titles: 50 each, one page of 50
    expect(fetchImpl).toHaveBeenCalledTimes(40);
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get("size")).toBe("50");
    expect(new Set(hits.map((h) => h.keyword)).size).toBe(40);
    expect(hits).toHaveLength(2000);
  });

  it("tags feed jobs with the title that matched", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        data: [
          { title: "Netzwerkadministrator (m/w/d)", location: "Köln", url: "https://www.arbeitnow.com/jobs/n", created_at: Math.floor(now.getTime() / 1000) },
        ],
        links: { next: null },
      }),
    );
    const hits = await searchArbeitnow(query({ keywords: ["Systemadministrator", "Netzwerkadministrator"] }), ctx(fetchImpl));
    expect(hits[0].keyword).toBe("Netzwerkadministrator");
  });
});

