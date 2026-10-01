import { z } from "zod";

const host = z
  .string()
  .trim()
  .min(1, "Host is required")
  .max(255)
  .regex(/^[a-zA-Z0-9.\-:[\]]+$/, "Invalid host");
const port = z.number().int().min(1).max(65_535);

export const connectImapAccountBody = z.object({
  email: z.string().trim().email("Invalid email address"),
  username: z.string().min(1, "Username is required").max(255),
  password: z.string().min(1, "Password is required").max(1024),
  imapHost: host,
  // IMAP connects with implicit TLS only, so the standard port is 993.
  imapPort: port,
  smtpHost: host,
  smtpPort: port,
  // Defaults to the IMAP password when omitted.
  smtpPassword: z.string().max(1024).optional(),
});

export type ConnectImapAccountBody = z.infer<typeof connectImapAccountBody>;
