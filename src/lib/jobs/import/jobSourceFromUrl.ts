import { JOB_SOURCES } from "@/lib/constants";

// Job boards by hostname. Anything else is treated as the employer's own
// careers site (or the ATS it uses), which is what most direct links are.
const BOARD_HOSTS: { pattern: RegExp; label: string }[] = [
  { pattern: /(^|\.)linkedin\./, label: "Linkedin" },
  { pattern: /(^|\.)indeed\./, label: "Indeed" },
  { pattern: /(^|\.)glassdoor\./, label: "Glassdoor" },
  { pattern: /(^|\.)monster\./, label: "Monster" },
  { pattern: /(^|\.)ziprecruiter\./, label: "ZipRecruiter" },
  { pattern: /(^|\.)jobstreet\./, label: "Job Street" },
  { pattern: /(^|\.)google\./, label: "Google" },
  { pattern: /(^|\.)stepstone\./, label: "StepStone" },
  { pattern: /(^|\.)xing\./, label: "XING" },
];

const CAREER_PAGE =
  JOB_SOURCES.find((s) => s.value === "careerpage")?.label ?? "Company Career page";

export function jobSourceLabelFromUrl(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return CAREER_PAGE;
  }
  return BOARD_HOSTS.find((b) => b.pattern.test(host))?.label ?? CAREER_PAGE;
}
