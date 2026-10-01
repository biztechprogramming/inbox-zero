import type {
  MessageAnalysis,
  OpenItemContext,
} from "@/utils/knowledge/analyze-message";
import { askSystemOne } from "@/utils/llms/system-one";
import type { Logger } from "@/utils/logger";
import { escapeHtml } from "@/utils/string";

// Kev decides ephemera only when confident; in between, the LLM's call
// stands. Calibrated on probes where notifications scored 0.71-0.89 and
// people's replies or real asks 0.06-0.47.
const EPHEMERAL_YES = 0.6;
const EPHEMERAL_NO = 0.5;
// Duplicates scored 0.58-0.93 and distinct obligations 0.04-0.15 on probes.
const SAME_OBLIGATION = 0.4;

type Answers = Awaited<ReturnType<typeof askSystemOne>>;

const EPHEMERAL_QUESTION =
  "Is this email only a system notification (an alert, a status change, a receipt, or a promotion) with no request for the reader, no deadline for the reader, and no lasting information about people?";

const FACT_KIND_CRITERIA = {
  lasting:
    "Lasting information: someone's role, company, or contact details, a price, a policy, a preference, or how the user writes to someone.",
  this_email:
    "Only about this particular email: who sent it, who received it, or who is involved in it.",
  logistics:
    "A one-off meeting or call arrangement: a time, a join link, a dial-in number, a conference ID, or an agenda.",
};

/**
 * Checks the judgments the economy model gets wrong (ephemera, facts that
 * only restate the email or its meeting logistics, items repeating an open
 * one) with the System One decision model. Kev can't write text, so it only
 * filters what the LLM produced.
 *
 * Returns null when Kev is disabled or failed, so the caller can fall back
 * to a model that makes these judgments itself.
 */
export async function gateMessageAnalysis({
  analysis,
  emailState,
  openItems,
  logger,
}: {
  analysis: MessageAnalysis;
  /** The email as shown to the LLM, so Kev judges ephemera from the same text. */
  emailState: string;
  openItems: OpenItemContext[];
  logger: Logger;
}): Promise<MessageAnalysis | null> {
  // Ephemerality only decides whether facts and new items are kept.
  if (!analysis.facts.length && !analysis.newItems.length) return analysis;

  const start = performance.now();
  const statementQuestions = buildStatementQuestions({ analysis, openItems });
  const [emailAnswers, statementAnswers] = await Promise.all([
    askSystemOne({
      state: emailState,
      questions: {
        ephemeral: { type: "noul", instructions: EPHEMERAL_QUESTION },
      },
      logger,
    }),
    // Statements are judged without the email: alongside it, Kev reads every
    // fact as being about the email.
    Object.keys(statementQuestions).length
      ? askSystemOne({
          state: formatStatements({ analysis, openItems }),
          questions: statementQuestions,
          logger,
        })
      : ({} as Answers),
  ]);
  if (!emailAnswers || !statementAnswers) return null;

  const ephemeralProbability = emailAnswers.ephemeral?.noul;
  const ephemeral = decideEphemeral(ephemeralProbability, analysis.ephemeral);

  const facts = analysis.facts.filter((_fact, index) => {
    const kind = statementAnswers[`fact_${index + 1}`]?.choice;
    return !kind || kind === "lasting";
  });

  const resolved = new Set(analysis.resolvedItemIds);
  const newItems = analysis.newItems.filter((_item, candidate) =>
    openItems.every((openItem, open) => {
      // Resolving an item and re-adding it is how a change is recorded.
      if (resolved.has(openItem.id)) return true;
      const same = statementAnswers[pairKey(candidate, open)]?.noul;
      return same === undefined || same < SAME_OBLIGATION;
    }),
  );

  logger.info("Knowledge Kev gate", {
    latencyMs: Math.round(performance.now() - start),
    ephemeralProbability,
    ephemeralChanged: ephemeral !== analysis.ephemeral,
    factsDropped: analysis.facts.length - facts.length,
    itemsDropped: analysis.newItems.length - newItems.length,
  });

  return { ...analysis, ephemeral, facts, newItems };
}

function decideEphemeral(probability: number | undefined, llmSays: boolean) {
  if (probability === undefined) return llmSays;
  if (probability >= EPHEMERAL_YES) return true;
  if (probability <= EPHEMERAL_NO) return false;
  return llmSays;
}

function formatStatements({
  analysis,
  openItems,
}: {
  analysis: MessageAnalysis;
  openItems: OpenItemContext[];
}) {
  return [
    analysis.facts.length &&
      `Statements:\n${analysis.facts.map((fact, index) => `[F${index + 1}] ${escapeHtml(fact)}`).join("\n")}`,
    analysis.newItems.length &&
      openItems.length &&
      `Open items:\n${openItems.map((item, index) => `[O${index + 1}] ${escapeHtml(item.text)}`).join("\n")}\n\nCandidate items:\n${analysis.newItems.map((item, index) => `[C${index + 1}] ${escapeHtml(item.text)}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildStatementQuestions({
  analysis,
  openItems,
}: {
  analysis: MessageAnalysis;
  openItems: OpenItemContext[];
}) {
  const questions: Parameters<typeof askSystemOne>[0]["questions"] = {};
  analysis.facts.forEach((_fact, index) => {
    questions[`fact_${index + 1}`] = {
      type: "choice",
      instructions: `What kind of statement is F${index + 1}?`,
      criteria: FACT_KIND_CRITERIA,
    };
  });
  analysis.newItems.forEach((_item, candidate) => {
    openItems.forEach((_openItem, open) => {
      questions[pairKey(candidate, open)] = {
        type: "noul",
        instructions: `Is candidate item C${candidate + 1} already covered by open item O${open + 1}, meaning the same task by the same people, even if worded differently or with a due date added?`,
      };
    });
  });
  return questions;
}

function pairKey(candidate: number, open: number) {
  return `same_c${candidate + 1}_o${open + 1}`;
}
