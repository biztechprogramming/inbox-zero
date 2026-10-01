"use server";

import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { actionClientUser } from "@/utils/actions/safe-action";
import { connectImapAccountBody } from "@/utils/actions/imap-connection.validation";
import { SafeError } from "@/utils/error";
import { encryptToken } from "@/utils/encryption";
import { isSafeExternalHost } from "@/utils/network/safe-http-url";
import { updateAccountSeats } from "@/utils/premium/seats";
import { INITIAL_MAIL_SPLITS } from "@/utils/mail/initial-splits";
import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";

const CONNECT_TIMEOUT_MS = 15_000;

export const connectImapAccountAction = actionClientUser
  .metadata({ name: "connectImapAccount" })
  .inputSchema(connectImapAccountBody)
  .action(
    async ({
      ctx: { userId, logger },
      parsedInput: {
        email,
        username,
        password,
        imapHost,
        imapPort,
        smtpHost,
        smtpPort,
        smtpPassword,
      },
    }) => {
      const normalizedEmail = email.toLowerCase();
      // "" from an untouched form field means "same as IMAP password"
      const smtpPass = smtpPassword?.length ? smtpPassword : undefined;

      if (
        !(await isSafeExternalHost(imapHost)) ||
        !(await isSafeExternalHost(smtpHost))
      ) {
        throw new SafeError("This mail server host is not allowed.");
      }

      const existing = await prisma.emailAccount.findUnique({
        where: { email: normalizedEmail },
        select: { id: true },
      });
      if (existing) throw new SafeError("This email is already connected.");

      // Encrypt before dialing out so a missing encryption key fails fast and
      // plaintext passwords are never stored.
      const encryptedImapPassword = encryptToken(password);
      const encryptedSmtpPassword = smtpPass ? encryptToken(smtpPass) : null;
      if (!encryptedImapPassword || (smtpPass && !encryptedSmtpPassword)) {
        throw new SafeError(
          "The server is not configured to store credentials.",
        );
      }

      await verifyImapLogin({
        host: imapHost,
        port: imapPort,
        username,
        password,
        logger,
      });
      await verifySmtpLogin({
        host: smtpHost,
        port: smtpPort,
        username,
        password: smtpPass ?? password,
      });

      let emailAccountId: string;
      try {
        const emailAccount = await prisma.emailAccount.create({
          data: {
            email: normalizedEmail,
            user: { connect: { id: userId } },
            account: {
              create: {
                user: { connect: { id: userId } },
                provider: "imap",
                type: "imap",
                providerAccountId: normalizedEmail,
                imapConnection: {
                  create: {
                    imapHost,
                    imapPort,
                    smtpHost,
                    smtpPort,
                    username,
                    imapPassword: encryptedImapPassword,
                    smtpPassword: encryptedSmtpPassword,
                  },
                },
              },
            },
            mailSplits: {
              create: INITIAL_MAIL_SPLITS.map((split, order) => ({
                ...split,
                order,
              })),
            },
          },
          select: { id: true },
        });
        emailAccountId = emailAccount.id;
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "P2002"
        ) {
          throw new SafeError("This email is already connected.");
        }
        throw error;
      }

      await updateAccountSeats({ userId }).catch((error) => {
        logger.error("Error updating premium account seats", {
          error,
          emailAccountId,
        });
      });

      logger.info("Connected IMAP account", { emailAccountId });

      return { emailAccountId };
    },
  );

async function verifyImapLogin({
  host,
  port,
  username,
  password,
  logger,
}: {
  host: string;
  port: number;
  username: string;
  password: string;
  logger: Logger;
}) {
  // Implicit TLS only (no STARTTLS upgrade path), so plaintext never hits the wire.
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user: username, pass: password },
    logger: false,
    verifyOnly: true,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
  });

  try {
    await client.connect();
  } catch (error) {
    logger.info("IMAP connection test failed", { host, port, error });
    throw new SafeError(
      `IMAP connection failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    client.close();
  }
}

async function verifySmtpLogin({
  host,
  port,
  username,
  password,
}: {
  host: string;
  port: number;
  username: string;
  password: string;
}) {
  const transporter = createTransport({
    host,
    port,
    secure: port === 465,
    // On non-465 ports, refuse to authenticate unless STARTTLS succeeds.
    requireTLS: true,
    auth: { user: username, pass: password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
  });

  try {
    await transporter.verify();
  } catch (error) {
    throw new SafeError(
      `SMTP connection failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    transporter.close();
  }
}
