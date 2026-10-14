# Commission Cashback — Plan A: Storefronts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shop storefronts sell airtime, Utility Bills and Standard Bundles with commission-cashback pricing (face − customer share + per-group payment fee), paid through Paystack, with the shop owner's commission share credited at payment and clawed back on refund.

**Architecture:** Reuse the live engines: `lib/cashback` quote (+ a pure fee step), `lib/bills` / `lib/standard-bundles` verify/catalog/dispatch, the existing order tables (`airtime_orders`, `hubtel_bill_orders`, `hubtel_data_orders` with `channel='storefront'`), the existing Paystack init/webhook/verify routes (two new order types), `shop_profits`, and `/admin/refunds`. Storefront orders are never wallet-debited: created unpaid → Paystack confirmation flips them paid (guarded) → shop share credited once → dispatched once.

**Tech Stack:** Next.js 15, TypeScript, Supabase (service role), Vitest, Paystack, shadcn UI.

**Spec:** `docs/superpowers/specs/2026-10-14-cashback-storefront-api-design.md` (approved 2026-10-14). Parent: `docs/superpowers/specs/2026-10-13-commission-cashback-design.md`. Checkout reference: `docs/hubtel-commission-services/ref/cashback-checkout-reference.png`.

## Global Constraints

- Storefront price: `base = face − customerCashback` (share `storefrontCustomer`), `fee = ceil_to_pesewa(base × paymentFee[group] / 100)`, `pay = base + fee`; shop share uses `storefrontShop`; provider/Hubtel always gets **face**. Pesewa maths in integers (ceil: `Math.ceil(basePesewas * pct / 100 - 1e-9)`).
- `paymentFee` per group `{ airtime, bundles, bills }`, 0–10 %, ≤ 2 decimals, default 0. Config also gains `storefrontGroups: { airtime, bundles, bills }` (default false) — the admin-only switch per group; the validator now allows enabling surface `storefront` (still rejects `bots`, `api` until their plans).
- Storefront airtime with cashback not applied (surface/group off, provider manual, > Hubtel cap) ⇒ **today's pricing byte-for-byte** (merchant fee + shop markup + pay-separately). Applied ⇒ no fee/markup/pay-separately; `merchant_commission = shopShare`; `payment_fee_amount = fee`; `total_paid = pay`.
- Storefront bills/bundles exist only when storefront surface + that group are on (and the Phase 3a/2b master + per-biller/network switches).
- No wallet debits on storefronts. Order rows start `pending` + `unpaid`; Paystack confirmation does a **guarded** `unpaid → paid` (`.eq('payment_status','unpaid')`), sets `paid_at`, `payment_reference`; only the call that flipped it credits the shop share and dispatches. Amount check: Paystack amount must equal `paid_amount` (pesewa-exact) or the order is flagged for review and not dispatched.
- Shop share credited once: `shop_profits` unique per `airtime_order_id` (exists) / new `bill_order_id` / `data_order_id`.
- **Nothing sent to Hubtel or Paystack carries product words** (references, metadata labels, descriptions): use opaque ids; Paystack metadata `orderType` values are internal codes `cs_bill` / `cs_bundle` (not shown to customers) and the Paystack `reference` is 32-hex.
- Client always sends `expectedPay`; server re-quotes; mismatch ⇒ 409 `{ error, quote }`, nothing written.
- Refund amount = `paid_amount` (bills/bundles) / `total_paid` (airtime); clawback = negative `shop_profits` of the credited share. Never refund while the Hubtel ledger row is `created|pending|needs_review`, never after delivery; unpaid orders are never refundable.
- Reuse; do not duplicate the reviewed money code: export and call `dispatchBillOrder` and the bundles dispatch (export it as `dispatchBundleOrder`).
- Migrations additive, `IF NOT EXISTS`, `SET search_path = public`, REVOKE/GRANT service_role; next number expected **0120**. Route files export only handlers + config. Edit with Edit/Write tools only; regexes in tested lib helpers. Real `next build` before pushing. Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Paystack webhook and `/api/payments/verify` both firing (or a webhook replay) ⇒ one `unpaid→paid`, one shop share, one Hubtel POST (Tasks 5, 6).
2. Paystack amount ≠ `paid_amount` (tampered/partial) ⇒ not dispatched, admin alerted (Task 5).
3. Storefront airtime with cashback off is byte-identical to today, incl. shop markup + pay-separately (Task 3).
4. Refund of a storefront order returns exactly what the customer paid and claws back exactly the credited share — both via /admin/refunds and "Mark refunded manually" (Task 7).
5. Public (unauthenticated) storefront verify/catalog/initialize endpoints can't be abused: Turnstile + the existing per-email/phone/shop pending caps + rate limits; a verify token from one shop can't initialize at another (Task 4).

