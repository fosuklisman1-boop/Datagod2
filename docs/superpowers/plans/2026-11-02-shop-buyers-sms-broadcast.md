# Shop Buyers SMS Broadcast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Shop buyers" audience in the admin SMS Centre broadcast. It reaches every payer and recipient of paid shop data orders, groups them under the shop of their latest purchase, and fills in that shop's subdomain link. Per-shop counts and an admin opt-out list come with it.

**Architecture:**
- **Migration 0145** adds the opt-out table and two read-only `SECURITY DEFINER` functions (`shop_buyer_audience`, `shop_buyer_counts`) that do the dedupe and "latest shop" logic in SQL.
- **`lib/sms/shop-buyers.ts`** holds pure helpers (phone key, subdomain link, token rendering) plus paged readers.
- **The existing queued broadcast** sends the pre-rendered per-recipient messages.

**Tech Stack:** Postgres (Supabase), Next.js route handlers, Vitest, React (shadcn/ui).

**Spec:** `docs/superpowers/specs/2026-11-02-shop-buyers-sms-broadcast-design.md`

**Scope:** the SMS Centre Broadcast tab (`app/admin/sms-centre/_components/BroadcastTab.tsx`). It is the broadcast screen in the sidebar and already holds the group and shop-owner audiences. The legacy `/admin/broadcast` page (roles/specific only) is unchanged.

---

## File map

| File | Responsibility |
|---|---|
| `migrations/0145_shop_buyers_audience.sql` | `sms_marketing_opt_outs`, `shop_buyer_audience(p_since, p_shop_ids)`, `shop_buyer_counts(p_since)` |
| `migrations/0145_shop_buyers_audience.selftest.sql` | Local Postgres assertions |
| `lib/sms/shop-buyers.ts` (+ test) | `phoneKey`, `shopSubdomainLink`, `renderShopTokens`, `SHOP_TOKENS`, paged `loadShopBuyerCounts` / `loadShopBuyerAudience` |
| `app/api/admin/broadcast/shop-buyers/route.ts` | GET per-shop counts and links, total, opted-out count |
| `app/api/admin/sms-opt-outs/route.ts` | GET list, POST add (bulk), DELETE remove |
| `app/api/admin/broadcast/route.ts` | New `shop_buyers` audience (SMS only), pre-rendered enqueue |
| `app/admin/sms-centre/_components/ShopBuyersPicker.tsx` | Shop table: search, select all, window, total, opt-out panel |
| `app/admin/sms-centre/_components/BroadcastTab.tsx` | Audience option, token buttons, preview, estimate, confirm |

---

### Task 1: Migration 0145 + selftest
- [ ] Opt-out table: `phone_key text PK CHECK '^[0-9]{9}$'`, `reason`, `added_by`, `created_at`. RLS on, revoked from PUBLIC, anon and authenticated.
- [ ] `shop_buyer_audience(p_since timestamptz, p_shop_ids uuid[])` returns `(phone_key, shop_id, last_purchase_at)`:
  - **Sources** (UNION ALL of phones from paid data orders):
    - `shop_orders.customer_phone`, where `payment_status = 'completed'` and not a stock purchase;
    - `payment_attempts.payer_phone`, joined on `order_id` with `payment_type = 'shop_order'`;
    - `ussd_shop_orders.dialing_phone` and `recipient_phone`, where `payment_status = 'completed'`.
  - **Phone key:** the last 9 digits, kept only if they match `^[25][0-9]{8}$`.
  - **One shop per number:** `DISTINCT ON (phone_key) ORDER BY paid_at DESC`.
  - **Exclusions:** opted-out numbers and shops where `is_active IS NOT TRUE`.
  - **Filters:** applied after the latest-shop pick, so a buyer who moved to another shop never shows under the old one.
- [ ] `shop_buyer_counts(p_since)`: GROUP BY shop over the audience.
- [ ] Both functions: STABLE, `SECURITY DEFINER`, `search_path = public`, EXECUTE for `service_role` only.
- [ ] Selftest on a local Postgres:
  - payer and recipient are both included;
  - the 0 / 233 / +233 forms of a number collapse to one entry;
  - the latest shop wins, even when filtering to the older shop;
  - stock purchases, unpaid orders, opted-out numbers, inactive shops and invalid numbers are excluded;
  - the `p_since` window works;
  - counts equal the audience.

### Task 2: `lib/sms/shop-buyers.ts`
- [ ] `phoneKey(raw)` returns the last 9 digits, or null.
- [ ] `localPhone(key)` returns `"0" + key`.
- [ ] `shopSubdomainLink(subdomain)` returns `https://<sub>.<NEXT_PUBLIC_ROOT_DOMAIN || datagod.store>`.
- [ ] `renderShopTokens(msg, { shopName, shopLink, phone })` fills `[ShopName]`, `[ShopLink]` and `[Phone]`, using function replacers (same reason as `personalize`).
- [ ] Paged readers: RPC + `.range()` in pages of 1,000, because PostgREST caps responses at 1,000 rows.
- [ ] Shop details read in chunks of 200 ids.
- [ ] Unit tests for every helper, plus paging over more than 1,000 rows with a fake client.

### Task 3: Admin APIs
- [ ] `GET /api/admin/broadcast/shop-buyers?since=all|30|90|180` returns `{ success, data: { shops, total, optedOut } }`, sorted by buyers descending.
- [ ] `/api/admin/sms-opt-outs`:
  - GET returns the list and count.
  - POST `{ phones: string[] | string, reason? }` accepts commas, newlines or spaces; invalid numbers are reported and duplicates upserted.
  - DELETE `{ phones }` removes entries.
- [ ] All routes are admin only (`verifyAdminAccess`).

### Task 4: Broadcast route
- [ ] Accept `recipients: { type: "shop_buyers", shopIds: string[] | "all", sinceDays?: 30|90|180 }`.
- [ ] Validate:
  - the channel list must be `["sms"]` exactly;
  - `shopIds` must be uuids or `"all"`;
  - the audience can't be empty;
  - the audience can't exceed `MAX_BROADCAST_RECIPIENTS`.
- [ ] Resolve the audience, fill in each recipient's message, and enqueue the rows as pre-rendered "specific" recipients. `target_group` is `["shop_buyers"]`.

### Task 5: UI
- [ ] Audience option "Shop buyers": only SMS is selectable; picking it switches channels to SMS.
- [ ] `ShopBuyersPicker`:
  - window select and search;
  - a table with checkbox, shop name, subdomain link and buyer count;
  - select all/none;
  - a sticky total of selected buyers, with the opted-out count;
  - an "Opt-out list" disclosure (paste numbers, add, list with remove).
- [ ] Message: `[ShopName]` / `[ShopLink]` insert buttons; preview uses the biggest selected shop.
- [ ] Segment estimate: uses the longest selected link. Recipients is the selected total; credits = segments × recipients.
- [ ] Confirm dialog: says "N shop buyers across M shops".
- [ ] Browser check at desktop and phone widths with mocked APIs.

### Task 6: Verify + ship
- [ ] Run the vitest suites for the touched areas, `tsc`, eslint on changed files and `next build`.
- [ ] Commit, push, open a pull request. The migration must be run in Supabase before use; the route returns a clear error until it is.
