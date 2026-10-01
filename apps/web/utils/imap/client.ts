import { ImapFlow } from "imapflow";
import type { ImapFlowOptions } from "imapflow";
import prisma from "@/utils/prisma";
import { decryptToken } from "@/utils/encryption";
import type { Logger } from "@/utils/logger";

const CONNECT_TIMEOUT_MS = 15_000;
// Keep idle connections short-lived: providers are created per request and
// have no dispose lifecycle, so the socket timeout is what closes them.
const SOCKET_TIMEOUT_MS = 60_000;

export type ImapAccountConfig = {
  host: string;
  port: number;
  username: string;
  password: string;
  smtpHost: string;
  smtpPort: number;
  smtpPassword: string;
  /** Test-only TLS overrides (e.g. self-signed certs in integration tests). */
  tls?: ImapFlowOptions["tls"];
};

export async function getImapAccountConfig({
  emailAccountId,
}: {
  emailAccountId: string;
}): Promise<ImapAccountConfig> {
  const connection = await prisma.imapConnection.findFirst({
    where: { account: { emailAccount: { id: emailAccountId } } },
  });
  if (!connection) {
    throw new Error("No IMAP connection configured for account");
  }

  const password = decryptToken(connection.imapPassword);
  if (!password) throw new Error("Failed to decrypt IMAP credentials");
  const smtpPassword = connection.smtpPassword
    ? decryptToken(connection.smtpPassword)
    : password;
  if (!smtpPassword) throw new Error("Failed to decrypt SMTP credentials");

  return {
    host: connection.imapHost,
    port: connection.imapPort,
    username: connection.username,
    password,
    smtpHost: connection.smtpHost,
    smtpPort: connection.smtpPort,
    smtpPassword,
  };
}

/**
 * Lazily connected, auto-reconnecting handle around a single ImapFlow
 * connection. One instance lives inside each ImapProvider.
 */
export class ImapSession {
  private readonly config: ImapAccountConfig;
  private readonly logger: Logger;
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;

  constructor(config: ImapAccountConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async getClient(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<ImapFlow> {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      // Implicit TLS only; see the connect action, which enforces the same.
      secure: true,
      auth: { user: this.config.username, pass: this.config.password },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      tls: this.config.tls,
    });
    client.on("error", (error) => {
      this.logger.warn("IMAP connection error", { error });
    });
    await client.connect();
    this.client = client;
    return client;
  }

  async close(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    await client.logout().catch(() => client.close());
  }
}

/** Runs `fn` with the mailbox selected, holding ImapFlow's mailbox lock. */
export async function withMailbox<T>(
  client: ImapFlow,
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await client.getMailboxLock(path);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
