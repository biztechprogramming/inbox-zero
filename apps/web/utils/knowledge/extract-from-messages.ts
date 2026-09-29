import { createEmailProvider } from "@/utils/email/provider";
import { getEmailForLLM } from "@/utils/get-email-from-message";
import { getKnowledgeMemory } from "@/utils/knowledge/memory";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { stringifyEmail } from "@/utils/stringify-email";
import { getEmailAccountWithAi } from "@/utils/user/get";

// Maximum knowledge: read the whole fresh fragment, not the enrichment
// snippet. Quoted history is stripped below, so this bounds a single
// message's own text.
const MAX_CONTENT_LENGTH = 10_000;

/**
 * Extracts durable facts from the given messages into the account's Mem0
 * store. Mem0 handles fact extraction and dedup (ADD/UPDATE/NOOP) internally;
 * this function owns candidate selection, content preparation, and the
 * `knowledgeExtractedAt` marker that makes reprocessing a no-op.
 *
 * Messages are processed independently: one failure leaves that message's
 * marker null (retried on its next sync) without blocking the rest.
 */
export async function extractKnowledgeFromMessages({
  emailAccountId,
  messageIds,
  logger,
}: {
  emailAccountId: string;
  messageIds: string[];
  logger: Logger;
}) {
  const candidates = await prisma.emailMessage.findMany({
    where: {
      emailAccountId,
      messageId: { in: messageIds },
      knowledgeExtractedAt: null,
      draft: false,
      // Newsletters are the one category with no durable personal facts.
      // Null category (sent mail, enrichment failures) is still extracted.
      OR: [{ aiCategory: null }, { aiCategory: { not: "newsletter" } }],
    },
    select: { messageId: true, threadId: true, sent: true, date: true },
  });
  if (!candidates.length) return { processed: 0 };

  const emailAccount = await getEmailAccountWithAi({ emailAccountId });
  if (!emailAccount) {
    logger.warn("Email account not found for knowledge extraction");
    return { processed: 0 };
  }

  const memory = getKnowledgeMemory(emailAccount);
  if (!memory) return { processed: 0 };

  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { account: { select: { provider: true } } },
  });
  if (!account?.account?.provider) {
    logger.warn("No provider for knowledge extraction account");
    return { processed: 0 };
  }

  const emailProvider = await createEmailProvider({
    emailAccountId,
    provider: account.account.provider,
    logger,
  });

  let processed = 0;
  for (const candidate of candidates) {
    try {
      const message = await emailProvider.getMessage(candidate.messageId);
      const email = getEmailForLLM(message, {
        maxLength: MAX_CONTENT_LENGTH,
        // Long-thread guard: only the text this message itself contributed.
        // Quoted history was already extracted from the messages it quotes.
        extractReply: true,
        removeForwarded: false,
        includeLinkUrls: false,
      });

      if (email.content?.trim()) {
        await memory.add(
          [
            {
              role: "user",
              content: stringifyEmail(email, MAX_CONTENT_LENGTH),
            },
          ],
          {
            userId: emailAccountId,
            timestamp: candidate.date,
            metadata: {
              threadId: candidate.threadId,
              messageId: candidate.messageId,
              direction: candidate.sent ? "sent" : "received",
            },
          },
        );
      }

      await prisma.emailMessage.update({
        where: {
          emailAccountId_threadId_messageId: {
            emailAccountId,
            threadId: candidate.threadId,
            messageId: candidate.messageId,
          },
        },
        data: { knowledgeExtractedAt: new Date() },
      });
      processed++;
    } catch (error) {
      logger.error("Knowledge extraction failed for message", {
        error,
        messageId: candidate.messageId,
      });
    }
  }

  logger.info("Knowledge extraction batch done", {
    processed,
    candidates: candidates.length,
  });
  return { processed };
}
