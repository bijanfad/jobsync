"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ExternalLink,
  FileCheck2,
  FileWarning,
  Loader2,
  Pause,
  Play,
  Plus,
} from "lucide-react";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { ResponsiveCardHeader } from "@/components/ResponsiveCardHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { BestCvBadge } from "@/components/myjobs/BestCvBadge";
import { toastError, toastSuccess } from "@/lib/toast";
import {
  addRankedJobsToMyJobs,
  getRanking,
  pauseRanking,
  startRanking,
  type RankingPage,
} from "@/actions/ranking.actions";
import { RANKING_LIMITS, type RankingRowFilter, type RankingRowView } from "@/models/jobRanking.model";
import { RankingProgress, rankingStatusLabel } from "./RankingProgress";

const POLL_MS = 5_000;

const MIN_SCORES = [
  { value: "any", label: "Any score" },
  { value: "50", label: "50 and up" },
  { value: "65", label: "65 and up" },
  { value: "80", label: "80 and up" },
];

function LoadIcon({ row }: { row: RankingRowView }) {
  if (row.loadStatus === "loaded") {
    return (
      <FileCheck2
        className="h-4 w-4 text-emerald-600"
        aria-label="Description read from the job page"
      >
        <title>Description read from the job page</title>
      </FileCheck2>
    );
  }
  if (row.loadStatus === "pending") {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Not read yet" />;
  }
  const why = row.loadError ?? "The page couldn't be read.";
  return (
    <FileWarning className="h-4 w-4 text-amber-600" aria-label={`Scored from the CSV only: ${why}`}>
      <title>{`Scored from the CSV only: ${why}`}</title>
    </FileWarning>
  );
}

