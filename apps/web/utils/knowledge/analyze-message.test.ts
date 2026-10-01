import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";
import { LlmUseCase } from "@/utils/llms/use-cases";

vi.mock("server-only", () => ({}));

const { testEnv, generateObject, gateMessageAnalysis, getModelForUseCase } =
  vi.hoisted(() => ({
    testEnv: { JEV_ENABLED: true },
    generateObject: vi.fn(),
    gateMessageAnalysis: vi.fn(),
    getModelForUseCase: vi.fn((_user: unknown, useCase: string) => ({
      useCase,
    })),
  }));

vi.mock("@/env", () => ({ env: testEnv }));
vi.mock("@/utils/llms", () => ({
  createGenerateObject: () => generateObject,
}));
vi.mock("@/utils/llms/use-cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/llms/use-cases")>()),
  getModelForUseCase,
}));
vi.mock("@/utils/knowledge/kev-gate", () => ({ gateMessageAnalysis }));

import { analyzeMessageKnowledge } from "./analyze-message";
import { getEmailAccount } from "@/__tests__/helpers";

const logger = createScopedLogger("test");

const draft = {
  ephemeral: false,
  threadSummary: "Summary.",
  facts: [],
  newItems: [],
  resolvedItemIds: ["2", "9"],
};

function analyze() {
  return analyzeMessageKnowledge({
    logger,
    emailAccount: getEmailAccount(),
    email: {
      id: "m1",
      from: "sam@acme.example",
      to: "user@test.com",
      subject: "Budget",
      content: "Please review.",
    },
    sent: false,
    threadSummary: null,
    openItems: [
      {
        id: "open-a",
        type: "REQUEST",
        text: "A.",
        owner: "ME",
        counterpartyEmail: null,
        dueDate: null,
      },
      {
        id: "open-b",
        type: "REQUEST",
        text: "B.",
        owner: "ME",
        counterpartyEmail: null,
        dueDate: null,
      },
    ],
    knownFacts: [],
  });
}

function usedUseCases() {
  return getModelForUseCase.mock.calls.map(([, useCase]) => useCase);
}

describe("analyzeMessageKnowledge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testEnv.JEV_ENABLED = true;
    generateObject.mockResolvedValue({ object: draft });
  });

  it("maps positional item ids back to rows and drops invented ones", async () => {
    gateMessageAnalysis.mockImplementation(async ({ analysis }) => analysis);

    const result = await analyze();

    expect(result.resolvedItemIds).toEqual(["open-b"]);
  });

  it("uses the economy model checked by Kev when Kev is available", async () => {
    const gated = { ...draft, facts: ["Kept."] };
    gateMessageAnalysis.mockResolvedValue(gated);

    const result = await analyze();

    expect(usedUseCases()).toEqual([LlmUseCase.KnowledgeExtraction]);
    expect(result).toBe(gated);
  });

  it("re-runs on the fallback model when Kev fails", async () => {
    gateMessageAnalysis.mockResolvedValue(null);

    await analyze();

    expect(usedUseCases()).toEqual([
      LlmUseCase.KnowledgeExtraction,
      LlmUseCase.KnowledgeExtractionFallback,
    ]);
  });

  it("goes straight to the fallback model when Kev is disabled", async () => {
    testEnv.JEV_ENABLED = false;

    await analyze();

    expect(usedUseCases()).toEqual([LlmUseCase.KnowledgeExtractionFallback]);
    expect(gateMessageAnalysis).not.toHaveBeenCalled();
  });
});
