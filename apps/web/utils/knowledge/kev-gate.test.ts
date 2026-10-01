import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";
import type { MessageAnalysis } from "./analyze-message";

vi.mock("server-only", () => ({}));

const askSystemOne = vi.fn();
vi.mock("@/utils/llms/system-one", () => ({
  askSystemOne: (...args: unknown[]) => askSystemOne(...args),
}));

import { gateMessageAnalysis } from "./kev-gate";

const logger = createScopedLogger("test");

function analysis(overrides: Partial<MessageAnalysis> = {}): MessageAnalysis {
  return {
    ephemeral: false,
    threadSummary: "Summary.",
    facts: ["Rosa Diaz is the account manager at Northwind."],
    newItems: [
      {
        type: "request",
        text: "Sam asked the user to set up the Figma seat.",
        owner: "me",
        counterpartyEmail: null,
        dueDate: null,
      },
    ],
    resolvedItemIds: [],
    ...overrides,
  };
}

const openItems = [
  {
    id: "open-1",
    type: "REQUEST",
    text: "Sam asked the user to set up a paid Figma seat for Morgan.",
    owner: "ME",
    counterpartyEmail: null,
    dueDate: null,
  },
];

// The email call carries only the ephemeral question; the statements call
// carries the fact and duplicate questions.
function answer({
  ephemeral,
  statements = {},
}: {
  ephemeral?: number;
  statements?: Record<string, { choice?: string; noul?: number }>;
}) {
  askSystemOne.mockImplementation(async ({ questions }) =>
    "ephemeral" in questions
      ? { ...(ephemeral !== undefined && { ephemeral: { noul: ephemeral } }) }
      : statements,
  );
}

async function gate(input: MessageAnalysis, items = openItems) {
  return gateMessageAnalysis({
    analysis: input,
    emailState: "<email>...</email>",
    openItems: items,
    logger,
  });
}

describe("gateMessageAnalysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips Kev when there is nothing for ephemerality to keep or drop", async () => {
    const input = analysis({ facts: [], newItems: [] });

    expect(await gate(input)).toBe(input);
    expect(askSystemOne).not.toHaveBeenCalled();
  });

  it("returns null when Kev is unavailable so the caller can fall back", async () => {
    askSystemOne.mockResolvedValue(null);

    expect(await gate(analysis())).toBeNull();
  });

  it.each([
    [0.9, false, true],
    [0.2, true, false],
    [0.55, true, true],
    [0.55, false, false],
  ])("with ephemeral p=%s and LLM=%s decides %s", async (probability, llmSays, expected) => {
    answer({ ephemeral: probability });

    const result = await gate(analysis({ ephemeral: llmSays }));

    expect(result?.ephemeral).toBe(expected);
  });

  it("drops facts Kev reads as about this email or its logistics", async () => {
    answer({
      ephemeral: 0.1,
      statements: {
        fact_1: { choice: "lasting" },
        fact_2: { choice: "this_email" },
        fact_3: { choice: "logistics" },
      },
    });

    const result = await gate(
      analysis({ facts: ["Lasting.", "Envelope.", "Dial-in.", "Unjudged."] }),
    );

    expect(result?.facts).toEqual(["Lasting.", "Unjudged."]);
  });

  it("drops a new item that repeats an open one", async () => {
    answer({ ephemeral: 0.1, statements: { same_c1_o1: { noul: 0.94 } } });

    const result = await gate(analysis());

    expect(result?.newItems).toEqual([]);
  });

  it("keeps a repeat the LLM resolved first, since that records a change", async () => {
    answer({ ephemeral: 0.1, statements: { same_c1_o1: { noul: 0.94 } } });

    const result = await gate(analysis({ resolvedItemIds: ["open-1"] }));

    expect(result?.newItems).toHaveLength(1);
  });

  it("asks only the email question when there are no statements to judge", async () => {
    answer({ ephemeral: 0.1 });

    await gate(analysis({ facts: [] }), []);

    expect(askSystemOne).toHaveBeenCalledTimes(1);
  });
});
