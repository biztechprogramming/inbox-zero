import { assertCanUseDigestsIfNeeded } from "@/utils/premium/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getStatsByPeriod } from "@/app/api/user/stats/by-period/controller";
import { getResponseTimeStats } from "@/utils/stats/response-time/controller";
import { toRuleWriteInput } from "@/app/api/v1/rules/request";
import { apiRuleSelect, serializeRule } from "@/app/api/v1/rules/serializers";
import { ruleRequestBodySchema } from "@/app/api/v1/rules/validation";
import { BRAND_NAME } from "@/utils/branding";
import { createEmailProvider } from "@/utils/email/provider";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { createRule, deleteRule, updateRule } from "@/utils/rule/rule";
import {
  listMcpEmailAccounts,
  resolveMcpEmailAccount,
} from "@/utils/mcp/account-selection";
import type { MCP_SCOPES } from "@/utils/mcp/config";
import { isMcpServerEnabledForUser } from "@/utils/mcp/access";
import { searchKnowledgeItems } from "@/utils/knowledge/retrieve";
import { getAttention } from "@/utils/knowledge/attention";
import { type EmailItemFilters, listEmailItems } from "@/utils/knowledge/items";
import {
  type DbSearchFilters,
  searchEmailMessages,
} from "@/utils/ai/assistant/search-inbox-db";
import type {
  EmailAudience,
  EmailItemOwner,
  EmailItemStatus,
  EmailItemType,
} from "@/generated/prisma/enums";
import { getEmailAccountWithAi } from "@/utils/user/get";

const logger = createScopedLogger("mcp-server");
type ToolResultData = Record<string, unknown>;
const accountSelectorShape = {
  emailAccountId: z.string().optional(),
  emailAddress: z.string().email().optional(),
};

