import { env } from "@/env";
import { formatClassificationFeedback } from "@/utils/ai/choose-rule/ai-choose-rule";
import { getUserInfoPrompt } from "@/utils/ai/helpers";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { Logger } from "@/utils/logger";
import type { ClassificationFeedbackItem } from "@/utils/rule/classification-feedback";
import { stringifyEmail } from "@/utils/stringify-email";
import type { EmailForLLM } from "@/utils/types";

const NO_MATCH = "none";
const TIMEOUT_MS = 10_000;

// Speaks the System One API, so it works with TypeSafe (Jev), Opper, or a self-hosted Kev server.
// Returns null when the caller should fall back to the LLM.
export async function jevChooseRule<
  T extends { name: string; instructions: string; systemType?: string | null },
>({
  email,
  rules,
  emailAccount,
  logger,
  classificationFeedback,
}: {
  email: EmailForLLM;
  rules: T[];
  emailAccount: EmailAccountWithAI;
  logger: Logger;
  classificationFeedback?: ClassificationFeedbackItem[] | null;
}): Promise<{
  rules: { rule: T; isPrimary: boolean }[];
  reason: string;
} | null> {
  if (!env.JEV_ENABLED || !rules.length) return null;

  // A choice question picks exactly one option.
  const hasCustomRules = rules.some((rule) => !rule.systemType);
  if (hasCustomRules && emailAccount.multiRuleSelectionEnabled) return null;

  // Keyed by index because rule names can contain arbitrary characters.
  const criteria: Record<string, string> = Object.fromEntries(
    rules.map((rule, i) => [`r${i}`, `${rule.name}: ${rule.instructions}`]),
  );
  criteria[NO_MATCH] =
    "None of the other rules reasonably applies to this email.";

  try {
    const response = await fetch(`${env.JEV_BASE_URL}/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.JEV_API_KEY && { authorization: `Bearer ${env.JEV_API_KEY}` }),
      },
      body: JSON.stringify({
        model: env.JEV_MODEL,
        state: buildState({ email, emailAccount, classificationFeedback }),
        questions: {
          rule: {
            type: "choice",
            instructions:
              "Which of the user's rules should be applied to this email they received? Prefer the most specific rule; use a catch-all rule only when no specific rule fits.",
            criteria,
          },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`System One API ${response.status}`);

    const data: {
      answers?: {
        rule?: { choice?: string; probabilities?: Record<string, number> };
      };
    } = await response.json();
    const choice = data.answers?.rule?.choice;
    const probability = choice && data.answers?.rule?.probabilities?.[choice];

    // Evals show Kev picks "none" too often while its rule picks are reliable,
    // so only rule picks are trusted and "none" goes to the LLM.
    const rule =
      choice && choice !== NO_MATCH && rules[Number(choice.slice(1))];
    if (!rule || !probability || probability < env.JEV_RULE_THRESHOLD) {
      logger.info("Jev not confident, falling back to LLM", {
        choice,
        probability,
        threshold: env.JEV_RULE_THRESHOLD,
      });
      return null;
    }

    return {
      rules: [{ rule, isPrimary: true }],
      reason: `Jev (p=${probability.toFixed(2)}): ${rule.name}`,
    };
  } catch (error) {
    logger.warn("Jev failed, falling back to LLM", { error });
    return null;
  }
}

function buildState({
  email,
  emailAccount,
  classificationFeedback,
}: {
  email: EmailForLLM;
  emailAccount: EmailAccountWithAI;
  classificationFeedback?: ClassificationFeedbackItem[] | null;
}) {
  return [
    getUserInfoPrompt({ emailAccount }),
    `<email>\n${stringifyEmail(email, 500)}\n</email>`,
    email.listUnsubscribe && "This email has a List-Unsubscribe header.",
    formatClassificationFeedback(classificationFeedback),
  ]
    .filter(Boolean)
    .join("\n\n");
}
