import { Metadata } from "next";
import { getRankings } from "@/actions/ranking.actions";
import { RankJobsContainer } from "@/components/ranking/RankJobsContainer";

export const metadata: Metadata = {
  title: "Rank jobs | JobSync",
};

export default async function RankJobsPage() {
  const result = await getRankings();
  return (
    <div className="col-span-3">
      <RankJobsContainer rankings={result.success ? (result.data ?? []) : []} />
    </div>
  );
}
