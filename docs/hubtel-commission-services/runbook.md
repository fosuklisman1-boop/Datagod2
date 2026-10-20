# Hubtel Commission Services - Phase 1 rollout runbook

Phase 1 ships DARK: nothing customer-facing, master switch OFF. Order matters.

> **WARNING: apply migrations 0113 and 0114 BEFORE merging to main.** The merge deploys the every-2-minutes status-check cron, which reads the ledger table. (It now skips quietly with `skipped: "ledger not migrated"` if the table is missing, but do not rely on that.)
> Pre-apply check: `select to_regclass('public.hubtel_cs_transactions');` must return NULL. 0113 was edited in place before it was ever applied; if the table ALREADY exists, STOP: do not re-run 0113. Add the missing columns/index via a follow-up migration instead.

## Before enabling
1. Apply migrations `0113` and `0114` to production (Supabase Management API SQL, see memory `reference-supabase-access`). Both are additive. Verify: `select * from hubtel_cs_stats();` returns one row of zeros.
2. Set Vercel env (production): `HUBTEL_CS_CALLBACK_SECRET`, `HUBTEL_CS_BASIC_AUTH` (base64 `clientId:secret` for Commission Services), `HUBTEL_DISBURSEMENT_ACCOUNT`. Confirm `NEXT_PUBLIC_APP_URL`, `HUBTEL_RELAY_URL`, `HUBTEL_RELAY_SECRET` already exist. Optional: `HUBTEL_CS_ENFORCE_CALLBACK_IP=true` once a first callback has been seen from 18.202.122.131.
   - Use a callback secret of at least 32 random characters. The readiness check enforces this: a shorter `HUBTEL_CS_CALLBACK_SECRET` is reported as not ready ("HUBTEL_CS_CALLBACK_SECRET (min 32 chars)").
   - Confirm `NEXT_PUBLIC_APP_URL` is the canonical `https://www` host. An apex-to-www 307 redirect silently dropped another provider's webhooks. A POST with a bad signature to the callback URL (`/api/hubtel-cs/callback?...`) must return 401, not a 3xx.
   - The callback URL carries the HMAC signature in its query string, so Vercel and relay request logs contain it. Restrict log access, and rotate `HUBTEL_CS_CALLBACK_SECRET` if it leaks. Rotation invalidates in-flight callbacks; the status-check cron settles those rows.
3. Deploy. Open `/admin/hubtel-commission`: the readiness card must say all variables are set.
4. Status checks use the relay `/status` (already deployed for USSD). If `mode: relay` is ever used for purchases, redeploy the droplet with `HUBTEL_CS_BASIC_AUTH` set (see `scripts/hubtel-relay/README.md`).

## Smoke test (live, at most GHS 5)
The page's test purchase sends a REAL purchase. It requires `confirm` (the UI sends it), is capped at GHS 5, and the page locks the Send button for 10 s after an unknown outcome (check Transactions before trying again).
1. Settings: master switch ON.
2. Live test: MTN Airtime, your own number, GHS 0.50. Expect state `pending` immediately, then `fulfilled` via callback within about 1 min, and a commission value on the row.
3. Force the fallback: temporarily block `/api/hubtel-cs/callback` (for example with a Vercel firewall rule), run one GHS 0.50 test, and confirm the status-check cron settles it after 5 min or more. Then remove the rule. (A wrong-secret trick cannot work: the same env var both signs and verifies the callback URL.)
3a. After a callback-settled test, call `POST /api/admin/hubtel-cs/check-status` with `{ "ref": "<client reference>" }` (curl with an admin session, or temporarily via the UI) and confirm Hubtel `/status` reports `Paid` with `isFulfilled: true` for a commission reference. This validates the spec's open assumption that the Collection account is the right account to query.
4. Data: use the query endpoint via a one-off script to read a real bundle `Value` and price, then send one live test with that exact bundle and amount.
5. Set a low-balance threshold above the current float and confirm one SMS/email arrives (then set it back).

## Status-check semantics
- `Paid` with `isFulfilled=false` is treated as keep-polling (inconclusive), never a failure. Only a non-Paid status with `isFulfilled=false`, seen twice at least 90 s apart and after the row is 10 min old, fails a row.
- Manual **Check status** inside 90 s of the previous check is recorded but not counted as a second negative.
- `needs_review` rows are NOT polled and raise NO alert: admins must watch the Review Queue (follow-up: add an alert).
- Status-check errors (relay down, bad response) leave rows `pending`; the 24 h sweep then moves them to `needs_review`.

## Destinations
- Airtime and data destinations are normalised and stored as `233XXXXXXXXX`. Admin search in Transactions accepts 0-prefixed numbers too.
- Bill destination (account number) formats are UNVERIFIED. Live-verify each bill service before Phase 3.

## Safe operations
- A row in **Review Queue** is never resent automatically. Use **Check status** first; resolve manually with a note.
- `HubtelOutcomeUnknownError` means the POST may have been sent but the outcome could not be recorded. NEVER retry. Find the row by its reference in **Transactions** and check status with Hubtel.
- Per-order uniqueness: a partial unique index allows one non-failed transaction per `(order_table, order_id)`. An order whose transaction is `needs_review` blocks re-purchase until that row is resolved to `failed`.
- A 4075 pauses the service and alerts admins (the float is shared with Hubtel SMS). The first 4075 after a Resume always alerts; repeats are debounced for 1 hour. Top up the Disbursement account, then **Resume** on the page.
- Turning the master switch OFF (or pausing) stops new orders. The status-check cron runs every 2 minutes and reconciles in-flight rows even when the service is disabled or paused.

## Refund safety
- Refunds are manual (admin action); nothing refunds automatically.
- An atomic claim (`refund_claimed_at` / `refund_claimed_by`) prevents double refunds. A row resolved to `failed` by an admin requires `force` to refund.
- If an order adapter throws during a refund, the claim is deliberately KEPT because the wallet may already have been credited. Verify the customer's wallet first. Only if it was NOT credited, clear the claim so the refund can be retried:
  ```sql
  update hubtel_cs_transactions set refund_claimed_at = null, refund_claimed_by = null where client_reference = '...';
  ```

## Known limits and follow-ups
- No product wiring yet: no order adapters are registered, so **Refund to wallet** is disabled until Phases 2/3 add them. The data bundle sync and an airtime provider are Phase 2.
- `hubtel_cs_stats()` is defined with `SET search_path = public` in the 0113 file here; if 0113 was already applied before that change, re-run the `CREATE OR REPLACE FUNCTION` statement.
- No route-level tests exist for the admin routes, and the Supabase store has no unit tests (fake-client gap).
- Hubtel de-duplication of a repeated `ClientReference` is unknown, so unknown POSTs are never resent.

## Phase 2 carry-over
- Register order adapters statically in `lib/hubtel-cs/runtime.ts` (imported by both the callback route and the cron) so they exist in every serverless entry point.
- Add a re-notify sweep for rows where the ledger is terminal but the order was not updated.
- Make the 4075 pause atomic (a `jsonb_set` RPC) before any customer traffic.
- Decide how to classify a 5xx response carrying code 0000/0001.
- Verify bill account number formats against the relay `CS_QUERY_VALUE` charset (Phase 3).

## Phase 2a — airtime provider switch (rollout)

1. Apply `migrations/0115_hubtel_cs_config_patch.sql` and `migrations/0116_hubtel_cs_order_synced.sql` to production
   BEFORE merging (the runtime calls the new RPC and the cron reads the new column). Verify:
   `select to_regprocedure('hubtel_cs_config_patch(jsonb)')` is not null and
   `select column_name from information_schema.columns where table_name='hubtel_cs_transactions' and column_name='order_synced_at'` returns a row.
   - RPC smoke test: note the current value of `select value from admin_settings where key='hubtel_cs_config'`, run
     `select hubtel_cs_config_patch('{}'::jsonb);` then `select hubtel_cs_config_patch('{"services":{"airtime_mtn":true}}'::jsonb);`
     and confirm `paused` and every other key survive (compare the value before/after; only `services.airtime_mtn` may differ). Set it back afterwards if you do not want it on yet.
   - BEFORE applying 0116 run `select count(*) from hubtel_cs_transactions where order_table is not null and state in ('fulfilled','failed')`. Expected 0. Phase 1 smoke rows with an `order_table` but no adapter would otherwise be retried forever by the re-notify sweep.
