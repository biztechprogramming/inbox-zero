import { beforeEach, describe, expect, it, vi } from "vitest";

const { testEnv, memoryConstructor, getEmbeddingProviderConfigs } = vi.hoisted(
  () => ({
    testEnv: {
      NEXT_PUBLIC_KNOWLEDGE_STORE_ENABLED: true,
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    },
    memoryConstructor: vi.fn(),
    getEmbeddingProviderConfigs: vi.fn(),
  }),
);

vi.mock("@/env", () => ({ env: testEnv }));
vi.mock("server-only", () => ({}));

vi.mock("mem0ai/oss", () => ({
  Memory: class {
    constructor(config: any) {
      memoryConstructor(config);
    }
  },
}));

vi.mock("@/utils/llms/model", () => ({
  getEmbeddingProviderConfigs: (...args: unknown[]) =>
    getEmbeddingProviderConfigs(...args),
}));

import { getKnowledgeMemory } from "./memory";
import { getEmailAccount } from "@/__tests__/helpers";

function setupProviders({
  embeddingProvider = "openai",
}: {
  embeddingProvider?: string;
} = {}) {
  getEmbeddingProviderConfigs.mockReturnValue([
    {
      provider: embeddingProvider,
      modelId: "text-embedding-3-small",
      apiKey: "embed-key",
    },
  ]);
}

describe("getKnowledgeMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testEnv.NEXT_PUBLIC_KNOWLEDGE_STORE_ENABLED = true;
  });

  it("returns null when the store is disabled", () => {
    testEnv.NEXT_PUBLIC_KNOWLEDGE_STORE_ENABLED = false;
    setupProviders();

    expect(getKnowledgeMemory(getEmailAccount())).toBeNull();
    expect(memoryConstructor).not.toHaveBeenCalled();
  });

  it("stores through pgvector without an extraction LLM", () => {
    setupProviders();

    const memory = getKnowledgeMemory(getEmailAccount());

    expect(memory).not.toBeNull();
    const config = memoryConstructor.mock.calls[0][0];
    expect(config.llm).toBeUndefined();
    expect(config.embedder.config.apiKey).toBe("embed-key");
    expect(config.disableHistory).toBe(true);
    expect(config.vectorStore.provider).toBe("pgvector");
    expect(config.vectorStore.config.connectionString).toBe(
      testEnv.DATABASE_URL,
    );
  });

  it("returns null when no embedding provider is compatible", () => {
    setupProviders({ embeddingProvider: "azure" });

    expect(getKnowledgeMemory(getEmailAccount())).toBeNull();
    expect(memoryConstructor).not.toHaveBeenCalled();
  });

  it("reuses the instance for an unchanged account config", () => {
    setupProviders();
    const emailAccount = { ...getEmailAccount(), id: "cache-account" };

    const first = getKnowledgeMemory(emailAccount);
    const second = getKnowledgeMemory(emailAccount);

    expect(first).toBe(second);
    expect(memoryConstructor).toHaveBeenCalledTimes(1);
  });
});
