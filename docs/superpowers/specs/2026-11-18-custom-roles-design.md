# Custom Roles — Design

Date: 2026-11-18 · Status: draft, awaiting approval · Size: project (multi-phase)

## 1. Intent

Admin wants **ready-made price tiers** that users can **buy into** (like the
dealer upgrade today) or be **upgraded into by an admin**. Each tier is a
named role (e.g. "Super Dealer", "Agent") with its own prices for every
product, its own rights, its own theme, and it must appear **everywhere the
dealer role appears today** — including every admin screen where a role is
picked for an action. The existing roles (user, dealer, sub_agent, admin)
become rows in the same system so admin can manage their prices/theme too.
Owner asked for a professional, detailed feature set.

## 2. Today (what this replaces)

- `users.role` is free text: `user | dealer | sub_agent | admin`. ~96 files
  check `role === 'dealer'` directly (nav, purchase, bulk, API v1/v2, USSD,
  WhatsApp bot, AI chat, shop pricing, airtime fees, cashback, bills, SMS).
- `packages.dealer_price` (~58 files, plus the Expo app in `mobile/`) with a
  copy-pasted rule "dealer_price if > 0 else price"
  (e.g. `lib/shop-commerce/pricing.ts:57`, `app/api/orders/purchase/route.ts:188`).
- Dealer upgrade = `subscription_plans` + `user_subscriptions` (no role
  column — every plan means dealer). Expiry crons set `role='user'`.
- `app/api/admin/users/update-role/route.ts` hard-codes valid roles, blocks
  sub-agents from becoming dealers, and **re-adjusts the user's shop profit
  margins on upgrade so storefront selling prices don't move**.
- Nav visibility: hard-coded `roles: [...]` arrays in `lib/dashboard-nav-items.ts`.
- Themes: 3 fixed skins (`default|dealer|admin`) in `lib/sidebar-theme.ts`
  and `lib/bottom-nav-theme.ts`.
- Role-tiered settings: airtime `airtime_fee_{net}_dealer`, cashback
  customer/dealer columns, `ussd_price_tier` (regular|dealer), signup
  default role (user|dealer).

## 3. Goals

1. Admin creates/edits/archives roles at `/admin/roles`.
2. Per-role prices for: data packages, airtime fees, cashback rates, bills /
   other Hubtel services, withdrawal minimum & fee.
3. Per-role rights (permission checklist) and limits.
4. Per-role theme (skin + accent + badge).
5. Users get a role by buying a plan, by admin action, or by auto-promotion.
6. Every role picker / role display in the app is driven by the `roles` table.
7. Existing dealers, sub-agents, shops and the mobile app see **no change**
   on the day the foundation ships.

### Non-goals
- Custom *admin* roles / admin staff permissions (separate future project).
- Changing how sub-agents relate to parent shops.
- Per-user (rather than per-role) custom prices.

### Anti-goals (failure even if it "works")
- Any path where a custom role grants admin power, or a user can change
  their own role.
- A blank/half-filled role selling anything at GHS 0 or below cost silently.
- A storefront's customer-facing price jumping when its owner changes role.
- A missed call site leaving one channel (USSD, bot, API) on old dealer
  logic while web uses new logic.

## 4. Approaches considered

- **A. New tables + dealer mirror (CHOSEN — Claude's call, owner did not
  object).** Normalised tables + one resolver. A DB trigger keeps
  `packages.dealer_price` mirrored from the dealer role's prices so all
  legacy readers (and the mobile app) keep working while call sites are
  migrated channel by channel. Mirror retired last. Phased, reversible.
- **B. JSONB `role_prices` on packages.** Fast but no FK integrity, weak
  audit/scheduling, silent typos. Rejected.
- **C. Same tables, big-bang switch.** One missed site = wrong prices on
  live money. Rejected.
- Postgres-role/RLS-based rights rejected: rights are enforced in app code
  and RLS is broad per migration 0060.

## 5. Design

### 5.1 Data model (new migration)

- `roles` — `id, slug (unique, immutable), name, description, badge_color,
  icon, rank int (ladder order), is_system bool, is_public bool (shown on
  upgrade page), fallback_role_id (where members go on expiry), archived_at,
  theme jsonb, limits jsonb, created_at, updated_at`.
  Seed: `user`(rank 0), `dealer`(rank 10), `sub_agent`, `admin` with
  `is_system=true`. System roles cannot be archived or have slug changed.
  `admin` is never offered in the roles hub (members, clone, plans,
  promotion); an existing admin can still make someone admin through the
  current update-role path, exactly as today.
