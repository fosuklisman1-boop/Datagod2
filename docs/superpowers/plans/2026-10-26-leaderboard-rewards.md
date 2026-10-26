# Leaderboard & Rewards — Plan

**Goal:** Rank users by completed sales value (GH₵) on two boards — **Dashboard sales** and **Shop sales** — across **daily, weekly, monthly, yearly** periods and **admin-created custom competitions**. Any period can optionally carry prizes for the top 3 on each board; admins set prizes, close the period to freeze winners, and deliver prizes from the admin panel.

**Reference screens:** user "Top Performers" page (podium + ranked list 4–30, countdown chip, Check my rank) and admin "Leaderboard Rewards" (Pause program, period picker, tabs Prizes / Close / Results / Delivery / Presets).

**Decisions (confirmed with owner, 2026-10-26)**

| Question | Decision |
|---|---|
| Which periods carry prizes | Admin enables rewards per period; periods without rewards are public rankings only |
| Ranking metric | Sales value (GH₵) of completed orders |
| Dashboard board products | Everything the user buys: data (web + API), airtime, AFA, results checker, bills |
| "Custom" | Admin-made named competitions with start/end dates, optional prizes |

| Winners per board | Fixed top 3 |
| Refund after close | Results stay frozen; admin may cancel the prize by hand |
| Public list | Podium 1–3 + list 4–30, plus Check my rank for everyone else |
| Sub-agents | Compete on their own; see §1 |

---

## 0. Reference screenshots (8), and what each one requires

The screenshots came from an existing implementation and the owner wants this look and flow. Copy below is quoted from the screens. Where a period name appears ("October 2026", "month"), it becomes the period label for the selected kind.

**User side: "Top Performers" page** (dark navy, soft raised cards)

1. **Page header (shot 8).**
   - Title: "Monthly top performers".
   - Lines: "The top 3 sellers in each category win a reward every month." and "Sales are counted from the 1st to the last day of each month (Ghana time). Only completed sales count."
   - A pill with a calendar icon showing "October 2026".
   - We add the Daily/Weekly/Monthly/Yearly/competition switcher above it. Header text changes with the kind, and the "win a reward" line only appears when rewards are enabled.
2. **"Top dashboard sales" card (shots 7–8).**
   - Blue grid icon tile, subtitle "Sales made from your dashboard.", round refresh button on the right.
   - "October 2026" next to a yellow chip with calendar-clock icon: "6 days left in October".
   - Rule line: "Counts your completed purchases made on the website and through the developer API." Because the owner chose *everything* for this board, this becomes "…on the website, the developer API, airtime, AFA, results checker and bills."
   - **Podium**, ordered 2 · 1 · 3:
     - #1 in the middle: tallest, gold, crown badge
     - #2 on the left: silver, medal badge
     - #3 on the right: bronze, ribbon badge
     - each step shows the rank number, masked name ("Anthony A.", long names truncated "ABUBAKA…") and "GH₵ 2,928.80"
   - Below it, an inset list of ranks 4–30, each row a round rank badge, the masked name, and the amount on the right.
3. **"Top shop sales" card (shot 6).**
   - Same layout, teal shop icon, subtitle "Sales made through your online shop.", rule "Counts completed sales through your storefront and USSD."
4. **Card footer (shots 5–6).**
   - A full-width blue gradient "Check my rank" button with a search icon. It opens your rank, your total and the gap to the next rank and to #3.
   - Info line: "Pending, processing, failed and refunded orders are not counted."
5. **Bottom nav (shots 5 and 8).** The page is reached from **More** in the floating bottom nav.

**Admin side: "Leaderboard Rewards" page**

6. **Header and program card (shot 4).**
   - Header: "Monthly rewards", with "Set the six prizes for a month, then close the month to lock in the winners."
   - A **Rewards program** card: "Shows a maintenance notice to every user instead of the rewards page. Cached for up to 1 hour on both ends — it does not take effect (or lift) instantly." It has an outline **Pause program** button.
   - We use a 5-min cache and say so in the copy.
   - Then a **Month** select. For us this is a kind select plus a period select.
   - Then tabs: **Prizes · Close month · Results · Delivery · Presets**, with an underline on the active tab, wrapping to two rows on phones.
