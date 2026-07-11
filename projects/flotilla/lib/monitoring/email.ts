// lib/monitoring/email.ts — the Gmail-SMTP alert channel (nodemailer). Kept
// entirely best-effort + degrade-clean per the notifier posture: NO creds ⇒ a
// logged no-op (never a throw), a send failure ⇒ { ok:false, reason } (never a
// throw). The transport is created per-send (alerts are low-volume; a cached pool
// isn't worth the lifecycle risk in a serverless cron).
//
// CREDS (env, never in the config store): ALERT_GMAIL_USER (the sender address),
// ALERT_GMAIL_APP_PASSWORD (a Gmail App Password — Gmail DISPLAYS it space-
// separated, so we STRIP all whitespace), ALERT_FROM_NAME (display name; optional).
// SMTP: smtp.gmail.com:465, secure (implicit TLS).

export type EmailResult = { ok: boolean; reason?: string };

// The app password as Gmail shows it is 16 chars in four space-separated groups;
// strip ALL whitespace so a pasted "abcd efgh ijkl mnop" authenticates.
function appPassword(): string {
  return (process.env.ALERT_GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
}

// True only when BOTH the sender address and the app password are present.
export function emailConfigured(): boolean {
  return Boolean((process.env.ALERT_GMAIL_USER || "").trim() && appPassword());
}

export async function sendAlertEmail(to: string[], subject: string, text: string): Promise<EmailResult> {
  if (!emailConfigured()) return { ok: false, reason: "email not configured (ALERT_GMAIL_USER / ALERT_GMAIL_APP_PASSWORD)" };
  if (to.length === 0) return { ok: false, reason: "no enabled recipients" };
  try {
    // Dynamic import so a build/runtime without the dep loaded doesn't pay for it
    // until an email actually needs sending (and a missing module degrades, not throws).
    const nodemailer = (await import("nodemailer")).default;
    const user = (process.env.ALERT_GMAIL_USER || "").trim();
    const fromName = (process.env.ALERT_FROM_NAME || "flotilla monitoring").trim();
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user, pass: appPassword() },
    });
    await transport.sendMail({
      from: `"${fromName}" <${user}>`,
      to: to.join(", "),
      subject,
      text,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
