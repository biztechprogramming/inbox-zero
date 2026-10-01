import { subMonths } from "date-fns";
import { Prisma } from "@/generated/prisma/client";
import { isKnowledgeStoreEnabled } from "@/utils/knowledge/config";
import {
  kickKnowledgeDrain,
  pendingKnowledgeSql,
} from "@/utils/knowledge/extract-queue";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

export const DEFAULT_BACKFILL_MONTHS = 12;

/**
 * Queues the account's historical mirror mail for knowledge extraction by
 * marking the window's messages requested and kicking the account's drain,
 * the same consumer live sync feeds.
 *
 * Safe to stop and restart at any point: the durable state is the
 * requested/extracted markers in Postgres, so calling this again resumes
 * wherever they say work remains.
 */
export async function queueKnowledgeBackfill({
  emailAccountId,
  sinceMonths = DEFAULT_BACKFILL_MONTHS,
  after,
  before,
  logger,
}: {
  emailAccountId: string;
  sinceMonths?: number;
  /** Explicit window start; defaults to `sinceMonths` ago. */
  after?: Date;
  /** Exclusive window end; unbounded when absent. */
  before?: Date;
  logger: Logger;
}) {
  if (!isKnowledgeStoreEnabled()) return { queued: 0 };

  const resolvedAfter = after ?? subMonths(new Date(), sinceMonths);

  await prisma.emailMessage.updateMany({
    where: {
      emailAccountId,
      date: { gte: resolvedAfter, ...(before && { lt: before }) },
      draft: false,
      knowledgeRequestedAt: null,
      knowledgeExtractedAt: null,
    },
    data: { knowledgeRequestedAt: new Date() },
  });

  const [{ count }] = await prisma.$queryRaw<[{ count: number }]>`
    SELECT COUNT(*)::int AS "count"
    FROM "EmailMessage"
    WHERE ${pendingKnowledgeSql(emailAccountId)}
      AND "date" >= ${resolvedAfter}
      ${before ? Prisma.sql`AND "date" < ${before}` : Prisma.empty}
  `;

  if (count) await kickKnowledgeDrain({ emailAccountId, logger });

  logger.info("Queued knowledge backfill", { queued: count, sinceMonths });
  return { queued: count };
}
