# Order refunds: runbook

Admin refunds of paid-but-pending shop / USSD / USSD-shop orders (`/admin/refunds`). Ledger: `order_refunds`. Dispatch serialisation: `order_dispatch_claims`. v1 has no UI to resolve a stuck row: an engineer resolves it with SQL **after verifying at the gateway dashboard** (Paystack / Moolre / wallet transactions). Never resolve from the app's own status alone.

## Ledger statuses

| Status | Meaning |
|---|---|
| `reserved` | Row + owner clawback taken, payout call not yet recorded. Under 5 min old: the request may still be running (UI shows "In flight"). Older: a crash; the payout MAY have gone out. |
| `processing` | Gateway accepted (or result unknown); waiting for confirmation. Same 5 min in-flight rule. Clawback stays in place. |
| `awaiting_otp` | Paystack payout created, waiting for the admin's OTP. `gateway_ref` holds the transfer code. |
| `completed` | Money left, order is `refunded`. Terminal. |
| `failed` | Payout did not happen (or admin cancelled); clawback restored, order back to `pending`. A new refund may be created. |

Order `order_status` follows: `pending` -> `refunding` (reserve) -> `refunded` (complete) or back to `pending` (fail). Late provider updates on `refunding`/`refunded` orders are blocked by a trigger and logged in `late_events`.

## Monitoring (run at least daily; alert if any rows)

```sql
-- 1. Refunds stuck mid-flight
SELECT id, order_table, order_id, gateway, amount, status, gateway_ref, error, updated_at
FROM order_refunds
WHERE status IN ('reserved','processing','awaiting_otp') AND updated_at < now() - interval '15 minutes'
ORDER BY updated_at;

-- 2. Provider updates the guard blocked (a provider moved an order a refund owns: money may need a manual look)
SELECT id, order_table, order_id, status, late_events
FROM order_refunds WHERE jsonb_array_length(late_events) > 0;

-- 3. Dispatch claims stuck at 'claimed' on orders still pending (killed function mid-dispatch; blocks refunds with DISPATCH_ACTIVE)
SELECT c.order_id, c.attempts, c.last_claimed_at
FROM order_dispatch_claims c
WHERE c.last_outcome = 'claimed' AND c.last_claimed_at < now() - interval '15 minutes'
  AND (EXISTS (SELECT 1 FROM shop_orders o WHERE o.id = c.order_id AND o.order_status = 'pending')
    OR EXISTS (SELECT 1 FROM ussd_orders o WHERE o.id = c.order_id AND o.order_status = 'pending')
    OR EXISTS (SELECT 1 FROM ussd_shop_orders o WHERE o.id = c.order_id AND o.order_status = 'pending'));
```

## Paystack reversal statuses and "Verify at gateway"

A Paystack reversal (gateway `paystack`) is only *accepted* when we call it; the refund then moves through Paystack statuses. OPEN VERIFICATION: this vocabulary is from Paystack docs, not live-tested.

| Paystack status | Adapter outcome | Ledger |
|---|---|---|
| `pending`, `processing` | pending | `processing` (clawback kept; "Check status" re-checks `GET /refund/:id`) |
| `needs-attention` | pending | `processing`; NOT compensated and NOT done: handle it at the Paystack dashboard (customer bank details needed / retry) |
| `processed` | completed | `completed` (order `refunded`) |
| `failed` | failed | `failed` (owner cut restored, order back to `pending`; OPEN VERIFICATION: Paystack docs say the amount returns to our Paystack balance, not live-confirmed) |
| anything else, or an HTTP/network error on lookup | unknown | unchanged, never compensated |

- `gateway_ref` of a reversal is the numeric Paystack **refund id**. If Paystack returns no id the refund is parked as `processing` with no ref and cannot be auto re-checked: find it in the Paystack dashboard by the order's transaction reference.
- Refunds completed before this change were marked `completed` on mere acceptance and may never have been confirmed. Use **Verify at gateway** on completed/processing Paystack rows in History (read-only: `GET /api/admin/refunds/<id>/gateway-status`, settles nothing). It shows "Paystack says: <status>".
- **Mismatch** ("Ledger says completed but Paystack says failed — the customer was NOT paid"): the money should be back in our Paystack balance (OPEN VERIFICATION). Confirm in the Paystack dashboard. The app will not auto-flip a completed row (`fail_order_refund` refuses on `completed`), so an engineer decides: issue a fresh refund (payout/wallet) and correct the ledger by hand.
- **failed** on a `processing` row: press "Check status"; reconcile compensates (owner cut restored, order pending), after which a new refund may be created.
- **needs-attention**: do NOT cancel in our ledger. Act at the Paystack dashboard; compensate only once Paystack reports `failed`.
- The 5-minute in-flight window only blocks "Check status" for the first 5 minutes after the row was last updated; a legitimately pending Paystack refund stays reconcilable after that for as long as it takes.

