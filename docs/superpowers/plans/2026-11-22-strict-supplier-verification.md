# Strict Per-Supplier MTN Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Behind a new admin switch, an MTN order is only sent to a supplier that has itself approved the number, with per-supplier answers saved, held orders re-checked, checkout feeding answers, and a Send-dialog preview.

**Architecture:** A new `lib/strict-verify/` module (settings, saved per-supplier verdicts, a strict "ask one supplier" call, a send-candidate loop) is called from `createMTNOrderUnguarded`, the single funnel for every MTN send. Strict holds are recorded in their own table so the existing registration/whitelist releasers leave them alone, and a 5-minute cron re-checks and releases them. Everything is inert while the switch is off.

**Tech Stack:** Next.js 15 App Router, Supabase (service role), Postgres migration + PGlite tests, Vitest, React + shadcn.

**Spec:** `docs/superpowers/specs/2026-11-22-strict-supplier-verification-design.md` (approved 2026-11-22 19:45).

## Global Constraints

- Switch key `mtn_strict_supplier_verification` in `admin_settings`, value `{ enabled: boolean }`. Missing row = off. Read error = ON (fail safe: never send unchecked because a read failed).
- Switch off: every path behaves exactly as today (the removed old `mtn_whitelist_enabled` block is already off in prod).
- A supplier receives an MTN order only with a saved/fresh "yes" from THAT supplier. Yes valid 30 days; no valid 24 hours.
- Answer values: `"yes" | "no" | "no_answer"`. Timeout, error, rate limit, Hubnet cooldown, Hubnet "queued", a missing/unmatched result row = `no_answer`. Only definite answers are saved.
- Per-supplier check ≤ 5 s; whole send gate ≤ 10 s.
- Candidates: admin pin alone; else `getMTNProvider()` then `getRetrySequence()` (deduped). A supplier without a configured `WHITELIST_REGISTRY` entry, or listed in `mtn_disabled_providers`, cannot approve.
- Pin never re-routed. Refusal error types: `SUPPLIER_NOT_APPROVED` (message `"<Supplier> hasn't approved this number"`), `SUPPLIER_CHECK_UNAVAILABLE` (`"<Supplier> couldn't check this number right now"`). Order stays pending; no tracking row, no admin failure SMS/push, no retry_count bump.
- No supplier approved: `held: true`, `error_type: "STRICT_HOLD"`, `strictHoldReason` `"rejected"` (every candidate said no) or `"unanswered"` (at least one no_answer). An approved supplier whose send fails → next approved supplier; every approved send failed → normal failure (pending). OUTCOME_UNKNOWN → stop (unchanged).
- Strict holds: re-check unanswered every 5 min, rejected every 24 h; after 72 h from first hold → order back to `pending`, hold `expired`, auto-fulfil never picks it, admins told once (push, no phone). One customer SMS per order, exact copy: `DTGOD: Your MTN data order for <phone> is being checked with our suppliers and will be delivered automatically once approved.`
- Checkout blocking unchanged. With the switch on, checkout saves every definite per-supplier answer and asks the remaining checkout suppliers in the background after the response.
- No phone numbers in logs, push bodies or stored errors. Edit/Write only for code. Migration number **0194** (re-check origin/main before applying; never applied by implementers).

## Review Focus

1. A supplier echoes the number in another format (233… vs 0…): still matched; a missing row is no_answer, never no (Task 2).
2. The switch is turned off while orders are strict-held: the re-check cron releases them to today's normal dispatch (Task 5).
3. Two held orders for the same number: one approval releases both (Task 5).
4. A pinned supplier that is disabled or has no check: refused with `SUPPLIER_CHECK_UNAVAILABLE`, never sent (Task 3).
5. Hubnet cooldown during a burst: no_answer (not "no", not saved), next approved supplier or hold (Tasks 2, 3).

---

### Task 1: Migration 0194

