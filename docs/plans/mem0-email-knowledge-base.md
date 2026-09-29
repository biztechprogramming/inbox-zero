# Plan: Mem0-backed email knowledge base

Status: implemented behind `KNOWLEDGE_STORE_ENABLED` (off by default) — queued
sync-time extraction with fresh-fragment stripping, Mem0-backed draft retrieval
replacing the whole-table prompt-stuffing path, the read-only `search_knowledge`
MCP tool, and the backfill action. Phase 1 live verification passed against the dev
database (azure-foundry provider; add → extraction → scoped search → tenant isolation).
Still pending: shadow-mode bake-in on real mail, draft-quality evals,
`Knowledge`/`ReplyMemory` migration (phase 5 remainder), and the performance phase (6).

Directive: **maximum knowledge first, maximum performance second.** Capture breadth
(all fact-bearing mail, full history backfill) before optimizing retrieval quality
and latency (reranker, indexes, hybrid search).

## Summary

Adopt [Mem0 OSS](https://github.com/mem0ai/mem0) (Apache-2.0) as the knowledge layer for
facts extracted from email. Facts are captured automatically at sync time (inbound *and*
sent mail), deduplicated and superseded by Mem0's extract → compare → ADD/UPDATE/DELETE
loop, retrieved by vector search when composing drafts, and exposed to external agents
(Claude Code, Codex) through the existing inbox-zero MCP server.

Mem0 runs **in-process** via its TypeScript SDK on the **existing Postgres + pgvector**
instance. No new services, no new databases.

## Current state (what exists today)

Three disconnected knowledge paths, all with structural problems:

| Path | Where | Problem |
|------|-------|---------|
| `Knowledge` table | `prisma/schema.prisma` (`model Knowledge`): flat `title` + `content` rows, manually curated | Append-only; nothing dedupes, updates, or retires entries. Contradictory facts accumulate |
| Knowledge injection at draft time | `utils/reply-tracker/generate-draft.ts`: `prisma.knowledge.findMany()` loads **every** row, then `aiExtractRelevantKnowledge` (`utils/ai/knowledge/extract.ts`) stuffs the whole table into one LLM prompt to filter relevance | Per-draft cost grows linearly with table size; degrades then breaks at scale |
| `ReplyMemory` | `utils/ai/reply/extract-reply-memories.ts`: learns from user edits to AI drafts, with hand-rolled LLM dedup (`matchingExistingMemoryId` decision), scoped by kind/sender/domain | A bespoke ~40% reimplementation of what Mem0 provides; capped at 16 memories in prompt |

Adjacent infrastructure we build on (already in the repo):

- **Single ingestion choke point**: `utils/email-message/save-email-messages.ts` —
  `saveParsedMessages()` is documented as "the only writer of EmailMessage"; the webhook,
  backfill script, and stats loader all route through it. It already batches an enrichment
  step (`utils/email-message/enrich-messages.ts`) computing `aiSummary` / `aiCategory` /
  `aiUrgency` / pgvector `embedding` per message.
- **Full bodies are available at ingestion**: `ParsedMessage` carries `textPlain` /
  `textHtml` (`utils/types.ts`), though current enrichment only uses subject + a 500-char
  snippet.
- **Quoted-reply stripping exists**: `parseReply()` in `utils/mail.ts` (via the installed
  `email-reply-parser` package, plus `html-to-text`), and
  `utils/email/parse-message-reply.ts`. This is the key to the long-thread problem below.
- **Sent-mail hook exists**: `utils/reply-tracker/handle-outbound.ts` →
  `handleOutboundReply`, with a Redis lock guaranteeing each outbound message is processed
  once.
- **Per-draft sender history search**: `utils/reply-tracker/sender-reply-examples.ts`
  searches up to 8 prior threads per sender at draft time to find 3 examples of how the
  user replied — live provider API calls on every draft.
- **Inbound MCP server exists**: `app/api/mcp-server/route.ts` with OAuth/JWT auth
  (better-auth JWKS), tools registered in `utils/mcp/server.ts` (e.g.
  `list_email_accounts`, `delete_rule`). This is the vehicle for Claude Code / Codex
  access.
- The `EmailMessage` mirror (per-message summary, category, urgency, embedding, tsvector)
  is **search**, not knowledge. It stays as-is; this plan does not touch it.

## Why Mem0

Evaluated against Graphiti, OpenViking, Cognee, Letta, LightRAG. Mem0 wins on stack fit:

- TypeScript SDK, runs in-process in the Next.js server — no sidecar service.
- pgvector store on the existing Postgres:
  `{ provider: "pgvector", config: { collectionName, embeddingModelDims: 1536, connectionString } }`.
  1536 dims matches the embedding dimension already used by `EmailMessage.embedding`.
- Its core loop (extract candidate facts → vector-search similar memories → LLM decides
  ADD/UPDATE/DELETE/NOOP) is exactly the lifecycle the `Knowledge` table lacks and that
  `extract-reply-memories.ts` hand-rolls.
- Apache-2.0 is compatible with inbox-zero's AGPL-3.0 + commercial terms.

Runner-up notes: Graphiti has the best temporal model but needs Neo4j/FalkorDB + a Python
service; OpenViking (AGPLv3, ByteDance) has the best agent-native retrieval paradigm but
is pre-1.0 with its own storage engine — re-evaluate at 1.0.

## Architecture

```
                       inbound sync                    sent mail
                            │                              │
              saveParsedMessages (batch)        handleOutboundMessage
                            │                              │
                 enrichMessages (existing)      reply-style extraction
                            │                              │
                 fresh-fragment extraction ────────────────┤
                 (parseReply, strips quotes)               │
                            │                              │
                            ▼                              ▼
                     memory.add(fragment, { userId: emailAccountId,
                        metadata: { kind, threadId, sourceMessageId } })
                            │
                    ┌───────┴────────┐
                    │  Mem0 (in-proc)│──── pgvector tables in existing Postgres
                    └───────┬────────┘
                            │ memory.search(query, { userId, limit: k })
              ┌─────────────┼──────────────────┐
              ▼             ▼                  ▼
        generate-draft   assistant chat   MCP server tools
        (reply drafts)   (inbox tools)    (Claude Code / Codex)
```

### Scoping and metadata

- `userId` = `emailAccountId` — matches the tenancy model of every existing table.
- `metadata.kind` — one of the taxonomy values below; used as a search filter.
- `metadata.sourceMessageId` / `metadata.threadId` — provenance, enables audit and
  cascade-delete when an account is removed.

### Memory taxonomy (what "the right info" is)

Per-message summaries stay on `EmailMessage`. Mem0 gets only **durable, cross-email
facts**:

| kind | Examples | Extracted from |
|------|----------|----------------|
| `contact-fact` | role, company, phone, assistant, timezone | inbound + sent |
| `commitment` | "user promised X by Friday", "vendor will deliver in March" | inbound + sent |
| `preference` | "user prefers morning meetings", "always CC legal on contracts" | sent + draft edits |
| `reference` | pricing quoted, policies stated, account numbers, recurring answers | inbound + sent |
| `reply-style` | tone per audience, sign-offs, how the user answers common asks | sent + draft edits |

The extraction prompt instructs the model to skip ephemera (meeting logistics that
expire, marketing copy). Per the maximum-knowledge directive, gating is wide:
`personal`, `work`, **and** `transactional` messages get fact extraction (receipts and
confirmations carry reference facts — order numbers, subscriptions, amounts); only
`newsletter` is skipped. Extraction reads the **full quote-stripped body**, not the
500-char snippet the current enrichment uses — `ParsedMessage.textPlain` is already
available at the ingestion point. Note the current enrichment only covers inbox mail
(`enrichInboxMessages` filters `inbox && !sent && !draft`); fact extraction deliberately
covers sent and archived mail too.

## The long-thread problem and its solution

Reply threads quote everything below them, so naive per-message ingestion would re-extract
the same facts from every message in a 30-reply thread — N² content, N² token cost, and
noisy duplicates.

Three-layer fix:

1. **Fresh-fragment extraction (primary).** Before `memory.add`, run each message body
   through the existing `parseReply()` (`utils/mail.ts`), which uses `email-reply-parser`
   to strip quoted history and signatures. Only the *new* text a message contributes is
   ever sent for extraction. This makes ingestion O(thread length) instead of O(thread²).
2. **Process-once guarantee.** `EmailMessage` already has
   `@@unique([emailAccountId, threadId, messageId])`, and `saveParsedMessages` upserts
   through it. Fact extraction piggybacks on the same batch: a message is extracted the
   first time it is stored, never again. Sent mail is additionally covered by the
   existing Redis outbound lock.
3. **Mem0's dedup as backstop.** Whatever survives layers 1–2 (senders who top-post
   inconsistently, forwarded digests, HTML mail where the parser misses a quote marker)
   hits Mem0's compare step and resolves to NOOP/UPDATE instead of a duplicate row.