export async function handleMcpServerRequest(
  request: Request,
  session: { userId: string; scopes: string[] },
) {
  const userId = session.userId;
  if (!userId) {
    return new Response(null, { status: 401 });
  }

  if (!(await isMcpServerEnabledForUser(userId))) {
    return new Response(null, { status: 403 });
  }

  const server = new McpServer(
    { name: `${BRAND_NAME} MCP`, version: "1.0.0" },
    {
      instructions:
        "Use list_email_accounts when the user needs to target a specific inbox account. All other tools accept either emailAccountId or emailAddress and default to the first linked account.",
    },
  );

  server.registerTool(
    "list_email_accounts",
    {
      description: "List the inbox accounts linked to the authenticated user.",
    },
    async () => {
      assertMcpScope(session.scopes, "mcp:read");
      const accounts = await listMcpEmailAccounts(userId);

      return createToolResult({ accounts });
    },
  );

  server.registerTool(
    "search_knowledge",
    {
      description:
        'Semantic search over durable background facts extracted from one inbox account\'s email: people (roles, companies, contact details), the user\'s preferences and standing decisions, reference answers (pricing, policies, account details), and how the user replies to particular audiences. Returns the most relevant facts with provenance metadata (source thread and message). Similarity top-k, so it cannot list everything: use list_email_items for commitments, requests, deadlines, and decisions, and get_attention for what needs attention now. Read-only. Returns an empty list when the knowledge store is disabled for this deployment or account. audience restricts results to exactly one way the user received the mail — the default "direct" searches only mail personally addressed to the user; "list" searches only distribution-list mail (e.g. a shared tech-support inbox); pass "any" to search everything.',
      inputSchema: {
        ...accountSelectorShape,
        query: z.string().describe("What to look for, in natural language."),
        limit: z.number().int().min(1).max(50).optional(),
        audience: z
          .enum(["direct", "cc", "list", "any"])
          .optional()
          .describe(
            'Restrict results to exactly one source. "direct" (default): only mail addressed to the user. "cc": only mail the user was copied on. "list": only mail via a distribution list or alias. "any": no restriction.',
          ),
      },
    },
    async ({ query, limit, audience, ...args }) => {
      assertMcpScope(session.scopes, "mcp:read");
      const emailAccount = await resolveMcpEmailAccount({ userId, ...args });
      const accountWithAi = await getEmailAccountWithAi({
        emailAccountId: emailAccount.id,
      });
      const audienceFilter =
        audience === "any" ? undefined : (audience ?? "direct");
      const facts = accountWithAi
        ? await searchKnowledgeItems({
            emailAccount: accountWithAi,
            query,
            topK: limit,
            audience: audienceFilter,
            logger,
          })
        : [];

      return createToolResult({ emailAccount, facts });
    },
  );

  server.registerTool(
    "get_attention",
    {
      description:
        "What needs the user's attention in one inbox account right now, ranked most pressing first. Combines open commitments, requests, and deadlines extracted from mail personally addressed to the user (to or cc; distribution-list and shared-queue mail is excluded) with threads the reply tracker marks as needing a reply or awaiting one. Covers the last 30 days plus anything due from a week ago onward. Each thread includes its running summary, open items (who owes what, due dates), urgency, and a link. Precomputed, so it is fast and complete for that window; use list_email_items for other windows or filters. Read-only.",
      inputSchema: {
        ...accountSelectorShape,
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum threads to return. Default 20."),
      },
    },
    async ({ limit, ...args }) => {
      assertMcpScope(session.scopes, "mcp:read");
      const emailAccount = await resolveMcpEmailAccount({ userId, ...args });
      const threads = await getAttention({
        emailAccountId: emailAccount.id,
        limit,
      });

      return createToolResult({
        emailAccount,
        threads: threads.map((thread) => ({
          ...thread,
          lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
          tracker: thread.tracker?.toLowerCase() ?? null,
          items: thread.items.map(serializeEmailItem),
        })),
      });
    },
  );

  server.registerTool(
    "list_email_items",
    {
      description:
        'List structured items extracted from one inbox account\'s email: commitments (someone promised to do something), requests (someone asked someone to do something), deadlines, and decisions. Each item has a status — open until later mail completes, answers, cancels, or supersedes it (for decisions, open means still in effect) — an owner ("me": the user must act or made the promise; "them": someone else must), the counterparty, an optional due date, and its source thread and link. Filters combine with AND; results are newest first and complete, so page with offset to list everything. Use this for exhaustive or filtered lists; use search_knowledge for background facts about people and topics. Read-only.',
      inputSchema: {
        ...accountSelectorShape,
        types: z
          .array(z.enum(["commitment", "request", "deadline", "decision"]))
          .optional()
          .describe("Only these item types. Default: all."),
        status: z
          .enum(["open", "resolved", "any"])
          .optional()
          .describe('Default "open".'),
        owner: z
          .enum(["me", "them"])
          .optional()
          .describe(
            '"me": items the user owes. "them": items others owe the user.',
          ),
        counterparty: z
          .string()
          .optional()
          .describe(
            'Email address or domain (e.g. "northwind.com") of the other party.',
          ),
        query: z
          .string()
          .optional()
          .describe("Words that must all appear in the item text."),
        dueAfter: z
          .string()
          .optional()
          .describe("Only items due on or after this date (YYYY-MM-DD)."),
        dueBefore: z
          .string()
          .optional()
          .describe(
            'Only items due before this date (YYYY-MM-DD). Combine with status "open" for overdue items.',
          ),
        after: z
          .string()
          .optional()
          .describe("Only items from mail on or after this date (YYYY-MM-DD)."),
        audience: z
          .enum(["direct", "cc", "list", "any"])
          .optional()
          .describe(
            'How the user received the source mail. "direct": addressed to the user; "cc": copied; "list": via a distribution list or shared queue. Default "any".',
          ),
        threadId: z
          .string()
          .optional()
          .describe("Only items from this thread."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Default 50."),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({
      types,
      status = "open",
      owner,
      counterparty,
      query,
      dueAfter,
      dueBefore,
      after,
      audience,
      threadId,
      limit = 50,
      offset = 0,
      ...args
    }) => {
      assertMcpScope(session.scopes, "mcp:read");
      const filters: EmailItemFilters = {
        ...(types?.length && {
          types: types.map((type) => type.toUpperCase() as EmailItemType),
        }),
        ...(status !== "any" && {
          status: status.toUpperCase() as EmailItemStatus,
        }),
        ...(owner && { owner: owner.toUpperCase() as EmailItemOwner }),
        ...(audience &&
          audience !== "any" && {
            audience: audience.toUpperCase() as EmailAudience,
          }),
        ...(counterparty && { counterparty }),
        ...(query && { query }),
        ...(threadId && { threadId }),
        ...(dueAfter && { dueAfter: parseDateParam("dueAfter", dueAfter) }),
        ...(dueBefore && { dueBefore: parseDateParam("dueBefore", dueBefore) }),
        ...(after && { after: parseDateParam("after", after) }),
      };
      const emailAccount = await resolveMcpEmailAccount({ userId, ...args });
      const { items, hasMore } = await listEmailItems({
        emailAccountId: emailAccount.id,
        filters,
        limit,
        offset,
      });

      return createToolResult({
        emailAccount,
        items: items.map((item) => ({
          ...serializeEmailItem(item),
          status: item.status.toLowerCase(),
          audience: item.audience.toLowerCase(),
          resolvedAt: item.resolvedAt?.toISOString() ?? null,
        })),
        hasMore,
      });
    },
  );

  server.registerTool(
    "search_emails",
    {
      description:
        'Search one inbox account\'s synced mail by words and metadata, answered from a local copy of the mailbox (fast, no mailbox API calls). Returns matching messages newest first with subject, sender, recipients, date, preview, a one-line summary, category, urgency, thread id, and a link. query words match the subject, preview, and sender name; every word must match (stemmed, so "invoices" matches "invoice"). At least one filter is required. Covers mail synced since the account was connected, so very old mail may be missing. Use search_knowledge for background facts and list_email_items for commitments, requests, deadlines, and decisions. Read-only.',
      inputSchema: {
        ...accountSelectorShape,
        query: z
          .string()
          .optional()
          .describe(
            "Words that must all appear in the subject, preview, or sender name.",
          ),
        from: z
          .string()
          .email()
          .optional()
          .describe("Exact sender email address."),
        after: z
          .string()
          .optional()
          .describe("Only mail on or after this date (YYYY-MM-DD)."),
        before: z
          .string()
          .optional()
          .describe("Only mail before this date (YYYY-MM-DD)."),
        unread: z
          .boolean()
          .optional()
          .describe("true: only unread mail; false: only read mail."),
        hasAttachment: z.boolean().optional(),
        folder: z
          .enum(["inbox", "sent"])
          .optional()
          .describe(
            '"inbox": only mail currently in the inbox; "sent": only mail the user sent.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Default 20."),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({
      query,
      from,
      after,
      before,
      unread,
      hasAttachment,
      folder,
      limit = 20,
      offset = 0,
      ...args
    }) => {
      assertMcpScope(session.scopes, "mcp:read");
      const filters: DbSearchFilters = {
        ...(query?.trim() && { text: query.trim() }),
        ...(from && { from: from.toLowerCase() }),
        ...(unread !== undefined && { read: !unread }),
        ...(hasAttachment !== undefined && { hasAttachments: hasAttachment }),
        ...(folder === "inbox" && { inbox: true as const }),
        ...(folder === "sent" && { sent: true as const }),
        ...(after && { after: parseDateParam("after", after) }),
        ...(before && { before: parseDateParam("before", before) }),
      };
      // An unfiltered search would page through the whole mailbox.
      if (!Object.keys(filters).length) {
        throw new Error("Provide at least one filter.");
      }
      const emailAccount = await resolveMcpEmailAccount({ userId, ...args });
      const rows = await searchEmailMessages({
        emailAccountId: emailAccount.id,
        filters,
        limit,
        offset,
      });

      return createToolResult({
        emailAccount,
        messages: rows.map((row) => ({
          messageId: row.messageId,
          threadId: row.threadId,
          subject: row.subject,
          from: row.from,
          to: row.to,
          date: row.date.toISOString(),
          preview: row.snippet,
          summary: row.aiSummary,
          category: row.aiCategory,
          urgency: row.aiUrgency,
          read: row.read,
          hasAttachments: row.hasAttachments,
          link: row.externalUrl,
        })),
      });
    },
  );

  server.registerTool(
    "list_rules",
    {
      description: "List automation rules for one inbox account.",
      inputSchema: accountSelectorShape,
    },
    async (args) => {
      assertMcpScope(session.scopes, "mcp:read");
      const emailAccount = await resolveMcpEmailAccount({ userId, ...args });
      const rules = await prisma.rule.findMany({
        where: { emailAccountId: emailAccount.id },
        select: apiRuleSelect,
        orderBy: { createdAt: "asc" },
      });

      return createToolResult({
        emailAccount,
        rules: rules.map(serializeRule),
      });
    },
  );

  server.registerTool(
    "get_rule",
    {
      description: "Get one automation rule by ID for one inbox account.",
      inputSchema: {
        ...accountSelectorShape,
        id: z.string(),
      },
    },
    async ({ id, ...args }) => {
      assertMcpScope(session.scopes, "mcp:read");
      const emailAccount = await resolveMcpEmailAccount({ userId, ...args });
      const rule = await prisma.rule.findFirst({
        where: { id, emailAccountId: emailAccount.id },
        select: apiRuleSelect,
      });

      if (!rule) {
        throw new Error("Rule not found for the selected email account.");
      }

      return createToolResult({
        emailAccount,
        rule: serializeRule(rule),
      });
    },
  );

  server.registerTool(
    "create_rule",
    {
      description: "Create an automation rule for one inbox account.",
      inputSchema: {
        ...accountSelectorShape,
        rule: ruleRequestBodySchema,
      },
    },
    async ({ rule, ...args }) => {
      assertMcpScope(session.scopes, "mcp:write");
      const emailAccount = await resolveMcpEmailAccount({ userId, ...args });
      const ruleInput = toRuleWriteInput(rule);
      const scopedLogger = logger.with({
        userId,
        emailAccountId: emailAccount.id,
      });

      await assertCanUseDigestsIfNeeded(userId, ruleInput.actions);

      const createdRule = await createRule({
        result: {
          name: ruleInput.name,
          condition: ruleInput.condition,
          actions: ruleInput.actions,
        },
        emailAccountId: emailAccount.id,
        provider: emailAccount.provider,
        runOnThreads: ruleInput.runOnThreads,
        logger: scopedLogger,
      });

      const storedRule = await prisma.rule.findUnique({
        where: { id: createdRule.id },
        select: apiRuleSelect,
      });

      if (!storedRule) {
        throw new Error("Created rule could not be loaded.");
      }

      return createToolResult({
        emailAccount,
        rule: serializeRule(storedRule),
      });
    },
  );

  server.registerTool(
    "update_rule",
    {
      description: "Replace an automation rule for one inbox account.",
      inputSchema: {
        ...accountSelectorShape,
        id: z.string(),
        rule: ruleRequestBodySchema,
      },
    },
    async ({ id, rule, ...args }) => {
      assertMcpScope(session.scopes, "mcp:write");
      const emailAccount = await resolveMcpEmailAccount({ userId, ...args });
      const existingRule = await prisma.rule.findFirst({
        where: { id, emailAccountId: emailAccount.id },
        select: { id: true, actions: { select: { type: true } } },
      });

      if (!existingRule) {
        throw new Error("Rule not found for the selected email account.");
      }

      const ruleInput = toRuleWriteInput(rule);
      const scopedLogger = logger.with({
        userId,
        emailAccountId: emailAccount.id,
        ruleId: id,
      });

      await assertCanUseDigestsIfNeeded(
        userId,
        ruleInput.actions,
        existingRule.actions,
      );

      await updateRule({
        ruleId: id,
        result: {
          name: ruleInput.name,
          condition: ruleInput.condition,
          actions: ruleInput.actions,
        },
        emailAccountId: emailAccount.id,
        provider: emailAccount.provider,
        logger: scopedLogger,
        runOnThreads: ruleInput.runOnThreads,
      });

      const updatedRule = await prisma.rule.findFirst({
        where: { id, emailAccountId: emailAccount.id },
        select: apiRuleSelect,
      });

      if (!updatedRule) {
        throw new Error("Updated rule could not be loaded.");
      }

      return createToolResult({
        emailAccount,
        rule: serializeRule(updatedRule),
      });
    },
  );

  server.registerTool(
    "delete_rule",
    {
      description: "Delete an automation rule for one inbox account.",
      inputSchema: {
        ...accountSelectorShape,
        id: z.string(),
      },
    },
    async ({ id, ...args }) => {
      assertMcpScope(session.scopes, "mcp:write");
      const emailAccount = await resolveMcpEmailAccount({ userId, ...args });
      const existingRule = await prisma.rule.findFirst({
        where: { id, emailAccountId: emailAccount.id },
        select: { groupId: true },
      });

      if (!existingRule) {
        throw new Error("Rule not found for the selected email account.");
      }

      await deleteRule({
        emailAccountId: emailAccount.id,
        ruleId: id,
        groupId: existingRule.groupId,
      });

      return createToolResult({
        deleted: true,
        emailAccount,
        id,
      });
    },
  );

  server.registerTool(
    "get_stats_by_period",
    {
      description: "Get email statistics grouped by day, week, month, or year.",
      inputSchema: {
        ...accountSelectorShape,
        period: z.enum(["day", "week", "month", "year"]).optional(),
        fromDate: z.number().int().optional(),
        toDate: z.number().int().optional(),
      },
    },
    async ({ period, fromDate, toDate, ...args }) => {
      assertMcpScope(session.scopes, "mcp:read");
      const emailAccount = await resolveMcpEmailAccount({ userId, ...args });
      const result = await getStatsByPeriod({
        period: period ?? "week",
        fromDate,
        toDate,
        emailAccountId: emailAccount.id,
      });

      return createToolResult({
        emailAccount,
        ...result,
      });
    },
  );

  server.registerTool(
    "get_response_time_stats",
    {
      description: "Get response time analytics for one inbox account.",
      inputSchema: {
        ...accountSelectorShape,
        fromDate: z.number().int().optional(),
        toDate: z.number().int().optional(),
      },
    },
    async ({ fromDate, toDate, ...args }) => {
      assertMcpScope(session.scopes, "mcp:read");
      const emailAccount = await resolveMcpEmailAccount({ userId, ...args });
      const scopedLogger = logger.with({
        userId,
        emailAccountId: emailAccount.id,
      });
      const emailProvider = await createEmailProvider({
        emailAccountId: emailAccount.id,
        provider: emailAccount.provider,
        logger: scopedLogger,
      });
      const result = await getResponseTimeStats({
        fromDate,
        toDate,
        emailAccountId: emailAccount.id,
        emailProvider,
        logger: scopedLogger,
      });

      return createToolResult({
        emailAccount,
        ...serializeResponseTimeStats(result),
      });
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  return transport.handleRequest(request);
}

function createToolResult(data: ToolResultData) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function serializeResponseTimeStats(
  result: Awaited<ReturnType<typeof getResponseTimeStats>>,
) {
  return {
    ...result,
    trend: result.trend.map((entry) => ({
      ...entry,
      periodDate: entry.periodDate.toISOString(),
    })),
  };
}

const DATE_PARAM_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDateParam(name: string, value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !DATE_PARAM_PATTERN.test(value) ||
    !date.toISOString().startsWith(value)
  ) {
    throw new Error(`${name} must be a date in YYYY-MM-DD format.`);
  }
  return date;
}

function serializeEmailItem<
  T extends {
    type: string;
    owner: string | null;
    dueDate: Date | null;
    sourceDate: Date;
  },
>(item: T) {
  return {
    ...item,
    type: item.type.toLowerCase(),
    owner: item.owner?.toLowerCase() ?? null,
    dueDate: item.dueDate?.toISOString().slice(0, 10) ?? null,
    sourceDate: item.sourceDate.toISOString(),
  };
}

function assertMcpScope(
  scopes: string[],
  required: (typeof MCP_SCOPES)[number],
) {
  if (!scopes.includes(required))
    throw new Error(`Missing required permission: ${required}`);
}
