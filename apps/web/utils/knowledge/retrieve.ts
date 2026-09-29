import { getKnowledgeMemory } from "@/utils/knowledge/memory";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { Logger } from "@/utils/logger";

const KNOWLEDGE_TOP_K = 8;

export type KnowledgeItem = {
  fact: string;
  score?: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * Top-k memories relevant to `query`. Empty when the store is unavailable or
 * has nothing relevant. Memories originate from email content, so callers
 * must keep treating them as untrusted context.
 */
export async function searchKnowledgeItems({
  emailAccount,
  query,
  topK = KNOWLEDGE_TOP_K,
  logger,
}: {
  emailAccount: EmailAccountWithAI;
  query: string;
  topK?: number;
  logger: Logger;
}): Promise<KnowledgeItem[]> {
  const memory = getKnowledgeMemory(emailAccount);
  if (!memory) return [];

  try {
    const { results } = await memory.search(query, {
      topK,
      filters: { user_id: emailAccount.id },
    });

    return results.map((item) => ({
      fact: item.memory,
      score: item.score,
      metadata: item.metadata,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
  } catch (error) {
    logger.error("Knowledge search failed", { error });
    return [];
  }
}

/** `searchKnowledgeItems` formatted for prompt injection, or null when empty. */
export async function searchKnowledge(options: {
  emailAccount: EmailAccountWithAI;
  query: string;
  topK?: number;
  logger: Logger;
}): Promise<string | null> {
  const items = await searchKnowledgeItems(options);
  if (!items.length) return null;

  return items.map((item) => `- ${item.fact}`).join("\n");
}