Thread context for *ambiguous* fragments ("yes, let's do that") is handled at extraction
time by passing the message's subject plus the existing `aiSummary` of the thread's prior
messages (cheap, already computed) — not by re-ingesting prior bodies.

## Processing sent emails ("how I replied")

Hook: `handleOutboundReply` in `utils/reply-tracker/` — it already fires exactly once per
outbound message with the full `ParsedMessage`.

Extraction for sent mail differs from inbound: the prompt looks at the (quote-stripped)
reply *in context of what it answers* and captures:

- Commitments the user made (`commitment`).
- Facts the user stated (`reference` — canonical answers: pricing, policy, links).
- How the user replies (`reply-style`): tone toward this audience, structure, sign-off,
  brevity. Stored scoped by sender/domain in metadata, mirroring the scope model
  `ReplyMemory` already uses.

Payoffs:

- `sender-reply-examples.ts` currently makes up to 8 provider API searches per draft to
  reconstruct "how did I reply to this person before". Once reply-style memories
  accumulate, that becomes one `memory.search` filtered to `kind: reply-style` — retire
  the live searches behind a fallback.
- `extract-reply-memories.ts` (learning from draft edits) keeps its trigger but writes to
  Mem0 instead of the `ReplyMemory` table, deleting its hand-rolled dedup logic.

