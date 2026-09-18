// Backfills the EmailMessage columns added for local search (subject, snippet,
// cc, labels, isReply, searchVector) on rows saved before those columns existed.
//
// Pages the mailbox instead of re-fetching each NULL-subject row by id: the list
// endpoint returns fully parsed messages, so one API call covers 20 messages
// rather than one. Writes go through the same upsert the live sync uses, so a
// row that is already complete is simply rewritten with the same values.
//
// Run with:
//   pnpm --filter inbox-zero-ai backfill-email-content -- --email-account-id=<id>
// (the package script supplies NODE_ENV and the tsconfig that stubs `server-only`,
// which the provider client pulls in)
// Resume an interrupted run from the last "oldest processed" date it logged:
//   ... --email-account-id=<id> --before=2024-03-01
// Try a couple of pages first with --max-pages=2; each page is 20 messages.

import "dotenv/config";
import { createEmailProvider } from "@/utils/email/provider";
import { saveParsedMessages } from "@/utils/email-message/save-email-messages";
import { createScopedLogger, type Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { sleep } from "@/utils/sleep";

const PAGE_SIZE = 20;
const PAGE_DELAY_MS = 200; // stay well under provider rate limits on long runs

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logger = createScopedLogger("backfill-email-content");

  const emailAccounts = await prisma.emailAccount.findMany({
    where: args.emailAccountId ? { id: args.emailAccountId } : {},
    select: { id: true, account: { select: { provider: true } } },
  });

  if (!emailAccounts.length) {
    logger.error("No email accounts matched", {
      emailAccountId: args.emailAccountId,
    });
    process.exitCode = 1;
    return;
  }

  for (const emailAccount of emailAccounts) {
    const accountLogger = logger.with({ emailAccountId: emailAccount.id });

    try {
      await backfillAccount({
        emailAccountId: emailAccount.id,
        provider: emailAccount.account.provider,
        before: args.before,
        maxPages: args.maxPages,
        logger: accountLogger,
      });
    } catch (error) {
      accountLogger.error("Backfill failed", { error });
      process.exitCode = 1;
    }
  }
}

async function backfillAccount({
  emailAccountId,
  provider,
  before,
  maxPages,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  before?: Date;
  maxPages: number;
  logger: Logger;
}) {
  const emailProvider = await createEmailProvider({
    emailAccountId,
    provider,
    logger,
  });

  let pageToken: string | undefined;
  let pages = 0;
  let saved = 0;
  let oldestProcessed: Date | undefined;

  while (pages < maxPages) {
    const res = await emailProvider.getMessagesWithPagination({
      maxResults: PAGE_SIZE,
      pageToken,
      before,
      after: undefined,
    });

    const messages = res.messages ?? [];
    if (!messages.length) break;

    saved += await saveParsedMessages({ emailAccountId, messages, logger });
    pages++;

    for (const message of messages) {
      const date = new Date(message.date);
      if (Number.isNaN(date.getTime())) continue;
      if (!oldestProcessed || date < oldestProcessed) oldestProcessed = date;
    }

    logger.info("Backfilled page", {
      pages,
      saved,
      oldestProcessed: oldestProcessed?.toISOString(),
    });

    pageToken = res.nextPageToken;
    if (!pageToken) break;

    await sleep(PAGE_DELAY_MS);
  }

  logger.info("Backfill complete", {
    pages,
    saved,
    // Pass this back as --before to resume a run that stopped early.
    oldestProcessed: oldestProcessed?.toISOString(),
    hasMore: Boolean(pageToken),
  });
}

function parseArgs(argv: string[]) {
  const get = (name: string) =>
    argv
      .find((arg) => arg.startsWith(`--${name}=`))
      ?.slice(name.length + 3)
      .trim();

  const beforeArg = get("before");
  const before = beforeArg ? new Date(beforeArg) : undefined;
  if (before && Number.isNaN(before.getTime())) {
    throw new Error(`Invalid --before date: ${beforeArg}`);
  }

  const maxPagesArg = get("max-pages");
  const maxPages = maxPagesArg ? Number(maxPagesArg) : Number.POSITIVE_INFINITY;
  if (!(maxPages > 0)) {
    throw new Error(`Invalid --max-pages: ${maxPagesArg}`);
  }

  return { emailAccountId: get("email-account-id"), before, maxPages };
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
