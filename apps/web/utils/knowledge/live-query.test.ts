/** Throwaway: query the live knowledge store (direct mail only). Delete after use. */
import { config } from "dotenv";
import { describe, expect, it } from "vitest";

config({
  path: "/Users/abarnett/Dev/inbox-zero/apps/web/.env",
  override: true,
});

const EMAIL_ACCOUNT_ID = "cmu5y4zeu0002003d3kzedmkz";

describe("live knowledge query (dev)", () => {
  it("finds recent work requests addressed to the user", async () => {
    const { getEmailAccountWithAi } = await import("@/utils/user/get");
    const { searchKnowledgeItems } = await import("./retrieve");
    const { createScopedLogger } = await import("@/utils/logger");

    const emailAccount = await getEmailAccountWithAi({
      emailAccountId: EMAIL_ACCOUNT_ID,
    });

    const items = await searchKnowledgeItems({
      emailAccount: emailAccount!,
      query:
        "someone asking me to do work: a task, deliverable, review, or action item I need to complete",
      topK: 12,
      audience: "direct",
      logger: createScopedLogger("live-query"),
    });

    const byDate = items
      .map((item) => ({
        date: String(item.metadata?.date ?? ""),
        score: item.score?.toFixed(3),
        fact: item.fact,
      }))
      .sort((a, b) => b.date.localeCompare(a.date));

    for (const item of byDate) {
      console.log(`RESULT [${item.date}] (${item.score}) ${item.fact}`);
    }
    expect(items.length).toBeGreaterThan(0);
  }, 120_000);
});
