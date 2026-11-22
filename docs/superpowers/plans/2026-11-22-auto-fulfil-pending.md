# Auto-fulfil Pending Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A server cron, with an on/off switch and settings on Order Payment Status, that queues paid pending orders for fulfilment automatically, age-gated so it can never catch an order mid-send.

**Architecture:** A per-minute cron reads settings from `admin_settings`, asks one SQL function for age-gated candidates, applies a pure policy (retry table, tries, history, blacklist, existing network switches), and inserts `fulfillment_queue` rows marked `source = 'auto'`. The existing drain sends them, capped per tick, re-checking the switch, without per-order alerts, and records each automatic outcome. Everything ships with the switch off.

**Tech Stack:** Next.js 15 App Router routes, Supabase (service role), Postgres SQL migration + PGlite tests, Vitest, React + shadcn UI.

**Spec:** `docs/superpowers/specs/2026-11-22-auto-fulfil-pending-design.md` (approved 2026-11-22 12:18).

## Global Constraints

- Ships **switched off**. Unreadable or invalid settings = off (fail closed).
- Age gate: order created ≥ `minAgeMinutes` ago AND no `fulfillment_queue` row (any source/status) with `enqueued_at`, `last_attempted_at` or `completed_at` inside the window AND no `mtn_fulfillment_tracking` row (`created_at`) or `fulfillment_logs` row (`updated_at`) inside it. `minAgeMinutes` bounds 10–120, default 10.
- Defaults: networks `["MTN","Telecel","AT - iShare","AT - BigTime"]`; `perRun` 20 (1–100); `maxAgeDays` 7 (1–30); retry table exactly as the spec (rate_limited yes 2 min ×5; out_of_balance yes 30 min ×5; supplier_unavailable yes 30 min ×5; not_enabled yes 24 h ×3; no_bundle no; wrong_number no; rejected yes 60 min ×3). Waits 1 min–7 days, tries 1–20.
- Never automatic: outcome_unknown/held, reversed, completed, live attempt, already queued, any order that ever had a held (`abandoned` or `UNKNOWN_` id) or `reversed` tracking row, plain "AirtelTigo"/unmapped networks, blacklisted phones, unclassified failures.
- Existing switches win: MTN skipped when `mtn_auto_fulfillment_enabled` is not true; a non-MTN network skipped unless `auto_fulfillment_enabled.value.enabled` is true and the network is in its `networks` list.
- Tries count automatic sends only; wait measured from the latest failure, whoever sent it.
- Admin-queued rows (`source = 'admin'`) are never cancelled, capped or changed by this feature.
- No phone numbers in logs, alerts, the attempts table or API responses. Logs carry ids and counts only.
- Settings writes need `verifyAdminAccess` AND a uuid `userId` (the cron-secret bypass has none → 403).
- Code edits with Edit/Write only, never sed or scripted rewrites.
- Migration number **0193** (re-check `origin/main` before applying; bump if taken). The migration is NOT applied by the implementer.

## Review Focus

1. An order refused at purchase with no tracking or queue row: treated as never tried and queued after the age gate (test in Task 3).
2. An admin queues an order while a cron run is mid-flight: the 0191 unique index makes the cron insert 23505, counted as skipped, not an error (test in Task 4).
3. Switching off while automatic rows wait: they are cancelled within the next minute and the drain refuses any it already claimed (tests in Tasks 4 and 5).
4. Settings JSON partly missing/garbled in the DB (old shape, wrong types): treated as off, panel shows defaults with an "invalid settings" note, never a 500 (tests in Tasks 1 and 6).
5. The drain nears its 300 s limit with claimed rows left: they go back to `pending` unsent, never marked failed (test in Task 5).

---

### Task 1: Settings model

**Files:**
- Create: `lib/auto-fulfil/settings.ts`
- Test: `lib/auto-fulfil/settings.test.ts`

