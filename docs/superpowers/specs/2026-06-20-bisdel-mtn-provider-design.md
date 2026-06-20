# Bisdel — New MTN Data Bundle Provider

**Date:** 2026-06-20
**Status:** Design (awaiting review)
**Branch:** feat/moolre-withdrawal-integration

## Summary

Add **Bisdel** (API host `bisdelgh.com/api/xx1`) as a fourth selectable MTN
data-bundle fulfillment provider, alongside Sykes, DataKazina, Xpress, and
EazyGhData. Bisdel is a *catalog-based* provider — orders reference an opaque
`product_id` from a synced product catalog rather than a raw GB size — making it
architecturally identical to the existing **EazyGhData** provider. The design
mirrors EazyGhData throughout and adapts three Bisdel-specific differences.

Internal provider key: `bisdel`. Display name: **Bisdel**.

## Goals

- Bisdel is selectable from the admin MTN provider switcher and, once active,
  fulfills new MTN orders across every order type (shop, bulk, api, ussd,
  ussd_shop).
- Order status is reconciled automatically (poll-only; Bisdel exposes no webhook).
- Admin can sync the Bisdel product catalog and see its wallet balance.
- No existing provider behaviour changes. Switching providers only affects new
  orders (in-flight orders keep their original provider, per existing design).

## Non-goals

- No refactor of the existing providers into a shared catalog base class (YAGNI).
- No webhook ingestion (Bisdel docs expose none).
- No change to the order/payment/dispatch pipeline — Bisdel plugs in behind the
  existing `MTNProvider` factory.

## Bisdel API reference (from supplied docs)

Base URL: `https://bisdelgh.com/api/xx1`. Auth: **two** headers on every
request — `X-API-Key` and `X-API-Secret`.

| Endpoint | Method | Purpose | Notes |
|----------|--------|---------|-------|
| `/products.php` | GET | List active products + API prices | Returns `data.products[]`, each with `product_id`, `name`, `data_volume` ("1GB"), `validity_days`, `network`, `category`, `api_price` |
| `/balance.php` | GET | Wallet balance | `data.wallet_balance` (number, GHS) |
| `/order.php` | POST | Place order, auto-debits wallet | Body `{ product_id, phone, quantity, external_order_id? }`. Success `code: 201`, `data.order_id` (numeric), `data.order_reference` (string `XX1-...`), `data.status` |
| `/status.php?order_reference=...` | GET | Order status | Keyed on **`order_reference`** (string), not numeric `order_id`. Returns `data.status` |

Status/error codes: 200 OK, 201 Created, 400 bad request / **insufficient
balance** (`error: "Insufficient wallet balance"`), 401 auth, 404 not found,
405 method, 503 disabled.

## Three Bisdel-specific differences vs. EazyGhData

1. **Dual-header auth** — `X-API-Key` + `X-API-Secret` (EazyGhData uses one key).
2. **Status lookup key** — `/status.php` keys on the string `order_reference`,
   not a numeric id. We therefore store `order_reference` as the tracking
   `mtn_order_id` so the existing sync machinery looks it up correctly.
3. **Category-filtered product match** — Bisdel's catalog can contain multiple
   products of the same GB but different validity/category (e.g. "1GB Daily" vs a
   monthly 1GB). Our orders carry only GB + network, so we disambiguate by an
   admin-chosen **category** (decision below).

## Architecture

Bisdel implements the existing `MTNProvider` interface
(`lib/mtn-providers/types.ts`): `createOrder`, `checkOrderStatus`,
`checkBalance`. The factory (`lib/mtn-providers/factory.ts`) instantiates it when
`admin_settings.mtn_provider_selection.provider === "bisdel"`. Everything
downstream (tracking writes, status mirroring, retries, notifications) is
provider-agnostic and already works once the provider name is threaded through.

### Component 1 — `lib/mtn-providers/bisdel-provider.ts` (class `BisdelProvider`, `name = "bisdel"`)

