import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEmail } from "@/__tests__/helpers";
import { jevClean } from "@/utils/ai/clean/ai-clean";
import { createScopedLogger } from "@/utils/logger";

vi.mock("@/env", () => ({
  env: {
    JEV_ENABLED: true,
    JEV_BASE_URL: "http://localhost:8009/v1",
    JEV_MODEL: "kev-latest",
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const logger = createScopedLogger("ai-clean-test");
const skips = { reply: true, receipt: false };

function kevSays(probability: number) {
  mockFetch.mockResolvedValue(
    Response.json({ answers: { archive: { noul: probability } } }),
  );
}

describe("jevClean", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps an email the model is fairly sure should stay", async () => {
    kevSays(0.2);

    const result = await jevClean({ messages: [getEmail()], skips, logger });

    expect(result?.archive).toBe(false);
  });

  it("never archives on its own; the LLM decides archives", async () => {
    kevSays(0.95);

    const result = await jevClean({ messages: [getEmail()], skips, logger });

    expect(result).toBeNull();
  });
});
