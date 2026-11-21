# Order work queue (reshape of /admin/order-payment-status) — design

Date: 2026-11-21. Owner chose approach A ("reshape this page into a work queue").

## Why

On 2026-11-21 ~75 orders fell through AgentPortal ("not enabled on MTN yet") to Hubnet, 63 were
held, and the owner had no way on this page to (a) find "the orders AgentPortal refused", or
(b) send a chosen set of orders to a chosen supplier in one go. Today the page is a flat list with
reference/phone search; its date/time/network filters live inside the collapsible "Bulk Status
Update" panel and only apply while that panel is open; per-row send-to-supplier exists, bulk send
does not let you pick a supplier. The owner asked for what is "needed professionally, even if it
reshapes the page".

The page should answer: *what needs my attention, and what do I do with it?*

## Goals

1. **Quick views with live counts** (tabs): Needs action (order status pending + reversed),
   Held (has a supplier attempt stored as `abandoned` / `UNKNOWN_*`, i.e. outcome unknown),
   Stuck (processing for more than 2 h), Failed, All.
2. **Always-visible filter bar:** status (multi), network, order type (bulk/shop/api/ussd/ussd_shop),
   date range (from/to, with optional times), search (reference/phone/email/store), plus two new
   ones driven by the latest supplier attempt: **Last supplier** and **Failure reason**.
3. **New columns:** last supplier + its short error, attempt count, age.
4. **Selection:** row checkbox, select page, "select all N matching" (hard cap 200).
5. **Bulk action bar** (appears when rows are selected): *Send to supplier ▾*, *Change status ▾*,
   *Export*. The supplier list shows only suppliers that can serve **every** selected network
   (same capability rules the per-row picker already mirrors from `lib/mtn-providers/factory.ts`),
   with each supplier's balance (existing `/api/admin/fulfillment/mtn-balance`).
6. **Confirm step** before any send: count, networks, total GB, chosen supplier, warnings
   (supplier is a hard pin — no fallback; slow supplier e.g. Hubnet ≈ 10/min; low balance).
7. **Per-order results** after a send, reusing the existing queue progress view, plus a
   **log** of every bulk send (who, when, supplier, order ids, outcome counts).
8. Filters live in the URL (shareable views). Desktop: filters in a left column, table right
   (house rule: every page widens at `lg:` and goes multi-column). Navy accent (`--primary`).

## Non-goals

- No change to how a supplier is called, retried, or reconciled (provider code untouched).
- No new supplier logic, no auto-resend, no scheduling.
- Not replacing /admin/orders or the reversed-order single fulfil flow there.
- No airtime orders (they are not in `combined_orders_view`).

## Anti-goals (a "working" build that is still a failure)

- **Any bulk path that can send an order twice without the admin knowingly accepting it.**
  Completed orders and orders with a live attempt (pending/processing/completed at a supplier) are
  never sendable in bulk. **Held** (outcome unknown) and **reversed** orders are "risky": owner
  decision 2026-11-21 — they MAY be sent in bulk, but only behind a typed confirmation (see
  Risky orders below), enforced on the server, not just in the UI.
- Silently falling back to another supplier when the admin picked one (pick = hard pin).
- A send that the admin cannot see the result of afterwards.
- Phone numbers in server logs or in the send log (ids only).
- The page getting slower than today for the default view.

## Constraints and facts found

- List API: `GET /api/admin/orders/all` reads `combined_orders_view` (UNION of orders(bulk),
  api_orders, shop_orders, ussd_orders, ussd_shop_orders) with `date/network/status/startTime/endTime`
  params, ilike search, `limit` unbounded and `search` interpolated into a PostgREST `.or()` string
  (filter-injection risk: commas/parentheses in the search text). Both must be fixed in this work.
