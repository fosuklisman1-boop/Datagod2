# Developer API v2 — Plan 6: Bulk SMS (SMS key)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a developer with an SMS account hold an `sms` v2 key and call `POST /sms/send`, `GET /sms/balance`, `GET /sms/senders`, `GET /sms/campaigns`, `GET /sms/campaigns/{campaignId}`, with a required client `reference`, claim-before-engine idempotency, sandbox parity and full docs, by wrapping `enqueueSendBatched` (unchanged).

**Architecture:** Same as plans 4/5. Claim table `api_v2_idempotency` gets kind `sms` through a tiny migration. SMS is paid from the SMS **credits ledger** (`sms_accounts.unit_balance`), NOT the wallet, so nothing here touches `deduct_wallet`. Decision logic lives in `lib/api-v2/`; routes are thin `withV2` wrappers with `requiredType: "sms"`.

**Spec:** `docs/superpowers/specs/2026-10-22-developer-api-v2-design.md`. Patterns to copy exactly: plan 5 (`docs/superpowers/plans/2026-10-26-developer-api-v2-results-and-afa.md`, `lib/api-v2/standard-orders.ts`, `endpoints/afa.ts`, `endpoints/afa-deps.ts`, `app/api/v2/afa/**`), including claim states, own-claim lookup shape `{ order: null, claim: {reference,state} }`, `userId` guards, fixed messages with machine codes prefixed in `message`.

