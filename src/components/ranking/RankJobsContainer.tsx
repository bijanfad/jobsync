"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Trash2 } from "lucide-react";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { ResponsiveCardHeader } from "@/components/ResponsiveCardHeader";
import { Button } from "@/components/ui/button";
import { toastActionResult } from "@/lib/toast";
import { deleteRanking } from "@/actions/ranking.actions";
import type { RankingSummary } from "@/models/jobRanking.model";
import { DeleteAlertDialog } from "@/components/DeleteAlertDialog";
import { RankingUpload } from "./RankingUpload";
import { FindJobs } from "./FindJobs";
import type { JobSearchView } from "@/models/jobSearch.model";
import { RankingProgress, rankingStatusLabel } from "./RankingProgress";

export function RankJobsContainer({
  rankings,
  searches,
}: {
  rankings: RankingSummary[];
  searches: { searches: JobSearchView[]; hasAdzunaKey: boolean };
}) {
  const router = useRouter();
  const [pending, setPending] = useState<RankingSummary | null>(null);

  const remove = async () => {
    const r = pending;
    setPending(null);
    if (!r) return;
    toastActionResult(await deleteRanking(r.id), {
      success: "Ranking deleted",
      onSuccess: () => router.refresh(),
    });
  };

  return (
    <Card>
      <ResponsiveCardHeader>
        <CardTitle>Find &amp; rank jobs</CardTitle>
      </ResponsiveCardHeader>
      <CardContent className="space-y-6">
        <FindJobs initial={searches} />
        <RankingUpload />
        {rankings.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Results and rankings</h3>
            <ul className="divide-y rounded-lg border">
              {rankings.map((r) => (
                <li key={r.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1 space-y-1">
                    <Link
                      href={`/dashboard/rank-jobs/${r.id}`}
                      className="font-medium hover:underline"
                    >
                      {r.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(r.createdAt), "PP")} · {r.total.toLocaleString()} jobs ·{" "}
                      {rankingStatusLabel(r.status)}
                    </p>
                    {r.status !== "done" && <RankingProgress ranking={r} />}
                  </div>
                  <div className="flex gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/dashboard/rank-jobs/${r.id}`}>Open</Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${r.name}`}
                      onClick={() => setPending(r)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
      <DeleteAlertDialog
        pageTitle="ranking"
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        onDelete={remove}
        alertDescription={`"${pending?.name ?? ""}" and its scores will be deleted. Jobs you already added to My Jobs stay.`}
      />
    </Card>
  );
}
