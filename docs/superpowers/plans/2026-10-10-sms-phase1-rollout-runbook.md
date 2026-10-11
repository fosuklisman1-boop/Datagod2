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

## Phase 2 — Admin console (`/admin/sms`)

- **New page**: `/admin/sms` is now the single "SMS Platform" console (7 tabs, `?tab=`). Old page features moved per the Phase 2 spec §3.2. `/admin/sms-centre` and `/admin/sms-health` are unchanged.
- **Master switch is a real kill switch.** Off = new sends, wallet/quantity/Paystack credit purchases, activation and bonus claims are refused (public API: 503 `SMS_DISABLED`). Never blocked: webhooks for payments already made, queue drain, refunds, DLR, OTP/transactional, admin broadcast. Reads are cached ~60 s per instance, so allow up to a minute to take effect; it fails OPEN if settings cannot be read.
- **Policy is still record-only.** `sms_policy_enforced` is not writable from the UI (Phase 3). The Settings tab and the Policy preview show what rules would have done.
- **"Recorded revenue"**: Σ `amount_ghs` of bundle purchases + activation fees. 56 purchases before Phase 1 (7,111 credits) have no amount and cannot be backfilled; the card says so.
- **Allocation** is admin-only, audited, and idempotent (`requestId` → ref `admin_alloc:<uuid>`).
- **Bundle delete** only if inactive ≥ 48 h (a DB trigger restarts the clock on every deactivation); otherwise Deactivate.
- **Migrations applied live**: `20261011_sms_admin_console.sql`, `20261011_sms_bundle_deactivation_clock.sql`.
- Known gap: the legacy `updateSmsSettings` writer (and `/api/admin/shop-sms` PATCH) is unvalidated; the new Settings tab is the validated path.

## Phase 3a — customer pages (shipped; enforcement still OFF)

- `/dashboard/sms` is now Home; sub-pages: `compose`, `records` (+ `records/[id]`), `contacts`, `credits`, `business`. The 2,035-line page is gone. "Buy any amount" is no longer reachable from the UI (the `/api/sms/units/purchase` route still exists, unused).
- New reads: `GET /api/sms/home`, `/api/sms/ledger`, paged/filtered `/api/sms/logs`, `POST /api/sms/compose/preview` (advisory, read-only, rate-limited, returns no keyword text).
- Migrations applied live 2026-10-11/12: `20261012_sms_customer_reads.sql` (`sms_customer_stats`), `20261012_sms_ledger_campaign_link.sql` (`debit_sms_for_send` now returns `debit_tx_id`; new debits link to their campaign, older ones stay unlinked), `20261012_sms_ledger_tx_index.sql`.
- Policy rule decided for 3b: one user send (up to 5,000 recipients, batched by 500 internally) counts as ONE send for caps — evaluate once on the whole list before batching.
- Known gaps (not bugs): `loadDefaultSender` picks the oldest active own sender (what the shop send route does) while the v1 API/admin console prefer `sms_accounts.default_sender_id`; a rejected KYC application starts a new draft and carries nothing over (UI now says so); the order-confirmation toggle on Home is disabled until Phase 4.

## Phase 3b — enforcement, held campaigns, and the flip (built; enforcement still OFF)

**State:** all code ships dark. `tenant_global_settings.sms_policy_enforced` is JSONB `false`. With it false, the send path is byte-for-byte the pre-3b path (pinned by `lib/sms/__fixtures__/send-service.enforcement-off.calls.json`).

**Migrations (all applied live 2026-10-12, in this order):** `20261013_sms_policy_enforcement.sql` (`record_sms_flags`; `claim_sms_messages` skips held/scheduled logs), `20261013_sms_policy_enforcement_2.sql` (owned per-account send lease; browser roles lose SELECT on `sms_send_logs.policy_shadow` and `.flag_reason`), `20261014_sms_held_reject.sql` (`reject_held_sms_campaign`). They MUST be present before the flip (they are).

**What the flip changes (customers):** per-send / per-hour / per-day caps, blocked keywords and non-own links (platform mode), fraud flags → auto-suspend (default 2) and review hold (default 5 open flags), held campaigns. Rejections carry a customer-safe reason only (no keyword text). One user send (up to 5,000 recipients) is evaluated ONCE and counts as one send. Admin broadcast and OTP/transactional messages never go through `enqueueSend` and stay exempt. If the policy evaluator itself fails or takes >10 s, the send is refused (`POLICY_UNAVAILABLE`, fail closed).
**Accepted trade-offs:** while enforced, parallel sends from the SAME account run one at a time — extra requests get `429 SEND_IN_PROGRESS` (callers retry; the lease is released as soon as a send finishes and expires after 330 s if a function instance dies). A business-mode held send of more than 500 recipients creates one held log per 500 chunk; release/reject act per log.

**Admin tools for the aftermath:** Flagged tab → "Held for review" (Release sends it; Reject refunds exactly the unsent messages and tells the customer the reason; both audited and notify the customer). Accounts tab → "Clear hold" / "Place on hold" (clearing also dismisses the account's open INFO flags; open FRAUD flags still count toward the review threshold, so action them in the Flagged tab first).

**Before flipping — checklist (do not flip until all are true):**
1. The Policy preview on `/admin/sms` (Overview) has meaningful data. As of 2026-10-12 only 1 send had a recorded shadow decision (shadow recording began with Phase 1 and SMS volume is low) — **there is not yet enough real traffic to judge the rules.** Wait for at least a few dozen real sends, or send a handful of representative test messages (short, long, with a link, with a blocked keyword) from a test account and confirm the Compose preview note matches intent.
2. Settings reviewed on the Settings tab: caps (platform 300/20/500, business 1000/2000/1,000,000), blocked keywords, business flagged keywords, allowed domains, auto-suspend (2) and review threshold (5). `sms_feature_enabled` is true.
3. Someone is available to watch the Flagged tab and Messages tab for the first hour after flipping.

**Flip (controller-run, needs the owner's explicit go-ahead):**
`UPDATE tenant_global_settings SET value = 'true'::jsonb WHERE key = 'sms_policy_enforced';` — takes effect within ~60 s per instance (settings cache).

**Watch for an hour:** Messages tab (blocked/held counts), Flagged tab (new fraud flags, held campaigns), customer complaints about "SMS blocked", any account auto-suspended.

**Rollback (instant, safe):** `UPDATE tenant_global_settings SET value = 'false'::jsonb WHERE key = 'sms_policy_enforced';` (≤ 60 s). Already-held campaigns stay held until an admin releases or rejects them; release them from the Flagged tab. Suspended accounts / review holds set during enforcement are NOT auto-reverted — clear them from the Accounts tab if the cause was a rule you are rolling back.
