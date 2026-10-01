/**
 * Integration test against a real IMAP server (GreenMail in Docker).
 *
 * Run with: pnpm test-imap  (requires Docker)
 *
 * The database is replaced with an in-memory store so the test exercises real
 * IMAP wire behavior (LIST/SELECT/SEARCH/FETCH/APPEND) without Postgres.
 */
import { execSync } from "node:child_process";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { ImapFlow } from "imapflow";
import { ImapSession, type ImapAccountConfig } from "@/utils/imap/client";
import {
  syncFolderFlagChanges,
  syncFolderNewMessages,
} from "@/utils/imap/sync";
import { ImapProvider } from "@/utils/email/imap";
import { createScopedLogger } from "@/utils/logger";

vi.mock("@/utils/prisma");
vi.mock("server-only", () => ({}));

const RUN_IMAP_TESTS = process.env.RUN_IMAP_TESTS === "true";

const CONTAINER_NAME = `inbox-zero-imap-test-${process.pid}`;
const IMAPS_PORT = 13_993;
const EMAIL_ACCOUNT_ID = "imap-test-account";

const config: ImapAccountConfig = {
  host: "127.0.0.1",
  port: IMAPS_PORT,
  username: "user1",
  password: "pass1",
  smtpHost: "127.0.0.1",
  smtpPort: 13_465,
  smtpPassword: "pass1",
  // GreenMail uses a self-signed certificate.
  tls: { rejectUnauthorized: false },
};

const logger = createScopedLogger("imap-integration-test");

// --- in-memory stand-ins for ImapFolder / ImapMessage ---

type FolderRow = {
  uidValidity: bigint;
  lastSeenUid: bigint;
  specialUse?: string | null;
};
type MessageRow = {
  messageIdHeader: string;
  threadId: string;
  folderPath: string;
  uid: bigint;
  flags: string[];
  internalDate: Date;
};

const folderRows = new Map<string, FolderRow>();
const messageRows = new Map<string, MessageRow>();

function installPrismaStore() {
  prisma.imapFolder.findUnique.mockImplementation(
    (async (args: { where: { emailAccountId_path: { path: string } } }) =>
      folderRows.get(args.where.emailAccountId_path.path) ?? null) as never,
  );

  prisma.imapFolder.upsert.mockImplementation((async (args: {
    where: { emailAccountId_path: { path: string } };
    update: Partial<FolderRow>;
    create: FolderRow & { path: string };
  }) => {
    const path = args.where.emailAccountId_path.path;
    const existing = folderRows.get(path);
    const row = existing
      ? { ...existing, ...args.update }
      : {
          uidValidity: args.create.uidValidity,
          lastSeenUid: args.create.lastSeenUid,
          specialUse: args.create.specialUse,
        };
    folderRows.set(path, row as FolderRow);
    return row;
  }) as never);

  prisma.imapMessage.upsert.mockImplementation((async (args: {
    where: { emailAccountId_messageIdHeader: { messageIdHeader: string } };
    update: Partial<MessageRow>;
    create: MessageRow;
  }) => {
    const key = args.where.emailAccountId_messageIdHeader.messageIdHeader;
    const existing = messageRows.get(key);
    const row = existing ? { ...existing, ...args.update } : { ...args.create };
    messageRows.set(key, row);
    return row;
  }) as never);

  prisma.imapMessage.findUnique.mockImplementation(
    (async (args: {
      where: { emailAccountId_messageIdHeader: { messageIdHeader: string } };
    }) =>
      messageRows.get(
        args.where.emailAccountId_messageIdHeader.messageIdHeader,
      ) ?? null) as never,
  );

  prisma.imapMessage.findFirst.mockImplementation((async (args: {
    where: { messageIdHeader: { in: string[] } };
  }) => {
    const matches = args.where.messageIdHeader.in
      .map((id) => messageRows.get(id))
      .filter((row): row is MessageRow => Boolean(row))
      .sort((a, b) => b.internalDate.getTime() - a.internalDate.getTime());
    return matches[0] ?? null;
  }) as never);

  prisma.imapMessage.findMany.mockImplementation((async (args: {
    where: {
      threadId?: string;
      folderPath?: string;
      uid?: { gte: bigint; lte: bigint };
    };
  }) => {
    let rows = [...messageRows.values()];
    if (args.where.threadId) {
      rows = rows.filter((row) => row.threadId === args.where.threadId);
    }
    if (args.where.folderPath) {
      rows = rows.filter((row) => row.folderPath === args.where.folderPath);
    }
    if (args.where.uid) {
      const { gte, lte } = args.where.uid;
      rows = rows.filter((row) => row.uid >= gte && row.uid <= lte);
    }
    return rows.sort(
      (a, b) => a.internalDate.getTime() - b.internalDate.getTime(),
    );
  }) as never);

  prisma.imapMessage.updateMany.mockImplementation((async (args: {
    where: { messageIdHeader: string };
    data: Partial<MessageRow>;
  }) => {
    const row = messageRows.get(args.where.messageIdHeader);
    if (row) Object.assign(row, args.data);
    return { count: row ? 1 : 0 };
  }) as never);

  prisma.emailMessage.updateMany.mockResolvedValue({ count: 0 });
}

