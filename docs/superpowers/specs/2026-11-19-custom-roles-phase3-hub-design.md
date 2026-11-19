# Custom Roles Phase 3 — `/admin/roles` hub — Design

Date: 2026-11-19 · Status: draft, awaiting owner approval · Size: project
Parent spec: `docs/superpowers/specs/2026-11-18-custom-roles-design.md` (§5.6, §6 phase 3, §6a).
Branch: `feat/custom-roles-hub` (off origin/main 2a187ea9, which has Phases 1+2 live).

## 1. Intent and why

The owner wants ready-made price tiers ("Super Dealer", "Agent", …) that admins
create and manage in one place, then move users into. Phases 1–2 put every
price reader (web, bulk, API v1/v2, shops, USSD, bots, AI, airtime fees,
cashback) on the roles tables, but nothing can create or edit a role yet and
custom roles are switched off (`lib/roles/flags.ts`
`CUSTOM_ROLE_ASSIGNMENT_ENABLED = false`). Phase 3 builds the admin hub and
the rights system, then switches custom roles on.

## 2. What exists today (facts this design builds on)

- Tables (prod): `roles` (0184: slug, name, description, badge_color, icon,
  rank unique among live ranked roles, is_system, is_public,
  fallback_role_id, theme jsonb, limits jsonb, archived_at),
  `role_package_prices` (0184, with two-way dealer mirror triggers to
  `packages.dealer_price`), `role_service_rates` (0186, empty; keys
  `airtime_fee:<net>`, `cashback_share:<key|group>`). All service-role only.
- System roles: `user` rank 0, `dealer` rank 10, `sub_agent` and `admin`
  off-ladder. `roles_protect_system` trigger blocks slug change / delete of
  system roles.
- Readers: `lib/roles/{ladder,repo,pricing,service-rates}.ts`. System slugs
  `user`/`dealer` read today's `admin_settings` airtime fees and cashback
  shares directly; only custom roles read `role_service_rates`.
- Role changes: `changeUserRole` in `lib/admin-users/account-ops.ts`
  (refuses admin target from custom path, sub-agent rule, margin
  recompute keeping storefront prices fixed, `admin_audit_log`
  'user_role_change' row). Custom targets refused while the flag is off.
- **Rights today:** User and Dealer see exactly the same dashboard pages
  (`lib/dashboard-nav-items.ts` `roles: [...]` arrays); dealers only pay less.
  Sub-agents have their own fixed set. **A custom-role member would today get
  an empty menu** (no array lists their slug) and land on
  `/dashboard/unavailable`. Sidebar skin is chosen by name
  (`components/layout/sidebar.tsx:119`: dealer → purple, else default).
- No per-package cost is stored anywhere (only per-order
  `provider_cost_ghs` from Kuntanii).

## 3. Goals

1. `/admin/roles` hub (sidebar NEW tag, admin group): list, create, clone,
   archive, rank ladder.
2. Role editor tabs: Basics · Prices · Services · Rights · Theme · Members ·
   Audit.
3. Rights: per-role checklist that both **hides** pages and **blocks** the
   matching server actions (owner decision).
4. New **Our cost** per package, used by the below-cost warning (owner
   decision).
5. Append-only audit of every role edit.
6. End of phase: flip `CUSTOM_ROLE_ASSIGNMENT_ENABLED = true`, re-run the
   Phase 1–2 parity checks plus a seeded real custom role.

### Non-goals (later phases)
- Plans / upgrade page / expiry / admin role pickers elsewhere → Phase 4.
- Auto-promotion, scheduled price changes, per-role revenue/profit stats,
  report & broadcast role filters, bills and withdrawal rates → Phase 5.
- Retiring the dealer mirror → Phase 6.
- Limits (daily spend cap, max bulk size): not chosen for Phase 3.
- "View as this role" preview: cut.
- Custom admin roles / staff permissions.

### Anti-goals (failure even if it "works")
- Anything in the hub can make someone admin, or grant an admin page.
- A role sells at GHS 0 / negative, or below cost without a recorded tick.
- A storefront's customer price moves because its owner was bulk-moved.
- A right is hidden in the menu but still usable through its API (or the
  reverse: blocks something Dealer/User can do today).
