import { Prisma } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";
import { isValidEmail } from "@/utils/email";

// Filters the local EmailMessage mirror can answer directly, mapped 1:1 onto
// columns. Anything outside this set has to go back to the provider.
export type DbSearchFilters = {
  text?: string;
  from?: string;
  read?: boolean;
  hasAttachments?: true;
  inbox?: true;
  sent?: true;
  after?: Date;
  before?: Date;
};

export type DbSearchRow = {
  messageId: string;
  threadId: string;
  externalUrl: string | null;
  subject: string | null;
  from: string;
  to: string;
  snippet: string | null;
  date: Date;
  labels: string[];
  hasAttachments: boolean;
  read: boolean;
  aiSummary: string | null;
  aiCategory: string | null;
  aiUrgency: number | null;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RELATIVE_UNIT_DAYS = { d: 1, m: 30, y: 365 } as const;
const DATE_PATTERN = /^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/;
// Splits on whitespace while keeping `key:"quoted value"` and `"quoted"` intact.
const TOKEN_PATTERN = /\S+:"[^"]*"|"[^"]*"|\S+/g;

/**
 * Translates a Gmail search query into local column filters.
 *
 * Returns `null` when the query uses anything the mirror cannot answer exactly
 * (`label:`, `subject:`, negation, boolean operators, …) so the caller falls
 * back to the provider rather than silently returning a narrower result set.
 */
export function parseGmailQueryForDb(query: string): DbSearchFilters | null {
  const tokens = query.match(TOKEN_PATTERN);
  if (!tokens) return null;

  const filters: DbSearchFilters = {};
  const textTerms: string[] = [];

  for (const token of tokens) {
    // Negation and grouping change the meaning of every other term, and `OR`
    // turns the AND-ed filters below into the wrong query.
    if (/^[-(]/.test(token) || token === "OR" || token === "AND") return null;

    const separator = token.indexOf(":");
    if (separator <= 0) {
      textTerms.push(stripQuotes(token));
      continue;
    }

    const operator = token.slice(0, separator).toLowerCase();
    const value = stripQuotes(token.slice(separator + 1));
    if (!value) return null;

    switch (operator) {
      case "from": {
        // The mirror stores a single normalised address, so only an exact
        // address lookup is faithful; a name or partial match is not.
        if (!isValidEmail(value) || filters.from) return null;
        filters.from = value.toLowerCase();
        break;
      }
      case "is": {
        if (value === "unread") filters.read = false;
        else if (value === "read") filters.read = true;
        else return null;
        break;
      }
      case "has": {
        if (value !== "attachment") return null;
        filters.hasAttachments = true;
        break;
      }
      case "in": {
        if (value === "inbox") filters.inbox = true;
        else if (value === "sent") filters.sent = true;
        else return null;
        break;
      }
      case "after":
      case "before": {
        const date = parseAbsoluteDate(value);
        if (!date) return null;
        if (operator === "after") filters.after = date;
        else filters.before = date;
        break;
      }
      case "newer_than":
      case "older_than": {
        const date = parseRelativeDate(value);
        if (!date) return null;
        if (operator === "newer_than") filters.after = date;
        else filters.before = date;
        break;
      }
      default:
        return null;
    }
  }

  const text = textTerms.join(" ").trim();
  if (text) filters.text = text;

  // A query of only unsupported-but-parsed noise would match the whole mailbox.
  if (!Object.keys(filters).length) return null;

  return filters;
}

export async function searchEmailMessages({
  emailAccountId,
  filters,
  limit,
  offset,
}: {
  emailAccountId: string;
  filters: DbSearchFilters;
  limit: number;
  offset: number;
}) {
  const conditions = [
    Prisma.sql`"emailAccountId" = ${emailAccountId}`,
    // Rows saved before the content columns existed have no subject or search
    // vector. Returning them would hand the agent blank messages, so they stay
    // invisible until the backfill script fills them in.
    Prisma.sql`"subject" IS NOT NULL`,
  ];

  if (filters.text) {
    conditions.push(
      Prisma.sql`"searchVector" @@ plainto_tsquery('english', ${filters.text})`,
    );
  }
  if (filters.from) {
    conditions.push(Prisma.sql`lower("from") = ${filters.from}`);
  }
  if (filters.read !== undefined) {
    conditions.push(Prisma.sql`"read" = ${filters.read}`);
  }
  if (filters.hasAttachments) {
    conditions.push(Prisma.sql`"hasAttachments" = true`);
  }
  if (filters.inbox) conditions.push(Prisma.sql`"inbox" = true`);
  if (filters.sent) conditions.push(Prisma.sql`"sent" = true`);
  if (filters.after) conditions.push(Prisma.sql`"date" >= ${filters.after}`);
  if (filters.before) conditions.push(Prisma.sql`"date" < ${filters.before}`);

  return prisma.$queryRaw<DbSearchRow[]>`
    SELECT
      "messageId",
      "threadId",
      "externalUrl",
      "subject",
      "from",
      "to",
      "snippet",
      "date",
      "labels",
      "hasAttachments",
      "read",
      "aiSummary",
      "aiCategory",
      "aiUrgency"
    FROM "EmailMessage"
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY "date" DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

/**
 * Maps the Outlook search tool's structured inputs onto local columns.
 *
 * Returns `null` for a category or folder scope: the mirror stores provider
 * label ids, not Outlook category or folder names, so resolving one to the
 * other would need a provider call and defeat the point.
 */
export function buildOutlookFiltersForDb({
  query,
  fromEmail,
  readState,
  categoryName,
}: {
  query?: string;
  fromEmail?: string | null;
  readState?: "read" | "unread" | null;
  categoryName?: string | null;
}): DbSearchFilters | null {
  if (categoryName) return null;

  const filters: DbSearchFilters = {};

  if (fromEmail) {
    if (!isValidEmail(fromEmail)) return null;
    filters.from = fromEmail.toLowerCase();
  }
  if (readState) filters.read = readState === "read";

  const text = query?.trim();
  if (text) filters.text = text;

  if (!Object.keys(filters).length) return null;

  return filters;
}

/**
 * Nearest-neighbour search over the stored embeddings, using cosine distance to
 * match the ivfflat index. Rows without an embedding are excluded rather than
 * sorted to the end, so a partially embedded mailbox still ranks correctly.
 */
export async function semanticSearchEmailMessages({
  emailAccountId,
  embedding,
  limit,
}: {
  emailAccountId: string;
  embedding: number[];
  limit: number;
}) {
  const vector = `[${embedding.join(",")}]`;

  return prisma.$queryRaw<DbSearchRow[]>`
    SELECT
      "messageId",
      "threadId",
      "externalUrl",
      "subject",
      "from",
      "to",
      "snippet",
      "date",
      "labels",
      "hasAttachments",
      "read",
      "aiSummary",
      "aiCategory",
      "aiUrgency"
    FROM "EmailMessage"
    WHERE "emailAccountId" = ${emailAccountId}
      AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${vector}::vector
    LIMIT ${limit}
  `;
}

function stripQuotes(value: string) {
  return value.replace(/^"|"$/g, "").trim();
}

function parseAbsoluteDate(value: string) {
  if (!DATE_PATTERN.test(value)) return null;
  const date = new Date(value.replace(/\//g, "-"));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseRelativeDate(value: string) {
  const match = /^(\d+)([dmy])$/.exec(value.toLowerCase());
  if (!match) return null;
  const amount = Number(match[1]);
  const days = RELATIVE_UNIT_DAYS[match[2] as keyof typeof RELATIVE_UNIT_DAYS];
  return new Date(Date.now() - amount * days * MS_PER_DAY);
}
