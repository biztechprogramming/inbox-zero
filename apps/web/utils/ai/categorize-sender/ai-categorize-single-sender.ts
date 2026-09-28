import { z } from "zod";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { Category } from "@/generated/prisma/client";
import { formatCategoriesForPrompt } from "@/utils/ai/categorize-sender/format-categories";
import { getModelForUseCase, LlmUseCase } from "@/utils/llms/use-cases";
import { createGenerateObject } from "@/utils/llms";
import { strictOptional } from "@/utils/llms/strict-optional";
import { askSystemOne } from "@/utils/llms/system-one";
import type { Logger } from "@/utils/logger";

// Minimum probability for the decision model's answer to be used without the LLM.
const JEV_CATEGORY_CONFIDENCE = 0.6;

export async function aiCategorizeSender({
  emailAccount,
  sender,
  previousEmails,
  categories,
}: {
  emailAccount: EmailAccountWithAI;
  sender: string;
  previousEmails: { subject: string; snippet: string }[];
  categories: Pick<Category, "name" | "description">[];
}) {
  const system = `You are an AI assistant specializing in email management and organization.
Your task is to categorize an email accounts based on their name, email address, and content from previous emails.
Provide an accurate categorization to help users efficiently manage their inbox.`;

  const prompt = `Categorize the following email account:
${sender}

Previous emails from them:
${previousEmails
  .slice(0, 3)
  .map(
    (email) =>
      `<email><subject>${email.subject}</subject><snippet>${email.snippet}</snippet></email>`,
  )
  .join("\n")}
${previousEmails.length === 0 ? "No previous emails found" : ""}

<categories>
${formatCategoriesForPrompt(categories)}
</categories>

<instructions>
1. Analyze the sender's name and email address for clues about their category.
2. Review the content of previous emails to gain more context about the account's relationship with us.
3. If the category is clear, assign it.
4. If you're not certain, respond with "Unknown".
5. If multiple categories are possible, respond with "Unknown".
6. Return your response in JSON format.
</instructions>`;

  const modelOptions = getModelForUseCase(
    emailAccount.user,
    LlmUseCase.CategorizeSender,
  );

  const generateObject = createGenerateObject({
    emailAccount,
    label: "Categorize sender",
    modelOptions,
    promptHardening: { trust: "untrusted", level: "compact" },
  });

  const aiResponse = await generateObject({
    ...modelOptions,
    instructions: system,
    prompt,
    schema: z.object({
      rationale: strictOptional(z.string()).describe(
        "Keep it short. 1-2 sentences max.",
      ),
      category: z.string(),
    }),
  });

  if (!categories.find((c) => c.name === aiResponse.object.category))
    return null;

  return aiResponse.object;
}

// Returns null when the caller should fall back to the LLM.
export async function jevCategorizeSender({
  sender,
  previousEmails,
  categories,
  logger,
}: {
  sender: string;
  previousEmails: { subject: string; snippet: string }[];
  categories: Pick<Category, "name" | "description">[];
  logger: Logger;
}): Promise<{ category: string; rationale: string } | null> {
  if (!categories.length) return null;

  // Keyed by index because category names can contain arbitrary characters.
  const criteria = Object.fromEntries(
    categories.map((c, i) => [
      `c${i}`,
      c.description ? `${c.name}: ${c.description}` : c.name,
    ]),
  );

  const answers = await askSystemOne({
    state: `Sender: ${sender}

Recent emails from this sender:
${
  previousEmails
    .slice(0, 3)
    .map(
      (email) =>
        `<email><subject>${email.subject}</subject><snippet>${email.snippet}</snippet></email>`,
    )
    .join("\n") || "No previous emails found"
}`,
    questions: {
      category: {
        type: "choice",
        instructions:
          "Which category best describes this sender, judging from their address and the emails they send?",
        criteria,
      },
    },
    logger,
  });
  const choice = answers?.category?.choice;
  const probability = choice && answers?.category?.probabilities?.[choice];
  const category = choice && categories[Number(choice.slice(1))];

  if (!category || !probability || probability < JEV_CATEGORY_CONFIDENCE) {
    logger.info("Jev not confident on sender category, falling back to LLM", {
      choice,
      probability,
    });
    return null;
  }

  return {
    category: category.name,
    rationale: `Jev (p=${probability.toFixed(2)})`,
  };
}
