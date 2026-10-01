// Shows how long recent knowledge backfills took, or how far along a running
// one is. A backfill stamps every message it queues with the same
// knowledgeRequestedAt and each message gets knowledgeExtractedAt when done,
// so each backfill is one group of rows.
//
// Run with:
//   pnpm --filter inbox-zero-ai knowledge-backfill-status
//   pnpm --filter inbox-zero-ai knowledge-backfill-status -- --email-account-id=<id> --limit=10

import "dotenv/config";
import { Prisma } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";

// Live sync queues messages in small batches (a webhook or a 20-message
// page); anything this size or larger is a backfill.
const MIN_BACKFILL_MESSAGES = 25;
// Nothing finished for this long while messages are pending means the drain
// stopped; re-running the backfill restarts it from where it left off.
const STALLED_AFTER_MS = 10 * 60 * 1000;
// Mirrors pendingKnowledgeSql: drafts and newsletters are never extracted,
// so they don't count as queued.
const eligible = Prisma.sql`NOT m."draft" AND (m."aiCategory" IS NULL OR m."aiCategory" <> 'newsletter')`;

type Row = {
  email: string;
  started: Date;
  queued: number;
  done: number;
  left: number;
  lastDone: Date | null;
};

async function main() {
  const { emailAccountId, limit } = parseArgs(process.argv.slice(2));

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      ea."email",
      m."knowledgeRequestedAt" AS "started",
      COUNT(*) FILTER (WHERE ${eligible})::int AS "queued",
      COUNT(*) FILTER (WHERE ${eligible} AND m."knowledgeExtractedAt" IS NOT NULL)::int AS "done",
      COUNT(*) FILTER (WHERE ${eligible} AND m."knowledgeExtractedAt" IS NULL)::int AS "left",
      MAX(m."knowledgeExtractedAt") AS "lastDone"
    FROM "EmailMessage" m
    JOIN "EmailAccount" ea ON ea."id" = m."emailAccountId"
    WHERE m."knowledgeRequestedAt" IS NOT NULL
      ${emailAccountId ? Prisma.sql`AND m."emailAccountId" = ${emailAccountId}` : Prisma.empty}
    GROUP BY ea."email", m."knowledgeRequestedAt"
    HAVING COUNT(*) >= ${MIN_BACKFILL_MESSAGES}
    ORDER BY m."knowledgeRequestedAt" DESC
    LIMIT ${limit}
  `;

  if (!rows.length) {
    console.log("No backfills found.");
    return;
  }

  const now = Date.now();
  console.table(
    rows.map((row) => {
      const end = row.left ? now : (row.lastDone?.getTime() ?? now);
      const elapsedMs = end - row.started.getTime();
      const idleMs = now - (row.lastDone ?? row.started).getTime();

      return {
        account: row.email,
        started: row.started.toLocaleString(),
        status: getStatus(row, idleMs),
        progress: `${row.done}/${row.queued}`,
        elapsed: formatDuration(elapsedMs),
        "per min": (row.done / Math.max(elapsedMs / 60_000, 1 / 60)).toFixed(1),
        finished: row.left ? "" : (row.lastDone?.toLocaleString() ?? ""),
      };
    }),
  );
}

function getStatus(row: Row, idleMs: number) {
  if (!row.left) return "finished";
  return idleMs > STALLED_AFTER_MS ? "stalled" : "running";
}

function formatDuration(ms: number) {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [
    hours && `${hours}h`,
    (hours || minutes) && `${minutes}m`,
    `${seconds}s`,
  ]
    .filter(Boolean)
    .join(" ");
}

function parseArgs(argv: string[]) {
  const get = (name: string) =>
    argv
      .find((arg) => arg.startsWith(`--${name}=`))
      ?.slice(name.length + 3)
      .trim();

  const limitArg = get("limit");
  const limit = limitArg ? Number(limitArg) : 5;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid --limit: ${limitArg}`);
  }

  return { emailAccountId: get("email-account-id"), limit };
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
