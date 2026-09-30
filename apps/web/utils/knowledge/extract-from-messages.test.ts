import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";
import type { MessageAnalysis } from "./analyze-message";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const memoryAdd = vi.fn();
const memorySearch = vi.fn();
const getKnowledgeMemory = vi.fn();
vi.mock("@/utils/knowledge/memory", () => ({
  getKnowledgeMemory: (...args: unknown[]) => getKnowledgeMemory(...args),
}));

const analyzeMessageKnowledge = vi.fn();
vi.mock("@/utils/knowledge/analyze-message", () => ({
  analyzeMessageKnowledge: (...args: unknown[]) =>
    analyzeMessageKnowledge(...args),
}));

vi.mock("@/utils/user/get", () => ({
  getEmailAccountWithAi: vi.fn(async () => ({
    id: "account-1",
    email: "user@test.com",
    user: {},
    account: { provider: "google" },
  })),
}));

const getMessage = vi.fn();
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(async () => ({ getMessage })),
}));

const getEmailForLLM = vi.fn();
vi.mock("@/utils/get-email-from-message", () => ({
  getEmailForLLM: (...args: unknown[]) => getEmailForLLM(...args),
}));

import {
  applyGuards,
  createExtractionContext,
  extractThreadKnowledge,
} from "./extract-from-messages";

const logger = createScopedLogger("test");

function pending(messageId: string, overrides = {}) {
  return {
    messageId,
    threadId: "thread-1",
    sent: false,
    date: new Date("2026-09-10T12:00:00Z"),
    ...overrides,
  };
}

function analysis(overrides: Partial<MessageAnalysis> = {}): MessageAnalysis {
  return {
    ephemeral: false,
    threadSummary: "Rosa is sending the signage proof.",
    facts: ["Rosa Diaz is the account manager at Northwind."],
    newItems: [
      {
        type: "commitment",
        text: "Rosa will send the signage proof.",
        owner: "them",
        counterpartyEmail: "Rosa@Northwind.example",
        dueDate: "2026-09-12",
      },
    ],
    resolvedItemIds: [],
    ...overrides,
  };
}

async function run(messages = [pending("m1")]) {
  const context = await createExtractionContext({
    emailAccountId: "account-1",
    logger,
  });
  if (!context) throw new Error("no context");
  return extractThreadKnowledge({ context, messages });
}

