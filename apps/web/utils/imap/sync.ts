import { simpleParser } from "mailparser";
import type { ImapFlow } from "imapflow";
import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";
import type { ParsedMessage } from "@/utils/types";
import { withMailbox } from "@/utils/imap/client";
import { fallbackMessageId, normalizeMessageId } from "@/utils/imap/message-id";
import { resolveImapThreadId } from "@/utils/imap/threading";
import { toParsedMessage } from "@/utils/imap/parse";

const MAX_SOURCE_BYTES = 1024 * 1024;
// ponytail: read-state changes are caught by a bounded flag sweep over the
// most recent UIDs; CONDSTORE/QRESYNC is the upgrade when staleness matters.
const FLAG_SWEEP_WINDOW = 200;

export type UidFetchPlan =
  | { action: "baseline" }
  | { action: "reset" }
  | { action: "fetch"; fromUid: bigint };

/**
 * Decides what to fetch for a folder given its stored sync state and the
 * mailbox's current UIDVALIDITY. A UIDVALIDITY change invalidates every
 * stored UID for the folder, so the cursor restarts at the end. Whether new
 * mail actually exists is answered by a live UID SEARCH, not UIDNEXT: the
 * cached UIDNEXT goes stale when the mailbox stays selected on a long-lived
 * connection.
 */
export function planUidFetch({
  stored,
  uidValidity,
}: {
  stored: { uidValidity: bigint; lastSeenUid: bigint } | null;
  uidValidity: bigint;
}): UidFetchPlan {
  if (!stored) return { action: "baseline" };
  if (stored.uidValidity !== uidValidity) return { action: "reset" };
  return { action: "fetch", fromUid: stored.lastSeenUid + BigInt(1) };
}

export async function lookupThreadIdInDb(
  emailAccountId: string,
  messageIds: string[],
): Promise<string | null> {
  const match = await prisma.imapMessage.findFirst({
    where: { emailAccountId, messageIdHeader: { in: messageIds } },
    orderBy: { internalDate: "desc" },
    select: { threadId: true },
  });
  return match?.threadId ?? null;
}

/**
 * Parses a raw message, resolves its stable id and thread, and records its
 * current location in the ImapMessage map. A message seen before (e.g. after
 * a move) keeps its original thread id; only its location and flags update.
 */
export async function ingestImapMessage({
  emailAccountId,
  source,
  uid,
  flags,
  internalDate,
  folderPath,
  specialUse,
  uidValidity,
}: {
  emailAccountId: string;
  source: Buffer;
  uid: bigint;
  flags: string[];
  internalDate: Date;
  folderPath: string;
  specialUse?: string | null;
  uidValidity: bigint;
}): Promise<ParsedMessage> {
  const parsed = await simpleParser(source);

  const messageId =
    normalizeMessageId(parsed.messageId) ??
    fallbackMessageId({ folderPath, uidValidity, uid, internalDate });

  const threadId = await resolveImapThreadId({
    messageId,
    inReplyTo: parsed.inReplyTo,
    references: Array.isArray(parsed.references)
      ? parsed.references.join(" ")
      : parsed.references,
    lookupThreadId: (ids) => lookupThreadIdInDb(emailAccountId, ids),
  });

  const row = await prisma.imapMessage.upsert({
    where: {
      emailAccountId_messageIdHeader: {
        emailAccountId,
        messageIdHeader: messageId,
      },
    },
    update: { folderPath, uid, flags, internalDate },
    create: {
      emailAccountId,
      messageIdHeader: messageId,
      threadId,
      folderPath,
      uid,
      flags,
      internalDate,
    },
    select: { threadId: true },
  });

  return toParsedMessage({
    parsed,
    id: messageId,
    threadId: row.threadId,
    location: { folderPath, specialUse, flags, internalDate },
  });
}

/**
 * Fetches and ingests messages that arrived in a folder since the last sync.
 * The first sync records a baseline without processing history, matching how
 * Gmail/Outlook accounts only process mail received after connection.
 */
