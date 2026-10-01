import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/knowledge/config", () => ({
  isKnowledgeStoreEnabled: () => true,
}));

const { redisSet, enqueueBackgroundJob } = vi.hoisted(() => ({
  redisSet: vi.fn(),
  enqueueBackgroundJob: vi.fn(),
}));
vi.mock("@/utils/redis", () => ({ redis: { set: redisSet } }));
vi.mock("@/utils/queue/dispatch", () => ({ enqueueBackgroundJob }));

import { queueKnowledgeExtraction } from "./extract-queue";

const logger = createScopedLogger("test");

describe("queueKnowledgeExtraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks new messages requested, then sets the wake-up flag before queuing the drain", async () => {
    prisma.emailMessage.updateMany.mockResolvedValue({ count: 2 } as never);

    await queueKnowledgeExtraction({
      emailAccountId: "account-1",
      messageIds: ["m1", "m2"],
      logger,
    });

    expect(prisma.emailMessage.updateMany).toHaveBeenCalledWith({
      where: {
        emailAccountId: "account-1",
        messageId: { in: ["m1", "m2"] },
        draft: false,
        knowledgeRequestedAt: null,
        knowledgeExtractedAt: null,
      },
      data: { knowledgeRequestedAt: expect.any(Date) },
    });
    // The no-lost-wake-up contract depends on this order.
    expect(redisSet.mock.invocationCallOrder[0]).toBeLessThan(
      enqueueBackgroundJob.mock.invocationCallOrder[0],
    );
    expect(enqueueBackgroundJob).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { emailAccountId: "account-1" },
        qstash: expect.objectContaining({ path: "/api/knowledge/drain" }),
      }),
    );
  });

  it("skips the kick when a re-sync adds no new work", async () => {
    prisma.emailMessage.updateMany.mockResolvedValue({ count: 0 } as never);

    await queueKnowledgeExtraction({
      emailAccountId: "account-1",
      messageIds: ["m1"],
      logger,
    });

    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("never fails the sync that called it", async () => {
    prisma.emailMessage.updateMany.mockRejectedValue(new Error("db down"));

    await expect(
      queueKnowledgeExtraction({
        emailAccountId: "account-1",
        messageIds: ["m1"],
        logger,
      }),
    ).resolves.toBeUndefined();
  });
});
