import { Readable } from "node:stream";
import { simpleParser, type ParsedMail } from "mailparser";
import type { ImapFlow, SearchObject } from "imapflow";
import type Mail from "nodemailer/lib/mailer";
import type { Attachment as MailAttachment } from "nodemailer/lib/mailer";
import type { Transporter } from "nodemailer";
import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";
import { createScopedLogger } from "@/utils/logger";
import type { ParsedMessage } from "@/utils/types";
import { toMailerAttachments, type SendEmailBody } from "@/utils/types/mail";
import { convertEmailHtmlToText } from "@/utils/mail";
import { buildThreadingHeaders } from "@/utils/email/threading";
import { formatReplySubject } from "@/utils/email/subject";
// Generic MIME content builders that happen to live in the gmail module.
import { createReplyContent } from "@/utils/gmail/reply";
import {
  forwardEmailHtml,
  forwardEmailSubject,
  forwardEmailText,
} from "@/utils/gmail/forward";
import { shouldSkipAutoDraft } from "@/utils/auto-draft";
import { handlePreviousDraftDeletion } from "@/utils/ai/choose-rule/draft-management";
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
  resolveOrCreateSpecialFolder,
  type ImapFolderInfo,
  type SpecialFolderKind,
} from "@/utils/imap/folders";
import { normalizeMessageId } from "@/utils/imap/message-id";
import { ingestImapMessage } from "@/utils/imap/sync";
import { attachmentIdFor, ImapSystemLabel } from "@/utils/imap/parse";
import { buildMimeMessage, createSmtpTransport } from "@/utils/imap/smtp";

const MAX_SOURCE_BYTES = 1024 * 1024;
const DEFAULT_PAGE_SIZE = 20;

export class ImapProvider implements EmailProvider {
  readonly name = "imap";
  readonly localMailSyncStrategy = "folder-delta" as const;

  private readonly config: ImapAccountConfig;
  private readonly session: ImapSession;
  private readonly emailAccountId: string;
  private readonly logger: Logger;
  private folderCache: ImapFolderInfo[] | null = null;
  private transport: Transporter | null = null;

  constructor(
    config: ImapAccountConfig,
    emailAccountId: string,
    logger?: Logger,
  ) {
    this.config = config;
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

  // --- sending (SMTP + Sent copy) ---

  async sendEmail(args: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageText: string;
    attachments?: MailAttachment[];
  }): Promise<{ messageId: string }> {
    const { messageId } = await this.sendMime({
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      text: args.messageText,
      attachments: args.attachments,
    });
    return { messageId };
  }

  async sendEmailWithHtml(
    body: SendEmailBody,
  ): Promise<{ messageId: string; threadId: string }> {
    const result = await this.sendMime({
      from: body.from,
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      replyTo: body.replyTo,
      subject: body.subject,
      alternatives: [
        {
          contentType: "text/plain; charset=UTF-8",
          content: this.htmlToText(body.messageHtml),
        },
        {
          contentType: "text/html; charset=UTF-8",
          content: body.messageHtml,
        },
      ],
      attachments: toMailerAttachments(body.attachments),
      ...buildThreadingHeaders({
        headerMessageId: body.replyToEmail?.headerMessageId || "",
        references: body.replyToEmail?.references,
      }),
    });

    if (body.providerDraftId) {
      await this.deleteDraft(body.providerDraftId).catch((error) => {
        this.logger.warn("Failed to delete draft after send", { error });
      });
    }

    return result;
  }

  async replyToEmail(
    email: ParsedMessage,
    content: string,
    options?: {
      replyTo?: string;
      from?: string;
      attachments?: MailAttachment[];
    },
  ): Promise<{ messageId: string }> {
    const { html, text } = createReplyContent({
      textContent: content,
      message: email,
    });
    const { messageId } = await this.sendMime({
      from: options?.from,
      replyTo: options?.replyTo,
      to: email.headers["reply-to"] || email.headers.from,
      subject: formatReplySubject(email.headers.subject),
      alternatives: [
        { contentType: "text/plain; charset=UTF-8", content: text },
        { contentType: "text/html; charset=UTF-8", content: html },
      ],
      attachments: options?.attachments,
      ...buildThreadingHeaders({
        headerMessageId: email.headers["message-id"] || "",
        references: email.headers.references,
      }),
    });
    return { messageId };
  }

