import { z } from "zod";

export const JobRankSchema = z.object({
  results: z
    .array(
      z.object({
        jobNumber: z.number(),
        resumeNumber: z.number().catch(1),
        score: z.number().catch(0),
        reason: z.string().catch(""),
      }),
    )
    .catch([]),
});
export type JobRankOutput = z.infer<typeof JobRankSchema>;
