import { randomUUID } from "node:crypto";
import { createTransport, type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";
import type { ImapAccountConfig } from "@/utils/imap/client";
import { normalizeMessageId } from "@/utils/imap/message-id";

const CONNECT_TIMEOUT_MS = 15_000;

export function createSmtpTransport(config: ImapAccountConfig): Transporter {
  return createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure ?? config.smtpPort === 465,
    // On non-465 ports, refuse to send unless STARTTLS succeeds.
    requireTLS: true,
    auth: { user: config.username, pass: config.smtpPassword },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    tls: config.tls,
  });
}

export type BuiltMimeMessage = {
  raw: Buffer;
  envelope: Mail.Envelope;
  /** Normalized Message-ID; also the public message id after sending. */
  messageId: string;
};

/**
 * Composes a MIME message once, for both the SMTP send and the Sent-folder
 * APPEND (same bytes). The Bcc header is stripped from the output; bcc
 * recipients travel only in the SMTP envelope.
 */
export async function buildMimeMessage(
  options: Mail.Options & { from: string },
): Promise<BuiltMimeMessage> {
  const messageId = options.messageId ?? generateImapMessageId(options.from);
  const composer = new MailComposer({
    ...options,
    messageId,
    headers: { "X-Mailer": "Inbox Zero Web", ...options.headers },
  });
  const node = composer.compile();
  node.keepBcc = false;
  // MimeNode envelopes are {from, to[]}; sendMail expects comma-joined strings.
  const mimeEnvelope = node.getEnvelope();
  const envelope: Mail.Envelope = {
    from: mimeEnvelope.from || undefined,
    to: mimeEnvelope.to.join(", "),
  };
  const raw = await node.build();
  const normalized = normalizeMessageId(messageId);
  if (!normalized) throw new Error("Failed to assign a Message-ID");
  return { raw, envelope, messageId: normalized };
}

export function generateImapMessageId(fromAddress: string): string {
  const domainMatch = fromAddress.match(/@([A-Za-z0-9.-]+)/);
  const domain = domainMatch?.[1] ?? "inbox-zero.mail";
  return `<${randomUUID()}@${domain}>`;
}
