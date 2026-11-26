import { z } from "zod";

// What the AI returns when reading a job page. Every field may be empty: the
// form fills what it gets and leaves the rest for the user. The type fields
// are free text rather than enums: a model reading a German posting will
// sometimes answer "Vollzeit" or "Homeoffice", and the server maps those
// (see jobImportTerms.ts) instead of the whole answer failing validation.
export const JobImportSchema = z.object({
  isJobPosting: z
    .boolean()
    .describe("false if the page is not a single job posting, e.g. a search page, a list of jobs, a login wall or an error page")
    .catch(true),
  jobTitle: z.string().catch(""),
  company: z.string().catch(""),
  location: z.string().catch(""),
  salaryRange: z.string().catch(""),
  workplaceType: z
    .string()
    .describe('"Remote", "Hybrid", "Onsite" or empty')
    .catch(""),
  jobType: z
    .string()
    .describe('"Full-time", "Part-time", "Contract" or empty')
    .catch(""),
  skills: z.array(z.string()).catch([]),
  description: z.string().catch(""),
});

export type JobImport = z.infer<typeof JobImportSchema>;
