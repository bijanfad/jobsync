import { z } from "zod";

export const ResumeCompareSchema = z.object({
  results: z
    .array(
      z.object({
        resumeNumber: z.number(),
        score: z.number().catch(0),
        verdict: z.string().catch(""),
        strengths: z.array(z.string()).catch([]),
        gaps: z.array(z.string()).catch([]),
      }),
    )
    .catch([]),
});

export interface ResumeComparison {
  resumeId: string;
  title: string;
  isDefault: boolean;
  /** The resume set on this job, which a plain Match uses first. */
  isJobResume: boolean;
  score: number;
  verdict: string;
  strengths: string[];
  gaps: string[];
}

export interface ResumeComparisonResult {
  results: ResumeComparison[];
  /** Resumes left out because they are empty or too short to judge. */
  skipped: string[];
  comparedAt?: string; // ISO
}

/** The saved comparison on a job, or null when absent or unreadable. */
export function parseResumeComparison(
  raw: string | null | undefined,
): ResumeComparisonResult | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.results) ? (parsed as ResumeComparisonResult) : null;
  } catch {
    return null;
  }
}