**Cron `/api/cron/reconcile-paystack-refunds` (every 5 minutes, `vercel.json`).** Picks up to 25 `processing` Paystack refunds in total with `updated_at` older than 5 minutes (oldest first): reversals (`gateway=paystack`, numeric `gateway_ref` required) AND MoMo payouts (`gateway=paystack_payout`, looked up by refund id, so a `TRF_` or null `gateway_ref` is fine). `awaiting_otp` payouts are NOT touched (an admin must enter the OTP), nor `reserved`, and Moolre refunds are not covered (use "Check status"). It runs the same `reconcileRefund` as the "Check status" button, one at a time. It settles ONLY on an explicit Paystack `processed` (-> `completed` + customer SMS) or `failed` (-> compensate). `pending` / `processing` / `needs-attention` / unknown / lookup errors leave the row `processing`. It never settles from an HTTP error and has no other write path. Response/log line: `{checked, completed, failed, stillProcessing, errors, stale24h}`. `needs-attention` rows sit in `processing` by design: any row created more than 24h ago (measured from `created_at`, not `updated_at`) is counted in `stale24h` and logged at error level as `[REFUND-CRON] needs attention: <refund id>`; handle it at the Paystack dashboard. `SETTLE_FAILED` is logged as `[REFUND-CRON] SETTLE_FAILED ...` with the refund id and needs a manual look. Admins can still use "Check status" and "Verify at gateway" at any time; Verify is available only for Paystack reversals.

One-off: list completed Paystack reversals for manual verification (no phone numbers):

```sql
SELECT id, gateway_ref, amount, created_at
FROM order_refunds
WHERE gateway = 'paystack' AND status = 'completed'
ORDER BY created_at;
```

## Resolving a stuck refund by hand

First look at the gateway dashboard for the payout (search by `gateway_ref`, or the refund id / `REFUND_<id>` reference, or the amount + destination + time). Then:

```sql
-- (a) Payout CONFIRMED at the gateway: settle the ledger (order -> refunded). Returns 'completed'.
SELECT complete_order_refund('<refund id>', '<gateway ref>');

-- (b) Payout confirmed NOT to have happened: restore the owner clawback (order -> pending). Returns 'failed'.
SELECT fail_order_refund('<refund id>', 'Resolved manually: <reason>');

-- (c) A 'claimed' dispatch claim stuck after a crash: FIRST check at the provider whether the order was actually sent.
UPDATE order_dispatch_claims SET last_outcome = 'failed' WHERE order_id = '<order uuid>';
-- use 'submitted' instead of 'failed' if the provider did receive it (then the order is not refundable anyway)
```

If (a) returns `failed` or (b) returns `completed` the row was already settled the other way: stop and investigate (money may have moved). Do not run both.

## Go-live checklist (human, in order)

1. **Discovery queries** on prod: CHECK constraints on `order_status` of the three order tables allow `refunding`/`refunded`; `shop_orders_state_machine` allows `pending -> refunding -> refunded`; table/column names used by the migration exist.
1b. **Apply** `migrations/20261006_payment_attempts_payer_phone.sql` (adds nullable `payment_attempts.payer_phone`; apply before or together with the refunds migration, either order is safe; the code degrades to "no payer number" if it is missing).
2. **Apply** `migrations/20261005_order_refunds.sql` off-peak (single transaction, 5s lock_timeout; re-run if it aborts on lock contention).
3. **Privilege checks**: the 6 refund RPCs (note `reserve_order_refund` has 10 args) and both new tables are NOT executable/selectable by `anon`/`authenticated`; `service_role` can execute.
4. **Run `migrations/tests/20261005_order_refunds_rpc_test.sql`** (it ends in ROLLBACK; read the NOTICEs: the two-owner case needs a second shop/owner).
5. **Deploy** the app. (Dispatch guard fails open if the RPCs are missing, closed on claim timeout/lock contention.)
6. **Wallet smoke test**: refund a small wallet-paid order; check wallet credit once, clawback, order `refunded`, SMS.
7. **Shortfall test**: owner with insufficient profit + wallet -> refund blocked, nothing changed.
8. **Moolre**: small payout; also OPEN VERIFICATION: probe `/status` with a random never-used externalref and record what it returns (the adapter assumes an unknown ref is not a success; unconfirmed).
9. **Paystack payout**: wrong OTP (row stays `awaiting_otp`), right OTP (completes), and Cancel. OPEN VERIFICATION: the full Paystack transfer status vocabulary the adapter maps.
10. **Paystack reversal**: small refund of a Paystack-paid order. A `pending` API status now lands in `processing`. OPEN VERIFICATION: confirm it later flips to `processed` and "Check status" settles it to `completed`; also confirm what `needs-attention` looks like in practice.
10b. **After deploy**: click "Verify at gateway" on one existing completed Paystack refund to confirm the `GET /refund/:id` path, the id type (numeric `gateway_ref`) and the status vocabulary. OPEN VERIFICATION (I-2). Also confirm the `reconcile-paystack-refunds` cron appears in Vercel and runs.
11. **Business sign-off**: a PARTIAL refund still removes the shop owner's FULL cut (clawback is per order, not pro-rata).
12. **Monitoring**: schedule the three queries above; add them to the daily check.

Known limits: storefront (`shop_orders`) payer MoMo number is recorded in `payment_attempts.payer_phone` ONLY for orders paid via the direct MoMo flow AFTER this deploy and migration; older orders and Paystack-hosted checkouts have none, so payout gateways are unavailable for them (Paystack reversal / wallet only; customer_phone is never used as the payer); a wallet debit counts as proof of wallet payment only if its amount matches the order and it is the only such debit; refunded orders still count in revenue/reporting (out of scope for v1).
