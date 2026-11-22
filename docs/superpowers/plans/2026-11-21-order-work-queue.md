# Order Work Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape `/admin/order-payment-status` into a work queue (views with counts, filters incl. last supplier / failure reason, selection) and add a safe bulk "Send to supplier".

**Architecture:** A service-role-only Postgres function returns orders from `combined_orders_view` joined to each order's latest `mtn_fulfillment_tracking` row; a validated API route serves the page. Bulk send goes through the existing `fulfillment_queue` via a hardened `enqueue` route that re-checks every order server-side (pure eligibility module), guards duplicates in the DB, and logs every send.

**Tech Stack:** Next.js 15 App Router, Supabase (service client), Postgres 17, zod 4, vitest + PGlite, Tailwind/shadcn.

**Spec:** `docs/superpowers/specs/2026-11-21-order-work-queue-design.md`

## Global Constraints

- Worktree `B:/worktrees/dg-order-queue`, branch `feat/order-work-queue`. Run vitest from the uppercase path: `cd B:/worktrees/dg-order-queue && npx vitest run <path>`.
- Code edits with Edit/Write only — never `sed` (tell every subagent).
- No phone numbers in any server log or in `admin_bulk_send_log` (ids only).
- Bulk cap: **200** orders per request; page size ≤ **200**.
- Supplier pick is a **hard pin** — never fall through to the retry sequence.
- All new/changed routes use `verifyAdminAccess` (same as today).
- Migrations: next free numbers at time of writing **0190** (step 1) and **0191** (step 2) — re-check `ls migrations` before creating; follow the 0182 pattern (`BEGIN;` + `SET LOCAL lock_timeout = '5s'` + `statement_timeout` + exactly one `COMMIT`, a `.selftest.sql` ending in `RAISE EXCEPTION 'SELFTEST_OK 0190 …'`, a `migration-0190-run.ts` run-string builder, a PGlite test).
- New functions: `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE … TO service_role`.
- Desktop: every new layout widens at `lg:` and goes multi-column; navy `--primary` accent.
- Prod: migrations follow precheck → self-rolling-back dry run → owner OK → apply → verify. `next build` with placeholder env before pushing main; fetch/merge origin/main first.
- Fresh reviewer (sonnet) after each task; ECC security review on Tasks 6–7; opus final review per step.

## Review Focus

