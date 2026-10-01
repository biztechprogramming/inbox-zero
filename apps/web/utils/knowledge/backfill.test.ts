import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const { storeEnabled, kickKnowledgeDrain } = vi.hoisted(() => ({
  storeEnabled: { value: true },
  kickKnowledgeDrain: vi.fn(),
}));

vi.mock("@/utils/knowledge/config", () => ({
  isKnowledgeStoreEnabled: () => storeEnabled.value,
}));
vi.mock("@/utils/knowledge/extract-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./extract-queue")>()),
  kickKnowledgeDrain,
}));

import { queueKnowledgeBackfill } from "./backfill";

const logger = createScopedLogger("test");

describe("queueKnowledgeBackfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeEnabled.value = true;
    prisma.emailMessage.updateMany.mockResolvedValue({ count: 0 } as never);
  });

  it("marks the window requested and kicks the drain when work remains", async () => {
    prisma.$queryRaw.mockResolvedValue([{ count: 500 }] as never);
    const after = new Date("2026-01-01T00:00:00Z");
    const before = new Date("2026-06-01T00:00:00Z");

    const result = await queueKnowledgeBackfill({
      emailAccountId: "account-1",
      after,
      before,
      logger,
    });

    expect(result.queued).toBe(500);
    expect(prisma.emailMessage.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        emailAccountId: "account-1",
        date: { gte: after, lt: before },
        knowledgeRequestedAt: null,
        knowledgeExtractedAt: null,
      }),
      data: { knowledgeRequestedAt: expect.any(Date) },
    });
    expect(kickKnowledgeDrain).toHaveBeenCalledWith({
      emailAccountId: "account-1",
      logger,
    });
  });

  it("does not kick the drain when the window has nothing pending", async () => {
    prisma.$queryRaw.mockResolvedValue([{ count: 0 }] as never);

    const result = await queueKnowledgeBackfill({
      emailAccountId: "account-1",
      logger,
    });

    expect(result.queued).toBe(0);
    expect(kickKnowledgeDrain).not.toHaveBeenCalled();
  });

  it("does nothing when the store is disabled", async () => {
    storeEnabled.value = false;

    const result = await queueKnowledgeBackfill({
      emailAccountId: "account-1",
      logger,
    });

    expect(result.queued).toBe(0);
    expect(prisma.emailMessage.updateMany).not.toHaveBeenCalled();
  });
});
