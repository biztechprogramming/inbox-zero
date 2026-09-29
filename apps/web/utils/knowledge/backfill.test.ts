import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const { storeEnabled, queueKnowledgeExtraction } = vi.hoisted(() => ({
  storeEnabled: { value: true },
  queueKnowledgeExtraction: vi.fn(),
}));

vi.mock("@/utils/knowledge/config", () => ({
  isKnowledgeStoreEnabled: () => storeEnabled.value,
}));
vi.mock("@/utils/knowledge/extract-queue", () => ({
  queueKnowledgeExtraction: (...args: unknown[]) =>
    queueKnowledgeExtraction(...args),
}));

import { queueKnowledgeBackfill } from "./backfill";

const logger = createScopedLogger("test");

describe("queueKnowledgeBackfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeEnabled.value = true;
  });

  it("queues unextracted mirror messages newest-first within the window", async () => {
    prisma.emailMessage.findMany.mockResolvedValue([
      { messageId: "m-new" },
      { messageId: "m-old" },
    ] as never);

    const result = await queueKnowledgeBackfill({
      emailAccountId: "account-1",
      logger,
    });

    expect(result.queued).toBe(2);
    expect(queueKnowledgeExtraction).toHaveBeenCalledWith({
      emailAccountId: "account-1",
      messageIds: ["m-new", "m-old"],
      logger,
    });

    const query = prisma.emailMessage.findMany.mock.calls[0][0];
    expect(query?.orderBy).toEqual({ date: "desc" });
    expect(query?.where).toMatchObject({
      emailAccountId: "account-1",
      knowledgeExtractedAt: null,
      draft: false,
    });
  });

  it("does nothing when the store is disabled", async () => {
    storeEnabled.value = false;

    const result = await queueKnowledgeBackfill({
      emailAccountId: "account-1",
      logger,
    });

    expect(result.queued).toBe(0);
    expect(prisma.emailMessage.findMany).not.toHaveBeenCalled();
    expect(queueKnowledgeExtraction).not.toHaveBeenCalled();
  });

  it("skips the enqueue when everything is already extracted", async () => {
    prisma.emailMessage.findMany.mockResolvedValue([]);

    const result = await queueKnowledgeBackfill({
      emailAccountId: "account-1",
      logger,
    });

    expect(result.queued).toBe(0);
    expect(queueKnowledgeExtraction).not.toHaveBeenCalled();
  });
});