- `users.role` stays text holding the slug; add FK to `roles.slug`
  (after verifying all existing values are seeded).
- `role_package_prices(role_id, package_id, price, PK(role_id, package_id))`.
- `role_service_rates(role_id, service_key, rate_type, value, ...)` — one
  table for airtime fee %, cashback %, bill fees, withdrawal min/fee.
  `service_key` values come from the existing settings keys.
- `role_permissions(role_id, capability text, PK)` — capability keys
  defined in code (`lib/roles/capabilities.ts`), e.g. `shop.manage`,
  `subagents.manage`, `api.keys`, `bulk.orders`, `bots.ussd`,
  `page:/dashboard/…`.
- `role_plans` — extend existing `subscription_plans` with `role_id`
  (backfill = dealer). `user_subscriptions` unchanged otherwise.
- `role_price_schedules(id, role_id, kind, payload jsonb, effective_at,
  applied_at, created_by)` — future-dated price changes applied by cron.
- `role_promotion_rules(role_id, spend_threshold, window_days, enabled)`.
- `role_audit_log(id, actor_id, role_id, action, target_user_id, before
  jsonb, after jsonb, reason, created_at)` — append-only.
- RLS: all new tables service-role only for writes; read of `roles`
  (public fields only) allowed for authenticated. No `USING(true)` on
  price/audit tables.

### 5.2 Resolver (`lib/roles/`)

Single entry point used by every surface:
`resolveRoleContext(userId | roleSlug) → { role, ladder, can(cap),
limits, theme }` and `priceFor(roleSlug, packageId)` /
`rateFor(roleSlug, serviceKey)`.

**Fallback rule (owner decision):** blank price → next role down the ladder
→ … → public `packages.price`. Same for service rates. Pure, unit-tested,
lives in `lib/`.

`admin` keeps its current behaviour (prices like dealer) via the same
resolver, hard-coded, not configurable.

### 5.3 Dealer mirror (transition)

Trigger on `role_package_prices` for the dealer role writes
`packages.dealer_price`; reverse trigger on `packages.dealer_price` writes
the dealer row (so the old admin packages form keeps working until it's
replaced). Retired in the final phase after every reader is migrated and
the mobile app is updated.

### 5.4 Role changes (one code path)

`changeUserRole(userId, toRole, { actor, reason, source:
'admin'|'purchase'|'expiry'|'promotion', expiresAt? })` in `lib/roles/`:
- refuses `admin` as target; refuses sub-agents → non-sub-agent roles
  (current rule generalised); refuses archived roles;
- **recomputes the user's shop profit margins so storefront selling prices
  stay unchanged** (generalising update-role's dealer logic to any
  base-price change, up or down);
- writes `role_audit_log`; sends SMS/in-app notification.
The update-role route, Paystack/Hubtel upgrade webhooks, expiry crons and
auto-promotion cron all call it.

### 5.5 Getting a role

- Upgrade page lists `is_public` roles above the user's rank with their
  plans; existing dealer purchase flow generalised by `plan.role_id`.
- Admin upgrade/downgrade: reason required, optional expiry, optional free
  trial (subscription row with price 0).
- Expiry: member drops to `fallback_role_id`; reminder SMS/WhatsApp at
  3 days and 1 day before.
- Auto-promotion: daily cron, completed-order spend over `window_days` ≥
  threshold → promote to that role. Never demotes. Switchable per role.

### 5.6 Admin UI — `/admin/roles` hub (sidebar NEW tag)

- Roles list: badge, members, revenue/profit this month, upcoming expiries.
- Role editor tabs: **Basics** (name, description, badge, rank, public,
  fallback) · **Prices** (package grid filtered by network; bulk actions
  "base −x%", "copy from role ± GHS"; margin guard warns below provider cost
  or below the next-lower role; "View as this role" preview) · **Services**
  (airtime, cashback, bills, withdrawals) · **Rights & limits** (grouped
  checklist; daily spend cap, max bulk size, API keys, sub-agents) ·
  **Plans** · **Theme** (skin + accent, live preview) · **Promotion** ·
  **Scheduled changes** · **Members** (search, bulk move) · **Audit**.