describe("extractThreadKnowledge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getKnowledgeMemory.mockReturnValue({
      add: memoryAdd,
      search: memorySearch,
    });
    memorySearch.mockResolvedValue({ results: [{ memory: "known fact" }] });
    prisma.emailAccount.findUnique.mockResolvedValue({
      knowledgeQueueSenders: [],
    } as never);
    prisma.emailMessage.findFirst.mockResolvedValue(null);
    prisma.emailMessage.update.mockResolvedValue({} as never);
    prisma.emailItem.findMany.mockResolvedValue([]);
    getMessage.mockResolvedValue({
      id: "m1",
      headers: {
        from: "Rosa Diaz <rosa@northwind.example>",
        to: "user@test.com",
      },
    });
    getEmailForLLM.mockReturnValue({
      id: "m1",
      from: "rosa@northwind.example",
      to: "user@test.com",
      subject: "Signage",
      content: "I'll send the proof by Friday.",
    });
    analyzeMessageKnowledge.mockResolvedValue(analysis());
  });

  it("stores facts, items, summary, and the marker from one analysis", async () => {
    const result = await run();

    expect(result).toEqual({ processed: 1, failed: false });
    // Long-thread contract: only the fresh fragment is analyzed.
    expect(getEmailForLLM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ extractReply: true }),
    );
    expect(analyzeMessageKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ knownFacts: ["known fact"] }),
    );
    expect(memoryAdd).toHaveBeenCalledWith(
      [
        {
          role: "user",
          content: "Rosa Diaz is the account manager at Northwind.",
        },
      ],
      {
        userId: "account-1",
        infer: false,
        metadata: {
          threadId: "thread-1",
          messageId: "m1",
          direction: "received",
          audience: "direct",
          date: pending("m1").date.toISOString(),
        },
      },
    );
    expect(prisma.emailItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          type: "COMMITMENT",
          owner: "THEM",
          counterpartyEmail: "rosa@northwind.example",
          counterpartyName: "Rosa Diaz",
          dueDate: new Date("2026-09-12T00:00:00Z"),
          threadId: "thread-1",
          messageId: "m1",
          audience: "DIRECT",
        }),
      ],
    });
    expect(prisma.emailMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          threadSummary: "Rosa is sending the signage proof.",
          knowledgeExtractedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("resolves open items scoped to the thread and records who resolved them", async () => {
    analyzeMessageKnowledge.mockResolvedValue(
      analysis({ newItems: [], resolvedItemIds: ["item-1"] }),
    );

    await run();

    expect(prisma.emailItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["item-1"] },
        emailAccountId: "account-1",
        threadId: "thread-1",
        status: "OPEN",
      },
      data: {
        status: "RESOLVED",
        resolvedAt: expect.any(Date),
        resolvedByMessageId: "m1",
      },
    });
  });

  it("stores nothing but lifecycle output for ephemeral mail", async () => {
    analyzeMessageKnowledge.mockResolvedValue(
      analysis({ ephemeral: true, resolvedItemIds: ["item-1"] }),
    );

    await run();

    expect(memoryAdd).not.toHaveBeenCalled();
    expect(prisma.emailItem.createMany).toHaveBeenCalledWith({ data: [] });
    expect(prisma.emailItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["item-1"] } }),
      }),
    );
  });

  it("keeps only facts from a message older than the thread's processed state", async () => {
    prisma.emailMessage.findFirst.mockResolvedValue({
      date: new Date("2026-09-20T00:00:00Z"),
    } as never);
    analyzeMessageKnowledge.mockResolvedValue(
      analysis({ resolvedItemIds: ["item-1"] }),
    );

    await run();

    expect(memoryAdd).toHaveBeenCalled();
    expect(prisma.emailItem.createMany).toHaveBeenCalledWith({ data: [] });
    expect(prisma.emailItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: [] } }),
      }),
    );
    const update = prisma.emailMessage.update.mock.calls[0][0];
    expect(update.data).not.toHaveProperty("threadSummary");
  });

  it("still writes items and summaries when the account has no Mem0 store", async () => {
    getKnowledgeMemory.mockReturnValue(null);

    await run();

    expect(analyzeMessageKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ knownFacts: [] }),
    );
    expect(prisma.emailItem.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ type: "COMMITMENT" })],
    });
  });

  it.each([
    ["CC", { to: "other@test.com", cc: "user@test.com" }],
    ["LIST", { to: "techsupport@test.com" }],
  ] as const)("records mail reaching the user via %s", async (audience, headers) => {
    getMessage.mockResolvedValue({ id: "m1", headers });

    await run();

    expect(prisma.emailItem.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ audience })],
    });
  });

  it("classifies configured queue senders as list even when addressed to the user", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      knowledgeQueueSenders: ["support@queue.test"],
    } as never);
    getMessage.mockResolvedValue({
      id: "m1",
      headers: {
        from: "Kai (Support) <support@queue.test>",
        to: "user@test.com",
      },
    });

    await run();

    expect(memoryAdd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ audience: "list" }),
      }),
    );
  });

  it("marks messages with no fresh content without analyzing them", async () => {
    getEmailForLLM.mockReturnValue({ content: "   " });

    const result = await run();

    expect(result.processed).toBe(1);
    expect(analyzeMessageKnowledge).not.toHaveBeenCalled();
    expect(prisma.emailMessage.update).toHaveBeenCalledTimes(1);
  });

  it("stops the thread at the first failure so later messages wait for it", async () => {
    analyzeMessageKnowledge.mockRejectedValueOnce(new Error("provider down"));

    const result = await run([pending("m1"), pending("m2")]);

    expect(result).toEqual({ processed: 0, failed: true });
    expect(analyzeMessageKnowledge).toHaveBeenCalledTimes(1);
    expect(prisma.emailMessage.update).not.toHaveBeenCalled();
  });

  it.each([
    [
      "content-filtered",
      new Error("wrapped", {
        cause: Object.assign(new Error("400"), { code: "content_filter" }),
      }),
    ],
    [
      "deleted",
      Object.assign(new Error("gone"), { code: "ErrorItemNotFound" }),
    ],
  ])("marks %s messages done and continues the thread", async (_label, error) => {
    analyzeMessageKnowledge.mockRejectedValueOnce(error);

    const result = await run([pending("m1"), pending("m2")]);

    expect(result).toEqual({ processed: 2, failed: false });
    expect(prisma.emailMessage.update).toHaveBeenCalledTimes(2);
  });
});

describe("applyGuards", () => {
  const participants = new Map([["rosa@northwind.example", "Rosa Diaz"]]);

  function item(overrides: Partial<MessageAnalysis["newItems"][number]>) {
    return analysis({
      newItems: [
        {
          type: "request",
          text: "Send the report.",
          owner: "me",
          counterpartyEmail: null,
          dueDate: null,
          ...overrides,
        },
      ],
    });
  }

  it("drops a counterparty who is not on the message", () => {
    const { newItems } = applyGuards({
      analysis: item({ counterpartyEmail: "made-up@elsewhere.example" }),
      late: false,
      participants,
    });

    expect(newItems[0]).toMatchObject({
      counterpartyEmail: null,
      counterpartyName: null,
    });
  });

  it.each([
    "2026-02-31",
    "Friday",
    "2026-9-1",
  ])("drops unusable due date %s", (dueDate) => {
    const { newItems } = applyGuards({
      analysis: item({ dueDate }),
      late: false,
      participants,
    });

    expect(newItems[0].dueDate).toBeNull();
  });

  it("never assigns an owner to a decision", () => {
    const { newItems } = applyGuards({
      analysis: item({ type: "decision", owner: "me" }),
      late: false,
      participants,
    });

    expect(newItems[0]).toMatchObject({ type: "DECISION", owner: null });
  });
});