export function RankingDetail({ rankingId, initial }: { rankingId: string; initial: RankingPage }) {
  const [data, setData] = useState<RankingPage>(initial);
  const [page, setPage] = useState(1);
  const [minScore, setMinScore] = useState("any");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [loadedOnly, setLoadedOnly] = useState(false);
  const [hideAdded, setHideAdded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const filter: RankingRowFilter = {
    minScore: minScore === "any" ? undefined : Number(minScore),
    search: query || undefined,
    loadedOnly,
    hideAdded,
  };
  const filterKey = JSON.stringify(filter);

  const apply = useCallback((res: Awaited<ReturnType<typeof getRanking>>) => {
    if (!res.success) toastError(res.message);
    else if (res.data) setData(res.data);
  }, []);

  const refresh = useCallback(async () => {
    apply(await getRanking(rankingId, page, JSON.parse(filterKey)));
  }, [apply, rankingId, page, filterKey]);

  // The first page comes from the server; later pages and filters load here.
  useEffect(() => {
    let live = true;
    getRanking(rankingId, page, JSON.parse(filterKey)).then((res) => {
      if (live) apply(res);
    });
    return () => {
      live = false;
    };
  }, [apply, rankingId, page, filterKey]);

  const running = data.ranking.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [running, refresh]);

  // Search waits for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [search]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < RANKING_LIMITS.MAX_ADD_AT_ONCE) next.add(id);
      return next;
    });

  const addable = data.rows.filter((r) => !r.jobId);
  const allOnPage = addable.length > 0 && addable.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPage) addable.forEach((r) => next.delete(r.id));
      else addable.forEach((r) => next.size < RANKING_LIMITS.MAX_ADD_AT_ONCE && next.add(r.id));
      return next;
    });

  const add = async (ids: string[]) => {
    setAdding(true);
    const res = await addRankedJobsToMyJobs(ids);
    setAdding(false);
    if (!res.success) {
      toastError(res.message);
      return;
    }
    const { added, duplicates } = res.data ?? { added: 0, duplicates: 0 };
    toastSuccess(
      `${added} added to My Jobs${duplicates ? `, ${duplicates} were already there` : ""}.`,
    );
    setSelected(new Set());
    void refresh();
  };

  const toggleRun = async () => {
    const res = running ? await pauseRanking(rankingId) : await startRanking(rankingId);
    if (!res.success) toastError(res.message);
    void refresh();
  };

  const { ranking, rows, matching, pageSize } = data;
  const pages = Math.max(1, Math.ceil(matching / pageSize));
  const canRun = ranking.status === "running" || ranking.status === "paused" || ranking.status === "uploading";

  return (
    <Card>
      <ResponsiveCardHeader>
        <div className="min-w-0 space-y-1">
          <Link
            href="/dashboard/rank-jobs"
            className="inline-flex items-center text-xs text-muted-foreground hover:underline"
          >
            <ArrowLeft className="mr-1 h-3 w-3" /> All rankings
          </Link>
          <CardTitle className="truncate">{ranking.name}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {ranking.total.toLocaleString()} jobs · {rankingStatusLabel(ranking.status)}
          </p>
        </div>
        {canRun && (
          <Button variant="outline" onClick={toggleRun}>
            {running ? <Pause className="mr-2 h-4 w-4" /> : <Play className="mr-2 h-4 w-4" />}
            {running ? "Pause" : "Resume"}
          </Button>
        )}
      </ResponsiveCardHeader>
      <CardContent className="space-y-4">
        {ranking.error && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            {ranking.error}
          </p>
        )}
        {ranking.status !== "done" && <RankingProgress ranking={ranking} />}
        {running && (
          <p className="text-xs text-muted-foreground">
            This runs on your server, so you can close this page. Scores appear as they come in.
          </p>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="ranking-search" className="text-xs">Search</Label>
            <Input
              id="ranking-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Title, company or place"
              className="h-9 w-56"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Score</Label>
            <Select
              value={minScore}
              onValueChange={(v) => {
                setMinScore(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9 w-36" aria-label="Minimum score">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MIN_SCORES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Switch
              id="ranking-loaded"
              checked={loadedOnly}
              onCheckedChange={(v) => {
                setLoadedOnly(v);
                setPage(1);
              }}
            />
            <Label htmlFor="ranking-loaded" className="text-xs">With description only</Label>
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Switch
              id="ranking-hide-added"
              checked={hideAdded}
              onCheckedChange={(v) => {
                setHideAdded(v);
                setPage(1);
              }}
            />
            <Label htmlFor="ranking-hide-added" className="text-xs">Hide jobs in My Jobs</Label>
          </div>
          <div className="ml-auto pb-1">
            <Button disabled={selected.size === 0 || adding} onClick={() => add([...selected])}>
              {adding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Add {selected.size || ""} to My Jobs
            </Button>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <input
                  type="checkbox"
                  aria-label="Select all on this page"
                  checked={allOnPage}
                  onChange={toggleAll}
                />
              </TableHead>
              <TableHead className="w-16">Score</TableHead>
              <TableHead>Job</TableHead>
              <TableHead className="hidden lg:table-cell">Why</TableHead>
              <TableHead className="w-28 text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                  {matching === 0 && ranking.scored === 0 && running
                    ? "Reading the first job pages…"
                    : "No jobs match these filters."}
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <TableRow key={row.id} data-testid="ranking-row">
                <TableCell>
                  {!row.jobId && (
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.title}`}
                      checked={selected.has(row.id)}
                      onChange={() => toggle(row.id)}
                    />
                  )}
                </TableCell>
                <TableCell>
                  {row.score != null ? (
                    <BestCvBadge score={row.score} title={row.bestResumeTitle} comparedAt={row.scoredAt} />
                  ) : (
                    <span className="text-xs text-muted-foreground" title={row.scoreError ?? undefined}>
                      {row.scoredAt ? "–" : "…"}
                    </span>
                  )}
                </TableCell>
                <TableCell className="max-w-md">
                  <div className="flex items-start gap-1.5">
                    <span className="mt-0.5 shrink-0">
                      <LoadIcon row={row} />
                    </span>
                    <div className="min-w-0">
                      <div className="font-medium leading-tight">
                        {row.url ? (
                          <a
                            href={row.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                          >
                            {row.title}
                            <ExternalLink className="ml-1 inline h-3 w-3 opacity-60" />
                          </a>
                        ) : (
                          row.title
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {[row.company, row.location, row.category, row.datePosted, row.source]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {row.reason && (
                        <p className="text-xs text-muted-foreground lg:hidden">{row.reason}</p>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden max-w-sm text-xs text-muted-foreground lg:table-cell">
                  {row.reason}
                </TableCell>
                <TableCell className="text-right">
                  {row.jobId ? (
                    <Link
                      href={`/dashboard/myjobs/${row.jobId}`}
                      className="text-xs text-primary hover:underline"
                    >
                      In My Jobs
                    </Link>
                  ) : (
                    <Button size="sm" variant="ghost" disabled={adding} onClick={() => add([row.id])}>
                      Add
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {matching.toLocaleString()} jobs · page {data.page} of {pages}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>
              Previous
            </Button>
            <Button size="sm" variant="outline" disabled={data.page >= pages} onClick={() => setPage(data.page + 1)}>
              Next
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