## Consumption when composing drafts

In `generate-draft.ts`, replace:

```
prisma.knowledge.findMany()  →  aiExtractRelevantKnowledge (LLM over whole table)
```

with:

```
memory.search(queryFromIncomingEmail, { userId: emailAccountId, limit: k })
```

- Query input: subject + quote-stripped body of the email being replied to (same shape as
  the existing embedding input).
- Results drop into the existing `<knowledge_base>` and `<reply_memories>` prompt slots in
  `utils/ai/reply/draft-reply.ts` — the drafting prompt itself is unchanged.
- Net effect per draft: **one LLM call removed** (the relevance-extraction call), replaced
  by a vector query. `aiExtractFromEmailHistory` shrinks too, since history facts were
  already captured at sync.
- Known trade-off: vector top-k returns entries verbatim and does not synthesize across
  them the way the current LLM filter can. The drafting model does its own synthesis; if
  quality regresses, add a cheap condense step over the top-k (still far cheaper than the
  whole-table read). Decide with evals, not by assumption.

## Access for Claude Code / Codex

Extend the existing MCP server (`utils/mcp/server.ts`, served at `app/api/mcp-server`,
OAuth-authenticated per user) with two tools:

- `search_knowledge({ query, kind?, limit? })` → top-k memories with kind, provenance
  (threadId/messageId), and timestamps.
