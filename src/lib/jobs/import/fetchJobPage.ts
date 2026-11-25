import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Fetches a job posting page for the AI to read. The URL comes from the user,
// so this is a server-side request on their behalf: it must never reach the
// server's own network (Postgres, Ollama, cloud metadata, the LAN). Every hop
// of a redirect chain is checked, not just the first URL.

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 3 * 1024 * 1024;

// Many career sites refuse requests that do not look like a browser.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en,de;q=0.8,*;q=0.5",
};

export class JobPageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobPageFetchError";
  }
}

function ipv4ToInt(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inV4Range(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** True for any address a user-supplied URL must not reach. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return BLOCKED_V4.some(([base, bits]) => inV4Range(address, base, bits));
  }
  if (family === 6) {
    const a = address.toLowerCase();
    // IPv4-mapped (::ffff:10.0.0.1) inherits the IPv4 verdict
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (a === "::" || a === "::1") return true;
    // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast
    return /^(f[cd]|fe[89ab]|ff)/.test(a);
  }
  return true;
}

async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new JobPageFetchError("Only http and https links can be read.");
  }
  if (url.username || url.password) {
    throw new JobPageFetchError("Links with a username or password can't be read.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new JobPageFetchError("That link points to a private address.");
  }
  let addresses: { address: string }[];
  try {
    addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch {
    throw new JobPageFetchError(`Couldn't find the website ${host}.`);
  }
  if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
    throw new JobPageFetchError("That link points to a private address.");
  }
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

export interface FetchedPage {
  finalUrl: string;
  html: string;
}

export async function fetchJobPage(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new JobPageFetchError("That doesn't look like a valid link.");
  }

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: BROWSER_HEADERS,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new JobPageFetchError("The job page took too long to respond.");
      }
      throw new JobPageFetchError("Couldn't connect to the job page.");
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      url = new URL(location, url);
      continue;
    }

    if (res.status === 401 || res.status === 403 || res.status === 429) {
      throw new JobPageFetchError(
        "The job site blocked automatic reading of this page.",
      );
    }
    if (!res.ok) {
      throw new JobPageFetchError(`The job page answered with an error (${res.status}).`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (type && !/html|xml|text\/plain/i.test(type)) {
      throw new JobPageFetchError("That link isn't a web page (it may be a PDF or image).");
    }
    return { finalUrl: url.toString(), html: await readCapped(res) };
  }
  throw new JobPageFetchError("The job page redirected too many times.");
}
