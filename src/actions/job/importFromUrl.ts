"use server";
import { randomUUID } from "node:crypto";
import MarkdownIt from "markdown-it";
import { generateText, Output } from "ai";
import prisma from "@/lib/db";
import { getModel } from "@/lib/ai/providers";
import { checkRateLimit } from "@/lib/ai/rate-limiter";
import { MissingCredentialError } from "@/lib/ai/tools/errors";
import { PROVIDER_REGISTRY } from "@/lib/ai/provider-registry";
import {
  JOB_IMPORT_SYSTEM_PROMPT,
  buildJobImportPrompt,
} from "@/lib/ai/prompts/job-import";
import { APP_CONSTANTS, TEMPERATURES } from "@/lib/constants";
import {
  getDefaultModelForProvider,
  getUserAiSettings,
} from "@/lib/scraper/automation-run/aiSettings";
import { fetchJobPage, JobPageFetchError } from "@/lib/jobs/import/fetchJobPage";
import {
  extractPageContent,
  hasUsableContent,
} from "@/lib/jobs/import/extractPageContent";
import { jobSourceLabelFromUrl } from "@/lib/jobs/import/jobSourceFromUrl";
import {
  resolveCompany,
  resolveJobSource,
  resolveJobTitle,
  resolveLocation,
  resolveTag,
} from "@/lib/jobs/resolve";
import { startAiCall } from "@/lib/aiUsage/tracker";
import { log } from "@/lib/telemetry";
import { JobImportSchema, type JobImport } from "@/models/jobImport.schema";
import { JOB_TYPES, WORKPLACE_TYPES, type Tag } from "@/models/job.model";
import type { ActionResult } from "@/models/action.model";
import { requireUser } from "../shared";

// html:false escapes any raw HTML the model echoes from the page, so the
// description that reaches the editor is only what Markdown itself produces.
const md = new MarkdownIt({ html: false, linkify: false, breaks: true });

export interface ImportedOption {
  id: string;
  label: string;
  value: string;
}

export interface JobUrlImport {
  title?: ImportedOption;
  company?: ImportedOption;
  location?: ImportedOption;
  source?: ImportedOption;
  salaryRange?: string;
  workplaceType?: string; // WORKPLACE_TYPES key
  jobType?: string; // JOB_TYPES key
  tags: Tag[];
  description?: string; // HTML
  /** Form fields that were filled, for the toast. */
  filled: string[];
}

function codeFor(
  enumObj: Record<string, string>,
  label: string,
): string | undefined {
  if (!label) return undefined;
  return Object.entries(enumObj).find(
    ([, v]) => v.toLowerCase() === label.toLowerCase(),
  )?.[0];
}

async function asOption(
  table: "jobTitle" | "company" | "location" | "jobSource",
  id: string,
  userId: string,
): Promise<ImportedOption | undefined> {
  const select = { id: true, label: true, value: true } as const;
  const where = { id, createdBy: userId };
  switch (table) {
    case "jobTitle":
      return (await prisma.jobTitle.findFirst({ where, select })) ?? undefined;
    case "company":
      return (await prisma.company.findFirst({ where, select })) ?? undefined;
    case "location":
      return (await prisma.location.findFirst({ where, select })) ?? undefined;
    case "jobSource":
      return (await prisma.jobSource.findFirst({ where, select })) ?? undefined;
  }
}

