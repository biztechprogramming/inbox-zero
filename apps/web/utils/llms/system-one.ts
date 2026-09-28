import { env } from "@/env";
import type { Logger } from "@/utils/logger";

const TIMEOUT_MS = 10_000;

type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string };

type Answer = {
  choice?: string;
  probabilities?: Record<string, number>;
  noul?: number;
};

// Calls a System One decision model: TypeSafe (Jev), Opper, or a self-hosted Kev server.
// Returns null when disabled or on any failure, so callers fall back to the LLM.
export async function askSystemOne<Q extends Record<string, Question>>({
  state,
  questions,
  logger,
}: {
  state: string;
  questions: Q;
  logger: Logger;
}): Promise<Partial<Record<keyof Q, Answer>> | null> {
  if (!env.JEV_ENABLED) return null;

  try {
    const response = await fetch(`${env.JEV_BASE_URL}/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.JEV_API_KEY && { authorization: `Bearer ${env.JEV_API_KEY}` }),
      },
      body: JSON.stringify({ model: env.JEV_MODEL, state, questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`System One API ${response.status}`);

    const data: { answers?: Partial<Record<keyof Q, Answer>> } =
      await response.json();
    return data.answers ?? null;
  } catch (error) {
    logger.warn("System One call failed, falling back to LLM", { error });
    return null;
  }
}