Env: `BISDEL_API_KEY`, `BISDEL_API_SECRET`, `BISDEL_BASE_URL`
(default `https://bisdelgh.com/api/xx1`). Request timeout 30s.

- **`createOrder(order)`**
  1. Validate phone format + phone/network match (reuse helpers from
     `mtn-fulfillment.ts`), as EazyGhData does.
  2. Resolve `product_id` via `getProductId(order.size_gb)` (Component 2). On
     miss → `success:false`, `error_type: "VALIDATION"`, clear message.
  3. `POST /order.php` with `{ product_id, phone: normalized, quantity: 1,
     external_order_id: order.client_ref }`.
     - Passing our order UUID as `external_order_id` aids traceability and gives
       Bisdel a dedupe handle.
  4. Success (`code 201` / `data.order_id`): **return `data.order_reference` as
     `order_id`** in the `MTNOrderResponse` (this is what gets stored as
     `mtn_fulfillment_tracking.mtn_order_id` and later passed to
     `checkOrderStatus`). Map `data.status` for the message.
  5. `400` insufficient balance → `success:false` with the API message
     (`isInsufficientFundsError` already matches "insufficient"/"balance").
  6. Modest retry-with-backoff on transient network errors / 429, mirroring the
     EazyGhData house style.
- **`checkOrderStatus(orderReference)`** — `GET /status.php?order_reference=...`
  → normalize `data.status` via shared `normalizeStatus`. `404` → not found.
- **`checkBalance()`** — `GET /balance.php` → `data.wallet_balance` (parse
  number/string, else null).

Status normalization (shared helper): `completed|complete|success|successful|
delivered|done|sent` → `completed`; `failed|error|cancelled|canceled|rejected|
refunded` → `failed`; `processing|in_progress|queued|submitted|accepted` →
`processing`; else `pending`.

### Component 2 — Category-filtered product mapping