7. **Prizes tab (shot 3).**
   - "Prizes for October 2026", then a "Dashboard sales" card and a "Shop sales" card, each with Rank 1/2/3 rows.
   - Each row shows the prize label and type ("GH₵50 CASH (Wallet top-up)", "10GB MTN BUNDLE (Data bundle)", "GH₵20 MTN Airtime (Airtime)", "15DAYS DEALER ROLE UPGRADE (Role upgrade)") and its status.
   - A cancelled prize is greyed: "- Cancelled", with the note "Cancelled. This prize cannot be reassigned."
   - **Our rule:** a cancelled prize stays as history and is never delivered or moved to another winner. Before close, the rank slot reopens so the admin can add a new prize. In the reference, every slot was cancelled while the Close tab still demanded "Prize needed", which would leave the admin stuck with only Close — No Reward.
8. **Close month tab (shot 2).**
   - Card "Close October 2026", note "This month has not ended yet. You can set prizes now and close it once the month is over."
   - Six rows: "Dashboard Rank 1–3" and "Shop Rank 1–3", each showing the prize or "Prize needed".
   - A red validation line: "Set a prize for: dashboard rank 1, …".
   - Primary button "Close October 2026" and outline button "Close — No Reward". Both stay disabled before the period ends, with the helper "Closing is unavailable until the month has ended."
9. **Results tab (shot 1).** Before close: "October 2026 is not closed yet, so there are no frozen results. Close the month to lock the standings." After close: the frozen standings. We also add a Live preview.

---

## 1. What counts as a sale

Ghana is UTC+0 with no DST, so period boundaries are plain UTC midnights. A sale counts in a period by its `created_at`. It only counts once it is completed, and it drops out again if it is later failed or refunded.

### Dashboard board (ranked by `user_id`)

| Table | Amount | "Completed" when |
|---|---|---|
| `orders` | `price` | `status = 'completed'` (verified: every provider writes the final state to `status`) |
| `api_orders` | `price` | `status = 'completed'` |
| `airtime_orders` | `total_paid` | `status = 'completed'` |
| `afa_orders` | `amount` | `status = 'completed'` |
| `results_checker_orders` | `total_paid` | `status = 'completed'` and `user_id IS NOT NULL` |
| `hubtel_bill_orders` | `amount` | `status = 'completed'` |
| standard bundles | Not read directly. `hubtel_cs_transactions` mirrors each purchase into an existing order table (`order_table` / `order_id`), so they are already counted through those tables. |
| `shop_orders` stock purchases | `total_price`, credited to the sub-agent shop's owner | `is_stock_purchase AND order_status = 'completed' AND payment_status = 'completed'` |

### Shop board (ranked by shop owner = `user_shops.user_id`)

| Table | Amount | "Completed" when |
|---|---|---|
| `shop_orders` | `total_price` (retail) | `order_status = 'completed' AND payment_status = 'completed' AND NOT is_stock_purchase` |
| `ussd_shop_orders` | `amount` | `order_status = 'completed' AND payment_status = 'completed'` |

### Sub-agents (decided 2026-10-26: standalone everywhere)

Sub-agents compete as ordinary users on both boards. Their sales count only for themselves and never roll up to the parent shop, because they compete with the parent. Only one level of sub-agents exists in practice.

- **Customer sales through a sub-agent's shop or USSD** count on the **sub-agent's** Shop board. The `parent_profit_amount` / `parent_shop_id` columns are ignored for ranking.
- **Stock purchases** (sub-agent buying from the parent via Buy Stock) are the sub-agent's own purchases, not customer sales:
  - they count on the **sub-agent's Dashboard** board
  - they are excluded from both Shop boards
  - they give the parent nothing
- **Prerequisite:** stock purchases are not marked on the stored row today. `is_stock_purchase` only exists in the request body (`app/api/shop/orders/create/route.ts`) and is never saved. A stock purchase is indistinguishable from a zero-markup customer sale. Phase 1 adds `shop_orders.is_stock_purchase boolean default false`, written by the create route. Historical rows are best-effort backfilled where `customer_email` matches the shop owner's email on a sub-agent shop.

**Excluded:** admins, plus any user on the `leaderboard_exclusions` list (test accounts, staff).

**Ties:** higher total first, then more orders, then whoever reached the total first.

---

## 2. Data model (new migration)

