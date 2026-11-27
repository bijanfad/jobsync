import nodemailer from "nodemailer";

// Outgoing email for Find jobs alerts. Configured only through env vars, so
// the password never sits in the database.
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
      "Email is not set up. Add SMTP_USER and SMTP_PASS to your .env file and restart JobSync.",
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

export function isEmailConfigured(): boolean {
  return mailSettings() !== null;
}

/** Where alerts go: SMTP_TO if set, else the account's login email. */
export function alertRecipient(userEmail: string | null | undefined): string | null {
  return mailSettings()?.to || userEmail?.trim() || null;
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
    return "Could not reach the mail server. Check SMTP_HOST and SMTP_PORT, and that the server allows outgoing mail.";
  }
  return e?.message || "Sending the email failed.";
}

export async function sendMail(message: MailMessage): Promise<void> {
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
