# Admin Order Refunds — Design

Date: 2026-10-05 · Status: draft for review

## Goal

An admin can refund **pending** shop, USSD and USSD-shop orders from a dedicated page (`/admin/refunds`). The admin chooses the payout gateway per refund (Paystack, Moolre, wallet, or any gateway added later). A refund is allowed only if every shop owner's cut for the order can be clawed back (profit balance first, then wallet). Otherwise it is blocked.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Amount | Default = order price minus gateway fee. Admin may enter a lower partial amount. |
| Clawback source | Each owner: `shop_profits` / `shop_available_balance` first, then their wallet. |
| Shortfall | Hard block. No negative balances, no partial application, no one subsidizing another. |
| Sub-agent orders | Two cuts: sub-agent (`profit_amount`) and parent (`parent_profit_amount`). Both clawed back, each from its own owner. Block if EITHER is short. |
| Gateway | Admin picks freely. Wallet = credit customer wallet. Paystack reversal = native refund if originally Paystack. Paystack payout = MoMo transfer needing an admin-entered OTP (ledger status `awaiting_otp`; wrong OTP changes nothing; explicit Cancel restores the clawback after the gateway confirms nothing went out). Moolre = payout transfer. |
| Partial refund | Owner's FULL cut is still stripped (order is cancelled either way). |
| Wallet-paid USSD orders | Not listed (they are `processing` from payment; page lists `pending` only). |
| Clawback mechanism | Negative `shop_profits` row (balance cache re-syncs by trigger) + direct wallet debit; amounts come from the order's `shop_profits` rows, not order columns. |
| Dispatch exclusion | Per-order advisory lock shared by refund reserve and a dispatch claim in `createMTNOrder`/`createNonMTNOrder` (see plan). |
| Destination | Always the payer's number from the payment record. No editing. |
| Eligibility | Order is `pending` AND no live provider activity (see below). |
| Scope v1 | `shop_orders`, `ussd_orders`, `ussd_shop_orders`. Airtime, results-checker, AFA out of scope. No bulk refund. |
| Page | `/admin/refunds`: Pending tab + History tab (retry failed payouts). |
| Notifications | Customer SMS/WhatsApp on completion; in-app notice to each affected owner. |
| Audit | Ledger row plus `admin_audit_log` entry. Admin-only via `verifyAdminAccess`. |

## Eligibility rule

An order is refundable when ALL hold:
1. Order status is `pending`.
2. No `mtn_fulfillment_tracking` row (or equivalent provider tracking) in a non-terminal or successful state, i.e. none `pending`, `processing` or `completed`.
3. No retry still queued (`fulfillment_logs.retry_after` set/not exhausted, or retry sequence not exhausted). A failed tracking row alone does not make an order refundable if another provider attempt is scheduled.
4. No existing non-failed refund for the order.

Orders with provider activity still appear on the Pending tab, **greyed out with the reason** ("sent to provider", "retry queued"). Orders whose every provider attempt has terminally failed ARE refundable.

Reversal-safeguard note: a failed row can still flip failed to completed on a late provider webhook. The refund RPC sets the order to `refunding` so crons and webhooks cannot complete it; any late "completed" webhook for a `refunding`/`refunded` order is logged for admin attention, not applied.

## Data model

New table `order_refunds`:
- `id`, `order_table`, `order_id`, `gateway`, `amount`, `gateway_fee`, `status` (`reserved | processing | completed | failed`), `destination_phone`, `gateway_ref`, `error`, `admin_id`, timestamps.
- `clawbacks` jsonb: per owner `{ owner_id, role: shop|parent, from_profit, from_wallet }`, which is what a compensating reversal replays.
- Partial unique index on (`order_table`, `order_id`) where status <> `failed`. This is the double-refund guard.
- RLS: service-role only (per the RLS grant model in memory).

New order status `refunding` and `refunded` on the three order tables. Check the existing state-machine trigger on `shop_orders` allows `pending→refunding→refunded` and `refunding→pending` (compensation).

## Flow

1. **Reserve** (Postgres RPC `admin_refund_order`, single transaction):
   - Lock the order row (`FOR UPDATE`) and re-check eligibility.
   - Compute each owner's cut, then deduct from profit and then wallet. Abort the whole transaction if any owner is short.
   - Insert the ledger row (`reserved`), set the order to `refunding`.
