import { Metadata } from "next";
import { getRankings } from "@/actions/ranking.actions";
import { getJobSearches } from "@/actions/jobSearch.actions";
import { RankJobsContainer } from "@/components/ranking/RankJobsContainer";

export const metadata: Metadata = {
  title: "Find & rank jobs | JobSync",
};

export default async function RankJobsPage() {
  const [result, searches] = await Promise.all([getRankings(), getJobSearches()]);
  return (
    <div className="col-span-3">
      <RankJobsContainer
        rankings={result.success ? (result.data ?? []) : []}
        searches={
          searches.success && searches.data ? searches.data : { searches: [], hasAdzunaKey: false }
        }
      />
    </div>
  );
}
