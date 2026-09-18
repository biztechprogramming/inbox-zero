import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";
import {
  extractDomainFromEmail,
  extractEmailAddress,
  extractNameFromEmail,
} from "@/utils/email";
import { internalDateToDate } from "@/utils/date";
import type { Logger } from "@/utils/logger";
import { findUnsubscribeLink } from "@/utils/parse/parseHtml.server";
import {
  cleanUnsubscribeLink,
  parseListUnsubscribeHeader,
} from "@/utils/parse/unsubscribe";
import { isDefined } from "@/utils/types";
import type { ParsedMessage } from "@/utils/types";
import { getEmailAccountWithAi } from "@/utils/user/get";
import {
  enrichMessages,
  type MessageEnrichment,
  type MessageToEnrich,
} from "@/utils/email-message/enrich-messages";

// The only writer of EmailMessage. The stats loader, the backfill script and the
// webhook all route through here so a message is stored identically whichever
// path first sees it.
export async function saveParsedMessages({
  emailAccountId,
  messages,
  logger,
}: {
  emailAccountId: string;
  messages: ParsedMessage[];
  logger: Logger;
}) {
  const emails = messages
    .map((m) => {
      // `date` orders every local search result, so fall back to the header
      // date rather than storing "now" for a message with no internalDate.
      const date = internalDateToDate(m.internalDate ?? m.date, {
        fallbackToNow: false,
      });
      if (Number.isNaN(date.getTime())) {
        logger.error("No usable date for email", {
          messageId: m.id,
          internalDate: m.internalDate,
        });
        return;
      }

      return {
        threadId: m.threadId,
        messageId: m.id,
        from: extractEmailAddress(m.headers.from),
        fromName: extractNameFromEmail(m.headers.from),
        fromDomain: extractDomainFromEmail(m.headers.from),
        to: m.headers.to ? extractEmailAddress(m.headers.to) : "Missing",
        cc: m.headers.cc ?? null,
        date,
        unsubscribeLink: mergeUnsubscribeSources({
          htmlUnsubscribeLink: findUnsubscribeLink(m.textHtml),
          listUnsubscribeHeader: m.headers["list-unsubscribe"],
        }),
        read: !m.labelIds?.includes("UNREAD"),
        sent: !!m.labelIds?.includes("SENT"),
        draft: !!m.labelIds?.includes("DRAFT"),
        inbox: !!m.labelIds?.includes("INBOX"),
        subject: m.subject ?? null,
        snippet: m.snippet ?? null,
        hasAttachments: (m.attachments?.length ?? 0) > 0,
        labels: m.labelIds ?? [],
        isReply: !!m.headers["in-reply-to"],
        externalUrl: m.externalUrl ?? null,
        emailAccountId,
      };
    })
    .filter(isDefined);

  if (emails.length === 0) return 0;

  const enrichment = await enrichInboxMessages({
    emailAccountId,
    emails,
    logger,
  });

  const rows = emails.map(
    (email) => Prisma.sql`(
      ${randomUUID()}::text,
      ${email.emailAccountId}::text,
      ${email.threadId}::text,
      ${email.messageId}::text,
      ${email.date}::timestamp,
      ${email.from}::text,
      ${email.fromName}::text,
      ${email.fromDomain}::text,
      ${email.to}::text,
      ${email.cc}::text,
      ${email.unsubscribeLink}::text,
      ${email.read}::boolean,
      ${email.sent}::boolean,
      ${email.draft}::boolean,
      ${email.inbox}::boolean,
      ${email.subject}::text,
      ${email.snippet}::text,
      ${email.hasAttachments}::boolean,
      ${email.labels}::text[],
      ${email.isReply}::boolean,
      ${email.externalUrl}::text,
      to_tsvector('english', concat_ws(' ', ${email.subject}::text, ${email.snippet}::text, ${email.fromName}::text)),
      ${enrichment.get(email.messageId)?.aiSummary ?? null}::text,
      ${enrichment.get(email.messageId)?.aiCategory ?? null}::text,
      ${enrichment.get(email.messageId)?.aiUrgency ?? null}::smallint,
      ${toVectorLiteral(enrichment.get(email.messageId)?.embedding)}::vector,
      NOW(),
      NOW()
    )`,
  );

  await prisma.$executeRaw`
    INSERT INTO "EmailMessage" (
      "id",
      "emailAccountId",
      "threadId",
      "messageId",
      "date",
      "from",
      "fromName",
      "fromDomain",
      "to",
      "cc",
      "unsubscribeLink",
      "read",
      "sent",
      "draft",
      "inbox",
      "subject",
      "snippet",
      "hasAttachments",
      "labels",
      "isReply",
      "externalUrl",
      "searchVector",
      "aiSummary",
      "aiCategory",
      "aiUrgency",
      "embedding",
      "createdAt",
      "updatedAt"
    )
    VALUES ${Prisma.join(rows)}
    ON CONFLICT ("emailAccountId", "threadId", "messageId") DO UPDATE SET
      "date" = EXCLUDED."date",
      "from" = EXCLUDED."from",
      "fromName" = EXCLUDED."fromName",
      "fromDomain" = EXCLUDED."fromDomain",
      "to" = EXCLUDED."to",
      "cc" = EXCLUDED."cc",
      "unsubscribeLink" = EXCLUDED."unsubscribeLink",
      "read" = EXCLUDED."read",
      "sent" = EXCLUDED."sent",
      "draft" = EXCLUDED."draft",
      "inbox" = EXCLUDED."inbox",
      "subject" = EXCLUDED."subject",
      "snippet" = EXCLUDED."snippet",
      "hasAttachments" = EXCLUDED."hasAttachments",
      "labels" = EXCLUDED."labels",
      "isReply" = EXCLUDED."isReply",
      "externalUrl" = EXCLUDED."externalUrl",
      "searchVector" = EXCLUDED."searchVector",
      -- Enrichment is only recomputed for rows that had none, so never let a
      -- plain re-sync overwrite a stored value with NULL.
      "aiSummary" = COALESCE(EXCLUDED."aiSummary", "EmailMessage"."aiSummary"),
      "aiCategory" = COALESCE(EXCLUDED."aiCategory", "EmailMessage"."aiCategory"),
      "aiUrgency" = COALESCE(EXCLUDED."aiUrgency", "EmailMessage"."aiUrgency"),
      "embedding" = COALESCE(EXCLUDED."embedding", "EmailMessage"."embedding"),
      "updatedAt" = NOW()
  `;

  return emails.length;
}

