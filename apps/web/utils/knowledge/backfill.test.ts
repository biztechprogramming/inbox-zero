import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const { storeEnabled, enqueueBackgroundJob, extractKnowledgeFromMessages } =
  vi.hoisted(() => ({
    storeEnabled: { value: true },
    enqueueBackgroundJob: vi.fn(),
    extractKnowledgeFromMessages: vi.fn(),
  }));

vi.mock("@/utils/knowledge/config", () => ({
  isKnowledgeStoreEnabled: () => storeEnabled.value,
}));
vi.mock("@/utils/queue/dispatch", () => ({
  enqueueBackgroundJob: (...args: unknown[]) => enqueueBackgroundJob(...args),
}));
vi.mock("@/utils/knowledge/extract-from-messages", () => ({
  extractKnowledgeFromMessages: (...args: unknown[]) =>
    extractKnowledgeFromMessages(...args),
}));

import {
  DRAIN_BATCH_SIZE,
  queueKnowledgeBackfill,
  runKnowledgeBackfillBatch,
} from "./backfill";

const logger = createScopedLogger("test");

describe("queueKnowledgeBackfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeEnabled.value = true;
  });

  it("enqueues a single drain job when unextracted messages remain", async () => {
    prisma.emailMessage.count.mockResolvedValue(500 as never);

    const result = await queueKnowledgeBackfill({
      emailAccountId: "account-1",
      logger,
    });

    expect(result.queued).toBe(500);
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(1);
    const job = enqueueBackgroundJob.mock.calls[0][0] as {
      body: { emailAccountId: string; after: Date; before?: Date };
      qstash: { path: string };
    };
    expect(job.qstash.path).toBe("/api/knowledge/backfill");
    expect(job.body.emailAccountId).toBe("account-1");
    expect(job.body.after).toBeInstanceOf(Date);
    expect(job.body.before).toBeUndefined();
  });

  it("passes an explicit window through to the drain job", async () => {
    prisma.emailMessage.count.mockResolvedValue(1 as never);
    const after = new Date("2026-01-01T00:00:00Z");
    const before = new Date("2026-06-01T00:00:00Z");

    await queueKnowledgeBackfill({
      emailAccountId: "account-1",
      after,
      before,
      logger,
    });

    const countWhere = prisma.emailMessage.count.mock.calls[0][0]?.where;
    expect(countWhere?.date).toEqual({ gte: after, lt: before });
    const job = enqueueBackgroundJob.mock.calls[0][0] as {
      body: { after: Date; before?: Date };
    };
    expect(job.body).toMatchObject({ after, before });
  });

  it("does nothing when the store is disabled", async () => {
    storeEnabled.value = false;

    const result = await queueKnowledgeBackfill({
      emailAccountId: "account-1",
      logger,
    });

    expect(result.queued).toBe(0);
    expect(prisma.emailMessage.count).not.toHaveBeenCalled();
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("skips the enqueue when everything is already extracted", async () => {
    prisma.emailMessage.count.mockResolvedValue(0 as never);

    const result = await queueKnowledgeBackfill({
      emailAccountId: "account-1",
      logger,
    });

    expect(result.queued).toBe(0);
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });
});

describe("runKnowledgeBackfillBatch", () => {
  const after = new Date("2025-01-01T00:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    storeEnabled.value = true;
    extractKnowledgeFromMessages.mockResolvedValue({ processed: 0 });
  });

  it("extracts a full batch and re-enqueues with the cursor advanced", async () => {
    const candidates = Array.from({ length: DRAIN_BATCH_SIZE }, (_, i) => ({
      messageId: `m-${i}`,
      date: new Date(Date.UTC(2026, 0, DRAIN_BATCH_SIZE - i)),
    }));
    prisma.emailMessage.findMany.mockResolvedValue(candidates as never);
    extractKnowledgeFromMessages.mockResolvedValue({ processed: 8 });

    const result = await runKnowledgeBackfillBatch({
      emailAccountId: "account-1",
      after,
      logger,
    });

    expect(result).toEqual({ processed: 8, done: false });
    expect(extractKnowledgeFromMessages).toHaveBeenCalledWith({
      emailAccountId: "account-1",
      messageIds: candidates.map((candidate) => candidate.messageId),
      logger,
    });
    const job = enqueueBackgroundJob.mock.calls[0][0] as {
      body: { after: Date; before: Date };
    };
    // Cursor is the oldest message in the batch, so the next iteration
    // continues strictly below it even when some extractions failed.
    expect(job.body.before).toEqual(candidates[DRAIN_BATCH_SIZE - 1].date);
    expect(job.body.after).toEqual(after);
  });

  it("bounds the batch query by the window and cursor", async () => {
    prisma.emailMessage.findMany.mockResolvedValue([] as never);
    const before = new Date("2026-02-01T00:00:00Z");

    await runKnowledgeBackfillBatch({
      emailAccountId: "account-1",
      after,
      before,
      logger,
    });

    const query = prisma.emailMessage.findMany.mock.calls[0][0];
    expect(query?.take).toBe(DRAIN_BATCH_SIZE);
    expect(query?.orderBy).toEqual({ date: "desc" });
    expect(query?.where).toMatchObject({
      emailAccountId: "account-1",
      knowledgeExtractedAt: null,
      draft: false,
      date: { gte: after, lt: before },
    });
  });

  it("stops chaining on a partial batch", async () => {
    prisma.emailMessage.findMany.mockResolvedValue([
      { messageId: "m-1", date: new Date("2026-01-01T00:00:00Z") },
    ] as never);
    extractKnowledgeFromMessages.mockResolvedValue({ processed: 1 });

    const result = await runKnowledgeBackfillBatch({
      emailAccountId: "account-1",
      after,
      logger,
    });

    expect(result).toEqual({ processed: 1, done: true });
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("finishes without extracting when nothing remains", async () => {
    prisma.emailMessage.findMany.mockResolvedValue([] as never);

    const result = await runKnowledgeBackfillBatch({
      emailAccountId: "account-1",
      after,
      logger,
    });

    expect(result).toEqual({ processed: 0, done: true });
    expect(extractKnowledgeFromMessages).not.toHaveBeenCalled();
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("does nothing when the store is disabled", async () => {
    storeEnabled.value = false;

    const result = await runKnowledgeBackfillBatch({
      emailAccountId: "account-1",
      after,
      logger,
    });

    expect(result).toEqual({ processed: 0, done: true });
    expect(prisma.emailMessage.findMany).not.toHaveBeenCalled();
  });
});
