"use server";
import { randomUUID } from "node:crypto";
import { generateText, Output } from "ai";
import prisma from "@/lib/db";
import { getModel } from "@/lib/ai/providers";
import { checkRateLimit } from "@/lib/ai/rate-limiter";
import { MissingCredentialError } from "@/lib/ai/tools/errors";
import { PROVIDER_REGISTRY } from "@/lib/ai/provider-registry";
import { preprocessJob } from "@/lib/ai/tools/preprocessing-job";
import { preprocessResume } from "@/lib/ai/tools/preprocessing";
import {
  RESUME_COMPARE_SYSTEM_PROMPT,
  buildResumeComparePrompt,
} from "@/lib/ai/prompts/resume-compare";
import { APP_CONSTANTS, TEMPERATURES } from "@/lib/constants";
import { resumeDetailInclude } from "@/lib/jobs/resumeDetailInclude";
import {
  getDefaultModelForProvider,
  getUserAiSettings,
} from "@/lib/scraper/automation-run/aiSettings";
import { startAiCall } from "@/lib/aiUsage/tracker";
import { log } from "@/lib/telemetry";
import {
  ResumeCompareSchema,
  type ResumeComparison,
  type ResumeComparisonResult,
} from "@/models/resumeCompare.schema";
import type { JobResponse } from "@/models/job.model";
import type { Resume } from "@/models/profile.model";
import type { ActionResult } from "@/models/action.model";
import { requireUser } from "../shared";

const clampScore = (n: number) =>
  Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));

/**
 * Scores every one of the user's resumes against one job in a single AI call,
 * so the user can see which CV to send. The ranking is saved on the job
 * (best score and CV title for the badge beside the job title); the full Job
 * Match (one resume) stays the place for the detailed analysis.
 */
export async function compareResumesForJob(
  jobId: string,
): Promise<ActionResult<ResumeComparisonResult>> {
  try {
    const user = await requireUser();
    const rateLimit = checkRateLimit(user.id);
    if (!rateLimit.allowed) {
      return {
        success: false,
        message: `Too many AI requests. Try again in ${Math.ceil(rateLimit.resetIn / 1000)} seconds.`,
      };
    }

    const job = await prisma.job.findFirst({
      where: { id: jobId, userId: user.id },
      include: { JobTitle: true, Company: true, Location: true },
    });
    if (!job) return { success: false, message: "Job not found." };
    const jobPre = await preprocessJob(job as unknown as JobResponse);
    if (!jobPre.success) {
      return {
        success: false,
        message:
          "This job's description is too short or missing. Add the full posting first (Edit, then paste it into Job Description).",
      };
    }

    const [resumes, owner] = await Promise.all([
      prisma.resume.findMany({
        where: { profile: { userId: user.id } },
        include: resumeDetailInclude,
        orderBy: { updatedAt: "desc" },
        take: APP_CONSTANTS.RESUME_COMPARE_MAX,
      }),
      prisma.user.findUnique({
        where: { id: user.id },
        select: { defaultResumeId: true },
      }),
    ]);
    if (resumes.length === 0) {
      return {
        success: false,
        message: "You don't have any resumes yet. Add one in Profile → Resumes.",
      };
    }

    const usable: { id: string; title: string; text: string }[] = [];
    const skipped: string[] = [];
    for (const resume of resumes) {
      const pre = await preprocessResume(resume as unknown as Resume);
      if (pre.success) {
        usable.push({
          id: resume.id,
          title: resume.title,
          text: pre.data.normalizedText.slice(
            0,
            APP_CONSTANTS.RESUME_COMPARE_CHARS_PER_RESUME,
          ),
        });
      } else {
        skipped.push(resume.title);
      }
    }
    if (usable.length === 0) {
      return {
        success: false,
        message:
          "None of your resumes has enough content to compare. Check them in Profile → Resumes.",
      };
    }

    const aiSettings = await getUserAiSettings(user.id);
    const provider = aiSettings.provider;
    const modelName = aiSettings.model || getDefaultModelForProvider(provider);
    let model;
    try {
      model = await getModel(provider, modelName, user.id);
    } catch (error) {
      if (error instanceof MissingCredentialError) {
        const name = PROVIDER_REGISTRY[provider]?.displayName ?? provider;
        return {
          success: false,
          message: `Add your ${name} key in Settings > API Keys, or pick another provider in AI Settings.`,
        };
      }
      throw error;
    }

    const nonce = randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase();
    const tracker = startAiCall({
      userId: user.id,
      feature: "job_match",
      provider,
      model: modelName,
      numCtx: APP_CONSTANTS.AI_OLLAMA_NUM_CTX,
    });
    let output;
    try {
      const result = await generateText({
        model,
        output: Output.object({ schema: ResumeCompareSchema }),
        instructions: RESUME_COMPARE_SYSTEM_PROMPT,
        prompt: buildResumeComparePrompt({
          jobText: jobPre.data.normalizedText,
          resumes: usable.map((r, i) => ({ number: i + 1, title: r.title, text: r.text })),
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
      output = ResumeCompareSchema.parse(result.output);
    } catch (error) {
      void tracker.finish({ error });
      log.error("Resume compare AI error", { provider, error: String(error) });
      return {
        success: false,
        message:
          "The AI couldn't compare your resumes this time. Try again, or check your AI Settings.",
      };
    }

    // One entry per resume, in the model's numbering; a resume the model
    // skipped or numbered twice keeps only its first score.
    const byNumber = new Map<number, (typeof output.results)[number]>();
    for (const r of output.results) {
      if (!byNumber.has(r.resumeNumber)) byNumber.set(r.resumeNumber, r);
    }
    const results: ResumeComparison[] = [];
    usable.forEach((resume, i) => {
      const r = byNumber.get(i + 1);
      if (!r) {
        skipped.push(resume.title);
        return;
      }
      results.push({
        resumeId: resume.id,
        title: resume.title,
        isDefault: resume.id === owner?.defaultResumeId,
        isJobResume: resume.id === job.resumeId,
        score: clampScore(r.score),
        verdict: r.verdict.trim(),
        strengths: r.strengths.map((s) => s.trim()).filter(Boolean).slice(0, 3),
        gaps: r.gaps.map((s) => s.trim()).filter(Boolean).slice(0, 3),
      });
    });
    if (results.length === 0) {
      return {
        success: false,
        message: "The AI couldn't compare your resumes this time. Try again.",
      };
    }
    results.sort((a, b) => b.score - a.score);
    const comparedAt = new Date();
    const data: ResumeComparisonResult = {
      results,
      skipped,
      comparedAt: comparedAt.toISOString(),
    };
    // Saved so the best score shows beside the job title everywhere and the
    // AI Match tab still has the ranking after a reload.
    await prisma.job.updateMany({
      where: { id: job.id, userId: user.id },
      data: {
        bestResumeScore: results[0].score,
        bestResumeTitle: results[0].title,
        resumeComparison: JSON.stringify(data),
        resumeComparedAt: comparedAt,
      },
    });
    return { success: true, data };
  } catch (error) {
    log.error("Resume compare failed", { error: String(error) });
    return {
      success: false,
      message: "Something went wrong while comparing your resumes. Please try again.",
    };
  }
}
