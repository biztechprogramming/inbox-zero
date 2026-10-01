import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/knowledge/config", () => ({
  isKnowledgeStoreEnabled: () => true,
}));

const {
  acquireOwnedLock,
  clearOwnedLock,
  extractThreadKnowledge,
  enqueueKnowledgeDrain,
  clearDrainDirtyFlag,
  takeDrainDirtyFlag,
} = vi.hoisted(() => ({
  acquireOwnedLock: vi.fn(),
  clearOwnedLock: vi.fn(),
  extractThreadKnowledge: vi.fn(),
  enqueueKnowledgeDrain: vi.fn(),
  clearDrainDirtyFlag: vi.fn(),
  takeDrainDirtyFlag: vi.fn(),
}));

vi.mock("@/utils/redis/owned-lock", () => ({
  acquireOwnedLock,
  clearOwnedLock,
}));
vi.mock("@/utils/knowledge/extract-from-messages", () => ({
  createExtractionContext: vi.fn(async () => ({})),
  extractThreadKnowledge,
}));
vi.mock("@/utils/knowledge/extract-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./extract-queue")>()),
  enqueueKnowledgeDrain,
  clearDrainDirtyFlag,
  takeDrainDirtyFlag,
}));

import { DRAIN_BATCH_SIZE, runKnowledgeDrain } from "./drain";

const logger = createScopedLogger("test");
const emailAccountId = "account-1";

function thread(threadId: string, day: number) {
  return { threadId, latest: new Date(`2026-09-${day}T00:00:00Z`) };
}

function messages(threadId: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `${threadId}-m${index}`,
    threadId,
    from: "sender@test.com",
    sent: false,
    date: new Date(`2026-09-01T0${index}:00:00Z`),
  }));
}

function mockPending(
  threads: ReturnType<typeof thread>[],
  pending: ReturnType<typeof messages>,
) {
  prisma.$queryRaw
    .mockResolvedValueOnce(threads as never)
    .mockResolvedValueOnce(pending as never);
}

