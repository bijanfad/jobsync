"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toastError } from "@/lib/toast";
import { parseRankingCsv, type ParsedRankingCsv } from "@/lib/jobs/ranking/csv";
import { addRankingRows, createRanking, startRanking } from "@/actions/ranking.actions";
import { RANKING_LIMITS } from "@/models/jobRanking.model";

const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  company: "Company",
  location: "Location",
  url: "Link",
  category: "Job type",
  datePosted: "Date",
  language: "Language",
  remote: "Remote",
  experience: "Experience",
  skills: "Skills",
  degree: "Degree",
};

/** Pick a CSV, check what was found, then upload it in chunks and start. */
export function RankingUpload() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<ParsedRankingCsv | null>(null);
  const [uploaded, setUploaded] = useState<number | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setParsed(parseRankingCsv(await file.text()));
  };

  const reset = () => {
    setParsed(null);
    setFileName("");
    setUploaded(null);
    if (input.current) input.current.value = "";
  };

  const upload = async () => {
    if (!parsed || parsed.rows.length === 0) return;
    const rows = parsed.rows;
    setUploaded(0);
    const created = await createRanking(fileName.replace(/\.csv$/i, ""), rows.length);
    if (!created.success || !created.data) {
      toastError(created.success ? undefined : created.message);
      setUploaded(null);
      return;
    }
    const id = created.data.id;
    for (let start = 0; start < rows.length; start += RANKING_LIMITS.UPLOAD_CHUNK) {
      const chunk = rows.slice(start, start + RANKING_LIMITS.UPLOAD_CHUNK);
      const res = await addRankingRows(id, start, chunk);
      if (!res.success) {
        toastError(res.message);
        setUploaded(null);
        return;
      }
      setUploaded(start + chunk.length);
    }
    const started = await startRanking(id);
    if (!started.success) {
      toastError(started.message);
      setUploaded(null);
      return;
    }
    router.push(`/dashboard/rank-jobs/${id}`);
  };

  const busy = uploaded !== null;
  const withLink = parsed?.rows.filter((r) => r.url).length ?? 0;

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <h3 className="font-medium">Rank a job list</h3>
        <p className="text-sm text-muted-foreground">
          Upload a CSV with one job per row. JobSync opens each job&apos;s link on the server,
          reads the posting (following listing pages on to the real job page), and scores
          every job against all your CVs. Nothing is added to My Jobs until you choose.
        </p>
      </div>

      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        data-testid="ranking-file"
        onChange={(e) => onFile(e.target.files?.[0])}
      />

      {!parsed ? (
        <Button variant="outline" onClick={() => input.current?.click()}>
          <FileUp className="mr-2 h-4 w-4" />
          Choose CSV file
        </Button>
      ) : parsed.error ? (
        <div className="space-y-2">
          <p className="text-sm text-destructive">{parsed.error}</p>
          <Button variant="outline" size="sm" onClick={reset}>
            Choose another file
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            <span className="font-medium">{fileName}</span>:{" "}
            {parsed.rows.length.toLocaleString()} jobs, {withLink.toLocaleString()} with a link.
            {parsed.duplicates > 0 &&
              ` ${parsed.duplicates} duplicate${parsed.duplicates === 1 ? "" : "s"} left out.`}
            {parsed.skipped > 0 &&
              ` ${parsed.skipped} row${parsed.skipped === 1 ? "" : "s"} without a title left out.`}
            {parsed.truncated &&
              ` Only the first ${RANKING_LIMITS.MAX_ROWS.toLocaleString()} are used.`}
          </p>
          <p className="text-xs text-muted-foreground">
            Columns found:{" "}
            {Object.entries(parsed.columns)
              .map(([field, header]) => `${FIELD_LABELS[field] ?? field} (“${header}”)`)
              .join(", ")}
          </p>
          {!parsed.columns.url && (
            <p className="text-xs text-amber-600">
              No link column was found, so jobs are scored from the CSV columns only.
            </p>
          )}
          {busy ? (
            <div className="space-y-1">
              <Progress value={(uploaded / parsed.rows.length) * 100} className="h-2" />
              <p className="text-xs text-muted-foreground">
                Uploading {uploaded.toLocaleString()} of {parsed.rows.length.toLocaleString()}…
              </p>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button onClick={upload} disabled={parsed.rows.length === 0}>
                Start ranking
              </Button>
              <Button variant="ghost" onClick={reset}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
