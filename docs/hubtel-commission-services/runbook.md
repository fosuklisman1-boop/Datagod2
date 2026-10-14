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
