import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  connect,
  handleRequest,
  mcpServerConstructor,
  registerTool,
  transportConstructor,
} = vi.hoisted(() => {
  const registerTool = vi.fn();
  const connect = vi.fn();
  const handleRequest = vi.fn();
  const mcpServerConstructor = vi.fn(
    class MockMcpServer {
      registerTool = registerTool;
      connect = connect;
    },
  );
  const transportConstructor = vi.fn(
    class MockTransport {
      handleRequest = handleRequest;
    },
  );

  return {
    connect,
    handleRequest,
    mcpServerConstructor,
    registerTool,
    transportConstructor,
  };
});

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: mcpServerConstructor,
}));
vi.mock(
  "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js",
  () => ({
    WebStandardStreamableHTTPServerTransport: transportConstructor,
  }),
);
vi.mock("@/app/api/user/stats/by-period/controller", () => ({
  getStatsByPeriod: vi.fn(),
}));
vi.mock("@/utils/stats/response-time/controller", () => ({
  getResponseTimeStats: vi.fn(),
}));
vi.mock("@/app/api/v1/rules/request", () => ({
  toRuleWriteInput: vi.fn(),
}));
vi.mock("@/app/api/v1/rules/serializers", () => ({
  apiRuleSelect: {},
  serializeRule: vi.fn(),
}));
vi.mock("@/app/api/v1/rules/validation", async (importActual) => {
  const actual =
    await importActual<typeof import("@/app/api/v1/rules/validation")>();
  return actual;
});
vi.mock("@/utils/branding", () => ({
  BRAND_NAME: "Inbox Zero",
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(),
}));
vi.mock("@/utils/mcp/access", () => ({
  isMcpServerEnabledForUser: vi.fn(),
}));
vi.mock("@/utils/mcp/account-selection", () => ({
  listMcpEmailAccounts: vi.fn(),
  resolveMcpEmailAccount: vi.fn(),
}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/premium/server", () => ({
  assertCanUseDigestsIfNeeded: vi.fn(),
}));
vi.mock("@/utils/knowledge/attention", () => ({ getAttention: vi.fn() }));
vi.mock("@/utils/knowledge/items", () => ({ listEmailItems: vi.fn() }));
vi.mock("@/utils/ai/assistant/search-inbox-db", () => ({
  searchEmailMessages: vi.fn(),
}));
vi.mock("@/utils/rule/rule", () => ({
  createRule: vi.fn(),
  deleteRule: vi.fn(),
  updateRule: vi.fn(),
}));

import { assertCanUseDigestsIfNeeded } from "@/utils/premium/server";
import { toRuleWriteInput } from "@/app/api/v1/rules/request";
import { createRule, updateRule, deleteRule } from "@/utils/rule/rule";
import { resolveMcpEmailAccount } from "@/utils/mcp/account-selection";
import prisma from "@/utils/__mocks__/prisma";
import { handleMcpServerRequest } from "@/utils/mcp/server";
import { isMcpServerEnabledForUser } from "@/utils/mcp/access";
import { getAttention } from "@/utils/knowledge/attention";
import { listEmailItems } from "@/utils/knowledge/items";
import { searchEmailMessages } from "@/utils/ai/assistant/search-inbox-db";

describe("mcp-server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleRequest.mockResolvedValue(new Response("ok"));
    vi.mocked(isMcpServerEnabledForUser).mockResolvedValue(true);
  });

  it("returns 401 when the MCP access token has no user id", async () => {
    const response = await handleMcpServerRequest(
      new Request("http://localhost/api/mcp-server", { method: "POST" }),
      {} as never,
    );

    expect(response.status).toBe(401);
    expect(mcpServerConstructor).not.toHaveBeenCalled();
  });

  it("registers tools and delegates the request to the MCP transport", async () => {
    const request = new Request("http://localhost/api/mcp-server", {
      method: "POST",
    });

    const response = await handleMcpServerRequest(request, {
      userId: "user_1",
      scopes: ["mcp:read", "mcp:write"],
    } as never);

    expect(mcpServerConstructor).toHaveBeenCalledTimes(1);
    expect(registerTool).toHaveBeenCalledTimes(12);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(transportConstructor).toHaveBeenCalledWith({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    expect(handleRequest).toHaveBeenCalledWith(request);
    expect(response).toBeInstanceOf(Response);
  });

  it("returns 403 when MCP access is disabled for the user", async () => {
    vi.mocked(isMcpServerEnabledForUser).mockResolvedValue(false);

    const response = await handleMcpServerRequest(
      new Request("http://localhost/api/mcp-server", { method: "POST" }),
      { userId: "user_1", scopes: [] } as never,
    );

    expect(response.status).toBe(403);
    expect(mcpServerConstructor).not.toHaveBeenCalled();
  });
});