**Files:** Create `migrations/0194_strict_supplier_verification.sql`, `migrations/0194_strict_supplier_verification.selftest.sql`, `lib/strict-verify/migration-0194.test.ts`, `lib/strict-verify/migration-0194-run.ts` (copy the 0193 pattern in `lib/auto-fulfil/migration-0193*.ts`: guarded `buildRunString`, `REQUIRE_PGLITE=1` fails loudly).

**Produces:**
- `mtn_supplier_verdicts (phone text, supplier text, verdict text CHECK IN ('yes','no'), checked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (phone, supplier))`; phone stored as `0XXXXXXXXX`.
- `mtn_strict_holds (order_table text CHECK IN ('orders','shop_orders','api_orders','ussd_orders','ussd_shop_orders'), order_id text, phone text NOT NULL, reason text NOT NULL CHECK IN ('rejected','unanswered'), state text NOT NULL DEFAULT 'open' CHECK IN ('open','released','expired'), held_at timestamptz NOT NULL DEFAULT now(), last_checked_at timestamptz, sms_sent boolean NOT NULL DEFAULT false, closed_at timestamptz, PRIMARY KEY (order_table, order_id))`, index `(state, last_checked_at)`, partial index `(phone) WHERE state = 'open'`.
- Both: RLS on, no policies, `REVOKE ALL FROM PUBLIC, anon, authenticated`, service_role SELECT/INSERT/UPDATE (+DELETE on verdicts). One transaction, idempotent, `lock_timeout 5s`, PRE-CHECK/VERIFY header comments.

- [ ] Step 1: PGlite tests (RED): both tables with their CHECKs (bad verdict/reason/state rejected); PK upsert; anon/authenticated cannot read; the selftest raises `SELFTEST_OK`; the run string has no COMMIT and leaves nothing behind.
- [ ] Step 2: `npx vitest run lib/strict-verify/migration-0194.test.ts` with PGlite (scratch install of `@electric-sql/pglite@0.2.17`, as in the auto-fulfil reports) — FAIL.
- [ ] Step 3: write the SQL and selftest (selftest only inserts/reads verdict and hold rows; no order rows).
- [ ] Step 4: PASS, also with `REQUIRE_PGLITE=1`.
- [ ] Step 5: commit `feat(mtn): migration 0194 for per-supplier verdicts and strict holds (not applied)`.

### Task 2: Strict-verify core

**Files:** Create `lib/strict-verify/settings.ts`, `lib/strict-verify/verdicts.ts`, `lib/strict-verify/ask.ts`, tests beside each.

**Produces:**
- `STRICT_VERIFY_KEY = "mtn_strict_supplier_verification"`; `isStrictVerifyOn(db: SupabaseClient): Promise<boolean>` (missing row false; read error true).
- `type Answer = "yes" | "no" | "no_answer"`; `YES_TTL_MS = 30 * 86_400_000`; `NO_TTL_MS = 86_400_000`.
- `getFreshVerdicts(db, phone: string, suppliers: string[], now: Date): Promise<Map<string, "yes" | "no">>` (fresh rows only; phone via `normalizeGhanaPhone`; read error → empty map).
- `saveVerdicts(db, rows: { phone: string; supplier: string; verdict: "yes" | "no" }[], now: Date): Promise<void>` (upsert on PK; errors logged without phone; never throws).
- `canCheck(supplier: string, disabled: Set<string>): boolean` (registry entry exists, `configured()`, not disabled).
- `askSupplier(supplier: string, phone: string, opts?: { timeoutMs?: number }): Promise<Answer>` — the entry's `checkBatchStrict([phone])`, default timeout 5000 ms; match rows by `normalizePhoneNumber`; matched `allowed:true` → yes, matched `allowed:false` → no; throw, timeout, no matching row → no_answer.

