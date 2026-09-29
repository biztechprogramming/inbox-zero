import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEmailAccount } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { bulkProcessInboxEmails } from "@/utils/ai/choose-rule/bulk-process-emails";
import { runRules } from "@/utils/ai/choose-rule/run-rules";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/ai/choose-rule/run-rules", () => ({ runRules: vi.fn() }));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(async () => ({
    getInboxMessages: async () => [
      { id: "m1", threadId: "t1", internalDate: "2" },
      { id: "m2", threadId: "t2", internalDate: "1" },
    ],
  })),
}));

const logger = createScopedLogger("bulk-process-emails-test");

describe("bulkProcessInboxEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.rule.findMany.mockResolvedValue([{ id: "rule" }] as never);
  });

  it.each([
    true,
    false,
  ])("passes the skip-drafts setting (%s) to every email", async (skip) => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      skipDraftRepliesInBulk: skip,
    } as never);

    await bulkProcessInboxEmails({
      emailAccount: getEmailAccount() as never,
      provider: "google",
      maxEmails: 20,
      skipArchive: true,
      logger,
    });

    expect(runRules).toHaveBeenCalledTimes(2);
    for (const [args] of vi.mocked(runRules).mock.calls) {
      expect(args.skipDraftReplies).toBe(skip);
    }
  });
});