**Interfaces:**
- Produces:
  - `type RetryBucket = "rate_limited" | "out_of_balance" | "supplier_unavailable" | "not_enabled" | "no_bundle" | "wrong_number" | "rejected"`
  - `type RetryRule = { retry: boolean; waitMinutes: number; maxTries: number }`
  - `type AutoFulfilSettings = { enabled: boolean; minAgeMinutes: number; maxAgeDays: number; perRun: number; networks: string[]; rules: Record<RetryBucket, RetryRule> }`
  - `const AUTO_FULFIL_SETTINGS_KEY = "auto_fulfil_pending"`
  - `const AUTO_FULFIL_NETWORKS = ["MTN","Telecel","AT - iShare","AT - BigTime"]`
  - `const DEFAULT_AUTO_FULFIL_SETTINGS: AutoFulfilSettings` (enabled false)
  - `parseAutoFulfilSettings(raw: unknown): { ok: true; value: AutoFulfilSettings } | { ok: false; error: string }` — strict: every field present and in bounds (integers only); networks a non-empty subset of `AUTO_FULFIL_NETWORKS`; all 7 buckets present; a rule with `retry: false` still carries numbers in bounds.
  - `loadAutoFulfilSettings(db: SupabaseClient): Promise<{ settings: AutoFulfilSettings; valid: boolean }>` — missing row → defaults, valid true; read error or parse failure → defaults with `enabled: false`, valid false.

- [ ] **Step 1: Write the failing tests**

```ts
it("defaults are off and match the spec table", () => {
  expect(DEFAULT_AUTO_FULFIL_SETTINGS.enabled).toBe(false)
  expect(DEFAULT_AUTO_FULFIL_SETTINGS.minAgeMinutes).toBe(10)
  expect(DEFAULT_AUTO_FULFIL_SETTINGS.rules.rate_limited).toEqual({ retry: true, waitMinutes: 2, maxTries: 5 })
  expect(DEFAULT_AUTO_FULFIL_SETTINGS.rules.not_enabled).toEqual({ retry: true, waitMinutes: 1440, maxTries: 3 })
  expect(DEFAULT_AUTO_FULFIL_SETTINGS.rules.no_bundle.retry).toBe(false)
  expect(DEFAULT_AUTO_FULFIL_SETTINGS.rules.wrong_number.retry).toBe(false)
})
it.each([9, 121, 10.5, "10"])("rejects minAgeMinutes %s", (v) =>
  expect(parseAutoFulfilSettings({ ...DEFAULT_AUTO_FULFIL_SETTINGS, minAgeMinutes: v }).ok).toBe(false))
it("rejects waits under 1 min or over 10080, tries outside 1-20, perRun outside 1-100, maxAgeDays outside 1-30")
it("rejects unknown networks, empty networks, a missing bucket, a non-boolean enabled")
it("loadAutoFulfilSettings: garbled row => enabled false, valid false")
it("loadAutoFulfilSettings: read error => enabled false, valid false")
it("loadAutoFulfilSettings: no row => defaults, valid true")
```

