import "server-only";

import { randomUUID } from "node:crypto";
import { generateText, Output, type LanguageModel } from "ai";
import prisma from "@/lib/db";
import { getModel } from "@/lib/ai/providers";
import { MissingCredentialError } from "@/lib/ai/tools/errors";
import { PROVIDER_REGISTRY } from "@/lib/ai/provider-registry";
import { preprocessResume } from "@/lib/ai/tools/preprocessing";
import { JOB_RANK_SYSTEM_PROMPT, buildJobRankPrompt } from "@/lib/ai/prompts/job-rank";
import { APP_CONSTANTS, TEMPERATURES } from "@/lib/constants";
import { resumeDetailInclude } from "@/lib/jobs/resumeDetailInclude";
import {
  getDefaultModelForProvider,
  getUserAiSettings,
} from "@/lib/scraper/automation-run/aiSettings";
import { startAiCall } from "@/lib/aiUsage/tracker";
import { JobRankSchema } from "@/models/jobRank.schema";
import type { Resume } from "@/models/profile.model";

/** CV text per resume in every batch: the CVs repeat in each call, so they stay short. */
const RESUME_CHARS = 3_500;
/** Job description sent per job. */
const JOB_DESCRIPTION_CHARS = 1_800;

export class RankingSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RankingSetupError";
  }
}

export interface RankResume {
  id: string;
  title: string;
  text: string;
}

export interface RankScorer {
  resumes: RankResume[];
  model: LanguageModel;
  provider: string;
  modelName: string;
}

/** Loads the user's CVs and AI model once per worker run. */
export async function prepareScorer(userId: string): Promise<RankScorer> {
  const resumes = await prisma.resume.findMany({
    where: { profile: { userId } },
    include: resumeDetailInclude,
    orderBy: { updatedAt: "desc" },
    take: APP_CONSTANTS.RESUME_COMPARE_MAX,
  });
  const usable: RankResume[] = [];
  for (const resume of resumes) {
    const pre = await preprocessResume(resume as unknown as Resume);
    if (pre.success) {
      usable.push({
        id: resume.id,
        title: resume.title,
        text: pre.data.normalizedText.slice(0, RESUME_CHARS),
      });
    }
  }
  if (usable.length === 0) {
    throw new RankingSetupError(
      resumes.length === 0
        ? "You don't have any resumes yet. Add one in Profile → Resumes, then resume the ranking."
        : "None of your resumes has enough content to compare. Check them in Profile → Resumes, then resume the ranking.",
    );
  }

  const aiSettings = await getUserAiSettings(userId);
  const provider = aiSettings.provider;
  const modelName = aiSettings.model || getDefaultModelForProvider(provider);
  try {
    const model = await getModel(provider, modelName, userId);
    return { resumes: usable, model, provider, modelName };
  } catch (error) {
    if (error instanceof MissingCredentialError) {
      const name = PROVIDER_REGISTRY[provider]?.displayName ?? provider;
      throw new RankingSetupError(
        `Add your ${name} key in Settings > API Keys, or pick another provider in AI Settings, then resume the ranking.`,
      );
    }
    throw error;
  }
}

export interface RankRow {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  category: string | null;
  language: string | null;
  remote: string | null;
  experience: string | null;
  skills: string | null;
  degree: string | null;
  description: string | null;
}

export interface RowScore {
  score: number;
  resumeId: string;
  resumeTitle: string;
  reason: string;
}

const clampScore = (n: number) =>
  Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));

function factsOf(row: RankRow): string[] {
  const facts: [string, string | null][] = [
    ["Company", row.company],
    ["Location", row.location],
    ["Field", row.category],
    ["Languages", row.language],
    ["Remote", row.remote],
    ["Experience (years)", row.experience],
    ["Skills", row.skills],
    ["Degree", row.degree],
  ];
  return facts
    .filter(([, v]) => v && !/^(unbekannt|unknown|unclear|n\/a|-)$/i.test(v.trim()))
    .map(([k, v]) => `${k}: ${v}`);
}

/**
 * Scores one batch of rows against all CVs in a single AI call. Rows the
 * model left out are missing from the returned map.
 */
export async function scoreBatch(
  userId: string,
  scorer: RankScorer,
  rows: RankRow[],
): Promise<Map<string, RowScore>> {
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
      output: Output.object({ schema: JobRankSchema }),
      instructions: JOB_RANK_SYSTEM_PROMPT,
      prompt: buildJobRankPrompt({
        resumes: scorer.resumes.map((r, i) => ({ number: i + 1, title: r.title, text: r.text })),
        jobs: rows.map((row, i) => ({
          number: i + 1,
          title: row.title,
          facts: factsOf(row),
          description: row.description?.slice(0, JOB_DESCRIPTION_CHARS) ?? null,
        })),
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
    output = JobRankSchema.parse(result.output);
  } catch (error) {
    void tracker.finish({ error });
    throw error;
  }

  const scores = new Map<string, RowScore>();
  for (const r of output.results) {
    const row = rows[r.jobNumber - 1];
    if (!row || scores.has(row.id)) continue;
    const resume = scorer.resumes[r.resumeNumber - 1] ?? scorer.resumes[0];
    scores.set(row.id, {
      score: clampScore(r.score),
      resumeId: resume.id,
      resumeTitle: resume.title,
      reason: r.reason.trim().slice(0, 300),
    });
  }
  return scores;
}
