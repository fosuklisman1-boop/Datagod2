# Standard Bundle Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a **Retry** button on paid Hubtel standard-bundle orders that Hubtel failed, exactly like Utility Bills already has, without ever risking a double delivery.

**Architecture:** A new module `lib/standard-bundles/admin-dispatch.ts` holds `executeBundleRetry(deps, orderId)`, a port of the reviewed `executeBillRetry` flow minus the Ghana Water rule: decide with the existing generic `retryDecision`, reopen failed -> pending, re-check the Hubtel ledger, then call the existing `dispatchBundleOrder`. A thin admin route wires the real IO; the orders list route adds a `can_retry` flag; the Standard Bundles tab shows the button.

**Tech Stack:** Next.js 15 route handlers, TypeScript, Vitest, Supabase (service role via `getBundlesRuntime()`), existing `hubtel_cs_transactions` ledger. No migration.

**Spec:** this plan is the spec (agreed in chat 2026-10-25: "add the retry button"; design playback: Retry on paid+failed bundle orders, same safety rules as bills, no auto-retry, refunds unchanged). Dispatch-for-never-sent is a separate follow-up and out of scope.

## Global Constraints

- No migration, no schema change. Existing tables only (`hubtel_data_orders`, `hubtel_cs_transactions`).
- Reuse, do not copy, the decision rules: import `retryDecision` and `type LedgerFact` from `@/lib/bills/admin` (they are generic: they read only `status`, `payment_status` and the ledger rows).
- Retry is allowed ONLY when: `status === "failed"` AND `payment_status === "paid"`, at least one Hubtel ledger row exists, every ledger row is `failed`, none has `refund_claimed_at`, none has `resolved_by` (exactly `retryDecision`'s rules and messages).
- Each retry is a NEW Hubtel transaction (new client reference): `reopen` clears `hubtel_client_reference` and `failure_reason` and sets status `pending` guarded on `failed`.
- After reopening, re-read the ledger and abort + restore to `failed` if `retryDecision` no longer passes (refund claim or live transaction appeared). If restoring fails: urgent admin alert, status 500.
- If `dispatchBundleOrder` returns `"pending"` (not sent): put the order back to `failed` ("Retry not sent: <notes>") so it can be retried or refunded; alert if that revert fails.
- Admin only (`requireAdmin`, signed-in admin id required), UUID-validated `orderId`, audit log entries `standard_bundles_retry_intent` (before the send) and `standard_bundles_retry` (after).
- Storefront and bot (`channel` storefront/bots) orders may be retried too (no wallet is involved); nothing in this change touches refunds.
- Edit/Write tools only for code (never sed/awk/shell edits). TDD. Money-tier: fresh reviewer on the diff before merge. Run a real placeholder-env `next build` before pushing main; fetch and check origin/main before pushing; never push a stale branch.

## Review Focus

- Double delivery: a retry while a refund claim or a non-failed ledger row exists must be refused (and after reopen, a ledger row appearing aborts and restores). Tested in Task 1.
- Order with no ledger row ("never reached Hubtel"): Retry must be refused with the "refund it instead" reason, and the list route must not set `can_retry`. Tasks 1 and 2.
- Admin-overridden failure (`resolved_by` set): refused, because the data may have been delivered. Task 1.
- Dispatch returns "pending" (nothing sent): order returns to `failed`, not left `pending`. Task 1.
- Ledger unreadable: the list route must fail closed (no Retry offered); the retry route returns 503. Tasks 1 and 2.

---

### Task 1: `executeBundleRetry` and the bundle ledger reader

**Files:**
- Create: `lib/standard-bundles/admin-dispatch.ts`
- Create: `lib/standard-bundles/admin-dispatch.test.ts`
- Modify: `lib/standard-bundles/admin.ts` (add `fetchBundleLedgerByOrders`, `bundleCanRetry`)
- Test: `lib/standard-bundles/admin.test.ts` (add cases for the two new helpers)

**Interfaces:**
- Consumes: `retryDecision(order: {status: string; payment_status: string}, ledger: LedgerFact[]): {ok: true} | {ok: false; reason: string}` and `LedgerFact` from `@/lib/bills/admin` (read that file for the exact fields: `client_reference`, `state`, `refund_claimed_at`, `resolved_by`, `created_at`).
- Produces (all in `lib/standard-bundles/admin.ts`):
  - `fetchBundleLedgerByOrders(db: SupabaseClient, orderIds: string[]): Promise<Map<string, LedgerFact[]>>` — same as `fetchLedgerByOrders` in `lib/bills/admin.ts` (read it and mirror its query, chunking and newest-first ordering) but with `.eq("order_table", DATA_ORDERS_TABLE)`; throws on DB error.
  - `bundleCanRetry(o: {status: string; payment_status: string}, ledger: LedgerFact[]): boolean` = `o.status === "failed" && o.payment_status === "paid" && retryDecision(o, ledger).ok`.
- Produces (in `admin-dispatch.ts`):
  - `interface BundleRetryOrder { id: string; reference_code: string; status: string; payment_status: string; notes?: string | null; failure_reason?: string | null; updated_at: string }`
  - `interface BundleRetryDeps { getOrder(id: string): Promise<BundleRetryOrder | null>; getLedger(orderId: string): Promise<LedgerFact[]>; reopen(orderId: string, note: string): Promise<number>; revertToFailed(orderId: string, note: string): Promise<number>; dispatch(order: BundleRetryOrder): Promise<string>; alert(message: string, urgent?: boolean): Promise<void>; now(): number }`
  - `interface BundleRetryResult { ok: boolean; status: number; message: string; orderStatus?: string }`
  - `executeBundleRetry(d: BundleRetryDeps, orderId: string): Promise<BundleRetryResult>`

- [ ] **Step 1: Write the failing tests** in `admin-dispatch.test.ts`, modelled one-for-one on `describe("executeBillRetry")` in `lib/bills/admin-dispatch.test.ts` (read it and copy its fake-deps helper style; drop the Ghana Water case). Test names and exact assertions:
  - `retries a paid failed order whose only ledger rows are failed` => result `toMatchObject({ ok: true, orderStatus: "processing" })`, `calls` equals `["reopen:Retrying after Hubtel failure: Invalid meter", "dispatch"]` (use `failure_reason: "Invalid meter"`).
  - `404 when the order is missing`.
  - `409 for every order that is not paid+failed` (each of: pending/paid, processing/paid, completed/paid, refunded/refunded, failed/unpaid) with no `reopen` call.
  - `409 "never reached Hubtel" when the ledger is empty` (message matches `/never reached Hubtel/`, no reopen).
  - `409 for ledger rows that are not failed, have refund_claimed_at, or have resolved_by` (three cases, no reopen).
  - `503 when the ledger cannot be read` (getLedger throws) and no reopen.
  - `409 "order changed" when reopen changes 0 rows` and calls equal only the reopen.
  - `aborts and restores to failed when the post-reopen ledger now has a refund claim` => status 409 and calls end with `"revert:Retry aborted"`.
  - `puts the order back to failed when dispatch returns "pending"` => `toMatchObject({ ok: false, orderStatus: "failed", message: "Retry not sent: Not sent: Hubtel paused" })` when `getOrder` after dispatch has `notes: "Not sent: Hubtel paused"`, calls end `"revert:Retry not sent: Not sent: Hubtel paused"`.
  - `500 + urgent alert when the abort cannot restore the order` (revert returns 0 after a ledger change; `calls` contains `"alert:urgent"`).
  - In `admin.test.ts`: `fetchBundleLedgerByOrders` filters on `order_table = hubtel_data_orders` (fake db records the `.eq` calls); `bundleCanRetry` true for failed+paid+all-failed ledger, false for no ledger, false for unpaid, false when any row has `resolved_by`.
- [ ] **Step 2: Run** `npx vitest run lib/standard-bundles/admin-dispatch.test.ts lib/standard-bundles/admin.test.ts` — expect FAIL (module/exports missing).
- [ ] **Step 3: Implement** `executeBundleRetry` in `admin-dispatch.ts` as a line-for-line port of `executeBillRetry` (`lib/bills/admin-dispatch.ts:90-132`) with `BillRetryDeps` -> `BundleRetryDeps`, "bill order" -> "standard bundle order" in alert texts ("check it in Standard Bundles"), and the Ghana Water block removed. Implement `fetchBundleLedgerByOrders` and `bundleCanRetry` in `admin.ts` as specified above.
- [ ] **Step 4: Run** the same command — expect PASS; also run `npx tsc --noEmit` — expect no errors.
- [ ] **Step 5: Commit** `feat(standard-bundles): executeBundleRetry and bundle ledger reader`.

### Task 2: Retry route and `can_retry` on the orders list

**Files:**
- Create: `app/api/admin/standard-bundles/retry/route.ts`
- Modify: `app/api/admin/standard-bundles/orders/route.ts`
- Test: no new unit logic here (the list flag calls `bundleCanRetry`, covered in Task 1). Verify with `tsc` and the lib test run.

**Interfaces:**
- Consumes: `executeBundleRetry`, `BundleRetryDeps`, `BundleRetryOrder` (Task 1); `fetchBundleLedgerByOrders`, `bundleCanRetry` (Task 1); `getBundlesRuntime()` from `@/lib/standard-bundles/runtime` returning `{ deps, db }` (read `lib/standard-bundles/runtime.ts` and the `BundlesDeps` interface in `lib/standard-bundles/service.ts` for `getOrder`, `updateOrder(id, patch, fromStatuses)` and `alert`); `dispatchBundleOrder(deps, order)` from `@/lib/standard-bundles/service`; `requireAdmin`, `auditLog`, `errorJson` from `@/lib/hubtel-cs/admin-route`.
- Produces: `POST /api/admin/standard-bundles/retry` body `{ orderId: string }` -> `{ ok, status, order, message }` with the HTTP status from `executeBundleRetry`; and a boolean `can_retry` on every row of `GET /api/admin/standard-bundles/orders`.

- [ ] **Step 1: Implement** the retry route as a port of `app/api/admin/utility-bills/retry/route.ts`: same auth (403 without a signed-in admin id), UUID check, and deps wiring, using `getBundlesRuntime()`; `reopen(id, note)` = `deps.updateOrder(id, { status: "pending", hubtel_client_reference: null, failure_reason: null, notes: `${note} (retry by admin ${adminId})` }, ["failed"])`; `revertToFailed(id, note)` = `deps.updateOrder(id, { status: "failed", notes: note }, ["pending"])`; `dispatch` writes the `standard_bundles_retry_intent` audit entry then returns `dispatchBundleOrder(deps, fresh)`; final audit action `standard_bundles_retry`. `getLedger` uses `fetchBundleLedgerByOrders(db, [id])`.
- [ ] **Step 2: Implement** `can_retry` in the orders list route: for rows with `status === "failed"` and `payment_status === "paid"` load `fetchBundleLedgerByOrders(db, ids)` inside its own try/catch (`retryOk = false` on error => fail closed) and set `can_retry: retryOk && bundleCanRetry(o, ledgerMap.get(o.id) ?? [])`; all other rows get `can_retry: false`.
- [ ] **Step 3: Verify**: `npx tsc --noEmit` (no errors) and `npx vitest run lib/standard-bundles` (all pass).
- [ ] **Step 4: Commit** `feat(standard-bundles): admin retry route and can_retry flag`.

### Task 3: The Retry button on the Standard Bundles tab

**Files:**
- Modify: `app/admin/hubtel-commission/standard-bundles.tsx`

**Interfaces:**
- Consumes: `can_retry?: boolean` on each order row (Task 2) and `POST /api/admin/standard-bundles/retry` (Task 2).
- Produces: a **Retry** button (outline variant with the `RefreshCw` icon from `lucide-react`, exactly as `app/admin/utility-bills/page.tsx:166` renders it) in the row action cell, shown only when `r.can_retry`.

- [ ] **Step 1: Implement**: add `can_retry?: boolean` to `OrderRow`; add a `retry(r: OrderRow)` handler beside the existing `sync`/`confirmRefund` handlers that uses the same `authed` helper, `inFlight` guard and `busy` state (`busy === \`retry-${r.id}\`` shows "Retrying..."), asks `window.confirm("Resend this order to Hubtel? The customer's data is only sent if Hubtel accepts it.")`, then posts `{ orderId: r.id }`, shows the response `message` in the existing banner (`ok: j.ok`) plus `toast.success`/`toast.error`, and reloads the current page with `load(offset)`. Render the button next to the Refund button; keep Refund behaviour untouched.
- [ ] **Step 2: Verify**: `npx tsc --noEmit`; then a real placeholder-env `next build` (NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co, NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder, SUPABASE_SERVICE_ROLE_KEY=placeholder, NEXT_PUBLIC_APP_URL=https://example.com) must exit 0.
- [ ] **Step 3: Commit** `feat(standard-bundles): Retry button on the Standard Bundles tab`.

---

## Self-review notes

- **Coverage:** Retry eligibility + double-delivery guard + restore paths (Task 1), admin API + list flag (Task 2), UI (Task 3). Dispatch for never-sent orders and the meter-correction action are explicitly out of scope.
- **Type consistency:** `BundleRetryDeps`/`BundleRetryOrder`/`BundleRetryResult` and `fetchBundleLedgerByOrders`/`bundleCanRetry` are defined in Task 1 and used with the same names in Tasks 2 and 3.
- **Proportion:** the logic is a port of `executeBillRetry`; the plan names the source lines instead of repeating the code.
