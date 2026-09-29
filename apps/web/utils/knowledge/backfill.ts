import { subMonths } from "date-fns";
import { isKnowledgeStoreEnabled } from "@/utils/knowledge/config";
import { queueKnowledgeExtraction } from "@/utils/knowledge/extract-queue";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

export const DEFAULT_BACKFILL_MONTHS = 12;

/**
 * Queues knowledge extraction for the account's historical mail, newest first
 * so the freshest knowledge lands earliest. Reads candidates from the local
 * EmailMessage mirror, so coverage is whatever the mailbox sync has already
 * stored; messages synced later are picked up by the regular sync-time hook.
 *
 * Safe to call repeatedly: extraction is keyed on `knowledgeExtractedAt`, so
 * already-processed messages are excluded here and are no-ops in the consumer.
 */
export async function queueKnowledgeBackfill({
  emailAccountId,
  sinceMonths = DEFAULT_BACKFILL_MONTHS,
  logger,
}: {
  emailAccountId: string;
  sinceMonths?: number;
  logger: Logger;
}) {
  if (!isKnowledgeStoreEnabled()) return { queued: 0 };

  const candidates = await prisma.emailMessage.findMany({
    where: {
      emailAccountId,
      knowledgeExtractedAt: null,
      draft: false,
      date: { gte: subMonths(new Date(), sinceMonths) },
      OR: [{ aiCategory: null }, { aiCategory: { not: "newsletter" } }],
    },
    orderBy: { date: "desc" },
    select: { messageId: true },
  });

  if (candidates.length) {
    await queueKnowledgeExtraction({
      emailAccountId,
      messageIds: candidates.map((candidate) => candidate.messageId),
      logger,
    });
  }

  logger.info("Queued knowledge backfill", {
    queued: candidates.length,
    sinceMonths,
  });
  return { queued: candidates.length };
}
