# Failed Orders Download + Provider-Failure → Pending Revert

**Date:** 2026-06-01
**Branch:** `feat/moolre-withdrawal-integration`
**Status:** Approved by user

## Problem

Two related shortcomings on the admin Order Payment Status page:

1. Admin can download **pending** orders (for batch dispatch via provider portals) but cannot download **failed** orders, which would let them manually retry at the provider level.
2. When a network provider (MTN Sykes, MTN DataKazina, MTN Xpress) reports a fulfillment failure, our system writes `status = "failed"` to the customer-facing order tables. This:
   - exposes a "Failed" badge to customers for orders the team can still retry,
   - sends customers a "your order failed" email even though we may immediately re-fulfill,
   - leaves the order in a terminal-looking state that's awkward to re-queue.

## Goals

- Admin can download failed orders from the same Bulk Status Update panel, scoped by the existing filters (date, time range, network).
- Provider failure no longer flips the customer-facing order to `"failed"` — it reverts to `"pending"` so the order remains re-fulfillable.
- The internal fulfillment-tracking record still stores `"failed"` so the duplicate-fulfillment guard works and admins can find these orders.
- Customer never sees a "your order failed" email when the failure is provider-side.

## Non-goals

- Non-MTN provider failure paths (AT-iShare, AFA, generic fulfillment-service.ts). Out of scope.
- Payment-status failures (`payment_status = "failed"`). Separate concern.
- USSD-initiated cancellations / user-side aborts.
- Schema migrations. This change is code-only.
- Admin-set "failed" (per-row dropdown, bulk-update tool) — admin decisions stay terminal.

## Architecture

Two independent features sharing one PR.

```
┌─────────────────────────────────────────────────────────────────┐
│ Feature #1: Failed Orders Download                              │
│                                                                 │
│   UI (page.tsx) ── POST /api/admin/orders/download              │
│                       { filters: { date, network, time,         │
│                                    failureMode: 'failed' } }    │
│                                                                 │
│   Route queries combined_orders_view + tracking join,           │
│   exports XLSX, does NOT mutate order status.                   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Feature #2: Provider Failure → Pending                          │
│                                                                 │
│   Provider says "failed"                                        │
│         │                                                       │
│         ▼                                                       │
│   tracking.status = "failed"   (unchanged — dedupe still works) │
│   order.status    = "pending"  (NEW — was "failed")             │
│         │                                                       │
│         ▼                                                       │
│   notifyAdmins (SMS/push)        (unchanged)                    │
│   customer failure email         (SUPPRESSED)                   │
└─────────────────────────────────────────────────────────────────┘
```

### Files touched

- **UI**: `app/admin/order-payment-status/page.tsx` — one new button, one new handler, one extra filter on the count fetch.
- **Download API**: `app/api/admin/orders/download/route.ts` — new branch for `failureMode === 'failed'`.
- **Provider failure mappers** (split `newStatus` into `trackingStatus` vs `orderTableStatus`):
  - `lib/mtn-fulfillment.ts` — `updateMTNOrderFromWebhook` (Sykes)
  - `lib/mtn-fulfillment.ts` — `updateDataKazinaOrderFromPayload`
  - `app/api/webhooks/mtn/xpress/route.ts` — Xpress webhook handler
  - `app/api/cron/sync-mtn-status/route.ts` — Sykes cron
  - `app/api/cron/sync-mtn-status/datakazina/route.ts` — DataKazina cron
  - `app/api/cron/sync-mtn-status/xpress/route.ts` — Xpress cron
- **Notification suppression**:
  - `app/api/webhooks/mtn/route.ts` `handleOrderFailed` — drop the customer `sendEmail` block; keep `notifyAdmins`.
  - Xpress webhook already only does admin notifications — no change.

## Feature #1: Failed Orders Download

### API contract

`POST /api/admin/orders/download`

```ts
filters: {
  date: string                          // required (unchanged)
  startTime?: string                    // unchanged
  endTime?: string                      // unchanged
  network?: string                      // unchanged
  failureMode?: 'pending' | 'failed'    // NEW, defaults to 'pending'
  onlyPending?: boolean                 // kept for back-compat
}
```

When `failureMode === 'failed'`:

