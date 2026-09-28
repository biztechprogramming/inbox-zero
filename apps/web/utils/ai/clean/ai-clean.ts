import { z } from "zod";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { EmailForLLM } from "@/utils/types";
import { stringifyEmailSimple } from "@/utils/stringify-email";
import { formatDateForLLM, formatRelativeTimeForLLM } from "@/utils/date";
import { preprocessBooleanLike } from "@/utils/zod";
import { getModelForUseCase, LlmUseCase } from "@/utils/llms/use-cases";
import { createGenerateObject } from "@/utils/llms";
import { askSystemOne } from "@/utils/llms/system-one";
import type { Logger } from "@/utils/logger";
// import { Braintrust } from "@/utils/braintrust";

// TODO: allow specific labels
// Pass in prompt labels
const schema = z.object({
  archive: z.preprocess(preprocessBooleanLike, z.boolean()),
  // label: z.string().optional(),
  // reasoning: z.string(),
});

// const braintrust = new Braintrust("cleaner-1");

// Below this archive probability the decision model's "keep" is used without the LLM.
// Only "keep" is trusted: evals showed its confident archives include receipts the user
// asked to keep, and wrongly keeping an email costs far less than wrongly archiving it.
const JEV_CLEAN_KEEP_BELOW = 0.5;

export async function aiClean({
  emailAccount,
  messageId: _messageId,
  messages,
  instructions,
  skips,
}: {
  emailAccount: EmailAccountWithAI;
  messageId: string;
  messages: EmailForLLM[];
  instructions?: string;
  skips: {
    reply?: boolean | null;
    receipt?: boolean | null;
  };
}): Promise<{ archive: boolean }> {
  const lastMessage = messages.at(-1);

  if (!lastMessage) throw new Error("No messages");

  const system =
    `You are an AI assistant designed to help users achieve inbox zero by analyzing emails and deciding whether they should be archived or not.
  
Examples of emails to archive:
- Newsletters
- Marketing
- Notifications
- Low-priority emails
- Notifications
- Social
- LinkedIn messages
- Facebook messages
- GitHub issues

${skips.reply ? "Do not archive emails that the user needs to reply to. But do archive old emails that are clearly not needed." : ""}
${
  skips.receipt
    ? `Do not archive emails that are actual financial records: receipts, payment confirmations, or invoices.
However, do archive payment-related communications like overdue payment notifications, payment reminders, or subscription renewal notices.`
    : ""
}

Return your response in JSON format.`.trim();

  const message = `${stringifyEmailSimple(lastMessage)}
  ${
    lastMessage.date
      ? `<date>${formatDateForLLM(lastMessage.date)} (${formatRelativeTimeForLLM(lastMessage.date)})</date>`
      : ""
  }`;

  const currentDate = formatDateForLLM(new Date());

  const prompt = `
${
  instructions
    ? `Additional user instructions:
<instructions>${instructions}</instructions>`
    : ""
}

The email to analyze:

<email>
${message}
</email>

The current date is ${currentDate}.
`.trim();

  // ${user.about ? `<user_background_information>${user.about}</user_background_information>` : ""}

  const modelOptions = getModelForUseCase(
    emailAccount.user,
    LlmUseCase.CleanInbox,
  );

  const generateObject = createGenerateObject({
    emailAccount,
    label: "Clean",
    modelOptions,
    promptHardening: { trust: "untrusted", level: "compact" },
  });

  const aiResponse = await generateObject({
    ...modelOptions,
    instructions: system,
    prompt,
    schema,
  });

  // braintrust.insertToDataset({
  //   id: messageId,
  //   input: { message, currentDate },
  //   expected: aiResponse.object,
  // });

  return aiResponse.object as { archive: boolean };
}

// Returns null when the caller should fall back to the LLM.
export async function jevClean({
  messages,
  instructions,
  skips,
  logger,
}: {
  messages: EmailForLLM[];
  instructions?: string;
  skips: { reply?: boolean | null; receipt?: boolean | null };
  logger: Logger;
}): Promise<{ archive: boolean; reason: string } | null> {
  const lastMessage = messages.at(-1);
  if (!lastMessage) return null;

  const guidance = [
    "Archive newsletters, marketing, notifications, social updates, and other low-priority email the user doesn't need to keep in their inbox.",
    skips.reply &&
      "Keep email the user still needs to reply to, but archive old email that is clearly no longer needed.",
    skips.receipt &&
      "Keep financial records: receipts, payment confirmations and invoices. Payment reminders, overdue notices and renewal notices can be archived.",
    instructions && `User instructions: ${instructions}`,
  ]
    .filter(Boolean)
    .join("\n");

  const answers = await askSystemOne({
    state: `<email>
${stringifyEmailSimple(lastMessage)}
${lastMessage.date ? `<date>${formatDateForLLM(lastMessage.date)} (${formatRelativeTimeForLLM(lastMessage.date)})</date>` : ""}
</email>
The current date is ${formatDateForLLM(new Date())}.`,
    questions: {
      archive: {
        type: "noul",
        instructions: `Should this email be archived to help the user reach inbox zero?\n\n${guidance}`,
      },
    },
    logger,
  });
  const probability = answers?.archive?.noul;
  if (probability === undefined) return null;

  if (probability >= JEV_CLEAN_KEEP_BELOW) {
    logger.info("Jev leaning archive on clean, deferring to LLM", {
      probability,
    });
    return null;
  }

  return { archive: false, reason: `Jev (p=${probability.toFixed(2)})` };
}
