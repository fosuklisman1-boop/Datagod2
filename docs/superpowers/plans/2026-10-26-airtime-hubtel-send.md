# Airtime "Send via Hubtel" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a **Send via Hubtel** button on `/admin/airtime` for paid airtime orders that are stuck in `pending` because Hubtel never received them or Hubtel definitely failed them, without ever risking a double delivery.

**Architecture:** A new module `lib/airtime-hubtel-admin.ts` holds a pure decision `airtimeSendDecision(order, ledger)` and an injected-IO executor `executeAirtimeHubtelSend(deps, orderId)` that re-checks, then calls the existing `fulfillAirtimeViaHubtel` (lib/airtime-hubtel.ts), which already handles unknown outcomes, duplicates and failures. A thin admin route wires the real IO (same deps wiring as `triggerAirtimeFulfillment` in lib/airtime-service.ts), the airtime list route adds a `can_send_hubtel` flag, and the page shows the button.

**Tech Stack:** Next.js 15 route handlers, TypeScript, Vitest, Supabase service role, existing `hubtel_cs_transactions` ledger and `getHubtelCsRuntime()`. No migration.

**Spec:** this plan is the spec (agreed in chat 2026-10-26: "Build Dispatch + Retry for airtime"). Context from production: 4 paid airtime orders are stuck (1 never sent; 2 where Hubtel failed with code 2001 and the later Digiwapy attempt said "fetch failed"; 1 with a Hubtel "outcome unknown" that must NOT be resent). Bundle "Dispatch for never-sent" and USSD orders are out of scope.

## Global Constraints

- No migration, no schema change. Existing tables only (`airtime_orders`, `hubtel_cs_transactions`).
- Airtime's Hubtel failure convention (lib/hubtel-cs/adapters/airtime-orders.ts): a Hubtel failure returns the order to status `pending` with a "Fulfil manually; not resent" note, so Retry and Dispatch are ONE action on a `pending` order.
- Send is allowed ONLY when ALL hold: `payment_status === "completed"`, `status === "pending"`, every Hubtel ledger row for the order (`order_table = airtime_orders`) has `state === "failed"` (zero rows is allowed = never sent), no row has `refund_claimed_at`, no row has `resolved_by` (an admin-overridden failure may in fact have been delivered), and the order notes contain no `dgwRef:` (a Digiwapy reference means Digiwapy accepted it once; check Digiwapy first).
- Refusal reasons (409): "Only paid, pending airtime can be sent"; "A Hubtel transaction for this order is not failed; resolve it in Hubtel Commission first"; "A refund was already claimed for this order"; "An attempt was marked failed by an admin override, not by Hubtel; it may have been delivered"; "Digiwapy already accepted this order (dgwRef); check Digiwapy before resending". Ledger unreadable => 503 "Could not read the Hubtel ledger; try again".
- Never fall back between providers automatically; never resend an order whose outcome is unknown. `fulfillAirtimeViaHubtel` already returns true (Hubtel owns it) for pending / settled / outcome-unknown / live-duplicate and false when nothing was sent; reuse it unchanged.
- Hubtel's DB rule (one non-failed transaction per order) is the double-send backstop; do not add a second claim mechanism. Known accepted exposure: the same refund-vs-send race window as the normal checkout dispatch, covered by the existing "delivered after refund" alert in the airtime adapter.
- Admin only (`requireAdmin`/`verifyAdminAccess` as the surrounding airtime admin routes do, signed-in admin id required), UUID-validated `orderId`, audit entries `airtime_hubtel_send_intent` (before the send) and `airtime_hubtel_send` (after).
- Storefront, dashboard and bot airtime orders are all eligible; refunds are not touched.
- Edit/Write tools only for code (never sed/awk/shell edits). TDD. Money-tier: fresh reviewer on the diff before merge. Real placeholder-env `next build` before pushing main; fetch and check origin/main before pushing; never push a stale branch.

## Review Focus

- Order with a ledger row that is not `failed` (e.g. the MTN order with a Hubtel `needs_review`): refused, never resent. Task 1.
- Digiwapy reference in the notes: refused. Task 1.
- Order already completed/processing/refunding/refunded, or unpaid: refused. Task 1.
- Nothing was sent (unsupported network, amount over GHS 100, Hubtel paused/disabled): the executor reports "Not sent" with the order's notes and leaves the order `pending` (no state change by this feature). Task 1.
- Ledger unreadable: 503 from the route and the list route offers no button (fail closed). Tasks 1 and 2.