- Supplier attempts: `mtn_fulfillment_tracking` (~152k rows), indexed on `order_id`, `shop_order_id`,
  `api_order_id`, `status`, `created_at`. Per-attempt `provider`, `status`
  (pending/processing/completed/failed/reversed/abandoned), `external_message`,
  `api_response_payload->>'message'`. Order id lives in `order_id` or `shop_order_id`
  (`coalesce(order_id, shop_order_id)`; `api_order_id` for API orders).
- Bulk send path: `POST /api/admin/fulfillment/enqueue {orders:[{id,type}], provider?}` inserts into
  `fulfillment_queue`; the drain (`lib/fulfillment-queue-drain.ts`, 20 per tick, cron each minute)
  calls `processManualFulfillment(id, type, provider)` for shop/bulk/api and `fulfillUssdOrder(...)`
  for ussd/ussd_shop. **Bug: the drain does not pass `row.provider` to `fulfillUssdOrder`**, so a
  chosen supplier is ignored for USSD orders today (`fulfillUssdOrder` already accepts `provider`
  as its 7th argument). Must be fixed.
- `enqueue` currently validates nothing: no order-state check, no supplier name check, no size cap,
  no duplicate check against rows already queued. Must be hardened (server-side, not just UI).
- Admin auth: `verifyAdminAccess`. Custom roles flag exists but is OFF; use the same gate the page
  and these routes use today.
- 2026-11-21 lesson: a `reversed` tracking row means a supplier once reported completed — treat as
  "customer may already have it".

## Approaches considered

- **A. Reshape this page into the work queue** — chosen by the owner. One place; existing bulk
  status-update and downloads move into an *Actions* menu. Bigger change, but fixes the page instead
  of stacking a fourth filter system on it.
- B. Keep the page, add a filter row + checkboxes. ~Half the work, but leaves three overlapping
  filter systems and the failure-reason filter/views don't fit.
- C. New "Fulfilment queue" page beside the old one. Clean and risk-free, but two near-duplicate
  pages until the old one is retired.

## The design (decided)

### Data: one server-side query function

A Postgres function (migration) `admin_order_queue(...)` — `SECURITY DEFINER`, `search_path` pinned,
`EXECUTE` granted to `service_role` only (called from the API route with the service client, never
from the browser) — returning one row per order from `combined_orders_view` joined LATERAL to its
latest `mtn_fulfillment_tracking` row, plus:
`last_provider, last_attempt_status, last_error (text, ≤120 chars), attempt_count, has_reversal,
has_unknown, failure_reason (bucket)`. Parameters: view, statuses[], networks[], types[], date
from/to, search text, last_provider, failure_reason, limit (≤200), offset. A sibling function (or a
mode flag) returns the per-view counts for the tabs. Default date window when none is given: last 7
days (keeps the lateral join cheap; "All" tab can widen it).

### Failure-reason buckets (pure TS + mirrored in SQL, tested both sides)

Keyword buckets over the latest attempt's message: `not_enabled` ("not enabled on MTN"),
`out_of_balance` ("insufficient balance"), `rate_limited` ("rate limit"/"rate-limiting"),
`no_bundle` ("no active bundle"/"size"), `outcome_unknown` (abandoned / UNKNOWN_), `rejected`
(other failed), `none`. Exact keyword lists are the builder's call, tested against real
messages pulled from prod.

### API

- `GET /api/admin/orders/queue` — validated params (zod or equivalent), calls the function,
  returns rows + counts + `hasMore`. No phone numbers in logs.
- `POST /api/admin/fulfillment/enqueue` hardened: ≤200 orders; supplier must be a known name and
  capable of each order's network; each order re-read server-side and **rejected unless**:
  its order status is `pending` (normal: held orders are `processing`, reversed are `reversed` —
  see Risky orders), it has no live attempt (pending/processing/completed tracking row), and it is
  not already in `fulfillment_queue` pending/processing. Response lists accepted and rejected ids
  with reasons. Writes one row to a new `admin_bulk_send_log` (admin id, supplier, accepted ids,
  rejected ids+reasons, risky ids, batch id, created_at; RLS on, no policies → service role only).
