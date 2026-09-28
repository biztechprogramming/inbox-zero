import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEmailAccount } from "@/__tests__/helpers";
import { createScopedLogger } from "@/utils/logger";
import { jevChooseRule } from "@/utils/ai/choose-rule/jev-choose-rule";

vi.mock("server-only", () => ({}));

const { mockedEnv } = vi.hoisted(() => ({
  mockedEnv: {
    JEV_ENABLED: true,
    JEV_BASE_URL: "http://localhost:8009/v1",
    JEV_MODEL: "kev-latest",
    JEV_RULE_THRESHOLD: 0.4,
  },
}));

vi.mock("@/env", () => ({ env: mockedEnv }));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const logger = createScopedLogger("jev-choose-rule-test");
const email = {
  id: "m1",
  from: "billing@vendor.com",
  to: "user@test.com",
  subject: "Your invoice",
  content: "Invoice attached.",
};
const rules = [
  {
    name: "Receipts",
    instructions: "Invoices and receipts",
    systemType: "RECEIPT",
  },
  { name: "Newsletter", instructions: "Newsletters", systemType: "NEWSLETTER" },
];

function jevResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function jevAnswers(choice: string, probabilities: Record<string, number>) {
  return jevResponse({
    answers: { rule: { type: "choice", choice, probabilities } },
  });
}

function run(overrides: Partial<Parameters<typeof jevChooseRule>[0]> = {}) {
  return jevChooseRule({
    email,
    rules,
    emailAccount: getEmailAccount(),
    logger,
    ...overrides,
  });
}

describe("jevChooseRule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedEnv.JEV_ENABLED = true;
  });

  it("returns the chosen rule when confidence clears the threshold", async () => {
    mockFetch.mockResolvedValue(
      jevAnswers("r0", { r0: 0.9, r1: 0.05, none: 0.05 }),
    );

    const result = await run();

    expect(result?.rules).toEqual([{ rule: rules[0], isPrimary: true }]);
  });

  it("falls back when Jev picks none, even confidently", async () => {
    mockFetch.mockResolvedValue(
      jevAnswers("none", { r0: 0.05, r1: 0.05, none: 0.9 }),
    );

    expect(await run()).toBeNull();
  });

  it("falls back when confidence is below the threshold", async () => {
    mockFetch.mockResolvedValue(
      jevAnswers("r0", { r0: 0.3, r1: 0.3, none: 0.4 }),
    );

    expect(await run()).toBeNull();
  });

  it("falls back when probabilities are missing", async () => {
    mockFetch.mockResolvedValue(
      jevResponse({ answers: { rule: { type: "choice", choice: "r0" } } }),
    );

    expect(await run()).toBeNull();
  });

  it("falls back when the request fails", async () => {
    mockFetch.mockRejectedValue(new Error("connection refused"));

    expect(await run()).toBeNull();
  });

  it("falls back on an error status", async () => {
    mockFetch.mockResolvedValue(jevResponse({ error: "overloaded" }, 503));

    expect(await run()).toBeNull();
  });

  it("skips Jev when disabled", async () => {
    mockedEnv.JEV_ENABLED = false;

    expect(await run()).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips Jev when multi-rule selection applies to custom rules", async () => {
    const result = await run({
      rules: [
        { name: "Clients", instructions: "Client emails", systemType: null },
      ],
      emailAccount: getEmailAccount({ multiRuleSelectionEnabled: true }),
    });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
