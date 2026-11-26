"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { CalendarClock, Loader2, Pencil, Play, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DeleteAlertDialog } from "@/components/DeleteAlertDialog";
import { toastActionResult, toastError } from "@/lib/toast";
import {
  deleteJobSearch,
  getJobSearches,
  runJobSearchNow,
} from "@/actions/jobSearch.actions";
import { sourceLabel, type JobSearchView, type SearchSourceId } from "@/models/jobSearch.model";
import { JobSearchDialog } from "./JobSearchDialog";

const POLL_MS = 4_000;

function LastRun({ search }: { search: JobSearchView }) {
  const run = search.lastRun;
  if (search.status === "running") {
    return (
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Searching the sites…
      </p>
    );
  }
  if (!run) return <p className="text-xs text-muted-foreground">Not run yet.</p>;
  const parts = (Object.entries(run.sources) as [SearchSourceId, { found: number; added: number; error?: string }][]).map(
    ([id, r]) => (r.error ? null : `${sourceLabel(id)} ${r.added}`),
  );
  const errors = Object.entries(run.sources).filter(([, r]) => r?.error) as [SearchSourceId, { error: string }][];
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      <p>
        {format(new Date(run.at), "PPp")}: {run.added.toLocaleString()} new jobs
        {parts.filter(Boolean).length > 0 && ` (${parts.filter(Boolean).join(", ")})`}
      </p>
      {errors.map(([id, r]) => (
        <p key={id} className="text-amber-700 dark:text-amber-400">
          {sourceLabel(id)}: {r.error}
        </p>
      ))}
    </div>
  );
}

export function FindJobs({
  initial,
}: {
  initial: { searches: JobSearchView[]; hasAdzunaKey: boolean };
}) {
  const [data, setData] = useState(initial);
  const [editing, setEditing] = useState<JobSearchView | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<JobSearchView | null>(null);
  const [kicked, setKicked] = useState(false);

  const refresh = useCallback(async () => {
    const res = await getJobSearches();
    if (res.success && res.data) setData(res.data);
  }, []);

  const running = kicked || data.searches.some((s) => s.status === "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      const res = await getJobSearches();
      if (res.success && res.data) {
        setData(res.data);
        setKicked(false);
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [running]);

  const open = (search: JobSearchView | null) => {
    setEditing(search);
    setDialogKey((k) => k + 1);
    setDialogOpen(true);
  };

  const run = async (id: string) => {
    const res = await runJobSearchNow(id);
    if (!res.success) {
      toastError(res.message);
      return;
    }
    setKicked(true);
    void refresh();
  };

  const remove = async () => {
    const s = pendingDelete;
    setPendingDelete(null);
    if (!s) return;
    toastActionResult(await deleteJobSearch(s.id), { success: "Search deleted", onSuccess: () => void refresh() });
  };

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-1.5 font-medium">
            <Search className="h-4 w-4" /> Find jobs
          </h3>
          <p className="text-sm text-muted-foreground">
            Search the Bundesagentur für Arbeit, arbeitnow, Adzuna and company career pages
            (Personio, Recruitee, SmartRecruiters, Greenhouse, Lever, Ashby). New jobs are ranked
            against your CVs.
          </p>
        </div>
        <Button onClick={() => open(null)} className="shrink-0">
          <Plus className="mr-2 h-4 w-4" /> New search
        </Button>
      </div>

      {data.searches.length > 0 && (
        <ul className="divide-y rounded-md border">
          {data.searches.map((s) => (
            <li key={s.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center" data-testid="job-search">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="font-medium">
                  {s.name}
                  {s.daily && (
                    <span className="ml-2 inline-flex items-center gap-0.5 text-xs font-normal text-muted-foreground">
                      <CalendarClock className="h-3 w-3" /> daily
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {s.keywords}
                  {s.location ? ` · ${s.location}, ${s.radiusKm} km` : " · all of Germany"} ·{" "}
                  {s.sources.map(sourceLabel).join(", ")}
                </p>
                <LastRun search={s} />
              </div>
              <div className="flex flex-wrap gap-2">
                {s.rankingId && (
                  <Button asChild size="sm">
                    <Link href={`/dashboard/rank-jobs/${s.rankingId}`}>Results</Link>
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={s.status === "running"}
                  onClick={() => run(s.id)}
                >
                  <Play className="mr-1 h-3 w-3" /> Search now
                </Button>
                <Button size="icon" variant="ghost" aria-label={`Edit ${s.name}`} onClick={() => open(s)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${s.name}`}
                  onClick={() => setPendingDelete(s)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <JobSearchDialog
        key={dialogKey}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        search={editing}
        hasAdzunaKey={data.hasAdzunaKey}
        onSaved={(id, runNow) => {
          setDialogOpen(false);
          if (runNow) void run(id);
          else void refresh();
        }}
      />
      <DeleteAlertDialog
        pageTitle="search"
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        onDelete={remove}
        alertDescription="The search is deleted. Its results list stays, with the jobs already found."
      />
    </div>
  );
}
