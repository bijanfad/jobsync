import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock("@/actions/ranking.actions", () => ({
  createRanking: vi.fn(),
  addRankingRows: vi.fn(),
  startRanking: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toastError: vi.fn() }));

import { addRankingRows, createRanking, startRanking } from "@/actions/ranking.actions";
import { RankingUpload } from "@/components/ranking/RankingUpload";

const csv = [
  "Title,Company,URL,Skills",
  "Admin,ACME,https://a.de/1,Windows",
  "SOC Analyst,Beta,https://b.de/2,SIEM",
  "SOC Analyst,Beta,https://b.de/2?utm_source=x,SIEM",
].join("\n");

describe("RankingUpload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows what the CSV holds, uploads it and opens the ranking", async () => {
    (createRanking as any).mockResolvedValue({ success: true, data: { id: "rk-1" } });
    (addRankingRows as any).mockResolvedValue({ success: true, data: { added: 2 } });
    (startRanking as any).mockResolvedValue({ success: true, data: null });
    const user = userEvent.setup();
    render(<RankingUpload />);

    await user.upload(screen.getByTestId("ranking-file"), new File([csv], "jobs.csv", { type: "text/csv" }));
    expect(await screen.findByText(/2 jobs, 2 with a link\. 1 duplicate left out\./)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start ranking" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard/rank-jobs/rk-1"));
    expect(createRanking).toHaveBeenCalledWith("jobs", 2);
    expect((addRankingRows as any).mock.calls[0][0]).toBe("rk-1");
    expect((addRankingRows as any).mock.calls[0][2].map((r: any) => r.title)).toEqual(["Admin", "SOC Analyst"]);
    expect(startRanking).toHaveBeenCalledWith("rk-1");
  });

  it("explains a CSV it can't use", async () => {
    const user = userEvent.setup();
    render(<RankingUpload />);
    await user.upload(screen.getByTestId("ranking-file"), new File(["Firma,Link\nA,https://a.de"], "x.csv"));
    expect(await screen.findByText(/Couldn't find a job title column/)).toBeInTheDocument();
    expect(createRanking).not.toHaveBeenCalled();
  });
});
