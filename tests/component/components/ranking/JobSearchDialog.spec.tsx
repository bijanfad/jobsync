import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/actions/jobSearch.actions", () => ({
  saveJobSearch: vi.fn(),
  saveAdzunaKey: vi.fn(),
  suggestJobTitles: vi.fn(),
  sendTestEmail: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

import { saveAdzunaKey, saveJobSearch, sendTestEmail, suggestJobTitles } from "@/actions/jobSearch.actions";
import { toastSuccess } from "@/lib/toast";
import { JobSearchDialog, mergeTitles } from "@/components/ranking/JobSearchDialog";

describe("JobSearchDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves keywords, place, sites and companies, then searches", async () => {
    (saveJobSearch as any).mockResolvedValue({ success: true, data: { id: "s-1", ignoredCompanies: [] } });
    (saveAdzunaKey as any).mockResolvedValue({ success: true, data: null });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<JobSearchDialog open onOpenChange={vi.fn()} search={null} hasAdzunaKey={false} onSaved={onSaved} />);

    await user.type(screen.getByLabelText(/Job list/), "IT-Administrator, SOC");
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
      emailAlerts: false,
      companies: { personio: ["proact", "acme"] },
    });
    expect(input.sources).toEqual(["bundesagentur", "arbeitnow", "personio", "adzuna"]);
  });

  it("builds the job list from the CVs, then from an imported file, without duplicates", async () => {
    (suggestJobTitles as any).mockResolvedValue({
      success: true,
      data: [
        { title: "Systemadministrator", fit: "core", why: "5 years Windows Server" },
        { title: "IT Security Engineer", fit: "adjacent", why: "ISO 27001 course" },
      ],
    });
    (saveJobSearch as any).mockResolvedValue({ success: true, data: { id: "s-2", ignoredCompanies: [] } });
    const user = userEvent.setup();
    render(
      <JobSearchDialog open onOpenChange={vi.fn()} search={null} hasAdzunaKey={false} onSaved={vi.fn()} suggestOnOpen />,
    );

    // Opened from "Job list from my CVs": the AI is asked straight away.
    await waitFor(() => expect(screen.getByLabelText(/Job list/)).toHaveValue("Systemadministrator\nIT Security Engineer"));
    expect(suggestJobTitles).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Name")).toHaveValue("Jobs from my CVs");
    expect(screen.getByText(/2 of 60/)).toBeInTheDocument();

    const file = new File(["Title\nsystemadministrator\nNetzwerkadministrator;Köln\n"], "joblist.csv");
    await user.upload(screen.getByTestId("job-list-file"), file);
    await waitFor(() =>
      expect(screen.getByLabelText(/Job list/)).toHaveValue(
        "Systemadministrator\nIT Security Engineer\nNetzwerkadministrator",
      ),
    );

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveJobSearch).toHaveBeenCalled());
    expect((saveJobSearch as any).mock.calls[0][0]).toMatchObject({
      name: "Jobs from my CVs",
      keywords: "Systemadministrator\nIT Security Engineer\nNetzwerkadministrator",
    });
  });
});

describe("mergeTitles", () => {
  it("turns on email alerts with a minimum score and sends a test email", async () => {
    (saveJobSearch as any).mockResolvedValue({ success: true, data: { id: "s-3", ignoredCompanies: [] } });
    (sendTestEmail as any).mockResolvedValue({ success: true, data: { to: "me@gmail.com" } });
    const user = userEvent.setup();
    render(
      <JobSearchDialog
        open
        onOpenChange={vi.fn()}
        search={null}
        hasAdzunaKey={false}
        email={{ configured: true, to: "me@gmail.com" }}
        onSaved={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText(/Job list/), "SOC");
    await user.click(screen.getByRole("switch", { name: "Email me new matches" }));
    expect(screen.getByTestId("email-status")).toHaveTextContent("Emails go to me@gmail.com.");
    await user.click(screen.getByRole("button", { name: "Send test email" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("me@gmail.com")));
    await user.click(screen.getByRole("button", { name: "Save and search now" }));
    await waitFor(() => expect(saveJobSearch).toHaveBeenCalled());
    expect((saveJobSearch as any).mock.calls[0][0]).toMatchObject({ emailAlerts: true, emailMinScore: 60 });
  });

  it("explains how to set up email when it isn't yet", async () => {
    const user = userEvent.setup();
    render(<JobSearchDialog open onOpenChange={vi.fn()} search={null} hasAdzunaKey={false} onSaved={vi.fn()} />);
    await user.click(screen.getByRole("switch", { name: "Email me new matches" }));
    expect(screen.getByTestId("email-status")).toHaveTextContent(/BREVO_API_KEY and BREVO_SENDER/);
    expect(screen.getByRole("button", { name: "Send test email" })).toBeDisabled();
  });

  it("appends only new titles, ignoring case", () => {
    expect(mergeTitles("Admin\nSOC Analyst", ["soc analyst", "Pentester"])).toEqual({
      text: "Admin\nSOC Analyst\nPentester",
      added: 1,
    });
  });
});