- [ ] Step 1: tests (RED): switch missing/false/true/read error; yes fresh at 29 d, stale at 31 d; no fresh at 23 h, stale at 25 h; askSupplier allowed true → yes, false → no; a row echoed as `233…` for a `0…` input matches; empty result → no_answer; throw → no_answer; slower than timeout → no_answer; Hubnet strict batch throwing (cooldown/queued) → no_answer; no phone in any console call.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS.
- [ ] Step 5: commit `feat(mtn): strict-verify settings, saved per-supplier verdicts and a strict supplier ask`.

### Task 3: Strict send gate

**Files:** Create `lib/strict-verify/send.ts` + test. Modify `lib/mtn-fulfillment.ts` (`createMTNOrderUnguarded`: call the gate; delete the old `mtn_whitelist_enabled` block and its auto-switch), `lib/mtn-providers/types.ts` (error types `STRICT_HOLD`, `SUPPLIER_NOT_APPROVED`, `SUPPLIER_CHECK_UNAVAILABLE`; optional `strictHoldReason?: "rejected" | "unanswered"` on `MTNOrderResponse`), `lib/mtn-fulfillment.test.ts` (remove old whitelist-block tests, add switch-off parity).

**Produces:** `strictSend(order: MTNOrderRequest, deps: StrictSendDeps): Promise<MTNOrderResponse>` with `StrictSendDeps = { candidates: string[]; pinned: boolean; disabled: Set<string>; fresh(phone: string, suppliers: string[]): Promise<Map<string, "yes"|"no">>; ask(supplier: string, phone: string): Promise<Answer>; save(rows): Promise<void>; send(supplier: string, order: MTNOrderRequest): Promise<MTNOrderResponse>; budgetMs: number }`. In `createMTNOrderUnguarded`, after the registration gate: `if (await isStrictVerifyOn(supabase)) return strictSend(order, realDeps)`; otherwise today's path minus the deleted block.

Per candidate in order: `!canCheck` → no_answer; saved yes → send; saved no → skip; else ask while the gate budget lasts (else no_answer), save a definite answer, yes → send. Send outcome: success → return (with `provider`); OUTCOME_UNKNOWN → return; other failure → note "an approved send failed" and continue. After the loop: an approved send failed → return the last failure; else STRICT_HOLD with `strictHoldReason`. Pinned: only that supplier; no → SUPPLIER_NOT_APPROVED; no_answer (incl. cannot check) → SUPPLIER_CHECK_UNAVAILABLE; never another supplier.

- [ ] Step 1: tests (RED), fake deps: switch off → today's path (createOrder called, no ask); primary approved → only primary sent; primary no + sequence approved → sequence sent, primary never sent; primary approved send fails "insufficient balance" + sequence approved → sequence; primary approved send fails + sequence no → normal failure, not held; all no → STRICT_HOLD "rejected"; one no_answer → "unanswered"; OUTCOME_UNKNOWN stops; pinned approved → sent; pinned no → SUPPLIER_NOT_APPROVED and nobody else asked or sent; pinned disabled or without a check → SUPPLIER_CHECK_UNAVAILABLE; supplier without a check in the sequence skipped; fresh saved yes → no ask call; budget used up → remaining no_answer.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS plus `lib/mtn-fulfillment.test.ts`, `lib/mtn-providers`.
- [ ] Step 5: commit `feat(mtn): strict per-supplier gate for every MTN send (switch off by default)`.

### Task 4: Strict holds, pin refusals, releaser isolation

**Files:** Modify `lib/mtn-hold.ts`, `lib/sms-service.ts`, every `holdMtnOrder(` call site (`grep -rn "holdMtnOrder(" lib app`), `lib/fulfillment-service.ts`, and any other `createMTNOrder` caller that can pass an explicit provider.

**Produces:** `holdMtnOrder({ table, orderId, phone, errorType?: string, strictReason?: "rejected" | "unanswered" })`; `isStrictHeld(db, table, orderId): Promise<boolean>`; `SMSTemplates.mtnStrictHold(phone)` with the exact copy from Global Constraints.

