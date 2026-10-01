import type { Memory } from "mem0ai/oss";
import type { Prisma } from "@/generated/prisma/client";
import {
  EmailAudience,
  EmailItemOwner,
  EmailItemStatus,
  EmailItemType,
} from "@/generated/prisma/enums";
import {
  canonicalizeEmailAddress,
  extractEmailAddress,
  extractEmailAddresses,
  extractNameFromEmail,
  isSameEmailAddress,
  splitRecipientList,
} from "@/utils/email";
import { createEmailProvider } from "@/utils/email/provider";
import { isThreadNotFoundError } from "@/utils/email/thread-not-found";
import type { EmailProvider } from "@/utils/email/types";
import { getEmailForLLM } from "@/utils/get-email-from-message";
import {
  analyzeMessageKnowledge,
  MAX_CONTENT_LENGTH,
  type MessageAnalysis,
} from "@/utils/knowledge/analyze-message";
import { getKnowledgeMemory } from "@/utils/knowledge/memory";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import type { ParsedMessage } from "@/utils/types";
import { getEmailAccountWithAi } from "@/utils/user/get";

const KNOWN_FACTS_LIMIT = 10;
// Bounds the prompt for a thread whose items never get resolved.
const OPEN_ITEMS_LIMIT = 30;
// Reminder series and "resolved" notices arrive as new threads from the
// same sender, so their recent open items are shown alongside the thread's.
const SENDER_ITEMS_LIMIT = 10;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type PendingMessage = {
  messageId: string;
  threadId: string;
  from: string;
  sent: boolean;
  date: Date;
};

const openItemSelect = {
  id: true,
  type: true,
  text: true,
  owner: true,
  counterpartyEmail: true,
  dueDate: true,
  sourceDate: true,
} as const;

type EmailAccount = NonNullable<
  Awaited<ReturnType<typeof getEmailAccountWithAi>>
>;

export type ExtractionContext = {
  emailAccount: EmailAccount;
  emailProvider: EmailProvider;
  memory: Memory | null;
  queueSenders: string[];
  logger: Logger;
};

export async function createExtractionContext({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}): Promise<ExtractionContext | null> {
  const [emailAccount, settings] = await Promise.all([
    getEmailAccountWithAi({ emailAccountId }),
    prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: { knowledgeQueueSenders: true },
    }),
  ]);
  const provider = emailAccount?.account?.provider;
  if (!emailAccount || !provider) {
    logger.warn("No email account or provider for knowledge extraction");
    return null;
  }

  return {
    emailAccount,
    emailProvider: await createEmailProvider({
      emailAccountId,
      provider,
      logger,
    }),
    // Null when the account has no compatible embedder: typed items and
    // thread summaries still work, only Mem0 facts are skipped.
    memory: getKnowledgeMemory(emailAccount),
    queueSenders: settings?.knowledgeQueueSenders ?? [],
    logger,
  };
}

/**
 * Extracts one thread's pending messages, oldest first. Each message builds
 * on the thread state (summary, open items) the previous one left, so the
 * first unexpected failure stops the thread: its later messages wait for the
 * failed one's retry instead of being processed against missing state.
 */
export async function extractThreadKnowledge({
  context,
  messages,
  deadline,
}: {
  context: ExtractionContext;
  messages: PendingMessage[];
  /** Epoch ms after which no new message is started. */
  deadline: number;
}) {
  let processed = 0;
  for (const candidate of messages) {
    if (Date.now() > deadline)
      return { processed, failed: false, complete: false };
    try {
      await extractMessage(context, candidate);
      processed++;
    } catch (error) {
      // Permanent for this message: mark it done so it doesn't become a
      // poison message. Nothing was stored, which is the safe outcome for
      // filtered or deleted content.
      if (isContentFilterError(error) || isThreadNotFoundError(error)) {
        context.logger.warn("Skipping message knowledge extraction", {
          messageId: candidate.messageId,
          reason: isContentFilterError(error) ? "content-filter" : "not-found",
        });
        await markExtracted(context.emailAccount.id, candidate).catch(() => {});
        processed++;
        continue;
      }
      context.logger.error("Knowledge extraction failed for message", {
        error,
        messageId: candidate.messageId,
      });
      return { processed, failed: true, complete: false };
    }
  }
  return { processed, failed: false, complete: true };
}

