# Hubtel Commission Services — Phase 2 design (airtime switch + Standard Bundles)

Date: 2026-10-13 · Status: draft for review · Builds on Phase 1 (live-dark on main 9995d980, migrations 0113/0114 applied).
API source of truth: `docs/hubtel-commission-services/hubtel-docs-full-2026-10-12.md` (complete Hubtel page).

## 1. Purpose

Earn Hubtel's per-transaction commission on airtime and data without changing what existing customers already buy.

- **Airtime:** Hubtel becomes a selectable fulfilment provider per network, beside Digiwapy.
- **Data:** a new customer page, **Standard Bundles**, sells Hubtel's own bundles (looked up live for the buyer's number) at
  **Hubtel's exact price, no markup**. Datagod's income is Hubtel's commission only.

Success: an admin can flip one network's airtime to Hubtel and back; a customer can open Standard Bundles, enter a number,
browse that number's bundles in category tabs, pay, and receive the bundle — with every failed or unknown outcome landing in
the Phase 1 review queue and nothing ever auto-resent or auto-refunded.

## 2. Decisions (from the user, 2026-10-13)

| Topic | Decision |
|---|---|
| Airtime provider | Per-network switch: Digiwapy / Hubtel / manual. No automatic cross-provider fallback. |
| Data catalog | Separate Hubtel catalog, live from Hubtel (no stored catalog). After the 2026-10-13 live check showed identical lists across numbers: **browse first, buyer's number re-checked at purchase.** |
| Data price | Hubtel's price, **no markup**. |
| Shop profit on Hubtel data | **None.** |
| Surfaces for data | Customer dashboard, shop storefronts, public API v1. USSD/WhatsApp stay in Phase 4. |
| Data page | Its own sidebar link and page named **Standard Bundles**; bundles shown in **category tabs**. Existing Data page untouched. |
| Telecel Broadband | Own sidebar link — **Phase 3** (bills), not here. |
| Failures | Never auto-refund, never auto-resend (unchanged from Phase 1). |

## 3. Scope and order

Phase 2 is split into three independently shippable parts, each with its own implementation plan:

- **2a — Foundation + airtime:** Phase 1 carry-over fixes (§4) and the airtime provider switch (§5).
- **2b — Standard Bundles on the customer dashboard** (§6, §7).
- **2c — Standard Bundles on shop storefronts and public API v1** (§8).

Out of scope: bills/broadband (Phase 3), USSD/WhatsApp (Phase 4), commission wallets / partner split (Phase 3).

## 4. Phase 1 carry-over (2a, first — real orders depend on these)

1. **Static adapter registration.** `lib/hubtel-cs/runtime.ts` imports and registers every product `OrderAdapter`
   (`airtime_orders` in 2a, `hubtel_data_orders` in 2b), so the callback route, cron and admin routes all see them.
   A row with an `order_table` but no adapter already logs at error level.
2. **Re-notify sweep.** Ledger rows can reach `fulfilled`/`failed` while the adapter hook failed (logged, not retried).
   Add `hubtel_cs_transactions.order_synced_at timestamptz` (set after a successful hook). The status-check cron
   re-runs `notifyAdapter` for terminal rows with `order_table` set and `order_synced_at` null, older than 2 min, capped
   per run. Adapter hooks must be idempotent (marking an already-completed order completed is a no-op).
3. **Atomic 4075 pause.** Replace the read-modify-write in `setHubtelCsPaused` with a single SQL `jsonb_set` RPC on
   `admin_settings.value` for key `hubtel_cs_config`, so a concurrent admin save cannot drop a fresh pause.
4. **5xx carrying 0000/0001.** Ruling: an HTTP status ≥ 500 is classified `unknown` → `needs_review` regardless of the
   body's code (today 0000/0001 short-circuit before the 5xx guard). Conservative; only affects a response Hubtel should
   never send.
5. **Review-queue alert.** When a row enters `needs_review`, send one admin alert (existing `lib/admin-actions/` notifier
   or `notifyAdmins`), debounced so a burst sends at most one alert per 15 min, never throwing.

## 5. Airtime provider switch (2a)

- **Setting:** `admin_settings` key `airtime_provider_<mtn|telecel|at>` with value `{ provider: "digiwapy" | "hubtel" | "manual" }`.
  Absent key ⇒ today's behaviour (the existing `airtime_digiwapy_enabled_<net>` flag decides Digiwapy vs manual), so
  nothing changes until an admin picks a provider. Edited on the existing `/admin/airtime/settings` page.
- **Single chokepoint:** every surface (wallet purchase, storefront Paystack webhook, API v1, USSD) already reaches
  `triggerDigiwapyFulfillment(order)` in `lib/airtime-service.ts`. It becomes `triggerAirtimeFulfillment(order)`, which
  reads the provider and dispatches:
  - `digiwapy` → existing code path, unchanged.
  - `hubtel` → `hubtelCs.purchase({ serviceKey: airtime_<net>, destination, amount, orderTable: "airtime_orders",
    orderId })`. On `pending` the order moves to `processing` with a note carrying the Hubtel client reference.
    A synchronous Hubtel validation error (never sent) leaves the order `pending` with an admin alert, exactly like a
    Digiwapy failure today. `HubtelOutcomeUnknownError` / `needs_review` ⇒ order stays `processing`, admin alerted, review queue owns it.
    Disabled/paused Hubtel ⇒ treated like "provider unavailable": order stays `pending`, admin alerted (no silent switch to Digiwapy).
  - `manual` → existing manual-needed alert.
