import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/actions/jobSearch.actions", () => ({
  saveJobSearch: vi.fn(),
  saveAdzunaKey: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

import { saveAdzunaKey, saveJobSearch } from "@/actions/jobSearch.actions";
import { JobSearchDialog } from "@/components/ranking/JobSearchDialog";

describe("JobSearchDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves keywords, place, sites and companies, then searches", async () => {
    (saveJobSearch as any).mockResolvedValue({ success: true, data: { id: "s-1", ignoredCompanies: [] } });
    (saveAdzunaKey as any).mockResolvedValue({ success: true, data: null });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<JobSearchDialog open onOpenChange={vi.fn()} search={null} hasAdzunaKey={false} onSaved={onSaved} />);

    await user.type(screen.getByLabelText(/Keywords/), "IT-Administrator, SOC");
    await user.type(screen.getByLabelText(/Place/), "Köln");
    await user.click(screen.getByRole("checkbox", { name: /Personio/ }));
    await user.type(screen.getByLabelText("Personio companies"), "proact\nacme");
    await user.click(screen.getByRole("checkbox", { name: /Adzuna/ }));
    await user.type(screen.getByLabelText("Adzuna app id"), "abcd1234");
    await user.type(screen.getByLabelText("Adzuna app key"), "0123456789abcdef");
    await user.click(screen.getByRole("button", { name: "Save and search now" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("s-1", true));
    expect(saveAdzunaKey).toHaveBeenCalledWith("abcd1234", "0123456789abcdef");
    const [input] = (saveJobSearch as any).mock.calls[0];
    expect(input).toMatchObject({
      name: "IT-Administrator",
      keywords: "IT-Administrator, SOC",
      location: "Köln",
      radiusKm: 50,
      maxAgeDays: 7,
      daily: true,
      companies: { personio: ["proact", "acme"] },
    });
    expect(input.sources).toEqual(["bundesagentur", "arbeitnow", "personio", "adzuna"]);
  });
});