---

### Task 1: Decision, ledger reader and executor

**Files:**
- Create: `lib/airtime-hubtel-admin.ts`
- Create: `lib/airtime-hubtel-admin.test.ts`

**Interfaces:**
- Consumes: `fulfillAirtimeViaHubtel(order: AirtimeOrderMinimal, deps: AirtimeHubtelDeps): Promise<boolean>` and `AirtimeOrderMinimal` from `@/lib/airtime-hubtel` (fields `id, reference_code, network, beneficiary_phone, airtime_amount`); `LedgerFact` (`client_reference, state, refund_claimed_at, resolved_by, created_at`) from `@/lib/bills/admin`; `SupabaseClient`.
- Produces:
  - `interface AirtimeSendOrder extends AirtimeOrderMinimal { status: string; payment_status: string; notes?: string | null }`
  - `airtimeSendDecision(order: Pick<AirtimeSendOrder, "status" | "payment_status" | "notes">, ledger: LedgerFact[]): { ok: true } | { ok: false; reason: string }` — pure, exactly the Global Constraints rules and reason strings, checked in that order.
  - `fetchAirtimeLedgerByOrders(db: SupabaseClient, orderIds: string[]): Promise<Map<string, LedgerFact[]>>` — read `fetchBundleLedgerByOrders` in lib/standard-bundles/admin.ts and mirror it with `.eq("order_table", "airtime_orders")`; throws on DB error.
  - `interface AirtimeSendDeps { getOrder(id: string): Promise<AirtimeSendOrder | null>; getLedger(orderId: string): Promise<LedgerFact[]>; send(order: AirtimeSendOrder): Promise<boolean>; alert(message: string, urgent?: boolean): Promise<void> }`
  - `interface AirtimeSendResult { ok: boolean; status: number; message: string; orderStatus?: string }`
  - `executeAirtimeHubtelSend(d: AirtimeSendDeps, orderId: string): Promise<AirtimeSendResult>`

- [ ] **Step 1: Write the failing tests** in `lib/airtime-hubtel-admin.test.ts` (fake deps recording `calls`, in the style of `lib/bills/admin-dispatch.test.ts`). Exact cases:
  - `airtimeSendDecision`: ok for pending+completed with `[]`; ok for pending+completed with one `failed` row and a note "Digiwapy error: fetch failed"; refuse (with the exact reason string) for: status completed / processing / refunding / refunded / failed, payment_status not `completed`, a row `needs_review`, a row `pending`, a row `fulfilled`, a row with `refund_claimed_at`, a row with `resolved_by`, notes containing `[dgwRef:abc]`.
  - `executeAirtimeHubtelSend`: `404` when the order is missing; `409` with the decision reason and NO `send` call when refused; `503` and no send when `getLedger` throws; happy path => `send` called exactly once with the fresh order, result `{ ok: true, status: 200, orderStatus: <re-read status> }` where the order is re-read after `send` (fake returns status `processing`) and message `Sent to Hubtel; the order is processing`; `send` returns false => `{ ok: false, status: 200, message: "Not sent: <order.notes>" }` and the order is not touched; the ledger is re-read AFTER the first decision and BEFORE `send`, and a second decision that now fails (a non-failed row appeared) => 409 with no `send` (assert `calls` order: `getOrder`, `getLedger`, `getLedger`, then no `send`); `send` throws => `{ ok: false, status: 500 }` plus an urgent alert whose text contains the reference code and "do not resend".
- [ ] **Step 2: Run** `npx vitest run lib/airtime-hubtel-admin.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the module per the interfaces; flow of `executeAirtimeHubtelSend`: getOrder (404) -> getLedger (503 on throw) -> decision (409) -> re-read ledger and decide again (409; a throw => 503) -> `send` inside try/catch (throw => urgent alert + 500) -> re-read the order for `orderStatus` (ignore read errors) -> result.
- [ ] **Step 4: Run** the test file — expect PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(airtime): decision and executor for admin Send via Hubtel`.

### Task 2: Route, list flag and button