- **DB-level duplicate guard** (builder call, accepted): partial unique index on
  `fulfillment_queue(order_id)` where status in ('pending','processing'); enqueue inserts with
  conflict-skip and reports skipped ids. The drain's orphan reset (processing→pending) keeps a row
  in the guarded set, so it stays correct.
- Drain: pass `row.provider` to `fulfillUssdOrder`. Plan must include a test proving a pinned
  supplier never falls through to the retry sequence on either the MTN or non-MTN path.

### Risky orders (held / reversed) — owner decision: bulk with typed confirmation

- A selected order is **risky** if its order status is `reversed`, or its order status is
  `processing` and its latest attempt is `abandoned`/`UNKNOWN_*` (held). Any other `processing`
  order (live at a supplier) is never sendable.
- The confirm dialog lists risky orders separately with the warning "the customer may already
  have this data — check with the supplier first", a tick box "I checked these at the supplier",
  and a field where the admin types the number of risky orders.
- The request carries `riskyAck: { count: n }`; the server recomputes the risky set itself and
  rejects the **whole request** if `riskyAck` is missing or `n` ≠ its count. Accepted risky orders
  are moved `processing|reversed → pending` in the same server step (guarded on their current
  status) before queueing, and are flagged in `admin_bulk_send_log.risky_ids`.
- Without `riskyAck`, risky orders are rejected with reason "held/reversed — needs confirmation"
  and the rest of the batch proceeds.

### Calls made after the builder check (owner may override)

- Eligible order status for bulk send: `pending` only (plus risky orders as above); `failed`
  orders are not bulk-sendable (refund/terminal paths own them).
- **Stuck** = order status `processing` and its latest tracking row is `pending`/`processing`
  with `created_at` older than 2 h.
- **Held** tab = order status `processing` and latest attempt `abandoned`/`UNKNOWN_*`.
  Failure-reason precedence: `outcome_unknown` first, then message keywords, then `rejected` for a
  failed attempt with no matching/empty message.
- Needs action, Held and Stuck tabs ignore the 7-day default window (their sets are small);
  the list and its tab count always use the same filters.
- Export = selected rows only (or the "all matching" set, ≤200), current download format,
  no new columns.
- No new page for the send log; the per-batch results panel shows outcomes; the log is for audit.
- All new routes use `verifyAdminAccess` like today's page and routes.

### Page

Reshaped `app/admin/order-payment-status/page.tsx` (split into components under
`components/admin/order-queue/`): tabs with counts → filter column (lg) / filter sheet (mobile) →
table with checkboxes and the new columns → sticky bulk action bar → confirm dialog → existing
batch progress panel showing per-order outcome. Row actions (single fulfil with supplier pick,
status change, details) stay. "Bulk Status Update" + downloads move under an *Actions* menu,
unchanged in behaviour. Filters and tab in the URL query string.

### Delivery in two steps (each shippable)

1. Views, filter bar, new columns, selection, Export of selected, `admin_order_queue` + API,
   search-injection and `limit` fixes.
2. Send-to-supplier bar + confirm dialog + hardened enqueue + drain USSD provider fix + send log
   + results view.

## Left to the builder

- Exact SQL of the function and whether counts are a second function or a flag; index additions
  if `EXPLAIN` shows the lateral join needs one.
- Component breakdown, table library (reuse what the page uses), mobile layout details.
- Keyword lists for failure buckets (from real prod messages).
- Whether "Change status" bulk reuses `/api/admin/orders/bulk-update-status` (preferred).

## Review gates

Money + schema + a bulk-send path ⇒ fresh reviewer on each step, ECC security review on step 2
(enqueue hardening, RPC grants), PGlite test for the SQL function, prod change protocol for the
migration (precheck → self-rolling-back dry run → owner OK → apply → verify).