1. **Search text with `,` `(` `)` `%` `\`** — must be treated as literal text, never change the query (Task 2 and Task 3 tests).
2. **Two admins sending the same orders at once** — exactly one queue row per order; the second request reports them as already queued (Task 6 PGlite test + Task 7 route test).
3. **An order that changes state between page load and send** (completed / picked up by a cron) — rejected server-side with a reason, never queued (Task 7 test).
4. **Mixed networks in one selection** (MTN + AT-BigTime + Telecel) — only suppliers capable of all are offered, and the server rejects a supplier that cannot serve one of them (Tasks 4, 5 and 7 tests).
5. **`riskyAck.count` off by one / risky set changed since the dialog opened** — whole request rejected, nothing queued, nothing moved to pending (Task 7 test).

---

## STEP 1 — Views, filters, columns, selection (ship on its own)

### Task 1: Failure-reason buckets

**Files:**
- Create: `lib/order-queue/failure-reason.ts`, `lib/order-queue/failure-reason.test.ts`, `lib/order-queue/failure-reason.fixtures.ts`

**Interfaces:**
- Produces: `type FailureReason = "outcome_unknown" | "not_enabled" | "out_of_balance" | "rate_limited" | "no_bundle" | "rejected" | "none"`; `classifyFailureReason(a: { status: string | null; mtnOrderId: string | null; message: string | null } | null): FailureReason`; `FAILURE_REASON_FIXTURES: Array<{ input: Parameters<typeof classifyFailureReason>[0]; expected: FailureReason }>` (shared with Task 2's SQL test); `FAILURE_REASON_LABELS: Record<FailureReason, string>`.

- [ ] **Step 1: Pull real messages.** Read-only prod query (Management API fallback if MCP is down): `select status, left(coalesce(external_message, api_response_payload->>'message',''),120) m, count(*) from mtn_fulfillment_tracking where created_at > now()-interval '30 days' group by 1,2 order by 3 desc limit 60`. Put ≥2 real messages per bucket into the fixtures file (replace any run of ≥9 digits with `X`).
- [ ] **Step 2: Write failing tests** — every fixture maps to its `expected`; precedence: status `abandoned` or `mtnOrderId` starting `UNKNOWN_` ⇒ `outcome_unknown` even when the message says "insufficient balance"; status `failed` with null/empty message ⇒ `rejected`; status `completed`/`processing`/`pending` ⇒ `none`; `null` attempt ⇒ `none`; matching is case-insensitive. Must be in fixtures: "not enabled on MTN yet — you can place this order after 24 hours" ⇒ `not_enabled`; "Insufficient balance for 2GB" ⇒ `out_of_balance`; "Hubnet is rate-limiting requests - not sent, try again in 41s" ⇒ `rate_limited`; "No active bundle found for mtn with size 4GB" ⇒ `no_bundle`.
- [ ] **Step 3: Run** `npx vitest run lib/order-queue/failure-reason.test.ts` — FAIL (module missing).
- [ ] **Step 4: Implement** as an ordered keyword list (first match wins) after the outcome-unknown check.
- [ ] **Step 5: Run** — PASS. **Step 6: Commit** `feat(order-queue): failure-reason buckets`.

### Task 2: Migration 0190 — `admin_order_queue` + counts

**Files:**
- Create: `migrations/0190_admin_order_queue.sql`, `migrations/0190_admin_order_queue.selftest.sql`, `lib/order-queue/migration-0190-run.ts`, `lib/order-queue/migration-0190.test.ts`

**Interfaces:**
- Consumes: `FAILURE_REASON_FIXTURES` (Task 1) — the SQL bucket CASE must agree with every fixture.
- Produces (SQL):
  - `admin_order_queue(p_view text, p_statuses text[], p_networks text[], p_types text[], p_from timestamptz, p_to timestamptz, p_search text, p_last_provider text, p_failure_reason text, p_limit int, p_offset int) RETURNS TABLE(id text, created_at timestamptz, phone_number text, price numeric, network text, status text, payment_status text, payment_reference text, volume_gb text, type text, customer_email text, store_name text, shop_owner_email text, last_provider text, last_attempt_status text, last_error text, attempt_count int, has_reversal bool, is_held bool, failure_reason text, total_count bigint)`
  - `admin_order_queue_counts(p_networks text[], p_types text[], p_from timestamptz, p_to timestamptz, p_search text, p_last_provider text, p_failure_reason text) RETURNS TABLE(view text, n bigint)` for views `needs_action, held, stuck, failed, all`.
- View definitions (exact): `needs_action` = status in (pending, reversed); `held` = status processing AND latest attempt status `abandoned` or its `mtn_order_id like 'UNKNOWN_%'`; `stuck` = status processing AND latest attempt status in (pending, processing) AND latest attempt `created_at < now() - interval '2 hours'`; `failed` = status failed; `all` = everything. Date window: when `p_from` is null, `all` and `failed` default to `now() - interval '7 days'`; `needs_action`, `held`, `stuck` ignore the default.
- Search: `p_search` matched with `ILIKE '%' || <p_search with \ % _ escaped> || '%'` against phone, reference, customer email, store name. `p_limit` clamped to 1..200.
- Latest attempt: LATERAL over `mtn_fulfillment_tracking` where `coalesce(order_id::text, shop_order_id::text, api_order_id::text) = v.id`, `ORDER BY created_at DESC LIMIT 1`; `last_error` = `left(coalesce(external_message, api_response_payload->>'message'), 120)`.

- [ ] **Step 1: Write the PGlite test** (0182 test shape): migration text rules; run-string rules; in PGlite create minimal source tables behind `combined_orders_view` + `mtn_fulfillment_tracking`, apply the migration, then assert: each view returns exactly the seeded rows; counts equal list totals; a search of `a,b)` runs without error and matches only that literal; `p_limit 5000` returns ≤200 rows; for every `FAILURE_REASON_FIXTURES` entry the SQL `failure_reason` equals `expected`; roles `authenticated` and `anon` cannot EXECUTE either function.
- [ ] **Step 2: Run** `npx vitest run lib/order-queue/migration-0190.test.ts` — FAIL.
- [ ] **Step 3: Write the migration + selftest** (selftest seeds rows, asserts the view counts, raises `SELFTEST_OK 0190`).
- [ ] **Step 4: Run** — PASS. Then on prod, read-only, run the self-rolling-back run string with an `EXPLAIN ANALYZE` of the default `needs_action` call; record the timing in the commit message (target < 1.5 s). If slower, add the missing index (e.g. expression index on `(coalesce(order_id::text, shop_order_id::text), created_at desc)`) inside 0190 and re-test.
- [ ] **Step 5: Commit** `feat(order-queue): admin_order_queue function (0190)` — not applied to prod yet (Task 9).

### Task 3: Queue API + hardening of the old list route

**Files:**
- Create: `lib/order-queue/types.ts`, `lib/order-queue/params.ts`, `lib/order-queue/params.test.ts`, `app/api/admin/orders/queue/route.ts`, `app/api/admin/orders/queue/route.test.ts`
- Modify: `app/api/admin/orders/all/route.ts` (clamp `limit` to 1..200; before building the `.or()` string remove `,` `(` `)` from the search text and escape `%` `_` `\`)

**Interfaces:**
- Consumes: SQL functions (Task 2), `FailureReason` (Task 1).
- Produces: `type OrderType = "bulk"|"shop"|"api"|"ussd"|"ussd_shop"`; `type QueueView = "needs_action"|"held"|"stuck"|"failed"|"all"`; `type QueueParams = { view: QueueView; statuses: string[]; networks: string[]; types: OrderType[]; from: string|null; to: string|null; search: string; lastProvider: string|null; failureReason: FailureReason|null; limit: number; offset: number }`; `type QueueRow` = the SQL RETURNS columns in camelCase (all in `types.ts`); `parseQueueParams(sp: URLSearchParams): { ok: true; value: QueueParams } | { ok: false; error: string }`; `queueParamsToSearch(p: QueueParams): string`. Route `GET /api/admin/orders/queue` → `{ success: true, data: QueueRow[], counts: Record<QueueView, number>, total: number, hasMore: boolean }`.

- [ ] **Step 1: Failing tests** — params: defaults (`view=needs_action`, `limit=50`, `offset=0`); unknown view/type/reason ⇒ `ok:false`; `limit=999` ⇒ 200; search trimmed to 100 chars; `parseQueueParams(new URLSearchParams(queueParamsToSearch(p))).value` deep-equals `p`. Route (fake service client in the style of `app/api/admin/hubnet/route.test.ts`): non-admin ⇒ the `verifyAdminAccess` error response; calls both RPCs with mapped args; RPC error ⇒ 500 with a generic message; captured console output has no run of ≥9 digits. Old route: `limit=100000` ⇒ range 0..199; search `x,y)` produces an `.or()` argument containing neither `,y` nor `)`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (zod for parsing). **Step 4: Run** — PASS. **Step 5: Commit** `feat(order-queue): queue API; clamp and escape the old list route`.

### Task 4: Page reshape — views, filters, columns, selection, export

**Files:**
- Create: `lib/order-queue/supplier-capability.ts` (+ `.test.ts`) — move `getProviderOptionsForNetwork` from the page unchanged and add `suppliersForNetworks`; `lib/order-queue/selection.ts` (+ `.test.ts`); `components/admin/order-queue/{queue-tabs,filter-panel,queue-table,actions-menu}.tsx`
- Modify: `app/admin/order-payment-status/page.tsx` (compose the new components; keep row actions — single fulfil with supplier pick, status change; move "Bulk Status Update" + downloads under `actions-menu` with unchanged handlers); the existing download route (add an optional `ids` filter, ≤200) for "Export selected"

**Interfaces:**
- Consumes: `/api/admin/orders/queue`, `QueueParams`/`queueParamsToSearch`/`parseQueueParams`/`QueueRow` (Task 3), `FAILURE_REASON_LABELS` (Task 1).
- Produces: `getProviderOptionsForNetwork(network: string): {value: string; label: string}[]`; `suppliersForNetworks(networks: string[]): {value: string; label: string}[]` (intersection; used by Tasks 7 and 8); `selectionReducer(state: SelectionState, action: SelectionAction): SelectionState` with actions `{type:"toggle", id}`, `{type:"selectPage", ids}`, `{type:"clear"}`, `{type:"selectAllMatching", total}`; `SelectionState = { ids: Set<string>; allMatching: boolean; error?: "cap" }` — `selectAllMatching` with `total > 200` leaves ids unchanged and sets `error: "cap"`.

- [ ] **Step 1: Failing tests** — capability: MTN ⇒ the 11 suppliers listed today; `suppliersForNetworks(["MTN","AT - BigTime"])` excludes agentportalgh, apexprime, sykes, kuntanii; `["Telecel"]` includes spfastit_telecel and excludes spfastit; `[]` ⇒ `[]`. Selection: toggle on/off; selectPage adds; clear empties; `selectAllMatching(201)` ⇒ `error: "cap"`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** the libs, then the components. Tabs show counts from the API; filter changes call `router.replace("?" + queueParamsToSearch(p))`; table columns: checkbox, order (short id), type, network, size, price, status, last supplier + error (truncated, full text in `title`), attempts, age.
- [ ] **Step 4: Run tests** — PASS; then headless screenshots at 500 px and 1440 px (memory `reference-headless-screenshots`): no horizontal page scroll at 500 px; filters in a left column at `lg`.
- [ ] **Step 5: Commit** `feat(order-queue): reshape payment status page into a work queue (step 1)`.

**Step 1 release:** run Task 9 for migration 0190 + push, then continue with Step 2.

---

## STEP 2 — Send to supplier (ship on its own)

### Task 5: Eligibility module

**Files:**
- Create: `lib/order-queue/eligibility.ts`, `lib/order-queue/eligibility.test.ts`

**Interfaces:**
- Consumes: `suppliersForNetworks` (Task 4), `OrderType` (Task 3).
- Produces:
  - `type OrderSnapshot = { id: string; type: OrderType; status: string; network: string; latestAttempt: { status: string; mtnOrderId: string | null } | null; hasLiveAttempt: boolean; queued: boolean }`
  - `type Verdict = { kind: "eligible" } | { kind: "risky"; why: "held" | "reversed" } | { kind: "blocked"; reason: "completed" | "live_at_supplier" | "already_queued" | "not_pending" | "supplier_cannot_serve_network" | "not_found" }`
  - `judgeOrder(o: OrderSnapshot | null, supplier: string): Verdict`
  - `checkRiskyAck(verdicts: Verdict[], ack: { count: number } | undefined): { ok: true } | { ok: false; expected: number }` — ok when there are no risky verdicts, or `ack.count === riskyCount`.

- [ ] **Step 1: Failing tests** — pending + no attempts ⇒ eligible; pending + latest failed ⇒ eligible; completed ⇒ blocked completed; processing + latest processing ⇒ blocked live_at_supplier; processing + latest abandoned ⇒ risky held; processing + `UNKNOWN_x` id ⇒ risky held; reversed ⇒ risky reversed; failed ⇒ blocked not_pending; queued ⇒ blocked already_queued (wins over risky); pending with `hasLiveAttempt` ⇒ blocked live_at_supplier; Telecel + `spfastit` ⇒ blocked supplier_cannot_serve_network; `null` ⇒ blocked not_found. Ack: 0 risky + no ack ⇒ ok; 3 risky + ack 3 ⇒ ok; 3 risky + ack 2 or missing ⇒ `{ok:false, expected:3}`.
- [ ] **Steps 2–4:** run FAIL → implement → run PASS. **Step 5: Commit** `feat(order-queue): bulk-send eligibility rules`.

### Task 6: Migration 0191 — queue duplicate guard + send log

**Files:**
- Create: `migrations/0191_bulk_send_guard.sql`, `migrations/0191_bulk_send_guard.selftest.sql`, `lib/order-queue/migration-0191-run.ts`, `lib/order-queue/migration-0191.test.ts`

**Interfaces:**
- Produces: unique index `fulfillment_queue_one_live_per_order ON fulfillment_queue(order_id) WHERE status IN ('pending','processing')`; table `admin_bulk_send_log(id uuid primary key default gen_random_uuid(), admin_id uuid not null, supplier text not null, batch_id uuid, accepted_ids text[] not null, rejected jsonb not null default '[]', risky_ids text[] not null default '{}', created_at timestamptz not null default now())`, RLS enabled, no policies, `REVOKE ALL … FROM anon, authenticated`.

- [ ] **Step 0: Prod precheck (read-only):** `select order_id, count(*) from fulfillment_queue where status in ('pending','processing') group by 1 having count(*) > 1` must return nothing; otherwise stop and report to the owner (the index would fail to build).
- [ ] **Step 1: Failing PGlite test** — migration text rules; a second `pending` row for the same `order_id` ⇒ unique violation; `INSERT … ON CONFLICT (order_id) WHERE status IN ('pending','processing') DO NOTHING` inserts 0 rows; a `completed` row plus a new `pending` row for the same order is allowed; role `authenticated` cannot select from or insert into the log.
- [ ] **Steps 2–4:** FAIL → write migration + selftest → PASS. **Step 5: Commit** `feat(order-queue): one live queue row per order + bulk send log (0191)`.

### Task 7: Hardened enqueue + drain supplier fix

**Files:**
- Modify: `app/api/admin/fulfillment/enqueue/route.ts`, `lib/fulfillment-queue-drain.ts`
- Create: `lib/order-queue/load-snapshots.ts` (+ `.test.ts`), `app/api/admin/fulfillment/enqueue/route.test.ts`, `lib/fulfillment-queue-drain.test.ts` (if absent)

**Interfaces:**
- Consumes: `judgeOrder`, `checkRiskyAck`, `OrderSnapshot` (Task 5); index + log table (Task 6); `suppliersForNetworks` (Task 4) for the known-supplier check.
- Produces: `loadSnapshots(db, orders: {id: string; type: OrderType}[]): Promise<Map<string, OrderSnapshot>>` (reads the five order tables, latest tracking row, live-attempt existence and queued existence, in chunks of ≤100 ids); `POST /api/admin/fulfillment/enqueue` body `{ orders: {id: string; type: OrderType}[]; provider: string; riskyAck?: { count: number } }` → `200 { batchId, queued: string[], rejected: {id: string; reason: string}[], risky: string[] }`, or `400 { error: "risky_ack_mismatch", expected: number }`, or `400` for >200 orders / unknown provider / empty list.

- [ ] **Step 1: Failing tests** — route: 201 orders ⇒ 400; unknown provider ⇒ 400; mixed batch ⇒ only eligible ids queued, `rejected` carries each reason; risky present without ack ⇒ risky rejected with reason `needs_confirmation`, eligible still queued; risky with wrong count ⇒ 400 with **no** inserts and **no** status updates; risky with correct ack ⇒ each risky order updated to `pending` guarded on its current status (`processing` or `reversed`) before insert, and an order whose guarded update matches 0 rows is rejected `changed`; the insert uses conflict-skip and skipped ids are reported `already_queued`; one `admin_bulk_send_log` row per request, ids only; captured logs have no run of ≥9 digits. Drain: a `ussd` and a `ussd_shop` row with `provider: "hubnet"` call `fulfillUssdOrder` with `"hubnet"` as the 7th argument; shop/bulk unchanged. Pin: `createMTNOrder` with `order.provider` set and a failing provider never calls a retry-sequence provider, and the non-MTN path with an explicit provider does the same (add to the existing `lib/mtn-fulfillment*` / `lib/non-mtn-fulfillment.test.ts` suites if not already covered).
- [ ] **Steps 2–4:** FAIL → implement → PASS. **Step 5: Commit** `feat(order-queue): server-checked bulk send; drain passes supplier to USSD`.

### Task 8: Send bar, confirm dialog, results

**Files:**
- Create: `components/admin/order-queue/{bulk-action-bar,send-confirm-dialog,send-results}.tsx`, `lib/order-queue/confirm-summary.ts` (+ `.test.ts`)
- Modify: `app/admin/order-payment-status/page.tsx`

**Interfaces:**
- Consumes: selection + `suppliersForNetworks` (Task 4), `QueueRow` (Task 3), enqueue API (Task 7), `/api/admin/fulfillment/mtn-balance`, existing `/api/admin/fulfillment/queue-status?batchId=`.
- Produces: `summarizeSelection(rows: QueueRow[]): { count: number; totalGb: number; networks: string[]; risky: QueueRow[]; blocked: { row: QueueRow; reason: string }[] }` — a client preview using the same rules as `judgeOrder` (the server stays authoritative).

- [ ] **Step 1: Failing tests** for `summarizeSelection` — GB sum of `"1"` and `"2.5"` = 3.5; risky split into held/reversed; completed rows listed under `blocked`.
- [ ] **Steps 2–3:** FAIL → implement the lib, then the UI. Bar sticky at the bottom when ≥1 row is selected: "N selected · X GB", *Send to supplier ▾* (from `suppliersForNetworks`, each with its balance), *Change status ▾* (existing bulk-update-status), *Export*. Dialog: count, GB, networks, supplier; copy "This supplier is a hard pin — if it refuses an order, it will not try another."; for Hubnet "Hubnet takes about 10 orders a minute."; risky block with "The customer may already have this data — check with the supplier first.", a checkbox "I checked these at the supplier", and a number input that must equal the risky count before Send is enabled. After sending: queued / rejected lists with reasons, then the existing batch progress panel.
- [ ] **Step 4:** tests PASS + screenshots (500 px / 1440 px). **Step 5: Commit** `feat(order-queue): send selected orders to a chosen supplier (step 2)`.

### Task 9: Release (run once per step)

- [ ] Related tests: `npx vitest run lib/order-queue lib/fulfillment-queue-drain.test.ts app/api/admin/orders app/api/admin/fulfillment lib/mtn-fulfillment lib/non-mtn-fulfillment.test.ts` — PASS (known unrelated failures per memory `feedback-testing-discipline` excepted, listed in the report).
- [ ] `npx tsc --noEmit -p .` — no errors in touched files.
- [ ] Fresh opus review of the step's diff; fix findings with failing tests first.
- [ ] Prod migration protocol for 0190 (step 1) / 0191 (step 2): precheck → self-rolling-back run string (expect `SELFTEST_OK`) → **owner OK** → apply → verify functions/grants (`has_function_privilege('authenticated', 'admin_order_queue(…)', 'EXECUTE')` = false) and index/table exist.
- [ ] `git fetch && git merge origin/main`, placeholder-env `npm run build` (reaches "Generating static pages (N/N)", exit 0), **owner OK**, `git push origin HEAD:main`, watch the deploy to READY + aliased.
- [ ] Live check: as admin, each tab count matches its list; filter "Failure reason: Not enabled on MTN" shows AgentPortal refusals; step 2: send one eligible order to a supplier and see it in the results panel.
- [ ] Update memory (`project-order-work-queue.md` + MEMORY.md line) and give the owner the WhatsApp channel post (Post now / Hold).
