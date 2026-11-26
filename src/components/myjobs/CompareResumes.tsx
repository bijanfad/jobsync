"use client";

import { useState, useTransition } from "react";
import { Check, Files, Loader2, Minus, Sparkles } from "lucide-react";
import { compareResumesForJob } from "@/actions/job.actions";
import type { ResumeComparisonResult } from "@/models/resumeCompare.schema";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";

// Same bands as the Job Match prompt's scoring guidelines.
export function scoreBand(score: number): { label: string; className: string } {
  if (score >= 80) return { label: "Strong", className: "bg-emerald-600 text-white" };
  if (score >= 65) return { label: "Good", className: "bg-teal-600 text-white" };
  if (score >= 50) return { label: "Partial", className: "bg-amber-500 text-white" };
  return { label: "Weak", className: "bg-rose-600 text-white" };
}

interface CompareResumesProps {
  jobId: string;
  /** Runs the full Job Match with the named resume. */
  onFullMatch: (resumeTitle: string) => void;
  fullMatchDisabled?: boolean;
  /** Why comparing can't run yet, e.g. no job description. */
  blockedReason?: string;
}

export function CompareResumes({
  jobId,
  onFullMatch,
  fullMatchDisabled,
  blockedReason,
}: CompareResumesProps) {
  const [result, setResult] = useState<ResumeComparisonResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const compare = () =>
    startTransition(async () => {
      const res = await compareResumesForJob(jobId);
      if (!res.success) {
        toastError(res.message, "Couldn't compare your CVs");
        return;
      }
      setResult(res.data!);
    });

  return (
    <Card className="p-6" data-testid="compare-resumes">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">Which CV fits best?</h3>
          <p className="text-sm text-muted-foreground">
            Scores every CV you have against this job, so you know which one to
            send. Nothing is saved.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={compare}
          disabled={isPending || !!blockedReason}
          title={blockedReason}
          data-testid="compare-resumes-btn"
        >
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Files className="h-4 w-4" aria-hidden="true" />
          )}
          {isPending
            ? "Comparing your CVs…"
            : result
              ? "Compare again"
              : "Compare all my CVs"}
        </Button>
      </div>

      {result && (
        <ol className="mt-5 space-y-3" aria-label="CVs ranked by fit">
          {result.results.map((r, i) => {
            const band = scoreBand(r.score);
            return (
              <li
                key={r.resumeId}
                className={cn(
                  "rounded-md border p-4",
                  i === 0 && "border-primary/60 bg-primary/5",
                )}
                data-testid="compare-resumes-row"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "inline-flex h-8 min-w-12 items-center justify-center rounded-md px-2 text-sm font-semibold",
                      band.className,
                    )}
                    aria-label={`Score ${r.score} of 100, ${band.label}`}
                  >
                    {r.score}
                  </span>
                  <span className="font-medium">{r.title}</span>
                  {i === 0 && <Badge>Best fit</Badge>}
                  {r.isJobResume && <Badge variant="secondary">Set on this job</Badge>}
                  {r.isDefault && <Badge variant="outline">Default</Badge>}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => onFullMatch(r.title)}
                    disabled={fullMatchDisabled}
                    title="Run the detailed Job Match with this CV"
                  >
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                    Full match with this CV
                  </Button>
                </div>
                {r.verdict && <p className="mt-2 text-sm">{r.verdict}</p>}
                {(r.strengths.length > 0 || r.gaps.length > 0) && (
                  <div className="mt-2 grid gap-2 text-sm md:grid-cols-2">
                    <ul className="space-y-1">
                      {r.strengths.map((s) => (
                        <li key={s} className="flex gap-1.5">
                          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-label="Shows" />
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                    <ul className="space-y-1">
                      {r.gaps.map((s) => (
                        <li key={s} className="flex gap-1.5 text-muted-foreground">
                          <Minus className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-label="Missing" />
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {result && result.skipped.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Not compared (too little content): {result.skipped.join(", ")}
        </p>
      )}
    </Card>
  );
}