async function readPosting(
  userId: string,
  url: string,
): Promise<ActionResult<JobImport>> {
  let page;
  try {
    page = await fetchJobPage(url);
  } catch (error) {
    if (error instanceof JobPageFetchError) {
      return { success: false, message: error.message };
    }
    throw error;
  }

  const content = extractPageContent(page.html);
  if (!hasUsableContent(content)) {
    return {
      success: false,
      message:
        "This site loads its job details with JavaScript or hides them from automatic reading, so there was nothing to fill from. Copy the posting text into the Job Description instead.",
    };
  }

  const aiSettings = await getUserAiSettings(userId);
  const provider = aiSettings.provider;
  const modelName = aiSettings.model || getDefaultModelForProvider(provider);
  let model;
  try {
    model = await getModel(provider, modelName, userId);
  } catch (error) {
    if (error instanceof MissingCredentialError) {
      const name = PROVIDER_REGISTRY[provider]?.displayName ?? provider;
      return {
        success: false,
        message: `Add your ${name} key in Settings > API Keys, or pick another provider in AI Settings, to fill jobs with AI.`,
      };
    }
    throw error;
  }

  const nonce = randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase();
  const tracker = startAiCall({
    userId,
    feature: "job_import",
    provider,
    model: modelName,
    numCtx: APP_CONSTANTS.AI_OLLAMA_NUM_CTX,
  });
  try {
    const result = await generateText({
      model,
      output: Output.object({ schema: JobImportSchema }),
      instructions: JOB_IMPORT_SYSTEM_PROMPT,
      prompt: buildJobImportPrompt({ url: page.finalUrl, ...content, nonce }),
      temperature: TEMPERATURES.ANALYSIS,
      abortSignal: AbortSignal.timeout(APP_CONSTANTS.JOB_IMPORT_TIMEOUT_MS),
      providerOptions: {
        ollama: { options: { num_ctx: APP_CONSTANTS.AI_OLLAMA_NUM_CTX } },
        openai: { strictJsonSchema: false },
      },
    });
    void tracker.finish({
      usage: result.usage,
      finishReason: result.finishReason,
    });
    return { success: true, data: JobImportSchema.parse(result.output) };
  } catch (error) {
    void tracker.finish({ error });
    log.error("Job import AI error", { provider, error: String(error) });
    return {
      success: false,
      message:
        "The AI couldn't read this posting. Check your AI Settings, or try again in a moment.",
    };
  }
}

/**
 * Reads the job posting at `url` with the user's configured AI provider and
 * returns form values for Add Job. Title, company, location, source and skill
 * tags are found or created, exactly as picking "Create" in the form does.
 */
export async function importJobFromUrl(
  url: string,
): Promise<ActionResult<JobUrlImport>> {
  try {
    const user = await requireUser();
    const rateLimit = checkRateLimit(user.id);
    if (!rateLimit.allowed) {
      return {
        success: false,
        message: `Too many AI requests. Try again in ${Math.ceil(rateLimit.resetIn / 1000)} seconds.`,
      };
    }

    const read = await readPosting(user.id, url);
    if (!read.success) return read;
    const job = read.data!;
    if (!job.isJobPosting) {
      return {
        success: false,
        message:
          "That page doesn't look like a single job posting. Open the specific job and paste its link.",
      };
    }

    const filled: string[] = [];
    const data: JobUrlImport = { tags: [], filled };
    const title = job.jobTitle.trim();
    const company = job.company.trim();
    const location = job.location.trim();

    const [titleRes, companyRes, locationRes, sourceRes] = await Promise.all([
      title ? resolveJobTitle(title, user.id) : undefined,
      company ? resolveCompany(company, user.id) : undefined,
      location ? resolveLocation(location, user.id) : undefined,
      resolveJobSource(jobSourceLabelFromUrl(url), user.id),
    ]);
    if (titleRes) {
      data.title = await asOption("jobTitle", titleRes.id, user.id);
      filled.push("title");
    }
    if (companyRes) {
      data.company = await asOption("company", companyRes.id, user.id);
      filled.push("company");
    }
    if (locationRes) {
      data.location = await asOption("location", locationRes.id, user.id);
      filled.push("location");
    }
    data.source = await asOption("jobSource", sourceRes.id, user.id);
    filled.push("source");

    if (job.salaryRange.trim()) {
      data.salaryRange = job.salaryRange.trim().slice(0, 100);
      filled.push("salary");
    }
    data.workplaceType = codeFor(WORKPLACE_TYPES, job.workplaceType);
    if (data.workplaceType) filled.push("workplace type");
    data.jobType = codeFor(JOB_TYPES, job.jobType);
    if (data.jobType) filled.push("job type");

    const skills = [...new Set(job.skills.map((s) => s.trim()).filter(Boolean))]
      .filter((s) => s.length <= 50)
      .slice(0, APP_CONSTANTS.MAX_JOB_TAGS);
    data.tags = await Promise.all(
      skills.map(async (s) => {
        const { id, label, value, createdBy } = await resolveTag(s, user.id);
        return { id, label, value, createdBy };
      }),
    );
    if (data.tags.length) filled.push("skills");

    if (job.description.trim()) {
      data.description = md.render(job.description.trim());
      filled.push("description");
    }

    return { success: true, data };
  } catch (error) {
    log.error("Job import failed", { error: String(error) });
    return {
      success: false,
      message: "Something went wrong while reading the job. Please try again.",
    };
  }
}
