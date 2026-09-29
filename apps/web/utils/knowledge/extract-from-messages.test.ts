import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const memoryAdd = vi.fn();
vi.mock("@/utils/knowledge/memory", () => ({
  getKnowledgeMemory: vi.fn(() => ({ add: memoryAdd })),
}));

const getEmailAccountWithAi = vi.fn();
vi.mock("@/utils/user/get", () => ({
  getEmailAccountWithAi: (...args: unknown[]) => getEmailAccountWithAi(...args),
}));

const getMessage = vi.fn();
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(async () => ({ getMessage })),
}));

const getEmailForLLM = vi.fn();
vi.mock("@/utils/get-email-from-message", () => ({
  getEmailForLLM: (...args: unknown[]) => getEmailForLLM(...args),
}));

import { extractKnowledgeFromMessages } from "./extract-from-messages";

const logger = createScopedLogger("test");

const emailAccountId = "account-1";

function candidate(messageId: string, overrides = {}) {
  return {
    messageId,
    threadId: `thread-${messageId}`,
    sent: false,
    date: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

describe("extractKnowledgeFromMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEmailAccountWithAi.mockResolvedValue({
      id: emailAccountId,
      email: "user@test.com",
      user: {},
    });
    prisma.emailAccount.findUnique.mockResolvedValue({
      knowledgeQueueSenders: [],
      account: { provider: "google" },
    } as any);
    prisma.emailMessage.update.mockResolvedValue({} as any);
    getMessage.mockResolvedValue({
      id: "msg",
      headers: { to: "user@test.com" },
    });
    getEmailForLLM.mockReturnValue({
      id: "msg",
      from: "sender@test.com",
      subject: "Subject",
      content: "Fresh reply text",
    });
  });

  it("stores memories with provenance and marks messages extracted", async () => {
    prisma.emailMessage.findMany.mockResolvedValue([
      candidate("m1") as any,
      candidate("m2", { sent: true }) as any,
    ]);

    const result = await extractKnowledgeFromMessages({
      emailAccountId,
      messageIds: ["m1", "m2"],
      logger,
    });

    expect(result.processed).toBe(2);
    expect(memoryAdd).toHaveBeenCalledTimes(2);
    expect(memoryAdd).toHaveBeenCalledWith(expect.anything(), {
      userId: emailAccountId,
      metadata: {
        threadId: "thread-m1",
        messageId: "m1",
        direction: "received",
        audience: "direct",
        date: candidate("m1").date.toISOString(),
      },
    });
    expect(memoryAdd).toHaveBeenCalledWith(expect.anything(), {
      userId: emailAccountId,
      metadata: {
        threadId: "thread-m2",
        messageId: "m2",
        direction: "sent",
        audience: "direct",
        date: candidate("m2").date.toISOString(),
      },
    });
    expect(prisma.emailMessage.update).toHaveBeenCalledTimes(2);

    // The long-thread contract: only the fresh fragment of each message is
    // extracted, never the quoted history it carries.
    expect(getEmailForLLM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ extractReply: true }),
    );
  });

  it.each([
    ["cc", { to: "other@test.com", cc: "user@test.com" }],
    ["list", { to: "techsupport@test.com" }],
  ] as const)("classifies mail reaching the user via %s", async (audience, headers) => {
    prisma.emailMessage.findMany.mockResolvedValue([candidate("m1") as never]);
    getMessage.mockResolvedValue({ id: "msg", headers });

    await extractKnowledgeFromMessages({
      emailAccountId,
      messageIds: ["m1"],
      logger,
    });

    expect(memoryAdd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ audience }),
      }),
    );
  });

  it("classifies configured queue senders as list even when addressed to the user", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      knowledgeQueueSenders: ["support@queue.test"],
      account: { provider: "google" },
    } as never);
    prisma.emailMessage.findMany.mockResolvedValue([candidate("m1") as never]);
    getMessage.mockResolvedValue({
      id: "msg",
      headers: {
        from: "Kirsty Courtney (Support) <support@queue.test>",
        to: "user@test.com",
      },
    });

    await extractKnowledgeFromMessages({
      emailAccountId,
      messageIds: ["m1"],
      logger,
    });

    expect(memoryAdd).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ audience: "list" }),
      }),
    );
  });

  it("marks messages with no fresh content without storing a memory", async () => {
    prisma.emailMessage.findMany.mockResolvedValue([candidate("m1") as any]);
    getEmailForLLM.mockReturnValue({ content: "   " });

    const result = await extractKnowledgeFromMessages({
      emailAccountId,
      messageIds: ["m1"],
      logger,
    });

    expect(result.processed).toBe(1);
    expect(memoryAdd).not.toHaveBeenCalled();
    expect(prisma.emailMessage.update).toHaveBeenCalledTimes(1);
  });

  it("keeps processing when one message fails, leaving it unmarked for retry", async () => {
    prisma.emailMessage.findMany.mockResolvedValue([
      candidate("m1") as any,
      candidate("m2") as any,
    ]);
    memoryAdd
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce({ results: [] });

    const result = await extractKnowledgeFromMessages({
      emailAccountId,
      messageIds: ["m1", "m2"],
      logger,
    });

    expect(result.processed).toBe(1);
    expect(prisma.emailMessage.update).toHaveBeenCalledTimes(1);
    expect(prisma.emailMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          emailAccountId_threadId_messageId: expect.objectContaining({
            messageId: "m2",
          }),
        },
      }),
    );
  });

  it("marks content-filtered messages done so they are not retried forever", async () => {
    prisma.emailMessage.findMany.mockResolvedValue([candidate("m1") as never]);
    memoryAdd.mockRejectedValueOnce(
      new Error("wrapped", {
        cause: Object.assign(new Error("400 filtered"), {
          code: "content_filter",
        }),
      }),
    );

    await extractKnowledgeFromMessages({
      emailAccountId,
      messageIds: ["m1"],
      logger,
    });

    expect(prisma.emailMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          emailAccountId_threadId_messageId: expect.objectContaining({
            messageId: "m1",
          }),
        },
      }),
    );
  });

  it("does nothing when every message is already extracted or filtered", async () => {
    prisma.emailMessage.findMany.mockResolvedValue([]);

    const result = await extractKnowledgeFromMessages({
      emailAccountId,
      messageIds: ["m1"],
      logger,
    });

    expect(result.processed).toBe(0);
    expect(getEmailAccountWithAi).not.toHaveBeenCalled();
    expect(memoryAdd).not.toHaveBeenCalled();
  });
});
