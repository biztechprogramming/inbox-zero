import chunk from "lodash/chunk";
import { z } from "zod";
import { isKnowledgeStoreEnabled } from "@/utils/knowledge/config";
import type { Logger } from "@/utils/logger";
import { publishToQstashQueue } from "@/utils/upstash";

const KNOWLEDGE_EXTRACT_PREFIX = "knowledge-extract";
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
        publishToQstashQueue({
          queueName: `${KNOWLEDGE_EXTRACT_PREFIX}-${emailAccountId}`,
          // Extraction calls the provider and an LLM per message; keep one
          // job at a time per account so a large sync can't stampede either.
          parallelism: 1,
          path: "/api/knowledge/extract-batch",
          body: {
            emailAccountId,
            messageIds: ids,
          } satisfies ExtractKnowledgeBody,
        }),
      ),
    );
  } catch (error) {
    logger.error("Failed to queue knowledge extraction", { error });
  }
}