---

### Task 1: Migration 0120

**Files:** Create `migrations/0120_cashback_storefront.sql`.

- `hubtel_bill_orders`, `hubtel_data_orders`: drop/recreate the `channel` CHECK as `('dashboard','storefront','api')` (find the constraint name from 0117/0118; `ALTER TABLE … DROP CONSTRAINT IF EXISTS …; ADD CONSTRAINT …`); `ADD COLUMN IF NOT EXISTS` `shop_id uuid`, `customer_email text`, `customer_name text`, `payment_fee_amount numeric(12,2)`, `payment_reference text`, `refund_method text`, `paid_at timestamptz`; index `(shop_id, created_at desc)`. `user_id` must allow NULL for storefront rows (customers are anonymous) — `ALTER COLUMN user_id DROP NOT NULL` and a CHECK `(channel <> 'dashboard' OR user_id IS NOT NULL)`.
- `airtime_orders`: `payment_fee_amount numeric(12,2)`.
- `shop_profits`: `bill_order_id uuid`, `data_order_id uuid`; unique partial indexes `ON shop_profits(bill_order_id) WHERE bill_order_id IS NOT NULL AND profit_amount > 0` (and data). Check how the existing airtime uniqueness is declared (grep migrations for `airtime_order_id` unique) and mirror it so clawback (negative) rows are not blocked.
- Refunds: widen `order_refunds.order_table` CHECK and every refund RPC whitelist (`migrations/20261007_refunds_bulk_api_orders.sql` holds the latest definitions — copy each function verbatim, only extending the table lists) with `'airtime_orders','hubtel_bill_orders','hubtel_data_orders'`. If an RPC branches per table for amounts/columns, add the three tables' columns (amount = `total_paid` / `paid_amount`).
- [ ] Write, commit `feat(cashback): migration 0120 storefront commission orders, shop share links, refund tables (not applied)`.

### Task 2: Config + fee step

**Files:** Modify `lib/cashback/config.ts` (+ test), `lib/cashback/quote.ts` (+ test).

**Produces:** `CashbackConfig.paymentFee: Record<CashbackGroup, number>`, `CashbackConfig.storefrontGroups: Record<CashbackGroup, boolean>`; validator accepts both (fee 0–10, ≤2 dp; groups booleans) and allows `surfaces.storefront = true`; `export interface StorefrontQuote extends CashbackQuote { base: number; paymentFee: number; feeRate: number }`; `export function quoteStorefront(i: Omit<QuoteInput,"channel"|"shop">, cfg): StorefrontQuote` = `quoteCashback({ ...i, channel: "storefront", shop: true })` + fee step (fee applied to `base` whether or not cashback applied, but only when `cfg.enabled && surfaces.storefront && storefrontGroups[group]`; otherwise `applied:false, paymentFee:0`).
Tests: reference GHS 10 MTN 3.96 storefront 20/40 + fee 1.95 ⇒ base 9.93, fee 0.20 (ceil of 19.36p), pay 10.13, shop 0.15; fee 0 ⇒ pay 9.93; DSTV 0.69 shares 20/40 fee 1.95 on GHS 100 ⇒ customer 0.13, shop 0.27, base 99.87, fee 1.95 (ceil 194.75p→195), pay 101.82; group off ⇒ not applied; validator rejects fee 10.5 / 3 dp / bots/api surfaces. Commit `feat(cashback): storefront payment fee and group switches`.

### Task 3: Storefront airtime pricing

