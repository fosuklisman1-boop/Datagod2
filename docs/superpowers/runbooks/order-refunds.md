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
10. **Paystack reversal**: small refund of a Paystack-paid order. OPEN VERIFICATION: a `pending` API status is treated as completed; confirm it settles.
11. **Business sign-off**: a PARTIAL refund still removes the shop owner's FULL cut (clawback is per order, not pro-rata).
12. **Monitoring**: schedule the three queries above; add them to the daily check.

Known limits: storefront (`shop_orders`) payer MoMo number is recorded in `payment_attempts.payer_phone` ONLY for orders paid via the direct MoMo flow AFTER this deploy and migration; older orders and Paystack-hosted checkouts have none, so payout gateways are unavailable for them (Paystack reversal / wallet only; customer_phone is never used as the payer); a wallet debit counts as proof of wallet payment only if its amount matches the order and it is the only such debit; refunded orders still count in revenue/reporting (out of scope for v1).
