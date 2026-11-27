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
  emailProvider,
  parseAddress,
  escapeHtml,
  friendlyMailError,
  isEmailConfigured,
  mailSettings,
  sendMail,
} from "@/lib/email/mailer";

const KEYS = [
  "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_TO", "NEXTAUTH_URL",
  "BREVO_API_KEY", "BREVO_SENDER", "EMAIL_TO",
];

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
    expect(friendlyMailError({ code: "ETIMEDOUT" })).toMatch(/use Brevo/);
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

  describe("Brevo", () => {
    const ok = () => vi.fn(async (..._args: any[]) => new Response('{"messageId":"m"}', { status: 201 }));
    const msg = { to: "me@gmail.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi" };

    it("is used instead of SMTP when BREVO_API_KEY is set", async () => {
      process.env.SMTP_USER = "me@gmail.com";
      process.env.SMTP_PASS = "pw";
      expect(emailProvider()).toBe("smtp");
      process.env.BREVO_API_KEY = "xkeysib-abc";
      process.env.BREVO_SENDER = "JobSync <me@gmail.com>";
      expect(emailProvider()).toBe("brevo");

      const fetchImpl = ok();
      await sendMail(msg, fetchImpl as any);
      expect(h.createTransport).not.toHaveBeenCalled();
      const [url, init] = fetchImpl.mock.calls[0] as any[];
      expect(url).toBe("https://api.brevo.com/v3/smtp/email");
      expect(init.headers["api-key"]).toBe("xkeysib-abc");
      expect(JSON.parse(init.body)).toEqual({
        sender: { name: "JobSync", email: "me@gmail.com" },
        to: [{ email: "me@gmail.com" }],
        subject: "Hi",
        htmlContent: "<p>Hi</p>",
        textContent: "Hi",
      });
    });

    it("needs a sender address, and falls back to SMTP_FROM or EMAIL_TO", () => {
      process.env.BREVO_API_KEY = "xkeysib-abc";
      expect(emailProvider()).toBeNull();
      process.env.EMAIL_TO = "me@gmail.com";
      expect(emailProvider()).toBe("brevo");
      expect(alertRecipient("login@example.com")).toBe("me@gmail.com");
    });

    it("explains Brevo's refusals in plain words", async () => {
      process.env.BREVO_API_KEY = "xkeysib-bad";
      process.env.BREVO_SENDER = "me@gmail.com";
      const answer = (status: number, message: string) =>
        vi.fn(async () => new Response(JSON.stringify({ code: "x", message }), { status }));
      await expect(sendMail(msg, answer(401, "Key not found") as any)).rejects.toThrow(/API key/);
      await expect(sendMail(msg, answer(400, "Sender is not valid") as any)).rejects.toThrow(/Senders/);
      await expect(
        sendMail(msg, answer(401, "We have detected you are using an unrecognised IP address 1.2.3.4") as any),
      ).rejects.toThrow(/Authorised IPs/);
      await expect(
        sendMail(msg, vi.fn(async () => { throw new TypeError("fetch failed"); }) as any),
      ).rejects.toThrow(/Could not reach Brevo/);
    });

    it("reads sender addresses with or without a name", () => {
      expect(parseAddress('"JobSync" <a@b.de>')).toEqual({ name: "JobSync", email: "a@b.de" });
      expect(parseAddress("a@b.de")).toEqual({ email: "a@b.de" });
      expect(parseAddress("not an address")).toBeNull();
    });
  });
});