**Files:** Modify `app/api/shop/airtime/initialize/route.ts`, `app/api/shop/airtime/public-constraints/route.ts` (expose storefront airtime rates for the page: per network `{ applied, rate, share, feePct, maxFace }` — only the shop-facing numbers), tests (extract the pricing block into `lib/cashback/storefront-airtime.ts` pure fn with tests if the route has no test harness).
- Resolve provider (`getAirtimeProvider` + `providerEarnsCommission`), serviceKey `airtime_<netId>`, Hubtel cap; `quoteStorefront`. Applied ⇒ `airtime_amount = face`, `fee_amount = 0`, `total_paid = pay`, `pay_separately = false`, `merchant_commission = shopShare`, `payment_fee_amount`, snapshot columns (`cashback_amount`, `shop_share_amount`, `cashback_rate`, `cashback_share`, `cashback_provider`, `expected_commission`). `expectedPay` mismatch ⇒ 409 before any insert. Not applied ⇒ existing code unchanged (test: identical inserted row vs before).
- Commit `feat(cashback): storefront airtime priced with cashback`.

### Task 4: Public storefront endpoints for bills and bundles

**Files:** Create `lib/storefront-commission/{shop,bills,bundles}.ts` (+ tests), `app/api/shop/bills/{verify,initialize}/route.ts`, `app/api/shop/bundles/{catalog,initialize}/route.ts`, `app/api/shop/commission/availability/route.ts`.
- `resolveShop(slug)` → active shop id + `availableGroups` (storefront surface + group switches + Phase 3a/2b switches); every route 404/403 when not available.
- Bills verify: reuse `verifyBill` with a synthetic binding `userId = "shop:" + shopId` (token is then shop-bound; initialize at another shop fails verification). Turnstile + rate limit (per IP 20/10 min, per shop 120/h).
- Bills initialize: `{ shopSlug, token, amount, customerName, customerEmail, customerPhone, expectedPay, turnstileToken }` → token check (single-use hash as dashboard), limits on face, `quoteStorefront(group bills)`, existing pending caps (mirror shop airtime: per email/phone/shop), insert `hubtel_bill_orders` (`channel 'storefront'`, `user_id null`, `shop_id`, customer fields, `amount = face`, `paid_amount = pay`, `payment_fee_amount`, snapshot, `status pending`, `payment_status unpaid`) → `{ orderId, payAmount }`.
- Bundles catalog: `getCatalog` + storefront prices per bundle; initialize: catalog token + Hubtel re-query for the recipient (as `buyBundle`), quote, idempotency key `(shop, key)` (store in `idempotency_key`; uniqueness is per `(user_id, idempotency_key)` so use a shop-scoped key string `shop:<id>:<key>`), insert `hubtel_data_orders` similarly.
- Commit `feat(cashback): storefront bill and bundle initialize endpoints`.

### Task 5: Payment wiring + confirmation

**Files:** Modify `app/api/payments/initialize/route.ts` (order types `cs_bill` → `hubtel_bill_orders`, `cs_bundle` → `hubtel_data_orders`; amount column `paid_amount`; status check `status='pending' AND payment_status='unpaid'`; **no** Paystack fee added; opaque 32-hex Paystack reference; metadata without product words), `app/api/webhooks/paystack/route.ts` and `app/api/payments/verify/route.ts` (call one shared confirm fn); create `lib/storefront-commission/confirm.ts` (+ test); export `dispatchBundleOrder` from `lib/standard-bundles/service.ts`.
- `confirmStorefrontOrder(deps, table, orderId, { paidAmount, reference })`: amount check (pesewa-exact vs `paid_amount`; mismatch ⇒ urgent alert, leave unpaid, return); guarded flip `unpaid→paid` (+`paid_at`,`payment_reference`); if 0 rows ⇒ already processed, return; insert `shop_profits` (`profit_amount = shop_share_amount` when > 0, `bill_order_id`/`data_order_id`, description "Cashback share", ignore 23505); dispatch via `dispatchBillOrder` / `dispatchBundleOrder` (claim inside guarantees one POST).
- Tests: webhook + verify concurrently ⇒ 1 flip, 1 share, 1 purchase; amount mismatch ⇒ no flip/dispatch + alert; share 0 ⇒ no profit row; dispatch throw ⇒ order stays paid pending "Not sent" (existing behaviour). Commit `feat(cashback): storefront payment confirmation, shop share, dispatch`.

### Task 6: Webhook/verify regression guard for airtime storefront

**Files:** `lib/airtime-service.ts` `markAirtimeOrderPaid`, test.
- Make the paid flip guarded (`.eq('payment_status', <current unpaid value>)` and act only if a row changed) so webhook + verify can't both dispatch; keep the existing unique profit insert. Test the double-confirm. Commit `fix(airtime): guarded paid flip so storefront airtime dispatches once`.

