import { embedMany } from "ai";
import { z } from "zod";
import { createGenerateObject } from "@/utils/llms";
import { getEmbeddingModel } from "@/utils/llms/model";
import type { EmailAccountWithAI, UserAIFields } from "@/utils/llms/types";
import { getModelForUseCase, LlmUseCase } from "@/utils/llms/use-cases";
import type { Logger } from "@/utils/logger";

const SUBJECT_MAX_LENGTH = 200;
const SNIPPET_MAX_LENGTH = 500;

export type MessageToEnrich = {
  messageId: string;
  from: string;
  subject: string | null;
  snippet: string | null;
};

export type MessageEnrichment = {
  aiSummary: string | null;
  aiCategory: string | null;
  aiUrgency: number | null;
  embedding: number[] | null;
};

const instructions = `You classify email metadata so an assistant can answer questions about a mailbox without re-reading each message.

For every email you are given, return:
- summary: one sentence, under 200 characters, stating what the email is about and what (if anything) it asks the reader to do. Do not repeat the subject line verbatim.
- category: newsletter (bulk or subscribed content), transactional (receipts, confirmations, alerts, automated notices), personal (from an individual about non-work matters), or work (from an individual or team about work).
- urgency: 1 (no action ever needed) to 5 (needs action today). Judge only from the content you are shown; do not assume a deadline that is not stated.

Return one entry per email, echoing the id you were given. You are shown a subject and a short preview, not the full body, so describe only what is visible.`;

const schema = z.object({
  results: z.array(
    z.object({
      id: z.string().describe("The id of the email being described."),
      summary: z.string(),
      category: z.enum(["newsletter", "transactional", "personal", "work"]),
      urgency: z.number().int().min(1).max(5),
    }),
  ),
});

/**
 * Computes the assistant-facing fields for a batch of messages: a one-line
 * summary, a coarse category, an urgency score, and a search embedding.
 *
 * Classification and embedding run independently so one provider failing still
 * yields the other, and a total failure yields an empty map rather than
 * blocking the message write.
 */
export async function enrichMessages({
  messages,
  emailAccount,
  logger,
}: {
  messages: MessageToEnrich[];
  emailAccount: EmailAccountWithAI;
  logger: Logger;
}) {
  const enrichment = new Map<string, MessageEnrichment>();
  if (!messages.length) return enrichment;

  const [classifications, embeddings] = await Promise.all([
    classifyMessages({ messages, emailAccount, logger }),
    embedMessages({ messages, userAi: emailAccount.user, logger }),
  ]);

  for (const message of messages) {
    const classification = classifications.get(message.messageId);
    const embedding = embeddings.get(message.messageId) ?? null;
    if (!classification && !embedding) continue;

    enrichment.set(message.messageId, {
      aiSummary: classification?.summary ?? null,
      aiCategory: classification?.category ?? null,
      aiUrgency: classification?.urgency ?? null,
      embedding,
    });
  }

  return enrichment;
}

export function getEmbeddingInput({ subject, snippet }: MessageToEnrich) {
  return [
    subject?.slice(0, SUBJECT_MAX_LENGTH),
    snippet?.slice(0, SNIPPET_MAX_LENGTH),
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function embedQuery({
  query,
  userAi,
}: {
  query: string;
  userAi: UserAIFields;
}) {
  const [embedding] = await embedTexts([query], userAi);
  return embedding ?? null;
}

async function classifyMessages({
  messages,
  emailAccount,
  logger,
}: {
  messages: MessageToEnrich[];
  emailAccount: EmailAccountWithAI;
  logger: Logger;
}) {
  const byId = new Map<string, z.infer<typeof schema>["results"][number]>();

  try {
    const modelOptions = getModelForUseCase(
      emailAccount.user,
      LlmUseCase.EmailMessageEnrichment,
    );

    const generateObject = createGenerateObject({
      emailAccount,
      label: "Email message enrichment",
      modelOptions,
      promptHardening: { trust: "untrusted", level: "compact" },
    });

    const result = await generateObject({
      ...modelOptions,
      instructions,
      prompt: `<emails>
${messages.map(formatMessageForPrompt).join("\n")}
</emails>`,
      schema,
    });

    for (const entry of result.object.results) byId.set(entry.id, entry);
  } catch (error) {
    logger.error("Failed to classify messages", { error });
  }

  return byId;
}

async function embedMessages({
  messages,
  userAi,
  logger,
}: {
  messages: MessageToEnrich[];
  userAi: UserAIFields;
  logger: Logger;
}) {
  const byId = new Map<string, number[]>();

  const embeddable = messages.filter((message) => getEmbeddingInput(message));
  if (!embeddable.length) return byId;

  try {
    const embeddings = await embedTexts(
      embeddable.map(getEmbeddingInput),
      userAi,
    );
    embeddable.forEach((message, index) => {
      const embedding = embeddings[index];
      if (embedding) byId.set(message.messageId, embedding);
    });
  } catch (error) {
    logger.error("Failed to embed messages", { error });
  }

  return byId;
}

async function embedTexts(values: string[], userAi: UserAIFields) {
  const model = getEmbeddingModel(userAi);
  if (!model) return [];

  const { embeddings } = await embedMany({ model, values });

  return embeddings;
}

function formatMessageForPrompt(message: MessageToEnrich) {
  return `<email id="${message.messageId}">
<from>${message.from}</from>
<subject>${message.subject?.slice(0, SUBJECT_MAX_LENGTH) ?? ""}</subject>
<preview>${message.snippet?.slice(0, SNIPPET_MAX_LENGTH) ?? ""}</preview>
</email>`;
}
