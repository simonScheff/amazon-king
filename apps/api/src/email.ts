import nodemailer from "nodemailer";
import type { ApiConfig } from "./config.js";

export interface MagicLinkMessage {
  to: string;
  url: string;
  expiresInMinutes: number;
}

export type MagicLinkSender = (message: MagicLinkMessage) => Promise<void>;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Build the production SMTP sender. Credentials are never logged. */
export function createSmtpMagicLinkSender(config: ApiConfig): MagicLinkSender {
  if (!config.smtpHost || !config.smtpFrom) {
    throw new Error("SMTP_HOST and SMTP_FROM are required for email delivery");
  }
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth:
      config.smtpUser && config.smtpPassword
        ? { user: config.smtpUser, pass: config.smtpPassword }
        : undefined,
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  return async ({ to, url, expiresInMinutes }) => {
    const safeUrl = escapeHtml(url);
    await transporter.sendMail({
      from: config.smtpFrom,
      to,
      subject: "Sign in to amazon-king",
      text: `Open this single-use link to sign in to amazon-king:\n\n${url}\n\nThis link expires in ${expiresInMinutes} minutes. If you did not request it, ignore this email.`,
      html: `<p>Open this single-use link to sign in to amazon-king:</p><p><a href="${safeUrl}">Sign in</a></p><p>This link expires in ${expiresInMinutes} minutes. If you did not request it, ignore this email.</p>`,
    });
  };
}