- [ ] **Step 2: Run** `npx vitest run lib/auto-fulfil/settings.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `lib/auto-fulfil/settings.ts` with the interfaces above. Read with `.from("admin_settings").select("value").eq("key", AUTO_FULFIL_SETTINGS_KEY).maybeSingle()`.
- [ ] **Step 4: Run** the tests — expect PASS.
- [ ] **Step 5: Commit** `feat(auto-fulfil): settings model with fail-closed loading`

---

### Task 2: Migration 0193 (schema + candidate function + split claim)

**Files:**
- Create: `migrations/0193_auto_fulfil.sql`, `migrations/0193_auto_fulfil.selftest.sql`
- Create: `lib/auto-fulfil/migration-0193.test.ts` (PGlite, following `lib/order-queue/migration-0191.test.ts` and `migration-0191-run.ts`)

**Interfaces:**
- Produces (one transaction, idempotent, `lock_timeout 5s`, header with PRE-CHECK and VERIFY like 0191):
  - `ALTER TABLE fulfillment_queue ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin','auto'))`.
  - `auto_fulfil_runs (id uuid pk default gen_random_uuid(), started_at timestamptz not null default now(), finished_at timestamptz, queued int not null default 0, waiting int not null default 0, needs_you int not null default 0, skipped jsonb not null default '{}', summary_sent boolean not null default false, error text)`.
  - `auto_fulfil_attempts (id uuid pk, run_id uuid not null references auto_fulfil_runs(id), queue_id uuid not null, order_id text not null, order_type text not null, outcome text, created_at timestamptz not null default now(), finished_at timestamptz)`; `outcome` NULL until the drain records it, else one of `'sent','rate_limited','out_of_balance','supplier_unavailable','not_enabled','no_bundle','wrong_number','rejected','unclassified','held','skipped'` (CHECK). Index `(order_id, created_at desc)`. No message or phone column.
  - `auto_fulfil_settings_log (id uuid pk, admin_id uuid not null, old_value jsonb, new_value jsonb not null, created_at timestamptz not null default now())`.
  - All three: RLS on, no policies, `REVOKE ALL FROM PUBLIC, anon, authenticated`, needed rights granted to `service_role`.
  - `auto_fulfil_candidates(p_min_age_minutes int, p_max_age_days int, p_networks text[], p_scan int) RETURNS TABLE(id text, type text, network text, phone_number text, created_at timestamptz)` — `SECURITY INVOKER`, `SET statement_timeout = '20s'`, EXECUTE only for service_role. Reads `combined_orders_view`: `status = 'pending'`, `created_at` between `now() - p_max_age_days days` and `now() - p_min_age_minutes minutes`, `network = ANY(p_networks)`, and the three NOT EXISTS quiet-window checks from Global Constraints (tracking matched on `order_id`, `shop_order_id`, `api_order_id`; `fulfillment_logs.order_id::text`). Order `created_at ASC`, `LIMIT p_scan`. Confirm the view only exposes paid shop/USSD rows; if not, filter `payment_status = 'completed'` for those types.
  - `claim_fulfillment_queue_split(p_limit int, p_auto_limit int) RETURNS SETOF fulfillment_queue` — same claim semantics as `claim_fulfillment_queue` (FOR UPDATE SKIP LOCKED, processing, attempt_count+1, last_attempted_at now()), at most `p_auto_limit` claimed rows with `source = 'auto'`, oldest `enqueued_at` first, total ≤ `p_limit`. `claim_fulfillment_queue` untouched.

- [ ] **Step 1: Write the failing PGlite tests**

```ts
it("candidates: pending paid order 11 min old with no activity is returned; 9 min old is not")
it("candidates: a queue row completed 5 min ago hides the order; one completed 15 min ago does not")
it("candidates: a tracking row created 5 min ago (via shop_order_id) hides the order")
it("candidates: unpaid shop order, non-pending order, order older than max age, network not in list => not returned")
it("claim split: 10 auto + 10 admin pending, p_limit 20 p_auto_limit 5 => 5 auto + 10 admin claimed")
it("claim split: claimed rows are processing with attempt_count 1")
it("existing fulfillment_queue rows get source 'admin'; source 'other' is rejected")
it("anon and authenticated cannot read the three tables or execute auto_fulfil_candidates")
```

- [ ] **Step 2: Run** `npx vitest run lib/auto-fulfil/migration-0193.test.ts` — expect FAIL.
- [ ] **Step 3: Write** both SQL files. The selftest runs inside `BEGIN … ROLLBACK`, seeds rows that satisfy prod NOT NULL/FK (e.g. `orders.user_id`), and raises on any wrong result.
- [ ] **Step 4: Run** the tests — expect PASS.
- [ ] **Step 5: Commit** `feat(auto-fulfil): migration 0193 (not applied)`

---

### Task 3: Policy (pure)

**Files:**
- Create: `lib/auto-fulfil/policy.ts`, `lib/auto-fulfil/policy.test.ts`
- Modify: `lib/order-queue/failure-reason.ts` (extract `classifyMessage`, refactor only)

