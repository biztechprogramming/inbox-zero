import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

import { getAttention } from "./attention";

const now = new Date("2026-09-30T12:00:00Z");

function item(
  threadId: string,
  owner: "ME" | "THEM" | null,
  dueDate: string | null,
) {
  return {
    id: `${threadId}-${owner}-${dueDate}`,
    threadId,
    type: "REQUEST",
    text: `Item in ${threadId}`,
    owner,
    counterpartyEmail: null,
    counterpartyName: null,
    dueDate: dueDate ? new Date(`${dueDate}T00:00:00Z`) : null,
    sourceDate: new Date("2026-09-25T00:00:00Z"),
  };
}

function row(threadId: string, urgency: number | null, day = 28) {
  return {
    threadId,
    subject: `Subject ${threadId}`,
    from: `${threadId}@test.com`,
    fromName: null,
    date: new Date(`2026-09-${day}T00:00:00Z`),
    externalUrl: null,
    summary: `Summary ${threadId}`,
    urgency,
  };
}

describe("getAttention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ranks due-soon obligations, then things to answer, then waiting-on", async () => {
    prisma.emailItem.findMany.mockResolvedValue([
      item("waiting", "THEM", "2026-10-01"),
      item("no-due", "ME", null),
      item("due-soon", "ME", "2026-10-05"),
      item("due-soon", "ME", "2026-10-01"),
    ] as never);
    prisma.threadTracker.findMany.mockResolvedValue([
      { threadId: "to-reply", type: "NEEDS_REPLY" },
    ] as never);
    prisma.$queryRaw.mockResolvedValue([
      row("waiting", 5),
      row("no-due", 2),
      row("due-soon", 1),
      row("to-reply", 4),
    ] as never);

    const threads = await getAttention({ emailAccountId: "account-1", now });

    expect(threads.map((thread) => thread.threadId)).toEqual([
      "due-soon",
      "to-reply",
      "no-due",
      "waiting",
    ]);
    expect(threads[0].items.map((i) => i.dueDate?.toISOString())).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-10-05T00:00:00.000Z",
    ]);
    expect(threads[1]).toMatchObject({
      tracker: "NEEDS_REPLY",
      summary: "Summary to-reply",
      items: [],
    });
  });

  it("only considers personally addressed, actionable, recent items", async () => {
    prisma.emailItem.findMany.mockResolvedValue([]);
    prisma.threadTracker.findMany.mockResolvedValue([]);

    const threads = await getAttention({ emailAccountId: "account-1", now });

    expect(threads).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    const where = prisma.emailItem.findMany.mock.calls[0][0]?.where;
    expect(where).toMatchObject({
      status: "OPEN",
      type: { in: ["COMMITMENT", "REQUEST", "DEADLINE"] },
      audience: { in: ["DIRECT", "CC"] },
    });
  });
});