  async forwardEmail(
    email: ParsedMessage,
    args: {
      to: string;
      cc?: string;
      bcc?: string;
      content?: string;
      from?: string;
    },
  ): Promise<{ messageId: string }> {
    const { messageId } = await this.sendMime({
      from: args.from,
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: forwardEmailSubject(email.subject),
      alternatives: [
        {
          contentType: "text/plain; charset=UTF-8",
          content: forwardEmailText({
            content: args.content ?? "",
            message: email,
          }),
        },
        {
          contentType: "text/html; charset=UTF-8",
          content: forwardEmailHtml({
            content: args.content ?? "",
            message: email,
          }),
        },
      ],
      attachments: await this.originalAttachments(email.id),
    });
    return { messageId };
  }

  // --- drafts (write) ---

  async createDraft(params: {
    to: string;
    subject: string;
    messageHtml: string;
    replyToMessageId?: string;
  }): Promise<{ id: string }> {
    const original = params.replyToMessageId
      ? await this.getMessageOrNull(params.replyToMessageId)
      : null;
    const id = await this.appendDraft({
      to: params.to,
      subject: params.subject,
      html: params.messageHtml,
      ...(original
        ? buildThreadingHeaders({
            headerMessageId: original.headers["message-id"] || "",
            references: original.headers.references,
          })
        : {}),
    });
    return { id };
  }

  async draftEmail(
    email: ParsedMessage,
    args: {
      to?: string;
      subject?: string;
      content: string;
      cc?: string;
      bcc?: string;
      attachments?: MailAttachment[];
    },
    _userEmail: string,
    executedRule?: { id: string; threadId: string; emailAccountId: string },
  ): Promise<{ draftId: string }> {
    if (shouldSkipAutoDraft({ logger: this.logger, source: "imap" })) {
      return { draftId: "" };
    }

    const { html, text } = createReplyContent({
      textContent: args.content,
      message: email,
    });
    const draftPromise = this.appendDraft({
      to: args.to || email.headers["reply-to"] || email.headers.from,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject || formatReplySubject(email.headers.subject),
      html,
      text,
      attachments: args.attachments,
      ...buildThreadingHeaders({
        headerMessageId: email.headers["message-id"] || "",
        references: email.headers.references,
      }),
    });

    if (executedRule) {
      const [draftId] = await Promise.all([
        draftPromise,
        handlePreviousDraftDeletion({
          client: this,
          executedRule,
          logger: this.logger,
        }),
      ]);
      return { draftId };
    }

    return { draftId: await draftPromise };
  }

  async updateDraft(
    draftId: string,
    params: {
      messageHtml?: string;
      subject?: string;
      to?: string;
      cc?: string;
      bcc?: string;
      attachments?: SendEmailBody["attachments"];
    },
  ): Promise<void> {
    const existing = await this.getDraft(draftId);
    if (!existing) throw new Error(`Draft not found: ${draftId}`);
    const row = await this.rowForMessage(draftId);
    if (!row) throw new Error(`Draft not found: ${draftId}`);

    // Remove the old copy first so the folder never holds two messages with
    // the same Message-ID; the id (and so the map row) stays stable.
    await this.deleteMessageAtLocation(row);
    await this.appendDraft({
      to: params.to ?? existing.headers.to,
      cc: params.cc ?? existing.headers.cc,
      bcc: params.bcc ?? existing.headers.bcc,
      subject: params.subject ?? existing.subject,
      html: params.messageHtml ?? existing.textHtml ?? existing.textPlain ?? "",
      attachments: toMailerAttachments(params.attachments),
      inReplyTo: existing.headers["in-reply-to"] || "",
      references: existing.headers.references || "",
      messageId: `<${draftId}>`,
    });
  }

  async deleteDraft(draftId: string, _version?: string): Promise<boolean> {
    const row = await this.rowForMessage(draftId);
    if (!row) return false;
    await this.deleteMessageAtLocation(row);
    await prisma.imapMessage.deleteMany({
      where: {
        emailAccountId: this.emailAccountId,
        messageIdHeader: draftId,
      },
    });
    return true;
  }

  async sendDraft(
    draftId: string,
  ): Promise<{ messageId: string; threadId: string }> {
    const row = await this.rowForMessage(draftId);
    if (!row) throw new Error(`Draft not found: ${draftId}`);
    const raw = await this.getMessageRaw(draftId);
    const parsed = await simpleParser(raw);

    await this.smtp().sendMail({
      envelope: envelopeFromParsed(parsed),
      raw,
    });

    const sent = await this.appendSentCopy(raw, draftId);
    await this.deleteMessageAtLocation(row).catch((error) => {
      this.logger.warn("Failed to remove sent draft from Drafts", { error });
    });

    return { messageId: draftId, threadId: sent?.threadId ?? draftId };
  }