```
leaderboard_daily_totals          -- rollup, the only thing leaderboards read
  user_id, board ('dashboard'|'shop'), day date,
  total_amount numeric, order_count int, last_sale_at timestamptz
  PK (user_id, board, day)

leaderboard_periods
  id, kind ('daily'|'weekly'|'monthly'|'yearly'|'custom'),
  title, description,                 -- title auto-generated for standard kinds
  starts_on date, ends_on date,       -- inclusive, whole days (Accra = UTC)
  boards text[] default {dashboard,shop},
  rewards_enabled bool default false,
  is_published bool default true,     -- custom competitions can be drafted
  status ('open'|'closed'|'closed_no_reward'),
  closed_at, closed_by
  UNIQUE (kind, starts_on) WHERE kind <> 'custom'

leaderboard_prizes
  id, period_id, board, rank (1..3),
  prize_type ('wallet_topup'|'data_bundle'|'airtime'|'role_upgrade'|'manual'),
  label,                              -- "GH₵50 CASH", "10GB MTN BUNDLE"
  amount numeric, package_id, network, role, duration_days,
  status ('active'|'cancelled')       -- cancelled = cannot be reassigned
  UNIQUE (period_id, board, rank) WHERE status = 'active'

leaderboard_prize_presets           -- reusable prize templates (Presets tab)
  id, name, prize_type, label, amount, package_id, network, role, duration_days

leaderboard_results                 -- frozen on close, never recomputed
  id, period_id, board, rank, user_id,
  display_name, total_amount, order_count, prize_id

leaderboard_deliveries
  id, result_id UNIQUE, status ('pending'|'delivered'|'failed'|'skipped'),
  recipient_phone, reference,          -- idempotency key: LB-<result_id>
  attempts, last_error, delivered_at, delivered_by

user_role_grants                     -- needed for time-limited role prizes
  id, user_id, granted_role, previous_role,
  starts_at, expires_at, reverted_at, source ('leaderboard'|...), source_id

leaderboard_exclusions
  user_id PK, reason, created_by, created_at
```

Settings: `admin_settings.leaderboard_program_paused` (bool).

RLS: users and anon get no direct access. All reads go through API routes using the service role, which return masked names only ("Anthony A.") and never a phone number or email.

---

## 3. Ranking engine

1. **View `leaderboard_sales_events`** UNIONs the tables in §1 into one shape: `(board, user_id, amount, created_at, source_table, order_id)`, completed rows only.
2. **Rollup refresh** — the SQL function `refresh_leaderboard_totals(p_from date, p_to date)` deletes and re-inserts the daily totals for that day range from the view.
   - **Cron** `/api/cron/leaderboard-refresh`, every 5 min: refreshes today and yesterday, which catches late completions and refunds.
   - **Nightly**: refreshes the last 7 days.
   - **One-off backfill script**: fills history from the first order onward.
3. **Partial indexes** on each source table, `(created_at) WHERE status = 'completed'`, keep the refresh cheap.
4. **`get_leaderboard(board, start, end, limit 30)`** sums the daily totals over the range, excludes admins and exclusions, applies the tiebreak, and returns JSONB of top N with masked names. This one function serves every period, from a single day to a whole year.
5. **`get_leaderboard_rank(user_id, board, start, end)`** returns my rank, my total, the gap to the next rank, and the gap to 3rd place. It backs "Check my rank".
6. **API responses** are cached for 60 s per (board, period). Displayed figures can lag by up to about 5 min, and the page footnote will say so.

---

## 4. User side — `/dashboard/leaderboard` ("Top Performers")

- **Header:** "Top performers", plus a period switcher: **Daily · Weekly · Monthly · Yearly**, then a chip for each live custom competition. Each kind has a small prev/next control to browse past periods.
- **Rules text:** what counts and when periods reset, rendered per kind (e.g. "Sales are counted from Monday to Sunday (Ghana time)").
- **Two cards**, *Top dashboard sales* and *Top shop sales*. Each card has:
  - an icon, title, subtitle, and the period label
  - a countdown chip ("6 days left in October", "4 hours left today")
  - a refresh button
  - a **podium for ranks 1–3** with crown, medal and ribbon; when rewards are enabled, each step shows its prize label
  - a **ranked list for 4–30**
  - a **Check my rank** button that opens a sheet with rank, total, and "GH₵X more to reach #3"
  - the footnote "Pending, processing, failed and refunded orders are not counted."
- **Past winners:** closed periods show frozen results with a "Winner" badge instead of live standings.
- **When the program is paused:** a maintenance notice replaces the page.
- **Navigation:** add the page under "More" in the bottom nav and in the sidebar. Optionally add a dashboard home widget showing your rank this month.

API: `GET /api/leaderboard?kind=&start=&board=` · `GET /api/leaderboard/me?…` · `GET /api/leaderboard/periods` (live custom competitions plus recent closed periods).

---

## 5. Admin side — `/admin/leaderboard` ("Leaderboard Rewards")