**Interfaces:**
- Consumes: Task 1 types; `Verdict` (`lib/order-queue/eligibility.ts`); `classifyFailureReason` (`lib/order-queue/failure-reason.ts`).
- Produces:
  - `classifyMessage(message: string | null): FailureReason | null` in `failure-reason.ts` — the keyword rules only; `classifyFailureReason` uses it (existing tests stay green).
  - `type FailureEvent = { at: string; source: "tracking" | "queue"; status: string | null; mtnOrderId: string | null; message: string | null }`
  - `type LatestFailure = { bucket: RetryBucket | "unclassified" | "outcome_unknown"; at: string } | null`
  - `latestFailure(events: FailureEvent[]): LatestFailure` — newest event that is a failure wins. Tracking event → `classifyFailureReason` (`none` = not a failure, ignored). Queue event with status `failed` → `classifyMessage(message) ?? "unclassified"` (a queue message alone is not proof of a definite refusal). No failures → `null`.
  - `type CandidateFacts = { verdict: Verdict; everHeldOrReversed: boolean; failure: LatestFailure; autoTries: number; blacklisted: boolean; networkSwitchOn: boolean }`
  - `type Decision = { kind: "queue" } | { kind: "wait"; until: string } | { kind: "needs_you"; reason: string } | { kind: "skip"; reason: string }`
  - `decideCandidate(f: CandidateFacts, s: AutoFulfilSettings, now: Date): Decision` — first match wins: verdict not `eligible` → skip(blocked reason, or "risky"); `blacklisted` → skip("blacklisted"); `!networkSwitchOn` → skip("network_switch_off"); `everHeldOrReversed` → needs_you("held_or_reversed_history"); failure null → queue; `outcome_unknown` → needs_you("outcome_unknown"); `unclassified` → needs_you("unclassified"); `!rule.retry` → needs_you(bucket); `autoTries >= rule.maxTries` → needs_you("out_of_tries"); `now < at + waitMinutes` → wait(until ISO); else queue.

- [ ] **Step 1: Write the failing tests** — one per branch above, plus:

```ts
it("never-tried order (no events) is queued")
it("rate_limited 1 min ago waits until +2 min")          // toEqual({ kind: "wait", until: iso(+1) })
it("rejected with 3 auto tries => needs_you out_of_tries")
it("queue message 'Insufficient balance' => out_of_balance; 'socket hang up' => unclassified")
it("tracking row abandoned newer than a failed one => outcome_unknown")
it("admin tries are not counted: autoTries 0 after admin failures => queued once the wait passes")
```

- [ ] **Step 2: Run** `npx vitest run lib/auto-fulfil/policy.test.ts lib/order-queue/failure-reason.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(auto-fulfil): pure retry policy`

---

### Task 4: Run engine + cron route

**Files:**
- Create: `lib/auto-fulfil/run.ts`, `lib/auto-fulfil/run.test.ts` (fake-db pattern: `lib/order-queue/fake-db.test-helper.ts`)
- Create: `app/api/cron/auto-fulfil-pending/route.ts`, `app/api/cron/auto-fulfil-pending/route.test.ts`
- Modify: `lib/cron-migration/crons.json` (add `{ "path": "/api/cron/auto-fulfil-pending", "schedule": "* * * * *" }`)

**Interfaces:**
- Consumes: Tasks 1–3; `loadSnapshots` (`lib/order-queue/load-snapshots.ts`); `judgeOrder` + the auto-mode capability trick from `lib/order-queue/enqueue.ts#judge` (first provider of `getProviderOptionsForNetwork(network)`); `findBlacklistedPhones` (`lib/blacklist.ts`); `notifyAdminsPush` (`lib/push-service`).
- Produces:
  - `type RunSummary = { ran: boolean; reason?: "off" | "invalid_settings"; runId?: string; queued: number; waiting: number; needsYou: number; skipped: Record<string, number>; cancelled: number }`
  - `runAutoFulfil(db: SupabaseClient, now?: Date): Promise<RunSummary>`
  - `cancelWaitingAutoRows(db: SupabaseClient): Promise<number>` — `fulfillment_queue` rows with `source='auto' AND status='pending'` → `status='failed', error_message='auto-fulfil switched off'`.

  `runAutoFulfil`: load settings; invalid or off → `cancelWaitingAutoRows`, return `ran: false`. Read both existing switches. Insert an `auto_fulfil_runs` row. RPC `auto_fulfil_candidates(minAge, maxAge, networks, 300)`. `loadSnapshots`. History reads (chunked ≤100 ids, paged): tracking rows (for `everHeldOrReversed` and tracking failure events), failed queue rows (`at = completed_at ?? last_attempted_at ?? enqueued_at`), `auto_fulfil_attempts` count per order excluding outcome `skipped`. `findBlacklistedPhones` (phones stay in memory). `decideCandidate` per candidate; insert `queue` decisions oldest first up to `perRun`, one at a time: `fulfillment_queue { batch_id: runId, order_id, order_type, provider: null, source: 'auto' }`; 23505 → `skipped.already_queued`; other insert error → `skipped.insert_failed` (logged with order id only); success → `auto_fulfil_attempts` row (outcome null, `queue_id` = inserted id). Update the run row with counts and `finished_at`. A thrown read → run row `error` set, rethrow (route 500).
  - Summary push: when `needsYou > 0` and no run in the last 60 minutes has `summary_sent = true` → `notifyAdminsPush({ title: "Auto-fulfil", body: \`${n} orders need you on Order Payment Status\`, data: { url: "/admin/order-payment-status" } })`, set `summary_sent = true`. No phone or order detail.
  - Route: `GET`, `verifyCronAuth`, `maxDuration = 60`, service-role client, returns `RunSummary`; logs counts only.

