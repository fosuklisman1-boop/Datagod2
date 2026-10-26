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

---

## 1. What counts as a sale

Ghana is UTC+0 with no DST, so period boundaries are plain UTC midnights. A sale counts in a period by its `created_at`. It only counts once it is completed, and it drops out again if it is later failed or refunded.

### Dashboard board (ranked by `user_id`)

| Table | Amount | "Completed" when |
|---|---|---|
| `orders` | `price` | `status = 'completed'` ⚠️ verify vs `fulfillment_status` |
| `api_orders` | `price` | `status = 'completed'` |
| `airtime_orders` | `total_paid` | `status = 'completed'` |
| `afa_orders` | `amount` | `status = 'completed'` |
| `results_checker_orders` | `total_paid` | `status = 'completed'` and `user_id IS NOT NULL` |
| `hubtel_bill_orders` | `amount` | `status = 'completed'` |
| standard bundles | ⚠️ verify whether they write to `orders` or their own table |

### Shop board (ranked by shop owner = `user_shops.user_id`)

| Table | Amount | "Completed" when |
|---|---|---|
| `shop_orders` | `total_price` (retail) | `order_status = 'completed' AND payment_status = 'completed'` |
| `ussd_shop_orders` | `amount` | `order_status = 'completed' AND payment_status = 'completed'` |

⚠️ To decide during build: whether sub-agent shop sales also count toward the parent shop. The default is no; each shop counts for its own owner.

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

1. **Engine:** migration (all tables), sales view, rollup refresh function, cron, backfill script, `get_leaderboard` / `get_leaderboard_rank`. Vitest covers the period-boundary helpers (week starts Monday, Accra time) and name masking. A SQL test checks the totals against hand-picked orders.
2. **User page (read-only):** daily/weekly/monthly/yearly, both boards, podium, list, countdown, Check my rank, pause notice.
3. **Admin setup:** period picker, rewards toggle, Prizes tab, Presets, Pause program, Exclusions, live preview.
4. **Close & Results:** close and close-no-reward flows, frozen results, past-winner view on the user page, winner notifications.
5. **Delivery:** wallet, data, airtime, manual, and role upgrade with the `user_role_grants` expiry cron.
6. **Custom competitions:** admin CRUD, user-side chips, published/unpublished handling.

## 8. Open items to verify at the start of Phase 1

- [ ] Which status on `orders` means completed: `status` or `fulfillment_status`?
- [ ] Where standard-bundle purchases are stored
- [ ] Sub-agent shop sales: do they count for the sub-agent only? (default: yes)
- [ ] Refund after close: results stay frozen and the admin can cancel the prize (default)
- [ ] Rank count: fixed top 3, or let the admin set top N per board? (default: 3)
