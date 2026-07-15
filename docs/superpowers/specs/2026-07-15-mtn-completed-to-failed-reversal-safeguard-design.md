# MTN "completed → failed" reversal safeguard

**Date:** 2026-07-15
**Status:** Design approved, pending implementation plan
**Related:** `reference-order-state-machine-guard`, `project-fulfillment-providers`, `project-bulk-order-ops-chunking` (2026-06-22 Sykes false-completion incident)

## Problem

Once an order is marked `completed`, our MTN status-sync crons stop watching it:
`app/api/cron/sync-mtn-status/route.ts:201` selects tracking rows only in
`["pending","processing","failed","retrying","error"]` — `completed` is excluded. So if a
provider later flips an order it had reported `completed` back to `failed` (a real thing —
delivery reversed/bounced on their side, or a premature "completed"), **we never see it**.
The order stays `completed`, no data was actually delivered, and the only recovery today is a
manual DB revert (as done for ~83 Sykes orders on 2026-06-22).

`completed` is effectively a one-way trapdoor. This safeguard catches provider reversals within
a bounded window and surfaces them to an admin **without** auto-re-sending (which could
double-deliver if the provider's *new* `failed` were itself wrong).

## Goals

- Detect when any MTN provider reports `failed` for an order we currently have `completed`,
  within **72 hours** of completion.
- Move such orders to a distinct **`reversed`** status that is:
  - **not** picked up by auto-fulfillment (never auto-re-sends),
  - **manually downloadable** (appears in the admin download / all-pending queue like `pending`),
  - actionable via a **per-line "Manual fulfill" button** on `/admin/orders`.
- Notify an admin on each reversal.
- Cover **all six** MTN provider sync crons via a shared helper.

## Non-goals

- No automatic re-fulfillment / re-send.
- No automatic financial action. Shop profits are credited at purchase (`project-shop-profit-timing`),
  and re-fulfilment delivers the paid-for data, so there is nothing to claw back. Refund-instead-of-fulfil
  stays a manual admin choice.
- No change to how *first-time* `failed` (never-completed) orders are handled — they keep their
  existing `failed → order=pending` re-fulfillable behaviour.

## Design

### 1. Detection (shared helper, wired into all 6 crons)

The six crons (`sync-mtn-status` = Sykes, plus `.../datakazina`, `.../xpress`, `.../eazyghdata`,
`.../bisdel`, `.../codecraft`) each already fetch their provider's recent-orders feed once per run
and build a `Map` keyed by `mtn_order_id`. Detection reuses that map — **no extra provider API calls.**

- Extend each cron's tracking selection to ALSO pull rows where
  `status = 'completed' AND updated_at >= now() - interval '72 hours'` for that provider.
- New shared module **`lib/mtn-reversal.ts`**, e.g.
  `detectReversal(trackingRow, providerOrder): boolean` — returns true when the tracking row is
  `completed` and `normalizeStatus(providerOrder.status) === 'failed'`. `normalizeStatus` is the
  existing mapper (already treats `failed/error/cancelled/rejected/expired/refunded` → `failed`).
- Because the completed-within-72h set can be large, the current `.limit(500)` must not starve the
  active (pending/processing/failed) rows: fetch the two sets separately (active rows as today;
  completed-72h rows in their own capped/paged query) rather than one combined `.limit(500)`.
- **Webhook-driven providers:** `datakazina` relies on webhooks, not a bulk feed. Its
  `app/api/webhooks/mtn/datakazina/route.ts` handler must ALSO route an incoming `failed` for an
  order it finds already `completed` through the same `flagReversal` path (below), so scope truly
  covers all providers.

### 2. New `reversed` status + state-machine change

- Introduce order status value **`reversed`** on `orders.status`, `shop_orders.order_status`,
  `api_orders.status`, `ussd_orders.order_status`, `ussd_shop_orders.order_status`, and a matching
  `mtn_fulfillment_tracking.status = 'reversed'`.
- **Migration** updates `enforce_order_state_machine()` (currently only on `shop_orders`). The trigger
  today raises when `OLD.order_status='completed' AND NEW.order_status IS DISTINCT FROM 'completed'`.
  Change it to raise when `OLD.order_status='completed' AND NEW.order_status NOT IN ('completed','reversed')`.
  - This permits **`completed → reversed`** (the safeguard's flag) while keeping every other exit from
    `completed` blocked — critically, **`completed → pending` still raises 23514**, preserving the guard
    that prevented accidental double-fulfilment.
  - `reversed → {pending, processing, completed}` needs **no** rule: the guard only fires when `OLD` is
    `completed`, so transitions *out of* `reversed` are already unguarded (manual re-fulfilment just works).
  - The `payment_status='completed'` terminal rule is unchanged.
- `reversed` is deliberately NOT added to:
  - auto-fulfillment's pickup set (so it never auto-re-sends), and
  - the crons' re-poll selection list (so once flagged it is not re-processed — a one-shot flag; a
    later manual fulfilment creates fresh tracking).

### 3. Flag action (`flagReversal`)

On a detected reversal, in one guarded update:
- `mtn_fulfillment_tracking`: `status='reversed'`, `external_status=<provider status>`,
  `external_message=<provider message>`, `updated_at=now()`.
- underlying order (by `order_type`/id, same dispatch as the existing sync branch): status →
  `reversed`, `updated_at=now()`.
- **Admin notification**: reuse the existing admin in-app notification (and optionally the
  security-alert channel from `project-security-alerting`): *"Provider {provider} reversed order
  {reference} (completed→failed) — flagged for review."* No end-customer notification (nothing has
  changed for them yet; re-fulfilment or refund is the admin's call).

### 4. Admin surface — downloadable + per-line manual fulfill

- **Downloadable:** add `reversed` alongside `pending` in the manual-download data sources
  (`app/api/admin/orders/all-pending/route.ts` and the filter/status checks in
  `app/api/admin/orders/download/route.ts`). Downloading a `reversed` order claims it → `processing`,
  exactly like a pending order, and records it in a download batch.
- **`/admin/orders` UI:**
  - a distinct **badge** for `reversed` (visually separate from pending/failed) and a
    **filter + count** so an admin can see the review queue,
  - a **per-row "Manual fulfill" button** that calls the existing single-order manual-fulfil path
    (`processManualFulfillment`) for that one order (`reversed → processing → completed`).
- `reversed` is added to status filters/badges/labels wherever order status is rendered or filtered
  in the admin surfaces (orders list, order detail).

### 5. Testing

- **Unit** (`lib/mtn-reversal.test.ts`): detector returns a flag for a `completed`-within-72h row
  whose provider order normalizes to `failed`; returns nothing when (a) provider still `completed`,
  (b) row completed > 72h ago, (c) row not `completed`.
- **Migration**: `completed → reversed` succeeds on `shop_orders`; `reversed → pending` and
  `reversed → processing`/`completed` succeed; **`completed → pending` still raises 23514**.
- **Flag action**: given a fake provider map + a completed tracking row, `flagReversal` sets order
  and tracking to `reversed` and inserts the admin notification (fake Supabase client per
  `reference-testing`).

## Components / boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `lib/mtn-reversal.ts` | pure detect + the `flagReversal` writer | supabase client, `normalizeStatus` |
| 6 sync crons | fetch provider map (unchanged), pull completed-72h rows, call detector/flag | `lib/mtn-reversal.ts` |
| datakazina webhook | route incoming `failed`-on-`completed` to `flagReversal` | `lib/mtn-reversal.ts` |
| migration `enforce_order_state_machine` | permit `completed→reversed` (keep `completed→pending` blocked; `reversed→*` already unguarded) | — |
| all-pending / download routes | include `reversed` in the download queue | — |
| `/admin/orders` | badge + filter + per-line Manual fulfill | existing `processManualFulfillment` |

## Open implementation notes

- Confirm the exact per-provider feed shape in each of the 6 crons before wiring the shared helper
  (some may already differ from Sykes's `/api/orders?limit=5000`).
- Decide the notification recipient set (all admins vs a fulfilment-ops subset) during implementation;
  default to the same audience the existing order-failure admin notifications use.
- `reversed` may need adding to `ALLOWED_STATUSES` in `bulk-update-status` only if admins should be
  able to bulk-set it; not required for the automated flow.