async function extractMessage(
  context: ExtractionContext,
  candidate: PendingMessage,
) {
  const { emailAccount, emailProvider, memory } = context;
  const emailAccountId = emailAccount.id;

  const message = await emailProvider.getMessage(candidate.messageId);
  const email = getEmailForLLM(message, {
    maxLength: MAX_CONTENT_LENGTH,
    // Long-thread guard: only the text this message itself contributed.
    // Quoted history was already extracted from the messages it quotes.
    extractReply: true,
    removeForwarded: false,
    includeLinkUrls: false,
  });
  if (!email.content?.trim()) {
    await markExtracted(emailAccountId, candidate);
    return;
  }

  const fromQueue = isQueueSender(message, context.queueSenders);
  const [newestExtracted, summarized, threadItems, senderItems] =
    await Promise.all([
      prisma.emailMessage.findFirst({
        where: {
          emailAccountId,
          threadId: candidate.threadId,
          knowledgeExtractedAt: { not: null },
        },
        orderBy: { date: "desc" },
        select: { date: true },
      }),
      prisma.emailMessage.findFirst({
        where: {
          emailAccountId,
          threadId: candidate.threadId,
          threadSummary: { not: null },
        },
        orderBy: { date: "desc" },
        select: { threadSummary: true },
      }),
      prisma.emailItem.findMany({
        where: {
          emailAccountId,
          threadId: candidate.threadId,
          status: EmailItemStatus.OPEN,
        },
        orderBy: { sourceDate: "asc" },
        take: OPEN_ITEMS_LIMIT,
        select: openItemSelect,
      }),
      // A shared queue sends every unrelated ticket, and the user's own
      // items span all their threads, so neither is a meaningful series.
      candidate.sent || fromQueue
        ? []
        : getSenderOpenItems({ emailAccountId, candidate }),
    ]);
  const openItems = [...threadItems, ...senderItems];

  const knownFacts = memory
    ? (
        await memory.search(`${email.subject}\n${email.content}`, {
          topK: KNOWN_FACTS_LIMIT,
          filters: { user_id: emailAccountId },
        })
      ).results.map((result) => result.memory)
    : [];

  const analysis = await analyzeMessageKnowledge({
    logger: context.logger,
    emailAccount,
    email: { ...email, date: candidate.date },
    sent: candidate.sent,
    threadSummary: summarized?.threadSummary ?? null,
    openItems,
    knownFacts,
  });

  const audience = getAudience({
    message,
    sent: candidate.sent,
    userEmail: emailAccount.email,
    fromQueue,
  });

  // A message older than the thread's newest extracted one arrived after
  // the thread moved on (e.g. a backfill window extended further back).
  // Its facts are still true, but the thread's items and summary already
  // reflect newer mail, so its lifecycle output would be stale.
  const late = !!newestExtracted && newestExtracted.date > candidate.date;
  const changes = applyGuards({
    analysis,
    late,
    participants: getParticipants(message, emailAccount.email),
    // An email can only close what came before it. During a newest-first
    // backfill an older reminder may see a newer item; it can skip
    // repeating it but must not resolve it.
    resolvableItemIds: new Set(
      openItems
        .filter((item) => item.sourceDate <= candidate.date)
        .map((item) => item.id),
    ),
  });

  if (memory && changes.facts.length) {
    await memory.add(
      changes.facts.map((content) => ({ role: "user", content })),
      {
        userId: emailAccountId,
        // Facts come from our own extraction pass; mem0 only embeds them.
        infer: false,
        metadata: {
          threadId: candidate.threadId,
          messageId: candidate.messageId,
          direction: candidate.sent ? "sent" : "received",
          audience: audience.toLowerCase(),
          // add()'s timestamp option is rejected by the OSS SDK (paid
          // platform feature), so the message date rides in metadata.
          date: candidate.date.toISOString(),
        },
      },
    );
  }

  context.logger.info("Knowledge extracted from message", {
    messageId: candidate.messageId,
    ephemeral: analysis.ephemeral,
    late,
    facts: changes.facts.length,
    newItems: changes.newItems.length,
    resolvedItems: changes.resolvedItemIds.length,
  });

  const now = new Date();
  await prisma.$transaction([
    prisma.emailItem.createMany({
      data: changes.newItems.map((item) => ({
        ...item,
        emailAccountId,
        threadId: candidate.threadId,
        messageId: candidate.messageId,
        sourceDate: candidate.date,
        audience,
      })),
    }),
    prisma.emailItem.updateMany({
      where: {
        id: { in: changes.resolvedItemIds },
        emailAccountId,
        status: EmailItemStatus.OPEN,
      },
      data: {
        status: EmailItemStatus.RESOLVED,
        resolvedAt: now,
        resolvedByMessageId: candidate.messageId,
      },
    }),
    prisma.emailMessage.update({
      where: messageKey(emailAccountId, candidate),
      data: {
        knowledgeExtractedAt: now,
        ...(changes.threadSummary && { threadSummary: changes.threadSummary }),
      },
    }),
  ]);
}

/**
 * The hard rules the model output must satisfy before anything is stored.
 * These are enforced here rather than trusted to the prompt.
 */
