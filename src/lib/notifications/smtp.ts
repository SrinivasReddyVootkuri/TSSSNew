/**
 * SMTP email sender, used for messages with attachments (identity cards).
 *
 * The existing notification layer speaks HTTP APIs; SMTP is configured
 * separately because providers and trusts typically already have mailbox
 * credentials, and attachments over SMTP need no provider-specific code.
 * When the variables are absent the sender reports itself unavailable and
 * nothing is attempted, so a missing mail server can never break a request.
 */

import "server-only";

import nodemailer, { type Transporter } from "nodemailer";

export type SmtpStatus =
  | { configured: true; transporter: Transporter }
  | { configured: false; reason: string };

export function smtpStatus(): SmtpStatus {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASS ?? "";

  if (!host) return { configured: false, reason: "SMTP_HOST is not set." };
  if (!user) return { configured: false, reason: "SMTP_USER is not set." };

  const port = Number(process.env.SMTP_PORT ?? "587") || 587;
  const secure =
    (process.env.SMTP_SECURE ?? (port === 465 ? "true" : "false")).toLowerCase() === "true";

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass: password },
  });

  return { configured: true, transporter };
}

export type SmtpMessage = {
  to: string;
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
};

/**
 * Sends one message. Returns a human-readable outcome so the caller can tell
 * an administrator exactly what happened instead of a bare true/false.
 */
export async function sendSmtpMail(
  message: SmtpMessage,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const status = smtpStatus();
  if (!status.configured) return { ok: false, error: status.reason };

  const from = process.env.SMTP_FROM?.trim() || process.env.SMTP_USER!.trim();

  try {
    await status.transporter.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      attachments: (message.attachments ?? []).map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
      })),
    });
    return { ok: true };
  } catch (error) {
    console.error("smtp send failed:", error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "The mail server rejected the message.",
    };
  }
}
