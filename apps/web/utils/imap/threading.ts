import { normalizeMessageId, parseReferences } from "@/utils/imap/message-id";

/**
 * Parent Message-ID candidates for thread resolution, most-recent ancestor
 * first: In-Reply-To names the direct parent, References lists the chain
 * oldest-first (RFC 5322 appendix A.2).
 */
export function candidateParentIds({
  inReplyTo,
  references,
}: {
  inReplyTo?: string | null;
  references?: string | null;
}): string[] {
  const candidates: string[] = [];
  const direct = normalizeMessageId(inReplyTo);
  if (direct) candidates.push(direct);
  for (const id of parseReferences(references).reverse()) {
    if (!candidates.includes(id)) candidates.push(id);
  }
  return candidates;
}

/**
 * Resolves the thread id for an incoming message: the thread of any known
 * ancestor, else the message starts a thread keyed by its own id.
 *
 * ponytail: no JWZ re-parenting — two sibling replies that arrive before
 * their common parent form separate threads. Upgrade to a merge pass if
 * split threads become a real complaint.
 */
export async function resolveImapThreadId({
  messageId,
  inReplyTo,
  references,
  lookupThreadId,
}: {
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
  /** Returns the thread id of any message matching one of the given ids. */
  lookupThreadId: (messageIds: string[]) => Promise<string | null>;
}): Promise<string> {
  const candidates = candidateParentIds({ inReplyTo, references });
  if (!candidates.length) return messageId;
  return (await lookupThreadId(candidates)) ?? messageId;
}
