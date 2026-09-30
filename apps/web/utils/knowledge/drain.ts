import groupBy from "lodash/groupBy";
import { Prisma } from "@/generated/prisma/client";
import { isKnowledgeStoreEnabled } from "@/utils/knowledge/config";
import {
  createExtractionContext,
  extractThreadKnowledge,
  type PendingMessage,
} from "@/utils/knowledge/extract-from-messages";
import {
  clearDrainDirtyFlag,
  enqueueKnowledgeDrain,
  type KnowledgeDrainBody,
  pendingKnowledgeSql,
  takeDrainDirtyFlag,
} from "@/utils/knowledge/extract-queue";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { acquireOwnedLock, clearOwnedLock } from "@/utils/redis/owned-lock";

// Each message costs a provider fetch plus an LLM call, so one iteration must
// fit well inside the route's 300s budget even when slow.
export const DRAIN_BATCH_SIZE = 10;
// Outlives the route's max duration, so a killed iteration frees the lock.
const LOCK_TTL_SECONDS = 360;

type Cursor = NonNullable<KnowledgeDrainBody["cursor"]>;

/**
 * One iteration of an account's knowledge drain: the only consumer of
 * pending extraction work (live sync and backfill alike).
 *
 * Thread lifecycle needs each thread's messages processed oldest-first and
 * one at a time, so an account has at most one iteration running (Redis
 * lock). A pass visits threads newest-activity first, so fresh mail lands
 * before history, and re-enqueues itself with a cursor until nothing is left
 * below it. A kick that arrived meanwhile (dirty flag) starts a fresh pass.
 */
export async function runKnowledgeDrain({
  emailAccountId,
  cursor,
  logger,
}: KnowledgeDrainBody & { logger: Logger }) {
  if (!isKnowledgeStoreEnabled()) return { status: "disabled" as const };

  const lockKey = `knowledge:drain:${emailAccountId}`;
  const lockToken = await acquireOwnedLock({
    key: lockKey,
    processingTtlSeconds: LOCK_TTL_SECONDS,
  });
  if (!lockToken) return { status: "busy" as const };

  let result: Awaited<ReturnType<typeof drainBatch>>;
  try {
    // A cursor-less iteration sees every pending message, so kicks before
    // this point are satisfied by it. Must precede the selection below.
    if (!cursor) await clearDrainDirtyFlag(emailAccountId);
    result = await drainBatch({ emailAccountId, cursor, logger });
  } finally {
    await clearOwnedLock({ key: lockKey, lockToken });
  }

  // Checked after the lock is released: a kick that failed to take the lock
  // set the flag first, so it is visible here.
  if (result.more) {
    await enqueueKnowledgeDrain({
      body: { emailAccountId, cursor: result.cursor },
      logger,
    });
  } else if (await takeDrainDirtyFlag(emailAccountId)) {
    await enqueueKnowledgeDrain({ body: { emailAccountId }, logger });
  } else {
    logger.info("Knowledge drain idle");
  }

  return {
    status: result.more ? ("continuing" as const) : ("drained" as const),
    processed: result.processed,
  };
}

async function drainBatch({
  emailAccountId,
  cursor,
  logger,
}: {
  emailAccountId: string;
  cursor?: Cursor;
  logger: Logger;
}): Promise<{ processed: number; more: boolean; cursor?: Cursor }> {
  const threads = await prisma.$queryRaw<{ threadId: string; latest: Date }[]>`
    SELECT "threadId", MAX("date") AS "latest"
    FROM "EmailMessage"
    WHERE ${pendingKnowledgeSql(emailAccountId)}
    GROUP BY "threadId"
    ${
      cursor
        ? Prisma.sql`HAVING (MAX("date"), "threadId") < (${cursor.date}, ${cursor.threadId})`
        : Prisma.empty
    }
    ORDER BY "latest" DESC, "threadId" DESC
    LIMIT ${DRAIN_BATCH_SIZE}
  `;
  if (!threads.length) return { processed: 0, more: false };

  const context = await createExtractionContext({ emailAccountId, logger });
  if (!context) return { processed: 0, more: false };

  const pending = await prisma.$queryRaw<PendingMessage[]>`
    SELECT "messageId", "threadId", "sent", "date"
    FROM "EmailMessage"
    WHERE ${pendingKnowledgeSql(emailAccountId)}
      AND "threadId" = ANY(${threads.map((thread) => thread.threadId)})
    ORDER BY "date" ASC, "messageId" ASC
  `;
  const pendingByThread = groupBy(pending, (message) => message.threadId);

  let budget = DRAIN_BATCH_SIZE;
  let processed = 0;
  let nextCursor = cursor;
  // A full page of threads may have more below it; a short one that was
  // fully visited means this pass is done.
  let more = threads.length === DRAIN_BATCH_SIZE;
  for (const thread of threads) {
    const messages = pendingByThread[thread.threadId] ?? [];
    const batch = messages.slice(0, budget);
    budget -= batch.length;

    const result = await extractThreadKnowledge({ context, messages: batch });
    processed += result.processed;

    // Out of budget mid-thread: leave the cursor above it so the next
    // iteration resumes the same thread. A failed thread is passed over;
    // its remaining messages are retried by the next pass.
    if (!result.failed && batch.length < messages.length) {
      more = true;
      break;
    }
    nextCursor = { date: thread.latest, threadId: thread.threadId };
    if (budget <= 0) {
      more = true;
      break;
    }
  }

  logger.info("Knowledge drain batch done", {
    processed,
    threads: threads.length,
  });
  return { processed, more, cursor: nextCursor };
}