describe("runKnowledgeDrain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$queryRaw.mockReset();
    acquireOwnedLock.mockResolvedValue("token");
    takeDrainDirtyFlag.mockResolvedValue(false);
    extractThreadKnowledge.mockImplementation(async ({ messages }) => ({
      processed: messages.length,
      failed: false,
      complete: true,
    }));
  });

  it("exits without work when another iteration holds the account lock", async () => {
    acquireOwnedLock.mockResolvedValue(null);

    const result = await runKnowledgeDrain({ emailAccountId, logger });

    expect(result.status).toBe("busy");
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(enqueueKnowledgeDrain).not.toHaveBeenCalled();
  });

  it("clears the wake-up flag before a pass selects its work", async () => {
    mockPending([], []);

    await runKnowledgeDrain({ emailAccountId, logger });

    expect(clearDrainDirtyFlag.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.$queryRaw.mock.invocationCallOrder[0],
    );
  });

  it("hands each thread its pending messages and finishes a short pass", async () => {
    mockPending(
      [thread("t1", 20), thread("t2", 10)],
      [...messages("t1", 2), ...messages("t2", 1)],
    );

    const result = await runKnowledgeDrain({ emailAccountId, logger });

    expect(result).toEqual({ status: "drained", processed: 3 });
    expect(
      extractThreadKnowledge.mock.calls.map(([{ messages }]) =>
        messages.map((message: { messageId: string }) => message.messageId),
      ),
    ).toEqual([["t1-m0", "t1-m1"], ["t2-m0"]]);
    expect(enqueueKnowledgeDrain).not.toHaveBeenCalled();
    expect(clearOwnedLock).toHaveBeenCalledWith({
      key: `knowledge:drain:${emailAccountId}`,
      lockToken: "token",
    });
  });

  it("starts a fresh pass when a kick arrived during this one", async () => {
    mockPending([thread("t1", 20)], messages("t1", 1));
    takeDrainDirtyFlag.mockResolvedValue(true);

    await runKnowledgeDrain({ emailAccountId, logger });

    expect(enqueueKnowledgeDrain).toHaveBeenCalledWith({
      body: { emailAccountId },
      logger,
    });
  });

  it("resumes a thread cut off by the batch budget instead of skipping it", async () => {
    const cursor = { date: new Date("2026-09-25T00:00:00Z"), threadId: "t0" };
    mockPending(
      [thread("t1", 20), thread("t2", 10)],
      [...messages("t1", 3), ...messages("t2", DRAIN_BATCH_SIZE)],
    );

    const result = await runKnowledgeDrain({ emailAccountId, cursor, logger });

    expect(result.status).toBe("continuing");
    // t2 got the remaining budget but has more pending, so the cursor stops
    // after t1 and the next iteration picks t2 up again.
    expect(extractThreadKnowledge.mock.calls[1][0].messages).toHaveLength(
      DRAIN_BATCH_SIZE - 3,
    );
    expect(enqueueKnowledgeDrain).toHaveBeenCalledWith({
      body: {
        emailAccountId,
        cursor: { date: thread("t1", 20).latest, threadId: "t1" },
      },
      logger,
    });
    expect(clearDrainDirtyFlag).not.toHaveBeenCalled();
  });

  it("keeps the cursor before a thread too long for one iteration", async () => {
    mockPending(
      [thread("t1", 20), thread("t2", 10)],
      [...messages("t1", DRAIN_BATCH_SIZE + 2), ...messages("t2", 1)],
    );

    const result = await runKnowledgeDrain({ emailAccountId, logger });

    expect(result.status).toBe("continuing");
    expect(extractThreadKnowledge).toHaveBeenCalledTimes(1);
    expect(enqueueKnowledgeDrain).toHaveBeenCalledWith({
      body: { emailAccountId, cursor: undefined },
      logger,
    });
  });

  it("resumes a thread the iteration deadline cut short", async () => {
    mockPending(
      [thread("t1", 20), thread("t2", 10)],
      [...messages("t1", 1), ...messages("t2", 3)],
    );
    extractThreadKnowledge
      .mockResolvedValueOnce({ processed: 1, failed: false, complete: true })
      .mockResolvedValueOnce({ processed: 1, failed: false, complete: false });

    await runKnowledgeDrain({ emailAccountId, logger });

    expect(enqueueKnowledgeDrain).toHaveBeenCalledWith({
      body: {
        emailAccountId,
        cursor: { date: thread("t1", 20).latest, threadId: "t1" },
      },
      logger,
    });
  });

  it("moves past a failed thread so one poison message can't stall the drain", async () => {
    mockPending(
      [thread("t1", 20), thread("t2", 10)],
      [...messages("t1", 3), ...messages("t2", 1)],
    );
    extractThreadKnowledge.mockResolvedValueOnce({
      processed: 0,
      failed: true,
    });

    const result = await runKnowledgeDrain({ emailAccountId, logger });

    expect(extractThreadKnowledge).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ status: "drained", processed: 1 });
  });

  it("continues after a full page of threads", async () => {
    const threads = Array.from({ length: DRAIN_BATCH_SIZE }, (_, index) =>
      thread(`t${index}`, 20 - index),
    );
    mockPending(
      threads,
      threads.flatMap(({ threadId }) => messages(threadId, 1)),
    );

    await runKnowledgeDrain({ emailAccountId, logger });

    const last = threads[DRAIN_BATCH_SIZE - 1];
    expect(enqueueKnowledgeDrain).toHaveBeenCalledWith({
      body: {
        emailAccountId,
        cursor: { date: last.latest, threadId: last.threadId },
      },
      logger,
    });
  });

  it("releases the lock when extraction throws", async () => {
    mockPending([thread("t1", 20)], messages("t1", 1));
    extractThreadKnowledge.mockRejectedValueOnce(new Error("boom"));

    await expect(runKnowledgeDrain({ emailAccountId, logger })).rejects.toThrow(
      "boom",
    );
    expect(clearOwnedLock).toHaveBeenCalled();
  });
});
