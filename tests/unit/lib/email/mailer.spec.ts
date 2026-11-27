const h = vi.hoisted(() => ({
  sendMail: vi.fn(async () => ({})),
  close: vi.fn(),
  createTransport: vi.fn(),
}));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: h.createTransport.mockImplementation(() => ({ sendMail: h.sendMail, close: h.close })),
  },
}));

import {
  alertRecipient,
  appBaseUrl,
  escapeHtml,
  friendlyMailError,
  isEmailConfigured,
  mailSettings,
  sendMail,
} from "@/lib/email/mailer";

const KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_TO", "NEXTAUTH_URL"];

describe("mailer", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is off until a user and password are set", () => {
    expect(isEmailConfigured()).toBe(false);
    process.env.SMTP_USER = "me@gmail.com";
    expect(isEmailConfigured()).toBe(false);
    process.env.SMTP_PASS = "abcd efgh ijkl mnop";
    expect(isEmailConfigured()).toBe(true);
  });

  it("defaults to Gmail and drops the spaces Google shows in app passwords", () => {
    expect(mailSettings({ SMTP_USER: "me@gmail.com", SMTP_PASS: "abcd efgh ijkl mnop" } as any)).toEqual({
      host: "smtp.gmail.com",
      port: 465,
      user: "me@gmail.com",
      pass: "abcdefghijklmnop",
      from: "me@gmail.com",
      to: null,
    });
  });

  it("sends through SMTP with TLS on port 465", async () => {
    process.env.SMTP_USER = "me@gmail.com";
    process.env.SMTP_PASS = "pw";
    process.env.SMTP_FROM = "JobSync <me@gmail.com>";
    await sendMail({ to: "me@gmail.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi" });
    expect(h.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: "me@gmail.com", pass: "pw" } }),
    );
    expect(h.sendMail).toHaveBeenCalledWith({
      from: "JobSync <me@gmail.com>",
      to: "me@gmail.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
    expect(h.close).toHaveBeenCalled();
  });

  it("explains a refused Gmail login in plain words", async () => {
    process.env.SMTP_USER = "me@gmail.com";
    process.env.SMTP_PASS = "wrong";
    h.sendMail.mockRejectedValueOnce(Object.assign(new Error("535-5.7.8 Username and Password not accepted"), { code: "EAUTH", responseCode: 535 }));
    await expect(sendMail({ to: "a@b.c", subject: "s", html: "h", text: "t" })).rejects.toThrow(/app password/);
    expect(friendlyMailError({ code: "ETIMEDOUT" })).toMatch(/Could not reach/);
  });

  it("refuses to send when not set up", async () => {
    await expect(sendMail({ to: "a@b.c", subject: "s", html: "h", text: "t" })).rejects.toThrow(/not set up/);
    expect(h.createTransport).not.toHaveBeenCalled();
  });

  it("sends alerts to SMTP_TO, else the login email", () => {
    process.env.SMTP_USER = "me@gmail.com";
    process.env.SMTP_PASS = "pw";
    expect(alertRecipient("login@example.com")).toBe("login@example.com");
    process.env.SMTP_TO = "alerts@gmail.com";
    expect(alertRecipient("login@example.com")).toBe("alerts@gmail.com");
  });

  it("builds links from NEXTAUTH_URL and escapes HTML", () => {
    expect(appBaseUrl({ NEXTAUTH_URL: "https://jobs.example.com/" } as any)).toBe("https://jobs.example.com");
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;");
  });
});
