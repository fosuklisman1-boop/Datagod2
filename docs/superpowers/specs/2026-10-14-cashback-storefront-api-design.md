# Commission Cashback — Part 3 (storefronts) + Part 4 (public API) design

Date: 2026-10-14 · Status: draft for review · Builds on Commission Cashback Part 1 (live, `docs/superpowers/specs/2026-10-13-commission-cashback-design.md`),
Utility Bills (Phase 3a) and Standard Bundles (Phase 2b), all live. Replaces the open Phase 2c ("Standard Bundles on storefronts
and the public API") and the remaining Phase 3b storefront-bills work. Hubtel Direct Pay is NOT used (no docs); Paystack stays the
storefront rail.

## 1. Purpose

Shop storefronts and the public API sell airtime, Utility Bills and Standard Bundles with commission-cashback pricing:

- **Storefront** buyers pay face − their cashback share + a per-group payment fee (covers Paystack); the shop owner earns a share of
  the commission instead of a markup; Datagod keeps the rest.
- **API** users (resellers, wallet-paid) buy airtime, bundles and bills with their tier's cashback share.

Success: a storefront customer sees "You pay / You receive" before paying, pays once through Paystack, and the provider receives
face; the shop owner's share appears in their profit balance at purchase and is clawed back on refund; an API integrator can list
bundles, verify a bill, and buy any of the three with one price check; no path debits or sends twice, and no sale loses money when
the admin's fee settings cover the payment cost.

## 2. Decisions (user, 2026-10-14)

| Topic | Decision |
|---|---|
| Payment cost on storefronts | New **payment fee %** per group (airtime, bundles, bills), charged on top, separate from the 3% data-order fee. |
| Shares | Unchanged model: `storefrontCustomer` + `storefrontShop` % of the provider commission (validator keeps their sum ≤ 100). |
| Shop markup | Dropped for commission services on storefronts while storefront cashback is on; existing `airtime_markup_*` ignored then. |
| Shop share credit | `shop_profits` at payment confirmation; negative row on refund (existing clawback mechanism). |
| Storefront control | **Admin only**: admin switches each group on for storefronts; every shop shows what is on. |
| API scope | Airtime **+ Standard Bundles + Bills** (verify + pay). |
| Refunds | Through `/admin/refunds` (Paystack reversal / Moolre payout) **and** a "refunded manually" action that only records it and claws back the shop share. |
| References | **No product words leave our system.** Anything sent to Hubtel or Paystack (references, metadata labels, descriptions) is opaque (e.g. 32-hex) — Hubtel ClientReference already changed (`bb916489`). |

## 3. Pricing (quote engine extension)

`quoteCashback` (lib/cashback/quote.ts) is reused unchanged for shares. A new pure step adds the payment fee:

```
storefront:  base = face − customerCashback            (customerCashback uses storefrontCustomer share)
             fee  = ceil_to_pesewa(base × paymentFee[group] / 100)
             pay  = base + fee                          provider gets face; shopShare uses storefrontShop
api:         pay  = face − customerCashback            (customer|dealer share by the API user's role; no fee)
```

- Fee rounds **up** to the pesewa (never under-collects Paystack's cost).
- Config gains `paymentFee: { airtime, bundles, bills }` (0–10 %, ≤ 2 decimals, default 0) and the validator stops rejecting the
  `storefront` and `api` surfaces.
- When a surface is off: storefront airtime keeps today's pricing exactly (fee + shop markup); storefront bills/bundles are not
  offered; API airtime keeps today's pricing; API bills/bundles endpoints return 403 "not available".
- Hubtel per-request caps (airtime GHS 100) behave as on the dashboard: above the cap → no cashback (airtime legacy path).

## 4. Storefront

### 4.1 What the customer sees (`app/shop/[slug]`)

- **Airtime** tab (exists): with storefront cashback on, no "pay fee separately", shows "GHS x (was GHS face)", payment fee line
  when > 0, **You pay / You receive** (reference image `docs/hubtel-commission-services/ref/cashback-checkout-reference.png`).
- **Bundles** tab (new): network pills → category tabs → bundle cards with storefront price → recipient phone → pay.
- **Bills** tab (new): biller grid (ECG / Ghana Water / DSTV / GOtv / StarTimes / Telecel Broadband as enabled) → the same verify
  steps as the dashboard (ECG phone-or-meter, Prepaid/Postpaid, consent) → amount → pay.
- Tabs appear only when the admin's storefront switch for that group is on (and, for bills/bundles, the Phase 2b/3a master and
  per-biller/per-network switches).
- Customer identity: name/email/phone as the existing storefront airtime checkout; Turnstile + the existing per-email/phone/shop
  pending caps apply.

### 4.2 Order + payment flow

1. **Initialize** (new `POST /api/shop/bills/initialize`, `POST /api/shop/bundles/initialize`; airtime keeps its route): all
   pre-checks (switches, limits, bill verify token / bundle catalog token + Hubtel re-query for the recipient), quote, then insert the
   order **unpaid** (`hubtel_bill_orders` / `hubtel_data_orders` with `channel='storefront'`, `shop_id`, `paid_amount` = pay incl.
   fee, `payment_fee_amount`, cashback snapshot incl. `shop_share_amount`). Client sends `expectedPay`; mismatch → 409, nothing written.
2. **Pay**: existing `/api/payments/initialize` gains order types for these tables; it re-reads the amount from the DB (never the
   client) and adds **no** extra Paystack fee (the payment fee is already inside `paid_amount`).
3. **Confirm** (Paystack webhook / verify, idempotent): guarded `unpaid → paid` on the order, then credit the shop share
   (`shop_profits`, one row per order, idempotent), then dispatch through the existing claim (`pending → processing`) and Hubtel
   purchase with **face**. Unknown/failed outcomes follow the Phase 3a/2b rules (never resend, never auto-refund).
4. Abandoned (never paid) orders expire like today's `pending_payment` airtime orders; nothing to refund.

### 4.3 Shop share and statement

- `shop_profits` row: `profit_amount = shop_share_amount`, links via new nullable `bill_order_id` / `data_order_id` (airtime uses
  the existing `airtime_order_id`), description "Airtime / Bundle / Bill cashback share".
- Shop dashboard shows these with the existing profit list; withdrawals unchanged.

## 5. Refunds (storefront)

- `/admin/refunds` learns the storefront commission orders (airtime via `airtime_orders` with `shop_id`, bills, bundles): refund =
  `paid_amount` through Paystack reversal or Moolre payout (existing gateways), plus the existing negative `shop_profits` clawback.
- New **"Mark refunded manually"** action (admin, note required, audit-logged): records the refund (status/payment_status refunded,
  `refund_method = 'manual'`), claws back the shop share; no money moves in our system.
- Eligibility mirrors 3a/2b: never while the Hubtel ledger row is pending/needs_review/created; never after delivery; never-sent
  orders after 60 s; stuck claims after 5 min (SQL-guarded release).

## 6. Public API (`/api/v1`, API-key auth, wallet-paid)

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/airtime` (exists) | Cashback pricing with channel `api`; `expected_pay` (optional) → 409 + `quote` on mismatch (already supported). |
| `GET /api/v1/bundles?network=` | Hubtel catalog with the caller's price, `bundle_token` per bundle (10 min). |
| `POST /api/v1/bundles` | `{ bundle_token, phone, idempotency_key, expected_pay? }` → order; same engine as dashboard `buyBundle` with channel `api`. |
| `POST /api/v1/bills/verify` | `{ biller, … }` → `{ customer_name, amount_due, verify_token, meters? }` (same as dashboard verify). |
| `POST /api/v1/bills` | `{ verify_token, amount, expected_pay? }` → order; same engine as `payBill` with channel `api`. |
| `GET /api/v1/bills/{ref}`, `GET /api/v1/bundles/{ref}` | Order status. |

- Orders are written with `channel='api'` (and the API key's user). Rate limits per key; docs added to `lib/api-docs-registry.ts`.
- Snake_case request/response fields like the existing v1 API.

## 7. Data model (one migration, additive)

- `hubtel_bill_orders`, `hubtel_data_orders`: `channel` check widened to `('dashboard','storefront','api')`; `shop_id uuid`,
  `customer_email text`, `customer_name text`, `payment_fee_amount numeric(12,2)`, `payment_reference text` (Paystack),
  `refund_method text`, `paid_at timestamptz`; no new status values — storefront orders start `pending` + `unpaid` (exactly like a
  dashboard order before its debit) and the payment confirmation flips `unpaid → paid` (guarded); indexes on `(shop_id, created_at)`.
  The existing never-sent / stuck-claim rules only ever consider `paid` orders, so an unpaid storefront order is never refundable.
- `airtime_orders`: `payment_fee_amount numeric(12,2)`.
- `shop_profits`: `bill_order_id uuid`, `data_order_id uuid` (+ unique partial indexes so a share is credited once per order).
- Debit RPCs unchanged (storefront orders are not wallet-debited).

## 8. Admin

- Cashback tab: Storefront and API switches become active; three **payment fee %** inputs; storefront live example shows customer
  pays (incl. fee), shop earns, Datagod keeps; margin report adds a channel filter and the shop-share column per channel.
- Utility Bills / Standard Bundles admin lists: channel + shop columns and filters.

## 9. Error handling

| Situation | Behaviour |
|---|---|
| Price changed between screen and initialize | 409 with new quote, nothing written. |
| Paystack paid twice / webhook replay | Guarded `unpaid → paid`; shop share unique per order; dispatch claim ⇒ one Hubtel POST. |
| Paid but Hubtel down/paused | Order paid + pending "Not sent", admin alerted; refund via /admin/refunds or manual. |
| Hubtel failure | Order failed → refund queue; shop share clawed back on refund. |
| Surface switched off after initialize | The unpaid order can still be paid at its stored price (the customer already saw it); new initializes refused. |

## 10. Build order

1. **Plan A — Storefront:** config/fee engine + migration + storefront airtime re-price + bills/bundles initialize + payment/webhook
   wiring + shop share + refunds (both methods) + storefront UI + admin.
2. **Plan B — API:** v1 bundles + bills endpoints, airtime channel `api`, docs registry, admin channel filter.

Each plan ships dark behind its surface switch.

## 11. Testing

Unit: fee step (round-up, per group, 0 %), storefront/API quotes incl. shop share, validator; initialize → pay → confirm idempotency
(double webhook, verify + webhook race), shop share once, clawback on refund (both methods), never-sent / stuck-claim refunds,
storefront airtime legacy path byte-identical when off; API endpoints contract tests. Real `next build`; one live storefront purchase
per group with a test shop.
