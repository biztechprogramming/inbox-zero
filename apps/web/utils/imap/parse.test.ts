import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { buildLabelIds, toParsedMessage } from "./parse";

const RAW_MESSAGE = [
  "Message-ID: <msg-1@example.com>",
  "In-Reply-To: <root@example.com>",
  "References: <root@example.com>",
  'From: "Alice" <alice@example.com>',
  "To: bob@example.com",
  "Cc: carol@example.com",
  "Subject: Hello world",
  "Date: Thu, 01 Jan 2026 10:00:00 +0000",
  "List-Unsubscribe: <https://example.com/unsub>",
  'Content-Type: multipart/mixed; boundary="b1"',
  "MIME-Version: 1.0",
  "",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Hi   there, Bob!</p>",
  "--b1",
  "Content-Type: text/plain; charset=utf-8",
  'Content-Disposition: attachment; filename="notes.txt"',
  "",
  "attached notes",
  "--b1--",
  "",
].join("\r\n");

describe("toParsedMessage", () => {
  it("maps a parsed MIME message into the ParsedMessage shape", async () => {
    const parsed = await simpleParser(RAW_MESSAGE);
    const message = toParsedMessage({
      parsed,
      id: "msg-1@example.com",
      threadId: "root@example.com",
      location: {
        folderPath: "INBOX",
        specialUse: "\\Inbox",
        flags: ["\\Flagged"],
        internalDate: new Date("2026-01-01T10:00:05Z"),
      },
    });

    expect(message.id).toBe("msg-1@example.com");
    expect(message.threadId).toBe("root@example.com");
    expect(message.subject).toBe("Hello world");
    expect(message.headers.from).toContain("alice@example.com");
    expect(message.headers.to).toBe("bob@example.com");
    expect(message.headers["message-id"]).toBe("<msg-1@example.com>");
    expect(message.headers["in-reply-to"]).toBe("<root@example.com>");
    expect(message.headers.references).toBe("<root@example.com>");
    expect(message.headers["list-unsubscribe"]).toContain(
      "https://example.com/unsub",
    );
    expect(message.textHtml).toContain("Hi");
    expect(message.labelIds).toEqual(
      expect.arrayContaining(["INBOX", "UNREAD", "STARRED"]),
    );
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments?.[0].filename).toBe("notes.txt");
    expect(message.attachments?.[0].attachmentId).toBeTruthy();
    expect(message.internalDate).toBe(
      String(new Date("2026-01-01T10:00:05Z").getTime()),
    );
  });
});

describe("buildLabelIds", () => {
  it("maps special-use folders to Gmail-style system labels", () => {
    expect(
      buildLabelIds({
        folderPath: "Sent",
        specialUse: "\\Sent",
        flags: ["\\Seen"],
      }),
    ).toEqual(["SENT"]);
    expect(
      buildLabelIds({
        folderPath: "Trash",
        specialUse: "\\Trash",
        flags: ["\\Seen"],
      }),
    ).toEqual(["TRASH"]);
    expect(
      buildLabelIds({ folderPath: "Junk", specialUse: "\\Junk", flags: [] }),
    ).toEqual(["SPAM", "UNREAD"]);
  });

  it("treats archived mail as unlabeled (not INBOX)", () => {
    expect(
      buildLabelIds({
        folderPath: "Archive",
        specialUse: "\\Archive",
        flags: ["\\Seen"],
      }),
    ).toEqual([]);
  });

  it("uses the folder path as the label for regular folders", () => {
    expect(
      buildLabelIds({
        folderPath: "Receipts/2026",
        specialUse: null,
        flags: ["\\Seen"],
      }),
    ).toEqual(["Receipts/2026"]);
  });
});
