# Special Bundles: design

**Goal.** Add a **Special Bundles** category to MTN on the dashboard Standard Bundles page. Each Special plan is the cheapest MTN non-expiry Hubtel bundle (the GHS 3 one, about 407 MB) bought N times for one recipient and shown as a single plan, for example "1.22GB for GH₵9.60, was GH₵9.75".

## Decisions (user, 2026-10-30)

| Topic | Decision |
|---|---|
| Plans | An admin-set list of multiples, for example `[3, 5, 8, 10, 15]`, stored in the Standard Bundles config. It can be edited without a deploy. |
| Price | Face price = N × the unit's live Hubtel price. Cashback applies as on any Standard Bundle. The card shows the cashback price with the face price struck through. |
| Partial failure | Admin review. Each delivered unit is its own order row, and a failed unit uses the existing per-order retry and refund tools on `/admin/standard-bundles`. |
| Networks | MTN only. |
| Surface | The dashboard Standard Bundles page only (paid from the wallet). Storefronts, the API and the bots are out of scope. |
| UI | The screenshot layout (shipped in 81957756). "Special Bundles" is the first category pill, with the line "Low Cost Non Expiry Bundles, special for you". |

## How it works

1. **Unit discovery.** In the MTN catalog, the unit is the bundle that matches the configured unit rule:
   - its category or name says non-expiry or Flexi;
   - its amount equals `specialUnitAmount` (default 3.00).

   The size per unit is parsed from the bundle's display or value. If no item matches, or the size can't be parsed, the Special category is hidden.

2. **Catalog.** For each configured multiple N, the API returns a synthetic bundle in the category "Special Bundles":
   - `display` = N × the unit size, shown in GB to 2 dp;
   - `amount` = N × the unit amount;
   - `token` = a signed token carrying `{ unitToken, n }`, which expires after 10 minutes like the other catalog tokens.

3. **Buy.** `POST /api/standard-bundles/buy` with a Special token goes to `buySpecial`:
   - **Price check.** Re-query the unit through the existing catalog path and re-validate the price. Apply cashback per unit: unit pay = `quoteCashback` of the unit amount, floored per unit, and total pay = N × unit pay, so each child row's `paid_amount` is exact. If the result doesn't match `expectedPay`, return 409.
   - **One transaction.** A new RPC, `create_special_bundle_orders(p_user, p_n, p_rows jsonb, p_total)`:
     - takes one wallet debit of the total and writes its transactions row;
     - inserts N `hubtel_data_orders` rows, all `channel='dashboard'` with the same recipient and the same `special_group_id`. Each row carries the unit amount, its `paid_amount` and cashback columns, and a `special_index` from 1 to N;
     - is idempotent on the group's idempotency key;
     - can be executed by service_role only.
   - **Dispatch.** Each child goes through the existing `dispatchBundleOrder`, one after another because of Hubtel rate limits, in the background (`after()`). Each child is a normal order with its own Hubtel reference and its own status, and the existing reconcile and status-check cover it.

4. **My orders.** Rows are grouped by `special_group_id` and shown as one line, for example "Special 1.22GB (3 × 407MB)", with a combined status:
   - all children completed → Completed;
   - any child failed → "Part delivered — we're on it";
   - otherwise → Processing.

5. **Admin.** `/admin/standard-bundles` lists each child with a "Special 2/3" badge and the group id. Retry and refund work per child, unchanged.

## Data model (one migration, next free number)

- **`hubtel_data_orders`:** add `special_group_id uuid NULL` and `special_index smallint NULL`, plus an index on `special_group_id`.
- **RPC `create_special_bundle_orders`:** SECURITY DEFINER; `REVOKE` from public, anon and authenticated; `GRANT` to service_role.
- **Config `standard_bundles_config`:** add `special: { enabled: false, multiples: [3,5,8,10,15], unitAmount: 3 }`. The validator caps N at 1–50 and the list at 10 entries. It ships with `enabled:false`.

## Errors

| Situation | Behaviour |
|---|---|
| Unit missing from the catalog, or its price changed | The category is hidden. A buy gets 409 "Price changed. Please try again." and nothing is charged. |
| Wallet balance too low | 402, and nothing is created. |
| A child fails at Hubtel | That child is marked `failed` and the existing alert fires. The group shows "Part delivered". The admin retries or refunds that child. |
| Server crash mid-dispatch | Children not yet sent stay `processing` with no Hubtel reference. The existing stuck-claim tools and admin retry cover them. |

## Testing

- **Unit discovery:** finding the unit and parsing its size.
- **Synthetic catalog entries:** exact GB and amount maths.
- **Cashback:** per-unit flooring, with the total equal to N × unit pay.
- **Token:** round trip and expiry.
- **Price drift:** 409.
- **RPC:** atomic debit plus N rows, idempotency, and a short wallet.
- **Dispatch:** N children sent one after another; when one fails, the others still complete.
- **My orders:** grouping.
- **Build:** a real `next build`.
- **Live test:** one supervised Special 3× purchase to a test number.

## Out of scope

- Selling Special plans on storefronts, the API or the bots.
- Other networks.
- Automatic refund of failed units.
