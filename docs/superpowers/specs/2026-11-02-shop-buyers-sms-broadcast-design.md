# Shop Buyers SMS Broadcast — Design

## Goal

Let an admin send an SMS to everyone who has bought data through a Datagod shop. Each
message carries the link of the shop that person bought from most recently. The admin
picks which shops' buyers to reach and sees, per shop and in total, how many people will
receive it before sending.

## Decisions (2026-11-02)

1. **Who is a buyer:** both the payer and the recipient of every paid shop data order.
2. **Shop buyers only.** Direct Datagod dashboard and API buyers are excluded, so every
   recipient has a real shop link.
3. **Latest shop only.** Each phone number belongs to exactly one shop: the shop of its
   most recent paid data order. It gets one SMS, with that shop's link.
4. **Admin-managed opt-out list.** Numbers on it are always skipped, and the screen shows
   how many were excluded.
5. **The link is the shop's Datagod subdomain:** `https://<subdomain>.datagod.store`.
   `user_shops.subdomain` is NOT NULL and auto-assigned (migration 0055), so every shop
   has one and no fallback is needed. Linked custom domains and `/shop/<slug>` are not
   used.

## Context

- **Admin broadcasts already queue and drain** (`app/api/admin/broadcast` →
  `broadcast_recipients` → `drain-broadcasts` cron).
  - A recipient row can carry its own `rendered_message`, which group broadcasts already
    use for `[FirstName]`.
  - The audience cap is 100,000 (#35).
- **Paid shop data orders** live in two tables:

  | Table | Channel | Paid when | Phones |
  |---|---|---|---|
  | `shop_orders` | storefront | `payment_status = 'completed'` | `customer_phone` (data recipient / contact) |
  | `ussd_shop_orders` | USSD + WhatsApp shop | `payment_status = 'completed'` | `dialing_phone` (payer), `recipient_phone` |

  - **Storefront payer:** the MoMo payer is recorded in `payment_attempts.payer_phone`
    (migration 20261006) where available. It is linked to the shop order and included
    when present.
  - **Excluded:** sub-agent stock purchases (`shop_orders.is_stock_purchase`, 0133).
- **Not `shop_customers`.** It mixes airtime and results-checker buyers, and the Hubtel
  shop USSD stores the recipient there rather than the payer, so it isn't the source.
- **Shop link:** `https://<user_shops.subdomain>.<NEXT_PUBLIC_ROOT_DOMAIN>`, where the
  root domain defaults to `datagod.store`. This is `shopOrigin(subdomain)` without the
  custom-domain argument.

## Design

### 1. Database (one migration)

```sql
-- Admin "do not text" list for marketing SMS. phone_key = last 9 digits.
CREATE TABLE public.sms_marketing_opt_outs (
  phone_key  text PRIMARY KEY CHECK (phone_key ~ '^[0-9]{9}$'),
  reason     text,
  added_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- RLS on, REVOKE ALL FROM PUBLIC, anon, authenticated (service role only).

-- One row per phone: the shop of its most recent paid data purchase.
CREATE FUNCTION public.shop_buyer_audience(p_since timestamptz DEFAULT NULL)
RETURNS TABLE (phone_key text, shop_id uuid, last_purchase_at timestamptz)
-- UNION ALL of (phone, shop_id, paid_at) from:
--   shop_orders        customer_phone, + payment_attempts.payer_phone when linked
--   ussd_shop_orders   dialing_phone, recipient_phone
-- normalised to the last 9 digits, kept only if a valid Ghana mobile,
-- then DISTINCT ON (phone_key) ORDER BY paid_at DESC,
-- minus sms_marketing_opt_outs, minus inactive/deleted shops.

CREATE FUNCTION public.shop_buyer_counts(p_since timestamptz DEFAULT NULL)
RETURNS TABLE (shop_id uuid, buyers bigint)   -- GROUP BY over shop_buyer_audience
```

- Both functions are `SECURITY DEFINER`, executable by `service_role` only.
- They are pure reads, so they can be re-run at any time.
- Indexes on the paid/date columns are checked, and added if a full scan is too slow.

### 2. Server

- **`GET /api/admin/broadcast/shop-buyers?since=all|30|90|180`** (admin only) returns
  `{ shops: [{ shop_id, name, subdomain, link, buyers }], total, optedOut }`, sorted by buyers.
- **`POST /api/admin/broadcast`** `init` takes a new audience:

  ```ts
  recipients: { type: "shop_buyers", shopIds: string[] | "all", sinceDays?: number }
  ```

  - It resolves `shop_buyer_audience()` filtered to the chosen shops.
  - It renders each recipient's message with `[ShopName]` and `[ShopLink]` (and the
    existing `[Phone]`).
  - It enqueues them as pre-rendered "specific" recipients, the same path group
    broadcasts use.
  - SMS channel only, since these buyers have no email or push. The 100,000 cap applies.
- **`/api/admin/sms-opt-outs`** lists, adds (bulk paste) and removes opt-out numbers.

### 3. Admin UI (Broadcast page and the SMS Centre Broadcast tab)

- **Audience option:** a new choice, "Shop buyers".
- **Shop picker table:**
  - Shop name, subdomain link (e.g. `kofidata.datagod.store`) and buyer count.
  - Search, select all/none, and a time window: All time, 30, 90 or 180 days.
  - A sticky total: "4,213 buyers will receive this · 37 skipped (opted out)".
- **Message box:**
  - Buttons to insert `[ShopName]` and `[ShopLink]`.
  - A live preview rendered for the biggest selected shop.
  - An SMS length and parts counter that allows for the longest selected link.
- **Before sending:** a confirm dialog with the total recipients and the estimated SMS
  parts.
- **Opt-out list:** a small panel to paste numbers and see or remove existing entries.

### 4. Tests

- **SQL selftest on a local Postgres:**
  - payer and recipient both included;
  - the same number in 0/233/+233 form collapses to one entry;
  - the latest shop wins;
  - stock purchases, unpaid orders, opted-out numbers and inactive shops are excluded;
  - the `p_since` window.
- **Unit tests:** token rendering and the subdomain link builder (root-domain env, no
  custom domain).
- **Route tests:** the new audience validation and its enqueue shape.
- **Browser check:** the picker at phone and desktop widths.

## Open points

- **Inactive shops:** excluded by default, because the link would be dead.
- **Cost:** each recipient is at least one SMS, and the link adds characters. Most
  messages with a link fit in 1–2 parts. The confirm dialog shows the estimate.
- **Out of scope:**
  - automatic STOP-reply handling (the opt-out list is manual);
  - including direct buyers;
  - WhatsApp or email delivery for this audience.