- Any change to what existing users see or pay on the day this ships.
- A price saved with no audit row.

## 4. Approaches

**Saving edits**
- **A (chosen, Claude's call — owner handed over the how):** validation in
  pure `lib/roles/admin/*` (TDD), then one `SECURITY DEFINER` Postgres
  function per save kind that locks the role row (`FOR UPDATE`), writes the
  change and appends the `role_audit_log` row in one transaction. Locking
  the role first serialises concurrent grid saves and avoids the dealer
  mirror lock-order deadlock noted in Phase 1. Routes: `verifyAdminAccess`
  → validate → `rpc()`.
- B: app-side writes then audit insert — rejected: a failure between them
  leaves an unaudited price change on a money table.

**Enforcing rights**
- **A (chosen):** a capability registry in code
  (`lib/roles/capabilities.ts`) maps each capability to its dashboard
  hrefs and its API route folders. Nav filters by capability; each mapped
  API route calls `requireCapability(user, cap)` next to its existing auth.
  A guard test walks the registered folders and fails if a route file does
  not call it (same idea as `lib/pricing/guard.test.ts`).
- B: one check in `middleware.ts` — rejected: a DB read on every request,
  and middleware cannot see per-route logic.

## 5. Design

### 5.1 Migration 0187 (prod change protocol applies)

- `role_permissions(role_id uuid FK roles ON DELETE CASCADE, capability
  text CHECK (capability ~ '^[a-z_]+(\.[a-z_]+)*$'), PK(role_id,
  capability))`. Seeded: `user` and `dealer` each get **every** capability
  in the registry (today they see the same pages); `sub_agent` and `admin`
  get no rows (their rights stay hard-coded, see 5.2).
- `role_audit_log(id bigserial, actor_id uuid, role_id uuid, action text,
  before jsonb, after jsonb, reason text, loss_override bool default false,
  created_at)`; append-only (trigger rejects UPDATE/DELETE). Stores ids, no
  phone numbers.
- `packages.cost_price numeric(10,2) NULL CHECK (cost_price IS NULL OR
  cost_price >= 0)`.
- Write functions (definer, `search_path` pinned, EXECUTE revoked from
  PUBLIC/anon/authenticated, granted to service_role):
  `admin_role_upsert` (create/clone/basics/theme/rank),
  `admin_role_set_prices` (batch of package prices, NULL = delete row),
  `admin_role_set_rates`, `admin_role_set_permissions`,
  `admin_role_archive` (refuses if any `users.role = slug`; refuses system
  roles), each taking `p_actor uuid, p_reason text` and writing one audit
  row with before/after. Every function refuses `slug = 'admin'` and
  refuses editing `admin`/`sub_agent` prices/rates/rights.
- Selftest SQL + PGlite run as in 0184–0186; runbook prechecks in header.

### 5.2 Capability registry (`lib/roles/capabilities.ts`)

Grouped, each with label, hrefs, api folders:
- **Buy:** `buy.data` (data packages, standard bundles), `buy.airtime`,
  `buy.afa`, `buy.bills` (bills, broadband), `buy.results` (results
  checker/check).
- **Shop:** `shop.storefront` (my-shop, shop-orders, customers, pricing,
  shop-profile, profit logs, withdraw, payment reverify, blocked numbers),
  `shop.subagents` (sub-agents, sub-agent catalog), `shop.bots` (USSD/
  WhatsApp bot), `shop.sms` (SMS), `shop.text_orders`.
- **Account:** `account.wallet` (wallet, transactions, my-orders),
  `account.api` (Developer / API keys), `account.leaderboard` (top
  performers), `account.upgrade`.
- Always on, not in the checklist: dashboard home, profile, support.

Exact href/folder lists are fixed in the plan from
`lib/dashboard-nav-items.ts` and `app/api/**`. `can(roleSlug, cap)`:
- `admin` → true for all (unchanged admin behaviour).
- `sub_agent` → today's hard-coded sub-agent set (from the current nav
  arrays), not editable.
- any other role → membership in `role_permissions`; unknown/archived role
  → false. Read failure → **fail closed** (deny + menu shows only the
  always-on pages), never "allow".