  // --- flags ---

  async markRead(threadId: string): Promise<void> {
    await this.markReadThread(threadId, true);
  }

  async markReadThread(threadId: string, read: boolean): Promise<void> {
    await this.setFlagForRows(await this.rowsForThread(threadId), {
      flag: "\\Seen",
      add: read,
    });
  }

  async markMessagesReadState(
    messageIds: string[],
    read: boolean,
  ): Promise<void> {
    await this.setFlagForRows(await this.rowsForMessages(messageIds), {
      flag: "\\Seen",
      add: read,
    });
  }

  async markMessagesStarredState(
    messageIds: string[],
    starred: boolean,
  ): Promise<void> {
    await this.setFlagForRows(await this.rowsForMessages(messageIds), {
      flag: "\\Flagged",
      add: starred,
    });
  }

  async starMessage(messageId: string): Promise<void> {
    await this.markMessagesStarredState([messageId], true);
  }

  // --- moves (archive / trash / spam / labels-as-folders) ---

  async archiveMessage(messageId: string): Promise<void> {
    await this.archiveMessages([messageId]);
  }

  async archiveMessages(messageIds: string[], labelId?: string): Promise<void> {
    const rows = await this.rowsForMessages(messageIds);
    await this.moveRows(
      rows.filter((row) => row.folderPath === "INBOX"),
      labelId ?? (await this.archiveFolder()),
    );
  }

  async archiveThread(threadId: string, ownerEmail: string): Promise<void> {
    await this.archiveThreadWithLabel(threadId, ownerEmail);
  }

  async archiveThreadWithLabel(
    threadId: string,
    _ownerEmail: string,
    labelId?: string,
  ): Promise<void> {
    const rows = await this.rowsForThread(threadId);
    await this.moveRows(
      rows.filter((row) => row.folderPath === "INBOX"),
      labelId ?? (await this.archiveFolder()),
    );
  }

  async unarchiveMessages(messageIds: string[]): Promise<void> {
    const archive = await this.archiveFolder();
    const rows = await this.rowsForMessages(messageIds);
    await this.moveRows(
      rows.filter((row) => row.folderPath === archive),
      "INBOX",
    );
  }

  async unarchiveThread(threadId: string): Promise<void> {
    const archive = await this.archiveFolder();
    const rows = await this.rowsForThread(threadId);
    await this.moveRows(
      rows.filter((row) => row.folderPath === archive),
      "INBOX",
    );
  }

  async bulkArchiveThreads(
    threads: BulkArchiveThread[],
    ownerEmail: string,
  ): Promise<BulkArchiveResult> {
    const succeededThreadIds: string[] = [];
    const failedThreadIds: string[] = [];
    for (const thread of threads) {
      try {
        await this.archiveThread(thread.threadId, ownerEmail);
        succeededThreadIds.push(thread.threadId);
      } catch (error) {
        this.logger.warn("Failed to archive thread in bulk", {
          threadId: thread.threadId,
          error,
        });
        failedThreadIds.push(thread.threadId);
      }
    }
    return { succeededThreadIds, failedThreadIds };
  }

