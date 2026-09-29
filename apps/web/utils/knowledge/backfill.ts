import { subMonths } from "date-fns";
import { z } from "zod";
import { isKnowledgeStoreEnabled } from "@/utils/knowledge/config";
import { extractKnowledgeFromMessages } from "@/utils/knowledge/extract-from-messages";
import {
  KNOWLEDGE_QUEUE_NAME,
  KNOWLEDGE_QUEUE_PARALLELISM,
} from "@/utils/knowledge/extract-queue";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";

export const DEFAULT_BACKFILL_MONTHS = 12;

// Each message costs a provider fetch plus an LLM call, so one drain
// iteration must fit well inside the route's 300s budget even when slow.
export const DRAIN_BATCH_SIZE = 10;

export const knowledgeBackfillBody = z.object({
  emailAccountId: z.string(),
  after: z.coerce.date(),
  /** Drain cursor: only messages strictly older than this are considered. */
  before: z.coerce.date().optional(),
});
export type KnowledgeBackfillBody = z.infer<typeof knowledgeBackfillBody>;

/**
 * Kicks off a knowledge backfill for the account's historical mail. The
 * durable state is the `knowledgeExtractedAt` marker in Postgres, so only a
 * single self-chaining drain job is queued: each iteration processes the next
 * batch of unextracted messages (newest first) and re-enqueues itself with
 * the date of the oldest message it saw as the new cursor.
 *
 * That makes the backfill safe to stop and restart at any point: killing the
 * queue loses at most one in-flight job, and calling this again resumes from
 * wherever the markers say work remains.
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

  // The window start is resolved here, not per iteration, so the drain works
  // against a fixed window instead of one that drifts with the clock.
  const resolvedAfter = after ?? subMonths(new Date(), sinceMonths);

  const remaining = await prisma.emailMessage.count({
    where: backfillCandidateWhere({
      emailAccountId,
      after: resolvedAfter,
      before,
    }),
  });

  if (remaining) {
    await enqueueKnowledgeBackfillJob({
      emailAccountId,
      after: resolvedAfter,
      before,
      logger,
    });
  }

  logger.info("Queued knowledge backfill", { queued: remaining, sinceMonths });
  return { queued: remaining };
}

/**
 * One drain iteration: extract the next batch below the cursor, then
 * re-enqueue with the cursor advanced past it. The cursor moves regardless of
 * per-message failures, so a poison message can't stall the drain; anything
 * left unmarked is retried by simply starting another backfill.
 */
export async function runKnowledgeBackfillBatch({
  emailAccountId,
  after,
  before,
  logger,
}: KnowledgeBackfillBody & { logger: Logger }) {
  if (!isKnowledgeStoreEnabled()) return { processed: 0, done: true };

  const candidates = await prisma.emailMessage.findMany({
    where: backfillCandidateWhere({ emailAccountId, after, before }),
    orderBy: { date: "desc" },
    take: DRAIN_BATCH_SIZE,
    select: { messageId: true, date: true },
  });
  if (!candidates.length) {
    logger.info("Knowledge backfill drained", { emailAccountId });
    return { processed: 0, done: true };
  }

  const { processed } = await extractKnowledgeFromMessages({
    emailAccountId,
    messageIds: candidates.map((candidate) => candidate.messageId),
    logger,
  });

  if (candidates.length < DRAIN_BATCH_SIZE) {
    logger.info("Knowledge backfill drained", { emailAccountId });
    return { processed, done: true };
  }

  // ponytail: a strict `lt` cursor skips unprocessed messages sharing the
  // boundary message's exact timestamp; tie-break on messageId if that ever
  // matters.
  await enqueueKnowledgeBackfillJob({
    emailAccountId,
    after,
    before: candidates[candidates.length - 1].date,
    logger,
  });
  return { processed, done: false };
}

function backfillCandidateWhere({
  emailAccountId,
  after,
  before,
}: {
  emailAccountId: string;
  after: Date;
  before?: Date;
}) {
  return {
    emailAccountId,
    knowledgeExtractedAt: null,
    draft: false,
    date: { gte: after, ...(before && { lt: before }) },
    OR: [{ aiCategory: null }, { aiCategory: { not: "newsletter" } }],
  };
}

async function enqueueKnowledgeBackfillJob({
  logger,
  ...body
}: KnowledgeBackfillBody & { logger: Logger }) {
  await enqueueBackgroundJob<KnowledgeBackfillBody>({
    topic: "knowledge-backfill",
    body,
    qstash: {
      queueName: KNOWLEDGE_QUEUE_NAME,
      parallelism: KNOWLEDGE_QUEUE_PARALLELISM,
      path: "/api/knowledge/backfill",
    },
    logger,
  });
}
