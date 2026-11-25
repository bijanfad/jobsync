import { z } from "zod";

// What the AI returns when reading a job page. Every field may be empty: the
// form fills what it gets and leaves the rest for the user.
export const JobImportSchema = z.object({
  isJobPosting: z
    .boolean()
    .describe("false if the page is not a single job posting, e.g. a search page, a list of jobs, a login wall or an error page"),
  jobTitle: z.string().catch(""),
  company: z.string().catch(""),
  location: z.string().catch(""),
  salaryRange: z.string().catch(""),
  workplaceType: z.enum(["Remote", "Hybrid", "Onsite", ""]).catch(""),
  jobType: z.enum(["Full-time", "Part-time", "Contract", ""]).catch(""),
  skills: z.array(z.string()).catch([]),
  description: z.string().catch(""),
});

export type JobImport = z.infer<typeof JobImportSchema>;
