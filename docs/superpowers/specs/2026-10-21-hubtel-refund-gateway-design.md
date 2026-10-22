# Hubtel refund gateway — design

Date: 2026-10-21 · Status: draft, awaiting approval
Extends: `2026-10-05-admin-order-refunds-design.md` (the refund system this plugs into).

## Intent

Orders paid through Hubtel USSD (money collected by Hubtel, stored in `hubtel_transactions` with `hubtel_order_id`)
can today only be refunded by paying the customer back from another rail (Moolre payout) or manually. Hubtel offers a
Refund API that returns the money to the payer directly. Add it as a gateway in the existing `/admin/refunds` system so
an admin can refund a Hubtel-paid order in one click, with the same eligibility, clawback, notification and audit
behaviour as every other gateway.

## Goals

- New `RefundGateway` "Hubtel (refund to payer)" in `lib/refunds/gateways/`, listed before Manual.
- Supported only for orders with a paid `hubtel_transactions` row (non-null `hubtel_order_id`, `amount_paid` > 0, linked
  to the order via `order_table`/`order_id`) paid through Hubtel.
- Refund call goes through the existing DigitalOcean relay (Hubtel only accepts whitelisted IPs): new `POST /refund`
  route in `lib/ussd-hubtel/relay-handler.ts`, deployed by the user.
- Hubtel responds `0001` (pending) and later POSTs a callback. Add a webhook that resolves the refund from the callback.
- The existing reconcile cron covers refunds stuck pending (no callback received).

## Non-goals

- Partial refunds (the API has no amount parameter; Hubtel refunds the whole order).
- Refunding Paystack- or wallet-paid orders through Hubtel.
- Orders older than 45 days (Hubtel says to email business@hubtel.com; admin uses Moolre/manual instead).
- Auto-refund on fulfilment failure (separate decision, not asked for).

## Anti-goals (a failure even if it "works")

- Refunding an order twice (Hubtel `4515` means a request is already in flight; treat as pending, never resend).
- Marking a refund completed from an unauthenticated callback that does not match a pending refund and amount.
- Retrying on timeout/ambiguous responses (money may have moved): outcome `unknown`, as the Moolre gateway does.

## Facts from Hubtel's docs

- `POST https://refund-api.hubtel.com/refund/{CollectionAccountNumber}/order/{orderId}`, Basic auth, JSON body
  `{ "callbackUrl": "..." }` (mandatory).
- Responses: `0001`/202 pending (final result via callback); `3000`/404 order not found; `4000`/404 amount < 1 cedi;
  `4509`/404 not eligible; `4515`/423 already being processed.
- Callback: `{ responseCode: "0000", message: "Successful", data: { amount, charges, orderId, externalTransactionId } }`.
  The failure callback shape is not documented: treat any non-`0000` code as failed and log the raw body.
- Only transactions within 45 days.

## Constraints

- Relay config already holds `collectionAccount` and a Basic credential. Whether `statusBasicAuth` is valid for the
  refund API is unknown, so make the credential configurable (own env var, defaulting to the status auth).
- The relay runs on the droplet, not Vercel: the relay change needs a manual redeploy. The Vercel side must fail soft
  ("relay not updated yet") before the relay is redeployed.
- The callback must reach a public Vercel route; a token in the URL authenticates it (Hubtel callbacks are unsigned).
- Prod change protocol for any migration (precheck, dry run, user OK, apply, verify). Money change: tests first, fresh
  reviewer on the diff. Edit/Write tools only for code. Real `next build` before pushing main.

## Decided with the user

- Scope: gateway in `/admin/refunds` (not auto-refund, not a standalone button).
- Fixed IP: use the existing relay.
- Full-refund-only and the 45-day limit are enforced in `supports()` with a clear reason string (my call; the user
  approved the playback).

## Calls made after the builder check (mine, not the user's; change if wrong)

- "Paid" = `hubtel_transactions.paid_at IS NOT NULL` and `amount_paid` > 0 (migration 0106; states are
  awaiting_payment/processing/fulfilled/needs_review/failed). `order_table` there covers ussd_orders, ussd_shop_orders,
  airtime_orders, results_checker_orders, results_check_requests, ussd_afa_orders (later migrations may add the bill/bundle
  tables; builder confirms the live check constraint). `session_id` is unique but `order_id` is not: if an order has more
  than one paid row, `supports()` returns not-ok ("ambiguous, refund manually").
- Amount rule: Hubtel refunds the whole order, so `supports()` is ok only when the admin's refund amount equals
  `hubtel_transactions.amount_paid`. A callback is checked against that same figure. Anything else is not offered.
- 45-day window runs from `paid_at`, with a 1-day margin (44 days) in `supports()`.
- Any callback other than `0000` is parked as `unknown` (needs manual review), never auto-failed, because the failure
  payload is undocumented and may not mean the money stayed put. Only the synchronous codes `3000`/`4000`/`4509` are
  treated as definitely-not-refunded `failed`. No automatic retry after a failure or `unknown`; an admin decides.
- The callback URL is built from the production base URL setting, never a preview host.

## Decided by the user after the builder check

- Funding/fees unknown: treat as unknown. Record the callback `charges` on the refund row and show it to the admin.
- Rollout: ships DARK (gateway hidden behind an admin setting, off by default). First live refund is one small real order
  (1-2 GHS), supervised. No sandbox assumed; callback-host registration with Hubtel is a to-do for the user before enabling.

## Left to the builder

- How `RefundableOrder` learns its Hubtel order id: likely loaded in `lib/refunds/orders.ts` next to `externalOrderId`;
  add a `hubtelOrderId` field rather than overloading it.
- Where to persist the in-flight refund's Hubtel order id and callback token (existing refund row columns or a new
  migration); idempotency so a double click cannot send two requests.
- Webhook route path and token generation (per-refund random token stored on the refund row, constant-time compare).
- `checkStatus()`: Hubtel has no refund status endpoint in these docs. Probably returns pending/unknown and relies on
  callback + reconcile; confirm against the reconcile cron's contract.
- Whether `charges` in the callback is deducted from what the customer gets: record it on the refund row and show it
  to the admin.
- Tests: fake-transport pattern like the existing gateway tests. Cover every response code, timeout => unknown,
  `4515` => pending, and a callback with wrong token / amount / unknown orderId => rejected.