function mergeUnsubscribeSources({
  htmlUnsubscribeLink,
  listUnsubscribeHeader,
}: {
  htmlUnsubscribeLink?: string | null;
  listUnsubscribeHeader?: string | null;
}) {
  if (!listUnsubscribeHeader) return cleanUnsubscribeLink(htmlUnsubscribeLink);

  const normalizedHtmlLink = cleanUnsubscribeLink(htmlUnsubscribeLink);
  if (!normalizedHtmlLink) return listUnsubscribeHeader;

  const headerLinks = parseListUnsubscribeHeader(listUnsubscribeHeader);
  if (headerLinks.includes(normalizedHtmlLink)) return listUnsubscribeHeader;

  return `${listUnsubscribeHeader}, <${normalizedHtmlLink}>`;
}

type EmailToSave = {
  messageId: string;
  from: string;
  subject: string | null;
  snippet: string | null;
  inbox: boolean;
  sent: boolean;
  draft: boolean;
};

/**
 * Computes the assistant-facing fields for the inbox messages in a batch.
 *
 * Only inbox mail is enriched — archived and sent history is the bulk of a
 * mailbox and is rarely what the assistant is asked about, so paying an LLM
 * call for it is not worth the cost. Messages already enriched on a previous
 * sync are skipped, and any failure returns an empty map so the write still
 * happens with the metadata columns populated.
 */
async function enrichInboxMessages({
  emailAccountId,
  emails,
  logger,
}: {
  emailAccountId: string;
  emails: EmailToSave[];
  logger: Logger;
}) {
  const empty = new Map<string, MessageEnrichment>();

  const candidates = emails.filter(
    (email) => email.inbox && !email.sent && !email.draft,
  );
  if (!candidates.length) return empty;

  try {
    const alreadyEnriched = await prisma.emailMessage.findMany({
      where: {
        emailAccountId,
        messageId: { in: candidates.map((email) => email.messageId) },
        aiSummary: { not: null },
      },
      select: { messageId: true },
    });
    const enrichedIds = new Set(
      alreadyEnriched.map((email) => email.messageId),
    );

    const messages: MessageToEnrich[] = candidates
      .filter((email) => !enrichedIds.has(email.messageId))
      .map((email) => ({
        messageId: email.messageId,
        from: email.from,
        subject: email.subject,
        snippet: email.snippet,
      }));
    if (!messages.length) return empty;

    const emailAccount = await getEmailAccountWithAi({ emailAccountId });
    if (!emailAccount) return empty;

    return await enrichMessages({ messages, emailAccount, logger });
  } catch (error) {
    logger.error("Failed to enrich messages", { error });
    return empty;
  }
}

// pgvector accepts its own bracketed text form, not a Postgres array literal.
function toVectorLiteral(embedding?: number[] | null) {
  return embedding?.length ? `[${embedding.join(",")}]` : null;
}
