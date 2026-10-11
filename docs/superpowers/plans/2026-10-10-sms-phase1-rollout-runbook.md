# SMS Platform Rebuild — Phase 1 rollout runbook

Written 2026-10-10 after the Phase 1 build. Phase 1 ships with **Moolre still primary** and the send
policy **record-only**. Hubtel is built and tested but dormant until the steps below are done, in order.

## What is already live (DB)
Migrations applied 2026-10-10/11 (all idempotent, self-asserting):
`20261010_sms_platform_foundation`, `…_sms_account_usage_rpc`, `…_sms_dlr_scheduling`,
`…_sms_dlr_mark_checked_index`, `…_sms_solvency_inflight`.
Result: 241 accounts in Platform mode + the admin account in Business; 36 sender IDs kept (one `kyc_free`
per account), 2 paused; credits unchanged (2,388); `sms_policy_enforced=false`.

## What changes for customers when the code deploys (Moolre primary)
1. Non-oldest sender IDs are paused (sending with one → `INVALID_SENDER_ID`). API sends with no `sender_id` use the account default.
2. Sender-ID requests follow the new rules (3–11 chars, protected brands blocked, Platform = 1 ID) and need a manual admin decision. **Approval is refused until Hubtel is the active provider** (see below).
3. Public SMS API rate limit = account override ?? 30/min (was a third of the key's own limit). Only 1 active key was above the old 90 cut-off (limit 100 → 33/min before, 30 now).
4. Credit purchases go "pending" a little more often: the solvency gate now subtracts queued-but-unsent messages.
5. New sends are inserted `claimed` and released after dispatch; if a request dies mid-dispatch its messages wait ≤5 min for the reaper.
6. The policy writes a would-be decision to `sms_send_logs.policy_shadow` — nothing is blocked, capped or flagged yet.

## Going live on Hubtel — do these IN ORDER
1. **Vercel env** (never paste secrets in chat): `HUBTEL_SMS_CLIENT_ID`, `HUBTEL_SMS_CLIENT_SECRET`. Optional `HUBTEL_SENDER_ID`. Redeploy.
2. **Relay** (DigitalOcean droplet): copy `scripts/hubtel-relay/server.ts` + `lib/ussd-hubtel/relay-handler.ts` (same paths), set `HUBTEL_DISBURSEMENT_ACCOUNT` (and `HUBTEL_BALANCE_BASIC_AUTH` only if Hubtel says the balance API uses different keys), restart the service. Ask the Hubtel Retail Systems Engineer to confirm the droplet IP is whitelisted for `trnf.hubtel.com`.
3. **Check the balance route:** `curl -s -H "Authorization: Bearer $RELAY_SECRET" https://<relay-host>/balance` → `{"ok":true,"upstreamStatus":200,"body":{"responseCode":"0000",…}}`.
4. Confirm whether the Disbursement account also funds other Hubtel payouts; set `sms_hubtel_low_balance_ghs` accordingly.
5. **Switch the primary** in the admin SMS settings (the setter itself refuses unless creds + a working `/balance` exist). Moolre stays as fallback for platform-sender messages.
6. **Live test**: one admin SMS to your own phone (`sms_logs` row shows `provider='hubtel'`), then a small real campaign to 2–3 own numbers. Within ~5 min `sms_messages` rows should show `provider='hubtel'`, a `provider_batch_id`, `delivery_status='delivered'` and `cost_ghs`.
7. **Verify two Hubtel facts with a 2-part (long) message** — both are assumptions until seen live:
   - is `rate` per message or per segment? (the solvency gate currently divides the balance by the highest observed `rate`; if `rate` is a per-message total this is conservative but may throttle sales);
   - when is the Disbursement balance deducted — at submit or at delivery? (the gate assumes at submit).
8. Rollback = set the primary back to `moolre` (one setting). Rows Hubtel already accepted are tracked by the DLR poller and refunded exactly once if they never deliver (72 h).

## After Hubtel is primary
- Approve pending tenant sender IDs (`POST /api/admin/sms-platform/sender-ids/{id}` or the legacy SMS-centre buttons — both now run the new rules).
- Watch `sms_messages.last_error = 'hubtel_unconfirmed'` — a spike means Hubtel outages are being treated as "maybe sent".
- Review `policy_shadow` data for a few days to tune caps / keyword lists **before Phase 3 turns enforcement on**.

## Known accepted gaps (documented, not bugs)
- `policy_shadow` and `cost_ghs` are readable by account owners via direct Supabase queries (RLS owner-select); the logs API no longer returns them.
- A dispatch killed mid-HTTP-call leaves that chunk truly unknown; it is re-sent after the 5-minute reaper (inherent at-least-once).
- Revenue (`amount_ghs`) is written in a second statement after the credit RPC; a crash in that window loses the amount for wallet purchases (Paystack recovers on webhook redelivery). Follow-up: add `p_amount_ghs` to `credit_sms_units_if_solvent`.
- The admin "Total Revenue" card (Phase 2) must filter `sms_pending_credits` to `status='pending'` if it sums them, because settled rows keep their `amount_ghs`.
- Quantity ("buy any amount") purchases remain available to all modes until Phase 3 retires them (and the `smsqty-` webhook path with them).
