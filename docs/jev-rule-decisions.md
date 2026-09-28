# Jev for rule decisions

Use [Jev](https://typesafe.ai) (TypeSafe AI's hosted decision model) to make most per-email processing decisions, and fall back to the LLM only when Jev is not confident.

## Why

Jev does not generate text. It takes a state blob plus typed questions (`choice`, `score`, `boolean`) and returns calibrated probabilities for all of them in one call. It costs $0.042 per million input tokens, and output is free. Rule selection is a choice among rules whose `instructions` are already plain-English criteria, so it maps onto Jev directly.

This still makes one model call per email. It replaces the generative LLM call for most emails; it does not remove the model call.

## Current decision order (unchanged)

`findMatchingRules` in `apps/web/utils/ai/choose-rule/match-rules.ts` runs these checks, which need no LLM, first:

1. Cold email check: whitelist, same organization, sender cache (`GroupItem`), prior contact. Only then `aiIsColdEmail`.
2. Per rule: calendar preset, thread guard, learned patterns (`GroupItem`), and static conditions with AND/OR.
3. A learned-pattern match cancels all AI candidates.
4. Only when AI candidates remain: `aiChooseRule`.

Jev slots in at step 4 and in the other LLM decision points listed in phase 2.

## Design

### Phase 1: `jevChooseRule` in front of `aiChooseRule`

- New file `apps/web/utils/ai/choose-rule/jev-choose-rule.ts`.
- **State:** From, To, Subject, Date, list and unsubscribe headers, a snippet or body taken from `getEmailForLLM(message)`, and the sender's recent `ClassificationFeedback`.
- **Question:** one `choice`. Each option is keyed by index (`r0`, `r1`, …) and described by the rule's name and `instructions`, plus a `none` option ("no rule applies").
- **Accept:** when Jev picks a rule with probability at least `JEV_RULE_THRESHOLD`, return the same `{ rules, reason }` shape as `aiChooseRule`, with a reason like `Jev (p=0.91): Receipt`. A `none` answer always goes to the LLM, because evals showed that is where Kev makes its mistakes.
- **Fall back** to `aiChooseRule`, unchanged, when any of these is true:
  - Jev picks `none`, or its probability is below the threshold
  - the response is missing the choice or its probability, or names an unknown option
  - the call errors, returns a non-2xx status, or takes longer than 10 s
  - `multiRuleSelectionEnabled` is on and the account has custom rules (Jev's `choice` picks exactly one option)
- **Gating:** `JEV_ENABLED`. When it is off, behaviour is identical to today.
- **Logging:** the match reason reads `Jev (p=0.91): <rule>`, and falling back logs `Jev not confident` or `Jev failed`. Jev matches count as AI matches, so phase 3 works without changes.

### Phase 2: other LLM decision points

| Call site | Jev question |
|---|---|
| `aiIsColdEmail`, `utils/cold-email/is-cold-email.ts` | `boolean` "is this unsolicited cold outreach" |
| `determineConversationStatus`, `utils/reply-tracker/handle-conversation-status.ts` | `choice` of TO_REPLY / FYI / AWAITING_REPLY / ACTIONED |
| `aiCategorizeSender`, `utils/categorize/senders/categorize.ts` | `choice` over the user's categories. Rule matching doesn't read it, but Smart Categories and Bulk Archive group senders by it, so it stays on. |

The same fallback rule applies to each: below the threshold, the existing LLM call runs.

### Phase 3: feed the existing learning

Jev matches are recorded like AI matches, so `analyzeSenderPatternIfAiMatch` (3+ threads) turns consistent senders into learned patterns, which then skip the model entirely. No new learning code is needed.

## Config

Add each of these to `.env.example`, `apps/web/env.ts`, and `turbo.json`:

| Var | Default | Notes |
|---|---|---|
| `JEV_ENABLED` | `false` | Master switch |
| `JEV_BASE_URL` | `https://api.typesafe.ai/v1` | `http://localhost:8009/v1` for self-hosted Kev |
| `JEV_API_KEY` | none | Bearer token; not needed for local Kev |
| `JEV_MODEL` | `jev-latest` | `kev-latest` for Kev |
| `JEV_RULE_THRESHOLD` | `0.4` | Minimum probability for a rule pick; set from the Kev-4B eval |

`jevChooseRule` calls `POST {JEV_BASE_URL}/systemone` directly (the System One API), so the same code works with TypeSafe (Jev), Opper (hosted Kev), or a self-hosted Kev server. `JEV_BASE_URL`, `JEV_API_KEY` and `JEV_MODEL` choose the backend.

## Dependencies

None. The call is a plain `fetch`. An earlier AI SDK bump for `experimental_evaluate` was reverted when we moved off the Vercel AI Gateway.

## Validation

- Run the existing choose-rule evals in `apps/web/__tests__/eval/` with Jev on and with it off, and compare accuracy and fallback rate.
- Pick the threshold where Jev's accepted decisions are at least as accurate as the LLM's.
- Unit test the threshold, fallback, and invalid-response handling. This is the logic that fails silently.

## Model-facing surface

No prompt or tool descriptions change. The new surface is the Jev question and option text built from rule `instructions`. Review it like a prompt change.

## Tasks

### Phase 1: rule selection
- [x] Call the System One API with `fetch`, with no new dependencies
- [x] Add `JEV_ENABLED`, `JEV_BASE_URL`, `JEV_API_KEY`, `JEV_MODEL` and `JEV_RULE_THRESHOLD` env vars
- [x] Implement `jev-choose-rule.ts` (state, question, parse, threshold, retry)
- [x] Wire it into `findMatchingRulesWithReasons` before `aiChooseRule`, with fallback
- [x] Skip Jev when multi-rule selection applies
- [x] Unit tests: accepted match, `none`, below-threshold fallback, invalid response, error fallback (`jev-choose-rule.test.ts`)
- [x] Add a Jev block to `__tests__/eval/choose-rule.test.ts`
- [x] Run the choose-rule eval against self-hosted Kev-4B and record the results below
- [x] Send `none` answers to the LLM, and lower the default threshold to 0.4
- [ ] Re-run on a larger labelled set (real mail) before enabling
- [x] Set the default threshold from the eval results (0.4)

### Phase 2: other decisions
- [x] Put Jev in front of `aiIsColdEmail`: yes/no question, used when confidence is at least 0.7 in either direction (`JEV_COLD_EMAIL_CONFIDENCE`)
- [x] Put Jev in front of `aiDetermineThreadStatus`: choice question, used when probability is at least 0.8 (`JEV_THREAD_STATUS_CONFIDENCE`). Skipped when the user has customised conversation rules.
- [x] Move the shared HTTP call into `utils/llms/system-one.ts` (`askSystemOne`)
- [x] Put Jev in front of `aiCategorizeSender` (single sender, from the webhook): used when probability is at least 0.6 (`JEV_CATEGORY_CONFIDENCE`)
- [x] Bulk sender categorization (`categorizeWithAi`): each sender left after the static rules goes to Jev one at a time, and only the unsure ones go to the `aiCategorizeSenders` LLM batch. At ~0.2 s per sender on local Kev, a 50-sender batch adds about 10 s.

### Phase 3: rollout
- [ ] Enable Jev for one account and watch the Jev and fallback ratio in logs
- [ ] Confirm learned patterns still get created from Jev matches

## Eval results

### 2026-09-28: Kev-4B, self-hosted (M4 Max, MLX bf16)

33 single-rule cases from `__tests__/eval/choose-rule.test.ts`, run through `jevChooseRule` against `kev.serve` on localhost.

- **Latency:** 321 to 391 ms per email, median 353 ms (wall clock through our code). A repeated state takes about 50 ms.
- **Accuracy:** when Kev picks a rule it was right 25 out of 25 times, even at low probability. All 8 errors were Kev picking `none` when a rule applied.

| Threshold | Decided by Kev | Wrong |
|---|---|---|
| 0.75 (current default) | 4/33 | 0 |
| 0.60 | 13/33 | 0 |
| 0.50 | 18/33 | 1 (a `none`) |
| 0.40 | 28/33 | 6 (all `none`) |
| 0.40, with `none` sent to the LLM | 22/33 | 0 |

### 2026-09-28: after sending `none` to the LLM, threshold 0.4

Same 33 cases and setup: **Kev decided 22/33 (67%) with 0 wrong**, and 11 fell back to the LLM. Latency was unchanged (median 353 ms, range 321 to 392 ms). This matches the prediction from the sweep above.

Next: re-check on a larger labelled set of real mail before enabling, because 33 cases is small and all of them are English.

To run:

```bash
# Kev server: uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009
EVAL_REPORT_PATH=/tmp/kev-report.md LLM_API_KEY=unused JEV_ENABLED=true \
  JEV_BASE_URL=http://localhost:8009/v1 JEV_MODEL=kev-latest \
  pnpm --filter inbox-zero-ai test-ai __tests__/eval/choose-rule.test.ts -t jev
```

`LLM_API_KEY=unused` only satisfies the eval suite's provider check; `-t jev` runs no LLM tests.

### 2026-09-28: Phase 2, Kev-4B, self-hosted

**Cold email** (`__tests__/eval/cold-email.test.ts`, current prompt, 56 scored cases):

| Confidence | Decided by Kev | Wrongly cold | Missed cold |
|---|---|---|---|
| 0.50 | 55/56 | 11 | 1 |
| 0.60 | 42/56 | 1 | 1 |
| 0.65 | 37/56 | 0 | 0 |
| **0.70 (chosen)** | 30/56 | 0 | 0 |

Kev's mistakes are genuine but unsolicited inbound mail (investors, journalists, applicants, prospects) called cold at p = 0.51 to 0.60. 0.70 leaves a margin, because wrongly marking an investor's email as cold is expensive. A confirmation run with GPT-5.6 Luna handling the fallbacks passed all 60 cases: Kev decided 28, all correct.

**Thread status** (24 labelled threads from `__tests__/ai-regression/` and `__tests__/eval/determine-thread-status.test.ts`):

| Threshold | Decided by Kev | Wrong |
|---|---|---|
| 0.50 | 13/24 | 1 |
| 0.70 | 8/24 | 1 |
| **0.80 (chosen)** | 6/24 | 0 |

Kev is confident only on simple threads: a single question, a plain FYI, automated notifications. Multi-person threads and implied promises go to the LLM. Two of its errors came from tests that don't pass `userSentLastEmail`, which production does. 24 cases is a small sample.

**Sender categorization** (`__tests__/eval/categorize-senders.test.ts`, 19 senders, default categories):

| Threshold | Decided by Kev | Wrong |
|---|---|---|
| 0.40 | 19/19 | 3 |
| 0.50 | 13/19 | 0 |
| **0.60 (chosen)** | 11/19 | 0 |
| 0.80 | 6/19 | 0 |

Kev's only mistakes: three receipt senders (Airbnb, Apple, Vercel) called Notification, at p = 0.44 to 0.48. A wrong category only affects grouping in Smart Categories and Bulk Archive, but 0.5 is too close to those errors, so 0.6 it is. Latency: median 210 ms (135 to 313 ms). The confirmation run at 0.6 passed all 19 cases.