- [ ] **Step 1: Write the failing tests**

```ts
it("off => cancels waiting auto rows only (admin pending row untouched), queues nothing")
it("invalid settings => same as off")
it("queues eligible candidates up to perRun, oldest first, source 'auto', provider null")
it("23505 on insert => skipped.already_queued, no attempt row, run continues")
it("MTN skipped when mtn_auto_fulfillment_enabled is false; Telecel skipped when not in auto_fulfillment_enabled.networks")
it("blacklisted phone skipped; no phone appears in any console call")   // spy console.*
it("summary push sent at most once per 60 min when needsYou > 0")
it("candidate RPC error => run row error set, route returns 500")
it("route rejects requests without cron auth")
```

- [ ] **Step 2: Run** `npx vitest run lib/auto-fulfil/run.test.ts app/api/cron/auto-fulfil-pending` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(auto-fulfil): run engine and cron route`

---

### Task 5: Drain changes

**Files:**
- Modify: `lib/fulfillment-queue-drain.ts`; `lib/fulfillment-service.ts` (the failure SMS/push blocks near lines 241–253 and ~360); `lib/ussd/fulfill.ts` (signature pass-through)
- Test: `lib/fulfillment-queue-drain.test.ts` (create if absent); existing fulfillment-service and ussd tests stay green

**Interfaces:**
- Consumes: `loadAutoFulfilSettings` (Task 1), `classifyMessage` (Task 3), `claim_fulfillment_queue_split` (Task 2).
- Produces:
  - `processManualFulfillment(orderId, orderType, provider?, skipSms = false, opts: { suppressFailureAlerts?: boolean } = {})` — when true, the per-failure admin SMS and push are not sent. Nothing else changes.
  - `fulfillUssdOrder(orderId, network, recipientPhone, packageSize, forceManual, orderTable, provider?, opts: { suppressFailureAlerts?: boolean } = {})` — accepted and forwarded to any failure alert (none today).
  - Drain constants `AUTO_PER_TICK = 5`, `TIME_BUDGET_MS = 240_000`.

  Behaviour: claim with `claim_fulfillment_queue_split(BATCH_SIZE, AUTO_PER_TICK)`. Before each row, if elapsed > `TIME_BUDGET_MS`, set that row and every remaining claimed row back to `status='pending'` and stop. For `source='auto'` rows: settings loaded once per tick; not enabled (or invalid) → `skipRow(..., "auto-fulfil switched off")`, attempt outcome `skipped`; otherwise call the fulfil function with `suppressFailureAlerts: true`, then set the attempt row (`queue_id = row.id`) `outcome` + `finished_at`: success → `sent`; `result.held` → `held`; failure → `classifyMessage(msg) ?? "unclassified"`; skipped before the send → `skipped`. Attempt-row write failures are logged (ids only) and never change the queue outcome. Admin rows behave exactly as today.

- [ ] **Step 1: Write the failing tests**

```ts
it("claims via claim_fulfillment_queue_split(20, 5)")
it("auto row with switch off: no supplier call, row failed 'auto-fulfil switched off', attempt outcome 'skipped'")
it("auto row failure 'Rate limit exceeded' => attempt outcome rate_limited, fulfil called with suppressFailureAlerts")
it("admin row is called without suppressFailureAlerts")
it("rows left after the time budget go back to pending unsent")
it("processManualFulfillment with suppressFailureAlerts sends neither notifyAdmins nor notifyAdminsPush on failure")
```

- [ ] **Step 2: Run** `npx vitest run lib/fulfillment-queue-drain.test.ts lib/fulfillment-service` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** those plus `lib/order-queue` and `lib/ussd` — expect PASS.
- [ ] **Step 5: Commit** `feat(auto-fulfil): drain caps auto rows, re-checks the switch, records outcomes quietly`

---

### Task 6: Settings API

**Files:**
- Create: `app/api/admin/auto-fulfil/route.ts`, `app/api/admin/auto-fulfil/route.test.ts`

**Interfaces:**
- Consumes: Task 1; `cancelWaitingAutoRows` (Task 4); `verifyAdminAccess`.
- Produces:
  - `GET` → `{ settings, valid, switches: { mtn: boolean; nonMtn: { enabled: boolean; networks: string[] } }, lastRun: { startedAt, finishedAt, queued, waiting, needsYou, error } | null, waitingAutoRows: number }`. Admin only; no phones or order ids.
  - `PUT` body = full `AutoFulfilSettings` → `parseAutoFulfilSettings`; 400 `{ error }` on failure (nothing written); requires a uuid `userId` else 403 `{ error: "admin_user_required" }`; upserts `admin_settings { key, value, updated_by: userId }` (match the existing upsert shape used by `app/api/admin/settings/auto-fulfillment/route.ts`); inserts `auto_fulfil_settings_log`; when `enabled` is false calls `cancelWaitingAutoRows`; returns the GET shape.

- [ ] **Step 1: Write the failing tests**

```ts
it("GET and PUT return the verifyAdminAccess error for non-admins")
it("PUT with cron-secret auth (no userId) => 403 admin_user_required")
it("PUT with minAgeMinutes 5 => 400, nothing written")
it("PUT valid => admin_settings upserted, log row with old and new values")
it("PUT enabled:false => waiting auto rows cancelled")
it("GET with garbled stored settings => 200, valid false, defaults returned")
```

- [ ] **Step 2: Run** `npx vitest run app/api/admin/auto-fulfil` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(auto-fulfil): admin settings API with audit log`