describe("MCP tool permissions and rule writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isMcpServerEnabledForUser).mockResolvedValue(true);
    vi.mocked(resolveMcpEmailAccount).mockResolvedValue({
      id: "account_1",
      email: "owner@example.com",
      name: null,
      provider: "google",
    });
    vi.mocked(toRuleWriteInput).mockReturnValue({
      name: "Digest",
      condition: {},
      actions: [{ type: "DIGEST", fields: null }],
      runOnThreads: false,
    } as never);
  });

  it.each([
    "create_rule",
    "update_rule",
    "delete_rule",
  ])("denies %s to a read-only client before accessing an inbox", async (name) => {
    const tool = await getTool(name, ["mcp:read"]);
    await expect(tool({ id: "rule_1", rule: {} })).rejects.toThrow(
      "Missing required permission",
    );
    expect(resolveMcpEmailAccount).not.toHaveBeenCalled();
    expect(createRule).not.toHaveBeenCalled();
    expect(updateRule).not.toHaveBeenCalled();
    expect(deleteRule).not.toHaveBeenCalled();
  });

  it.each([
    "list_email_accounts",
    "list_rules",
    "get_rule",
    "get_stats_by_period",
    "get_response_time_stats",
    "search_knowledge",
    "get_attention",
    "list_email_items",
    "search_emails",
  ])("denies %s without a read grant", async (name) => {
    const tool = await getTool(name, ["offline_access"]);
    await expect(tool({ id: "rule_1" })).rejects.toThrow(
      "Missing required permission",
    );
  });

  it("rejects creating a paid digest rule before persistence", async () => {
    vi.mocked(assertCanUseDigestsIfNeeded).mockRejectedValueOnce(
      new Error("Upgrade required"),
    );
    const tool = await getTool("create_rule", ["mcp:write"]);
    await expect(tool({ rule: {} })).rejects.toThrow("Upgrade required");
    expect(createRule).not.toHaveBeenCalled();
  });

  it("passes existing actions to the digest check when replacing a rule", async () => {
    const actions = [{ type: "DIGEST" }];
    prisma.rule.findFirst.mockResolvedValueOnce({
      id: "rule_1",
      actions,
    } as never);
    vi.mocked(assertCanUseDigestsIfNeeded).mockRejectedValueOnce(
      new Error("Upgrade required"),
    );
    const tool = await getTool("update_rule", ["mcp:write"]);
    await expect(tool({ id: "rule_1", rule: {} })).rejects.toThrow(
      "Upgrade required",
    );
    expect(assertCanUseDigestsIfNeeded).toHaveBeenCalledWith(
      "user_1",
      expect.any(Array),
      actions,
    );
    expect(updateRule).not.toHaveBeenCalled();
  });

  it.each([
    "update_rule",
    "delete_rule",
  ])("rejects %s for a rule outside the selected inbox", async (name) => {
    prisma.rule.findFirst.mockResolvedValueOnce(null);
    const tool = await getTool(name, ["mcp:write"]);
    await expect(tool({ id: "foreign_rule", rule: {} })).rejects.toThrow(
      "Rule not found",
    );
    expect(prisma.rule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "foreign_rule", emailAccountId: "account_1" },
      }),
    );
    expect(updateRule).not.toHaveBeenCalled();
    expect(deleteRule).not.toHaveBeenCalled();
  });
});

