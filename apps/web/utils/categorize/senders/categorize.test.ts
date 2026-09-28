import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEmailAccount } from "@/__tests__/helpers";
import { defaultCategory } from "@/utils/categories";
import {
  categorizeSender,
  categorizeWithAi,
} from "@/utils/categorize/senders/categorize";
import {
  aiCategorizeSender,
  jevCategorizeSender,
} from "@/utils/ai/categorize-sender/ai-categorize-single-sender";
import { aiCategorizeSenders } from "@/utils/ai/categorize-sender/ai-categorize-senders";
import { upsertSenderRecord } from "@/utils/senders/record";

vi.mock("@/utils/ai/categorize-sender/ai-categorize-single-sender", () => ({
  aiCategorizeSender: vi.fn(),
  jevCategorizeSender: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/utils/ai/categorize-sender/ai-categorize-senders", () => ({
  aiCategorizeSenders: vi.fn(),
}));

vi.mock("@/utils/senders/record", () => ({
  upsertSenderRecord: vi.fn(),
}));

describe("categorizeSender", () => {
  const emailAccount = getEmailAccount();
  const categories = [
    {
      id: "cat-other",
      name: defaultCategory.OTHER.name,
      description: defaultCategory.OTHER.description,
    },
    {
      id: "cat-notification",
      name: defaultCategory.NOTIFICATION.name,
      description: defaultCategory.NOTIFICATION.description,
    },
  ];
  const provider = {
    getThreadsFromSenderWithSubject: vi.fn(),
  } as unknown as {
    getThreadsFromSenderWithSubject: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provider.getThreadsFromSenderWithSubject.mockResolvedValue([]);
  });

  it("defaults abstained single-sender categorization to Other", async () => {
    vi.mocked(aiCategorizeSender).mockResolvedValue(null);
    vi.mocked(upsertSenderRecord).mockResolvedValue({
      categoryId: "cat-other",
    } as Awaited<ReturnType<typeof upsertSenderRecord>>);

    const result = await categorizeSender(
      "unknown@example.com",
      emailAccount,
      provider as never,
      categories,
    );

    expect(upsertSenderRecord).toHaveBeenCalledWith({
      emailAccountId: emailAccount.id,
      senderEmail: "unknown@example.com",
      changes: {
        categoryId: "cat-other",
      },
    });
    expect(result).toEqual({ categoryId: "cat-other" });
  });

  it("uses a confident decision-model category without the LLM", async () => {
    vi.mocked(jevCategorizeSender).mockResolvedValueOnce({
      category: defaultCategory.NOTIFICATION.name,
      rationale: "Jev (p=0.85)",
    });
    vi.mocked(upsertSenderRecord).mockResolvedValue({
      categoryId: "cat-notification",
    } as Awaited<ReturnType<typeof upsertSenderRecord>>);

    const result = await categorizeSender(
      "noreply@github.com",
      emailAccount,
      provider as never,
      categories,
    );

    expect(aiCategorizeSender).not.toHaveBeenCalled();
    expect(result).toEqual({ categoryId: "cat-notification" });
  });
});

describe("categorizeWithAi", () => {
  const emailAccount = getEmailAccount();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiCategorizeSenders).mockResolvedValue([]);
    vi.mocked(jevCategorizeSender).mockResolvedValue(null);
  });

  it("does not apply static rules for categories the user does not have", async () => {
    const sendersWithEmails = new Map([
      ["newsletter@substack.com", []],
      ["other@example.com", []],
    ]);
    vi.mocked(aiCategorizeSenders).mockResolvedValue([
      { sender: "newsletter@substack.com", category: "Marketing" },
      { sender: "other@example.com", category: "Marketing" },
    ]);

    const result = await categorizeWithAi({
      emailAccount,
      sendersWithEmails,
      categories: [{ name: "Marketing", description: "Promotions" }],
    });

    expect(vi.mocked(aiCategorizeSenders)).toHaveBeenCalledWith(
      expect.objectContaining({
        senders: [
          { emailAddress: "newsletter@substack.com", emails: [] },
          { emailAddress: "other@example.com", emails: [] },
        ],
      }),
    );
    expect(result).toEqual([
      { sender: "newsletter@substack.com", category: "Marketing" },
      { sender: "other@example.com", category: "Marketing" },
    ]);
  });

  it("applies static rules and skips AI for senders when the matching category exists", async () => {
    const sendersWithEmails = new Map([
      ["newsletter@substack.com", []],
      ["receipt@example.com", []],
      ["other@example.com", []],
    ]);

    const result = await categorizeWithAi({
      emailAccount,
      sendersWithEmails,
      categories: [
        { name: "Newsletter", description: "Editorial" },
        { name: "Receipt", description: "Purchase confirmations" },
      ],
    });

    expect(vi.mocked(aiCategorizeSenders)).toHaveBeenCalledWith(
      expect.objectContaining({
        senders: [{ emailAddress: "other@example.com", emails: [] }],
      }),
    );
    expect(result).toEqual([
      { sender: "newsletter@substack.com", category: "Newsletter" },
      { sender: "receipt@example.com", category: "Receipt" },
      { sender: "other@example.com", category: undefined },
    ]);
  });

  it("sends only the senders the decision model is unsure about to the LLM", async () => {
    const sendersWithEmails = new Map([
      ["alerts@bank.example", []],
      ["someone@example.com", []],
    ]);
    vi.mocked(jevCategorizeSender).mockImplementation(async ({ sender }) =>
      sender === "alerts@bank.example"
        ? { category: "Notification", rationale: "Jev (p=0.9)" }
        : null,
    );
    vi.mocked(aiCategorizeSenders).mockResolvedValue([
      { sender: "someone@example.com", category: "Other" },
    ]);

    const result = await categorizeWithAi({
      emailAccount,
      sendersWithEmails,
      categories: [
        { name: "Notification", description: "Automated alerts" },
        { name: "Other", description: "Anything else" },
      ],
    });

    expect(vi.mocked(aiCategorizeSenders)).toHaveBeenCalledWith(
      expect.objectContaining({
        senders: [{ emailAddress: "someone@example.com", emails: [] }],
      }),
    );
    expect(result).toEqual([
      { sender: "alerts@bank.example", category: "Notification" },
      { sender: "someone@example.com", category: "Other" },
    ]);
  });
});
