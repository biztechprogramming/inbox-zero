# IMAP/SMTP provider — implementation plan

Adds IMAP/SMTP as a third email provider alongside Google and Microsoft.
Engineering notes; not part of the published docs navigation.

## Design decisions

- **Message identity**: the public `ParsedMessage.id` is the normalized RFC822
  `Message-ID` (fallback: hash of folder+UID+date). IMAP UIDs are per-folder and
  invalidated by moves/UIDVALIDITY changes, and "archive" is a move out of
  INBOX, so folder+UID cannot be the stable id. An `ImapMessage` mapping table
  resolves id → current folder+UID.
- **Threading**: IMAP has no thread ids. `threadId` is resolved at sync time
  from `In-Reply-To`/`References` against previously seen messages; a message
  with no known references starts a thread keyed by its own Message-ID. No full
  JWZ re-parenting.
- **Sync**: `localMailSyncStrategy = "folder-delta"` (same contract as
  Outlook). Cursor `v1:<uidValidity>:<lastSeenUid>`; UIDVALIDITY mismatch →
  `reset-required`. New mail via `UID FETCH lastSeenUid+1:*`; backfill via
  `UID SEARCH SINCE/BEFORE`. Read-state changes via a bounded `FETCH FLAGS`
  sweep (CONDSTORE/QRESYNC is the upgrade path).
- **New mail**: no push webhooks. A cron (`/api/cron/imap-poll`) polls INBOX +
  Sent per account and feeds new messages into the shared
  `processHistoryItem` pipeline. IMAP accounts are excluded from the
  watch-manager. IMAP IDLE is a possible later upgrade.
- **Auth**: username + app password over TLS only (IMAP implicit TLS on 993;
  SMTP 465 implicit TLS or 587 with required STARTTLS). No OAuth. Passwords are
  encrypted at rest with `encryptToken`, never logged, never returned to the
  client. Hosts are validated at the action boundary (DNS-resolving
  private/loopback IP blocking) to prevent SSRF.
- **Send**: compose MIME once (nodemailer `MailComposer`), send the raw bytes
  over SMTP and `APPEND` the same bytes to the Sent folder (SPECIAL-USE
  `\Sent`, falling back to common names). Known limitation: Gmail-over-IMAP
  auto-appends to Sent, so those accounts may see duplicate sent copies.
- **Labels**: map to IMAP folders (apply label = `MOVE`). Keywords on servers
  advertising `PERMANENTFLAGS \*` are a later upgrade. Archive/Trash/Junk/Sent
  are located via SPECIAL-USE with common-name fallbacks.
- **Unsupported surfaces** (honest no-ops, UI hidden): Gmail filters,
  categories, signatures, contact search, provider deep links
  ("Open in Gmail/Outlook").
- **Account creation**: IMAP is an add-on mail account, not a sign-in method.
  The connect action creates `Account { provider: "imap" }` + `EmailAccount` +
  `ImapConnection` directly; the OAuth flow is untouched.

## Schema

- `ImapConnection` (1:1 `Account`): imap/smtp host+port, username, encrypted
  password(s).
- `ImapFolder` (per `EmailAccount` + path): `uidValidity`, `lastSeenUid`,
  `specialUse` — sync state for polling and folder-delta.
- `ImapMessage` (per `EmailAccount`): `messageIdHeader` (public id),
  `threadId`, `folderPath`, `uid`, `flags`, `internalDate`.

## Phases

1. Plan (this document) and call-site audit of `isGoogleProvider` /
   `isMicrosoftProvider` usage.
2. Connect: server action that verifies IMAP + SMTP credentials and saves the
   account; settings UI form.
3. Read path: messages/threads/folders/search, folder-delta local sync, and
   the polling cron feeding the rule-processing pipeline.
4. Write path: SMTP send/reply/draft with Sent copy; archive, label, mark
   read, trash over IMAP.
5. Gating: hide unsupported features for IMAP accounts at the audited call
   sites.
