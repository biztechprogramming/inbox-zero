import "@/utils/knowledge/mem0-telemetry";
import { Memory } from "mem0ai/oss";
import { env } from "@/env";
import { isKnowledgeStoreEnabled } from "@/utils/knowledge/config";
import { Provider } from "@/utils/llms/config";
import { getEmbeddingProviderConfigs } from "@/utils/llms/model";
import type { EmailAccountWithAI, UserAIFields } from "@/utils/llms/types";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("knowledge-memory");

const KNOWLEDGE_COLLECTION = "knowledge_memories";
const EMBEDDING_DIMS = 1536;

// Facts are extracted by our own structured pass (analyze-message.ts) and
// written with `infer: false`, so mem0 only embeds and stores: its LLM client
// is never called and needs no config. The embedder routes through the
// already-installed `openai` client against each provider's OpenAI-compatible
// endpoint; providers without one disable the store for that account.
const EMBEDDER_BASE_URLS: Record<string, string | undefined> = {
  [Provider.OPEN_AI]: undefined,
  [Provider.AI_GATEWAY]: "https://ai-gateway.vercel.sh/v1",
  ...(env.AZURE_FOUNDRY_BASE_URL && {
    [Provider.AZURE_FOUNDRY]: env.AZURE_FOUNDRY_BASE_URL,
  }),
};

// One Memory per account: the pgvector pool is shared per instance and the
// config only changes when the account's provider setup does.
const memoryCache = new Map<string, { fingerprint: string; memory: Memory }>();

/**
 * The Mem0 store for an account, or null when the store is disabled or the
 * account's embedding providers have no OpenAI-compatible endpoint. All
 * memories are scoped by `userId: emailAccountId`.
 */
export function getKnowledgeMemory(
  emailAccount: EmailAccountWithAI,
): Memory | null {
  if (!isKnowledgeStoreEnabled()) return null;

  const embedder = getEmbedderConfig(emailAccount.user);
  if (!embedder) {
    logger.warn("Knowledge store unavailable: no compatible embedder", {
      email: emailAccount.email,
    });
    return null;
  }

  const fingerprint = JSON.stringify(embedder);
  const cached = memoryCache.get(emailAccount.id);
  if (cached?.fingerprint === fingerprint) return cached.memory;

  const memory = new Memory({
    embedder: {
      provider: "openai",
      config: {
        apiKey: embedder.apiKey,
        model: embedder.modelId,
        embeddingDims: EMBEDDING_DIMS,
        ...(embedder.baseURL && { baseURL: embedder.baseURL }),
      },
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

function getEmbedderConfig(userAi: UserAIFields) {
  for (const candidate of getEmbeddingProviderConfigs(userAi)) {
    if (!(candidate.provider in EMBEDDER_BASE_URLS)) continue;
    return {
      apiKey: candidate.apiKey,
      modelId: candidate.modelId,
      baseURL: EMBEDDER_BASE_URLS[candidate.provider],
    };
  }
  return null;
}
