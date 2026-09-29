import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  testEnv,
  memoryConstructor,
  getModelForUseCase,
  getEmbeddingProviderConfigs,
} = vi.hoisted(() => ({
  testEnv: {
    NEXT_PUBLIC_KNOWLEDGE_STORE_ENABLED: true,
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  },
  memoryConstructor: vi.fn(),
  getModelForUseCase: vi.fn(),
  getEmbeddingProviderConfigs: vi.fn(),
}));

vi.mock("@/env", () => ({ env: testEnv }));
vi.mock("server-only", () => ({}));

vi.mock("mem0ai/oss", () => ({
  Memory: class {
    constructor(config: any) {
      memoryConstructor(config);
    }
  },
}));

vi.mock("@/utils/llms/use-cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/llms/use-cases")>()),
  getModelForUseCase: (...args: unknown[]) => getModelForUseCase(...args),
}));
vi.mock("@/utils/llms/model", () => ({
  getEmbeddingProviderConfigs: (...args: unknown[]) =>
    getEmbeddingProviderConfigs(...args),
  resolveProviderApiKey: (_provider: string, userKey?: string | null) =>
    userKey || "env-key",
}));

import { getKnowledgeMemory } from "./memory";
import { getEmailAccount } from "@/__tests__/helpers";

function setupProviders({
  chatProvider = "openai",
  embeddingProvider = "openai",
}: {
  chatProvider?: string;
  embeddingProvider?: string;
} = {}) {
  getModelForUseCase.mockReturnValue({
    provider: chatProvider,
    modelName: "test-model",
  });
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

  it("routes a non-OpenAI provider through its OpenAI-compatible endpoint", () => {
    setupProviders({ chatProvider: "anthropic" });

    const memory = getKnowledgeMemory(getEmailAccount());

    expect(memory).not.toBeNull();
    const config = memoryConstructor.mock.calls[0][0];
    expect(config.llm.provider).toBe("openai");
    expect(config.llm.config.baseURL).toBe("https://api.anthropic.com/v1/");
    expect(config.llm.config.model).toBe("test-model");
    expect(config.disableHistory).toBe(true);
    expect(config.vectorStore.provider).toBe("pgvector");
    expect(config.vectorStore.config.connectionString).toBe(
      testEnv.DATABASE_URL,
    );
  });

  it("returns null for a chat provider with no OpenAI-compatible endpoint", () => {
    setupProviders({ chatProvider: "bedrock" });

    expect(getKnowledgeMemory(getEmailAccount())).toBeNull();
    expect(memoryConstructor).not.toHaveBeenCalled();
  });

  it("returns null when no embedding provider is compatible", () => {
    setupProviders({ embeddingProvider: "azure" });

    expect(getKnowledgeMemory(getEmailAccount())).toBeNull();
    expect(memoryConstructor).not.toHaveBeenCalled();
  });

  it("reuses the instance for an unchanged account config", () => {
    setupProviders();
    const emailAccount = getEmailAccount();

    const first = getKnowledgeMemory(emailAccount);
    const second = getKnowledgeMemory(emailAccount);

    expect(first).toBe(second);
    expect(memoryConstructor).toHaveBeenCalledTimes(1);
  });
});
