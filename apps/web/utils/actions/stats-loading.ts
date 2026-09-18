import "server-only";

import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import type { EmailProvider } from "@/utils/email/types";
import { saveParsedMessages } from "@/utils/email-message/save-email-messages";

const PAGE_SIZE = 20; // avoid setting too high because it will hit the rate limit
const MAX_PAGES = 50;

export async function loadEmails(
  {
    emailAccountId,
    emailProvider,
    logger,
  }: {
    emailAccountId: string;
    emailProvider: EmailProvider;
    logger: Logger;
  },
  {
    loadBefore,
    maxPages = MAX_PAGES,
  }: { loadBefore: boolean; maxPages?: number },
) {
  let pages = 0;
  let loadedAfterMessages = 0;
  let loadedBeforeMessages = 0;
  let hasMoreAfter = false;
  let hasMoreBefore = false;

  const newestEmailSaved = await prisma.emailMessage.findFirst({
    where: { emailAccountId },
    orderBy: { date: "desc" },
  });

  const after = newestEmailSaved?.date;
  logger.info("Loading emails after", { after });

  let nextPageToken: string | undefined;
  while (pages < maxPages) {
    logger.info("After Page", { pages, nextPageToken });
    const res = await saveBatch({
      emailAccountId,
      emailProvider,
      logger,
      nextPageToken,
      after,
      before: undefined,
    });

    nextPageToken = res.data.nextPageToken ?? undefined;
    loadedAfterMessages += res.data.messages?.length || 0;

    if (!res.data.messages || res.data.messages.length < PAGE_SIZE) {
      hasMoreAfter = false;
      break;
    }

    pages++;

    if (!nextPageToken) {
      hasMoreAfter = false;
      break;
    }

    hasMoreAfter = true;
  }

  logger.info("Completed emails after", { after, pages });

  if (!loadBefore || !newestEmailSaved) {
    return {
      pages,
      loadedAfterMessages,
      loadedBeforeMessages,
      hasMoreAfter,
      hasMoreBefore,
    };
  }

  const oldestEmailSaved = await prisma.emailMessage.findFirst({
    where: { emailAccountId },
    orderBy: { date: "asc" },
  });

  const before = oldestEmailSaved?.date;
  logger.info("Loading emails before", { before });

  if (!before) {
    return {
      pages,
      loadedAfterMessages,
      loadedBeforeMessages,
      hasMoreAfter,
      hasMoreBefore,
    };
  }

  nextPageToken = undefined;
  while (pages < maxPages) {
    logger.info("Before Page", { pages, nextPageToken });
    const res = await saveBatch({
      emailAccountId,
      emailProvider,
      logger,
      nextPageToken,
      before,
      after: undefined,
    });

    nextPageToken = res.data.nextPageToken ?? undefined;
    loadedBeforeMessages += res.data.messages?.length || 0;

    if (!res.data.messages || res.data.messages.length < PAGE_SIZE) {
      hasMoreBefore = false;
      break;
    }

    pages++;

    if (!nextPageToken) {
      hasMoreBefore = false;
      break;
    }

    hasMoreBefore = true;
  }

  logger.info("Completed emails before", { before, pages });

  return {
    pages,
    loadedAfterMessages,
    loadedBeforeMessages,
    hasMoreAfter,
    hasMoreBefore,
  };
}

export async function saveBatch({
  emailAccountId,
  emailProvider,
  logger,
  nextPageToken,
  before,
  after,
}: {
  emailAccountId: string;
  emailProvider: EmailProvider;
  logger: Logger;
  nextPageToken?: string;
} & (
  | { before: Date; after: undefined }
  | { before: undefined; after: Date }
  | { before: undefined; after: undefined }
)) {
  const res = await emailProvider.getMessagesWithPagination({
    maxResults: PAGE_SIZE,
    pageToken: nextPageToken,
    before,
    after,
  });

  const messages = res.messages ?? [];

  const savedCount = await saveParsedMessages({
    emailAccountId,
    messages,
    logger,
  });

  logger.info("Saving", { count: savedCount });

  return {
    data: {
      messages: res.messages,
      nextPageToken: res.nextPageToken,
    },
  };
}