**Risk tier:** Tier 1 (money in credits, messaging abuse/fraud surface). Mandatory fresh most-capable-model whole-branch review, database-reviewer pass on the migration, abuse-case pass (free / someone else's / twice / cheaper / no-auth / at scale), failing tests first, prod change protocol with a dry-run string built BY CODE (asserts no `COMMIT`/bare `END;`, explicit `BEGIN`, ends in `SELFTEST_OK` raise) and user OK before apply.

## Facts from the code (2026-10-27)

- v1 `POST /api/v1/sms/send` (read, do NOT edit): per-account rate limit override via `loadSmsSettings`/`apiRateLimitFor`; `getOrCreateAccountForUser(userId)` returns null when the account type has no SMS (403); body `{message 3..1000 chars, recipients string[] (unique, max SMS_MAX_TOTAL=5000), sender_id?, scheduled_at? (checkSchedule: 2 min..30 days), provider? (via resolveTenantSendProvider, ignored unless platform allows)}`; sender defaults to account `default_sender_id` (active only, same account) then first active `sms_sender_ids` by created_at; `getShopTokens(account)` for template tokens; calls `enqueueSendBatched(userId, account.id, message, uniqueRecipients, tokens, senderId, opts?)`; `maxDuration = 300`.
- `enqueueSendBatched` returns `{ ok:true, batches, totalQueued, segments, creditsReserved, invalidSkipped, partial, stoppedReason, held, scheduled, scheduledFor, sendLogId }` or `{ ok:false, error, code?, reason? }`. Errors: `EMPTY_MESSAGE, BLOCKED, TOO_MANY_RECIPIENTS, NO_VALID_RECIPIENTS, NOT_ACTIVATED, SUSPENDED, INSUFFICIENT_CREDITS, INVALID_SENDER_ID, ENQUEUE_FAILED, SMS_DISABLED, POLICY_REJECTED, SEND_IN_PROGRESS`. Via `runSequentialBatches`: an error on the FIRST batch means nothing sent/charged; an error or throw on a LATER batch returns `partial:true` with what went out (already charged); a throw on the first batch is rethrown ("nothing charged" by comment, but v2 treats an unexplained throw as ambiguous).
- `lib/sms/customer-reads.ts`: `listRecords(accountId,{status,page})` (25/page, from `sms_send_logs`), `getRecord(accountId, logId)` (log + per-recipient `sms_messages` + delivery counts), `getHomeSummary(accountId)` (limits, senderPool). `lib/sms/account-service.ts`: `SmsAccount {id, unit_balance, status, mode, api_rate_limit_override, default_sender_id, review_hold}`, `getPendingUnits(accountId)`.
- `canIssue` (lib/api-v2/key-issue.ts) refuses `sms` today with "SMS keys are not available yet"; this plan replaces that branch.

## Calls I made (flag to the user at hand-off)

1. **SMS keys need an SMS account.** Eligibility = `getOrCreateAccountForUser(userId) !== null` at issue time (same gate v1 uses), in addition to the normal role/suspension/v2-open checks. No account => 403 "SMS isn't enabled for this account type".
2. **Client `reference` is REQUIRED on send** (3-100 chars, like plans 4/5). v1 has none; a retry of a v1 send double-sends and double-charges, which v2 must not.
3. **Replay returns the stored summary**, never re-sends. Claim `done` stores `{ campaign_id (sendLogId), total, batches, segments, credits_reserved, invalid_skipped, partial, stopped_reason, held, scheduled, scheduled_for }` — no message body, no recipients.
4. **Campaign id exposed = `send_log_id`** (stringified). Campaign list/detail are owner-scoped by the account id; a foreign id gets the same 404 as a missing one.
5. **Error classification:** returned errors with no batch sent (`BLOCKED, NOT_ACTIVATED, SUSPENDED, INSUFFICIENT_CREDITS, INVALID_SENDER_ID, SMS_DISABLED, POLICY_REJECTED, SEND_IN_PROGRESS, EMPTY_MESSAGE, TOO_MANY_RECIPIENTS, NO_VALID_RECIPIENTS`, and `ENQUEUE_FAILED` which refunds before returning) => no_charge, release the claim. Any THROW from the engine, or any shape we do not recognise => ambiguous, mark claim `unknown`, never re-run, urgent admin alert, response `OUTCOME_UNKNOWN`. A `partial` success is `done` (charged for what went out) and reported as `partial: true`.
6. **No `provider` field in v2** (spec call 10: omit what is not part of the product surface); the tenant default decides.
7. **Rate limit group `purchase` for send, `status` for reads, `balance` for balance** (existing groups). The v1 per-account override is NOT applied in v2 in this plan (follow-up) — admin per-key limits already exist.

## Global Constraints

- v1 untouched. Plans 1-5 rules apply: envelope, `withV2` with `requiredType: "sms"` (a standard/commission key gets 403), `failClosedWhenLimiterDegraded` on send, no phone numbers, message bodies, or sender IDs in logs.
- Request hash: sha256 of key-sorted canonical JSON of `{ message (as sent), recipients: sorted unique normalised E.164, sender_id (input or null), scheduled_at (ISO instant or null) }`. Only the hash is stored.
- Recipient handling: accept Ghana local (`0XXXXXXXXX`), `233XXXXXXXXX`, `+233XXXXXXXXX`, 9-digit; normalise for hashing and dedupe; pass the ORIGINAL unique strings to the engine as v1 does. Reject non-string items, >5000 unique, 0 recipients. Invalid-but-string numbers are the engine's job (`invalid_skipped`).
- `message` 3..1000 chars string; `sender_id` optional non-empty string; `scheduled_at` via `checkSchedule`. Forbidden fields (case-insensitive): `provider, price, cost, credits, status, user_id, account_id, fee, amount`.
- Sandbox (`test` keys): same parsing, no account/credits/engine/claims; follow v1's sandbox shape plus `campaign_id: null`; replay through `getSandboxOrder`/`placeSandboxOrder` only if `lib/sandbox.ts` supports an `sms` action (verify before choosing; otherwise stateless).
- Edit with Edit/Write tools, never `sed`. Real `next build` before pushing main. Unique test phones per file (0249991060-0249991069 for this plan). Work only in the clean worktree.

## Tasks

### Task 1: Migration — claim kind `sms`
Files: `migrations/<next free>_api_v2_idempotency_sms_kind.sql` + `.selftest.sql` (copy the 0138 shape). CHECK becomes `airtime,bill,results,afa,sms`; idempotent; selftest inserts one claim per kind, still rejects `'other'`, same reference allowed across kinds. Precheck next free number. Do not apply (Task 7). Commit `feat(api-v2): idempotency claim kind for sms`.

### Task 2: Pure rules — `lib/api-v2/sms-rules.ts` (+ test)
`ClaimKind` gains `"sms"` in idempotency.ts (additive). Produce: `parseSmsSendBody(body, now)`, `smsHash`, `classifySmsError(e)` (table above, unknown => ambiguous), `smsErrorResponse(e)` (fixed messages: 402 INSUFFICIENT_CREDITS, 403 NOT_ACTIVATED/SUSPENDED, 400 INVALID_SENDER_ID/BLOCKED/POLICY_REJECTED with the customer-safe `reason` only, 503 SMS_DISABLED/POLICY unavailable, 429 SEND_IN_PROGRESS without inviting a new reference), `mapSendSummary(result)`, `mapCampaign(row)`, `mapCampaignDetail(record)` (allow-listed fields; recipients as E.164 with per-recipient `status`; no provider internals), `mapSenders(rows)`, `mapBalance(account, pending)`. Failing tests first for every edge (message length 2/3/1000/1001, recipients 0/1/5000/5001/duplicates/mixed forms/non-strings, schedule bounds, sender_id blank, forbidden fields, hash equivalence across spellings, mapper allow-lists, classifier incl. unknown/throw). Commit `feat(api-v2): sms request rules`.

### Task 3: Endpoint core + deps — `lib/api-v2/endpoints/sms.ts`, `sms-deps.ts` (+ tests, fake-client pattern)
`handleSmsSend` follows `handleAfaRegister`: parse => claim (kind `sms`) => resolve account (null => 403, release) => resolve sender (default, then first active; none => 400 INVALID_SENDER_ID, release) => engine => classify/complete/release/markUnknown. Plus `handleSmsBalance`, `handleSmsSenders`, `handleSmsCampaigns` (page param, 25/page, status filter), `handleSmsCampaign` (path param is the CAMPAIGN id; replay of a send is by re-POST with the same reference). Real deps wire `getOrCreateAccountForUser`, `getShopTokens`, `enqueueSendBatched`, `listRecords`, `getRecord`, `getPendingUnits`, claims bound to the admin client. Commit `feat(api-v2): sms endpoints`.

### Task 4: Routes — `app/api/v2/sms/{send,balance,senders,campaigns,campaigns/[campaignId]}/route.ts`
Thin `withV2` wrappers; send has `export const maxDuration = 300`. Route tests per existing pattern. Commit `feat(api-v2): sms routes`.

### Task 5: Key issuance for sms
`canIssue` gains `hasSmsAccess: boolean` (consulted only when `type === "sms"`): sms + no access => 403 "SMS isn't enabled for this account type". `app/api/user/v2-keys` computes it with `getOrCreateAccountForUser`. `isIssuableType` includes `sms`. Dashboard `GenerateKeyDialog`/`V2KeysCard` offer the SMS type only when the access GET says SMS is available (extend additively with `smsAvailable`). Verify the admin console key list/filters already handle the type. Failing tests first. Commit `feat(api-v2): issue sms keys`.

### Task 6: Docs registry + samples
Add the SMS group to `lib/api-v2/docs/registry.ts` (auth note for SMS key, Send, Balance, Senders, Campaigns, Campaign detail), samples in all four languages, error table, idempotency/`reference` note, partial/held/scheduled states, sandbox section. Drift tests import real constants. Commit `docs(api-v2): sms reference`.

### Task 7: Whole-branch verification, review, ship
Full vitest (known 9 order-health + AFA + hubtel-cs flake only), `tsc`, mandatory fresh whole-branch review + database-reviewer on the migration + abuse-case pass, fix with failing tests, merge origin/main, real `next build`, then — with explicit user OK via AskUserQuestion — apply the migration using a code-asserted dry run, verify, push `HEAD:main`, watch the deploy, probe the five routes unauthenticated (401 envelope), update memory `project-api-v2-foundation.md`.
