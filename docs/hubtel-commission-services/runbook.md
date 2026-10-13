# Hubtel Commission Services - Phase 1 rollout runbook

Phase 1 ships DARK: nothing customer-facing, master switch OFF. Order matters.

## Before enabling
1. Apply migrations `0113` and `0114` to production (Supabase Management API SQL, see memory `reference-supabase-access`). Both are additive. Verify: `select * from hubtel_cs_stats();` returns one row of zeros.
2. Set Vercel env (production): `HUBTEL_CS_CALLBACK_SECRET`, `HUBTEL_CS_BASIC_AUTH` (base64 `clientId:secret` for Commission Services), `HUBTEL_DISBURSEMENT_ACCOUNT`. Confirm `NEXT_PUBLIC_APP_URL`, `HUBTEL_RELAY_URL`, `HUBTEL_RELAY_SECRET` already exist. Optional: `HUBTEL_CS_ENFORCE_CALLBACK_IP=true` once a first callback has been seen from 18.202.122.131.
   - Use a callback secret of at least 32 random characters. The readiness check does NOT enforce a minimum length.
   - The callback URL carries the HMAC signature in its query string, so Vercel and relay request logs contain it. Restrict log access, and rotate `HUBTEL_CS_CALLBACK_SECRET` if it leaks. Rotation invalidates in-flight callbacks; the status-check cron settles those rows.
3. Deploy. Open `/admin/hubtel-commission`: the readiness card must say all variables are set.
4. Status checks use the relay `/status` (already deployed for USSD). If `mode: relay` is ever used for purchases, redeploy the droplet with `HUBTEL_CS_BASIC_AUTH` set (see `scripts/hubtel-relay/README.md`).

## Smoke test (live, at most GHS 5)
The page's test purchase sends a REAL purchase. It requires `confirm` (the UI sends it), is capped at GHS 5, and the page locks the Send button for 10 s after an unknown outcome (check Transactions before trying again).
1. Settings: master switch ON.
2. Live test: MTN Airtime, your own number, GHS 0.50. Expect state `pending` immediately, then `fulfilled` via callback within about 1 min, and a commission value on the row.
3. Force the fallback: temporarily set `HUBTEL_CS_CALLBACK_SECRET` to a wrong value for one test, run another GHS 0.50 test, and confirm the row settles via the status-check cron after 5 min or more (the callback gets 401 and is not logged as a transition). Restore the secret afterwards.
4. Data: use the query endpoint via a one-off script to read a real bundle `Value` and price, then send one live test with that exact bundle and amount.
5. Set a low-balance threshold above the current float and confirm one SMS/email arrives (then set it back).

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
- The readiness check does not enforce a minimum callback secret length.
- `hubtel_cs_stats()` is defined with `SET search_path = public` in the 0113 file here; if 0113 was already applied before that change, re-run the `CREATE OR REPLACE FUNCTION` statement.
- No route-level tests exist for the admin routes, and the Supabase store has no unit tests (fake-client gap).
- Hubtel de-duplication of a repeated `ClientReference` is unknown, so unknown POSTs are never resent.