2. **Pay out** via the gateway adapter, ledger status `processing`.
   - Wallet gateway: credit inside the same RPC, so it completes atomically.
3. **Finalize:**
   - Success: ledger `completed`, order `refunded`, notify.
   - Gateway failure: compensating RPC replays `clawbacks` in reverse, order returns to `pending`, ledger `failed` with the error. Retry from the History tab re-runs the flow from step 1.
   - Gateway timeout/unknown: ledger stays `processing`, flagged for manual reconciliation. Never auto-compensate on an ambiguous result, because the money may have left.

## Concurrency

1. **Dispatch claim (cron/refund race).** Every path that submits an order to a provider (`createMTNOrder`, `createNonMTNOrder`, the retry crons, manual fulfill) must first claim the order with a conditional update, `status 'pending' -> 'processing' WHERE status = 'pending'`, and abort if zero rows match. The refund RPC's `pending -> refunding` is the same kind of conditional update. Exactly one of the two wins. Without this, a cron that read the order before the refund reserved it could deliver and be refunded.
2. **Balance locks.** The RPC takes `FOR UPDATE` on each owner's `shop_available_balance` and wallet rows. The sufficiency check and the deduction happen under that lock, so a concurrent withdrawal or purchase cannot spend the same funds.
3. **Lock ordering.** Locks are taken in a fixed order: the order row first, then owner rows sorted by owner id, with wallet and balance rows in a fixed sequence. This prevents deadlocks when two sub-agent refunds touch the same owners in opposite roles.
4. **Retry exclusion.** Retry is allowed only for ledger rows in `failed`. A `processing` row blocks it. The retry re-runs the full reserve step, so it re-checks eligibility and balances.
5. **Idempotent payouts.** The ledger id is the transfer reference, so a repeated gateway call cannot pay twice.
6. **Tests.** Concurrent-call tests: two simultaneous refunds on one order, a refund racing a dispatch claim, and a refund racing a withdrawal. These use real Postgres, not the fake client, since the fake client can't prove locking.

## Gateway adapters

```ts
interface RefundGateway {
  id: string                       // 'paystack' | 'moolre' | 'wallet' | future
  label: string
  refund(input: { order: RefundableOrder; amount: number; destinationPhone: string }): Promise<{ ref: string }>
}
```

A registry maps `id` to the adapter. Adding a gateway is one adapter file plus one registry entry, and it appears in the picker automatically. Adapters wrap the existing `refundTransaction` / `initiateTransfer` ([lib/paystack.ts](../../../lib/paystack.ts)) and [lib/moolre-transfer.ts](../../../lib/moolre-transfer.ts). Payout adapters must be idempotent on the ledger id as the transfer reference.

## Admin page `/admin/refunds`

- **Pending tab:** merged list across the three tables. Server-side pagination; any `.in()` over more than a few hundred IDs is chunked. Columns: order type, shop, package, phone, amount paid, payment gateway, age, owner cut (plus parent cut). Filters: type, shop, payment method; search by phone or reference. Ineligible rows greyed out with the reason.
- **Refund dialog:** gateway picker, amount (default price minus fee, editable down, cannot exceed the paid amount), clawback preview per owner (profit, wallet, shortfall), confirm disabled when any owner is short.
- **History tab:** completed and failed refunds with admin, time, gateway, amount, clawbacks. Retry action on failed.

## API

- `GET /api/admin/refunds/pending`, `GET /api/admin/refunds/history`
- `POST /api/admin/refunds/preview` (computes the clawback without writing)
- `POST /api/admin/refunds` (executes), `POST /api/admin/refunds/[id]/retry`
- All behind `verifyAdminAccess`; rate limited.

## Testing

Vitest, fake-client pattern per [reference-testing]:
- Pure helper for clawback split (profit-then-wallet, sub-agent two-owner, shortfall).
- Eligibility function (all provider-state combinations, retry queued).
- Adapter registry and the failure/compensation path.
- RPC verified against a Supabase branch or via the Management API SQL fallback.

## Open items for planning

- Confirm the payer's number and gateway fee are stored for each of the three order types. If USSD payments don't record the fee, derive it from a gateway fee setting.
- Confirm the Moolre transfer API's idempotency reference support.
- Confirm wallet table and column names and the profit/balance sync convention in [lib/shop-service.ts](../../../lib/shop-service.ts).
