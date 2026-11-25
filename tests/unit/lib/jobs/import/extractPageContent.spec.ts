import {
  extractJobPostingJsonLd,
  extractPageContent,
  hasUsableContent,
  htmlToReadableText,
} from "@/lib/jobs/import/extractPageContent";
import { jobSourceLabelFromUrl } from "@/lib/jobs/import/jobSourceFromUrl";

const posting = {
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Data Engineer (m/w/d)",
  hiringOrganization: { "@type": "Organization", name: "thyssenkrupp AG" },
};

describe("extractJobPostingJsonLd", () => {
  it("finds a JobPosting block", () => {
    const html = `<script type="application/ld+json">${JSON.stringify(posting)}</script>`;
    expect(extractJobPostingJsonLd(html)?.title).toBe("Data Engineer (m/w/d)");
  });

  it("finds a JobPosting inside @graph and skips malformed blocks", () => {
    const html = `
      <script type="application/ld+json">{ not json</script>
      <script type='application/ld+json'>${JSON.stringify({
        "@graph": [{ "@type": "WebPage" }, posting],
      })}</script>`;
    expect(extractJobPostingJsonLd(html)?.title).toBe("Data Engineer (m/w/d)");
  });

  it("returns null when there is none", () => {
    expect(extractJobPostingJsonLd("<p>hi</p>")).toBeNull();
  });
});

describe("htmlToReadableText", () => {
  it("drops scripts, styles and nav, and keeps list structure", () => {
    const text = htmlToReadableText(`
      <html><head><title>x</title><style>.a{}</style></head><body>
      <nav>Home | Jobs</nav>
      <h2>Your tasks</h2><ul><li>Build &amp; run pipelines</li><li>Python</li></ul>
      <script>alert(1)</script></body></html>`);
    expect(text).toContain("Your tasks");
    expect(text).toContain("- Build & run pipelines");
    expect(text).toContain("- Python");
    expect(text).not.toMatch(/alert|Home \| Jobs|\.a\{\}/);
  });
});

describe("extractPageContent / hasUsableContent", () => {
  it("reads og:title and the JSON-LD", () => {
    const html = `<head><meta property="og:title" content="Data Engineer | thyssenkrupp"><title>t</title></head>
      <script type="application/ld+json">${JSON.stringify(posting)}</script>`;
    const content = extractPageContent(html);
    expect(content.title).toBe("Data Engineer | thyssenkrupp");
    expect(content.jsonLd).toContain("Data Engineer");
    expect(hasUsableContent(content)).toBe(true);
  });

  it("treats a JavaScript-only shell as unusable", () => {
    const content = extractPageContent(
      `<html><body><div id="root"></div><script src="/app.js"></script></body></html>`,
    );
    expect(hasUsableContent(content)).toBe(false);
  });
});

describe("jobSourceLabelFromUrl", () => {
  it.each([
    ["https://www.linkedin.com/jobs/view/123", "Linkedin"],
    ["https://de.indeed.com/viewjob?jk=1", "Indeed"],
    ["https://www.stepstone.de/stellenangebote--x", "StepStone"],
    ["https://jobs.thyssenkrupp.com/en/job/1", "Company Career page"],
    ["https://boards.greenhouse.io/acme/jobs/1", "Company Career page"],
    ["garbage", "Company Career page"],
  ])("%s -> %s", (url, label) => {
    expect(jobSourceLabelFromUrl(url)).toBe(label);
  });
});
