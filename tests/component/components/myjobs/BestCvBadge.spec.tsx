import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BestCvBadge } from "@/components/myjobs/BestCvBadge";
import { parseResumeComparison } from "@/models/resumeCompare.schema";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

describe("BestCvBadge", () => {
  it("shows the best score and names the CV on hover", async () => {
    render(<BestCvBadge score={82} title="Security CV" comparedAt="2026-11-26T09:00:00Z" />);
    const badge = screen.getByTestId("best-cv-badge");
    expect(badge).toHaveTextContent("82");
    expect(badge).toHaveAccessibleName("Best CV match 82 of 100: Security CV");
    await userEvent.hover(badge);
    expect((await screen.findAllByText("Best CV: Security CV")).length).toBeGreaterThan(0);
  });

  it("renders nothing before any comparison", () => {
    const { container } = render(<BestCvBadge score={null} title={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("parseResumeComparison", () => {
  it("reads a saved comparison and ignores anything else", () => {
    expect(parseResumeComparison('{"results":[],"skipped":[]}')).toEqual({ results: [], skipped: [] });
    expect(parseResumeComparison("not json")).toBeNull();
    expect(parseResumeComparison('{"x":1}')).toBeNull();
    expect(parseResumeComparison(null)).toBeNull();
  });
});