- `add_knowledge({ content, kind })` → writes through the same Mem0 pipeline so external
  additions get the same dedup/supersede treatment.

Because auth, account selection (`utils/mcp/account-selection.ts`), and tool registration
already exist, this is additive. Claude Code and Codex connect as standard MCP clients;
no separate memory server (and no OpenMemory sidecar) is needed. Write access via
`add_knowledge` should respect the existing `filterWriteTools` conventions.

## Security and privacy

- **Email content is untrusted input.** Mem0's internal extraction prompts do not go
  through `createGenerateObject`'s prompt-hardening wrapper. Mitigation: use Mem0's
  `customPrompt` to carry the same injection-resistant framing used by
  `enrich-messages.ts` (`trust: "untrusted"` conventions), and treat retrieved memories
  as untrusted when injected into drafting prompts (they already are, via the existing
  `<knowledge_base>` framing).
- **Isolation**: every read/write carries `userId: emailAccountId`; MCP tools resolve the
  account from the authenticated principal, never from client input.
- **Deletion**: account deletion must call Mem0's delete-by-user in addition to the
  Prisma cascade, since Mem0's tables are outside Prisma's schema.
- **Logging**: memory contents are PII — `logger.trace` only, per repo logging rules.

## Spike findings (resolved from `mem0ai` 3.3.1 source, `mem0ai/oss` entry point)

The four hard blockers from the review are all resolved:

1. **Provider coverage is sufficient — no adapter layer needed.** LLM factory:
   `openai` (with `baseURL`, so OpenRouter and any OpenAI-compatible endpoint work),
   `anthropic`, `groq`, `ollama`, `lmstudio`, `google`/`gemini`, `azure_openai`,
   `mistral`, `deepseek`, `xai`, `aws_bedrock`, `langchain`. Embedder factory: `openai`,
   `aws_bedrock`, `ollama`, `lmstudio`, `together`, `google`/`gemini`, `azure_openai`,
   `fastembed` (fully local — an option for self-hosters with no embedding API),
   `langchain`, `vertexai`, `huggingface`. Map inbox-zero's per-account provider +
   `aiApiKey` onto a per-account `Memory` instance (cache instances per account config).
2. **Extraction-prompt hardening is supported.** `MemoryConfig.customInstructions`
   is appended to the fact-extraction prompt (verified in source). Carry the same
   untrusted-content framing used by `enrich-messages.ts`. `add()` also accepts
   `infer: false` for raw writes that bypass extraction (useful for migrating existing
   `Knowledge` rows verbatim).
3. **History store is a non-issue.** `MemoryConfig.disableHistory: true` exists —
   set it. (Alternatives if history is ever wanted: `historyDbPath` or a
   Supabase-backed `historyStore`.)
4. **Tenant isolation is in-SQL and parameterized.** PGVector's `search()` builds a
   `WHERE` clause from filters (`user_id` etc.) via `buildFilterConditions` with
   parameterized values and escaped identifiers — filtering happens in Postgres, not
   post-hoc. Still add an integration test asserting cross-account isolation.

Also confirmed:

- PGVector `initialize()` auto-runs `CREATE EXTENSION IF NOT EXISTS vector` and
  `CREATE TABLE IF NOT EXISTS ...`. For prod reproducibility, pre-create the tables in a
  hand-written Prisma migration (repo precedent: the ivfflat index migration for
  `EmailMessage.embedding`); auto-create then only serves dev databases.
- Mem0's collection is its own table, so `embeddingModelDims` is **not** tied to
  `EmailMessage`'s 1536 — it must only be consistent per deployment's chosen embedder.
- A reranker stage (`cohere`, local `huggingface` via transformers.js, or
  `llm_reranker`) and pgvector `hnsw: true` indexing are available in-SDK — these are
  the phase-6 performance levers.
- Pin `mem0ai` to an exact version (0.x/3.x churn is real; spike ran against 3.3.1).

