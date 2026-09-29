import chunk from "lodash/chunk";
import { z } from "zod";
import { isKnowledgeStoreEnabled } from "@/utils/knowledge/config";
import type { Logger } from "@/utils/logger";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";

// Static queue name (not per-account) so the BullMQ worker can subscribe to
// it; per-account queue names would never be drained on self-hosted deploys.
export const KNOWLEDGE_QUEUE_NAME = "knowledge-extract";
export const KNOWLEDGE_QUEUE_PARALLELISM = 3;

const BATCH_SIZE = 20;

export const extractKnowledgeBody = z.object({
  emailAccountId: z.string(),
  messageIds: z.array(z.string()).min(1),
});
export type ExtractKnowledgeBody = z.infer<typeof extractKnowledgeBody>;

/**
 * Queues knowledge extraction for messages that just went through a sync
 * batch. Extraction is LLM work, so it runs off the sync path; the
 * `knowledgeExtractedAt` marker makes duplicate queue deliveries no-ops.
 * Failures are logged and swallowed: a missed enqueue self-heals on the next
 * sync of the same messages.
 */
export async function queueKnowledgeExtraction({
  emailAccountId,
  messageIds,
  logger,
}: ExtractKnowledgeBody & { logger: Logger }) {
  if (!isKnowledgeStoreEnabled()) return;
  if (!messageIds.length) return;

  try {
    await Promise.all(
      chunk(messageIds, BATCH_SIZE).map((ids) =>
        enqueueBackgroundJob<ExtractKnowledgeBody>({
          topic: KNOWLEDGE_QUEUE_NAME,
          body: { emailAccountId, messageIds: ids },
          qstash: {
            queueName: KNOWLEDGE_QUEUE_NAME,
            parallelism: KNOWLEDGE_QUEUE_PARALLELISM,
            path: "/api/knowledge/extract-batch",
          },
          logger,
        }),
      ),
    );
  } catch (error) {
    logger.error("Failed to queue knowledge extraction", { error });
  }
}
