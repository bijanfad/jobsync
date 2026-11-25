vi.mock("server-only", () => ({}));

import {
  cleanJobTitle,
  jobTypeCode,
  workplaceTypeCode,
} from "@/lib/jobs/import/jobImportTerms";
import { acceptLanguageFor, detectCharset } from "@/lib/jobs/import/fetchJobPage";
import {
  extractDescriptionText,
  extractPageContent,
} from "@/lib/jobs/import/extractPageContent";
import {
  chooseDescription,
  descriptionTooShortForMatch,
} from "@/lib/jobs/import/chooseDescription";

describe("cleanJobTitle", () => {
  it.each([
    ["IT Consultant Security (wmd)", "IT Consultant Security"],
    ["IT Consultant Security (w/m/d)", "IT Consultant Security"],
    ["Data Engineer (m/w/d) – Cloud", "Data Engineer – Cloud"],
    ["Entwickler (m/f/x)", "Entwickler"],
    ["Werkstudent (gn*)", "Werkstudent"],
    ["Sales Manager (all genders)", "Sales Manager"],
    ["Projektleiter [m/w/d]", "Projektleiter"],
    ["Head of R&D (EMEA)", "Head of R&D (EMEA)"],
  ])("%s -> %s", (input, expected) => {
    expect(cleanJobTitle(input)).toBe(expected);
  });
});

describe("German workplace and job type terms", () => {
  it.each([
    ["Remote", "REMOTE"],
    ["Homeoffice", "REMOTE"],
    ["Mobiles Arbeiten", "REMOTE"],
    ["Hybrid", "HYBRID"],
    ["teilweise mobil", "HYBRID"],
    ["vor Ort", "ONSITE"],
    ["Onsite", "ONSITE"],
    ["Präsenz", "ONSITE"],
    ["", undefined],
    ["unbekannt", undefined],
  ])("workplace %s -> %s", (input, code) => {
    expect(workplaceTypeCode(input)).toBe(code);
  });

  it.each([
    ["Full-time", "FT"],
    ["Vollzeit", "FT"],
    ["Vollzeit, unbefristet", "FT"],
    ["Teilzeit", "PT"],
    ["Werkstudent", "PT"],
    ["Part-time", "PT"],
    ["befristet", "C"],
    ["Contract", "C"],
    ["Freiberuflich", "C"],
    ["", undefined],
  ])("job type %s -> %s", (input, code) => {
    expect(jobTypeCode(input)).toBe(code);
  });
});

describe("acceptLanguageFor", () => {
  it("prefers German for a de_DE SuccessFactors link", () => {
    const url = new URL(
      "https://jobs.bechtle.com/job/Neckarsulm-IT-Consultant-Security-%28wmd%29-74172/78743-de_DE/?utm_source=bundesagentur",
    );
    expect(acceptLanguageFor(url)).toMatch(/^de-DE/);
  });

  it.each([
    "https://www.stepstone.de/stellenangebote--x",
    "https://karriere.example.com/de/jobs/1",
    "https://jobs.example.com/job/1?lang=de",
  ])("prefers German for %s", (u) => {
    expect(acceptLanguageFor(new URL(u))).toMatch(/^de-DE/);
  });

  it("prefers English otherwise", () => {
    expect(acceptLanguageFor(new URL("https://boards.greenhouse.io/acme/jobs/1"))).toMatch(/^en/);
  });
});

describe("detectCharset", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it("uses the header charset", () => {
    expect(detectCharset("text/html; charset=ISO-8859-1", bytes(""))).toBe("windows-1252");
  });

  it("falls back to <meta charset>", () => {
    expect(detectCharset("text/html", bytes('<meta charset="iso-8859-1">'))).toBe("windows-1252");
  });

  it("defaults to UTF-8 and ignores unknown labels", () => {
    expect(detectCharset("text/html; charset=bogus", bytes(""))).toBe("utf-8");
  });

  it("decodes umlauts from a Latin-1 page", () => {
    const latin1 = Uint8Array.from([0x47, 0xfc, 0x6e, 0x73, 0x74, 0x69, 0x67]); // "Günstig"
    expect(new TextDecoder(detectCharset("text/html; charset=iso-8859-1", latin1)).decode(latin1)).toBe(
      "Günstig",
    );
  });
});

const LONG_DE = Array.from(
  { length: 12 },
  (_, i) => `<li>Aufgabe ${i + 1}: Beratung unserer Kunden zu IT-Sicherheit und Netzwerkschutz</li>`,
).join("");

describe("extractDescriptionText", () => {
  it("reads a microdata description with nested divs (SuccessFactors)", () => {
    const html = `
      <div itemscope itemtype="http://schema.org/JobPosting">
        <h1 itemprop="title">IT Consultant Security (w/m/d)</h1>
        <div class="jobDisplay"><span itemprop="description">
          <div><h2>Ihre Aufgaben</h2><div><ul>${LONG_DE}</ul></div></div>
          <div><h2>Ihr Profil</h2><p>Erfahrung mit Firewalls &amp; SIEM.</p></div>
        </span></div>
        <div class="footer-links">Impressum</div>
      </div>`;
    const text = extractDescriptionText(html, null)!;
    expect(text).toContain("Ihre Aufgaben");
    expect(text).toContain("- Aufgabe 12: Beratung");
    expect(text).toContain("Erfahrung mit Firewalls & SIEM.");
    expect(text).not.toContain("Impressum");
  });

  it("reads a jobdescription class when there is no microdata", () => {
    const html = `<div class="jobdescription"><div><ul>${LONG_DE}</ul></div></div><div>Andere Jobs</div>`;
    const text = extractDescriptionText(html, null)!;
    expect(text).toContain("Aufgabe 1:");
    expect(text).not.toContain("Andere Jobs");
  });

  it("prefers the JSON-LD description", () => {
    const text = extractDescriptionText("", {
      "@type": "JobPosting",
      description: `&lt;ul&gt;${LONG_DE.replace(/</g, "&lt;").replace(/>/g, "&gt;")}&lt;/ul&gt;`,
    })!;
    expect(text).toContain("- Aufgabe 1:");
  });

  it("returns null when nothing long enough is found", () => {
    expect(extractDescriptionText('<div itemprop="description">kurz</div>', null)).toBeNull();
  });

  it("is part of extractPageContent", () => {
    const content = extractPageContent(`<span itemprop="description"><ul>${LONG_DE}</ul></span>`);
    expect(content.description).toContain("Aufgabe 3");
  });
});

describe("chooseDescription", () => {
  const page = "Ihre Aufgaben\n" + "- Beratung unserer Kunden zu IT-Sicherheit\n".repeat(20);

  it("uses the page's description when the model's copy is cut short", () => {
    expect(chooseDescription("## Ihre Aufgaben\n- Beratung", page)).toBe(page);
  });

  it("keeps the model's copy when it is complete", () => {
    const model = "## Ihre Aufgaben\n\n" + "- Beratung unserer Kunden zu IT-Sicherheit\n".repeat(20);
    expect(chooseDescription(model, page)).toBe(model.trim());
  });

  it("uses the model's copy when the page has none", () => {
    expect(chooseDescription("  text  ", null)).toBe("text");
  });

  it("flags a description Job Match would refuse", () => {
    expect(descriptionTooShortForMatch("kurz")).toBe(true);
    expect(descriptionTooShortForMatch(page)).toBe(false);
  });
});