// --- the tests ---

describe.skipIf(!RUN_IMAP_TESTS)("IMAP read path against GreenMail", () => {
  let session: ImapSession;

  beforeAll(async () => {
    const sessionLabel = process.env.AO_SESSION_ID
      ? `--label ao.session=${process.env.AO_SESSION_ID}`
      : "";
    execSync(
      `docker run -d --rm --name ${CONTAINER_NAME} ${sessionLabel} ` +
        `-p ${IMAPS_PORT}:3993 -p 13465:3465 ` +
        `-e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=user1:pass1@example.com" ` +
        "greenmail/standalone:2.1.3",
      { stdio: "inherit" },
    );
    await waitForImap();
    session = new ImapSession(config, logger);
  }, 120_000);

  afterAll(async () => {
    await session?.close();
    try {
      execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "ignore" });
    } catch {
      // already gone
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    installPrismaStore();
  });

  it("baselines, syncs new mail, threads replies, and serves reads", async () => {
    const client = await session.getClient();

    // First sync records a baseline and processes nothing.
    const baseline = await syncFolderNewMessages({
      client,
      emailAccountId: EMAIL_ACCOUNT_ID,
      folderPath: "INBOX",
      logger,
    });
    expect(baseline.messages).toHaveLength(0);

    await client.append(
      "INBOX",
      rawMessage({
        messageId: "<root@test.example>",
        subject: "Hello integration",
        body: "the original message",
      }),
      [],
    );
    await client.append(
      "INBOX",
      rawMessage({
        messageId: "<reply@test.example>",
        subject: "Re: Hello integration",
        body: "a reply",
        inReplyTo: "<root@test.example>",
        references: "<root@test.example>",
      }),
      [],
    );

    // Second sync picks up exactly the two appended messages.
    const sync = await syncFolderNewMessages({
      client,
      emailAccountId: EMAIL_ACCOUNT_ID,
      folderPath: "INBOX",
      logger,
    });
    expect(sync.messages).toHaveLength(2);
    const [root, reply] = sync.messages;
    expect(root.id).toBe("root@test.example");
    expect(reply.id).toBe("reply@test.example");
    // The reply joins the root's thread via References/In-Reply-To.
    expect(reply.threadId).toBe(root.threadId);
    expect(root.labelIds).toContain("INBOX");
    expect(root.labelIds).toContain("UNREAD");

    // A third sync has nothing new.
    const idle = await syncFolderNewMessages({
      client,
      emailAccountId: EMAIL_ACCOUNT_ID,
      folderPath: "INBOX",
      logger,
    });
    expect(idle.messages).toHaveLength(0);

    // Read path through the provider: direct fetch, thread, search, stats.
    const provider = new ImapProvider(config, EMAIL_ACCOUNT_ID, logger);
    const fetched = await provider.getMessage("root@test.example");
    expect(fetched.subject).toBe("Hello integration");
    expect(fetched.textPlain).toContain("the original message");

    const thread = await provider.getThread(root.threadId);
    expect(thread.messages.map((m) => m.id)).toEqual([
      "root@test.example",
      "reply@test.example",
    ]);

    const search = await provider.searchMessages({
      query: "integration",
      maxResults: 10,
    });
    expect(search.messages.some((m) => m.id === "root@test.example")).toBe(
      true,
    );

    const stats = await provider.getInboxStats();
    expect(stats.total).toBe(2);
    expect(stats.unread).toBe(2);

    const labels = await provider.getLabels();
    expect(labels.some((label) => label.id === "INBOX")).toBe(true);

    // Flag sweep: mark the root read on the server, then sync read state.
    const row = messageRows.get("root@test.example");
    expect(row).toBeDefined();
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.messageFlagsAdd({ uid: String(row?.uid) }, ["\\Seen"], {
        uid: true,
      });
    } finally {
      lock.release();
    }
    await syncFolderFlagChanges({
      client,
      emailAccountId: EMAIL_ACCOUNT_ID,
      folderPath: "INBOX",
      logger,
    });
    expect(messageRows.get("root@test.example")?.flags).toContain("\\Seen");
  }, 60_000);
});

async function waitForImap(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const probe = new ImapFlow({
        host: config.host,
        port: config.port,
        secure: true,
        auth: { user: config.username, pass: config.password },
        logger: false,
        tls: { rejectUnauthorized: false },
        connectionTimeout: 2000,
        greetingTimeout: 2000,
      });
      await probe.connect();
      await probe.logout();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

function rawMessage({
  messageId,
  subject,
  body,
  inReplyTo,
  references,
}: {
  messageId: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  return [
    `Message-ID: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    "From: sender@test.example",
    "To: user1@example.com",
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "",
  ].join("\r\n");
}
