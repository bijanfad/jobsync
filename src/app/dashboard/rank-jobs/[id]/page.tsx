import { Metadata } from "next";
import { notFound } from "next/navigation";
import { getRanking } from "@/actions/ranking.actions";
import { RankingDetail } from "@/components/ranking/RankingDetail";

export const metadata: Metadata = {
  title: "Ranked jobs | JobSync",
};

export default async function RankingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const { id } = await params;
  const newOnly = (await searchParams).new === "1";
  const result = await getRanking(id, 1, newOnly ? { newOnly } : {});
  if (!result.success || !result.data) notFound();
  return (
    <div className="col-span-3">
      <RankingDetail rankingId={id} initial={result.data} initialNewOnly={newOnly} />
    </div>
  );
}
