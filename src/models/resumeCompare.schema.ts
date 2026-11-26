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
}
