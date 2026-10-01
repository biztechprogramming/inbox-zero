import { describe, expect, it } from "vitest";
import {
  normalizeMessageId,
  fallbackMessageId,
  parseReferences,
} from "./message-id";

describe("normalizeMessageId", () => {
  it("strips angle brackets and whitespace", () => {
    expect(normalizeMessageId("<abc@example.com>")).toBe("abc@example.com");
    expect(normalizeMessageId("  <abc@example.com>  ")).toBe("abc@example.com");
    expect(normalizeMessageId("abc@example.com")).toBe("abc@example.com");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeMessageId(undefined)).toBeNull();
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId("")).toBeNull();
    expect(normalizeMessageId("<>")).toBeNull();
    expect(normalizeMessageId("   ")).toBeNull();
  });

  it("preserves case (Message-IDs are case-sensitive)", () => {
    expect(normalizeMessageId("<AbC@Example.com>")).toBe("AbC@Example.com");
  });
});

describe("fallbackMessageId", () => {
  it("is deterministic for the same location", () => {
    const a = fallbackMessageId({
      folderPath: "INBOX",
      uidValidity: BigInt(7),
      uid: BigInt(42),
      internalDate: new Date("2026-01-01T00:00:00Z"),
    });
    const b = fallbackMessageId({
      folderPath: "INBOX",
      uidValidity: BigInt(7),
      uid: BigInt(42),
      internalDate: new Date("2026-01-01T00:00:00Z"),
    });
    expect(a).toBe(b);
  });

  it("differs when the location differs", () => {
    const base = {
      folderPath: "INBOX",
      uidValidity: BigInt(7),
      uid: BigInt(42),
      internalDate: new Date("2026-01-01T00:00:00Z"),
    };
    expect(fallbackMessageId(base)).not.toBe(
      fallbackMessageId({ ...base, uid: BigInt(43) }),
    );
    expect(fallbackMessageId(base)).not.toBe(
      fallbackMessageId({ ...base, folderPath: "Archive" }),
    );
  });
});

describe("parseReferences", () => {
  it("splits a References header into normalized ids", () => {
    expect(parseReferences("<a@x.com> <b@y.com>\t<c@z.com>")).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
  });

  it("handles folded headers and missing values", () => {
    expect(parseReferences("<a@x.com>\r\n <b@y.com>")).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
    expect(parseReferences(undefined)).toEqual([]);
    expect(parseReferences("")).toEqual([]);
  });
});