**Files:**
- Create: `app/api/admin/airtime/hubtel-send/route.ts`
- Modify: `app/api/admin/airtime/list/route.ts` (add `can_send_hubtel`)
- Modify: `app/admin/airtime/page.tsx` (button)

**Interfaces:**
- Consumes: `executeAirtimeHubtelSend`, `airtimeSendDecision`, `fetchAirtimeLedgerByOrders`, `AirtimeSendDeps`, `AirtimeSendOrder` (Task 1); `fulfillAirtimeViaHubtel` and the dependency wiring exactly as in `triggerAirtimeFulfillment` (lib/airtime-service.ts lines ~96-129: `purchase: input => rt.client.purchase(input)`, guarded `markOrder`, `refreshTx`, `settle`, `alert` via `notifyAdmins`); `getHubtelCsRuntime()` from `@/lib/hubtel-cs/runtime`; `auditLog` from `@/lib/hubtel-cs/admin-route`; the admin auth helper the sibling routes use (`verifyAdminAccess` in `app/api/admin/airtime/action/route.ts`; also fetch the admin user id the way other airtime admin routes or `requireAdmin` in `@/lib/hubtel-cs/admin-route` do, 403 if absent).
- Produces: `POST /api/admin/airtime/hubtel-send` body `{ orderId: string }` -> `{ ok, message, status }` with the HTTP status from the executor; a boolean `can_send_hubtel` on each row of the airtime list response; a **Send via Hubtel** button (outline variant, `RefreshCw`/`Send` icon consistent with the page) in the order row actions, shown only when `can_send_hubtel`.

- [ ] **Step 1: Implement** the route: auth + UUID check, build `AirtimeSendDeps` (`getOrder` selects `id, reference_code, network, beneficiary_phone, airtime_amount, status, payment_status, notes`; `getLedger` uses `fetchAirtimeLedgerByOrders`; `send` writes the `airtime_hubtel_send_intent` audit entry then runs `fulfillAirtimeViaHubtel` with the Hubtel runtime deps — if `getHubtelCsRuntime()` throws, return false so the executor reports "Not sent"; `alert` via `notifyAdmins` like the service), run the executor, write the `airtime_hubtel_send` audit entry (ok, status, message), return JSON.
- [ ] **Step 2: Implement** `can_send_hubtel` in the list route: for rows with `payment_status === "completed"` and `status === "pending"` load `fetchAirtimeLedgerByOrders` for those ids in its own try/catch (error => false for all, fail closed), then `airtimeSendDecision(row, ledger.get(row.id) ?? []).ok`; all other rows `false`.
- [ ] **Step 3: Implement** the button: `can_send_hubtel?: boolean` on the page's order type; a `handleHubtelSend(order)` beside `handleAutoFulfill` using the same `token`/`getToken` pattern and a `window.confirm("Send this airtime to Hubtel now? Do not use this if the customer may already have received it.")`; show the response `message` via `toast.success` when `ok` else `toast.error`; reload with `loadOrders()` in `finally`; disable while in flight; render next to the existing auto-fulfill/action buttons without changing their behaviour.
- [ ] **Step 4: Verify**: `npx tsc --noEmit`; `npx vitest run lib/airtime-hubtel-admin.test.ts lib/airtime-hubtel.test.ts lib/airtime-service-dispatch.test.ts`; then the placeholder-env real `next build` (NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co, NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder, SUPABASE_SERVICE_ROLE_KEY=placeholder, NEXT_PUBLIC_APP_URL=https://example.com) exits 0.
- [ ] **Step 5: Commit** `feat(airtime): Send via Hubtel route, list flag and button`.

---

## Self-review notes

- **Coverage:** eligibility + double-send guards (Task 1), admin API + fail-closed list flag + UI (Task 2). Bundle Dispatch, USSD orders and ECG meter correction stay out of scope.
- **Type consistency:** `AirtimeSendOrder`, `AirtimeSendDeps`, `AirtimeSendResult`, `airtimeSendDecision`, `fetchAirtimeLedgerByOrders`, `executeAirtimeHubtelSend` are defined in Task 1 and used with the same names in Task 2.
- **Proportion:** the real work is wiring around the existing `fulfillAirtimeViaHubtel`; the plan names source lines instead of repeating code.
