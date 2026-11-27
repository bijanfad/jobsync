import "server-only";

import prisma from "@/lib/db";
import { log } from "@/lib/telemetry";
import {
  alertRecipient,
  appBaseUrl,
  escapeHtml,
  isEmailConfigured,
  sendMail,
} from "@/lib/email/mailer";

// The daily email: once a run's new jobs are scored, one message per search
// with the ones that reached its minimum score, best first. Nothing is sent
// when none did.

/** Send what is scored by then, even if some jobs are still waiting. */
export const DIGEST_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
/** Give up on an email that keeps failing after this long. */
export const DIGEST_GIVE_UP_MS = 24 * 60 * 60 * 1000;
export const DIGEST_MAX_ROWS = 30;

export interface DigestRow {
  title: string;
  company: string | null;
  location: string | null;
  url: string | null;
  score: number | null;
  bestResumeTitle: string | null;
  reason: string | null;
  source: string | null;
}

export interface DigestContent {
  searchName: string;
  rows: DigestRow[];
  /** All new jobs at or above the minimum score (rows holds the top ones). */
  matches: number;
  /** All new jobs found since the last email. */
  found: number;
  minScore: number;
  resultsUrl: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function digestSubject(c: DigestContent): string {
  const what = c.matches === 1 ? "1 new job match" : `${c.matches} new job matches`;
  return `JobSync: ${what} for “${c.searchName}”`;
}

export function buildDigestEmail(c: DigestContent): { subject: string; html: string; text: string } {
  const subject = digestSubject(c);
  const intro = `${plural(c.found, "new job")} found, ${c.matches} with a score of ${c.minScore} or more.`;
  const more =
    c.matches > c.rows.length ? `Showing the best ${c.rows.length}. See all in JobSync.` : "";

  const textRows = c.rows.map((r) => {
    const meta = [r.company, r.location, r.source].filter(Boolean).join(" · ");
    return [
      `${r.score ?? "–"}  ${r.title}${meta ? ` (${meta})` : ""}`,
      r.bestResumeTitle ? `    Best CV: ${r.bestResumeTitle}` : null,
      r.reason ? `    ${r.reason}` : null,
      r.url ? `    ${r.url}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });
  const text = [intro, ...(more ? [more] : []), "", textRows.join("\n\n"), "", `All results: ${c.resultsUrl}`].join(
    "\n",
  );

  const color = (s: number | null) =>
    s == null ? "#6b7280" : s >= 75 ? "#15803d" : s >= 50 ? "#b45309" : "#b91c1c";
  const htmlRows = c.rows
    .map((r) => {
      const meta = [r.company, r.location, r.source].filter(Boolean).map((v) => escapeHtml(v!)).join(" · ");
      const title = r.url
        ? `<a href="${escapeHtml(r.url)}" style="color:#1d4ed8;text-decoration:none;font-weight:600">${escapeHtml(r.title)}</a>`
        : `<span style="font-weight:600">${escapeHtml(r.title)}</span>`;
      return `<tr>
<td style="padding:10px 12px 10px 0;vertical-align:top;font-size:18px;font-weight:700;color:${color(r.score)};white-space:nowrap">${r.score ?? "–"}</td>
<td style="padding:10px 0;vertical-align:top;border-bottom:1px solid #e5e7eb">
${title}
${meta ? `<div style="font-size:13px;color:#6b7280">${meta}</div>` : ""}
${r.bestResumeTitle ? `<div style="font-size:13px;color:#374151">Best CV: ${escapeHtml(r.bestResumeTitle)}</div>` : ""}
${r.reason ? `<div style="font-size:13px;color:#4b5563">${escapeHtml(r.reason)}</div>` : ""}
</td></tr>`;
    })
    .join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;max-width:640px;margin:0 auto;padding:16px">
<h2 style="margin:0 0 4px;font-size:20px">New jobs for “${escapeHtml(c.searchName)}”</h2>
<p style="margin:0 0 12px;color:#4b5563">${escapeHtml(intro)}${more ? ` ${escapeHtml(more)}` : ""}</p>
<table style="border-collapse:collapse;width:100%">${htmlRows}</table>
<p style="margin:20px 0 0"><a href="${escapeHtml(c.resultsUrl)}" style="background:#111827;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open all results in JobSync</a></p>
<p style="margin:16px 0 0;font-size:12px;color:#9ca3af">You get this because “Email me new matches” is on for this search in JobSync, Find jobs.</p>
</body></html>`;
  return { subject, html, text };
}

const sending = globalThis as unknown as { __digestSending?: boolean };

/**
 * Sends each search's owed email once its new jobs are scored (or after
 * DIGEST_MAX_WAIT_MS). Called when a ranking finishes and by the hourly
 * scheduler. Never throws.
 */
export async function sendDueDigests(now = new Date()): Promise<void> {
  if (sending.__digestSending) return;
  sending.__digestSending = true;
  try {
    if (!isEmailConfigured()) return;
    const due = await prisma.jobSearch.findMany({
      where: { emailAlerts: true, digestPendingSince: { not: null } },
      select: {
        id: true,
        name: true,
        rankingId: true,
        emailMinScore: true,
        digestPendingSince: true,
        user: { select: { email: true } },
      },
    });
    for (const search of due) {
      try {
        await sendOne(search, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("[Find jobs] Email failed", { "search.id": search.id, error: message });
        if (now.getTime() - search.digestPendingSince!.getTime() > DIGEST_GIVE_UP_MS) {
          await clearPending(search.id);
        }
      }
    }
  } catch (error) {
    log.error("[Find jobs] Email check failed", { error: String(error) });
  } finally {
    sending.__digestSending = false;
  }
}

async function clearPending(searchId: string) {
  await prisma.jobSearch.update({ where: { id: searchId }, data: { digestPendingSince: null } });
}

async function sendOne(
  search: {
    id: string;
    name: string;
    rankingId: string | null;
    emailMinScore: number;
    digestPendingSince: Date | null;
    user: { email: string | null };
  },
  now: Date,
) {
  const since = search.digestPendingSince!;
  if (!search.rankingId) return clearPending(search.id);
  const fresh = { rankingId: search.rankingId, foundAt: { gte: since } };
  const [found, waiting] = await Promise.all([
    prisma.jobRankingRow.count({ where: fresh }),
    prisma.jobRankingRow.count({ where: { ...fresh, scoredAt: null } }),
  ]);
  if (waiting > 0 && now.getTime() - since.getTime() < DIGEST_MAX_WAIT_MS) return;

  const minScore = search.emailMinScore;
  const matchWhere = { ...fresh, score: { gte: minScore } };
  const [matches, rows] = await Promise.all([
    prisma.jobRankingRow.count({ where: matchWhere }),
    prisma.jobRankingRow.findMany({
      where: matchWhere,
      orderBy: [{ score: "desc" }, { position: "asc" }],
      take: DIGEST_MAX_ROWS,
      select: {
        title: true,
        company: true,
        location: true,
        url: true,
        score: true,
        bestResumeTitle: true,
        reason: true,
        source: true,
      },
    }),
  ]);
  const to = alertRecipient(search.user.email);
  if (matches > 0 && to) {
    const email = buildDigestEmail({
      searchName: search.name,
      rows,
      matches,
      found,
      minScore,
      resultsUrl: `${appBaseUrl()}/dashboard/rank-jobs/${search.rankingId}?new=1`,
    });
    await sendMail({ to, ...email });
    log.info("[Find jobs] Email sent", { "search.id": search.id, matches });
  }
  await clearPending(search.id);
}
