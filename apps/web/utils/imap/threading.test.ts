import { describe, expect, it } from "vitest";
import { candidateParentIds, resolveImapThreadId } from "./threading";

describe("candidateParentIds", () => {
  it("prioritizes In-Reply-To, then References newest-first, deduplicated", () => {
    expect(
      candidateParentIds({
        inReplyTo: "<c@z.com>",
        references: "<a@x.com> <b@y.com> <c@z.com>",
      }),
    ).toEqual(["c@z.com", "b@y.com", "a@x.com"]);
  });

  it("returns an empty list for a message with no parents", () => {
    expect(candidateParentIds({})).toEqual([]);
  });

  it("handles In-Reply-To without References", () => {
    expect(candidateParentIds({ inReplyTo: "<a@x.com>" })).toEqual(["a@x.com"]);
  });
});

describe("resolveImapThreadId", () => {
  it("joins the thread of a known ancestor", async () => {
    const threadId = await resolveImapThreadId({
      messageId: "reply@x.com",
      inReplyTo: "<root@x.com>",
      references: "<root@x.com>",
      lookupThreadId: async (ids) =>
        ids.includes("root@x.com") ? "thread-1" : null,
    });
    expect(threadId).toBe("thread-1");
  });

  it("starts a new thread keyed by its own id when no ancestor is known", async () => {
    const threadId = await resolveImapThreadId({
      messageId: "lonely@x.com",
      references: "<unknown@x.com>",
      lookupThreadId: async () => null,
    });
    expect(threadId).toBe("lonely@x.com");
  });

  it("does not hit the lookup for a message without parents", async () => {
    let called = false;
    const threadId = await resolveImapThreadId({
      messageId: "fresh@x.com",
      lookupThreadId: async () => {
        called = true;
        return "should-not-be-used";
      },
    });
    expect(threadId).toBe("fresh@x.com");
    expect(called).toBe(false);
  });
});