Rules: `errorType === "STRICT_HOLD"` → same guarded status update; upsert `mtn_strict_holds` (open, reason; keep `held_at` if already open); send `mtnStrictHold` only if `sms_sent` was false, then set it true. Other errorTypes → unchanged (registration SMS). `releaseHeldMtnOrders`, `releaseWhitelistHeldOrders`, `getHeldOrderPhones` skip orders with an open strict hold. `processManualFulfillment`: `SUPPLIER_NOT_APPROVED` / `SUPPLIER_CHECK_UNAVAILABLE` → revert the lock to pending and return `{ success: false, message }` before any tracking write, retry_count change or admin alert. Every other caller with an explicit provider (v1/v2/USSD overrides, payment-attempts): the refusal leaves the order pending, never refunded or failed; list each in the report.

- [ ] Step 1: tests (RED): strict hold writes the hold row and one SMS; a second strict hold for the same order sends no SMS and keeps `held_at`; non-strict hold unchanged; each releaser skips an open strict hold and still releases a registration hold; refusal in `processManualFulfillment` → pending, no tracking insert, no `notifyAdmins` / `notifyAdminsPush`; a coverage test that every `holdMtnOrder(` call site passes `errorType`.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS plus `lib/fulfillment-service`, `lib/ussd`, `lib/fulfillment-queue-drain.test.ts`.
- [ ] Step 5: commit `feat(mtn): strict holds with one customer SMS, clean pin refusals, releasers skip strict holds`.

### Task 5: Strict re-check cron

**Files:** Create `lib/strict-verify/recheck.ts` + test, `app/api/cron/mtn-strict-recheck/route.ts` + test (`verifyCronAuth`, `backgroundCron`, `maxDuration = 300`). Modify `lib/cron-migration/crons.json` (add `{ "path": "/api/cron/mtn-strict-recheck", "schedule": "*/5 * * * *" }`), `lib/cron-migration/jobs.ts` (classify; overlap-safe via guarded claims), `lib/auto-fulfil/run.ts` (skip candidates with an `expired` strict hold as `skipped.strict_hold_expired`).

**Produces:** `runStrictRecheck(db, now: Date): Promise<{ checked: number; released: number; expired: number; stillHeld: number }>`. Load up to 500 open holds, oldest `last_checked_at` first (nulls first). Switch off → release every open hold (guarded held→pending, state released) and dispatch unpinned. Else per hold: `held_at` older than 72 h → guarded held→pending, state expired, counted into one admin push `"<n> MTN orders could not be verified for 72 hours — check Needs action"`; due (unanswered: last check ≥ 5 min; rejected: ≥ 24 h) → per Task 3 candidate (fresh verdict or `askSupplier`, save), set `last_checked_at` and reason; any yes → release every open hold for that phone and dispatch each with `processManualFulfillment(orderId, type)` or `fulfillUssdOrder(id, network, phone, size, false, table)` (unpinned; the gate picks the approved supplier). An order no longer `held_registration` → close its hold (released) without dispatch. Stop asking Hubnet for the rest of the run after its first no_answer.

- [ ] Step 1: tests (RED): switch off releases all; one approval releases both orders for a phone; rejected not re-asked before 24 h; unanswered re-asked after 5 min; 72 h → pending + expired + one push with no phone; closed when the order moved on; auto-fulfil skips an expired strict hold; route without cron auth → 401.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS.
- [ ] Step 5: commit `feat(mtn): 5-minute strict re-check releases approved holds and expires them after 72 h`.

### Task 6: Checkout feeds per-supplier answers

**Files:** Modify `lib/mtn-providers/customer-verification.ts` + tests.