export async function syncFolderNewMessages({
  client,
  emailAccountId,
  folderPath,
  specialUse,
  logger,
  maxMessages = 25,
}: {
  client: ImapFlow;
  emailAccountId: string;
  folderPath: string;
  specialUse?: string | null;
  logger: Logger;
  maxMessages?: number;
}): Promise<{ messages: ParsedMessage[]; reset: boolean }> {
  return withMailbox(client, folderPath, async () => {
    const mailbox = client.mailbox;
    if (!mailbox) throw new Error("IMAP mailbox failed to open");
    const uidValidity = mailbox.uidValidity;

    const stored = await prisma.imapFolder.findUnique({
      where: { emailAccountId_path: { emailAccountId, path: folderPath } },
      select: { uidValidity: true, lastSeenUid: true },
    });

    const plan = planUidFetch({ stored, uidValidity });

    if (plan.action === "baseline" || plan.action === "reset") {
      if (plan.action === "reset") {
        logger.warn("IMAP UIDVALIDITY changed; restarting folder cursor", {
          folderPath,
        });
      }
      const existing =
        (await client.search({ all: true }, { uid: true })) || [];
      const maxUid = existing.length ? Math.max(...existing) : 0;
      await upsertFolderState({
        emailAccountId,
        folderPath,
        uidValidity,
        lastSeenUid: BigInt(maxUid),
        specialUse,
      });
      return { messages: [], reset: plan.action === "reset" };
    }

    // A live UID SEARCH, so new mail is found even when the mailbox has been
    // selected for a while on this connection.
    const found = await client.search(
      { uid: `${plan.fromUid}:*` },
      { uid: true },
    );
    // "n:*" always matches the highest-UID message even when n exceeds it.
    const newUids = (found || [])
      .filter((uid) => BigInt(uid) >= plan.fromUid)
      .sort((a, b) => a - b)
      .slice(0, maxMessages);
    if (!newUids.length) return { messages: [], reset: false };

    const batch: Array<{
      uid: bigint;
      flags: string[];
      internalDate: Date;
      source: Buffer;
    }> = [];
    for await (const message of client.fetch(
      { uid: newUids.join(",") },
      {
        uid: true,
        flags: true,
        internalDate: true,
        source: { maxLength: MAX_SOURCE_BYTES },
      },
      { uid: true },
    )) {
      if (!message.source) continue;
      batch.push({
        uid: BigInt(message.uid),
        flags: [...(message.flags ?? [])],
        internalDate: toDate(message.internalDate),
        source: message.source,
      });
    }
    batch.sort((a, b) => (a.uid < b.uid ? -1 : 1));
    if (!batch.length) {
      // Searched UIDs vanished before the fetch (expunged); skip past them.
      await upsertFolderState({
        emailAccountId,
        folderPath,
        uidValidity,
        lastSeenUid: BigInt(newUids[newUids.length - 1]),
        specialUse,
      });
      return { messages: [], reset: false };
    }

    const messages: ParsedMessage[] = [];
    for (const item of batch) {
      try {
        messages.push(
          await ingestImapMessage({
            emailAccountId,
            source: item.source,
            uid: item.uid,
            flags: item.flags,
            internalDate: item.internalDate,
            folderPath,
            specialUse,
            uidValidity,
          }),
        );
      } catch (error) {
        logger.error("Failed to ingest IMAP message", {
          folderPath,
          uid: item.uid.toString(),
          error,
        });
      }
    }

    // Advance only to the last processed UID so a capped batch resumes
    // where it stopped instead of skipping messages.
    await upsertFolderState({
      emailAccountId,
      folderPath,
      uidValidity,
      lastSeenUid: batch[batch.length - 1].uid,
      specialUse,
    });

    return { messages, reset: false };
  });
}

/**
 * Bounded read-state sweep: refreshes flags for the most recent UIDs in a
 * folder and propagates read-state changes to the EmailMessage mirror.
 */
export async function syncFolderFlagChanges({
  client,
  emailAccountId,
  folderPath,
  logger,
}: {
  client: ImapFlow;
  emailAccountId: string;
  folderPath: string;
  logger: Logger;
}): Promise<void> {
  const stored = await prisma.imapFolder.findUnique({
    where: { emailAccountId_path: { emailAccountId, path: folderPath } },
    select: { lastSeenUid: true },
  });
  if (!stored || stored.lastSeenUid <= BigInt(0)) return;

  const fromUid =
    stored.lastSeenUid > BigInt(FLAG_SWEEP_WINDOW)
      ? stored.lastSeenUid - BigInt(FLAG_SWEEP_WINDOW)
      : BigInt(1);

  const liveFlags = new Map<bigint, string[]>();
  await withMailbox(client, folderPath, async () => {
    for await (const message of client.fetch(
      { uid: `${fromUid}:${stored.lastSeenUid}` },
      { uid: true, flags: true },
      { uid: true },
    )) {
      liveFlags.set(BigInt(message.uid), [...(message.flags ?? [])]);
    }
  });
  if (!liveFlags.size) return;

  const rows = await prisma.imapMessage.findMany({
    where: {
      emailAccountId,
      folderPath,
      uid: { gte: fromUid, lte: stored.lastSeenUid },
    },
    select: { messageIdHeader: true, uid: true, flags: true },
  });

  const nowRead: string[] = [];
  const nowUnread: string[] = [];
  for (const row of rows) {
    const flags = liveFlags.get(row.uid);
    if (!flags || sameFlags(flags, row.flags)) continue;

    await prisma.imapMessage.updateMany({
      where: { emailAccountId, messageIdHeader: row.messageIdHeader },
      data: { flags },
    });

    const wasRead = row.flags.includes("\\Seen");
    const isRead = flags.includes("\\Seen");
    if (wasRead === isRead) continue;
    (isRead ? nowRead : nowUnread).push(row.messageIdHeader);
  }

  if (nowRead.length) {
    await prisma.emailMessage.updateMany({
      where: { emailAccountId, messageId: { in: nowRead } },
      data: { read: true },
    });
  }
  if (nowUnread.length) {
    await prisma.emailMessage.updateMany({
      where: { emailAccountId, messageId: { in: nowUnread } },
      data: { read: false },
    });
  }
  if (nowRead.length || nowUnread.length) {
    logger.info("IMAP flag sweep updated read state", {
      folderPath,
      read: nowRead.length,
      unread: nowUnread.length,
    });
  }
}

async function upsertFolderState({
  emailAccountId,
  folderPath,
  uidValidity,
  lastSeenUid,
  specialUse,
}: {
  emailAccountId: string;
  folderPath: string;
  uidValidity: bigint;
  lastSeenUid: bigint;
  specialUse?: string | null;
}) {
  await prisma.imapFolder.upsert({
    where: { emailAccountId_path: { emailAccountId, path: folderPath } },
    update: { uidValidity, lastSeenUid, specialUse: specialUse ?? undefined },
    create: {
      emailAccountId,
      path: folderPath,
      uidValidity,
      lastSeenUid,
      specialUse,
    },
  });
}

function sameFlags(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

function toDate(value: Date | string | undefined): Date {
  if (!value) return new Date();
  return value instanceof Date ? value : new Date(value);
}
