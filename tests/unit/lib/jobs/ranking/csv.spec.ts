import { mapHeaders, parseRankingCsv } from "@/lib/jobs/ranking/csv";

const HEADER =
  "﻿Title,Job type,Company,Location / Remote,Date Posted,Language,URL,Remote,Experience (years),Skills,Degree";

describe("parseRankingCsv", () => {
  it("reads a job finder export, mapping every column", () => {
    const csv = [
      HEADER,
      'Data Scientist,KI / AI,Globaldimensionsllc,Stuttgart,26.11.2026,Unbekannt,https://www.arbeitnow.com/jobs/companies/x/data-scientist-285730,Unclear,7,"Python, Machine Learning",Degree or training required',
      'Fachinformatiker (m/w/d),IT-Support,ANGEHEUERT GmbH,Frankfurt am Main,26.11.2026,Deutsch & Englisch nötig,https://www.arbeitsagentur.de/jobsuche/jobdetail/1-2-S,No,2,"Windows, Active Directory",',
    ].join("\n");
    const parsed = parseRankingCsv(csv);
    expect(parsed.error).toBeUndefined();
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual({
      title: "Data Scientist",
      company: "Globaldimensionsllc",
      location: "Stuttgart",
      url: "https://www.arbeitnow.com/jobs/companies/x/data-scientist-285730",
      category: "KI / AI",
      datePosted: "26.11.2026",
      language: "Unbekannt",
      remote: "Unclear",
      experience: "7",
      skills: "Python, Machine Learning",
      degree: "Degree or training required",
    });
    expect(parsed.rows[1].degree).toBeUndefined();
    expect(parsed.columns).toMatchObject({ title: "Title", url: "URL", location: "Location / Remote" });
  });

  it("drops the same posting under another tracking query, and rows without a title", () => {
    const csv = [
      HEADER,
      "A,,Co,,,,https://www.get-in-it.de/jobsuche/p1?utm_source=arbeitsagentur,,,,",
      "A again,,Co,,,,https://get-in-it.de/jobsuche/p1,,,,",
      ",,Co,,,,https://example.com/job/2,,,,",
      "B,,Co,,,,https://www.interamt.de/koop/app/stelle?id=1,,,,",
      "C,,Co,,,,https://www.interamt.de/koop/app/stelle?id=2,,,,",
    ].join("\n");
    const parsed = parseRankingCsv(csv);
    expect(parsed.rows.map((r) => r.title)).toEqual(["A", "B", "C"]);
    expect(parsed.duplicates).toBe(1);
    expect(parsed.skipped).toBe(1);
  });

  it("explains a file without a title column", () => {
    const parsed = parseRankingCsv("Firma,Link\nACME,https://a.de/1");
    expect(parsed.rows).toEqual([]);
    expect(parsed.error).toMatch(/job title column/);
  });

  it("accepts German headers and links without a scheme", () => {
    const parsed = parseRankingCsv("Stellentitel;Unternehmen;Ort;Link\nAdmin;ACME;Köln;www.acme.de/jobs/1");
    expect(parsed.rows).toEqual([
      expect.objectContaining({ title: "Admin", company: "ACME", location: "Köln", url: "https://www.acme.de/jobs/1" }),
    ]);
  });

  it("ignores links that aren't web pages", () => {
    const parsed = parseRankingCsv("Title,URL\nA,javascript:alert(1)\nB,mailto:x@y.de");
    expect(parsed.rows.map((r) => r.url)).toEqual([undefined, undefined]);
  });
});

describe("mapHeaders", () => {
  it("finds a title column by a looser name", () => {
    expect(mapHeaders(["Job Title (EN)", "Apply link"])).toEqual({ title: 0, url: 1 });
  });
});