Rules: the wrapped registry in `resolveVerdicts` also records each supplier's definite per-number results (matched `allowed:true` → yes, `allowed:false` → no). In `verifyRecipientsForOrder`, when `isStrictVerifyOn`: save those answers (`saveVerdicts`), then defer (the file's existing `after()`/`defer` mechanism) a task that asks every remaining checkout supplier without a fresh verdict (`askSupplier`) and saves definite answers. The returned verdicts and blocking are computed exactly as today and never wait for the deferred task. Switch off → no saving, no deferred task.

- [ ] Step 1: tests (RED): switch on, first supplier yes → returns without calling the second synchronously; the deferred task asks the second and saves; main-check answers saved; a fresh saved answer is not re-asked; blocking unchanged for no/no, yes/–, no_answer/no_answer; switch off → no save, no defer; deferred errors never throw.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS plus all existing customer-verification tests.
- [ ] Step 5: commit `feat(mtn): checkout saves per-supplier answers and checks the rest in the background`.

### Task 7: Settings API and MTN settings card

**Files:** Create `app/api/admin/settings/strict-supplier-verify/route.ts` + test. Modify `app/admin/settings/mtn/page.tsx` (new card; remove the old "MTN whitelist check" toggle and "Whitelist Auto-Switch Providers" card, replaced by a one-line note pointing at the new switch). Delete the old `mtn-whitelist` / `mtn-whitelist-switch` routes and tests only if nothing else reads them; otherwise leave them.

**Produces:** `GET` → `{ enabled: boolean; warnings: string[] }`; warnings name each sending supplier (primary + retry sequence) that cannot check, e.g. `"Hubnet can't check numbers right now, so it will receive no MTN orders in strict mode"`. `PUT { enabled }` → `verifyAdminAccess` + uuid `userId` (else 403 `admin_user_required`), upsert with `updated_by`, log the admin id only. Card: switch "Strict supplier verification", description "Only send an MTN order to a supplier that has approved the number itself", confirm dialog on turning on, warnings listed, navy accent, `lg:` layout matching the page.

- [ ] Step 1: tests (RED): non-admin rejected; cron-secret PUT → 403; non-boolean → 400; warnings for a sending supplier without a check; no raw DB error text returned.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS; `npx tsc --noEmit` clean for touched files.
- [ ] Step 5: commit `feat(mtn): strict supplier verification switch on MTN settings`.

### Task 8: Send-dialog approval preview

**Files:** Create `lib/order-queue/approval-preview.ts` + test, `app/api/admin/fulfillment/approval-preview/route.ts` + test. Modify `components/admin/order-queue/send-confirm-dialog.tsx`, `app/admin/order-payment-status/page.tsx`.

**Produces:** `POST { orders: { id: string; type: OrderType }[] (≤ 200, uuid ids), supplier: string }` (admin only) → `{ enabled: boolean; counts: { approved: number; notApproved: number; notChecked: number }; perOrder: { id: string; status: "approved" | "not_approved" | "not_checked" }[] }`, from SAVED verdicts only (`getFreshVerdicts`; never calls a supplier); switch off → `enabled: false` and the dialog shows nothing new. Dialog line `"<Supplier>: 40 approved · 7 not approved · 3 not checked yet"` and a button `"Remove the 7 not approved"` that deselects them.

- [ ] Step 1: tests (RED): counts from saved verdicts; stale yes → not_checked; no supplier call; switch off → enabled false; invalid id → 400; non-admin rejected; dialog shows the line and button only when enabled.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS.
- [ ] Step 5: commit `feat(mtn): Send-to-supplier dialog previews the supplier's saved approvals`.

---

## Release (controller)

Final whole-branch review (most capable model) + security review; placeholder-env `next build` + full vitest compared with a clean main; owner OK → guarded 0194 dry run → owner OK → apply + verify → owner OK → push (switch off) → create + enable the `mtn-strict-recheck` cron-job.org job (inert while off) → owner turns the switch on; watch holds, refusals and Hubnet cooldowns.
