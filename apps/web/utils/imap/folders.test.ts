import { describe, expect, it } from "vitest";
import { pickSpecialFolder, type ImapFolderInfo } from "./folders";

function folder(
  path: string,
  specialUse?: string,
  delimiter = "/",
): ImapFolderInfo {
  const name = path.split(delimiter).at(-1) ?? path;
  return { path, name, delimiter, specialUse };
}

describe("pickSpecialFolder", () => {
  it("prefers SPECIAL-USE flags over names", () => {
    const folders = [folder("Sent", undefined), folder("Elküldött", "\\Sent")];
    expect(pickSpecialFolder(folders, "sent")?.path).toBe("Elküldött");
  });

  it("falls back to common names at the top level", () => {
    const folders = [folder("INBOX"), folder("Sent Items")];
    expect(pickSpecialFolder(folders, "sent")?.path).toBe("Sent Items");
  });

  it("finds folders nested under INBOX with the server delimiter", () => {
    const folders = [
      folder("INBOX", undefined, "."),
      folder("INBOX.Trash", undefined, "."),
    ];
    expect(pickSpecialFolder(folders, "trash")?.path).toBe("INBOX.Trash");
  });

  it("matches names case-insensitively", () => {
    const folders = [folder("INBOX"), folder("spam")];
    expect(pickSpecialFolder(folders, "junk")?.path).toBe("spam");
  });

  it("returns null when nothing matches", () => {
    expect(pickSpecialFolder([folder("INBOX")], "archive")).toBeNull();
  });
});
