"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import prisma from "@/lib/db";
import { encrypt, getLast4 } from "@/lib/encryption";
import { log } from "@/lib/telemetry";
import {
  ADZUNA_KEY_PROVIDER,
  isSearchRunning,
  parseCompanies,
  parseRunSummary,
  parseSources,
  runJobSearch,
} from "@/lib/jobs/search/run";
import {
  CAREER_SOURCE_IDS,
  SEARCH_LIMITS,
  SEARCH_SOURCE_IDS,
  splitKeywords,
  type JobSearchesData,
  type JobSearchInput,
  type JobSearchView,
  type SearchCompanies,
} from "@/models/jobSearch.model";
import { RankingSetupError } from "@/lib/jobs/ranking/score";
import { checkRateLimit } from "@/lib/ai/rate-limiter";
import { suggestTitlesFromCvs, type SuggestedTitle } from "@/lib/jobs/search/suggestTitles";
import type { ActionResult } from "@/models/action.model";
import { requireUser } from "./shared";
import { alertRecipient, isEmailConfigured, sendMail } from "@/lib/email/mailer";

const fail = (message: string) => ({ success: false as const, message });
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** "https://acme.jobs.personio.de/job/1", "acme.recruitee.com" or "acme" → "acme". */
function companySlug(source: string, raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.split("/").filter(Boolean);
    if (source === "personio" && host.endsWith(".jobs.personio.de")) s = host.split(".")[0];
    else if (source === "personio" && host.endsWith(".jobs.personio.com")) s = host.split(".")[0];
    else if (source === "recruitee" && host.endsWith(".recruitee.com")) s = host.split(".")[0];
    else if (
      ["smartrecruiters", "greenhouse", "lever", "ashby"].includes(source) &&
      /(smartrecruiters\.com|greenhouse\.io|lever\.co|ashbyhq\.com)$/.test(host) &&
      path[0]
    ) {
      s = path[0] === "v1" && path[1] === "companies" ? path[2] : path[0];
    }
  } catch {
    // Not a link: take it as the slug itself.
  }
  return SLUG.test(s) ? s : null;
}

const SearchInputSchema = z.object({
  name: z.string().trim().min(1, "Give the search a name.").max(100),
  keywords: z.string().max(6_000),
  location: z.string().trim().max(100).optional(),
  radiusKm: z.number().int().min(0).max(500),
  maxAgeDays: z.number().int().min(1).max(60),
  sources: z.array(z.enum(SEARCH_SOURCE_IDS as [string, ...string[]])).min(1, "Pick at least one site."),
  companies: z.record(z.string(), z.array(z.string())),
  daily: z.boolean(),
  emailAlerts: z.boolean().optional(),
  emailMinScore: z.number().int().min(0).max(100).optional(),
});

function toView(s: {
  id: string;
  name: string;
  keywords: string;
  location: string | null;
  radiusKm: number;
  maxAgeDays: number;
  sources: string;
  companies: string;
  daily: boolean;
  emailAlerts: boolean;
  emailMinScore: number;
  rankingId: string | null;
  status: string;
  lastRunAt: Date | null;
  lastRun: string | null;
}): JobSearchView {
  return {
    id: s.id,
    name: s.name,
    keywords: s.keywords,
    location: s.location,
    radiusKm: s.radiusKm,
    maxAgeDays: s.maxAgeDays,
    sources: parseSources(s.sources),
    companies: parseCompanies(s.companies),
    daily: s.daily,
    emailAlerts: s.emailAlerts,
    emailMinScore: s.emailMinScore,
    rankingId: s.rankingId,
    status: s.status === "running" || isSearchRunning(s.id) ? "running" : "idle",
    lastRunAt: s.lastRunAt,
    lastRun: parseRunSummary(s.lastRun),
  };
}