describe("MCP email knowledge tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isMcpServerEnabledForUser).mockResolvedValue(true);
    vi.mocked(resolveMcpEmailAccount).mockResolvedValue({
      id: "account_1",
      email: "owner@example.com",
      name: null,
      provider: "microsoft",
    });
    vi.mocked(listEmailItems).mockResolvedValue({ items: [], hasMore: false });
    vi.mocked(searchEmailMessages).mockResolvedValue([]);
  });

  it("lists open items by default and maps filters onto stored values", async () => {
    const tool = await getTool("list_email_items", ["mcp:read"]);

    await tool({
      types: ["request", "commitment"],
      owner: "me",
      audience: "cc",
      dueBefore: "2026-10-05",
      counterparty: "northwind.com",
    });

    expect(listEmailItems).toHaveBeenCalledWith({
      emailAccountId: "account_1",
      filters: {
        types: ["REQUEST", "COMMITMENT"],
        status: "OPEN",
        owner: "ME",
        audience: "CC",
        dueBefore: new Date("2026-10-05T00:00:00Z"),
        counterparty: "northwind.com",
      },
      limit: 50,
      offset: 0,
    });
  });

  it("drops the status and audience filters for any", async () => {
    const tool = await getTool("list_email_items", ["mcp:read"]);

    await tool({ status: "any", audience: "any" });

    const { filters } = vi.mocked(listEmailItems).mock.calls[0][0];
    expect(filters.status).toBeUndefined();
    expect(filters.audience).toBeUndefined();
  });

  it("rejects a malformed date instead of guessing", async () => {
    const tool = await getTool("list_email_items", ["mcp:read"]);

    await expect(tool({ after: "next friday" })).rejects.toThrow("YYYY-MM-DD");
    expect(listEmailItems).not.toHaveBeenCalled();
  });

  it("returns items with lowercase enums and plain dates", async () => {
    vi.mocked(listEmailItems).mockResolvedValue({
      items: [
        {
          id: "item_1",
          type: "REQUEST",
          status: "OPEN",
          text: "Sam asked the user to review the budget.",
          owner: "ME",
          counterpartyEmail: "sam@acme.example",
          counterpartyName: "Sam Lee",
          dueDate: new Date("2026-10-02T00:00:00Z"),
          sourceDate: new Date("2026-09-28T15:00:00Z"),
          audience: "DIRECT",
          threadId: "thread_1",
          messageId: "message_1",
          resolvedAt: null,
          subject: "Q4 budget",
          link: "https://mail.example/1",
        },
      ],
      hasMore: true,
    } as never);
    const tool = await getTool("list_email_items", ["mcp:read"]);

    const result = (await tool({})) as { structuredContent: unknown };

    expect(result.structuredContent).toMatchObject({
      hasMore: true,
      items: [
        {
          type: "request",
          status: "open",
          owner: "me",
          audience: "direct",
          dueDate: "2026-10-02",
          sourceDate: "2026-09-28T15:00:00.000Z",
          resolvedAt: null,
        },
      ],
    });
  });

  it("requires at least one filter for search_emails", async () => {
    const tool = await getTool("search_emails", ["mcp:read"]);

    await expect(tool({ limit: 5 })).rejects.toThrow("at least one filter");
    expect(searchEmailMessages).not.toHaveBeenCalled();
  });

  it("maps search_emails parameters onto the local mirror filters", async () => {
    const tool = await getTool("search_emails", ["mcp:read"]);

    await tool({
      query: "invoice",
      from: "Billing@Vendor.example",
      unread: true,
      hasAttachment: false,
      folder: "inbox",
      after: "2026-09-01",
    });

    expect(searchEmailMessages).toHaveBeenCalledWith({
      emailAccountId: "account_1",
      filters: {
        text: "invoice",
        from: "billing@vendor.example",
        read: false,
        hasAttachments: false,
        inbox: true,
        after: new Date("2026-09-01T00:00:00Z"),
      },
      limit: 20,
      offset: 0,
    });
  });

  it("returns ranked attention threads with serialized dates", async () => {
    vi.mocked(getAttention).mockResolvedValue([
      {
        threadId: "thread_1",
        subject: "Q4 budget",
        lastMessageAt: new Date("2026-09-28T15:00:00Z"),
        lastFrom: "Sam Lee",
        link: null,
        summary: "Sam needs comments by Friday.",
        urgency: 4,
        tracker: "NEEDS_REPLY",
        items: [
          {
            id: "item_1",
            type: "REQUEST",
            text: "Sam asked the user to review the budget.",
            owner: "ME",
            counterpartyEmail: null,
            counterpartyName: null,
            dueDate: new Date("2026-10-02T00:00:00Z"),
            sourceDate: new Date("2026-09-28T15:00:00Z"),
          },
        ],
      },
    ] as never);
    const tool = await getTool("get_attention", ["mcp:read"]);

    const result = (await tool({ limit: 5 })) as { structuredContent: unknown };

    expect(getAttention).toHaveBeenCalledWith({
      emailAccountId: "account_1",
      limit: 5,
    });
    expect(result.structuredContent).toMatchObject({
      threads: [
        {
          lastMessageAt: "2026-09-28T15:00:00.000Z",
          tracker: "needs_reply",
          items: [{ type: "request", owner: "me", dueDate: "2026-10-02" }],
        },
      ],
    });
  });
});

async function getTool(name: string, scopes: string[]) {
  await handleMcpServerRequest(
    new Request("http://localhost/api/mcp-server", { method: "POST" }),
    { userId: "user_1", scopes },
  );
  const registration = registerTool.mock.calls.find(
    ([toolName]) => toolName === name,
  );
  if (!registration) throw new Error(`Tool not registered: ${name}`);
  return registration[2] as (args: Record<string, unknown>) => Promise<unknown>;
}