Two `admin_settings` rows (mirrors EazyGhData's `eazyghdata_packages`):

- `bisdel_packages` → `{ packages: [...], synced_at, count }` — full
  `/products.php` catalog, cached.
- `bisdel_category` → `{ category: "<chosen>" }` — the single category Bisdel
  orders are matched within.

`getProductId(sizeGb)`:
1. Load cached `bisdel_packages` + `bisdel_category`.
2. Filter products to `network === "MTN"` **AND** `category === chosen`.
3. Within that subset, match by GB: parse `data_volume` ("1GB", "1.5 GB",
   "500MB") to a number and compare rounded GB.
4. Return the matched `product_id`. If no category configured, or no GB match in
   that category → return `null` (→ order reverts to `pending`, never a silent
   wrong-bundle delivery).

**Decision (user-selected):** disambiguate same-GB products by a single
admin-chosen category (the "Filter to one category" option). Rationale: most
explicit and deterministic; avoids shipping a short-validity daily bundle when a
standard one was expected.

### Component 3 — `app/api/admin/fulfillment/bisdel-products/route.ts`

Clone of `eazyghdata-packages` route.
- `GET` — return cached `bisdel_packages` (+ `synced_at`, `count`, and the
  distinct `category` list to populate the admin dropdown).
- `POST` — fetch `/products.php` (with both auth headers), normalize to a flat
  product array, upsert into `admin_settings.bisdel_packages`. Admin-guarded via
  `verifyAdminAccess`.

### Component 4 — `app/api/cron/sync-mtn-status/bisdel/route.ts`

Clone of the EazyGhData sync cron:
- Select `mtn_fulfillment_tracking` where `provider = "bisdel"` and status in
  (pending, processing), batched.
- `checkMTNOrderStatus(mtn_order_id, "bisdel")` per row (where `mtn_order_id`
  holds the `order_reference`).
- Apply the existing no-status-regression rule; on change, mirror terminal
  status to the originating order table (all 5 order types) and fire in-app +
  push notifications, exactly as the EazyGhData cron does.
- Registered in `vercel.json` at `* * * * *`.

## Data flow

1. Order paid → existing dispatcher (`process-order` / manual / wallet paths) →
   `createMTNOrder` → factory returns `BisdelProvider` (when active).
2. `createOrder` resolves `product_id` (category+GB) → `POST /order.php` →
   returns `order_reference`.
3. `saveMTNTracking` writes a row with `provider: "bisdel"`,
   `mtn_order_id: <order_reference>`.
4. Cron `sync-mtn-status/bisdel` polls `/status.php?order_reference=...` →
   normalizes → updates tracking + originating order + notifies on terminal.

## Error handling

- Product miss / no category → `VALIDATION` failure, order stays/reverts to
  `pending` (re-fulfillable). No wrong-bundle delivery.
- Insufficient balance → surfaced as a normal failure; existing admin
  low-balance SMS/email alerting covers Bisdel (added to the balance route).
- Transient network/429 → bounded retry-with-backoff inside the provider.
- A throw inside `createOrder` is converted to a normal failure by the existing
  callers (`fulfillment-service`, `process-order`), so orders never strand in
  `processing` without a tracking row.

## Complete integration checklist ("nothing is missed")

**New files (3):**
1. `lib/mtn-providers/bisdel-provider.ts` — `BisdelProvider`
2. `app/api/admin/fulfillment/bisdel-products/route.ts`
3. `app/api/cron/sync-mtn-status/bisdel/route.ts`

**Modified files (10):**
4. `lib/mtn-providers/types.ts` — add `"bisdel"` to `MTNProviderName`
5. `lib/mtn-providers/factory.ts` — import + `getSelectedProvider` validation +
   both `switch` statements (`getMTNProvider`, `getProviderByName`)
6. `app/api/admin/settings/mtn-provider/route.ts` — add `"bisdel"` to the POST
   validation array
7. `app/api/admin/fulfillment/mtn-balance/route.ts` — instantiate
   `BisdelProvider`, add to `Promise.all`, add `balances.bisdel`, include in
   low-balance SMS + email
8. `app/admin/settings/mtn/page.tsx` — `MTNBalance` interface, balance card
   (5th tile), provider selection button, Bisdel product-sync + category
   dropdown UI (shown when active), widen the `mtnProvider` union
9. `app/admin/settings/page.tsx` — widen the `mtnProvider` union (line ~47)
10. `app/admin/mtn-logs/page.tsx` — add a Bisdel provider badge
11. `lib/ai-tools.ts` — add `"bisdel"` to the `set_mtn_provider` and
    `sync_fulfillment_status` enums; mention Bisdel in `get_mtn_logs` description
12. `lib/admin-service.ts` — verify the `set_mtn_provider` tool handler accepts
    `"bisdel"` (add if it whitelists providers)
13. `vercel.json` — register `/api/cron/sync-mtn-status/bisdel`

**Env vars (Vercel):** `BISDEL_API_KEY`, `BISDEL_API_SECRET`, `BISDEL_BASE_URL`.

## Testing

- **Unit (Vitest):** the category+GB product matcher and the status normalizer
  (pure functions — the project's preferred test target). Cover: GB match within
  category, same-GB collision resolved by category, no-category miss, MB→GB
  parse, unknown-status → pending.
- **Manual smoke (admin):** set Bisdel active → Sync Products → pick category →
  Refresh Balances (shows Bisdel tile) → place a test MTN order → confirm
  tracking row `provider=bisdel` with `order_reference` → cron flips it to
  completed and notifies.

## Rollout / ops notes

- Set the three env vars in Vercel before selecting Bisdel.
- After selecting Bisdel: Sync Products, then choose the category, before placing
  live orders (an unset category fails every order by design).
- Vercel Pro cron limit (40) is not exceeded — ~21 crons after this addition.
