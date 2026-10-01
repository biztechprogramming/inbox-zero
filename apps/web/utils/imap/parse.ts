import type { AddressObject, ParsedMail, Attachment } from "mailparser";
import type { ParsedMessage } from "@/utils/types";

const SNIPPET_LENGTH = 200;

// Gmail-style system label ids. Values must stay in sync with GmailLabel in
// @/utils/gmail/label: saveParsedMessages and message filtering derive
// read/sent/draft/inbox state from these exact strings.
export const ImapSystemLabel = {
  INBOX: "INBOX",
  SENT: "SENT",
  UNREAD: "UNREAD",
  STARRED: "STARRED",
  SPAM: "SPAM",
  TRASH: "TRASH",
  DRAFT: "DRAFT",
} as const;

export type ImapMessageLocation = {
  folderPath: string;
  specialUse?: string | null;
  flags: string[];
  internalDate: Date;
};

/**
 * Converts a mailparser result plus its IMAP location into the ParsedMessage
 * shape the rest of the app consumes. labelIds uses Gmail-style system labels
 * (INBOX/SENT/DRAFT/TRASH/SPAM/UNREAD/STARRED) because the EmailMessage mirror
 * and message filtering derive read/sent/inbox state from those values.
 */
export function toParsedMessage({
  parsed,
  id,
  threadId,
  location,
}: {
  parsed: ParsedMail;
  id: string;
  threadId: string;
  location: ImapMessageLocation;
}): ParsedMessage {
  const textPlain = parsed.text || undefined;
  const textHtml = parsed.html || undefined;
  const date = parsed.date ?? location.internalDate;

  const attachments: ParsedMessage["attachments"] = [];
  const inline: ParsedMessage["inline"] = [];
  for (const [index, attachment] of (parsed.attachments ?? []).entries()) {
    const mapped = toAttachment(attachment, index);
    if (attachment.contentDisposition === "inline" && attachment.cid) {
      inline.push(mapped);
    } else {
      attachments.push(mapped);
    }
  }

  return {
    id,
    threadId,
    historyId: "",
    snippet: (textPlain ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, SNIPPET_LENGTH),
    subject: parsed.subject ?? "",
    date: date.toISOString(),
    internalDate: String(location.internalDate.getTime()),
    labelIds: buildLabelIds(location),
    parentFolderId: location.folderPath,
    textPlain,
    textHtml,
    bodyContentType: textHtml ? "html" : "text",
    headers: {
      from: addressText(parsed.from),
      to: addressText(parsed.to),
      cc: addressText(parsed.cc) || undefined,
      bcc: addressText(parsed.bcc) || undefined,
      subject: parsed.subject ?? "",
      date: date.toISOString(),
      "message-id": parsed.messageId,
      "in-reply-to": parsed.inReplyTo,
      references: joinReferences(parsed.references),
      "reply-to": addressText(parsed.replyTo) || undefined,
      "list-unsubscribe": rawHeaderValue(parsed, "list-unsubscribe"),
      "list-unsubscribe-post": rawHeaderValue(parsed, "list-unsubscribe-post"),
    },
    attachments,
    inline,
  };
}

export function buildLabelIds({
  folderPath,
  specialUse,
  flags,
}: Pick<ImapMessageLocation, "folderPath" | "specialUse" | "flags">): string[] {
  const labelIds: string[] = [];

  if (folderPath.toUpperCase() === "INBOX" || specialUse === "\\Inbox") {
    labelIds.push(ImapSystemLabel.INBOX);
  } else if (specialUse === "\\Sent") {
    labelIds.push(ImapSystemLabel.SENT);
  } else if (specialUse === "\\Drafts") {
    labelIds.push(ImapSystemLabel.DRAFT);
  } else if (specialUse === "\\Trash") {
    labelIds.push(ImapSystemLabel.TRASH);
  } else if (specialUse === "\\Junk") {
    labelIds.push(ImapSystemLabel.SPAM);
  } else if (specialUse !== "\\Archive" && specialUse !== "\\All") {
    labelIds.push(folderPath);
  }

  if (!flags.includes("\\Seen")) labelIds.push(ImapSystemLabel.UNREAD);
  if (flags.includes("\\Flagged")) labelIds.push(ImapSystemLabel.STARRED);
  if (flags.includes("\\Draft") && !labelIds.includes(ImapSystemLabel.DRAFT)) {
    labelIds.push(ImapSystemLabel.DRAFT);
  }

  return labelIds;
}

/**
 * Stable attachment id within a message; used by getAttachment to find the
 * part again after re-parsing the raw message.
 */
export function attachmentIdFor(
  attachment: Pick<Attachment, "contentId" | "checksum">,
  index: number,
): string {
  return attachment.contentId || attachment.checksum || `part-${index}`;
}

function toAttachment(attachment: Attachment, index: number) {
  return {
    attachmentId: attachmentIdFor(attachment, index),
    filename: attachment.filename ?? "",
    mimeType: attachment.contentType,
    size: attachment.size,
    headers: {
      "content-description": "",
      "content-disposition": attachment.contentDisposition ?? "",
      "content-id": attachment.contentId ?? "",
      "content-transfer-encoding": "",
      "content-type": attachment.contentType,
    },
  };
}

function addressText(
  address: AddressObject | AddressObject[] | undefined,
): string {
  if (!address) return "";
  const list = Array.isArray(address) ? address : [address];
  return list
    .map((entry) => entry.text)
    .filter(Boolean)
    .join(", ");
}

function joinReferences(
  references: string | string[] | undefined,
): string | undefined {
  if (!references) return;
  return Array.isArray(references) ? references.join(" ") : references;
}

// mailparser folds List-* headers into a structured "list" value; the app
// expects the original header text, so read it from the raw header lines.
function rawHeaderValue(parsed: ParsedMail, key: string): string | undefined {
  const line = parsed.headerLines.find((header) => header.key === key)?.line;
  if (!line) return;
  const value = line.slice(line.indexOf(":") + 1).trim();
  return value.length ? value : undefined;
}