export function applyGuards({
  analysis,
  late,
  participants,
  resolvableItemIds,
}: {
  analysis: MessageAnalysis;
  late: boolean;
  participants: Map<string, string | null>;
  resolvableItemIds: Set<string>;
}) {
  const keep = !analysis.ephemeral;

  return {
    facts: keep
      ? analysis.facts.map((fact) => fact.trim()).filter(Boolean)
      : [],
    threadSummary: late ? null : analysis.threadSummary.trim() || null,
    resolvedItemIds: late
      ? []
      : analysis.resolvedItemIds.filter((id) => resolvableItemIds.has(id)),
    newItems:
      keep && !late
        ? analysis.newItems
            .filter((item) => item.text.trim())
            .map((item) => {
              const counterpartyEmail = item.counterpartyEmail
                ? canonicalizeEmailAddress(item.counterpartyEmail)
                : "";
              // Only a real participant: an address the model made up
              // must not become someone's obligation.
              const isParticipant = participants.has(counterpartyEmail);
              const type = ITEM_TYPES[item.type];
              return {
                type,
                text: item.text.trim(),
                owner:
                  type === EmailItemType.DECISION || !item.owner
                    ? null
                    : ITEM_OWNERS[item.owner],
                counterpartyEmail: isParticipant ? counterpartyEmail : null,
                counterpartyName: isParticipant
                  ? (participants.get(counterpartyEmail) ?? null)
                  : null,
                dueDate: parseDueDate(item.dueDate),
              };
            })
        : [],
  };
}

const ITEM_TYPES = {
  commitment: EmailItemType.COMMITMENT,
  request: EmailItemType.REQUEST,
  deadline: EmailItemType.DEADLINE,
  decision: EmailItemType.DECISION,
} as const;

const ITEM_OWNERS = {
  me: EmailItemOwner.ME,
  them: EmailItemOwner.THEM,
} as const;

function parseDueDate(value: string | null) {
  if (!value || !DATE_ONLY_PATTERN.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  // Rejects rollovers like 2026-02-31, which Date silently turns into March.
  return date.toISOString().startsWith(value) ? date : null;
}

/** Everyone on the message except the user, keyed by lowercase address. */
function getParticipants(message: ParsedMessage, userEmail: string) {
  const participants = new Map<string, string | null>();
  for (const header of [
    message.headers.from,
    message.headers.to,
    message.headers.cc,
  ]) {
    for (const entry of splitRecipientList(header ?? "")) {
      const address = canonicalizeEmailAddress(entry);
      if (!address || isSameEmailAddress(address, userEmail)) continue;
      const name = entry.includes("<")
        ? extractNameFromEmail(entry).replace(/"/g, "").trim()
        : "";
      participants.set(address, name || participants.get(address) || null);
    }
  }
  return participants;
}

function markExtracted(emailAccountId: string, candidate: PendingMessage) {
  return prisma.emailMessage.update({
    where: messageKey(emailAccountId, candidate),
    data: { knowledgeExtractedAt: new Date() },
  });
}

function messageKey(emailAccountId: string, candidate: PendingMessage) {
  return {
    emailAccountId_threadId_messageId: {
      emailAccountId,
      threadId: candidate.threadId,
      messageId: candidate.messageId,
    },
  };
}

/**
 * Whether the user was personally addressed. Mail from a configured shared
 * queue (ticket systems address every agent directly, so recipients can't
 * distinguish it), and mail that reaches the mailbox without the user in
 * To/Cc (distribution list, alias, bcc), rank below personal mail.
 */
function getAudience({
  message,
  sent,
  userEmail,
  fromQueue,
}: {
  message: ParsedMessage;
  sent: boolean;
  userEmail: string;
  fromQueue: boolean;
}): EmailAudience {
  if (sent) return EmailAudience.DIRECT;
  if (fromQueue) return EmailAudience.LIST;

  const to = extractEmailAddresses(message.headers.to ?? "");
  if (to.some((address) => isSameEmailAddress(address, userEmail))) {
    return EmailAudience.DIRECT;
  }

  const cc = extractEmailAddresses(message.headers.cc ?? "");
  if (cc.some((address) => isSameEmailAddress(address, userEmail))) {
    return EmailAudience.CC;
  }

  return EmailAudience.LIST;
}

function isQueueSender(message: ParsedMessage, queueSenders: string[]) {
  const from = extractEmailAddress(message.headers.from ?? "");
  return queueSenders.some((sender) => isSameEmailAddress(from, sender));
}

/** Open items from the sender's other threads, newest first. */
function getSenderOpenItems({
  emailAccountId,
  candidate,
}: {
  emailAccountId: string;
  candidate: PendingMessage;
}) {
  return prisma.$queryRaw<
    Prisma.EmailItemGetPayload<{ select: typeof openItemSelect }>[]
  >`
    SELECT i."id", i."type", i."text", i."owner", i."counterpartyEmail",
      i."dueDate", i."sourceDate"
    FROM "EmailItem" i
    JOIN "EmailMessage" m
      ON m."emailAccountId" = i."emailAccountId"
      AND m."threadId" = i."threadId"
      AND m."messageId" = i."messageId"
    WHERE i."emailAccountId" = ${emailAccountId}
      AND i."status" = 'OPEN'
      AND i."threadId" <> ${candidate.threadId}
      AND m."from" = ${candidate.from}
    ORDER BY i."sourceDate" DESC
    LIMIT ${SENDER_ITEMS_LIMIT}
  `;
}

function isContentFilterError(error: unknown) {
  for (
    let current = error as { code?: unknown; cause?: unknown } | undefined;
    current;
    current = current.cause as { code?: unknown; cause?: unknown } | undefined
  ) {
    if (current.code === "content_filter") return true;
  }
  return false;
}