export async function getJobSearches(): Promise<ActionResult<JobSearchesData>> {
  try {
    const user = await requireUser();
    const [searches, adzuna] = await Promise.all([
      prisma.jobSearch.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
      }),
      prisma.apiKey.count({ where: { userId: user.id, provider: ADZUNA_KEY_PROVIDER } }),
    ]);
    return {
      success: true,
      data: {
        searches: searches.map(toView),
        hasAdzunaKey: adzuna > 0,
        email: { configured: isEmailConfigured(), to: alertRecipient(user.email) },
      },
    };
  } catch (error) {
    log.error("Get job searches failed", { error: String(error) });
    return fail("Couldn't load your searches.");
  }
}

export async function saveJobSearch(
  input: JobSearchInput,
  id?: string,
): Promise<ActionResult<{ id: string; ignoredCompanies: string[] }>> {
  try {
    const user = await requireUser();
    const parsed = SearchInputSchema.safeParse(input);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the search.");
    const data = parsed.data;
    const keywords = splitKeywords(data.keywords);
    if (keywords.length === 0) return fail("Add at least one keyword, such as IT-Administrator.");

    const companies: SearchCompanies = {};
    const ignored: string[] = [];
    for (const source of CAREER_SOURCE_IDS) {
      if (!data.sources.includes(source)) continue;
      const slugs: string[] = [];
      for (const raw of data.companies[source] ?? []) {
        const slug = companySlug(source, raw);
        if (slug) slugs.push(slug);
        else if (raw.trim()) ignored.push(raw.trim());
      }
      const unique = [...new Set(slugs)].slice(0, SEARCH_LIMITS.MAX_COMPANIES_PER_SOURCE);
      if (unique.length === 0) {
        return fail(`Add at least one company for ${source}, or untick it.`);
      }
      companies[source] = unique;
    }

    const fields = {
      name: data.name,
      // One title per line: a job list from the CVs is read and edited as a list.
      keywords: keywords.join("\n"),
      location: data.location || null,
      radiusKm: data.radiusKm,
      maxAgeDays: data.maxAgeDays,
      sources: JSON.stringify(data.sources),
      companies: JSON.stringify(companies),
      daily: data.daily,
      emailAlerts: data.emailAlerts ?? false,
      emailMinScore: data.emailMinScore ?? 60,
      // Turning alerts off drops an email that was still owed.
      ...(data.emailAlerts ? {} : { digestPendingSince: null }),
    };
    let saved;
    if (id) {
      const updated = await prisma.jobSearch.updateMany({ where: { id, userId: user.id }, data: fields });
      if (updated.count === 0) return fail("Search not found.");
      saved = { id };
    } else {
      const count = await prisma.jobSearch.count({ where: { userId: user.id } });
      if (count >= SEARCH_LIMITS.MAX_SEARCHES) return fail(`You can keep up to ${SEARCH_LIMITS.MAX_SEARCHES} searches.`);
      saved = await prisma.jobSearch.create({ data: { ...fields, userId: user.id }, select: { id: true } });
    }
    revalidatePath("/dashboard/rank-jobs");
    return { success: true, data: { id: saved.id, ignoredCompanies: ignored } };
  } catch (error) {
    log.error("Save job search failed", { error: String(error) });
    return fail("Couldn't save the search. Please try again.");
  }
}

export async function deleteJobSearch(id: string): Promise<ActionResult<null>> {
  try {
    const user = await requireUser();
    // Its ranking stays, with the jobs already found.
    const deleted = await prisma.jobSearch.deleteMany({ where: { id, userId: user.id } });
    if (deleted.count === 0) return fail("Search not found.");
    revalidatePath("/dashboard/rank-jobs");
    return { success: true, data: null };
  } catch (error) {
    log.error("Delete job search failed", { error: String(error) });
    return fail("Couldn't delete the search. Please try again.");
  }
}

