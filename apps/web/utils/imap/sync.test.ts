import { describe, expect, it } from "vitest";
import { planUidFetch } from "./sync";

describe("planUidFetch", () => {
  it("records a baseline on first sync instead of backfilling history", () => {
    expect(planUidFetch({ stored: null, uidValidity: BigInt(5) })).toEqual({
      action: "baseline",
    });
  });

  it("resets when UIDVALIDITY changes", () => {
    expect(
      planUidFetch({
        stored: { uidValidity: BigInt(4), lastSeenUid: BigInt(80) },
        uidValidity: BigInt(5),
      }),
    ).toEqual({ action: "reset" });
  });

  it("fetches from the next unseen UID", () => {
    expect(
      planUidFetch({
        stored: { uidValidity: BigInt(5), lastSeenUid: BigInt(80) },
        uidValidity: BigInt(5),
      }),
    ).toEqual({ action: "fetch", fromUid: BigInt(81) });
  });
});
