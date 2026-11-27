import nodemailer from "nodemailer";

// Outgoing email for Find jobs alerts: Brevo's HTTPS API when BREVO_API_KEY
// is set (works where a host blocks mail ports), else SMTP such as Gmail.
// Configured only through env vars, so no secret sits in the database.
export interface MailSettings {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string | null;
}

export class EmailNotConfiguredError extends Error {
  constructor() {
    super(
      "Email is not set up. Add BREVO_API_KEY and BREVO_SENDER (or SMTP_USER and SMTP_PASS) to your .env file and restart JobSync.",
    );
    this.name = "EmailNotConfiguredError";
  }
}

export function mailSettings(env: NodeJS.ProcessEnv = process.env): MailSettings | null {
  const user = env.SMTP_USER?.trim();
  // Google shows app passwords in groups of four; the spaces are not part of it.
  const pass = env.SMTP_PASS?.replace(/\s+/g, "");
  if (!user || !pass) return null;
  const port = Number(env.SMTP_PORT) || 465;
  return {
    host: env.SMTP_HOST?.trim() || "smtp.gmail.com",
    port,
    user,
    pass,
    from: env.SMTP_FROM?.trim() || user,
    to: env.SMTP_TO?.trim() || null,
  };
}

/** "JobSync <me@x.de>" or "me@x.de" → name and address. */
export function parseAddress(raw: string): { name?: string; email: string } | null {
  const m = raw.trim().match(/^(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>$/);
  if (m) return { ...(m[1]?.trim() ? { name: m[1].trim() } : {}), email: m[2] };
  return /^[^\s<>@]+@[^\s<>@]+$/.test(raw.trim()) ? { email: raw.trim() } : null;
}

export interface BrevoSettings {
  apiKey: string;
  sender: { name?: string; email: string };
}

/** Brevo's web API (HTTPS), for servers whose host blocks outgoing SMTP. */
export function brevoSettings(env: NodeJS.ProcessEnv = process.env): BrevoSettings | null {
  const apiKey = env.BREVO_API_KEY?.trim();
  if (!apiKey) return null;
  const raw = env.BREVO_SENDER || env.SMTP_FROM || env.EMAIL_TO || env.SMTP_TO || "";
  const sender = parseAddress(raw);
  if (!sender) return null;
  return { apiKey, sender: sender.name ? sender : { name: "JobSync", email: sender.email } };
}

/** "brevo" when BREVO_API_KEY is set, else "smtp" when SMTP is, else null. */
export function emailProvider(env: NodeJS.ProcessEnv = process.env): "brevo" | "smtp" | null {
  if (brevoSettings(env)) return "brevo";
  if (mailSettings(env)) return "smtp";
  return null;
}

export function isEmailConfigured(): boolean {
  return emailProvider() !== null;
}

/** Where alerts go: EMAIL_TO (or SMTP_TO) if set, else the account's login email. */
export function alertRecipient(userEmail: string | null | undefined): string | null {
  return process.env.EMAIL_TO?.trim() || process.env.SMTP_TO?.trim() || userEmail?.trim() || null;
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export function friendlyMailError(error: unknown): string {
  const e = error as { code?: string; responseCode?: number; message?: string };
  if (e?.responseCode === 535 || e?.code === "EAUTH") {
    return "Gmail did not accept the login. Use an app password (not your normal Gmail password) in SMTP_PASS, and check SMTP_USER.";
  }
  if (e?.code === "ECONNECTION" || e?.code === "ETIMEDOUT" || e?.code === "ESOCKET") {
    return "Could not reach the mail server. Many VPS hosts block outgoing email ports: use Brevo instead (BREVO_API_KEY, see .env.example).";
  }
  return e?.message || "Sending the email failed.";
}

/** Brevo's answer in plain words. */
export function friendlyBrevoError(status: number, body: string): string {
  let message = "";
  try {
    message = String(JSON.parse(body)?.message ?? "");
  } catch {
    message = body.slice(0, 200);
  }
  if (/unrecogni[sz]ed IP|authori[sz]ed IP/i.test(message)) {
    return "Brevo blocked this server's IP address. In Brevo, open Security, Authorised IPs, and allow this server's IP (or turn the IP check off).";
  }
  if (status === 401) return "Brevo did not accept the API key. Check BREVO_API_KEY (it starts with xkeysib-).";
  if (/sender/i.test(message)) {
    return "Brevo does not know this sender yet. In Brevo, open Senders, add the address in BREVO_SENDER and confirm the email Brevo sends you.";
  }
  if (status === 402 || /credit|quota|limit/i.test(message)) {
    return "Brevo refused to send: the account has no free emails left today, or needs to be activated.";
  }
  return `Brevo refused the email (${status}${message ? `: ${message}` : ""}).`;
}

async function sendWithBrevo(b: BrevoSettings, message: MailMessage, fetchImpl: typeof fetch) {
  let res: Response;
  try {
    res = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": b.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: b.sender,
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Could not reach Brevo (api.brevo.com). Check that the server can open websites.");
  }
  if (!res.ok) throw new Error(friendlyBrevoError(res.status, await res.text().catch(() => "")));
}

export async function sendMail(message: MailMessage, fetchImpl: typeof fetch = fetch): Promise<void> {
  const brevo = brevoSettings();
  if (brevo) return sendWithBrevo(brevo, message, fetchImpl);
  const s = mailSettings();
  if (!s) throw new EmailNotConfiguredError();
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.port === 465,
    auth: { user: s.user, pass: s.pass },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.sendMail({ from: s.from, ...message });
  } catch (error) {
    throw new Error(friendlyMailError(error));
  } finally {
    transport.close();
  }
}

/** The address the app is opened at, for links in emails. */
export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NEXTAUTH_URL || env.AUTH_URL || "http://localhost:3737").replace(/\/+$/, "");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
