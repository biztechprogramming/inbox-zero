import { describe, expect, it } from "vitest";
import { buildThreadingHeaders } from "@/utils/email/threading";
import { buildMimeMessage, generateImapMessageId } from "./smtp";

describe("buildMimeMessage", () => {
  it("builds one raw message with a known Message-ID and full envelope", async () => {
    const { raw, envelope, messageId } = await buildMimeMessage({
      from: "me@example.com",
      to: "to@example.com",
      cc: "cc@example.com",
      bcc: "secret@example.com",
      subject: "Hello",
      text: "hi",
      html: "<p>hi</p>",
    });

    const text = raw.toString("utf8");
    expect(messageId).toMatch(/@example\.com$/);
    expect(text).toContain(`Message-ID: <${messageId}>`);
    expect(text).toContain("Subject: Hello");

    // Bcc never appears in the message bytes (they go to every recipient)...
    expect(text.toLowerCase()).not.toContain("secret@example.com");
    // ...but bcc recipients are still delivered via the SMTP envelope.
    expect(envelope.to).toContain("secret@example.com");
    expect(envelope.to).toContain("to@example.com");
    expect(envelope.to).toContain("cc@example.com");
    expect(envelope.from).toBe("me@example.com");
  });

  it("carries reply threading headers", async () => {
    const { raw } = await buildMimeMessage({
      from: "me@example.com",
      to: "to@example.com",
      subject: "Re: Hello",
      text: "reply",
      ...buildThreadingHeaders({
        headerMessageId: "<root@example.com>",
        references: "<older@example.com>",
      }),
    });

    const text = raw.toString("utf8");
    expect(text).toContain("In-Reply-To: <root@example.com>");
    expect(text).toContain(
      "References: <older@example.com> <root@example.com>",
    );
  });

  it("respects a caller-provided Message-ID (stable draft ids)", async () => {
    const { messageId, raw } = await buildMimeMessage({
      from: "me@example.com",
      to: "to@example.com",
      subject: "Draft",
      text: "draft",
      messageId: "<existing-draft@example.com>",
    });
    expect(messageId).toBe("existing-draft@example.com");
    expect(raw.toString("utf8")).toContain(
      "Message-ID: <existing-draft@example.com>",
    );
  });
});

describe("generateImapMessageId", () => {
  it("uses the sender domain and is unique", () => {
    const a = generateImapMessageId("Alice <alice@corp.example>");
    const b = generateImapMessageId("Alice <alice@corp.example>");
    expect(a).toMatch(/^<[0-9a-f-]+@corp\.example>$/);
    expect(a).not.toBe(b);
  });

  it("falls back to a fixed domain for unparsable senders", () => {
    expect(generateImapMessageId("nonsense")).toMatch(/@inbox-zero\.mail>$/);
  });
});
