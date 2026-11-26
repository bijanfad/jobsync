import { Metadata } from "next";
import { notFound } from "next/navigation";
import { getRanking } from "@/actions/ranking.actions";
import { RankingDetail } from "@/components/ranking/RankingDetail";

export const metadata: Metadata = {
  title: "Ranked jobs | JobSync",
};

export default async function RankingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await getRanking(id);
  if (!result.success || !result.data) notFound();
  return (
    <div className="col-span-3">
      <RankingDetail rankingId={id} initial={result.data} />
    </div>
  );
}
