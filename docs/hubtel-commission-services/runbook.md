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
