import { describe, expect, it } from "vitest";
import {
  buildOutlookFiltersForDb,
  parseGmailQueryForDb,
} from "./search-inbox-db";

describe("parseGmailQueryForDb", () => {
  it("maps free text and supported operators onto columns", () => {
    expect(parseGmailQueryForDb("invoice overdue")).toEqual({
      text: "invoice overdue",
    });

    expect(
      parseGmailQueryForDb("from:Billing@Example.com is:unread has:attachment"),
    ).toEqual({
      from: "billing@example.com",
      read: false,
      hasAttachments: true,
    });

    expect(parseGmailQueryForDb("in:inbox receipt")).toEqual({
      text: "receipt",
      inbox: true,
    });
  });

  it("parses absolute and relative date bounds", () => {
    expect(parseGmailQueryForDb("after:2024/03/01")?.after).toEqual(
      new Date("2024-03-01"),
    );
    expect(parseGmailQueryForDb("before:2024-03-01")?.before).toEqual(
      new Date("2024-03-01"),
    );

    const relative = parseGmailQueryForDb("newer_than:7d");
    expect(relative?.after?.getTime()).toBeCloseTo(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
      -3,
    );
  });

  it.each([
    ["label:Receipts", "label filter needs name to id resolution"],
    ["subject:invoice", "subject-scoped match is not stored separately"],
    ["to:someone@example.com", "only the first recipient is stored"],
    ["-invoice", "negation inverts every other filter"],
    ["invoice OR receipt", "filters below are AND-ed"],
    ["is:starred", "unknown operator value"],
    ["in:spam", "unsynced mailbox section"],
    ["after:last-tuesday", "unparseable date"],
    ["newer_than:7w", "unsupported relative unit"],
    ["", "nothing to filter on"],
  ])("falls back to the provider for %s", (query) => {
    expect(parseGmailQueryForDb(query)).toBeNull();
  });

  it("falls back when the same operator is given twice", () => {
    expect(
      parseGmailQueryForDb("from:a@example.com from:b@example.com"),
    ).toBeNull();
  });

  it("falls back for a sender that is not an exact address", () => {
    expect(parseGmailQueryForDb("from:stripe")).toBeNull();
  });
});

describe("buildOutlookFiltersForDb", () => {
  it("maps the structured Outlook inputs onto columns", () => {
    expect(
      buildOutlookFiltersForDb({
        query: "renewal notice",
        fromEmail: "Billing@Example.com",
        readState: "unread",
      }),
    ).toEqual({
      text: "renewal notice",
      from: "billing@example.com",
      read: false,
    });
  });

  it("falls back to the provider for a category or folder scope", () => {
    expect(
      buildOutlookFiltersForDb({ query: "invoice", categoryName: "Receipts" }),
    ).toBeNull();
  });

  it("falls back when there is nothing to filter on", () => {
    expect(buildOutlookFiltersForDb({ query: "   " })).toBeNull();
  });

  it("falls back for a sender that is not an exact address", () => {
    expect(buildOutlookFiltersForDb({ fromEmail: "stripe" })).toBeNull();
  });
});
