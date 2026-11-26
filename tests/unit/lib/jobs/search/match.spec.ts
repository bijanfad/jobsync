import { matchesKeywords, matchesLocation, withinAge } from "@/lib/jobs/search/match";

describe("job search matching", () => {
  it("matches keywords loosely", () => {
    expect(matchesKeywords("IT Administrator (m/w/d)", ["IT-Administrator"])).toBe(true);
    expect(matchesKeywords("Systemadministrator Windows", ["administrator"])).toBe(true);
    expect(matchesKeywords("Informationssicherheitsbeauftragter", ["Sicherheit"])).toBe(true);
    expect(matchesKeywords("Koch", ["IT-Administrator", "SOC"])).toBe(false);
    expect(matchesKeywords("anything", [])).toBe(true);
  });

  it("matches places, aliases and remote jobs", () => {
    expect(matchesLocation("Munich, Bayern, Germany", false, "München")).toBe(true);
    expect(matchesLocation("Office Köln", false, "Cologne")).toBe(true);
    expect(matchesLocation("Hamburg", false, "Köln")).toBe(false);
    expect(matchesLocation("Hamburg", true, "Köln")).toBe(true);
    expect(matchesLocation("Remote Deutschland", false, "Köln")).toBe(true);
    expect(matchesLocation(undefined, false, "")).toBe(true);
  });

  it("checks the posting age", () => {
    const now = new Date("2026-11-26T12:00:00Z");
    const q = { keywords: [], radiusKm: 0, maxAgeDays: 7 };
    expect(withinAge("2026-11-20", q, now)).toBe(true);
    expect(withinAge("2026-11-01", q, now)).toBe(false);
    expect(withinAge(undefined, q, now)).toBe(true);
  });
});