- **Rewards program card** with a **Pause program** / **Resume** toggle. Use a 5-min cache rather than the 1 h shown in the screenshot.
- **Period picker:** a kind selector (Daily/Weekly/Monthly/Yearly/Custom), then a specific period. Standard periods are created on first use (get-or-create).
- **Rewards toggle** per period: "Give prizes for this period".
- **Tabs:**
  - **Prizes** — one block per board with Rank 1–3 rows. Each row has a type, label, and value fields, can be filled from a preset, and can be edited until close. **Cancel** marks the prize "Cancelled. This prize cannot be reassigned."
  - **Close period** — shows each rank's prize status ("Prize needed") and validation errors.
    - **Close {period}** is only enabled after the period has ended and all active ranks have prizes.
    - **Close — No Reward** freezes results with no prizes.
    - Closing runs a final rollup refresh for the period, then writes `leaderboard_results`.
  - **Results** — frozen standings per board: rank, user (full name, phone and email are visible to the admin), total, order count, prize. Before close it shows "not closed yet" and offers a **Live preview**.
  - **Delivery** — one row per winner showing prize, recipient phone (editable for data and airtime prizes), status, and attempts. Actions are **Deliver**, **Deliver all**, **Retry**, and **Mark delivered manually**.
  - **Presets** — CRUD for prize templates.
- **Competitions** (Custom kind) — create, edit or unpublish a named competition with title, description, dates, boards, and rewards on/off.
- **Exclusions** — add or remove users hidden from rankings.
- Every admin write goes to `admin_audit_log`.

API under `/api/admin/leaderboard/*`, admin-guarded like the existing admin routes.

---

## 6. Prize delivery

All delivery is idempotent, keyed on `LB-<result_id>`, so retries and double-clicks can never pay twice.

| Prize type | How it's delivered |
|---|---|
| `wallet_topup` | `credit_wallet_safely` with reference `LB-<result_id>` and a transaction row of type "Leaderboard reward" |
| `data_bundle` | Creates a GH₵0 `orders` row for `package_id` / recipient phone and hands it to the normal fulfillment pipeline. Delivery status follows that order. |
| `airtime` | Creates a GH₵0 `airtime_orders` row and sends it through existing airtime fulfillment |
| `role_upgrade` | Inserts into `user_role_grants`, sets `users.role`. New cron `/api/cron/expire-role-grants` (hourly) reverts the role to `previous_role` when it expires, unless the role was changed by hand in the meantime. |
| `manual` | Admin marks it delivered, with an optional note (physical prizes, etc.) |

Winners get an in-app notification when the period closes, and another when the prize is delivered (push/SMS via existing channels).

---

## 7. Build phases

Each phase can ship on its own.

1. **Engine (built 2026-10-26):** only the engine tables. Periods, prizes, results and deliveries land with the phase that uses them.
   - **Migrations:** `migrations/0133_leaderboard_engine.sql` (with `.selftest.sql`) and `0134_leaderboard_indexes.sql`.
   - **SQL test:** `migrations/tests/0133_leaderboard_engine_local_test.sql`, using a stub schema and hand-worked totals.
   - **Code:** `lib/leaderboard/{periods,service}.ts` with tests, cron `/api/cron/leaderboard-refresh` (every 5 min, cron-job.org batch A), and `scripts/leaderboard-backfill.ts`.
   - **Stock flag:** the shop order route now sets `is_stock_purchase`.
   - **Rollout order:** selftest → apply 0133 → apply 0134 statement by statement → run backfill → enable the cron.
2. **User page (built 2026-10-26):** `/dashboard/top-performers`.
   - **Content:** daily/weekly/monthly/yearly tabs, prev/next period, both boards, podium, ranks 4–30, countdown chip, Check my rank dialog, and the pause notice.
   - **Code:** `components/leaderboard/*`, `lib/leaderboard/public.ts`, `GET /api/leaderboard`, `GET /api/leaderboard/me`.
   - **Pause switch:** `admin_settings.leaderboard_config = { paused }`. The admin toggle comes in Phase 3.
   - **Navigation:** sidebar item with a NEW tag. The bottom bar has no "More" slot, so it isn't there. Never chosen as a landing page.
3. **Admin setup:** period picker, rewards toggle, Prizes tab, Presets, Pause program, Exclusions, live preview.
4. **Close & Results:** close and close-no-reward flows, frozen results, past-winner view on the user page, winner notifications.
5. **Delivery:** wallet, data, airtime, manual, and role upgrade with the `user_role_grants` expiry cron.
6. **Custom competitions:** admin CRUD, user-side chips, published/unpublished handling.

## 8. Open items to verify at the start of Phase 1

All resolved on 2026-10-26. See the decisions table and §1.