/** Starts a run in the background; the page polls getJobSearches for the result. */
export async function runJobSearchNow(id: string): Promise<ActionResult<null>> {
  try {
    const user = await requireUser();
    const search = await prisma.jobSearch.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!search) return fail("Search not found.");
    if (isSearchRunning(search.id)) return fail("This search is already running.");
    void runJobSearch(search.id).catch((error) =>
      log.error("[Find jobs] Run failed", { "search.id": search.id, error: String(error) }),
    );
    return { success: true, data: null };
  } catch (error) {
    log.error("Run job search failed", { error: String(error) });
    return fail("Couldn't start the search. Please try again.");
  }
}

export async function saveAdzunaKey(appId: string, appKey: string): Promise<ActionResult<null>> {
  try {
    const user = await requireUser();
    const id = (appId ?? "").trim();
    const key = (appKey ?? "").trim();
    if (!/^[A-Za-z0-9]{4,64}$/.test(id) || !/^[A-Za-z0-9]{8,128}$/.test(key)) {
      return fail("That doesn't look like an Adzuna app id and key. Copy both from developer.adzuna.com.");
    }
    const { encrypted, iv } = encrypt(`${id}:${key}`);
    await prisma.apiKey.upsert({
      where: { userId_provider: { userId: user.id, provider: ADZUNA_KEY_PROVIDER } },
      create: {
        userId: user.id,
        provider: ADZUNA_KEY_PROVIDER,
        encryptedKey: encrypted,
        iv,
        last4: getLast4(key),
        label: "Adzuna (Find jobs)",
      },
      update: { encryptedKey: encrypted, iv, last4: getLast4(key) },
    });
    return { success: true, data: null };
  } catch (error) {
    log.error("Save Adzuna key failed", { error: String(error) });
    return fail("Couldn't save the Adzuna key. Please try again.");
  }
}

export async function deleteAdzunaKey(): Promise<ActionResult<null>> {
  try {
    const user = await requireUser();
    await prisma.apiKey.deleteMany({ where: { userId: user.id, provider: ADZUNA_KEY_PROVIDER } });
    return { success: true, data: null };
  } catch (error) {
    log.error("Delete Adzuna key failed", { error: String(error) });
    return fail("Couldn't remove the Adzuna key.");
  }
}

/** Reads all the user's CVs with AI and suggests the job titles to search for. */
export async function suggestJobTitles(): Promise<ActionResult<SuggestedTitle[]>> {
  try {
    const user = await requireUser();
    const rateLimit = checkRateLimit(user.id);
    if (!rateLimit.allowed) {
      return fail(`Too many AI requests. Try again in ${Math.ceil(rateLimit.resetIn / 1000)} seconds.`);
    }
    const titles = await suggestTitlesFromCvs(user.id);
    if (titles.length === 0) return fail("The AI didn't suggest any titles. Try again.");
    return { success: true, data: titles };
  } catch (error) {
    if (error instanceof RankingSetupError) {
      return fail(error.message.replace(/, then resume the ranking\.$/, "."));
    }
    log.error("Suggest job titles failed", { error: String(error) });
    return fail("The AI couldn't read your CVs this time. Try again, or check your AI Settings.");
  }
}

/** Sends a short email so the person can see the Gmail settings work. */
export async function sendTestEmail(): Promise<ActionResult<{ to: string }>> {
  try {
    const user = await requireUser();
    if (!isEmailConfigured()) {
      return fail("Email is not set up yet. Add SMTP_USER and SMTP_PASS to your .env file and restart JobSync.");
    }
    const to = alertRecipient(user.email);
    if (!to) return fail("There is no address to send to. Add SMTP_TO to your .env file.");
    await sendMail({
      to,
      subject: "JobSync: test email",
      text: "This is a test from JobSync. Email alerts for Find jobs are working.",
      html: "<p>This is a test from JobSync. Email alerts for <b>Find jobs</b> are working.</p>",
    });
    return { success: true, data: { to } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("Test email failed", { error: message });
    return fail(message);
  }
}
