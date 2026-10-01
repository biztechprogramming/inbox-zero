import { NextResponse } from "next/server";
import { hasCronSecret, hasPostCronSecret } from "@/utils/cron";
import { withError } from "@/utils/middleware";
import { captureException } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import {
  getPremiumUserFilter,
  getUserTier,
  hasAiAccess,
} from "@/utils/premium";
import {
  webhookEmailAccountSelect,
  type ValidatedWebhookAccountData,
} from "@/utils/webhook/validate-webhook-account";
import { createEmailProvider } from "@/utils/email/provider";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import { markMessageAsProcessing } from "@/utils/redis/message-processing";
import { pollImapAccount } from "@/utils/imap/poll";

export const maxDuration = 300;

export const GET = withError("cron/imap-poll", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(
      new Error("Unauthorized cron request: api/cron/imap-poll"),
    );
    return new Response("Unauthorized", { status: 401 });
  }
  return pollAllImapAccounts(request.logger);
});

export const POST = withError("cron/imap-poll", async (request) => {
  if (!(await hasPostCronSecret(request))) {
    captureException(
      new Error("Unauthorized cron request: api/cron/imap-poll"),
    );
    return new Response("Unauthorized", { status: 401 });
  }
  return pollAllImapAccounts(request.logger);
});

async function pollAllImapAccounts(logger: Logger) {
  const emailAccounts = await prisma.emailAccount.findMany({
    where: {
      ...getPremiumUserFilter(),
      account: { provider: "imap", disconnectedAt: null },
    },
    select: webhookEmailAccountSelect,
  });

  const results: Array<{
    emailAccountId: string;
    status: "ok" | "skipped" | "error";
    processed?: number;
  }> = [];

  for (const emailAccount of emailAccounts) {
    const log = logger.with({
      emailAccountId: emailAccount.id,
      email: emailAccount.email,
      provider: "imap",
    });
    try {
      const result = await pollOneAccount(emailAccount, log);
      results.push({ emailAccountId: emailAccount.id, ...result });
    } catch (error) {
      log.error("IMAP poll failed for account", { error });
      captureException(error, { emailAccountId: emailAccount.id });
      results.push({ emailAccountId: emailAccount.id, status: "error" });
    }
  }

  return NextResponse.json({ success: true, results });
}

async function pollOneAccount(
  emailAccount: NonNullable<ValidatedWebhookAccountData>,
  logger: Logger,
): Promise<{ status: "ok" | "skipped"; processed?: number }> {
  const tier = getUserTier(emailAccount.user.premium);
  const userHasAiAccess = hasAiAccess(tier, !!emailAccount.user.aiApiKey);
  if (!userHasAiAccess) {
    logger.info("Skipping IMAP poll: no AI access");
    return { status: "skipped" };
  }

  const hasAutomationRules = emailAccount.rules.length > 0;
  const hasFilingEnabled =
    emailAccount.filingEnabled && !!emailAccount.filingPrompt;
  if (!hasAutomationRules && !hasFilingEnabled) {
    logger.info("Skipping IMAP poll: no rules enabled");
    return { status: "skipped" };
  }

  const { newMessages } = await pollImapAccount({
    emailAccountId: emailAccount.id,
    logger,
  });
  if (!newMessages.length) return { status: "ok", processed: 0 };

  const provider = await createEmailProvider({
    emailAccountId: emailAccount.id,
    provider: "imap",
    logger,
  });

  let processed = 0;
  for (const message of newMessages) {
    // Same redis guard the webhook paths use, in case poll runs overlap.
    const isFree = await markMessageAsProcessing({
      userEmail: emailAccount.email,
      messageId: message.id,
    });
    if (!isFree) {
      logger.info("Skipping. Message already being processed.", {
        messageId: message.id,
      });
      continue;
    }

    await processHistoryItem(
      { messageId: message.id, threadId: message.threadId, message },
      {
        provider,
        emailAccount,
        hasAutomationRules,
        hasAiAccess: userHasAiAccess,
        rules: emailAccount.rules,
        logger,
      },
    );
    processed += 1;
  }

  logger.info("IMAP poll complete", { processed });
  return { status: "ok", processed };
}
