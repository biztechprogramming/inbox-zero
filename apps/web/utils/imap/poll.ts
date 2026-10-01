import type { Logger } from "@/utils/logger";
import type { ParsedMessage } from "@/utils/types";
import { getImapAccountConfig, ImapSession } from "@/utils/imap/client";
import { listImapFolders, pickSpecialFolder } from "@/utils/imap/folders";
import {
  syncFolderFlagChanges,
  syncFolderNewMessages,
} from "@/utils/imap/sync";

const MAX_MESSAGES_PER_FOLDER = 25;

/**
 * Fetches mail that arrived since the last poll in INBOX and Sent (Sent feeds
 * outbound handling: reply tracking and draft cleanup), and refreshes read
 * state for recent inbox mail. Opens its own IMAP connection and closes it.
 */
export async function pollImapAccount({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}): Promise<{ newMessages: ParsedMessage[] }> {
  const config = await getImapAccountConfig({ emailAccountId });
  const session = new ImapSession(config, logger);

  try {
    const client = await session.getClient();
    const folders = await listImapFolders(client);
    const sent = pickSpecialFolder(folders, "sent");

    const newMessages: ParsedMessage[] = [];

    const inboxSync = await syncFolderNewMessages({
      client,
      emailAccountId,
      folderPath: "INBOX",
      specialUse: "\\Inbox",
      logger,
      maxMessages: MAX_MESSAGES_PER_FOLDER,
    });
    newMessages.push(...inboxSync.messages);

    if (sent) {
      const sentSync = await syncFolderNewMessages({
        client,
        emailAccountId,
        folderPath: sent.path,
        specialUse: "\\Sent",
        logger,
        maxMessages: MAX_MESSAGES_PER_FOLDER,
      });
      newMessages.push(...sentSync.messages);
    }

    await syncFolderFlagChanges({
      client,
      emailAccountId,
      folderPath: "INBOX",
      logger,
    });

    return { newMessages };
  } finally {
    await session.close();
  }
}
