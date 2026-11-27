import "server-only";

import { randomUUID } from "node:crypto";
import { generateText, Output } from "ai";
import { z } from "zod";
import { JOB_TITLES_SYSTEM_PROMPT, buildJobTitlesPrompt } from "@/lib/ai/prompts/job-titles";
import { APP_CONSTANTS, TEMPERATURES } from "@/lib/constants";
import { startAiCall } from "@/lib/aiUsage/tracker";
import { prepareScorer } from "@/lib/jobs/ranking/score";
import { SEARCH_LIMITS } from "@/models/jobSearch.model";

export const JobTitlesSchema = z.object({
  titles: z
    .array(
      z.object({
        title: z.string(),
        fit: z.enum(["core", "adjacent"]).catch("core"),
        why: z.string().catch(""),
      }),
    )
    .catch([]),
});

export interface SuggestedTitle {
  title: string;
  fit: "core" | "adjacent";
  why: string;
}

const RESUME_CHARS = 6_000;
const foldKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß]+/g, "");

/** Cleans a title the way a job search wants it: no "(m/w/d)", no stray punctuation. */
export function cleanSearchTitle(raw: string): string {
  return raw
    .replace(/\((?:[mwfdx]\s*\/\s*){1,3}[mwfdx]\)|\((?:all genders|alle geschlechter)\)/gi, "")
    .replace(/[“”"]/g, "")
    .replace(/[,;\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * Reads all of the user's CVs (one AI call) and returns the job titles worth
 * searching for, core fits first. Throws RankingSetupError when there are no
 * usable CVs or no AI key.
 */
export async function suggestTitlesFromCvs(userId: string): Promise<SuggestedTitle[]> {
  const scorer = await prepareScorer(userId, RESUME_CHARS);
  const nonce = randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase();
  const tracker = startAiCall({
    userId,
    feature: "job_rank",
    provider: scorer.provider,
    model: scorer.modelName,
    numCtx: APP_CONSTANTS.AI_OLLAMA_NUM_CTX,
  });
  let output;
  try {
    const result = await generateText({
      model: scorer.model,
      output: Output.object({ schema: JobTitlesSchema }),
      instructions: JOB_TITLES_SYSTEM_PROMPT,
      prompt: buildJobTitlesPrompt({
        resumes: scorer.resumes.map((r, i) => ({ number: i + 1, title: r.title, text: r.text })),
        nonce,
      }),
      temperature: TEMPERATURES.ANALYSIS,
      abortSignal: AbortSignal.timeout(APP_CONSTANTS.AI_JOB_MATCH_TIMEOUT_MS),
      providerOptions: {
        ollama: { options: { num_ctx: APP_CONSTANTS.AI_OLLAMA_NUM_CTX } },
        openai: { strictJsonSchema: false },
      },
    });
    void tracker.finish({ usage: result.usage, finishReason: result.finishReason });
    output = JobTitlesSchema.parse(result.output);
  } catch (error) {
    void tracker.finish({ error });
    throw error;
  }

  const seen = new Set<string>();
  const titles: SuggestedTitle[] = [];
  for (const t of output.titles) {
    const title = cleanSearchTitle(t.title);
    const key = foldKey(title);
    if (title.length < 2 || seen.has(key)) continue;
    seen.add(key);
    titles.push({ title, fit: t.fit, why: t.why.trim().slice(0, 160) });
  }
  // Core fits first, keeping the model's order within each group.
  return [...titles.filter((t) => t.fit === "core"), ...titles.filter((t) => t.fit === "adjacent")].slice(
    0,
    SEARCH_LIMITS.MAX_KEYWORDS,
  );
}