## Idempotency and where extraction runs

`saveParsedMessages` upserts via `ON CONFLICT ... DO UPDATE` with `COALESCE` so re-syncs
never null out enrichment — and `enrichInboxMessages` already implements the pre-filter
pattern: query which candidate messages already have `aiSummary`, process only the rest.
Fact extraction reuses the pattern with its own marker: a nullable
`knowledgeExtractedAt DateTime?` on `EmailMessage`, set only after a successful
`memory.add`. A failed Mem0 write leaves the marker null and the next sync retries —
best-effort with self-healing, no outbox machinery.

Extraction runs **queued, not inline**: the sync/webhook path publishes extraction jobs
through the existing QStash infrastructure (`utils/qstash.ts`, `utils/queue`,
`utils/upstash` — same pattern as `categorize-senders`). Backfill jobs go through the
same queue at low priority.

## Costs and operational notes

- Extraction adds LLM calls per message batch. Contained by: queueing off the hot path,
  fresh-fragment-only input, newsletter gating, and a cheap model via the existing
  `LlmUseCase` mechanism (new use case: `KnowledgeExtraction`).
- Deployments where `getEmbeddingModel()` returns null gate the entire feature off,
  identical to how embedding search already degrades to keyword-only — unless the
  deployment opts into the `fastembed` local embedder.

## Rollout phases

1. **DB verification (1 day)** — the SDK spike is done offline (see findings above);
   what remains is a live round-trip against a dev Postgres: `add`/`search` with an
   inbox-zero provider config, plus the cross-account isolation test.
2. **Ingestion (shadow mode)** — queued extraction from `saveParsedMessages` +
   `handleOutboundReply` behind a feature flag for internal accounts; nothing reads the
   store yet. Watch extraction quality, token spend, dedup behavior on long threads.
3. **Backfill (maximum knowledge)** — implemented: `backfillKnowledgeAction` queues
   extraction for the account's unextracted mirror messages (default 12 months,
   configurable, newest-first) through the same per-account queue. Spend visibility is
   processed-message counts in logs; per-account dollar accounting would require
   wrapping mem0's internal LLM client and is deferred until someone needs it.
4. **Draft consumption** — swap `generate-draft.ts` to `memory.search`, evals comparing
   draft quality vs. the prompt-stuffing path (per repo rules: judge semantic failure
   modes, not wording).
5. **Unify** — migrate `Knowledge` rows (`memory.add` with `infer: false`) and
   `ReplyMemory` extraction; retire `aiExtractRelevantKnowledge` and the per-draft
   sender searches. MCP tools (`search_knowledge`, read-only first) for Claude Code /
   Codex land here.
6. **Performance (maximum performance)** — once the store is populated: pgvector
   `hnsw: true` indexing, a reranker stage over a wider candidate set (local
   `huggingface` reranker by default, `llm_reranker` where quality demands), hybrid
   keyword+vector retrieval (PGVector's built-in tsvector keyword search), and top-k /
   filter tuning driven by the phase-4 evals.

Each phase ships independently; phases 2–6 are individually reversible via flags.

## Open questions (product calls)

- The Knowledge UI (`app/api/knowledge/route.ts` + assistant tool): become a memory
  browser, go read-only, or retire? Auto-extracted memories contain things users will
  want to inspect and delete.
- Does `reply-style` warrant per-sender scoping keys in metadata from day one (as
  `ReplyMemory.scopeType` has today), or is semantic search over unscoped memories
  sufficient? Migrating scope semantics is the trickiest part of phase 5.
- Multi-account users: memories are per `emailAccountId` today; is cross-account recall
  (same human, work + personal accounts) wanted later? Mem0 metadata can carry `userId`
  proper if so.
- MCP write access (`add_knowledge`): exposed at launch or after read-only bake-in?
  Existing `filterWriteTools` convention suggests read-only first.
