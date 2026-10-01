import { createHash } from "node:crypto";

/**
 * Normalizes an RFC822 Message-ID for use as the stable public message id.
 * IMAP UIDs change on moves and UIDVALIDITY resets, so the Message-ID is the
 * only identifier that survives a message's lifetime.
 */
export function normalizeMessageId(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^<|>$/g, "").trim();
  return trimmed.length ? trimmed : null;
}

/** Deterministic id for the rare message without a Message-ID header. */
export function fallbackMessageId({
  folderPath,
  uidValidity,
  uid,
  internalDate,
}: {
  folderPath: string;
  uidValidity: bigint;
  uid: bigint;
  internalDate: Date;
}): string {
  const hash = createHash("sha256")
    .update(`${folderPath}\n${uidValidity}\n${uid}\n${internalDate.getTime()}`)
    .digest("hex")
    .slice(0, 32);
  return `imap-${hash}`;
}

/** Splits a References header into normalized Message-IDs, oldest first. */
export function parseReferences(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const ids: string[] = [];
  for (const match of raw.matchAll(/<([^<>]+)>/g)) {
    const id = normalizeMessageId(match[1]);
    if (id) ids.push(id);
  }
  return ids;
}
