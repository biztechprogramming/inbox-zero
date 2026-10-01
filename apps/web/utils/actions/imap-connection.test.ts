import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { connectImapAccountAction } from "./imap-connection";

const { imapState, smtpState, encryptionSecrets } = vi.hoisted(() => ({
  imapState: { error: null as Error | null, connects: 0 },
  smtpState: { error: null as Error | null, verifies: 0 },
  encryptionSecrets: { secret: "test-secret", salt: "test-salt" },
}));

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));
vi.mock("@/utils/premium/seats", () => ({
  updateAccountSeats: vi.fn(async () => {}),
}));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    async connect() {
      imapState.connects += 1;
      if (imapState.error) throw imapState.error;
    }
    close() {}
  },
}));
vi.mock("nodemailer", () => ({
  createTransport: vi.fn(() => ({
    verify: async () => {
      smtpState.verifies += 1;
      if (smtpState.error) throw smtpState.error;
    },
    close: () => {},
  })),
}));
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get EMAIL_ENCRYPT_SECRET() {
        return encryptionSecrets.secret;
      },
      get EMAIL_ENCRYPT_SALT() {
        return encryptionSecrets.salt;
      },
    },
  };
});

// Public IP literals skip DNS resolution in the SSRF check.
const validInput = {
  email: "Person@Example.com",
  username: "person@example.com",
  password: "app-password",
  imapHost: "8.8.8.8",
  imapPort: 993,
  smtpHost: "8.8.4.4",
  smtpPort: 587,
};

describe("connectImapAccountAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    imapState.error = null;
    imapState.connects = 0;
    smtpState.error = null;
    smtpState.verifies = 0;
    encryptionSecrets.secret = "test-secret";
    encryptionSecrets.salt = "test-salt";
    prisma.emailAccount.findUnique.mockResolvedValue(null);
    prisma.emailAccount.create.mockResolvedValue({
      id: "email-account-1",
    } as Awaited<ReturnType<typeof prisma.emailAccount.create>>);
  });

  it("rejects private mail server hosts without dialing out", async () => {
    const result = await connectImapAccountAction({
      ...validInput,
      imapHost: "10.0.0.5",
    });

    expect(result?.serverError).toBe("This mail server host is not allowed.");
    expect(imapState.connects).toBe(0);
    expect(prisma.emailAccount.create).not.toHaveBeenCalled();
  });

  it("rejects an email that is already connected without dialing out", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "existing",
    } as Awaited<ReturnType<typeof prisma.emailAccount.findUnique>>);

    const result = await connectImapAccountAction(validInput);

    expect(result?.serverError).toBe("This email is already connected.");
    expect(imapState.connects).toBe(0);
    expect(prisma.emailAccount.create).not.toHaveBeenCalled();
  });

  it("refuses to save credentials when encryption is not configured", async () => {
    encryptionSecrets.secret = "";

    const result = await connectImapAccountAction(validInput);

    expect(result?.serverError).toBe(
      "The server is not configured to store credentials.",
    );
    expect(prisma.emailAccount.create).not.toHaveBeenCalled();
  });

  it("does not create the account when the IMAP login fails", async () => {
    imapState.error = new Error("Invalid credentials");

    const result = await connectImapAccountAction(validInput);

    expect(result?.serverError).toBe(
      "IMAP connection failed: Invalid credentials",
    );
    expect(prisma.emailAccount.create).not.toHaveBeenCalled();
  });

  it("does not create the account when the SMTP login fails", async () => {
    smtpState.error = new Error("535 Auth failed");

    const result = await connectImapAccountAction(validInput);

    expect(result?.serverError).toBe("SMTP connection failed: 535 Auth failed");
    expect(prisma.emailAccount.create).not.toHaveBeenCalled();
  });

  it("creates the account with encrypted credentials after both logins succeed", async () => {
    const result = await connectImapAccountAction(validInput);

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({ emailAccountId: "email-account-1" });
    expect(imapState.connects).toBe(1);
    expect(smtpState.verifies).toBe(1);

    const createArgs = prisma.emailAccount.create.mock.calls[0]?.[0];
    expect(createArgs?.data.email).toBe("person@example.com");
    const account = createArgs?.data.account?.create as {
      provider: string;
      providerAccountId: string;
      imapConnection: { create: Record<string, unknown> };
    };
    expect(account.provider).toBe("imap");
    expect(account.providerAccountId).toBe("person@example.com");

    const connection = account.imapConnection.create;
    expect(connection.imapHost).toBe("8.8.8.8");
    expect(connection.smtpPassword).toBeNull();
    // Stored value must be versioned ciphertext, never the plaintext password.
    expect(connection.imapPassword).toMatch(/^v1:/);
    expect(connection.imapPassword).not.toContain("app-password");
  });
});
