# SMS Platform Rebuild — Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scheduled sends (2 min–30 days, credits debited at scheduling, cancel = refund) and billed order confirmations (toggle: own sender ID, 1 credit/segment, falls back to the free platform sender).

**Architecture:** Both features reuse the Phase 3 machinery. A scheduled send is a held-shaped log (`status='scheduled'` + `scheduled_for`, messages pending/unclaimed) promoted by a per-minute cron and dispatched through a dispatch module factored out of `held-service`. A billed confirmation is one `enqueueSend` call (debit, log, message, dispatch) guarded by a per-order idempotency row; any failure falls back to the existing free `sendSMS`.

**Tech Stack:** Next.js 15 App Router, Supabase (service-role routes + SQL functions), Vitest, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-12-sms-platform-rebuild-phase4-design.md`. **Facts report (line maps, signatures, schema):** the controller's scratchpad `phase4-facts.md` (copied into each task file).

**Conventions (same as Phases 1–3):** branch `worktree-customer-ui-rebuild`; commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; baseline 9 known failures in `lib/order-health-service.test.ts`; live SQL applied by the controller only after a line-by-line review (diff any re-created live function against `pg_get_functiondef` first); subagents never touch the live DB or log into the app; commit only your own paths (never `git add -A`); plain separate git/node commands; no Python (use node; mind CRLF). Gates per milestone: `npx tsc --noEmit`, `npm run test:run`, placeholder-env `npx next build`, visual check, final whole-milestone review, push branch then `HEAD:main` after `git fetch origin main`.

**Deviation from the spec (stated honestly):** the spec's "flag sends more than 24 h late" is dropped (YAGNI); Records shows the scheduled time and the normal delivery breakdown. `source` column added (spec implied a label but no column) so Records/Credits can show "Order confirmation".

## Design decisions made while planning
1. **Cancel/dispatch per log.** A >500-recipient scheduled send is several `scheduled` logs sharing `scheduled_for`; cancel and dispatch act per log (same as held).
2. **Scheduled + policy hold:** a send the policy says to hold is stored `held` (hold wins); `scheduled_for` is kept for information; release sends it immediately.
3. **Kill switch:** the cron does nothing while SMS is disabled (due logs stay scheduled); cancel/refund is never blocked. Suspended account at due time → cancel + refund.
4. **Order confirmations use `enqueueSend` directly** (not `enqueueSendBatched`): they are system messages, exempt from policy enforcement and the per-account lease, but still pass kill switch, entitlement, content filter and the debit. Idempotency: new table `sms_order_confirmations(shop_order_id UNIQUE)` inserted first (`ON CONFLICT DO NOTHING`); conflict ⇒ skip everything (never double-bill/double-send).
5. **Fallback rule:** if the billed path cannot produce a successful enqueue for ANY reason (toggle off, no active sender, not entitled, kill switch, insufficient credits, DB error), the caller sends the existing free `sendSMS` message from the platform sender exactly as before the toggle was on. A billed attempt that already succeeded never also sends the free one.

## File structure
```
migrations/20261016_sms_scheduled_sends.sql          scheduled_for, source columns; promote/cancel SQL; usage fn update
migrations/20261017_order_confirmation_billing.sql   shop_settings.order_confirmation_use_own_sender; sms_order_confirmations
lib/sms/dispatch-claimed.ts (+test)                  shared claim→dispatch→mark→hand-back→recompute (extracted from held-service)
lib/sms/schedule.ts (+test)                          bounds validation, parse
lib/sms/scheduled-service.ts (+test)                 runScheduledDispatch(), cancelScheduledCampaign()
lib/sms/order-confirmation.ts (+test)                resolveConfirmationSender, sendOrderConfirmation (billed + guard + fallback signal)
app/api/cron/sms-scheduled/route.ts (+test)          per-minute cron (verifyCronAuth)
app/api/sms/logs/[id]/cancel/route.ts (+test)        customer cancel
app/api/sms/order-confirmations/route.ts (+test)     GET/PATCH toggle
vercel.json                                          + cron entry
Modified: lib/sms/send-service.ts (opts param: scheduledFor, source), lib/sms/held-service.ts (use shared dispatch), lib/sms/customer-reads.ts, shop + v1 send routes, lib/api-docs-registry.ts, app/api/fulfillment/process-order/route.ts, app/api/shop/settings/[shopId]/route.ts, app/dashboard/sms/{page.tsx,compose/page.tsx,_lib/view.ts,_components/records/*}
```

---

# Milestone 4a — Scheduled sends

### Task 1: Migration — columns, promote, cancel, usage

**Files:** Create `migrations/20261016_sms_scheduled_sends.sql`.

- [ ] **Step 1: Write the migration** (controller reviews and applies; implementer writes only). Contents:
  1. `ALTER TABLE sms_send_logs ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'campaign';` + `CHECK (source IN ('campaign','order_confirmation'))` named `sms_send_logs_source_check`; `CREATE INDEX IF NOT EXISTS idx_sms_send_logs_due ON sms_send_logs (scheduled_for) WHERE status = 'scheduled';`. **Do not** grant the new columns to `authenticated` (all reads are service-role).
  2. `sms_promote_due_scheduled(p_limit INT)` → `TABLE(out_id BIGINT, out_account_id UUID, out_sender_id TEXT)`, SECURITY DEFINER, `search_path = public`, service-role only: one statement `WITH due AS (SELECT id FROM sms_send_logs WHERE status='scheduled' AND scheduled_for <= now() ORDER BY scheduled_for, id LIMIT GREATEST(p_limit,1) FOR UPDATE SKIP LOCKED) UPDATE sms_send_logs l SET status='queued' FROM due WHERE l.id = due.id RETURNING l.id, l.sms_account_id, l.sender_id;` (the atomic gate; concurrent cron runs and cancel are safe).
  3. `cancel_scheduled_sms_campaign(p_send_log_id BIGINT, p_account_id UUID DEFAULT NULL, p_reason TEXT DEFAULT 'cancelled')` → `TABLE(out_result TEXT, out_refunded INT)`: **copy the structure of `reject_held_sms_campaign` in `migrations/20261014_sms_held_reject.sql`** (read it; same locking, message closing `attempts>=3`, single refund ledger row, refunded flags) with these differences: lock the log `FOR UPDATE`; require `status='scheduled'` (else `not_scheduled`, or `already_cancelled` when `policy_shadow->'review'->>'outcome'='cancelled'`); when `p_account_id` is not NULL it must equal the log's `sms_account_id` (else `not_found`) — the customer route passes it, the system cron passes NULL; message `last_error='scheduled_cancelled'`; refund ledger ref `sched_cancel:<logId>`, reason `campaign_refund`, linked by `send_log_id`; log set to `failed`, `credits_used=0`, `completed_at=now()`, `policy_shadow = coalesce(policy_shadow,'{}') || jsonb_build_object('review', jsonb_build_object('outcome','cancelled','reason',p_reason,'at',now(),'refunded',v_refund))`. Returns `('cancelled', refunded)`.
  4. Re-create `sms_account_usage(p_account_id UUID)` (**first fetch the live definition with `pg_get_functiondef` and keep it identical** — latest is `migrations/20261015_sms_usage_exclude_rejected.sql`) adding `COALESCE(policy_shadow->'review'->>'outcome','') IN ('rejected','cancelled')` to the failed-log exclusion. Same signature, STABLE, SECURITY DEFINER, grants.
  5. REVOKE/GRANT service_role only on both new functions.
- [ ] **Step 2: Self-check** — `node` script that loads the file and asserts it contains each object name (cheap guard test in `lib/sms/scheduled-service.test.ts` later reads the file the same way the existing enforcement tests do).
- [ ] **Step 3: Commit** `feat(sms): scheduled sends migration`.

### Task 2: Shared dispatch module

**Files:** Create `lib/sms/dispatch-claimed.ts`, `lib/sms/dispatch-claimed.test.ts`; Modify `lib/sms/held-service.ts`, `lib/sms/held-service.test.ts`.

- [ ] **Step 1:** Move `dispatchClaimed` (held-service l.113-187) and its constants (`MAX_ATTEMPTS`, `DISPATCH_WINDOW_MS`, `RELEASE_CHUNK`) into `dispatch-claimed.ts` exporting `dispatchClaimed(db, sendLogId, items, senderId, claimedAtMs): Promise<number>` and `claimPendingForLog(db, sendLogId): Promise<{id,phone,message}[]>` (the CLAIM update from `releaseHeldCampaign` l.224-233, returning `[]` on error), taking the supabase client as a parameter. Behaviour must be byte-identical (batches of 100 hand-back, `placedUnmarked`, hubtel-unconfirmed tagging, recompute non-fatal).
- [ ] **Step 2:** `held-service.ts` imports and uses them; all existing held-service tests must pass unchanged (move the dispatch-specific assertions to the new test file, keep behaviour assertions).
- [ ] **Step 3:** `npx vitest run lib/sms/held-service.test.ts lib/sms/dispatch-claimed.test.ts` + `tsc`; commit `refactor(sms): extract shared claim/dispatch module`.

### Task 3: Schedule validation + enqueue support

**Files:** Create `lib/sms/schedule.ts` (+test); Modify `lib/sms/send-service.ts` (+test), shop and v1 send routes (+ docs registry), `lib/sms/customer-reads.ts`.

- [ ] **Step 1 (TDD) `schedule.ts`:**
```ts
export const MIN_SCHEDULE_MS = 2 * 60_000
export const MAX_SCHEDULE_MS = 30 * 24 * 3_600_000
export type ScheduleCheck = { ok: true; at: Date } | { ok: false; message: string }
export function checkSchedule(raw: unknown, now: Date = new Date()): ScheduleCheck { /* string ISO with timezone offset or Z; reject invalid/NaN; at-now < MIN → "Pick a time at least 2 minutes from now"; > MAX → "You can schedule up to 30 days ahead" */ }
```
Tests: valid mid-range, exactly MIN (ok), MIN-1s (reject), exactly MAX (ok), MAX+1s (reject), non-string/NaN/empty, date without offset (reject — require explicit offset or Z).
- [ ] **Step 2: `enqueueSend` options.** Add a 9th optional param `opts?: { scheduledFor?: Date; source?: "campaign" | "order_confirmation" }`. Behaviour: log insert gains `source` (default omitted → DB default) and, when `scheduledFor` and not held, `status: "scheduled"`, `scheduled_for: scheduledFor.toISOString()`, messages inserted `pending` unclaimed (same expression as `held`, l.244/247), orphan-close status list adds `"scheduled"` (l.273-284), early return after `onLogged` returns `{ ...result, scheduled: true, scheduledFor }` with **no dispatch and no recompute**; when held AND scheduledFor, hold wins (`status 'held'`, `scheduled_for` stored). `EnqueueSendResult` gains `scheduled?: true; scheduledFor?: string`. When `opts` is undefined the DB call sequence is byte-identical (golden fixture test must pass untouched).
- [ ] **Step 3: pass-through.** `enqueueSendBatched(..., senderId?, opts?)` → both the unenforced `runSequentialBatches` path and `enforcedSendBatched/enforcedSendLocked` forward `opts` to every chunk; `BatchedSendResult` gains `scheduled: boolean; scheduledFor: string | null`. Tests: scheduled unenforced single chunk (log status scheduled, rows pending unclaimed, no dispatch calls, debit happened), scheduled enforced allow, scheduled enforced hold ⇒ held, >500 recipients ⇒ N scheduled logs same `scheduled_for`, orphan cleanup closes a scheduled log, off-path fixture unchanged.
- [ ] **Step 4: routes.** `POST /api/shop/sms/send`: accept optional `scheduledAt` (string); validate with `checkSchedule` → 400 `{success:false,error:"INVALID_SCHEDULE",message}`; pass `{scheduledFor}`; success data gains `scheduled`, `scheduledFor`. `POST /api/v1/sms/send`: snake_case `scheduled_at`; same validation; success body gains `scheduled`, `scheduled_for` (and `status: "scheduled"` when scheduled); sandbox body includes `scheduled:false`. Update `lib/api-docs-registry.ts` (param, example, 400 INVALID_SCHEDULE). Route tests for validation and mapping.
- [ ] **Step 5: reads.** `lib/sms/customer-reads.ts` `LOG_COLUMNS` += `scheduled_for, source`; `getRecord`/`listRecords` return them (tests updated).
- [ ] **Step 6:** vitest `lib/sms app/api` + full `npm run test:run` + `tsc`; commit in small steps.

### Task 4: Dispatcher service, cron, cancel

**Files:** Create `lib/sms/scheduled-service.ts` (+test), `app/api/cron/sms-scheduled/route.ts` (+test), `app/api/sms/logs/[id]/cancel/route.ts` (+test); Modify `vercel.json`.

- [ ] **Step 1 `cancelScheduledCampaign(accountId: string | null, rawLogId, reason)`**: `parseLogId` (reuse from held-service), `rpc cancel_scheduled_sms_campaign({p_send_log_id,p_account_id,p_reason})`, map result: `cancelled`/`already_cancelled` → ok (`already` flag), `not_scheduled` → typed error NOT_SCHEDULED (409), `not_found` → 404; on success a customer notification (direct `notifications` insert like `held-service.notifyOwner`, type `sms_scheduled_cancelled`, fail-soft) only for the customer-initiated path (accountId not null) or for system cancel with reason text ("account suspended"). Never blocked by the kill switch. Tests: ok, idempotent, wrong account, not scheduled, notification failure doesn't fail.
- [ ] **Step 2 `runScheduledDispatch({limit = 50, deadlineMs})`**: (a) `isSmsEnabled()` false → return `{skipped:"sms_disabled"}` (due logs stay scheduled); (b) select due logs (`status='scheduled' AND scheduled_for <= now()`, limit) whose account `status='suspended'` and cancel each via `cancelScheduledCampaign(null, id, "account suspended")`; (c) `rpc sms_promote_due_scheduled({p_limit})` → for each promoted log: `claimPendingForLog` → `dispatchClaimed(..., log.sender_id, Date.now())`, stop starting new logs after the deadline (remaining promoted logs stay `queued` with pending messages: the existing drain sends them); return a summary `{promoted, dispatched, placed, cancelled}`. A throw inside one log never stops the others. Tests with fake db/rpc: due→promoted→dispatched; kill switch off; suspended→cancelled+refunded; deadline; concurrent promote returns none; dispatch failure leaves log queued for drain.
- [ ] **Step 3 cron route** `GET`, `verifyCronAuth`, `maxDuration = 300`, deadline `Date.now() + 100_000`, `{success:true,data}` / 500. `vercel.json` gains `{ "path": "/api/cron/sms-scheduled", "schedule": "* * * * *" }` (keep file formatting; add test or script asserting it parses).
- [ ] **Step 4 cancel route** `POST /api/sms/logs/[id]/cancel`: `resolveAccount`, id param Promise, `cancelScheduledCampaign(account.id, id, "cancelled by customer")`, JSON `{success,data:{cancelled:true,already?:true,refunded}}`; 409/404 mapping; tests incl. cross-account → 404.
- [ ] **Step 5:** vitest + tsc; commit.

### Task 5: Customer UI

**Files:** Modify `app/dashboard/sms/_lib/view.ts` (+tests in a NEW `view.schedule.test.ts`), `compose/page.tsx`, `_components/compose/*` (new `SchedulePicker.tsx`), `_components/records/{RecordsList,RecordDetail,StatusBadge}.tsx`.

- [ ] **Step 1 helpers (TDD, pure):** `scheduleBounds(now): {min: Date, max: Date}`; `toLocalInputValue(date)` / `fromLocalInputValue(str)` (datetime-local ⇄ ISO UTC; the picker shows **GMT** — Ghana is UTC+0, so local-input values are interpreted as UTC and labelled "GMT"); `scheduleError(valueIso, now)` reusing the same bounds wording as the server; `formatScheduled(iso)` ("12 Oct, 15:30 GMT"); add `scheduled` to `RECORD_CHIPS` (`{key:"scheduled",label:"Scheduled",values:["scheduled"]}`) and its `chipStatus` mapping; `sendOutcomeMessage` handles `scheduled` ("Scheduled for <time> — credits reserved. You can cancel from Records until then."); `ledgerLabel` for `campaign_refund` with `sched_cancel` unchanged (label text "Refund — campaign #N" is fine).
- [ ] **Step 2 Compose:** "Send later" Switch → `SchedulePicker` (datetime-local with min/max, error text, summary "Will be sent on …"); payload gains `scheduledAt` (ISO UTC) only when on and valid; Send button text "Schedule SMS"; disabled while the schedule is invalid. After success route to Records (chip Scheduled).
- [ ] **Step 3 Records:** "Scheduled" chip; rows with `status==='scheduled'` show "Scheduled for <formatScheduled>" and a Cancel button (AlertDialog: "Cancel this scheduled send? Credits for unsent messages will be refunded.") → `POST /api/sms/logs/{id}/cancel`, toast, reload; no polling for scheduled; `RecordDetail` shows a "Scheduled" alert with time and Cancel, hides delivery cards like `held`; cancelled logs (failed + review outcome) show "Cancelled" — expose a derived `cancelled` flag from `getRecord`/`listRecords` (tests).
- [ ] **Step 4:** vitest `app/dashboard/sms`, tsc; commit.

### Task 6: 4a gates, visual check, review, ship (controller)
- [ ] Review SQL line by line + diff re-created `sms_account_usage` vs `pg_get_functiondef`; apply `20261016` live; smoke-test in a rolled-back `DO` block (promote returns nothing for no due rows; cancel on a fabricated scheduled log in a txn that raises at the end).
- [ ] `tsc`, `npm run test:run`, placeholder-env `npx next build`; throwaway fixture preview (`app/preview-sms-customer/` pattern from Phase 3) for Compose (schedule picker), Records (chip + cancel), detail; screenshots 500 px + 1400 px; delete preview.
- [ ] Opus whole-4a review (money path: debit at schedule, refund on cancel, promote/dispatch races, kill switch interplay, v1 compat). Fix, re-review if material. Runbook section "Phase 4a". Push branch + main. Verify the new cron appears in the Vercel project (auto-deploy flaky; needs the user's token).

---

# Milestone 4b — Billed order confirmations

### Task 7: Migration + settings plumbing

**Files:** Create `migrations/20261017_order_confirmation_billing.sql`; Modify `app/api/shop/settings/[shopId]/route.ts` (+test).

- [ ] **Step 1 migration:** `ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS order_confirmation_use_own_sender BOOLEAN NOT NULL DEFAULT false;` and `CREATE TABLE IF NOT EXISTS sms_order_confirmations (shop_order_id UUID PRIMARY KEY, shop_id UUID, sms_account_id UUID, mode TEXT NOT NULL CHECK (mode IN ('billed','free')), send_log_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());` RLS enabled with no policies, `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, `GRANT ... TO service_role`. **Check the type of `shop_orders.id` (uuid vs bigint) in migrations before choosing the PK type** and match it.
- [ ] **Step 2 settings route:** GET select list (l.33), default (`false`), NULL→false, and PUT validation + update/insert lists accept `order_confirmation_use_own_sender` (boolean). **Turning it ON via this route is refused with 400 unless the shop's SMS account has an active own sender** (same rule as the new SMS endpoint — share one helper `canUseOwnSenderForConfirmations(shopId)` in `lib/sms/order-confirmation.ts`). Tests.
- [ ] Commit.

### Task 8: Order-confirmation service + fulfilment integration

**Files:** Create `lib/sms/order-confirmation.ts` (+test); Modify `app/api/fulfillment/process-order/route.ts`, `lib/sms/send-service.ts` only if needed (it already takes `opts.source`).

- [ ] **Step 1 `resolveConfirmationSender(shopId)`** → `{ useOwnSender: false } | { useOwnSender: true, accountId, userId, senderId }`: reads `shop_settings.order_confirmation_use_own_sender`; when true resolves the shop's `sms_accounts` row (by `user_shops.user_id`), requires `status='active'` and an active own sender via `loadDefaultSender`; any gap ⇒ `{useOwnSender:false}`. Never throws (errors ⇒ `{useOwnSender:false}`).
- [ ] **Step 2 `sendBilledConfirmation({ shopOrderId, shopId, accountId, userId, senderId, phone, message })`** → `{ status: "billed_sent" | "duplicate" | "fallback"; reason? }`: (1) `INSERT INTO sms_order_confirmations (shop_order_id, shop_id, sms_account_id, mode) VALUES (…,'billed') ON CONFLICT DO NOTHING RETURNING` — no row ⇒ return `duplicate` (caller sends NOTHING); (2) `enqueueSend(userId, accountId, message, [phone], undefined, senderId, undefined, undefined, { source: "order_confirmation" })`; ok ⇒ update the guard row `send_log_id`, return `billed_sent`; any `ok:false` (INSUFFICIENT_CREDITS, NOT_ACTIVATED, SUSPENDED, SMS_DISABLED, BLOCKED, …) or throw ⇒ update guard row `mode='free'` and return `fallback` (caller sends the free message); on INSUFFICIENT_CREDITS also write ONE `notifications` row per shop owner per day (type `sms_order_confirm_unbilled`, dedupe by checking an existing row today) — fail-soft. Tests: the full matrix (toggle off, no sender, inactive, success, duplicate order id, insufficient credits fallback + notification dedupe, throw ⇒ fallback, DB failure on guard insert ⇒ fallback).
- [ ] **Step 3 `process-order` integration** (l.423-512): replace the inline sender lookup (l.467-483) with `resolveConfirmationSender`. Flow when `!skipShopSms`: if `useOwnSender` ⇒ `sendBilledConfirmation`; `billed_sent`/`duplicate` ⇒ do not call `sendSMS`; `fallback` ⇒ call `sendSMS` WITHOUT `senderId` (free platform sender). If not `useOwnSender` ⇒ `sendSMS` exactly as the wallet/non-own-sender path (no `senderId`). **Behaviour change (intended, D5):** shops that previously got their own sender for free now go out from the platform sender until the toggle is on. Entire block stays inside the existing try/catch; nothing here can fail fulfilment. Tests via exported pure `decideConfirmationSend(...)` helper (the route file itself must only export HTTP handlers).
- [ ] **Step 4:** vitest `lib/sms app/api` + full tests + tsc; commit.

### Task 9: Customer API + UI

**Files:** Create `app/api/sms/order-confirmations/route.ts` (+test); Modify `app/dashboard/sms/page.tsx`, `app/dashboard/sms/_lib/{api,view}.ts`, `_components/records/*`, `lib/sms/customer-reads.ts`.

- [ ] **Step 1 route:** `GET` → `{success:true,data:{useOwnSender:boolean, canEnable:boolean, reason?:string}}` (`resolveAccount`; maps account → shop via `resolveShop`; `canEnable` = active own sender + active account); `PATCH {useOwnSender:boolean}` → validates, refuses ON when `!canEnable` (400 with a customer-readable reason), writes `shop_settings` (upsert by shop_id, service role), returns the new state. Non-shop accounts (e.g. platform owner) → `{useOwnSender:false, canEnable:false, reason}`. Tests.
- [ ] **Step 2 Home:** the `Switch` (page.tsx l.103-114) becomes live: loads state, optimistic toggle with rollback on error + toast, disabled with the reason text when `!canEnable`; helper text "Customers get your order confirmation from your own sender ID. Costs 1 credit per message." Remove "Coming soon". Pure helpers in `view.ts` (copy strings, `confirmationToggleState`) with tests.
- [ ] **Step 3 labels:** Records rows/detail show an "Order confirmation" tag when `source==='order_confirmation'` (list excludes them from the default "All"? **No** — show them, tagged); ledger label: debits whose send log has `source='order_confirmation'` show "Order confirmation SMS" (`getHomeSummary`/`listLedger` join or lookup by `send_log_id`; tests).
- [ ] **Step 4:** vitest, tsc; commit.

### Task 10: 4b gates, review, ship (controller)
- [ ] Review SQL; apply `20261017` live; verify `shop_settings` default and guard table privileges (service role only).
- [ ] Gates (tsc, tests, build); visual check of Home toggle (on/off/disabled states) + Records tag; delete preview.
- [ ] Opus whole-4b review (double-billing/double-send impossibility, fallback never silent-drops a confirmation, fulfilment never blocked, the D5 behaviour change). Fix. Runbook "Phase 4b" incl. the **announcement text** for shops that lose free own-sender confirmations. Push branch + main.

---

## Self-review (spec coverage)
- §3.1–3.2 scheduling → Tasks 1, 3. §3.3 dispatch cron → Task 4 (promote SQL in Task 1). §3.4 cancel → Tasks 1, 4. §3.5 UI → Task 5. §3.6 admin → no change (Messages already lists `scheduled`). §4.1 toggle → Tasks 7, 9. §4.2 send path/fallback/idempotency → Tasks 7–8. §4.3 UI → Task 9. §5 testing → per task + Tasks 6/10. §6 rollout → Tasks 6/10 + runbook. Dropped: "sent late" flag (see Deviation).
- Type consistency: `opts` param shape defined once in Task 3 and used by Task 8; `scheduled_for`/`source` columns (Task 1) read in Tasks 3, 5, 9; `parseLogId` and `dispatchClaimed`/`claimPendingForLog` (Task 2) used in Task 4; `canUseOwnSenderForConfirmations` (Task 7) shared with Task 9's route.
- Open items to resolve in-task, not guessed: `shop_orders.id` column type (Task 7); exact live `sms_account_usage` body (Task 1); whether `getHomeSummary`/ledger can cheaply label order-confirmation debits (Task 9 — fall back to the log's Records tag only if not).
