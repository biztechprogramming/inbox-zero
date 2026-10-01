import { Readable } from "node:stream";
import { simpleParser } from "mailparser";
import type { ImapFlow, SearchObject } from "imapflow";
import type { Attachment as MailAttachment } from "nodemailer/lib/mailer";
import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";
import { createScopedLogger } from "@/utils/logger";
import type { ParsedMessage } from "@/utils/types";
import type { SendEmailBody } from "@/utils/types/mail";
import type { EmailContact } from "@/utils/email/contact";
import type { InboxZeroLabel } from "@/utils/label";
import { inboxZeroLabels } from "@/utils/label";
import type { ThreadsQuery } from "@/utils/threads/validation";
import type { OutlookFolder } from "@/utils/outlook/folders";
import type { LocalMailSyncRequest } from "@/utils/actions/local-mail-sync.validation";
import type { LocalMailSyncResponse } from "@/utils/email/local-mail-sync-types";
import type {
  BulkArchiveResult,
  BulkArchiveThread,
  EmailFilter,
  EmailFolderCount,
  EmailLabel,
  EmailLabelUpdate,
  EmailProvider,
  EmailSignature,
  EmailThread,
  GetThreadOptions,
  MailboxSyncPage,
  SentMessagePage,
} from "@/utils/email/types";
import {
  ImapSession,
  withMailbox,
  type ImapAccountConfig,
} from "@/utils/imap/client";
import {
  listImapFolders,
  pickSpecialFolder,
  getOrCreateFolderByName,
  type ImapFolderInfo,
  type SpecialFolderKind,
} from "@/utils/imap/folders";
import { normalizeMessageId } from "@/utils/imap/message-id";
import { ingestImapMessage } from "@/utils/imap/sync";
import { attachmentIdFor, ImapSystemLabel } from "@/utils/imap/parse";

const MAX_SOURCE_BYTES = 1024 * 1024;
const DEFAULT_PAGE_SIZE = 20;

export class ImapProvider implements EmailProvider {
  readonly name = "imap";
  readonly localMailSyncStrategy = "folder-delta" as const;

  private readonly session: ImapSession;
  private readonly emailAccountId: string;
  private readonly logger: Logger;
  private folderCache: ImapFolderInfo[] | null = null;

  constructor(
    config: ImapAccountConfig,
    emailAccountId: string,
    logger?: Logger,
  ) {
    this.emailAccountId = emailAccountId;
    this.logger = logger || createScopedLogger("email-provider-imap");
    this.session = new ImapSession(config, this.logger);
  }

  // --- messages ---

  async getMessage(messageId: string): Promise<ParsedMessage> {
    const message = await this.getMessageOrNull(messageId);
    if (!message) throw new Error(`Message not found: ${messageId}`);
    return message;
  }

  async getMessageByRfc822MessageId(
    rfc822MessageId: string,
  ): Promise<ParsedMessage | null> {
    const id = normalizeMessageId(rfc822MessageId);
    if (!id) return null;
    return this.getMessageOrNull(id);
  }

  async getMessagesBatch(messageIds: string[]): Promise<ParsedMessage[]> {
    const messages: ParsedMessage[] = [];
    for (const messageId of messageIds) {
      const message = await this.getMessageOrNull(messageId);
      if (message) messages.push(message);
    }
    return messages;
  }

  async getOriginalMessage(
    originalMessageId: string | undefined,
  ): Promise<ParsedMessage | null> {
    if (!originalMessageId) return null;
    return this.getMessageOrNull(originalMessageId);
  }

  async getPreviousConversationMessages(
    messageIds: string[],
  ): Promise<ParsedMessage[]> {
    return this.getMessagesBatch(messageIds);
  }

  async getInboxMessages(maxResults?: number): Promise<ParsedMessage[]> {
    const { messages } = await this.listMessages({
      folderPath: "INBOX",
      maxResults: maxResults ?? DEFAULT_PAGE_SIZE,
    });
    return messages;
  }

  async getMessagesWithPagination(options: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
    before?: Date;
    after?: Date;
    inboxOnly?: boolean;
    unreadOnly?: boolean;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    return this.listMessages({
      folderPath: "INBOX",
      criteria: {
        ...(options.query ? { text: options.query } : {}),
        ...(options.after ? { since: options.after } : {}),
        ...(options.before ? { before: options.before } : {}),
        ...(options.unreadOnly ? { seen: false } : {}),
      },
      maxResults: options.maxResults,
      pageToken: options.pageToken,
    });
  }