2. Merge + deploy. Nothing changes until an admin picks a provider: with no `airtime_provider_<net>` setting the legacy
   Digiwapy toggle still decides.
3. Hubtel must be enabled and ready on `/admin/hubtel-commission` (credential + account are set in Vercel since 2026-10-13). Readiness checklist:
   - `HUBTEL_CS_CALLBACK_SECRET` is at least 32 characters;
   - `NEXT_PUBLIC_APP_URL` is set (canonical https://www host);
   - relay env (`HUBTEL_RELAY_URL`, `HUBTEL_RELAY_SECRET`) is set;
   - the Hubtel master switch is ON;
   - the per-service switch `airtime_<net>` (e.g. `airtime_mtn`) for the canary network is ON.
4. On `/admin/airtime/settings` -> "Fulfilment provider", set ONE network to Hubtel and press the page's **Save Changes** (the provider buttons only change local page state until saved). Buy GHS 0.50 airtime to your own number
   on that network from the dashboard. Expect: order `processing` with `[hcsRef:HCS-...]`, then `completed`, normally within ~1 min. With no callback it can take up to about 7 minutes (the cron only checks pending rows after 5 minutes, and runs every 2). Do NOT resend during that time.
   the ledger row on `/admin/hubtel-commission` shows `fulfilled` and a commission.
5. Roll back any time by choosing Digiwapy or Manual for that network. In-flight Hubtel orders still settle (cron runs regardless).

Behaviour to know:
- Orders over GHS 100 on a Hubtel network are NOT split: they stay `pending` with an admin alert for manual fulfilment.
- Hubtel off / paused / not configured => orders stay `pending` + alert; no silent switch to Digiwapy. "Nothing sent" alerts use SMS type `airtime_manual_needed`.
- A definite Hubtel failure returns the order to `pending` (same as Digiwapy failures) for an admin; never auto-resent. This
  applies only when the order is currently `pending` or `processing`: an order the admin already marked `failed`/refunded is
  left untouched. If Hubtel later delivers such an order, admins get a "possible double value" alert (check for double value).
- Outcome unknown / `needs_review` => order `processing`, alert (SMS type `airtime_hubtel_review`), the Hubtel review queue owns it. Do not resend.
- Airtime refunds are NOT in `/admin/refunds` (that page has no airtime support). The real path is `/admin/airtime` -> **Mark failed**, which refunds the wallet immediately and does NOT check the Hubtel ledger. RULE: resolve the Hubtel review row first (Mark failed in the Hubtel review queue returns the order to `pending`), and NEVER refund an airtime order whose Hubtel ledger row is `pending` or `needs_review` (Hubtel may still deliver, giving double value).
- Admins get one "transaction needs review" alert per 15 min when rows enter the review queue.
- If an order hook fails, the 2-minute cron re-runs it (rows with `order_synced_at` null).
- Choosing "Digiwapy" explicitly for a network bypasses the legacy per-network Auto Fulfillment toggle (it auto-sends even if that toggle was off). There is no "unset" option in the UI; to revert to the legacy behaviour, delete the `airtime_provider_<net>` row.
- Hubtel deliveries currently send no customer in-app/push notification (the Digiwapy cron does). Follow-up: add it before enabling beyond a one-network canary.

## Phase 3a — Utility Bills

Wallet-paid bill payments (ECG, Ghana Water, DSTV, GOtv, StarTimes, Telecel Broadband) over Hubtel. The bills master switch and every biller ship OFF; the Hubtel `bill_*` service switches default ON (see step 2.1).

1. Apply `migrations/0117_hubtel_bill_orders.sql` BEFORE merging/deploying. It creates `hubtel_bill_orders` (including `verify_token_hash` UNIQUE, `session_id`, `broadband_account`) and three RPCs: `utility_bills_config_patch`, `bill_order_debit`, `hubtel_bill_orders_stats`.
   - Pre-check: `select to_regclass('public.hubtel_bill_orders');` must be null.
   - Post-check: the table exists with RLS on (`select relrowsecurity from pg_class where oid='public.hubtel_bill_orders'::regclass;` is true; anon/authenticated have no grants). The three functions exist and only `service_role` can EXECUTE them (check `has_function_privilege` for anon, authenticated, service_role).
   - Smoke: `select utility_bills_config_patch('{}'::jsonb);` returns the config without error (creates the `utility_bills_config` admin_settings row if absent).
   - Smoke: `select bill_order_debit(gen_random_uuid());` returns `'not_found'`.
   - Smoke: `select * from hubtel_bill_orders_stats(null,null,null,null,null,false);` returns exactly one row of zeros.
   - Verified 2026-10-13: `transactions` has no CHECK constraint on `type`/`source`, so the `utility_bill` history rows are accepted. The unique constraint `unique_transaction_reference` on `(user_id, reference_id, type)` exists, which makes concurrent refunds safe (the second credit with the same `bill-refund-<order id>` reference is rejected).
2. Enable order (the bills config is the real gate):
   1. `/admin/hubtel-commission`: Hubtel must be enabled and ready (see Phase 2 readiness checklist) and the Hubtel `bill_*` service switches you want (`bill_ecg`, `bill_ghana_water`, `bill_dstv`, `bill_gotv`, `bill_startimes`, `bill_telecel_broadband`) must be ON. These Hubtel switches default ON (`defaultEnabled: true` in `lib/hubtel-cs/services.ts` for 5 of 6; `bill_telecel_broadband` defaults OFF), so do not rely on them to keep bills dark: the bills config (master switch + per-biller switches on `/admin/utility-bills`, default OFF) is the real gate. A biller whose Hubtel switch is off is unavailable even if enabled below.
   2. `/admin/utility-bills` -> Settings: turn on the master switch and ONE biller (and decide auto-fulfil).
   3. Pay the minimum to a known account. Check the order goes `completed` with a commission, the Hubtel ledger row is `fulfilled`, and the wallet history has a `transactions` row with reason `utility_bill`.
   4. Then enable the remaining billers.
3. How payment works: the customer first verifies the account (single-use token, valid 10 minutes, bound to the user and inputs). Paying runs every pre-check (token, biller enabled, amount within the biller's min/max, Hubtel enabled/not paused) BEFORE any write, so nothing is charged if a pre-check fails. The wallet debit, the paid mark and the wallet-history row happen together in one DB function (`bill_order_debit`). Reusing a token returns 409 "verify again". Insufficient balance marks the order `failed` with no debit. If the debit result is uncertain the order is re-read; only `payment_status = paid` is believed, otherwise admins are alerted and the customer is told to check their wallet.
4. Admin operations (`/admin/utility-bills`):
   - Dispatch: for paid, pending orders that never reached Hubtel (auto-fulfil off, or notes say "Not sent: ..."). Dispatch is refused if a Hubtel ledger row already exists (resolve it in Hubtel Commission instead).
   - A "Dispatching…" claim (status processing, no Hubtel ref, no ledger row) older than 5 minutes is considered stuck and can be released via Dispatch or Refund. If a Hubtel row appears during the release, the action aborts and the order is restored to processing with an admin alert.
   - Refund Queue rules: never refund while the Hubtel row is `pending` or `needs_review` (or `created`); Hubtel-fulfilled and completed orders cannot be refunded. Orders that never reached Hubtel (no ledger row) are refundable once not updated for 60 seconds. Failed Hubtel rows refund through the Phase 1 ledger path (an admin-overridden row needs the force confirmation). Refunds are idempotent with credit reference `bill-refund-<order id>`; if the outcome is reported unknown, check the wallet, then retrying is safe.
5. Biller specifics:
   - ECG: the customer enters their mobile number; "add meter" links that phone to the meter on Hubtel (the customer must tick the consent box). Without it, verification lists the meters already linked to the phone.
   - Ghana Water: needs mobile + email + meter number; verification returns a session id that is required for the payment, so the payment must happen within 10 minutes of a fresh verification (verify again after that). Because the session id is per-lookup, admin Dispatch refuses a Ghana Water order created more than 10 minutes ago with "Ghana Water verification expired — refund instead"; refund it from the Refund Queue.
   - Telecel Broadband: needs the 10-digit landline AND the broadband account number (e.g. P0444101).
   - DSTV / GOtv: smartcard number. StarTimes: account number.
6. Known follow-ups:
   - StarTimes and Telecel logos (`public/billers/*.png`) are small app icons, not official logos (see `public/billers/SOURCES.md`); replace with official assets (128x128, <= 30 KB).
   - Input validation accepts only letters, digits and `-` (4-30 chars) for account/meter/smartcard numbers. A biller format containing `.` or `/` would be rejected; verify on the first live payments of each biller.
   - Phase 3b adds the storefront, the partner split and Commission Wallets.

## Phase 2b — Standard Bundles

Wallet-paid Hubtel data bundles at Hubtel's exact price (no markup; income = Hubtel commission) on `/dashboard/standard-bundles`. The Standard Bundles master switch and every network ship OFF; the Hubtel `data_mtn` / `data_telecel` / `data_at` service switches default ON, so the Standard Bundles config is the real gate.

1. Apply `migrations/0118_hubtel_data_orders.sql` BEFORE merging/deploying. It creates `hubtel_data_orders` (UNIQUE `(user_id, idempotency_key)`) and two RPCs: `standard_bundles_config_patch`, `data_order_debit`.
   - Pre-check: `select to_regclass('public.hubtel_data_orders');` must be null.
   - Post-check: RLS on (`select relrowsecurity from pg_class where oid='public.hubtel_data_orders'::regclass;` is true), anon/authenticated have no grants, and only `service_role` can EXECUTE both functions.
   - Smoke: `select standard_bundles_config_patch('{}'::jsonb);` returns the config (creates the `standard_bundles_config` admin_settings row if absent).
   - Smoke: `select data_order_debit(gen_random_uuid());` returns `'not_found'`.
2. Enable order:
   1. `/admin/hubtel-commission`: Hubtel enabled and ready; the `data_*` service for the network ON.
   2. Same page → Standard Bundles card: turn on the master switch and ONE network. Optionally hide categories, or change the catalog reference number (any valid number on that network; bundle lists were identical across numbers when tested).
   3. Buy the cheapest bundle to your own number. Check the order goes `completed` with a commission, the Hubtel ledger row is `fulfilled`, and the wallet history has a `transactions` row with source `standard_bundle`.
   4. Then enable the other networks.
3. How buying works: the catalog is cached 10 minutes per network and each bundle carries a signed price stamp (10 minutes). At Buy, every pre-check runs before any write, then Hubtel is re-queried for the buyer's own number and the exact bundle value + price must still be offered, otherwise 409 "refresh" and nothing is charged. The page sends an idempotency key per buy; a repeat (double-click, retry after a timeout) returns the first order and never charges twice. Debit + paid + wallet-history row happen in one DB function (`data_order_debit`); the order is claimed (`processing`, "Dispatching…") before the single Hubtel call. Bundle values are sent to Hubtel exactly as Hubtel returned them (no trimming).
4. Refunds (manual only, credit reference `data-refund-<order id>` shared by both paths so it can never credit twice):
   - Order has a Hubtel ledger row → refund through the Hubtel review queue on `/admin/hubtel-commission` (never while the row is pending/needs_review).
   - Never sent (pending + paid, not updated for 60 s) or a stuck "Dispatching…" claim (processing ≥ 5 min, no ledger row) → Standard Bundles orders tab → Refund (note required). If the ledger cannot be read during the refund, the order stays `failed`, an urgent alert fires and the refund returns 503 — retry.
5. Known follow-ups:
   - Categories come from Hubtel's value/display naming (`lib/standard-bundles/categories.ts`, verified against all 94 live bundles on 2026-10-13). If Hubtel renames or adds bundles they land in "Other" — re-check the mapping.
   - The admin category chips list the known categories + "Other", not the live catalog.
   - MTN "Flexi" bundles (`RACT_*_Flexi_Bundle`) are NOT any-amount: live test 2026-10-14 (Midnight Flexi GHS 1.50 to 0555773910, ref FLEXITEST1791942803794, txn be5c3ba87522457892c77a472e960aa6) was accepted as 0001 pending then FAILED; nothing delivered. Only the listed price points work. The same response showed MTN data commission = 3.96% (0.0594 on 1.50).
   - Phase 2c adds storefront and public-API sales.

## Commission Cashback — Part 1 (dashboard)

Buyers pay face − (provider rate × share) on dashboard airtime, Utility Bills and Standard Bundles; the provider still receives face. Spec `docs/superpowers/specs/2026-10-13-commission-cashback-design.md`. Everything ships OFF (`commission_cashback_config` absent = all off, rates/shares 0).

1. Apply `migrations/0119_commission_cashback.sql` BEFORE merging/deploying — **required even with cashback off**: the bills and bundles code now inserts `paid_amount`, so without the column every bill and bundle purchase fails.
   - Pre-check: `select column_name from information_schema.columns where table_name='airtime_orders' and column_name='cashback_amount';` returns no row.
   - Post-check: the columns exist on `airtime_orders`, `hubtel_bill_orders`, `hubtel_data_orders` (+ `paid_amount` on the last two); `commission_cashback_config_patch`, `bill_order_debit`, `data_order_debit`, `cashback_margin_report` exist and only `service_role` can EXECUTE them.
   - Smoke: `select bill_order_debit(gen_random_uuid());` and `select data_order_debit(gen_random_uuid());` return `'not_found'`; `select * from cashback_margin_report(now() - interval '7 days', now());` runs; `select commission_cashback_config_patch('{}'::jsonb);` returns `{}`.
   - The two debit functions are replaced; with `paid_amount` NULL (every existing order and every order while cashback is off) they behave exactly as before.
2. Enable (`/admin/hubtel-commission` → Cashback):
   1. Rates: `airtime_mtn/telecel/at : hubtel` = 3.96, `bill_ecg : hubtel` = 1.708. Others: after their first live sales, the margin report shows the actual rate — click "Use actual", then Save. Digiwapy airtime: enter its rate once known (its actual commission is not yet verified — rows say "expected").
   2. Shares (% of the commission): customer, dealer (dealer = dealer or sub_agent role). Storefront shares are stored but inactive until Part 3.
   3. Master switch + **Dashboard** surface. Bots / storefront / API stay off (Parts 2–3).
   4. Buy GHS 1 airtime to your own number: order `airtime_amount` = 1.00 (face, sent to the provider), `total_paid` = pay, `fee_amount` = 0, `cashback_*` filled; wallet history = pay. Then one bill and one bundle: order `amount` = face, `paid_amount` = pay, Hubtel ledger amount = face.
3. Pricing rules:
   - Cashback = floor to the pesewa of face × rate% × share%. Shares are capped so a sale can never lose money.
   - With cashback on, dashboard airtime has no fee and no "pay fee separately" toggle. Where cashback does not apply (switch off, provider manual, Hubtel airtime above GHS 100, shop orders, API) today's fee pricing is unchanged.
   - The page sends the price it showed; any difference (rate edited, switch flipped, provider changed) returns 409 "Price updated" and charges nothing until the buyer confirms again.
4. Refunds return what the customer paid (`paid_amount`, or `total_paid` for airtime), never face.
5. Admin numbers: Utility Bills "Sales (face value)" sums face; order lists show "Paid GHS x" under the amount for cashback orders. The margin report shows set vs actual rate (✓ within 0.05 points), commission earned, cashback given, Datagod kept.
6. Not in Part 1: USSD/WhatsApp bots (Part 2), storefronts with shop share + markup removal, and the public API (Part 3). Surface switches other than Dashboard are rejected by the settings validator until then.
7. AirtelTigo airtime fix shipped with Part 1: the dashboard sends "AT", which the server previously rejected; the server now reads the real `airtime_enabled_at` / `airtime_fee_at_*` settings for both "AT" and "AirtelTigo" (v1 API resellers using "AirtelTigo" now get the AT switch and AT fee rates instead of the old 5% default).
8. Measured Hubtel commission rates (2026-10-14, from `Meta.Commission` in Hubtel's first reply — it is reported even when the transaction later fails, so a failing "probe" reveals the rate): MTN airtime 3.96 · Telecel airtime 5.19 · AT airtime 3.96 · MTN data 3.96 · Telecel data ≈2.70 · AT data ≈3.33 · ECG 1.708 · DSTV ≈0.69 · GOtv ≈0.69 · StarTimes ≈0.69 · Ghana Water ≈0.07 · Telecel Broadband 0. The "≈" rates come from GHS 0.75–1 sends (Hubtel rounds to 4 decimals). StarTimes account lookups returned 4000 "error during verification" for every account tried, including the docs sample — check with Hubtel before enabling StarTimes.
9. Follow-ups:
   - Mobile app (`mobile/src/lib/datagod.ts`) buys airtime without `expectedPay`: with cashback on, app users are charged the (lower) cashback price but the app shows the old fee price. Update the app to read `/api/cashback/rates` and send `expectedPay`.
   - Margin report: Digiwapy rows show 0 orders (expected figures only), and "actual" uses Hubtel `completed_at` while "given" uses order `created_at` — fine for weekly views, slightly off at window edges.
   - Digiwapy actual commission: confirm from a real status response before relying on Digiwapy rates.

## Commission Cashback — Storefronts (Plan A)

Shop storefronts sell airtime, Utility Bills and Standard Bundles with cashback pricing: customer pays `face − customer share + payment fee`, Paystack collects it, Hubtel/Digiwapy receive face, the shop earns its share of the commission (credited at payment, clawed back on refund). Spec `docs/superpowers/specs/2026-10-14-cashback-storefront-api-design.md`. Ships OFF.

1. Apply `migrations/0120_cashback_storefront.sql` BEFORE merging/deploying — required even with storefront cashback off: the admin lists, refunds and the margin report read the new columns/arguments.
   - What it changes: bills/bundles orders accept storefront rows (`user_id` nullable for `channel <> 'dashboard'`, `shop_id`, `buyer_*`, `payment_fee_amount`, `payment_reference`, `paid_at`, `refund_method`, `verified_at`); storefront bundle dedupe index `(shop_id, idempotency_key)`; `airtime_orders.payment_fee_amount`; `shop_profits.bill_order_id/data_order_id` (+ unique indexes); the airtime status CHECK is rebuilt from its live definition plus `refunding/refunded`; refund RPCs (`reserve/complete/fail_order_refund`) accept `airtime_orders`, `hubtel_bill_orders`, `hubtel_data_orders` (storefront rows only — wallet rows raise `BAD_CHANNEL`); `cashback_margin_report` gains `p_channel` (2-arg version dropped).
   - Pre-check: `select count(*) from information_schema.columns where table_name='hubtel_bill_orders' and column_name='buyer_email'` = 0.
   - Post-check: the columns/indexes exist; `pg_get_constraintdef` of `airtime_orders_status_check` lists the live statuses plus `refunding`,`refunded`; the refund functions and `cashback_margin_report(timestamptz,timestamptz,text)` exist with service_role-only EXECUTE; `select * from cashback_margin_report(now()-interval '7 days', now(), null)` runs.
2. Enable (`/admin/hubtel-commission` → Cashback): set the **payment fee %** per group (start with ≈ Paystack's real rate, e.g. 1.95, on Bills and Bundles; airtime may stay 0 because its commission covers Paystack), turn on the **Storefront** surface and **one** "Sell on storefronts" group. Check the live example (customer pays / shop earns / Datagod keeps).
3. Test on a test shop: buy the cheapest item, pay with MoMo/card, check the order (`paid_amount`, `payment_reference`, `paid_at`), the `shop_profits` row (share, linked to the order), the Hubtel ledger amount = face, and the payment-confirmation page shows Delivered. Then refund one via `/admin/refunds` (Paystack reversal) and one with "Mark refunded manually" — each must add one negative `shop_profits` row.
4. Behaviour notes:
   - Storefront airtime with cashback off (or provider manual, or above Hubtel's GHS 100 cap) keeps the old pricing exactly (merchant fee + shop markup). It now also honours the admin airtime on/off switches and min/max amounts (previously it ignored them).
   - Storefront bill verify shows **masked** names (e.g. `KLI*** FOS***`); verify fails closed when Turnstile is off; verify tokens are shop-bound.
   - Storefront orders are never wallet-paid: refunds go through `/admin/refunds` (Paystack reversal / Moolre payout) or "Mark refunded manually". The Hubtel review-queue and the bills/bundles admin refund buttons refuse storefront rows and link to Refunds.
   - Admin airtime page actions now only work on `pending`/`processing`/`flagged` orders (refunded/refunding/unpaid/expired are refused) — prevents double clawback/commission.
   - A Digiwapy delivery that arrives after a storefront refund triggers an urgent "double value" admin alert.
   - Unpaid storefront orders never expire; they are never refundable and never dispatched.
   - If `storefront_otp_required` is turned on, the Bills/Bundles sheets run the payer-phone OTP step.
   - Bills/Bundles tabs follow the domain's service allow-list (hidden where the data service is not allowed).
   - With `storefront_direct_charge` on (it is on in prod), Bills/Bundles pay by on-page MoMo prompt to the buyer's phone ("Your Mobile Money number"), like storefront airtime: sheet → approve / Telecel OTP → payment-confirmation page. With it off they use the hosted Paystack checkout. A declined prompt leaves the order unpaid; tapping Pay again reuses the same order (max 2 payment starts per order per hour).
   - `/admin/refunds` lists and refunds storefront airtime only for orders created on/after 2026-10-14 (`STOREFRONT_REFUNDS_FROM`). The older backlog (paid failed/pending storefront airtime) was handled out of band and stays off the queue.
   - A gateway refund (or retry) of a bill/bundle whose Hubtel failure was an admin override needs the "I confirmed it was not delivered" tick, like "Mark refunded manually".
   - Storefront airtime: the page always sends the price it showed; if cashback applies and the page did not send it (stale page / old client), the server answers 409 with the price instead of charging.
   - Admin airtime "Failed" on a storefront order sends no "refunded to your wallet" SMS and credits nothing: refund it on `/admin/refunds`.


## Commission Cashback — API
Adds `GET/POST /api/v1/bundles`, `GET /api/v1/bundles/{reference}`, `POST /api/v1/bills/verify`, `POST /api/v1/bills`, `GET /api/v1/bills/{reference}`, and API-channel cashback pricing on v1 airtime. Ships DARK: the API surface switch is OFF, so live keys get `403 not_available` on the bundle AND bill endpoints (`GET/POST /api/v1/bundles`, `POST /api/v1/bills/verify`, `POST /api/v1/bills`). Turning on Utility Bills for the dashboard does not open them to API keys. Test keys (sandbox) are not gated. `GET .../{reference}` is not gated, so integrators can always look up orders they already placed.

1. **Apply migration `0122_sandbox_commission_actions.sql` BEFORE deploying** (Supabase Management API SQL). Without it, sandbox bundle and bill orders fail on the `sandbox_orders.action` CHECK. It is additive.
   - Pre-check: `select pg_get_constraintdef(oid) from pg_constraint where conname = 'sandbox_orders_action_check';` should list 4 actions (`data_order`, `airtime`, `afa`, `results_checker`).
   - Post-check: the same query must now list 6 actions (adds `standard_bundle`, `utility_bill`).
2. Deploy. Nothing changes for live keys yet.
3. Admin > Hubtel Commission > Cashback: switch **API** ON (the master switch must also be ON, and the rates/shares for each group must be set). Bots stays "Coming later". Airtime pricing for API keys uses the same switch.
4. Sandbox test with a TEST key (`dg_test_...`, sandbox wallet, no real money):
   - Bundles: `GET /api/v1/bundles?network=MTN` returns the static `sbx_*` catalog; `POST /api/v1/bundles` with `bundle_token: "sbx_mtn_1gb"`, a 10-digit `phone` and an `idempotency_key` returns 201; repeating the same key returns the same order with no second debit; `GET /api/v1/bundles/{reference}` returns it.
   - Bills: `POST /api/v1/bills/verify` (`biller: "dstv"`, any `account`) returns "Sandbox Customer" and a `verify_token`; `POST /api/v1/bills` with that token and an amount returns 201; re-sending the same token returns the same order (201, same reference, no second debit); `expected_pay` different from the amount returns `409 price_changed`; `GET /api/v1/bills/{reference}` returns it.
   - Sandbox `idempotency_key` must match the live format (8-64 letters, digits or hyphens) or it is a 400.
   - Sandbox prices are face value and simulate no cashback (accepted).
5. Live test with ONE live key, your own account, smallest amounts:
   - Cheapest bundle: `GET /api/v1/bundles?network=MTN`, buy the cheapest to your own number with `expected_pay` set to its `pay_amount`. Confirm the order completes and appears on `/admin/hubtel-commission` Standard Bundles with channel "API" (filter: API).
   - Airtime: GHS 1 to your own number via `POST /api/v1/airtime`.
   - Bill: verify and pay the smallest bill you can on your own account; confirm it shows channel "API" on `/admin/utility-bills`.
   - Bill retry: re-send the exact same `POST /api/v1/bills` (same `verify_token`). It must return 201 with the SAME reference, and the wallet must show one debit only.
   - Also confirm switching **API** OFF returns `403 not_available` on the bundle endpoints AND on `POST /api/v1/bills/verify` and `POST /api/v1/bills`.
6. Contract change to tell integrators: v1 airtime `409 price_changed` now has the same shape as bundles/bills: `{ "success": false, "error": "price_changed", "message": "...", "quote": { "face_amount", "pay_amount", "customer_cashback" } }` (snake_case). Anyone parsing the old camelCase quote must update.

Notes:
- The Cashback margin report channel filter now has an `api` option. For bills and bundles it filters on the order channel. Airtime orders carry no API/dashboard marker (both are `airtime_orders` with a user and no shop), so the `dashboard` option for airtime is dashboard + API combined, and `api` shows no airtime.
- Bundle and bill orders placed by API keys are refundable like dashboard orders (wallet refund from the admin pages).
- A bill `verify_token` pays at most one order. On the API, re-sending a used token returns that order (looked up by token hash + user + channel `api`) instead of a 409, so a timed-out request can be retried safely. The dashboard still answers 409 "verify again".
- If the cashback config cannot be read (DB error), the bundles and bills API endpoints fail closed with 403 `not_available` (they exist only while the API switch is on, so an unreadable switch counts as off). The Utility Bills / Standard Bundles / Hubtel switches also fail closed (503) on their own read errors. v1 airtime is unaffected: it falls back to its standard pricing.

## Commission Cashback — Bots (Plan 1: shared engine)

Shared engine for all five bots (Hubtel USSD, main USSD, shop USSD, WhatsApp main + shop). Spec `docs/superpowers/specs/2026-10-14-cashback-bots-design.md`. **Nothing customer-visible yet** — Plans 2–4 add the menus. Ships OFF.

1. Apply `migrations/0123_cashback_bots.sql` BEFORE merging/deploying — required: the /admin/refunds loader and the admin bills/bundles lists select `bot_surface`.
   - Pre-check: `select count(*) from information_schema.columns where table_name='hubtel_bill_orders' and column_name='bot_surface'` = 0.
   - Post-check: `bot_surface` on both order tables; channel CHECKs list `dashboard, storefront, api, bots`; the bot dedupe index exists; `reserve_order_refund` accepts `channel IN ('storefront','bots')` for bills/bundles; service_role-only EXECUTE unchanged.
2. Admin (`/admin/hubtel-commission` → Cashback): Bots surface switch, per-group "Sell on bots" (Airtime / Network Plans / Pay Bills), two fee sets — "Paystack bots (USSD + WhatsApp)" and "Hubtel USSD" — added on top, rounded up. Keep everything off until a bot plan ships.
3. Rules the bot plans rely on:
   - Main bots (no shop): buyer gets the `customer` share, no shop share. Shop bots / Hubtel USSD in shop mode: buyer `storefrontCustomer`, shop `storefrontShop` (credited at payment, clawed back on refund).
   - Bot orders: `channel='bots'`, `bot_surface`, `buyer_phone`, `user_id` NULL; Ghana Water refused for USSD surfaces (WhatsApp only).
   - Abuse caps: bill verify 20/10 min per phone, 300/h per bot+shop, 2000/h global; unpaid bot orders ≤ 5/h per phone, ≤ 60/h per shop.
   - Paystack-paid bot orders use `BOT_PAYMENT_EMAIL` (default `payments@datagod.store`) when the buyer has no email.
   - Refunds: `/admin/refunds` — Paystack reversal only for Paystack-paid rows, Moolre payout to `buyer_phone`, or manual; Hubtel-USSD-paid rows: Moolre payout or manual.
4. Carried to Plans 2–4: bots must use the direct MoMo charge with the number they ask for (direct-charge ON strips MoMo from the hosted page); an in-process payment-init helper (payments/initialize is IP rate-limited); record the paying MoMo number and prefer it for refund payouts; airtime bot rows need a margin-report mapping.

## Commission Cashback — Bots (Plan 2: Hubtel USSD)

The live Hubtel USSD code ("Clingshub", currently in shop mode) gains two menus, **Network Plans** (Hubtel Standard Bundles) and **Pay Bills** (Utility Bills), plus cashback-priced **Buy Airtime**. All three are paid through Hubtel's AddToCart checkout and confirmed by the shared bot engine. Plan `docs/superpowers/plans/2026-10-14-cashback-bots-2-hubtel-ussd.md`. Ships DARK: the menus appear only when the cashback switches below are on.

0. **Pre-deploy: confirm the Bots switches are OFF.** "Ships dark" only holds if they are off in prod right now. If the Bots surface and a group are already on, that menu (and cashback airtime) goes live at deploy, not at step 3, and without 0125 its CONFIRMs fail.
   ```sql
   SELECT value->'enabled'          AS master,
          value->'surfaces'->'bots' AS bots_surface,
          value->'botGroups'        AS bot_groups
     FROM admin_settings WHERE key = 'commission_cashback_config';
   ```
   Expect `bots_surface` = `false` or NULL, and every `bot_groups` value (`airtime`, `bundles`, `bills`) = `false` or absent (no row at all also means off). If anything is `true`, either turn it off in Admin > Hubtel Commission > Cashback before deploying, or go ahead knowingly, with 0125 already applied.
1. **Apply `migrations/0125_hubtel_ussd_bot_orders.sql` BEFORE deploying.** Apply it after 0123, using Supabase Management API SQL. It widens the `hubtel_transactions.order_table` CHECK to add `hubtel_bill_orders` and `hubtel_data_orders`. Without it, every Network Plans / Pay Bills CONFIRM fails at the tx insert: the order is failed and the customer sees "Error creating order". Run it at a quiet time (it holds a table lock for one scan; `lock_timeout` 5 s makes it fail rather than hang, so just re-run).
   - **Pre-apply check (constraint name).** List EVERY CHECK on the table, not only the expected name:
     ```sql
     SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conrelid = 'public.hubtel_transactions'::regclass AND contype = 'c'
      ORDER BY conname;
     ```
     Exactly one row should mention `order_table`. It should be named `hubtel_transactions_order_table_check` and list the 6 tables from 0106 (`ussd_orders, ussd_shop_orders, airtime_orders, results_checker_orders, results_check_requests, ussd_afa_orders`). If it has a different name, STOP and edit the migration's `DROP CONSTRAINT` to that name. Left as is, the migration's assertion block would abort it, because it refuses to finish with any order_table CHECK other than the widened one.
   - Post-check: the same query returns exactly one `order_table` CHECK, `hubtel_transactions_order_table_check`, with those 6 tables plus `hubtel_bill_orders` and `hubtel_data_orders`.
2. Deploy. Customers see no change while the switches are off: the main and shop menus stay byte-for-byte the same (tested).
3. Turn it on in Admin > Hubtel Commission > Cashback:
   - Master switch ON, and the **Bots** surface ON.
   - "Sell on bots" per group: **Network Plans** (bundles), **Pay Bills** (bills), and **Airtime**, for cashback airtime on Hubtel USSD.
   - **Hubtel USSD fee set: 0 recommended for every group.** Hubtel adds its own checkout charge on top of our price, so a bot fee would charge the customer twice.
   - Rates and shares must be set for each group. In shop mode the buyer gets `storefrontCustomer` and the shop gets `storefrontShop`. In main mode the buyer gets `customer` and there is no shop share.
   - A menu shows only when ALL of these are on: master, Bots surface, the group's "Sell on bots" (bundles → Network Plans, bills → Pay Bills), and the Hubtel visibility toggle (step 4). If the cashback config cannot be read, both menus are hidden (fail closed). The gate is re-read on every request.
4. Visibility toggles on `/admin/ussd-hubtel`. The new "Network Plans" and "Pay Bills" toggles default to ON, so the cashback switch is the real gate. Turn a toggle off to hide that menu on Hubtel USSD only.
5. Test in shop mode with a test number (your own phone; smallest amounts):
   - Dial the code, enter a test shop's code. The product menu must show `4. Network Plans` and `5. Pay Bills` after the existing three items.
   - Network Plans: MTN → the cheapest plan → "My number" → confirm → approve the Hubtel prompt. Check `/admin/hubtel-commission` Standard Bundles: the order shows channel "Bot · Hubtel USSD", status completed, and the shop share credited.
   - Pay Bills: ECG → "This number" (or "Meter number" for a meter not linked to the phone; it asks consent to link) → GHS 1 → confirm → pay. Check `/admin/utility-bills`.
   - Airtime: Buy Airtime → your number. The prompt must read "Enter airtime amount". Then GHS 1 → the confirm screen shows `Pay GHS x (was GHS 1.00)`.
   - Leave one cart unpaid. After the status-check expiry it must show failed with "payment not completed" (payment_status stays `unpaid`, so it is never refundable or dispatched).
   - Switch the Bots surface OFF and re-dial: both menus are gone and airtime asks "Enter amount to pay" again.
6. What customers see (sample screens, shop mode):
   ```
   Ama Data Hub                      Network Plans
   What would you like to buy?       Select network:
   1. Buy Data Bundle                1. MTN
   2. Buy Airtime                    2. Telecel
   3. Results Checker                3. AirtelTigo
   4. Network Plans                  0. Back
   5. Pay Bills
   0. Exit

   MTN Internet                      Pay GHS 9.50 (was GHS 10.00)
   1. 1GB GHS 9.50                   You receive 1GB on 0244123456
   2. 2GB GHS 10.50                  1 Confirm 2 Cancel
   0 Next
   00 Back

   Pay Bills                         ECG
   1. ECG                            1 This number
   2. DStv                           2 Other number
   3. GOtv                           3 Meter number
   4. StarTimes                      0 Back
   5. Telecel Broadband
   0 Back

   ECG P1234567                      Pay GHS 49.00 (was GHS 50.00)
   Name: Kof*** Men***               You receive GHS 50.00 ECG on P1234567
   Due: GHS 12.50                    1 Confirm 2 Cancel
   Enter amount (GHS 1.00 - 1000.00):
   0 Back
   ```
   In main mode the same items follow `4. Results Checker` as `5. Network Plans` / `6. Pay Bills`. No screen says "data", "bundle" or "water". Hubtel's cart only ever shows `CH order <8 chars>`.
7. Rollback / disable, fastest first:
   - Hide one menu: turn off its visibility toggle on `/admin/ussd-hubtel`, or turn off its "Sell on bots" group.
   - Hide all bot menus and cashback airtime: turn the **Bots** surface OFF. Airtime returns to today's fee pricing on the next screen. A customer already on a confirm screen gets "Airtime rates changed. Please restart your order." and is never re-priced silently.
   - Whole channel: the Hubtel USSD kill switch on `/admin/ussd-hubtel`.
   - Code rollback: redeploy the previous build. 0125 is additive and can stay; do not drop the CHECK values while rows reference them.
   - Unpaid bot orders left behind are failed by the existing status-check expiry. An order the engine created but that never got a checkout (an engine error mid-CONFIRM) is failed right away, and the log shows "Failing uncarted engine order <id>".
8. **Paid bot orders held for review ("needs review:").** Hubtel can report a successful payment for a Network Plans / Pay Bills order that is then not delivered. The cases are:
   - the payment arrived after the order expired, or after an indeterminate expiry park;
   - the payment was short (`AmountAfterCharges` below the cart price);
   - the engine's pesewa-exact amount check failed (`amount_mismatch`);
   - the engine refused or errored;
   - the order had already been failed when the payment came in.

   In each case the code records the payment on the order in one guarded update: `payment_status='paid'`, `paid_at`, `payment_reference` (Hubtel OrderId or `hubtel-session:<sid>`), `status='failed'`, and `failure_reason` starting `needs review:`. It is never dispatched and no shop share is credited. The `hubtel_transactions` row is `needs_review` with a `review_reason`, and the callback to Hubtel still goes out as success.
   - Find them:
     ```sql
     SELECT 'hubtel_bill_orders' AS t, id, reference_code, buyer_phone, shop_id, paid_amount, payment_reference, paid_at, failure_reason
       FROM hubtel_bill_orders WHERE channel = 'bots' AND payment_status = 'paid' AND status = 'failed' AND failure_reason LIKE 'needs review:%'
     UNION ALL
     SELECT 'hubtel_data_orders', id, reference_code, buyer_phone, shop_id, paid_amount, payment_reference, paid_at, failure_reason
       FROM hubtel_data_orders WHERE channel = 'bots' AND payment_status = 'paid' AND status = 'failed' AND failure_reason LIKE 'needs review:%'
     ORDER BY paid_at DESC;
     -- the Hubtel side (amounts actually received):
     SELECT session_id, order_table, order_id, hubtel_order_id, amount_paid, amount_after_charges, paid_at, review_reason
       FROM hubtel_transactions WHERE state = 'needs_review' AND order_table IN ('hubtel_bill_orders','hubtel_data_orders')
      ORDER BY paid_at DESC NULLS LAST;
     ```
   - Verify first. Check that the Hubtel payment is real (Hubtel dashboard or status check by session id) and that nothing reached Hubtel Commission for the order: `hubtel_client_reference` is NULL and there is no `hubtel_cs_transactions` row for the order.
   - **Refund (default).** The order is listed on `/admin/refunds` (bots, failed, paid). Use **Moolre payout** to `buyer_phone` (the Hubtel rail charges the dialing phone), or **Manual** if the money went back another way. Paystack reversal is not offered for Hubtel-paid rows. The suggested amount is the order's `paid_amount`. For a short payment, refund what Hubtel actually received (`amount_after_charges` on the tx row), not more. No shop share was credited, so there is no clawback.
   - **Deliver instead** (customer prefers it, amount correct):
     - **Bills.** Move the row back to pending with a guarded update:
       ```sql
       UPDATE hubtel_bill_orders SET status = 'pending', failure_reason = NULL, notes = NULL, updated_at = now()
        WHERE id = '<id>' AND channel = 'bots' AND payment_status = 'paid' AND status = 'failed'
          AND hubtel_client_reference IS NULL AND failure_reason LIKE 'needs review:%';
       ```
       Then use **Dispatch** on `/admin/utility-bills`.
     - **Network Plans (bundles).** There is no admin dispatch. Send the plan by hand from Hubtel (or refund), then mark the order completed with a note.
     - In shop mode, credit the shop share (`shop_share_amount`) by hand if the shop should earn it.
   - After a refund or delivery, resolve the tx row on `/admin/ussd-hubtel` as **fulfilled** (money was received). Never as "not paid": the strict fail refuses a paid order anyway.
   - Edge case: `needs_review` with the bot order already `paid` + `pending` (not failed, no `needs review:`). The engine's flip committed but reported an error, so the review recording was correctly a no-op. Check `hubtel_cs_transactions`. If there is no ledger row and no note, the order was never sent: dispatch it from `/admin/utility-bills` (bills), or refund it.
   - Edge case: a `hubtel_transactions` row with `state` `needs_review` (or stuck `processing` after a crash) for `order_table IN ('hubtel_bill_orders','hubtel_data_orders')` whose bot order is still `unpaid`. A transient DB error, or a handler crash, happened before the recording. The order query above does not list these, and `/admin/refunds` blocks them as "never paid". Find them with `SELECT t.session_id, t.order_table, t.order_id, t.amount_after_charges, t.state FROM hubtel_transactions t WHERE t.order_table IN ('hubtel_bill_orders','hubtel_data_orders') AND t.state IN ('needs_review','processing') AND t.created_at < now() - interval '10 minutes';`. Then join each one to its order and check `payment_status`. If the order is unpaid, record the payment by hand: `UPDATE <table> SET payment_status='paid', paid_at=now(), payment_reference='hubtel-session:<sid>', status='failed', failure_reason='needs review: manual record' WHERE id='<order_id>' AND payment_status='unpaid';`. Then refund or deliver as above.

Known limits:
- ECG meter type (Prepaid / Postpaid) is informational. It is shown on the confirm screen but is not sent to Hubtel: the meter number decides.
- Entering an unlinked meter number uses 2 verify calls: the phone's meters lookup, then the consent add-meter verify. Both count against the verify caps (20 per 10 min per phone).
- Ghana Water is not offered on USSD (WhatsApp only). The engine refuses it on USSD as well.
- The airtime wording is probed at the minimum amount. If a typed amount is above Hubtel's per-request cap, cashback does not apply to it, so the confirm screen shows today's "You pay / They get" pricing even though the prompt said "airtime amount". Both numbers are always shown before payment.
- Margin report (`/admin/hubtel-commission` → Cashback → report): Network Plans and Pay Bills rows have `channel='bots'` (`bot_surface='hubtel_ussd'`), so they appear under **Bots** and **All**. Cashback airtime from Hubtel USSD is stored in `airtime_orders` with channel `ussd` / `ussd_shop`, and `cashback_margin_report` (0120/0123) maps airtime only by `shop_id`. So these rows count under **All**, but the channel filter puts main-mode rows under **Dashboard** and shop-mode rows under **Storefront**, and **Bots** shows no airtime. Totals are correct; only the channel split is off. This is a SQL change to the report RPC, left to a later bot plan, as 0123 anticipated (no code change here).

Follow-ups from the final review (2026-10-15), deliberately not fixed in Plan 2:
- **Orphan race (finding 3).** A concurrent CONFIRM on the same session can insert its tx row after `failOrphanEngineOrder`'s "no tx row" check, and so cart an order that was just failed. Today the customer's payment for it is recorded for review (step 8: paid + failed, "needs review:", never sent, no share). The engine is not called for it, and no share is credited even if it were (finding 4 fixed in the engine for bots and storefront). Proper fix: refuse to cart in `submitOrder` when the guarded order is no longer open after the tx insert, or re-read the order in `replaySubmittedOrder`.
- **Shop status not re-checked (finding 5).** The engine trusts the session's `shopId`. It does not re-check that the shop is accepted and unblocked at create or at confirm. A shop blocked mid-session, or between cart and payment, still gets its share. The resolver gate is the accepted control.
- **1-pesewa tolerance (finding 6, pre-existing).** `decidePayment` accepts up to 1 pesewa under, for every Hubtel table. For bot orders the engine now checks Hubtel's own amount pesewa-exact, so a 1-pesewa-short bot payment lands in step 8 (needs review) instead of being delivered.
- **Extra config reads per request (finding 7).** Every Hubtel request does a second `admin_settings` read (cashback config) in parallel, and airtime does more on each amount, re-prompt and confirm step. The latency is roughly flat, but Hubtel USSD has a hard response budget. Consider one `.in("key", [hubtel_ussd_config, commission_cashback_config])` read per request.
- **Test gaps (findings 11, 12, 13).**
  - No test of the orphan race itself (tx inserted after the orphan check).
  - No `processFulfillment` → `airtimeOrderPostPayment` test showing a shop-mode cashback airtime share is credited exactly once and main mode credits nothing; coverage stops at the inserted row.
  - The 0125 constraint name can only be checked against prod. Use the pre-apply check in step 1; the migration's assertion block now fails loudly on a mismatch.

## Commission Cashback — Bots (Plan 3: main + shop USSD)

The Uzo main USSD (`/api/ussd`) and shop USSD (`/api/ussd-shop`) gain **Network Plans** and **Pay Bills**, plus cashback-priced airtime. Network Plans and Pay Bills are paid by **MoMo only**: a Paystack prompt to the dialing number. The shared bot engine creates the orders (`channel='bots'`, `bot_surface` `ussd` / `ussd_shop`), and Paystack's `charge.success` confirms them through the same engine path as storefront orders. Plan `docs/superpowers/plans/2026-10-20-cashback-bots-3-uzo-ussd.md`. Ships DARK.

0. **The deploy is dark by default.** In prod the shared cashback switches are already ON for Plan 2 (Hubtel USSD): master, `surfaces.bots` and every `botGroups` value are `true`. So the Uzo side has its own three **opt-in switches**, all **OFF when their key is missing**:
   - `networkPlans` (Network Plans menu item);
   - `payBills` (Pay Bills menu item);
   - `cashbackAirtime` (cashback pricing on Uzo airtime).

   They live in `ussd_service_visibility` and are switched at `/admin/ussd-shops` ("USSD Menu Services" card). Hubtel USSD never reads them. Pre-deploy check that they are absent or false:
   ```sql
   SELECT value->'networkPlans' AS network_plans, value->'payBills' AS pay_bills, value->'cashbackAirtime' AS cashback_airtime
     FROM admin_settings WHERE key = 'ussd_service_visibility';
   ```
   Expect NULL (key absent) or `false` for all three, or no row at all. If any of them is `true`, that item goes live at deploy.
1. **No migration needed.** `bot_surface` already allows `ussd` / `ussd_shop` (0123), and `airtime_orders.channel` already allows `ussd` / `ussd_shop`.
2. Deploy. With the three opt-ins off, the main menu, the shop product menu, airtime screens, prices and rows are byte-for-byte unchanged, even with every Bots switch on (tested). WhatsApp is untouched: `mainMenu()` with no arguments and `handleMain` without `"ussd"` never show the new items.
   - The deploy adds the cron `/api/cron/expire-stale-bot-orders` (every 10 min, `CRON_SECRET`). See step 9.
   - The deploy also changes two shared paths, for every rail:
     - A `charge.failed` for a cs_* payment now fails its **bot** order at once (guarded; storefront orders unchanged), and only a still-pending `wallet_payments` row is marked failed.
     - The commission confirm decides share + dispatch from the paid flip's own row state.
3. **Before going live: set the Paystack bots fee (`botFees.paystack`).** In prod it is 0 for every group. With 0, Paystack's MoMo fee (~1.95%) is not passed to the buyer and comes out of our margin on every Uzo bot order and cashback airtime row.
   - Set it in Admin > Hubtel Commission > Cashback, in the "Paystack bots (USSD + WhatsApp)" fee set: about 2 per group (bundles, bills, airtime). It is added on top of the price and rounded up.
   - Check it:
     ```sql
     SELECT value->'botFees'->'paystack' AS paystack_bot_fees
       FROM admin_settings WHERE key = 'commission_cashback_config';
     ```
     Expect a non-zero value for each of `airtime`, `bundles` and `bills`.
   - This fee set does not affect Hubtel USSD, which uses the "Hubtel USSD" fee set.
4. **Go live** (after step 3). Turn the three switches on at `/admin/ussd-shops` ("USSD Menu Services": **Network Plans**, **Pay Bills**, **Cashback airtime**), one at a time if you want a staged rollout.
   - An item is live only when the shared cashback gate (master AND Bots AND its group: bundles → Network Plans, bills → Pay Bills, airtime → Cashback airtime) AND its Uzo switch are on.
   - If any config read fails, the items stay hidden and airtime stays on today's pricing (fail closed). Both configs are re-read on every request.
   - Rates and shares for each group: main USSD pays the buyer `customer` (no shop share); shop USSD pays `storefrontCustomer` to the buyer and `storefrontShop` to the shop.
   - Network Plans also follows the data whitelist (hidden for a whitelist-blocked caller, like Browse Services). Pay Bills does not.
5. Test with a test number (your own phone, smallest amounts), on both menus. Include at least one real approved payment per menu, and check the order row, the shop share and the Hubtel ledger row for each:
   - Main: dial, and check that `5. Network Plans` / `6. Pay Bills` follow `4. Results Checker` (numbering shifts down if an item above is hidden). Shop: enter a test shop code, and check that `4. Network Plans` / `5. Pay Bills` follow `3. Results Checker`.
   - Network Plans: network → type → cheapest plan → "My number" → `1. Confirm` → approve the MoMo prompt. The order must show channel Bot (USSD / Shop USSD), status completed, and in shop mode the shop share credited once.
   - Pay Bills: ECG → "This number" (or "Meter number" for an unlinked meter, which asks consent to link it) → GHS 1 → confirm → approve. Check `/admin/utility-bills`.
   - OTP: if the prompt says an OTP was sent instead, redial. The OTP prompt appears, the code finishes the charge, a wrong code shows "Wrong code. Try again.", and `0` cancels (payment + order failed, guarded). The code is submitted while the USSD session is still open, so verify on a real handset that the MoMo approval prompt arrives after you enter the OTP.
   - Leave one prompt unapproved. Within about 40 minutes the order must be `failed` with "payment not completed" (payment_status stays `unpaid`) and its `wallet_payments` row `failed`.
   - Cashback airtime: with **Cashback airtime** ON, the amount prompt reads "Enter airtime amount" and the confirm screen shows `Pay GHS x (was GHS y)`. Turn it OFF and re-dial: the prompt is "Enter amount to pay" again (today's pricing).
   - Turn **Network Plans** / **Pay Bills** OFF at `/admin/ussd-shops` and re-dial: those items are gone on both Uzo menus, and Hubtel USSD is unchanged.
6. **Ruling: no OTP switch and no direct-charge switch on USSD.** The dialing number is network-authenticated, so the storefront OTP and direct-charge admin switches do not apply. The MoMo prompt always goes to the dialing number. There is a per-phone cap of 3 charges per hour (shared with the storefront `momodirect_phone` budget), on top of the engine's pending-order caps.
7. **Refunds.** These rows are Paystack-paid, so `/admin/refunds` offers **Paystack reversal**, or a Moolre payout / manual. The paying MoMo number is recorded (`recordPayerPhone`); prefer it for payouts. A shop share credited at payment is clawed back on refund.
8. **Paid but not delivered (needs review).** A payment that arrives for an order that is no longer pending (failed by the sweep, by a declined charge, by a cancel, or by a final OTP failure) is recorded paid with status `failed`. This holds even if the order is failed in the instant between the confirm's read and its paid flip: share and dispatch are decided from the flip's own row state. It is never dispatched, no shop share is credited, and admins get an URGENT "refund it" alert. Handle it with the same procedure as Plan 2 step 8 ("Paid bot orders held for review"), using **Paystack reversal** for the refund instead of a Moolre payout.
9. **Stale unpaid sweep** (`/api/cron/expire-stale-bot-orders`, every 10 min, `lib/bot-commission/stale-sweep.ts`):
   - It fails `hubtel_bill_orders` / `hubtel_data_orders` rows with `channel='bots'`, `bot_surface IN ('ussd','ussd_shop')`, `status='pending'`, `payment_status='unpaid'` and `created_at` more than 30 min ago, at most 200 per table per run, oldest first.
   - It uses the guarded bot patch (`status='failed'`, `failure_reason='payment not completed'`) and re-checks every guard on the update, so an order paid in between is never touched. It then marks that order's pending `wallet_payments` rows (`cs_bill` / `cs_bundle`) failed.
   - It never touches paid rows, Hubtel USSD rows (`bot_surface='hubtel_ussd'`, which have their own expiry), WhatsApp bot rows or storefront rows.
   - A late Paystack payment after the sweep lands in step 8 (needs review), never as a delivery.
   - A declined charge (Paystack `charge.failed`) fails its bot order right away, without waiting for the sweep.
   - The response is 500 when any DB step failed (see the log tag `[BOT-STALE-SWEEP]`). Check it manually with `curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/expire-stale-bot-orders`.
10. Rollback, fastest first:
   - Uzo only: turn **Network Plans**, **Pay Bills** and/or **Cashback airtime** OFF at `/admin/ussd-shops`. This does not touch Hubtel USSD.
   - Everything (Uzo and Hubtel USSD): turn a "Sell on bots" group or the **Bots** surface OFF.
   - Code rollback: redeploy the previous build. There is no migration to undo. Unpaid Uzo bot orders left behind by a rollback are no longer swept, so fail them with the step 9 conditions by hand.

Known limits:
- Back (`0`) from the legacy Data / AFA / Results Checker / Status screens on the **main** menu repaints the main menu WITHOUT the bot items. Those renderers are shared with the WhatsApp bot and were left untouched. The items still work by their digit, since they are numbered last, and they show again on the next full menu (redial, or back from Airtime or a bot flow). The shop menu and main Airtime back paths do show them.
- Data whitelist (`ussd_data_whitelist_enabled` / `dataBlocked`): **Network Plans** is a data product, so it is hidden for a blocked caller exactly where Browse Services is. A stale session that reaches a Network Plans step anyway gets "Not available right now.". **Pay Bills** is not data and follows only the cashback gate and its visibility switch.
- An OTP code is submitted to Paystack while the USSD session is still open (kept on purpose, for the "Wrong code" retry). The existing OTP handlers submit after the session closes, with a 3 s delay. Step 5 covers the handset check.
- Once confirm has called the engine, the session goes back to the menu (all bot fields and tokens dropped), so back-navigation can never create a second order.

Follow-ups (not fixed in Plan 3):
- **Airtime wallet paid-flip unchecked (pre-existing).** The dealer-wallet path for airtime does not check the result of the order's paid-flip update (Task 3 review, parked).
- **`cleanupAbandonedPayments`** (`lib/payment-cleanup-service.ts`) is not wired to any cron today. If it is ever wired up, it needs a `cs_*` order-type exclusion: bot and storefront commission payments are owned by the engine and this sweep.
- **Margin report airtime mapping.** This is unchanged from Plan 2: cashback airtime rows live in `airtime_orders` with channel `ussd` / `ussd_shop`, and `cashback_margin_report` maps airtime only by `shop_id`. So Uzo airtime shows under Dashboard / Storefront, not Bots. Totals are correct.
- **Plan labels can still be cut.** Long Hubtel plan names are shortened on a word to fit 160 chars, and the price is never cut. Check the list screens against the live catalog after enabling, and shorten the labels if a name loses its meaning.
- **Stale sweep.** It is new and has no live run yet: watch the first runs' logs. A late payment after the sweep is a needs-review refund (step 8), not a delivery.
