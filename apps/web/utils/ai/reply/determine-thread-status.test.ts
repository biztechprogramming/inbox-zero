import { beforeEach, describe, it, expect, vi } from "vitest";
import { SystemType } from "@/generated/prisma/enums";
import { getRuleConfig } from "@/utils/rule/consts";
import type { RuleWithActions } from "@/utils/types";
import { getEmail, getEmailAccount } from "@/__tests__/helpers";
import { createScopedLogger } from "@/utils/logger";
import { jevDetermineThreadStatus } from "@/utils/ai/reply/determine-thread-status";

vi.mock("@/env", () => ({
  env: {
    JEV_ENABLED: true,
    JEV_BASE_URL: "http://localhost:8009/v1",
    JEV_MODEL: "kev-latest",
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function getCustomizedRules(conversationRules: RuleWithActions[]) {
  return conversationRules.filter((r) => {
    if (!r.enabled || !r.instructions || !r.systemType) return false;
    const defaultInstructions = getRuleConfig(r.systemType).instructions;
    return r.instructions !== defaultInstructions;
  });
}

function createMockRule(
  systemType: SystemType,
  instructions: string | null,
  enabled = true,
): RuleWithActions {
  return {
    id: `rule-${systemType}`,
    name: systemType,
    instructions,
    enabled,
    systemType,
    runOnThreads: true,
    automate: true,
    actions: [],
    conditions: [],
    conditionalOperator: "AND",
  } as unknown as RuleWithActions;
}

describe("getCustomizedRules", () => {
  it("excludes rules with current default instructions", () => {
    const rules = [
      createMockRule(SystemType.TO_REPLY, "Emails I need to respond to"),
      createMockRule(
        SystemType.FYI,
        "Important emails I should know about, but don't need to reply to",
      ),
      createMockRule(
        SystemType.AWAITING_REPLY,
        "Emails where I'm waiting for someone to get back to me",
      ),
      createMockRule(
        SystemType.ACTIONED,
        "Conversations that are done, nothing left to do",
      ),
    ];

    const customized = getCustomizedRules(rules);
    expect(customized).toHaveLength(0);
  });

  it("includes rules with genuinely customized instructions", () => {
    const rules = [
      createMockRule(SystemType.TO_REPLY, "Emails I need to respond to"),
      createMockRule(
        SystemType.FYI,
        "Important emails from my team that I should read",
      ),
      createMockRule(
        SystemType.AWAITING_REPLY,
        "Emails where I'm waiting for someone to get back to me",
      ),
    ];

    const customized = getCustomizedRules(rules);
    expect(customized).toHaveLength(1);
    expect(customized[0].systemType).toBe(SystemType.FYI);
  });

  it("excludes disabled rules even if customized", () => {
    const rules = [
      createMockRule(
        SystemType.TO_REPLY,
        "Custom to reply instructions",
        false,
      ),
    ];

    const customized = getCustomizedRules(rules);
    expect(customized).toHaveLength(0);
  });

  it("excludes rules with null or empty instructions", () => {
    const rules = [
      createMockRule(SystemType.TO_REPLY, null),
      createMockRule(SystemType.FYI, ""),
    ];

    const customized = getCustomizedRules(rules);
    expect(customized).toHaveLength(0);
  });
});

describe("jevDetermineThreadStatus", () => {
  const logger = createScopedLogger("jev-thread-status-test");
  const threadMessages = [getEmail({ content: "Can you send the Q3 report?" })];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function kevSays(status: string, probability: number) {
    mockFetch.mockResolvedValue(
      Response.json({
        answers: {
          status: {
            choice: status,
            probabilities: { [status]: probability },
          },
        },
      }),
    );
  }

  it("uses a confident answer", async () => {
    kevSays(SystemType.TO_REPLY, 0.9);

    const result = await jevDetermineThreadStatus({
      emailAccount: getEmailAccount(),
      threadMessages,
      logger,
    });

    expect(result?.status).toBe(SystemType.TO_REPLY);
  });

  it("falls back when unsure", async () => {
    kevSays(SystemType.TO_REPLY, 0.5);

    const result = await jevDetermineThreadStatus({
      emailAccount: getEmailAccount(),
      threadMessages,
      logger,
    });

    expect(result).toBeNull();
  });

  it("falls back on FYI when the user sent the last email", async () => {
    kevSays(SystemType.FYI, 0.95);

    const result = await jevDetermineThreadStatus({
      emailAccount: getEmailAccount(),
      threadMessages,
      userSentLastEmail: true,
      logger,
    });

    expect(result).toBeNull();
  });

  it("leaves customized conversation preferences to the LLM", async () => {
    const result = await jevDetermineThreadStatus({
      emailAccount: getEmailAccount(),
      threadMessages,
      conversationRules: [
        createMockRule(SystemType.TO_REPLY, "Only emails from my boss"),
      ],
      logger,
    });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