**What blocking covers (Claude's call):** the member's own dashboard pages
and their authenticated actions (e.g. add a sub-agent, create an API key,
edit shop prices). It does **not** switch off customer-facing sales of an
existing storefront, USSD/WhatsApp shop menu or existing API keys' orders —
switching those off would hurt the member's customers and is an admin
suspension action, not a role right. (**Owner confirmed 2026-11-19: keep
selling.**)

### 5.3 Nav and theme

- `NavItem.roles` arrays become `cap` per item. Visible = `can(role,
  item.cap)` (or always-on). Sub-agent-only items (`buy-stock`) keep a
  `subAgentOnly` flag. Parity test: for `user`, `dealer`, `sub_agent`,
  `admin` the visible set before == after.
- `pickFirstVisiblePath` uses the same rule.
- Sidebar receives the role's capabilities and theme from one new
  `GET /api/me/role` (role slug, name, badge, theme, capabilities). The
  existing localStorage role cache stays for first paint.
- Theme (Claude's call): `theme = { skin: 'default' | 'dealer' }` plus
  `badge_color` from a fixed palette (navy, purple, emerald, amber, rose,
  slate) and `icon` from a short lucide list. Admin skin never selectable.
  No free colour picker (navy is the brand accent). Dealer/User keep their
  current skin.

### 5.4 Hub UI (`app/admin/roles`)

Desktop multi-column at `lg:`, navy accent, admin nav group + NEW tag
(`lib/nav-new.ts`).
- **List:** badge, name, rank, members count, packages with own price
  (n/total), archived filter. Ladder: up/down buttons swap ranks (one RPC,
  audited). `user` fixed at bottom; off-ladder roles listed separately;
  `admin` shown read-only, never editable.
- **Create / Clone:** slug (immutable, `^[a-z][a-z0-9_]{1,19}$`, not a
  system slug), name, rank. Clone copies prices, custom rates, rights,
  theme. New (non-clone) role starts with Dealer's rights, no prices (falls
  down the ladder), default theme.
- **Basics:** name, description, rank. (`is_public`, `fallback_role_id`
  shown disabled — used in Phase 4.)
- **Prices:** grid of active packages filtered by network: public price,
  our cost, role price (editable), effective price (after ladder), margin
  vs cost. Bulk: "public price − x%", "copy from role ± GHS" (preview
  before save). Rules: blank = delete row (falls down ladder); ≤ 0 hard
  block; < cost_price → row flagged, save needs "I know this sells at a
  loss" tick, recorded `loss_override=true`; 2dp rounding. Dealer grid
  writes go through the same RPC; the mirror keeps `dealer_price` in sync.
  Our cost is edited on the existing `/admin/packages` page (new column)
  and shown read-only here.
- **Services:** airtime fee % per network, cashback share per
  service/group. **System roles (User/Dealer): read-only, showing today's
  values with a link to the existing settings pages** (Claude's call: no
  new write path into `admin_settings`). Custom roles: editable, blank =
  falls down the ladder, 0–100.
- **Rights:** grouped checklist from the registry; "copy from role".
  Dealer/User editable (so the owner can take a right off Dealer), with a
  confirm showing affected member count.
- **Theme:** skin + badge colour + icon, live preview of a sidebar header
  and badge.
- **Members:** search by name/email/phone within the role, paginated;
  select (or select all matching) → move to role (User, Dealer, custom;
  never admin or sub_agent) with required reason. Each user goes through
  `changeUserRole` (margins recomputed, `admin_audit_log` row); results
  reported per user (moved / skipped + reason). Chunked, ≤ 200 per
  request.
- **Audit:** paginated `role_audit_log` for the role plus that role's
  `user_role_change` rows from `admin_audit_log`.

### 5.5 API routes (`app/api/admin/roles/**`)

All `verifyAdminAccess`; bodies validated with pure `lib/roles/admin/*`
validators; writes via the 0187 RPCs; no secrets/PII in logs. Reads use
the service client and fail closed (500, nothing partial).

### 5.6 Flag flip and parity (end of phase)

1. Deploy hub + rights with flag still false; verify parity on prod
   (system roles' menus unchanged; price parity 0/N as in 0185).
2. Owner creates one real custom role in the hub (e.g. `super_dealer`
   rank 20, a few prices below dealer).
3. Flip `CUSTOM_ROLE_ASSIGNMENT_ENABLED = true`, deploy.
4. Move one test account into it; check web price, storefront base,
   USSD price, airtime fee and menu match the role; move it back and check
   the storefront price did not move.
The combined live-order check (deferred by the owner) runs after Phase 6.

### 5.7 Decisions from the builder check (Claude's calls unless marked)

1. **Every role price write is audited, whatever the writer.** An AFTER
   trigger on `role_package_prices` writes the `role_audit_log` row. The
   0187 RPCs set a transaction-local context (`set_config('app.role_audit',
   json{actor, reason, loss_override}, true)`) that the trigger reads; a
   write without it (the old `/admin/packages` dealer_price form via the
   mirror, any script) is still logged with `actor_id NULL`, action
   `price_external`. Non-price RPC writes (rights, rates, basics) audit
   inside the RPC.
2. **Which callers `requireCapability` applies to:** only routes driven by
   a signed-in dashboard session (cookie auth). API-key (v1/v2), USSD,
   WhatsApp/SMS bot, webhook, cron and public storefront routes are never
   checked (consistent with 5.2: rights don't stop sales to customers).
   The registry lists the session route files explicitly per capability;
   the guard test checks that every listed file calls `requireCapability`
   and that every session route under the registered folders is either
   listed or in an explicit `UNGATED` list with a one-line reason — a new
   route fails the build until classified. Sub-agents resolve through
   their hard-coded set; admin always passes.
3. **Read cost:** `can()` loads the caller's role + permission rows once
   per request; an in-process cache of the permission table with a 60 s
   TTL. Revoking a right takes effect within 60 s.
4. **Archive:** error "move its N members first" with a link to the
   Members tab; no auto-move. **Ranks:** custom roles may sit anywhere
   above `user` (rank > 0; below or above dealer). New ranks are spaced by
   10 (insert between → midpoint, renumber in one transaction if no gap).
   Up/down swaps two ranks in one transaction (deferred-safe: temporarily
   negative rank, then final).
5. **Cost:** NULL cost → no warning, margin column blank. In Phase 3 only
   the role Prices grid warns; other price surfaces unchanged. Below-cost
   compares the role's own entered price (not the inherited one). Cost is
   admin-only (packages page + hub), never in any customer/API response.
6. **Menu freshness:** the sidebar refetches `/api/me/role` on mount and
   on route change; localStorage only paints the first frame. A blocked
   page is refused by the server regardless. Archived role / read failure
   → always-on pages only.
7. **Members move outcomes:** moved, or skipped with reason (sub-agent
   rule, already in role, refused by `changeUserRole`, error). Pending
   orders do not block (prices are snapshotted on orders). Client chunks
   "select all matching" into requests of ≤ 200 and shows a running
   tally; each user is independent and re-running is safe (same-role =
   no-op).
8. **Skin follows data:** 0187 seeds `dealer.theme = {"skin":"dealer"}`,
   `user.theme = {"skin":"default"}`; sidebar reads `theme.skin`, admin
   skin stays decided by `isAdmin`. Parity test covers the four system
   roles.
9. **Flag rollback (from Phases 1–2):** the flag only gates *assigning* a
   custom role; every reader already prices custom roles. Flipping it back
   to false leaves existing custom members priced and menu'd by their
   role; only new assignments are refused, and moving them off stays
   allowed. Rollback step = revert the flag commit and deploy.

## 6. Constraints

TDD, logic in `lib/`; fresh reviewer per task; Opus final review; prod
change protocol for 0187 (precheck → self-rolling-back dry run → owner OK
→ apply → verify); `next build` with placeholder env before pushing main;
check local main for other sessions' commits; Edit/Write only (no sed);
chunk `.in()` lists; known pre-existing failures (12 tests, 2 tsc files)
ignored.

## 7. Left to the builder

Component structure, exact route shapes, pagination sizes, palette hex
values, icon list, audit row `action` names, test layout.