  async bulkArchiveFromSenders(
    fromEmails: string[],
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<void> {
    const archive = await this.archiveFolder();
    for (const sender of fromEmails) {
      await this.moveSearchedUids("INBOX", { from: sender }, archive);
    }
  }

  async bulkTrashFromSenders(
    fromEmails: string[],
    _ownerEmail: string,
    _emailAccountId: string,
  ): Promise<void> {
    const trash = await this.trashFolder();
    for (const sender of fromEmails) {
      await this.moveSearchedUids("INBOX", { from: sender }, trash);
    }
  }

  async trashMessages(messageIds: string[]): Promise<void> {
    const trash = await this.trashFolder();
    const rows = await this.rowsForMessages(messageIds);
    await this.moveRows(
      rows.filter((row) => row.folderPath !== trash),
      trash,
    );
  }

  async trashThread(
    threadId: string,
    _ownerEmail: string,
    _actionSource: "user" | "automation",
  ): Promise<void> {
    const trash = await this.trashFolder();
    const rows = await this.rowsForThread(threadId);
    await this.moveRows(
      rows.filter((row) => row.folderPath !== trash),
      trash,
    );
  }

  async untrashMessages(messageIds: string[]): Promise<void> {
    const trash = await this.trashFolder();
    const rows = await this.rowsForMessages(messageIds);
    await this.moveRows(
      rows.filter((row) => row.folderPath === trash),
      "INBOX",
    );
  }

  async untrashThread(threadId: string): Promise<void> {
    const trash = await this.trashFolder();
    const rows = await this.rowsForThread(threadId);
    await this.moveRows(
      rows.filter((row) => row.folderPath === trash),
      "INBOX",
    );
  }

  async markSpam(threadId: string): Promise<void> {
    const junk = await this.junkFolder();
    const rows = await this.rowsForThread(threadId);
    await this.moveRows(
      rows.filter((row) => row.folderPath === "INBOX"),
      junk,
    );
  }

  async moveThreadToFolder(
    threadId: string,
    _ownerEmail: string,
    folderName: string,
  ): Promise<void> {
    const target = await this.getOrCreateFolderIdByName(folderName);
    const rows = await this.rowsForThread(threadId);
    const keepOut = new Set(
      [
        await this.specialFolder("sent"),
        await this.specialFolder("drafts"),
        await this.specialFolder("trash"),
      ].filter(Boolean),
    );
    await this.moveRows(
      rows.filter((row) => !keepOut.has(row.folderPath)),
      target,
    );
  }

  async labelMessage(options: {
    messageId: string;
    labelId: string;
    labelName: string | null;
  }): Promise<{ usedFallback?: boolean; actualLabelId?: string }> {
    const row = await this.rowForMessage(options.messageId);
    if (!row) throw new Error(`Message not found: ${options.messageId}`);

    let target = options.labelId;
    let usedFallback = false;
    if (!(await this.getLabelById(target))) {
      target = await this.getOrCreateFolderIdByName(
        options.labelName || options.labelId,
      );
      usedFallback = true;
    }
    await this.moveRows([row], target);
    return { usedFallback, actualLabelId: target };
  }

  async removeThreadLabel(threadId: string, labelId: string): Promise<void> {
    const rows = await this.rowsForThread(threadId);
    await this.moveRows(
      rows.filter((row) => row.folderPath === labelId),
      "INBOX",
    );
  }

  async removeThreadLabels(
    threadId: string,
    labelIds: string[],
  ): Promise<void> {
    for (const labelId of labelIds) {
      await this.removeThreadLabel(threadId, labelId);
    }
  }

  async blockUnsubscribedEmail(messageId: string): Promise<void> {
    const row = await this.rowForMessage(messageId);
    if (!row) return;
    await this.setFlagForRows([row], { flag: "\\Seen", add: true });
    if (row.folderPath === "INBOX") {
      await this.moveRows([row], await this.archiveFolder());
    }
  }

  // --- internals ---

  private async client(): Promise<ImapFlow> {
    return this.session.getClient();
  }

  private smtp(): Transporter {
    if (!this.transport) this.transport = createSmtpTransport(this.config);
    return this.transport;
  }

  private htmlToText(html: string): string {
    try {
      return convertEmailHtmlToText({ htmlText: html });
    } catch (error) {
      this.logger.warn("Error converting email html to text", { error });
      return html
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  /**
   * Composes the message once, sends the bytes over SMTP, and appends the
   * same bytes to the Sent folder (most IMAP servers do not save sent mail
   * themselves). Known limitation: Gmail-over-IMAP saves its own Sent copy,
   * so those accounts may see duplicates.
   */
  private async sendMime(
    options: Mail.Options,
  ): Promise<{ messageId: string; threadId: string }> {
    const built = await buildMimeMessage({
      ...options,
      from: typeof options.from === "string" ? options.from : this.config.email,
    });
    await this.smtp().sendMail({ envelope: built.envelope, raw: built.raw });
    const sent = await this.appendSentCopy(built.raw, built.messageId);
    return {
      messageId: built.messageId,
      threadId: sent?.threadId ?? built.messageId,
    };
  }

  private async appendSentCopy(
    raw: Buffer,
    messageId: string,
  ): Promise<ParsedMessage | null> {
    try {
      const client = await this.client();
      const sentPath = await resolveOrCreateSpecialFolder(
        client,
        "sent",
        "Sent",
      );
      this.folderCache = null;
      return await this.appendAndIngest({
        folderPath: sentPath,
        raw,
        flags: ["\\Seen"],
        messageId,
      });
    } catch (error) {
      // The message went out over SMTP; a missing Sent copy is recoverable.
      this.logger.error("Failed to append sent copy to Sent folder", {
        error,
      });
      return null;
    }
  }

  private async appendAndIngest({
    folderPath,
    raw,
    flags,
    messageId,
  }: {
    folderPath: string;
    raw: Buffer;
    flags: string[];
    messageId: string;
  }): Promise<ParsedMessage | null> {
    const client = await this.client();
    const appended = await client.append(folderPath, raw, flags);
    if (appended !== false && appended.uid) {
      return this.fetchByLocation(
        appended.destination || folderPath,
        BigInt(appended.uid),
        messageId,
      );
    }
    // No UIDPLUS: locate the appended copy by its Message-ID.
    return this.searchAndFetchByMessageId(messageId);
  }

  private async appendDraft(options: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    html: string;
    text?: string;
    attachments?: MailAttachment[];
    inReplyTo?: string;
    references?: string;
    messageId?: string;
  }): Promise<string> {
    const built = await buildMimeMessage({
      from: this.config.email,
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      alternatives: [
        {
          contentType: "text/plain; charset=UTF-8",
          content: options.text ?? this.htmlToText(options.html),
        },
        { contentType: "text/html; charset=UTF-8", content: options.html },
      ],
      attachments: options.attachments,
      inReplyTo: options.inReplyTo,
      references: options.references,
      messageId: options.messageId,
    });
    const client = await this.client();
    const draftsPath = await resolveOrCreateSpecialFolder(
      client,
      "drafts",
      "Drafts",
    );
    this.folderCache = null;
    await this.appendAndIngest({
      folderPath: draftsPath,
      raw: built.raw,
      flags: ["\\Draft", "\\Seen"],
      messageId: built.messageId,
    });
    return built.messageId;
  }

  private async originalAttachments(
    messageId: string,
  ): Promise<MailAttachment[] | undefined> {
    try {
      const raw = await this.getMessageRaw(messageId);
      const parsed = await simpleParser(raw);
      if (!parsed.attachments?.length) return;
      return parsed.attachments.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
        ...(attachment.cid ? { cid: attachment.cid } : {}),
      }));
    } catch (error) {
      this.logger.warn("Failed to load original attachments for forward", {
        error,
      });
      return;
    }
  }

  private async rowForMessage(
    messageId: string,
  ): Promise<ImapMessageRow | null> {
    return prisma.imapMessage.findUnique({
      where: {
        emailAccountId_messageIdHeader: {
          emailAccountId: this.emailAccountId,
          messageIdHeader: messageId,
        },
      },
      select: imapMessageRowSelect,
    });
  }

  private async rowsForMessages(
    messageIds: string[],
  ): Promise<ImapMessageRow[]> {
    return prisma.imapMessage.findMany({
      where: {
        emailAccountId: this.emailAccountId,
        messageIdHeader: { in: messageIds },
      },
      select: imapMessageRowSelect,
    });
  }

  private async rowsForThread(threadId: string): Promise<ImapMessageRow[]> {
    return prisma.imapMessage.findMany({
      where: { emailAccountId: this.emailAccountId, threadId },
      select: imapMessageRowSelect,
    });
  }

  /**
   * Moves messages (grouped by their current folder) to the target folder and
   * records the new locations. Without UIDPLUS the new UID is unknown; the
   * row keeps uid 0 and the next fetch repairs it via Message-ID search.
   */
  private async moveRows(
    rows: ImapMessageRow[],
    targetPath: string,
  ): Promise<void> {
    const toMove = rows.filter((row) => row.folderPath !== targetPath);
    if (!toMove.length) return;

    const client = await this.client();
    const byFolder = new Map<string, ImapMessageRow[]>();
    for (const row of toMove) {
      const list = byFolder.get(row.folderPath);
      if (list) list.push(row);
      else byFolder.set(row.folderPath, [row]);
    }

    for (const [folderPath, folderRows] of byFolder) {
      await withMailbox(client, folderPath, async () => {
        const result = await client.messageMove(
          folderRows.map((row) => String(row.uid)).join(","),
          targetPath,
          { uid: true },
        );
        const uidMap = result ? result.uidMap : undefined;
        for (const row of folderRows) {
          const newUid = uidMap?.get(Number(row.uid));
          await prisma.imapMessage.updateMany({
            where: {
              emailAccountId: this.emailAccountId,
              messageIdHeader: row.messageIdHeader,
            },
            data: {
              folderPath: targetPath,
              uid: newUid ? BigInt(newUid) : BigInt(0),
            },
          });
        }
      });
    }

    await prisma.emailMessage.updateMany({
      where: {
        emailAccountId: this.emailAccountId,
        messageId: { in: toMove.map((row) => row.messageIdHeader) },
      },
      data: { inbox: targetPath === "INBOX" },
    });
  }

  /**
   * Moves every message matching the search out of a folder, including mail
   * from before the account was connected (which has no map row yet).
   */
  private async moveSearchedUids(
    folderPath: string,
    criteria: SearchObject,
    targetPath: string,
  ): Promise<void> {
    const client = await this.client();
    const uids = await withMailbox(client, folderPath, async () => {
      const found = await client.search(criteria, { uid: true });
      return found || [];
    });
    if (!uids.length) return;

    const known = await prisma.imapMessage.findMany({
      where: {
        emailAccountId: this.emailAccountId,
        folderPath,
        uid: { in: uids.map((uid) => BigInt(uid)) },
      },
      select: imapMessageRowSelect,
    });
    const knownUids = new Set(known.map((row) => Number(row.uid)));
    const unknownUids = uids.filter((uid) => !knownUids.has(uid));

    await this.moveRows(known, targetPath);
    if (unknownUids.length) {
      await withMailbox(client, folderPath, async () => {
        await client.messageMove(unknownUids.join(","), targetPath, {
          uid: true,
        });
      });
    }
  }

  private async setFlagForRows(
    rows: ImapMessageRow[],
    { flag, add }: { flag: "\\Seen" | "\\Flagged"; add: boolean },
  ): Promise<void> {
    if (!rows.length) return;
    const client = await this.client();

    const byFolder = new Map<string, ImapMessageRow[]>();
    for (const row of rows) {
      const list = byFolder.get(row.folderPath);
      if (list) list.push(row);
      else byFolder.set(row.folderPath, [row]);
    }

    for (const [folderPath, folderRows] of byFolder) {
      await withMailbox(client, folderPath, async () => {
        const range = folderRows.map((row) => String(row.uid)).join(",");
        if (add) await client.messageFlagsAdd(range, [flag], { uid: true });
        else await client.messageFlagsRemove(range, [flag], { uid: true });
      });
      for (const row of folderRows) {
        const flags = add
          ? [...new Set([...row.flags, flag])]
          : row.flags.filter((existing) => existing !== flag);
        await prisma.imapMessage.updateMany({
          where: {
            emailAccountId: this.emailAccountId,
            messageIdHeader: row.messageIdHeader,
          },
          data: { flags },
        });
      }
    }

    if (flag === "\\Seen") {
      await prisma.emailMessage.updateMany({
        where: {
          emailAccountId: this.emailAccountId,
          messageId: { in: rows.map((row) => row.messageIdHeader) },
        },
        data: { read: add },
      });
    }
  }

  private async deleteMessageAtLocation(
    row: Pick<ImapMessageRow, "folderPath" | "uid">,
  ): Promise<void> {
    const client = await this.client();
    await withMailbox(client, row.folderPath, async () => {
      await client.messageDelete(String(row.uid), { uid: true });
    });
  }

  private async archiveFolder(): Promise<string> {
    const client = await this.client();
    const path = await resolveOrCreateSpecialFolder(
      client,
      "archive",
      "Archive",
    );
    this.folderCache = null;
    return path;
  }

  private async trashFolder(): Promise<string> {
    const client = await this.client();
    const path = await resolveOrCreateSpecialFolder(client, "trash", "Trash");
    this.folderCache = null;
    return path;
  }

  private async junkFolder(): Promise<string> {
    const client = await this.client();
    const path = await resolveOrCreateSpecialFolder(client, "junk", "Junk");
    this.folderCache = null;
    return path;
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

const imapMessageRowSelect = {
  messageIdHeader: true,
  folderPath: true,
  uid: true,
  flags: true,
} as const;

type ImapMessageRow = {
  messageIdHeader: string;
  folderPath: string;
  uid: bigint;
  flags: string[];
};

function envelopeFromParsed(parsed: ParsedMail): Mail.Envelope {
  const addresses = (
    value: ParsedMail["to"] | ParsedMail["from"],
  ): string[] => {
    if (!value) return [];
    const list = Array.isArray(value) ? value : [value];
    return list.flatMap((entry) =>
      entry.value
        .map((address) => address.address)
        .filter((address): address is string => Boolean(address)),
    );
  };
  return {
    from: addresses(parsed.from)[0],
    to: [
      ...addresses(parsed.to),
      ...addresses(parsed.cc),
      ...addresses(parsed.bcc),
    ].join(", "),
  };
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