- **Amounts over GHS 100:** Hubtel's per-request cap. Orders above 100 on a Hubtel network are not split (splitting multiplies
  the unknown-outcome risk); they go to manual with an alert. Admin page shows this limit next to the Hubtel option.
- **Adapter `airtime_orders`:** `onFulfilled` → `status: completed` (+ note with Hubtel transaction id); `onFailed` → order
  stays non-completed with `status: failed` and a note; refund remains manual through the existing `/admin/refunds` flow
  (Phase 1's `refundToWallet` is implemented by delegating to it, wallet orders only). Commission is recorded on the
  ledger row only (no new airtime column).
- Customer-facing copy and prices do not change.

## 6. Standard Bundles — data model and lookup (2b)

- **New table `hubtel_data_orders`** (migration = next free number at plan time; additive, service-role only like 0113):
  `id, reference_code (unique), user_id (nullable for storefront), shop_id (nullable), channel ('dashboard'|'storefront'|'api'),
  network ('MTN'|'TELECEL'|'AT'), service_key, beneficiary_phone (233 form), bundle_value (exact, untrimmed), bundle_display,
  bundle_category, amount numeric(12,2), payment_status, status ('pending'|'processing'|'completed'|'failed'),
  hubtel_client_reference, transaction_id (payment), notes, created_at, updated_at`.
  Unique `(hubtel_client_reference)`; index `(user_id, created_at)`.
- **Live verification (2026-10-13, account 2027144, keys work):** read-only queries for two different numbers per network
  returned **identical lists** (MTN 37, Telecel 27, AT 30 bundles). Raw responses saved as
  `lib/hubtel-cs/testing/fixtures/live-bundle-query-2026-10-13.json` and used as test fixtures. **The live `Value`s differ
  completely from the docs' samples** (e.g. MTN `RACT_Data_Flexi_Bundle`, Telecel `DATANVDBDL1`, AT `db_BigTime_Data_…`) —
  design below follows the live data, not the docs.
- **Browse first, verify at purchase.** Because lists matched across numbers, the page shows a network's bundles before any
  number is entered:
  - **Catalog endpoint** `GET /api/standard-bundles/catalog?network=` → queries Hubtel with a per-network **reference number**
    (admin setting; defaults to Hubtel's documented sample numbers), cached server-side 10 minutes. Returns
    `{ bundles: [{ id, display, value, amount, category }] }`, `id` = HMAC-signed token of `(network, value, amount, issuedAt)`
    (10-minute validity), so the buy step can never receive an arbitrary value/amount pair. Rate-limited per user/IP.
  - **At purchase the buyer's own number is always re-queried** (§7 step 2). If that number's list doesn't contain the
    `(value, amount)`, nothing is charged and the customer is told the bundle isn't available for that number. This keeps the
    flow safe even if some numbers do get different lists.
- **Categories** (no category field exists — mapping in `lib/hubtel-cs/bundle-categories.ts`, tested against the live fixture):
  - **MTN** by `Value`: contains `_Midnight_` → "Midnight"; `_Kokrokoo_` → "Kokrokoo"; `_Social_` → "Social Media";
    `_Video_` → "Video"; `_Data_` → "Data" (covers both `RACT_Data_GHC_*` and `RACT_Data_Flexi_Bundle`).
  - **Telecel** by the duration text before " - " in `Display`: "1 Hour" → "Hourly"; "1 day" → "Daily"; 2–7 days → "Weekly";
    8–31 days → "Monthly"; "No Expiry(12am - 5am)" → "Night"; "No Expiry" → "No Expiry".
  - **AT** by `Value` prefix: `db_BigTime_Data_` → "BigTime"; `db_Fuse_` → "Fuse (Mins + Data)"; `db_Sika_Kokoo_` → "Kokoo";
    `db_XXL_Family_Pack_` → "XXL Family".
  - Anything unmatched → "Other" (shown last). Tab order per network follows the order above. Admin can hide categories per
    network (§7). A test asserts every bundle in the live fixture maps to a non-"Other" category.
- **Identity:** a bundle is `(value, amount)` — MTN `RACT_*_Flexi_Bundle` values repeat at many prices (live data confirms).
- **Display:** show Hubtel's `Display` text trimmed; price from `Amount` formatted "GHS x.xx". Sort within a tab by amount.

## 7. Standard Bundles — dashboard page and purchase flow (2b)

- **Sidebar:** new "Standard Bundles" link with the NEW tag (`lib/nav-new.ts`, 2nd-click clear), shown only when at least one
  network is enabled.
- **Page `/dashboard/standard-bundles`:** network selector (MTN / Telecel / AT, enabled ones only) → category pill-tabs →
  bundle cards (display, price "GHS x.xx") loaded from the catalog endpoint → tap a bundle → dialog asks for the recipient
  number (validated against the network prefix map, like the Data page) and shows bundle, price, wallet balance → pay.
  Navy accent, light cards, `lg:` multi-column grid of bundle cards, usable at 500 px (memory rules: navy brand, desktop
  layout, NEW tag).
- **Buy** `POST /api/standard-bundles/purchase { token, phone }` (auth required):
  1. Verify token (signature, age ≤ 10 min, network enabled, category not hidden); validate phone for the network.
  2. **Re-query** Hubtel for the buyer's number and confirm `(value, amount)` is offered; if not → 409 "this bundle isn't
     available for that number / has changed — refresh" (nothing charged).
  3. Insert `hubtel_data_orders` row, debit wallet with existing `deduct_wallet` RPC (insufficient funds → order failed, no Hubtel call).
  4. `hubtelCs.purchase({ serviceKey: data_<net>, destination, amount, bundle: value, orderTable: "hubtel_data_orders", orderId })`.
  5. Return the order; UI shows "processing" and polls status.
  Any error after the wallet debit and before/at the Hubtel POST follows Phase 1 rules: never resend; unknown ⇒ review queue;
  refunds manual via the review queue's Refund button (adapter `refundToWallet` credits with `credit_wallet_safely`).
- **Adapter `hubtel_data_orders`:** fulfilled → `completed`; failed → `failed` + note; `refundToWallet` idempotent per order
  (keyed by order id, uses the Phase 1 refund claim). Customer order history: rows appear in `/dashboard/my-orders` via a
  new "Standard Bundles" filter.
- **Admin:** `/admin/hubtel-commission` Settings gains a Standard Bundles card: per-network enable, per-category hide,
  per-network catalog reference number.
  Transactions tab already lists the ledger rows.

## 8. Storefronts and API v1 (2c)

- **Storefront** `/shop/[slug]/standard-bundles`: same lookup UI (public, rate-limited), payment through the existing
  storefront Paystack initialize pattern (amount = Hubtel price, **no shop markup, no shop profit**), order created with
  `channel: storefront`, `shop_id`. Paystack webhook branch on the order reference → mark paid → step 4 of §7. Re-query
  happens before initializing payment and again before the Hubtel POST; a mismatch after payment ⇒ order to review queue
  (customer has paid; refund manual), never a silent different bundle.
- **API v1:** `GET /api/v1/standard-bundles?network=` (catalog: bundles + categories + tokens) and `POST /api/v1/standard-bundles
  { token, phone }` (wallet; buyer's number re-checked as in §7), authenticated with `authenticateApiKey`, logged with `logApiRequest`, errors via `classifyServiceError`;
  sandbox mode returns canned bundles. Documented in the developer page.

## 9. Error handling summary

| Situation | Customer sees | System does |
|---|---|---|
| Lookup fails / Hubtel down | "Bundles unavailable, try later" | nothing charged |
| Bundle changed between lookup and buy | "This bundle changed — refresh" | nothing charged |
| Insufficient wallet | existing insufficient-funds message | order failed, no Hubtel call |
| Service disabled / paused (4075) | "Temporarily unavailable" | nothing charged (check before debit) |
| Hubtel definite failure after debit | "Failed — under review" | order failed, review queue, manual refund |
| Unknown outcome (timeout/5xx/0005) | "Processing — under review" | review queue, never resent |

## 10. Testing

Unit (Vitest, memory store + fakes): category mapping (all three networks, unknowns → Other), token sign/verify/expiry/tamper,
re-query mismatch path, purchase orchestration order (no Hubtel call before successful debit; never a second POST),
airtime dispatcher for each provider + >100 cap + disabled/paused, adapters idempotent, re-notify sweep, atomic pause RPC
contract, 5xx classification change, review-alert debounce. Real `next build` before any push. Live: one GHS 0.50 airtime per
network and one cheapest data bundle per network after the credential is set (runbook).

## 11. Carried forward to Phase 3 (bills) — not built here

- **ECG side effect:** Hubtel's ECG top-up "will link the phone number to the meter if that has not already been done".
  The Phase 3 ECG page must tell the customer this before they pay, and require them to confirm. For POSTPAID meters the
  account number (not meter number) goes in `Extradata.bundle`.
- Telecel Broadband gets its own sidebar link and page (user decision, 2026-10-13).
- Bill query `Display` keys vary by service (`name`/`amountDue`/`account` vs StarTimes `Name`/`Account Number`/`Bouquet`);
  GOtv `amountDue` and ECG `Amount` can be negative; Ghana Water needs the per-query `sessionId` in the POST.

## 12. Rollout

Each part ships dark: airtime networks default to their current provider; Standard Bundles networks default disabled; the
sidebar link hides when none is enabled. Migrations applied before merge (cron/route depend on them), as in Phase 1.
