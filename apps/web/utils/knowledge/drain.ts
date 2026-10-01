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
import { mapWithConcurrency } from "@/utils/async";
import prisma from "@/utils/prisma";
import { acquireOwnedLock, clearOwnedLock } from "@/utils/redis/owned-lock";

// Each message costs a provider fetch plus an LLM call (~4s). One iteration
// must fit well inside the route's 300s budget even if every message lands
// in a single thread, which runs sequentially.
export const DRAIN_BATCH_SIZE = 15;
// Outlook allows 4 concurrent requests per mailbox.
const THREAD_CONCURRENCY = 3;
// Outlives the route's max duration, so a killed iteration frees the lock.
const LOCK_TTL_SECONDS = 360;
// No message starts after this, so an iteration ends inside the route's
// 300s budget (and the lock TTL) even when calls run slow: the deadline plus
// one message's worst case (the 90s analysis timeout and its I/O).
const ITERATION_DEADLINE_MS = 180_000;

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
    SELECT "messageId", "threadId", "from", "sent", "date"
    FROM "EmailMessage"
    WHERE ${pendingKnowledgeSql(emailAccountId)}
      AND "threadId" = ANY(${threads.map((thread) => thread.threadId)})
    ORDER BY "date" ASC, "messageId" ASC
  `;
  const pendingByThread = groupBy(pending, (message) => message.threadId);

  // Whole threads while they fit; the first that doesn't gets the rest of
  // the budget and is resumed by the next iteration.
  let budget = DRAIN_BATCH_SIZE;
  const batches: {
    thread: (typeof threads)[number];
    messages: PendingMessage[];
    partial: boolean;
  }[] = [];
  for (const thread of threads) {
    if (budget <= 0) break;
    const pendingInThread = pendingByThread[thread.threadId] ?? [];
    const messages = pendingInThread.slice(0, budget);
    budget -= messages.length;
    batches.push({
      thread,
      messages,
      partial: messages.length < pendingInThread.length,
    });
  }

  // Order only matters inside a thread, so threads run side by side.
  const deadline = Date.now() + ITERATION_DEADLINE_MS;
  const results = await mapWithConcurrency(
    batches,
    THREAD_CONCURRENCY,
    ({ messages }) => extractThreadKnowledge({ context, messages, deadline }),
  );

  // The cursor may only pass a prefix of finished threads: a thread cut off
  // by the budget or the deadline must be selected again. A failed thread
  // counts as finished; its remaining messages are retried by the next
  // pass. A full page of threads, or one the budget didn't reach, may have
  // more below it.
  let nextCursor = cursor;
  let more =
    threads.length === DRAIN_BATCH_SIZE || batches.length < threads.length;
  for (const [index, { thread, partial }] of batches.entries()) {
    const result = results[index];
    if (!result.failed && (partial || !result.complete)) {
      more = true;
      break;
    }
    nextCursor = { date: thread.latest, threadId: thread.threadId };
  }

  const processed = results.reduce((sum, result) => sum + result.processed, 0);
  logger.info("Knowledge drain batch done", {
    processed,
    threads: threads.length,
  });
  return { processed, more, cursor: nextCursor };
}
