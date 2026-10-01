import "@/utils/knowledge/mem0-telemetry";
import { type EmbeddingModel, embed, embedMany } from "ai";
import { Memory } from "mem0ai/oss";
import { env } from "@/env";
import { isKnowledgeStoreEnabled } from "@/utils/knowledge/config";
import { getEmbeddingModel } from "@/utils/llms/model";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("knowledge-memory");

const KNOWLEDGE_COLLECTION = "knowledge_memories";
const EMBEDDING_DIMS = 1536;
// mem0's own OpenAI client waits up to 10 minutes per attempt, which let a
// provider slowdown stall an account's drain far past its lock.
const EMBED_TIMEOUT_MS = 30_000;

// One Memory per account: the pgvector pool is shared per instance and the
// config only changes when the account's provider setup does.
const memoryCache = new Map<string, { fingerprint: string; memory: Memory }>();

/**
 * The Mem0 store for an account, or null when the store is disabled or no
 * configured provider can embed. All memories are scoped by
 * `userId: emailAccountId`.
 *
 * Facts are extracted by our own structured pass (analyze-message.ts) and
 * written with `infer: false`, so mem0 only embeds and stores: its LLM client
 * is never called and needs no config.
 */
export function getKnowledgeMemory(
  emailAccount: EmailAccountWithAI,
): Memory | null {
  if (!isKnowledgeStoreEnabled()) return null;

  const model = getEmbeddingModel(emailAccount.user);
  if (!model) {
    logger.warn("Knowledge store unavailable: no embedding model", {
      email: emailAccount.email,
    });
    return null;
  }

  const fingerprint = JSON.stringify(emailAccount.user);
  const cached = memoryCache.get(emailAccount.id);
  if (cached?.fingerprint === fingerprint) return cached.memory;

  const memory = new Memory({
    embedder: {
      // mem0 accepts any object with this LangChain Embeddings shape, so the
      // store embeds with the same models as the rest of the app.
      provider: "langchain",
      config: { model: createEmbeddings(model) },
    },
    vectorStore: {
      provider: "pgvector",
      config: {
        collectionName: KNOWLEDGE_COLLECTION,
        embeddingModelDims: EMBEDDING_DIMS,
        connectionString: env.DATABASE_URL,
      },
    },
    disableHistory: true,
  });

  memoryCache.set(emailAccount.id, { fingerprint, memory });
  return memory;
}

function createEmbeddings(model: EmbeddingModel) {
  return {
    embedQuery: async (value: string) =>
      (
        await embed({
          model,
          value,
          abortSignal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        })
      ).embedding,
    embedDocuments: async (values: string[]) =>
      (
        await embedMany({
          model,
          values,
          abortSignal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        })
      ).embeddings,
  };
}
