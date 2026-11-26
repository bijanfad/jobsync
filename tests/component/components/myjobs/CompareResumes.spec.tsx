import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CompareResumes, scoreBand } from "@/components/myjobs/CompareResumes";
import { compareResumesForJob } from "@/actions/job.actions";
import { toastError } from "@/lib/toast";

vi.mock("@/actions/job.actions", () => ({ compareResumesForJob: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toastError: vi.fn() }));

const data = {
  results: [
    {
      resumeId: "r-sec",
      title: "Security CV",
      isDefault: true,
      isJobResume: false,
      score: 82,
      verdict: "Strong security fit.",
      strengths: ["SIEM"],
      gaps: ["Azure"],
    },
    {
      resumeId: "r-dev",
      title: "Developer CV",
      isDefault: false,
      isJobResume: true,
      score: 48,
      verdict: "Developer focus.",
      strengths: [],
      gaps: ["Firewalls"],
    },
  ],
  skipped: ["Empty draft"],
};

describe("CompareResumes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ranks the CVs and runs a full match with the one picked", async () => {
    (compareResumesForJob as any).mockResolvedValue({ success: true, data });
    const onFullMatch = vi.fn();
    render(<CompareResumes jobId="job-1" onFullMatch={onFullMatch} />);

    await userEvent.click(screen.getByRole("button", { name: /compare all my cvs/i }));

    expect(compareResumesForJob).toHaveBeenCalledWith("job-1");
    const rows = await screen.findAllByTestId("compare-resumes-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Security CV")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Best fit")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Default")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Set on this job")).toBeInTheDocument();
    expect(screen.getByText(/Not compared.*Empty draft/)).toBeInTheDocument();

    await userEvent.click(
      within(rows[1]).getByRole("button", { name: /full match with this cv/i }),
    );
    expect(onFullMatch).toHaveBeenCalledWith("Developer CV");
  });

  it("shows the error and no results when comparing fails", async () => {
    (compareResumesForJob as any).mockResolvedValue({ success: false, message: "No key" });
    render(<CompareResumes jobId="job-1" onFullMatch={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /compare all my cvs/i }));
    expect(toastError).toHaveBeenCalledWith("No key", "Couldn't compare your CVs");
    expect(screen.queryByTestId("compare-resumes-row")).not.toBeInTheDocument();
  });

  it("is disabled until the job has a description", () => {
    render(
      <CompareResumes jobId="job-1" onFullMatch={vi.fn()} blockedReason="Add a job description first" />,
    );
    expect(screen.getByRole("button", { name: /compare all my cvs/i })).toBeDisabled();
  });

  it("bands scores like Job Match", () => {
    expect([85, 70, 55, 20].map((s) => scoreBand(s).label)).toEqual([
      "Strong",
      "Good",
      "Partial",
      "Weak",
    ]);
  });
});
