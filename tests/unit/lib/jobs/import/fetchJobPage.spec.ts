vi.mock("server-only", () => ({}));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

import { lookup } from "node:dns/promises";
import {
  fetchJobPage,
  isBlockedAddress,
  JobPageFetchError,
} from "@/lib/jobs/import/fetchJobPage";

const publicDns = () =>
  (lookup as any).mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

function htmlResponse(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });
}

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.5",
    "192.168.1.10",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "allows %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
});

describe("fetchJobPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publicDns();
  });

  it("returns the page html for a public URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse("<h1>Job</h1>"));
    const page = await fetchJobPage("https://jobs.example.com/1", fetchImpl);
    expect(page).toEqual({ finalUrl: "https://jobs.example.com/1", html: "<h1>Job</h1>" });
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("manual");
  });

  it.each([
    "ftp://example.com/job",
    "http://localhost:3737/api",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://user:pw@example.com/",
    "not a url",
  ])("rejects %s without fetching", async (url) => {
    const fetchImpl = vi.fn();
    await expect(fetchJobPage(url, fetchImpl)).rejects.toBeInstanceOf(JobPageFetchError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a hostname that resolves to a private address", async () => {
    (lookup as any).mockResolvedValue([{ address: "10.0.0.7", family: 4 }]);
    const fetchImpl = vi.fn();
    await expect(fetchJobPage("https://intranet.example.com", fetchImpl)).rejects.toThrow(
      "private address",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("follows a redirect but checks every hop", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
      );
    await expect(fetchJobPage("https://jobs.example.com/1", fetchImpl)).rejects.toThrow(
      "private address",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows a public redirect", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/en/job/1" } }))
      .mockResolvedValueOnce(htmlResponse("ok"));
    const page = await fetchJobPage("https://jobs.example.com/1", fetchImpl);
    expect(page.finalUrl).toBe("https://jobs.example.com/en/job/1");
  });

  it("explains a blocked request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse("no", { status: 403 }));
    await expect(fetchJobPage("https://jobs.example.com/1", fetchImpl)).rejects.toThrow(
      "blocked automatic reading",
    );
  });

  it("rejects a non-HTML response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("%PDF", { status: 200, headers: { "content-type": "application/pdf" } }),
    );
    await expect(fetchJobPage("https://jobs.example.com/1.pdf", fetchImpl)).rejects.toThrow(
      "isn't a web page",
    );
  });
});
