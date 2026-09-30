import type { Prisma } from "@/generated/prisma/client";
import type {
  EmailAudience,
  EmailItemOwner,
  EmailItemStatus,
  EmailItemType,
} from "@/generated/prisma/enums";
import prisma from "@/utils/prisma";

export type EmailItemFilters = {
  types?: EmailItemType[];
  /** Omit for any status. */
  status?: EmailItemStatus;
  owner?: EmailItemOwner;
  /** An email address, or a domain matching it and its subdomains. */
  counterparty?: string;
  /** Words that must all appear in the item text. */
  query?: string;
  dueAfter?: Date;
  dueBefore?: Date;
  /** Source mail on or after this date. */
  after?: Date;
  audience?: EmailAudience;
  threadId?: string;
};

/**
 * Filtered, complete listing of an account's extracted items, newest source
 * mail first. Each item carries its source message's subject and link.
 */
export async function listEmailItems({
  emailAccountId,
  filters,
  limit,
  offset,
}: {
  emailAccountId: string;
  filters: EmailItemFilters;
  limit: number;
  offset: number;
}) {
  const rows = await prisma.emailItem.findMany({
    where: buildItemWhere(emailAccountId, filters),
    orderBy: [{ sourceDate: "desc" }, { id: "asc" }],
    skip: offset,
    // One extra row answers hasMore without a count query.
    take: limit + 1,
    select: {
      id: true,
      type: true,
      status: true,
      text: true,
      owner: true,
      counterpartyEmail: true,
      counterpartyName: true,
      dueDate: true,
      sourceDate: true,
      audience: true,
      threadId: true,
      messageId: true,
      resolvedAt: true,
    },
  });
  const items = rows.slice(0, limit);

  const sources = await prisma.emailMessage.findMany({
    where: {
      emailAccountId,
      messageId: { in: [...new Set(items.map((item) => item.messageId))] },
    },
    select: { messageId: true, subject: true, externalUrl: true },
  });
  const sourceById = new Map(
    sources.map((source) => [source.messageId, source]),
  );

  return {
    items: items.map((item) => ({
      ...item,
      subject: sourceById.get(item.messageId)?.subject ?? null,
      link: sourceById.get(item.messageId)?.externalUrl ?? null,
    })),
    hasMore: rows.length > limit,
  };
}

function buildItemWhere(
  emailAccountId: string,
  filters: EmailItemFilters,
): Prisma.EmailItemWhereInput {
  const and: Prisma.EmailItemWhereInput[] = [];

  const counterparty = filters.counterparty?.trim().toLowerCase();
  if (counterparty) {
    and.push(
      counterparty.includes("@")
        ? { counterpartyEmail: counterparty }
        : {
            OR: [
              { counterpartyEmail: { endsWith: `@${counterparty}` } },
              { counterpartyEmail: { endsWith: `.${counterparty}` } },
            ],
          },
    );
  }

  for (const word of filters.query?.split(/\s+/).filter(Boolean) ?? []) {
    and.push({ text: { contains: word, mode: "insensitive" } });
  }

  return {
    emailAccountId,
    ...(filters.status && { status: filters.status }),
    ...(filters.types?.length && { type: { in: filters.types } }),
    ...(filters.owner && { owner: filters.owner }),
    ...(filters.audience && { audience: filters.audience }),
    ...(filters.threadId && { threadId: filters.threadId }),
    ...((filters.dueAfter || filters.dueBefore) && {
      dueDate: {
        ...(filters.dueAfter && { gte: filters.dueAfter }),
        ...(filters.dueBefore && { lt: filters.dueBefore }),
      },
    }),
    ...(filters.after && { sourceDate: { gte: filters.after } }),
    ...(and.length && { AND: and }),
  };
}