  async getMessagesFromSender(options: {
    senderEmail: string;
    maxResults?: number;
    pageToken?: string;
    before?: Date;
    after?: Date;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    return this.listMessages({
      folderPath: "INBOX",
      criteria: {
        from: options.senderEmail,
        ...(options.after ? { since: options.after } : {}),
        ...(options.before ? { before: options.before } : {}),
      },
      maxResults: options.maxResults,
      pageToken: options.pageToken,
    });
  }

  async getMessagesWithAttachments(options: {
    maxResults?: number;
    pageToken?: string;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    // IMAP SEARCH cannot filter on attachments; filter after fetching.
    const { messages, nextPageToken } = await this.listMessages({
      folderPath: "INBOX",
      maxResults: options.maxResults,
      pageToken: options.pageToken,
    });
    return {
      messages: messages.filter((message) => message.attachments?.length),
      nextPageToken,
    };
  }

  async searchMessages(options: {
    query: string;
    maxResults?: number;
    pageToken?: string;
    fromEmail?: string;
    readState?: "read" | "unread";
    labelName?: string;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    let folderPath = "INBOX";
    if (options.labelName) {
      const label = await this.getLabelByName(options.labelName);
      if (label) folderPath = label.id;
    }
    return this.listMessages({
      folderPath,
      criteria: {
        ...(options.query ? { text: options.query } : {}),
        ...(options.fromEmail ? { from: options.fromEmail } : {}),
        ...(options.readState ? { seen: options.readState === "read" } : {}),
      },
      maxResults: options.maxResults,
      pageToken: options.pageToken,
    });
  }

  // --- threads ---

  async getThread(
    threadId: string,
    options?: GetThreadOptions,
  ): Promise<EmailThread> {
    const messages = await this.fetchThreadMessages(threadId);
    const filtered = options?.includeDrafts
      ? messages
      : messages.filter(
          (message) => !message.labelIds?.includes(ImapSystemLabel.DRAFT),
        );
    return {
      id: threadId,
      messages: filtered,
      snippet: filtered.at(-1)?.snippet ?? "",
    };
  }

  async getThreadMessages(threadId: string): Promise<ParsedMessage[]> {
    return (await this.getThread(threadId)).messages;
  }

  async getThreadMessagesInInbox(threadId: string): Promise<ParsedMessage[]> {
    const messages = await this.getThreadMessages(threadId);
    return messages.filter((message) =>
      message.labelIds?.includes(ImapSystemLabel.INBOX),
    );
  }

  async getLatestMessageInThread(
    threadId: string,
  ): Promise<ParsedMessage | null> {
    const messages = await this.getThreadMessages(threadId);
    return messages.at(-1) ?? null;
  }

  async getLatestMessageFromThreadSnapshot(
    thread: Pick<EmailThread, "id" | "messages">,
  ): Promise<ParsedMessage | null> {
    const latest = thread.messages.at(-1);
    if (!latest) return this.getLatestMessageInThread(thread.id);
    return latest;
  }

  async getThreads(folderId?: string): Promise<EmailThread[]> {
    const { messages } = await this.listMessages({
      folderPath: folderId || "INBOX",
      maxResults: 50,
    });
    return groupIntoThreads(messages);
  }

  async getThreadsWithQuery(options: {
    query?: ThreadsQuery;
    maxResults?: number;
    pageToken?: string;
    messageFormat?: "full" | "metadata";
  }): Promise<{ threads: EmailThread[]; nextPageToken?: string }> {
    const query = options.query;
    const folderPath = await this.resolveQueryFolder(query);
    const { messages, nextPageToken } = await this.listMessages({
      folderPath,
      criteria: {
        ...(query?.q ? { text: query.q } : {}),
        ...(query?.fromEmail ? { from: query.fromEmail } : {}),
        ...(query?.after ? { since: query.after } : {}),
        ...(query?.before ? { before: query.before } : {}),
        ...(query?.isUnread ? { seen: false } : {}),
        ...(query?.type === "starred" ? { flagged: true } : {}),
      },
      maxResults: options.maxResults,
      pageToken: options.pageToken,
    });
    return { threads: groupIntoThreads(messages), nextPageToken };
  }

  async searchThreads(options: {
    query: string;
    maxResults?: number;
    pageToken?: string;
    messageFormat?: "full" | "metadata";
  }): Promise<{ threads: EmailThread[]; nextPageToken?: string }> {
    // ponytail: searches INBOX only; cross-folder search needs one SEARCH per
    // folder, which is the upgrade when "whole mailbox" search matters.
    const { messages, nextPageToken } = await this.listMessages({
      folderPath: "INBOX",
      criteria: { text: options.query },
      maxResults: options.maxResults,
      pageToken: options.pageToken,
    });
    return { threads: groupIntoThreads(messages), nextPageToken };
  }

  async getThreadsWithLabel(options: {
    labelId: string;
    maxResults?: number;
  }): Promise<EmailThread[]> {
    const { messages } = await this.listMessages({
      folderPath: options.labelId,
      maxResults: options.maxResults,
    });
    return groupIntoThreads(messages);
  }

  async getThreadsWithParticipant(options: {
    participantEmail: string;
    maxThreads?: number;
  }): Promise<EmailThread[]> {
    const { messages } = await this.listMessages({
      folderPath: "INBOX",
      criteria: {
        or: [
          { from: options.participantEmail },
          { to: options.participantEmail },
        ],
      },
      maxResults: options.maxThreads,
    });
    return groupIntoThreads(messages);
  }

  async getThreadsFromSenderWithSubject(
    sender: string,
    limit: number,
  ): Promise<Array<{ id: string; snippet: string; subject: string }>> {
    const { messages } = await this.listMessages({
      folderPath: "INBOX",
      criteria: { from: sender },
      maxResults: limit,
    });
    return groupIntoThreads(messages).map((thread) => ({
      id: thread.id,
      snippet: thread.snippet,
      subject: thread.messages.at(-1)?.subject ?? "",
    }));
  }

  isReplyInThread(message: ParsedMessage): boolean {
    return Boolean(
      message.headers["in-reply-to"] || message.headers.references,
    );
  }

  isSentMessage(message: ParsedMessage): boolean {
    return message.labelIds?.includes(ImapSystemLabel.SENT) || false;
  }

  // --- sent mail ---

  async getSentMessages(maxResults?: number): Promise<ParsedMessage[]> {
    const sent = await this.requireSpecialFolder("sent");
    const { messages } = await this.listMessages({
      folderPath: sent,
      maxResults: maxResults ?? DEFAULT_PAGE_SIZE,
    });
    return messages;
  }

  async getSentMessageIds(options: {
    maxResults: number;
    after?: Date;
    before?: Date;
    pageToken?: string;
  }): Promise<SentMessagePage> {
    const sent = await this.requireSpecialFolder("sent");
    const { messages, nextPageToken } = await this.listMessages({
      folderPath: sent,
      criteria: {
        ...(options.after ? { since: options.after } : {}),
        ...(options.before ? { before: options.before } : {}),
      },
      maxResults: options.maxResults,
      pageToken: options.pageToken,
    });
    return {
      messages: messages.map((message) => ({
        id: message.id,
        threadId: message.threadId,
      })),
      nextPageToken,
    };
  }

  async getSentThreadsExcluding(options: {
    excludeToEmails?: string[];
    excludeFromEmails?: string[];
    maxResults?: number;
  }): Promise<EmailThread[]> {
    const sent = await this.requireSpecialFolder("sent");
    const { messages } = await this.listMessages({
      folderPath: sent,
      maxResults: options.maxResults,
    });
    const excludeTo = (options.excludeToEmails ?? []).map((e) =>
      e.toLowerCase(),
    );
    const excludeFrom = (options.excludeFromEmails ?? []).map((e) =>
      e.toLowerCase(),
    );
    const filtered = messages.filter((message) => {
      const to = message.headers.to.toLowerCase();
      const from = message.headers.from.toLowerCase();
      if (excludeTo.some((email) => to.includes(email))) return false;
      if (excludeFrom.some((email) => from.includes(email))) return false;
      return true;
    });
    return groupIntoThreads(filtered);
  }

  async checkIfReplySent(senderEmail: string): Promise<boolean> {
    const sent = await this.requireSpecialFolder("sent");
    const uids = await this.searchFolderUids(sent, { to: senderEmail });
    return uids.length > 0;
  }

  async countReceivedMessages(
    senderEmail: string,
    threshold: number,
  ): Promise<number> {
    const uids = await this.searchFolderUids("INBOX", { from: senderEmail });
    return Math.min(uids.length, threshold);
  }

  async hasPreviousCommunicationsWithSenderOrDomain(options: {
    from: string;
    date: Date;
    messageId: string;
  }): Promise<boolean> {
    const uids = await this.searchFolderUids("INBOX", {
      from: options.from,
      before: options.date,
    });
    if (!uids.length) return false;
    if (uids.length > 1) return true;
    // A single hit may be the message itself.
    const row = await prisma.imapMessage.findUnique({
      where: {
        emailAccountId_messageIdHeader: {
          emailAccountId: this.emailAccountId,
          messageIdHeader: options.messageId,
        },
      },
      select: { uid: true, folderPath: true },
    });
    return !(row?.folderPath === "INBOX" && row.uid === BigInt(uids[0]));
  }

  // --- labels (= IMAP folders) ---

  async getLabels(): Promise<EmailLabel[]> {
    const folders = await this.listFolders();
    return folders
      .filter((folder) => !isNoSelect(folder))
      .map((folder) => folderToLabel(folder));
  }

  async getLabelById(labelId: string): Promise<EmailLabel | null> {
    const folders = await this.listFolders();
    const folder = folders.find((entry) => entry.path === labelId);
    return folder ? folderToLabel(folder) : null;
  }

  async getLabelByName(name: string): Promise<EmailLabel | null> {
    const folders = await this.listFolders();
    const lower = name.toLowerCase();
    const folder = folders.find(
      (entry) =>
        entry.path.toLowerCase() === lower ||
        entry.name.toLowerCase() === lower,
    );
    return folder ? folderToLabel(folder) : null;
  }

  async createLabel(name: string): Promise<EmailLabel> {
    const client = await this.client();
    const path = await getOrCreateFolderByName(client, name);
    this.folderCache = null;
    return { id: path, name: path, type: "user" };
  }

  async updateLabel(labelId: string, update: EmailLabelUpdate): Promise<void> {
    if (!update.name || update.name === labelId) return;
    const client = await this.client();
    await client.mailboxRename(labelId, update.name);
    this.folderCache = null;
  }

  async deleteLabel(labelId: string): Promise<void> {
    const client = await this.client();
    await client.mailboxDelete(labelId);
    this.folderCache = null;
  }

  async getOrCreateInboxZeroLabel(key: InboxZeroLabel): Promise<EmailLabel> {
    const name = inboxZeroLabels[key].name;
    const client = await this.client();
    const folders = await this.listFolders();
    const existing = folders.find(
      (folder) =>
        folder.path.split(folder.delimiter).join("/").toLowerCase() ===
        name.toLowerCase(),
    );
    if (existing) return folderToLabel(existing);
    const created = await client.mailboxCreate(name.split("/"));
    this.folderCache = null;
    return { id: created.path, name, type: "user" };
  }

  async getOrCreateFolderIdByName(folderName: string): Promise<string> {
    const client = await this.client();
    const path = await getOrCreateFolderByName(client, folderName);
    this.folderCache = null;
    return path;
  }

  async getFolders(): Promise<OutlookFolder[]> {
    const folders = await this.listFolders();
    return folders
      .filter((folder) => !isNoSelect(folder))
      .map((folder) => ({
        id: folder.path,
        displayName: folder.name,
        childFolders: [],
      }));
  }

  async getFolderCounts(): Promise<EmailFolderCount[]> {
    const client = await this.client();
    const folders = await client.list({
      statusQuery: { messages: true, unseen: true },
    });
    return folders
      .filter((folder) => !isNoSelect(folder))
      .map((folder) => ({
        id: folder.path,
        name: folder.name,
        total: folder.status?.messages ?? 0,
        unread: folder.status?.unseen ?? 0,
      }));
  }

  async renameFolder(folderId: string, name: string): Promise<void> {
    await this.updateLabel(folderId, { name });
  }

  async deleteFolder(folderId: string): Promise<void> {
    await this.deleteLabel(folderId);
  }

  async getInboxStats(): Promise<{ total: number; unread: number }> {
    const client = await this.client();
    const status = await client.status("INBOX", {
      messages: true,
      unseen: true,
    });
    if (!status) return { total: 0, unread: 0 };
    return { total: status.messages ?? 0, unread: status.unseen ?? 0 };
  }

  // --- drafts (read) ---

  async getDrafts(options?: { maxResults?: number }): Promise<ParsedMessage[]> {
    const drafts = await this.specialFolder("drafts");
    if (!drafts) return [];
    const { messages } = await this.listMessages({
      folderPath: drafts,
      maxResults: options?.maxResults,
    });
    return messages;
  }

  async getDraft(draftId: string): Promise<ParsedMessage | null> {
    return this.getMessageOrNull(draftId);
  }

  async getDraftReferenceForMessage(): Promise<null> {
    // IMAP drafts are plain messages in the Drafts folder with no link to the
    // message they reply to.
    return null;
  }

  // --- attachments ---

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: string; size: number }> {
    const attachment = await this.findAttachment(messageId, attachmentId);
    return {
      data: attachment.content.toString("base64"),
      size: attachment.content.length,
    };
  }

  async getAttachmentStream(
    messageId: string,
    attachmentId: string,
  ): Promise<ReadableStream<Uint8Array>> {
    const attachment = await this.findAttachment(messageId, attachmentId);
    return Readable.toWeb(
      Readable.from(attachment.content),
    ) as ReadableStream<Uint8Array>;
  }

  // --- honest no-ops (no IMAP equivalent) ---

  async getSignatures(): Promise<EmailSignature[]> {
    return [];
  }

  async searchContacts(): Promise<EmailContact[]> {
    return [];
  }

  async getFiltersList(): Promise<EmailFilter[]> {
    return [];
  }

  async createFilter(): Promise<{ status: number }> {
    return { status: 501 };
  }

  async createAutoArchiveFilter(): Promise<{ status: number }> {
    return { status: 501 };
  }

  async deleteFilter(): Promise<{ status: number }> {
    return { status: 501 };
  }

  async watchEmails(): Promise<null> {
    // IMAP has no push notifications; the imap-poll cron covers new mail.
    return null;
  }

  async unwatchEmails(): Promise<void> {}

  getAccessToken(): string {
    throw new Error("IMAP accounts do not use OAuth access tokens");
  }

  toJSON() {
    return { name: "imap", type: "imap" };
  }

  // --- sync surfaces ---

  async syncLocalMail(
    _request: LocalMailSyncRequest,
    _context: { emailAccountId: string },
  ): Promise<LocalMailSyncResponse> {
    // Desktop local mail mirroring for IMAP is a follow-up; the client treats
    // "unsupported" as a clean skip.
    return { status: "unsupported", strategy: this.localMailSyncStrategy };
  }

  async getMailboxSyncPage(): Promise<MailboxSyncPage> {
    throw new Error("Mailbox sync is not yet available for IMAP accounts");
  }

  // --- write path (phase 4) ---

  async archiveMessage(): Promise<void> {
    this.notYetSupported("archiveMessage");
  }
  async archiveMessages(): Promise<void> {
    this.notYetSupported("archiveMessages");
  }
  async archiveThread(): Promise<void> {
    this.notYetSupported("archiveThread");
  }
  async archiveThreadWithLabel(): Promise<void> {
    this.notYetSupported("archiveThreadWithLabel");
  }
  async blockUnsubscribedEmail(): Promise<void> {
    this.notYetSupported("blockUnsubscribedEmail");
  }
  async bulkArchiveFromSenders(): Promise<void> {
    this.notYetSupported("bulkArchiveFromSenders");
  }
  async bulkArchiveThreads(
    _threads: BulkArchiveThread[],
  ): Promise<BulkArchiveResult> {
    return this.notYetSupported("bulkArchiveThreads");
  }
  async bulkTrashFromSenders(): Promise<void> {
    this.notYetSupported("bulkTrashFromSenders");
  }
  async createDraft(): Promise<{ id: string }> {
    return this.notYetSupported("createDraft");
  }
  async deleteDraft(): Promise<boolean> {
    return this.notYetSupported("deleteDraft");
  }
  async draftEmail(
    _email: ParsedMessage,
    _args: { content: string; attachments?: MailAttachment[] },
  ): Promise<{ draftId: string }> {
    return this.notYetSupported("draftEmail");
  }
  async forwardEmail(): Promise<{ messageId: string }> {
    return this.notYetSupported("forwardEmail");
  }
  async labelMessage(): Promise<{
    usedFallback?: boolean;
    actualLabelId?: string;
  }> {
    return this.notYetSupported("labelMessage");
  }
  async markMessagesReadState(): Promise<void> {
    this.notYetSupported("markMessagesReadState");
  }
  async markMessagesStarredState(): Promise<void> {
    this.notYetSupported("markMessagesStarredState");
  }
  async markRead(): Promise<void> {
    this.notYetSupported("markRead");
  }
  async markReadThread(): Promise<void> {
    this.notYetSupported("markReadThread");
  }
  async markSpam(): Promise<void> {
    this.notYetSupported("markSpam");
  }
  async moveThreadToFolder(): Promise<void> {
    this.notYetSupported("moveThreadToFolder");
  }
  async removeThreadLabel(): Promise<void> {
    this.notYetSupported("removeThreadLabel");
  }
  async removeThreadLabels(): Promise<void> {
    this.notYetSupported("removeThreadLabels");
  }
  async replyToEmail(): Promise<{ messageId: string }> {
    return this.notYetSupported("replyToEmail");
  }
  async sendDraft(): Promise<{ messageId: string; threadId: string }> {
    return this.notYetSupported("sendDraft");
  }
  async sendEmail(): Promise<{ messageId: string }> {
    return this.notYetSupported("sendEmail");
  }
  async sendEmailWithHtml(
    _body: SendEmailBody,
  ): Promise<{ messageId: string; threadId: string }> {
    return this.notYetSupported("sendEmailWithHtml");
  }
  async starMessage(): Promise<void> {
    this.notYetSupported("starMessage");
  }
  async trashMessages(): Promise<void> {
    this.notYetSupported("trashMessages");
  }
  async trashThread(): Promise<void> {
    this.notYetSupported("trashThread");
  }
  async unarchiveMessages(): Promise<void> {
    this.notYetSupported("unarchiveMessages");
  }
  async unarchiveThread(): Promise<void> {
    this.notYetSupported("unarchiveThread");
  }
  async untrashMessages(): Promise<void> {
    this.notYetSupported("untrashMessages");
  }
  async untrashThread(): Promise<void> {
    this.notYetSupported("untrashThread");
  }
  async updateDraft(): Promise<void> {
    this.notYetSupported("updateDraft");
  }

  // --- internals ---

  private notYetSupported(method: string): never {
    throw new Error(`${method} is not yet supported for IMAP accounts`);
  }

  private async client(): Promise<ImapFlow> {
    return this.session.getClient();
  }

  private async listFolders(): Promise<ImapFolderInfo[]> {
    if (this.folderCache) return this.folderCache;
    const client = await this.client();
    this.folderCache = await listImapFolders(client);
    return this.folderCache;
  }

  private async specialFolder(kind: SpecialFolderKind): Promise<string | null> {
    const folders = await this.listFolders();
    return pickSpecialFolder(folders, kind)?.path ?? null;
  }

  private async requireSpecialFolder(kind: SpecialFolderKind): Promise<string> {
    const path = await this.specialFolder(kind);
    if (!path) throw new Error(`No ${kind} folder found on the IMAP server`);
    return path;
  }

  private async resolveQueryFolder(query?: ThreadsQuery): Promise<string> {
    if (query?.folderId) return query.folderId;
    if (query?.labelId && query.labelId.toUpperCase() !== "INBOX") {
      return query.labelId;
    }
    switch (query?.type) {
      case "sent":
        return this.requireSpecialFolder("sent");
      case "archive":
        return (await this.specialFolder("archive")) ?? "INBOX";
      case "draft":
        return (await this.specialFolder("drafts")) ?? "INBOX";
      case "trash":
        return (await this.specialFolder("trash")) ?? "INBOX";
      case "spam":
        return (await this.specialFolder("junk")) ?? "INBOX";
      default:
        return "INBOX";
    }
  }

  private async searchFolderUids(
    folderPath: string,
    criteria: SearchObject,
  ): Promise<number[]> {
    const client = await this.client();
    return withMailbox(client, folderPath, async () => {
      const uids = await client.search(criteria, { uid: true });
      return uids || [];
    });
  }

  /**
   * Lists messages in one folder, newest first, paged by UID. The pageToken is
   * the lowest UID of the previous page.
   */
  private async listMessages({
    folderPath,
    criteria,
    maxResults,
    pageToken,
  }: {
    folderPath: string;
    criteria?: SearchObject;
    maxResults?: number | null;
    pageToken?: string | null;
  }): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    const limit = maxResults ?? DEFAULT_PAGE_SIZE;
    const client = await this.client();

    return withMailbox(client, folderPath, async () => {
      const specialUse = client.mailbox ? client.mailbox.specialUse : undefined;
      const uidValidity = client.mailbox
        ? client.mailbox.uidValidity
        : BigInt(0);

      const found = await client.search(
        criteria && Object.keys(criteria).length ? criteria : { all: true },
        { uid: true },
      );
      let uids = (found || []).sort((a, b) => b - a);
      if (pageToken) {
        const beforeUid = Number(pageToken);
        if (Number.isFinite(beforeUid)) {
          uids = uids.filter((uid) => uid < beforeUid);
        }
      }
      const page = uids.slice(0, limit);
      if (!page.length) return { messages: [] };

      const messages: ParsedMessage[] = [];
      for await (const fetched of client.fetch(
        { uid: page.join(",") },
        {
          uid: true,
          flags: true,
          internalDate: true,
          source: { maxLength: MAX_SOURCE_BYTES },
        },
        { uid: true },
      )) {
        if (!fetched.source) continue;
        try {
          messages.push(
            await ingestImapMessage({
              emailAccountId: this.emailAccountId,
              source: fetched.source,
              uid: BigInt(fetched.uid),
              flags: [...(fetched.flags ?? [])],
              internalDate: fetched.internalDate
                ? new Date(fetched.internalDate)
                : new Date(),
              folderPath,
              specialUse,
              uidValidity,
            }),
          );
        } catch (error) {
          this.logger.error("Failed to parse IMAP message", {
            folderPath,
            uid: fetched.uid,
            error,
          });
        }
      }

      messages.sort(
        (a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0),
      );

      return {
        messages,
        nextPageToken:
          uids.length > page.length ? String(page[page.length - 1]) : undefined,
      };
    });
  }

  private async fetchThreadMessages(
    threadId: string,
  ): Promise<ParsedMessage[]> {
    const rows = await prisma.imapMessage.findMany({
      where: { emailAccountId: this.emailAccountId, threadId },
      orderBy: { internalDate: "asc" },
      take: 50,
      select: { messageIdHeader: true },
    });

    const ids = rows.length ? rows.map((row) => row.messageIdHeader) : null;
    const messages: ParsedMessage[] = [];
    // A thread id with no mapped rows is a lone message id (thread of one).
    for (const id of ids ?? [threadId]) {
      const message = await this.getMessageOrNull(id);
      if (message) messages.push(message);
    }
    messages.sort(
      (a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0),
    );
    return messages;
  }

  private async getMessageOrNull(
    messageId: string,
  ): Promise<ParsedMessage | null> {
    const row = await prisma.imapMessage.findUnique({
      where: {
        emailAccountId_messageIdHeader: {
          emailAccountId: this.emailAccountId,
          messageIdHeader: messageId,
        },
      },
      select: { folderPath: true, uid: true },
    });

    if (row) {
      const message = await this.fetchByLocation(
        row.folderPath,
        row.uid,
        messageId,
      );
      if (message) return message;
      // Stale location (moved/expunged behind our back): fall through to search.
    }

    return this.searchAndFetchByMessageId(messageId);
  }

  private async fetchByLocation(
    folderPath: string,
    uid: bigint,
    expectedMessageId: string,
  ): Promise<ParsedMessage | null> {
    const client = await this.client();
    try {
      return await withMailbox(client, folderPath, async () => {
        const specialUse = client.mailbox
          ? client.mailbox.specialUse
          : undefined;
        const uidValidity = client.mailbox
          ? client.mailbox.uidValidity
          : BigInt(0);
        const fetched = await client.fetchOne(
          String(uid),
          {
            uid: true,
            flags: true,
            internalDate: true,
            source: { maxLength: MAX_SOURCE_BYTES },
          },
          { uid: true },
        );
        if (!fetched) return null;
        if (!fetched.source) return null;
        // UID reuse after UIDVALIDITY change can return a different message.
        const parsed = await simpleParser(fetched.source);
        const parsedId = normalizeMessageId(parsed.messageId);
        if (parsedId && parsedId !== expectedMessageId) return null;

        return ingestImapMessage({
          emailAccountId: this.emailAccountId,
          source: fetched.source,
          uid: BigInt(fetched.uid),
          flags: [...(fetched.flags ?? [])],
          internalDate: fetched.internalDate
            ? new Date(fetched.internalDate)
            : new Date(),
          folderPath,
          specialUse,
          uidValidity,
        });
      });
    } catch (error) {
      this.logger.warn("IMAP fetch by location failed", {
        folderPath,
        error,
      });
      return null;
    }
  }

  /**
   * Finds a message by Message-ID header across the common folders. Bounded on
   * purpose: the ImapMessage map answers this for synced mail, so this path
   * only runs for ids from before the account was connected.
   */
  private async searchAndFetchByMessageId(
    messageId: string,
  ): Promise<ParsedMessage | null> {
    const candidates = ["INBOX"];
    for (const kind of ["sent", "archive", "trash", "drafts"] as const) {
      const path = await this.specialFolder(kind);
      if (path) candidates.push(path);
    }

    const client = await this.client();
    for (const folderPath of candidates) {
      const message = await withMailbox(client, folderPath, async () => {
        const uids = await client.search(
          { header: { "message-id": messageId } },
          { uid: true },
        );
        if (uids === false || uids === undefined || !uids.length) return null;
        return BigInt(uids[uids.length - 1]);
      });
      if (message !== null) {
        return this.fetchByLocation(folderPath, message, messageId);
      }
    }
    return null;
  }

  private async findAttachment(messageId: string, attachmentId: string) {
    const message = await this.getMessageRaw(messageId);
    const parsed = await simpleParser(message);
    const attachment = (parsed.attachments ?? []).find(
      (entry, index) => attachmentIdFor(entry, index) === attachmentId,
    );
    if (!attachment) {
      throw new Error(`Attachment not found: ${attachmentId}`);
    }
    return attachment;
  }

  private async getMessageRaw(messageId: string): Promise<Buffer> {
    const row = await prisma.imapMessage.findUnique({
      where: {
        emailAccountId_messageIdHeader: {
          emailAccountId: this.emailAccountId,
          messageIdHeader: messageId,
        },
      },
      select: { folderPath: true, uid: true },
    });
    if (!row) throw new Error(`Message not found: ${messageId}`);

    const client = await this.client();
    return withMailbox(client, row.folderPath, async () => {
      const fetched = await client.fetchOne(
        String(row.uid),
        { uid: true, source: true },
        { uid: true },
      );
      if (!fetched) throw new Error(`Message not found: ${messageId}`);
      if (!fetched.source) throw new Error(`Message not found: ${messageId}`);
      return fetched.source;
    });
  }
}

function groupIntoThreads(messages: ParsedMessage[]): EmailThread[] {
  const threads = new Map<string, ParsedMessage[]>();
  for (const message of messages) {
    const list = threads.get(message.threadId);
    if (list) list.push(message);
    else threads.set(message.threadId, [message]);
  }
  return [...threads.entries()].map(([id, threadMessages]) => {
    const sorted = [...threadMessages].sort(
      (a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0),
    );
    return { id, messages: sorted, snippet: sorted.at(-1)?.snippet ?? "" };
  });
}

function folderToLabel(folder: ImapFolderInfo): EmailLabel {
  return {
    id: folder.path,
    name: folder.path.split(folder.delimiter).join("/"),
    type:
      folder.specialUse || folder.path.toUpperCase() === "INBOX"
        ? "system"
        : "user",
  };
}

function isNoSelect(folder: ImapFolderInfo): boolean {
  const flags = (folder as { flags?: Set<string> }).flags;
  return flags?.has("\\Noselect") ?? false;
}
