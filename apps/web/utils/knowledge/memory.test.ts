import { beforeEach, describe, expect, it, vi } from "vitest";

const { testEnv, memoryConstructor, getEmbeddingModel, embed } = vi.hoisted(
  () => ({
    testEnv: {
      NEXT_PUBLIC_KNOWLEDGE_STORE_ENABLED: true,
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    },
    memoryConstructor: vi.fn(),
    getEmbeddingModel: vi.fn(),
    embed: vi.fn(),
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
vi.mock("@/utils/llms/model", () => ({ getEmbeddingModel }));
vi.mock("ai", () => ({ embed, embedMany: vi.fn() }));

import { getKnowledgeMemory } from "./memory";
import { getEmailAccount } from "@/__tests__/helpers";

describe("getKnowledgeMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testEnv.NEXT_PUBLIC_KNOWLEDGE_STORE_ENABLED = true;
    getEmbeddingModel.mockReturnValue({ modelId: "text-embedding-3-small" });
  });

  it("returns null when the store is disabled", () => {
    testEnv.NEXT_PUBLIC_KNOWLEDGE_STORE_ENABLED = false;

    expect(getKnowledgeMemory(getEmailAccount())).toBeNull();
    expect(memoryConstructor).not.toHaveBeenCalled();
  });

  it("returns null when no configured provider can embed", () => {
    getEmbeddingModel.mockReturnValue(null);

    expect(getKnowledgeMemory(getEmailAccount())).toBeNull();
    expect(memoryConstructor).not.toHaveBeenCalled();
  });

  it("stores through pgvector with the app's embedding model and no LLM", async () => {
    getKnowledgeMemory(getEmailAccount());

    const config = memoryConstructor.mock.calls[0][0];
    expect(config.llm).toBeUndefined();
    expect(config.disableHistory).toBe(true);
    expect(config.vectorStore.provider).toBe("pgvector");
    expect(config.vectorStore.config.connectionString).toBe(
      testEnv.DATABASE_URL,
    );

    // A hung provider must not stall the caller: every embedding call is
    // bounded by an abort signal.
    embed.mockResolvedValue({ embedding: [0.1] });
    await expect(
      config.embedder.config.model.embedQuery("query"),
    ).resolves.toEqual([0.1]);
    expect(embed).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
  });

  it("reuses the instance for an unchanged account config", () => {
    const emailAccount = { ...getEmailAccount(), id: "cache-account" };

    const first = getKnowledgeMemory(emailAccount);
    const second = getKnowledgeMemory(emailAccount);

    expect(first).toBe(second);
    expect(memoryConstructor).toHaveBeenCalledTimes(1);
  });
});