---

### Task 7: Panel on Order Payment Status

**Files:**
- Create: `components/admin/order-queue/auto-fulfil-panel.tsx`, `lib/auto-fulfil/panel-format.ts`, `lib/auto-fulfil/panel-format.test.ts`
- Modify: `app/admin/order-payment-status/page.tsx` (render `<AutoFulfilPanel />` under the page header; nothing else)

**Interfaces:**
- Consumes: Task 6 API.
- Produces:
  - `describeLastRun(lastRun, now: Date): string` — "Never run" | "Last run failed" | "Last run 2 min ago · 4 queued · 3 waiting · 1 needs you".
  - `networkSkipNotes(settings, switches): string[]` — e.g. "MTN skipped: MTN auto-fulfilment is off", "Telecel skipped: not in the auto-fulfilment networks"; all on → `[]`.
  - `<AutoFulfilPanel />` — self-loading Card: switch labelled "Auto-fulfil pending orders" (turning on asks: "Orders older than N minutes will be sent to suppliers automatically. Turn on?"), last-run line, skip notes, "invalid settings" warning when `valid` is false, collapsible Settings (minimum age, max age, per run, network checkboxes, 7-row retry table: retry toggle, wait minutes, max tries) with Save (PUT full object, inline errors). Navy primary accent; `lg:grid-cols-2` (general | retry table). Polls GET every 30 s. Auth headers as the page does.

- [ ] **Step 1: Write the failing tests** for `describeLastRun` (never / failed / counts / minutes ago) and `networkSkipNotes` (MTN off; Telecel not listed; all on).
- [ ] **Step 2: Run** `npx vitest run lib/auto-fulfil/panel-format.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the helpers, the panel, and the one-line page insertion.
- [ ] **Step 4: Run** the tests, `app/admin/order-payment-status/*.test.ts`, and `npx tsc --noEmit` filtered to touched files — expect PASS / no new errors.
- [ ] **Step 5: Commit** `feat(auto-fulfil): switch and settings panel on Order Payment Status`

---

## Release (controller, not a subagent task)

1. Final whole-branch review (most capable model) + security review (money path, new cron, settings API).
2. Placeholder-env `next build`; fetch + check origin/main; owner OK; push.
3. Prod migration protocol for 0193: pre-check → self-rolling-back selftest on prod → owner OK → apply → verify grants/functions.
4. `MSYS_NO_PATHCONV=1 npx tsx scripts/sync-cronjob-org.ts --apply` creates the cron-job.org job DISABLED; enable it (the switch is still off, so runs are no-ops).
5. Owner turns the switch on; watch the first runs for duplicates, refusals and Hubnet pauses.
