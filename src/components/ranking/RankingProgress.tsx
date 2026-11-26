import { Progress } from "@/components/ui/progress";
import type { RankingSummary } from "@/models/jobRanking.model";

const STATUS_LABEL: Record<string, string> = {
  uploading: "Upload not finished",
  running: "Running",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
};

export function rankingStatusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export function RankingProgress({ ranking }: { ranking: RankingSummary }) {
  const { total, loaded, loadFailed, scored } = ranking;
  const read = loaded + loadFailed;
  const pct = total > 0 ? Math.round(((read + scored) / (2 * total)) * 100) : 0;
  return (
    <div className="space-y-1" data-testid="ranking-progress">
      <Progress value={pct} className="h-2" />
      <p className="text-xs text-muted-foreground">
        {read.toLocaleString()} of {total.toLocaleString()} links read ({loaded.toLocaleString()}{" "}
        with a description, {loadFailed.toLocaleString()} from the CSV only) ·{" "}
        {scored.toLocaleString()} scored
      </p>
    </div>
  );
}