- Clone role (copies prices, rates, rights, theme).
- Archive only when member count is 0 (bulk-move first).
- Desktop layout: multi-column at `lg:`; navy accent.

### 5.7 "Appears everywhere"

Replace hard-coded role lists with `roles` lookups in:
admin users filter + change-role dropdown, signup default role, USSD price
tier (becomes "price as role…"), SMS broadcast audience, packages page
(one price column per role, or link to the grid), airtime fee table,
cashback columns, custom-domain page visibility, admin overview role chart,
admin order/profit report filters. Customer side: nav (`roles` arrays →
capabilities), sidebar/bottom-nav skins (from role theme), role badge,
API v1/v2, USSD, WhatsApp bots, AI chat tools, storefront base price.

## 6. Phases (each shippable, each through fresh-reviewer gate)

1. **Foundation (invisible):** tables, seed, resolver, mirror, `changeUserRole`.
   Dealer behaviour byte-identical (parity tests on resolver vs old rule).
2. **Migrate readers channel by channel:** web buy/bulk → shops → API v1/v2
   → USSD (both) → WhatsApp bots + AI → airtime/cashback/bills/withdrawals.
3. **Admin hub v1:** create/clone roles, prices, services, rights, theme,
   members, audit. Rights enforced via `can()`.
4. **Getting roles:** per-role plans, upgrade page, expiry + reminders,
   admin up/downgrade, all admin role pickers.
5. **Automation & reporting:** auto-promotion, scheduled price changes,
   role filters in reports and broadcasts.
6. **Retire mirror:** mobile app reads resolver API; drop dealer-specific code.

## 6a. Decisions from the builder check

Owner decisions:
- **Downgrade/expiry storefront prices:** keep customer prices, shrink the
  owner's margin. If the margin would go below 0, clamp it at 0 (price rises
  only by the shortfall). Same rule for upgrades (margin grows, price fixed).
- **Below-cost role price:** warn and allow override — admin must tick
  "I know this sells at a loss"; the override is recorded in the audit log.
  GHS 0 / negative is always a hard block.

Claude's calls (owner may correct):
- **Sub-agents** keep today's pricing (parent sets cost via
  `sub_agent_shop_packages.parent_price` / catalog). `sub_agent` role row
  carries only theme/rights; no role prices. Snapshot behaviour unchanged.
- **Ladder:** `user` and custom/dealer roles have ranks; `sub_agent` and
  `admin` are off-ladder. Price fallback walks the ladder down;
  `fallback_role_id` is used only for expiry. Admin sets a new role's rank.
- **Mirror semantics:** `dealer_price` NULL or 0 ⇔ no dealer row (preserves
  old "fall back to price"). Triggers use a recursion guard
  (`pg_trigger_depth()` / session flag). Clearing a dealer grid cell sets
  `dealer_price` NULL.
- **Service-rate mirror:** existing `_dealer` keys in `admin_settings`
  (airtime fees, cashback, withdrawals) are mirrored to/from the dealer
  role's `role_service_rates` the same way — no hard switch.
- **Rights:** every `role === 'dealer'` gate becomes a server-side `can()`
  check (UI hides too). Dealer role is seeded with exactly today's
  behaviour; parity tests prove it.
- **Buying:** only roles ranked above the current one are purchasable.
  Upgrading mid-subscription ends the old one with no proration.
- **Auto-promotion spend:** the user's own completed orders (data, airtime,
  bills), refunds excluded, using the dedup rules from the profit/revenue
  reference; shop-customer orders excluded.
- **Mobile app:** check its price source before Phase 6; mirror stays
  until it no longer reads `dealer_price`.

## 7. Constraints

- Money paths: TDD, fresh reviewer per phase, prod change protocol
  (precheck → dry run → owner OK → apply → verify).
- Pricing always server-side; client never sends price.
- Bulk `.in()` lists chunked (known 2000+ no-op trap).
- No PII in logs; audit log stores ids not phone numbers.
- Channel announcement post after each user-visible phase.

## 8. Left to the builder

Exact column types, capability key list, UI component structure, cron
schedules (use cron-job.org sync), notification wording, test layout.
