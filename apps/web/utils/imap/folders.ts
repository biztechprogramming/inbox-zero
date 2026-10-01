import type { ImapFlow, ListResponse } from "imapflow";

export type SpecialFolderKind =
  | "sent"
  | "trash"
  | "archive"
  | "junk"
  | "drafts";

export type ImapFolderInfo = Pick<
  ListResponse,
  "path" | "name" | "delimiter" | "specialUse"
>;

const SPECIAL_FOLDERS: Record<
  SpecialFolderKind,
  { use: string; names: string[] }
> = {
  sent: {
    use: "\\Sent",
    names: ["Sent", "Sent Messages", "Sent Items", "Sent Mail"],
  },
  trash: {
    use: "\\Trash",
    names: ["Trash", "Deleted Items", "Deleted Messages", "Deleted"],
  },
  archive: { use: "\\Archive", names: ["Archive", "Archives"] },
  junk: { use: "\\Junk", names: ["Junk", "Spam", "Junk Mail", "Junk E-mail"] },
  drafts: { use: "\\Drafts", names: ["Drafts", "Draft"] },
};

export async function listImapFolders(
  client: ImapFlow,
): Promise<ImapFolderInfo[]> {
  return client.list();
}

/**
 * Finds a special folder by SPECIAL-USE flag, falling back to common names
 * (matched on the folder name or full path, either at the top level or one
 * level under INBOX).
 */
export function pickSpecialFolder(
  folders: ImapFolderInfo[],
  kind: SpecialFolderKind,
): ImapFolderInfo | null {
  const { use, names } = SPECIAL_FOLDERS[kind];

  const bySpecialUse = folders.find((folder) => folder.specialUse === use);
  if (bySpecialUse) return bySpecialUse;

  for (const name of names) {
    const lower = name.toLowerCase();
    const match = folders.find((folder) => {
      const folderName = folder.name.toLowerCase();
      const path = folder.path.toLowerCase();
      return (
        folderName === lower ||
        path === lower ||
        path === `inbox${folder.delimiter}${lower}`
      );
    });
    if (match) return match;
  }

  return null;
}

export async function resolveSpecialFolder(
  client: ImapFlow,
  kind: SpecialFolderKind,
): Promise<ImapFolderInfo | null> {
  return pickSpecialFolder(await listImapFolders(client), kind);
}

/**
 * Like resolveSpecialFolder, but creates the folder when the server has none
 * (only sensible for archive: Sent/Trash/Junk/Drafts exist on any real server).
 */
export async function resolveOrCreateSpecialFolder(
  client: ImapFlow,
  kind: SpecialFolderKind,
  createAs: string,
): Promise<string> {
  const existing = await resolveSpecialFolder(client, kind);
  if (existing) return existing.path;
  await client.mailboxCreate(createAs);
  return createAs;
}

export async function getOrCreateFolderByName(
  client: ImapFlow,
  name: string,
): Promise<string> {
  const folders = await listImapFolders(client);
  const lower = name.toLowerCase();
  const existing = folders.find(
    (folder) =>
      folder.path.toLowerCase() === lower ||
      folder.name.toLowerCase() === lower,
  );
  if (existing) return existing.path;
  await client.mailboxCreate(name);
  return name;
}
