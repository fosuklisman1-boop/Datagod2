# Payment Gateway — carry-forward list for Plan 4

From the final review of Plan 3 (2026-11-04). Plan 4 wires the 6 surfaces and must handle all of these.

1. **Insert the `hubtel_payments` row before calling Hubtel**, otherwise the callback and sweep return `ignored` for a real payment. On `refused`, close the row at once. Never reuse a reference.
2. **Set `internal_reference` and `metadata`** on the row (added to migration 0151). The shared handler finds USSD, airtime, results and check-request rows by `id = reference`, token purchases by `paystack_reference`, and SMS by metadata or `smsbundle-` prefixes. Hubtel returns no metadata and only ever sees the opaque reference.
3. **Payment row contents.** `wallet_payments.reference` must equal what the handler receives. `amount` plus `fee` must fit `charge-events.ts` (orders are re-priced as `total_price + fee`). `fee` must be 0 when Hubtel adds its own charge on top, or the wallet credit is reduced twice.
4. **Merchant-bearer mode conflicts with the handler.** Requesting less than the price fails the handler's underpayment check for orders. It needs a separate "expected for handler" value.
5. **Paystack-only verifiers must skip Hubtel rows.** Add `gateway` to the payment row and branch on it in:
   - `app/api/cron/verify-pending-payments/route.ts` (Paystack's 404 marks the order `abandoned`, every 2 minutes)
   - `lib/payment-cleanup-service.ts` (one site marks a wallet row `failed`)
   - `app/api/admin/payment-reverify`, `app/api/shop/payment-reverify`
   - `app/api/payments/verify`, including the storefront verify path
   - `app/api/payments/momo-status`
   - `lib/refunds/eligibility.ts` treats `abandoned` as terminal failed
6. **Handler text and data.** Fix "via Paystack" wording. Write the transaction id somewhere gateway-neutral. Check the column types of `wallet_payments.paystack_transaction_id` and `shop_orders.transaction_id`: Hubtel's id is hex, Paystack's numeric. If numeric, the unchecked updates fail silently and `process-order` blocks fulfilment.
7. **Handler "success" doesn't mean delivered.** `isOk` trusts HTTP status, but SMS `underpayment`/`bundle_not_found`, storefront `amount_mismatch`/`refused`, swallowed fulfilment failures and wallet `rpcError` all come back 2xx or null. Return a structured result, with 5xx for the wallet RPC failure.
8. **Start errors.** `receiveMoney`/`initiateCheckout` throw `HubtelPayInputError` on a relay 400 or bad amount (client allows 0.05, relay minimum is 0.10). `hubtelCallbackUrl` throws plain `Error`. Treat both as nothing sent, and alert. Alert on `isConfigRefusal` and `relay_404`, and include Hubtel 404/405. `not_found` never means fall back.
9. **Round amounts** to exact 2 decimals before the relay.
10. **Return URLs must be on the app host.** Relay `appUrl` rejects shop subdomains and custom domains; storefronts need a bounce route on www.
11. **Admin tooling for `needs_review`.** Plan 3 gives only an alert, with no screen and no re-drive, and those rows are terminal. Paid customers depend on this.
12. **Enforce no unsolicited prompts** at every `receiveMoney` caller; the relay accepts any valid msisdn. Store payer msisdn and channel for refunds.
13. **Set `expires_at` per mode**, longer than the status lag. Align with `expire-stale-airtime` and `expire-stale-bot-orders`. Decide what a Hubtel refund after `paid` should do.
14. **The customer's screen can show success after a refused upgrade** (known from the dealer fix); momo-status and verify read the wallet row, not the grant.
15. **Abandoned payments.** If the live test shows Hubtel returns 404 for ignored prompts or abandoned checkouts, replace the per-row 24h alert with a digest and define how those orders close.