1. Skip the existing `query.eq("status", "pending")` filter.
2. Skip the entire "claim by flipping pending → processing" block (no race-condition concern; failed mode is export-only).
3. Add a tracking-table join to scope to orders with a failed MTN attempt:

   ```ts
   const { data: failedTracking } = await supabase
     .from("mtn_fulfillment_tracking")
     .select("shop_order_id, order_id, api_order_id, order_type, status, created_at")
     .eq("status", "failed")
     .order("created_at", { ascending: false })

   // Per-order: only include if the LATEST tracking row is "failed"
   // (skip orders where a later attempt succeeded)
   const latestPerOrder = new Map<string, string>()  // orderId → status
   for (const t of failedTracking) {
     const id = t.shop_order_id || t.order_id || t.api_order_id
     if (id && !latestPerOrder.has(id)) latestPerOrder.set(id, t.status)
   }
   const failedOrderIds = Array.from(latestPerOrder.keys())

   query = query.in("id", failedOrderIds)
   ```

4. Also include orders with historical `status = "failed"` written before this PR shipped (orders that were marked failed before Feature #2 started reverting to pending). The exact Supabase query shape:
   ```ts
   // Two queries unioned client-side, deduplicated by id:
   //   Query A: combined_orders_view WHERE id IN (failedOrderIds)
   //   Query B: combined_orders_view WHERE status = 'failed'
   // Then apply date/network/time filters to both, merge, dedupe by id.
   ```
   Using two queries + client-side merge is simpler than wrestling Supabase's `.or()` syntax across a long IN list. After Feature #2 ships, Query B's result set monotonically shrinks (no new orders enter `status='failed'` from providers).

5. Still apply date/network/time filters.
6. Still exclude auto-fulfilled networks (Telecel / AT-iShare / AT-BigTime) when auto-fulfillment is enabled.
7. Return XLSX with `Phone`, `Size` columns (same shape as today).
8. Do NOT insert `order_download_batches` records — this is not a dispatch download.

### UI

In `app/admin/order-payment-status/page.tsx`:

- New state: `bulkDownloadingFailed`, `globalFailedCount`.
- New handler `handleBulkDownloadFailed()` — copy of `handleBulkDownload` with `failureMode: 'failed'` and filename `orders-failed-${network || 'all'}-${date}-${timestamp}.xlsx`.
- Optional second count: extend `fetchGlobalBulkCount` (or add a sibling) to also fetch the count of failed orders matching the date/network/time filters, shown beside the button.
- New button in the bulk-update panel button row:

  ```
  [Update N Orders]  [Download N Orders]  [Download Failed (M)]
   (blue)             (green outline)      (red outline)
  ```

### Edge cases

- **Same order retried, latest tracking succeeded**: only include if the *latest* tracking row per order is `"failed"` (sort by `created_at DESC`, dedupe).
- **No tracking record but order.status = "failed"** (historical data): include via the OR fallback.
- **Auto-fulfilled networks**: respected — same exclusion as today.
- **No matches**: 404 / "no orders found" toast (matches existing behavior).

## Feature #2: Provider Failure → Pending

### The rule

```
Provider reports "failed"
   │
   ├─► mtn_fulfillment_tracking.status      = "failed"     (UNCHANGED)
   ├─► mtn_fulfillment_tracking.external_*  = as today     (UNCHANGED)
   │
   └─► shop_orders.order_status             = "pending"    (was "failed")
       orders.status                        = "pending"    (was "failed")
       api_orders.status                    = "pending"    (was "failed")
       ussd_orders.order_status             = "pending"    (was "failed")
       ussd_shop_orders.order_status        = "pending"    (was "failed")
```

### Inline change at each site

Each site already normalizes the provider status into one of `"pending" | "processing" | "completed" | "failed"`. We split the result into two values right before the order-table writes:

```ts
// EXISTING: normalize provider status
const newStatus = /* existing normalization */

// NEW: customer-facing tables never see "failed" from providers
const orderTableStatus = newStatus === "failed" ? "pending" : newStatus
```

Tracking-table writes use `newStatus`. Order-table writes use `orderTableStatus`. That's it.

### Why the dedupe guard still works

`lib/fulfillment-service.ts:138-166` handles retry after failure:

1. Find latest tracking row for the order.
2. If `tracking.status === "failed"` and `mtn_order_id` is real (not `FAILED_INIT_*`):
   3. Call MTN — "what's the actual state of order X?"
   4. If MTN says active/completed → reconcile + BLOCK retry (prevents double-charge).
   5. If MTN confirms failed → allow retry.
6. Atomic lock: `UPDATE orders SET status='processing' WHERE status IN ('pending', 'failed')`.

The atomic lock explicitly allows transitioning from `'pending'` (our new state after revert), so the lock acquires cleanly. Steps 3-5 still verify with the provider before allowing the new fulfillment call.

### Why status-priority regression guards still work

DataKazina (`lib/mtn-fulfillment.ts:928-948`) and Xpress (`app/api/webhooks/mtn/xpress/route.ts:155`) compute regression priority off the *tracking* table (`{ pending: 1, processing: 2, completed: 3, failed: 3 }`). Tracking writes are unchanged, so the guards' input is unchanged.

## Feature #2: Notification side effects

### Sites that send a customer "order failed" email

- `app/api/webhooks/mtn/route.ts` `handleOrderFailed` (lines 378-410) — **REMOVE** the `sendEmail` block. Keep `notifyAdmins` and the retry-marking logic.
- `app/api/webhooks/mtn/xpress/route.ts` `handleOrderFailed` — already only notifies admins. No change.
- Sync crons (Sykes / DataKazina / Xpress) — do not send customer emails on failure today. No change.

### What admins still see

1. SMS + push notification on failure (real-time alert).
2. `mtn_fulfillment_tracking` row with `status='failed'` + `external_message`.
3. The new failed-orders download.
4. Per-order manual-fulfill button + per-row status dropdown — these still work because the order shows as `pending` (matches existing visibility checks at `page.tsx` ~lines 893, 918, 939).

### What customers see

- Order stays as "Pending" / "Processing" on their dashboard.
- No "your order failed" email.
- If retry succeeds → normal completion email/SMS.
- If admin decides to give up → admin manually flips to "failed" via the bulk-update or per-row dropdown.

## Testing

### Manual smoke tests

**Feature #1:**
1. Open `/admin/order-payment-status`, expand Bulk Status Update.
2. Pick a date with known failed orders.
3. Click **Download Failed Orders** — confirm XLSX downloads, order status untouched in DB.
4. Filter combinations: date-only, +network, +time-range, all three.
5. Same date + a network with no failures → "no orders found" toast.
6. Verify the existing "Download Orders" button still does pending-claim semantics.

**Feature #2:**
1. POST a synthetic Sykes failure webhook for a known shop order.
2. Assert `tracking.status = "failed"`, `shop_orders.order_status = "pending"`.
3. Confirm admin SMS/push fires.
4. Confirm no customer email (check `email_logs` for that order with `type='order_failed'` — expect nothing).
5. Click manual-fulfill on the order — confirm dedupe guard fires (`checkMTNOrderStatus` called), either reconciles or proceeds with retry.
6. Repeat for DataKazina webhook (`order_code` payload) and Xpress webhook (`item.failed` event).
7. Trigger sync-mtn-status cron locally with a provider-side failed order → same split.

### Unit tests

Existing `lib/mtn-fulfillment.test.ts` — add:

```
describe("updateMTNOrderFromWebhook (Sykes)", () => {
  it("maps provider 'failed' to tracking='failed' but order='pending'")
  it("maps provider 'completed' identically to both tables")
  it("maps provider 'processing' identically to both tables")
})

describe("updateDataKazinaOrderFromPayload", () => {
  it("maps provider 'failed' to tracking='failed' but order='pending'")
  it("respects status-priority guard when tracking already 'failed'")
})
```

Xpress webhook + sync crons: no existing test scaffold. Rely on manual smoke unless plan phase decides otherwise.

### Regression risks

1. Dedupe-guard MTN status check (`fulfillment-service.ts:141`) — not modified, but exercise it end-to-end after the PR.
2. Customers see "Processing" indefinitely if admin never intervenes — operational concern, not a bug.
3. `combined_orders_view` — confirm it reads from order tables, not tracking, so our pending mapping flows through to admin lists correctly.
4. Status-priority regression guards in DataKazina/Xpress — keyed on tracking table; we don't touch tracking writes.

## Out of scope

- AT-iShare, AFA, generic fulfillment-service.ts failure mappings.
- Payment-status failures.
- USSD user-side cancellations.
- Schema migrations.
- Auto-retry policy changes — orders auto-marked for retry continue with existing `retry_count < maxRetries` logic.
