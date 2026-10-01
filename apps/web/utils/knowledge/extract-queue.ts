import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { isKnowledgeStoreEnabled } from "@/utils/knowledge/config";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";
import { redis } from "@/utils/redis";

// Static queue name (not per-account) so the BullMQ worker can subscribe to
// it; per-account queue names would never be drained on self-hosted deploys.
const KNOWLEDGE_QUEUE_NAME = "knowledge-extract";
const KNOWLEDGE_QUEUE_PARALLELISM = 3;
const DIRTY_TTL_SECONDS = 60 * 60 * 24;

export const knowledgeDrainBody = z.object({
  emailAccountId: z.string(),
  /** Resume point inside a pass: threads ordered below this one remain. */
  cursor: z.object({ date: z.coerce.date(), threadId: z.string() }).optional(),
});
export type KnowledgeDrainBody = z.infer<typeof knowledgeDrainBody>;

/**
 * Messages waiting for extraction. The single definition of eligibility:
 * newsletters carry no durable personal facts, drafts are not mail yet, and
 * null category (sent mail, enrichment failures) is still extracted.
 */
export function pendingKnowledgeSql(emailAccountId: string) {
  return Prisma.sql`"emailAccountId" = ${emailAccountId}
    AND "knowledgeRequestedAt" IS NOT NULL
    AND "knowledgeExtractedAt" IS NULL
    AND "draft" = false
    AND ("aiCategory" IS NULL OR "aiCategory" <> 'newsletter')`;
}

/**
 * Queues messages that just went through a sync batch for extraction. The
 * request marker is durable, so the drain picks them up even if this kick's
 * job is lost; failures are logged and swallowed to keep sync unaffected.
 */
export async function queueKnowledgeExtraction({
  emailAccountId,
  messageIds,
  logger,
}: {
  emailAccountId: string;
  messageIds: string[];
  logger: Logger;
}) {
  if (!isKnowledgeStoreEnabled()) return;
  if (!messageIds.length) return;

  try {
    const { count } = await prisma.emailMessage.updateMany({
      where: {
        emailAccountId,
        messageId: { in: messageIds },
        draft: false,
        knowledgeRequestedAt: null,
        knowledgeExtractedAt: null,
      },
      data: { knowledgeRequestedAt: new Date() },
    });
    // Re-syncs of known messages (read-state changes etc.) add no work.
    if (count) await kickKnowledgeDrain({ emailAccountId, logger });
  } catch (error) {
    logger.error("Failed to queue knowledge extraction", { error });
  }
}

/**
 * Wakes the account's drain. The dirty flag is set before the job is queued:
 * if a drain is already running, this job finds its lock taken and exits,
 * and the running drain sees the flag when it finishes and starts another
 * pass. Either way the new work is picked up.
 */
export async function kickKnowledgeDrain({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}) {
  await redis.set(getDirtyKey(emailAccountId), "1", { ex: DIRTY_TTL_SECONDS });
  await enqueueKnowledgeDrain({ body: { emailAccountId }, logger });
}

export async function enqueueKnowledgeDrain({
  body,
  logger,
}: {
  body: KnowledgeDrainBody;
  logger: Logger;
}) {
  await enqueueBackgroundJob<KnowledgeDrainBody>({
    topic: KNOWLEDGE_QUEUE_NAME,
    body,
    qstash: {
      queueName: KNOWLEDGE_QUEUE_NAME,
      parallelism: KNOWLEDGE_QUEUE_PARALLELISM,
      path: "/api/knowledge/drain",
    },
    logger,
  });
}

export function clearDrainDirtyFlag(emailAccountId: string) {
  return redis.del(getDirtyKey(emailAccountId));
}

export async function takeDrainDirtyFlag(emailAccountId: string) {
  return !!(await redis.getdel(getDirtyKey(emailAccountId)));
}

function getDirtyKey(emailAccountId: string) {
  return `knowledge:drain-dirty:${emailAccountId}`;
}