### Task 7: Refunds

**Files:** `lib/refunds/{types,orders,eligibility,clawback}.ts` (+ tests), `app/api/admin/refunds/**`, `app/admin/refunds` page; new `app/api/admin/refunds/manual/route.ts`.
- Add the three tables (storefront rows only: `shop_id is not null` for airtime, `channel='storefront'` for bills/bundles) with amount = `total_paid` / `paid_amount`, recipient = Paystack customer (email/phone) for reversal, Moolre payout to `customer_phone`.
- Eligibility: paid; not completed/delivered; Hubtel ledger row (if any) not `created|pending|needs_review`; never-sent after 60 s; stuck claim ≥ 5 min (reuse `lib/bills/admin-refund.ts` / `lib/standard-bundles/admin.ts` checks — call them, don't copy).
- Clawback: negative `shop_profits` for the credited share via the existing clawback helper (extend its link columns).
- "Mark refunded manually": `requireAdmin`, note ≤ 500, `auditLog`; guarded status flip to refunded + `refund_method='manual'`; clawback; idempotent.
- Commit `feat(cashback): storefront commission orders in refunds + manual refund`.

### Task 8: Storefront UI — airtime + bundles

**Files:** `app/shop/[slug]/storefront-client.tsx` (airtime pricing + new tab shell), create `components/storefront-commission/{BundlesTab,PriceSummary}.tsx` (reuse `components/cashback/PriceSummary` if suitable) .
- Airtime: when the page's storefront airtime rate says applied ⇒ hide pay-separately + markup lines, show "GHS pay (was GHS face)", fee line when > 0, You pay / You receive; send `expectedPay`; 409 ⇒ show new price, second tap.
- Bundles tab: availability → network pills → category tabs → cards with storefront price → sheet: recipient phone, customer name/email/phone, You pay / You receive, Turnstile → initialize → existing Paystack checkout (same as storefront airtime) → success/“processing” view polling the order status endpoint (add `GET /api/shop/commission/order?ref=` returning status only).
- Shop accent colour + existing storefront styling; 500px; no autoFocus. Commit `feat(cashback): storefront airtime cashback pricing and bundles tab`.

### Task 9: Storefront UI — bills

**Files:** create `components/storefront-commission/BillsTab.tsx` (+ small shared helpers in `lib/` if needed).
- Biller grid → verify (ECG phone/meter toggle, Prepaid/Postpaid, consent; Ghana Water phone+email; broadband landline+account) via `/api/shop/bills/verify` → amount (suggested = amount due) → You pay / You receive → customer details → initialize → Paystack → status view. Reuse dashboard field components where they are presentational. Commit `feat(cashback): storefront bills tab`.

### Task 10: Admin

**Files:** `app/admin/hubtel-commission/cashback.tsx`, `app/api/admin/cashback/config/route.ts`, utility-bills + standard-bundles admin lists.
- Cashback tab: Storefront surface switch active; per-group "Sell on storefronts" switches; payment fee % inputs; storefront live example (customer pays incl. fee, shop earns, Datagod keeps); margin report channel filter (dashboard/storefront) — extend `cashback_margin_report` only if needed (new optional `p_channel`; add to migration 0120 if so).
- Admin order lists: channel + shop name columns/filters for bills and bundles. Commit `feat(cashback): admin storefront settings`.

### Task 11: Verification, runbook, gate

- Full vitest (only the 9 known order-health failures), tsc 0, real `next build` exit 0.
- Runbook "Commission Cashback — Storefronts": apply 0120 before merge (pre/post checks incl. refund RPC smoke calls with a fake id), enable storefront surface + one group + fee %, buy once on a test shop (check order paid_amount, shop_profits row, Hubtel ledger amount = face), refund it once via /admin/refunds and once manually on another order (check clawback rows). Commit; STOP before migrating/pushing.

## Self-review

Spec §3 → Tasks 2–3; §4.1 → Tasks 8–9; §4.2 → Tasks 4–6; §4.3 → Tasks 1, 5; §5 → Task 7; §7 → Task 1; §8 → Task 10; §9 → Tasks 4–7; §11 → per task + Task 11; references rule → Global Constraints + Task 5. API (§6) is Plan B.
