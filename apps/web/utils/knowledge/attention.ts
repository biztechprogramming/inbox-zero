import { addDays, subDays } from "date-fns";
import groupBy from "lodash/groupBy";
import {
  EmailAudience,
  EmailItemOwner,
  EmailItemStatus,
  EmailItemType,
  ThreadTrackerType,
} from "@/generated/prisma/enums";
import prisma from "@/utils/prisma";

const WINDOW_DAYS = 30;
const DUE_SOON_DAYS = 3;
const DEFAULT_LIMIT = 20;

/**
 * What needs the user's attention, ranked, from precomputed state only (no
 * LLM on the read path): open commitments, requests, and deadlines from mail
 * personally addressed to the user, plus threads the reply tracker holds
 * open. Covers the last 30 days and anything with an upcoming due date.
 */
export async function getAttention({
  emailAccountId,
  limit = DEFAULT_LIMIT,
  now = new Date(),
}: {
  emailAccountId: string;
  limit?: number;
  now?: Date;
}) {
  const windowStart = subDays(now, WINDOW_DAYS);

  const [items, trackers] = await Promise.all([
    prisma.emailItem.findMany({
      where: {
        emailAccountId,
        status: EmailItemStatus.OPEN,
        type: {
          in: [
            EmailItemType.COMMITMENT,
            EmailItemType.REQUEST,
            EmailItemType.DEADLINE,
          ],
        },
        audience: { in: [EmailAudience.DIRECT, EmailAudience.CC] },
        OR: [
          { sourceDate: { gte: windowStart } },
          { dueDate: { gte: windowStart } },
        ],
      },
      select: {
        id: true,
        threadId: true,
        type: true,
        text: true,
        owner: true,
        counterpartyEmail: true,
        counterpartyName: true,
        dueDate: true,
        sourceDate: true,
      },
    }),
    prisma.threadTracker.findMany({
      where: { emailAccountId, resolved: false, sentAt: { gte: windowStart } },
      orderBy: { sentAt: "desc" },
      select: { threadId: true, type: true },
    }),
  ]);

  const itemsByThread = groupBy(items, (item) => item.threadId);
  // Newest tracker wins when a thread has several unresolved ones.
  const trackerByThread = new Map<string, ThreadTrackerType>();
  for (const tracker of trackers) {
    if (!trackerByThread.has(tracker.threadId)) {
      trackerByThread.set(tracker.threadId, tracker.type);
    }
  }

  const threadIds = [
    ...new Set([...Object.keys(itemsByThread), ...trackerByThread.keys()]),
  ];
  if (!threadIds.length) return [];

  const threadRows = await prisma.$queryRaw<ThreadRow[]>`
    SELECT DISTINCT ON (m."threadId")
      m."threadId",
      m."subject",
      m."from",
      m."fromName",
      m."date",
      m."externalUrl",
      (
        SELECT s."threadSummary" FROM "EmailMessage" s
        WHERE s."emailAccountId" = m."emailAccountId"
          AND s."threadId" = m."threadId"
          AND s."threadSummary" IS NOT NULL
        ORDER BY s."date" DESC LIMIT 1
      ) AS "summary",
      (
        SELECT r."aiUrgency" FROM "EmailMessage" r
        WHERE r."emailAccountId" = m."emailAccountId"
          AND r."threadId" = m."threadId"
          AND r."sent" = false
          AND r."aiUrgency" IS NOT NULL
        ORDER BY r."date" DESC LIMIT 1
      ) AS "urgency"
    FROM "EmailMessage" m
    WHERE m."emailAccountId" = ${emailAccountId}
      AND m."threadId" = ANY(${threadIds})
      AND m."draft" = false
    ORDER BY m."threadId", m."date" DESC
  `;
  const rowByThread = new Map(threadRows.map((row) => [row.threadId, row]));
  const dueSoon = addDays(now, DUE_SOON_DAYS);

  return threadIds
    .map((threadId) => {
      const row = rowByThread.get(threadId);
      const threadItems = (itemsByThread[threadId] ?? []).sort(
        (a, b) =>
          (a.dueDate?.getTime() ?? Number.POSITIVE_INFINITY) -
          (b.dueDate?.getTime() ?? Number.POSITIVE_INFINITY),
      );
      const tracker = trackerByThread.get(threadId) ?? null;
      // Unowned deadlines ("the renewal is due Oct 15") are the user's to
      // notice, so only items someone else owes rank as waiting-on.
      const mine = threadItems.filter(
        (item) => item.owner !== EmailItemOwner.THEM,
      );
      const nextDue = mine.find((item) => item.dueDate)?.dueDate ?? null;

      return {
        threadId,
        subject: row?.subject ?? null,
        lastMessageAt: row?.date ?? null,
        lastFrom: row ? row.fromName || row.from : null,
        link: row?.externalUrl ?? null,
        summary: row?.summary ?? null,
        urgency: row?.urgency ?? null,
        tracker,
        items: threadItems.map(({ threadId: _threadId, ...item }) => item),
        rank: [
          getBucket({ mine: mine.length, nextDue, dueSoon, tracker }),
          nextDue?.getTime() ?? Number.POSITIVE_INFINITY,
          -(row?.urgency ?? 0),
          -(row?.date.getTime() ?? 0),
        ],
      };
    })
    .sort((a, b) => compareRanks(a.rank, b.rank))
    .slice(0, limit)
    .map(({ rank: _rank, ...thread }) => thread);
}

type ThreadRow = {
  threadId: string;
  subject: string | null;
  from: string;
  fromName: string | null;
  date: Date;
  externalUrl: string | null;
  summary: string | null;
  urgency: number | null;
};

function getBucket({
  mine,
  nextDue,
  dueSoon,
  tracker,
}: {
  mine: number;
  nextDue: Date | null;
  dueSoon: Date;
  tracker: ThreadTrackerType | null;
}) {
  if (nextDue && nextDue <= dueSoon) return 0;
  if (
    mine ||
    tracker === ThreadTrackerType.NEEDS_REPLY ||
    tracker === ThreadTrackerType.NEEDS_ACTION
  ) {
    return 1;
  }
  return 2;
}

function compareRanks(a: number[], b: number[]) {
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
