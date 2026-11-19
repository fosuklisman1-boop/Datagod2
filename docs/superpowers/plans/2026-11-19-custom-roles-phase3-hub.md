# Custom Roles Phase 3 — `/admin/roles` hub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin hub to create, clone, rank, price, rate, theme, staff and archive roles, plus a rights system (hide + block) that replaces the hard-coded nav role lists, ending with custom roles switched on.

**Architecture:** One migration (0187) adds `role_permissions`, append-only `role_audit_log`, `packages.cost_price`, and definer write functions that lock the role, write and audit in one transaction (role price writes are audited by trigger, whoever writes). Pure validators and a capability registry live in `lib/roles/`; admin routes under `app/api/admin/roles/**` validate then call the functions; dashboard session routes call `requireCapability`; the sidebar reads rights and theme from `GET /api/user/role`.

**Tech Stack:** Next.js 15 App Router, Supabase (PostgREST + Postgres functions), Vitest, PGlite for SQL tests, Tailwind + shadcn/ui, lucide-react.

**Spec:** `docs/superpowers/specs/2026-11-19-custom-roles-phase3-hub-design.md` (parent: `docs/superpowers/specs/2026-11-18-custom-roles-design.md`).

## Global Constraints

- Branch `feat/custom-roles-hub` in worktree `.claude/worktrees/custom-roles-hub` (off origin/main 2a187ea9).
- TDD; logic in `lib/`; fake-client pattern for route tests (see `lib/roles/repo.test.ts`, `app/api/user/keys/route.test.ts`).
- Edit/Write tools only for code edits — **never sed/awk/perl on source files**.
- Fail closed on every money/rights read: a read error refuses (5xx), never falls back to "allow" or partial data.
- `admin` is never a target, never editable, never grantable from the hub. `sub_agent` rights/prices/rates are never editable.
- Slug regex `^[a-z][a-z0-9_]{1,19}$`, immutable; system slugs `user`, `dealer`, `sub_agent`, `admin`.
- Prices: 2dp; ≤ 0 after rounding is a hard block; below `cost_price` needs `loss_override=true`, recorded.
- Rates: 0–100, 2dp; only custom roles editable.
- Capability keys exactly: `buy.data`, `buy.airtime`, `buy.afa`, `buy.bills`, `buy.results`, `shop.storefront`, `shop.subagents`, `shop.bots`, `shop.sms`, `shop.text_orders`, `account.wallet`, `account.api`, `account.leaderboard`, `account.upgrade`.
- Rights never block API-key (v1/v2), USSD, WhatsApp/SMS bots, webhooks, crons or public storefront routes (owner: "keep selling").
- Permission cache TTL 60 s.
- Chunk every `.in()` list (≤ 500); members bulk move ≤ 200 users per request.
- No secrets or phone numbers in logs; audit rows store ids.
- Desktop: `lg:` multi-column; navy accent (`--primary`); new sidebar link gets a NEW tag in `lib/nav-new.ts`.
- `CUSTOM_ROLE_ASSIGNMENT_ENABLED` stays `false` until Task 12.
- Known pre-existing failures to ignore: 12 tests (order-health ×9, admin-users/migration, pricing/migration, standard-bundles getBuyerTier) and tsc errors in `app/api/admin/broadcast/route.shop-buyers.test.ts`, `lib/leaderboard/delivery.test.ts`.
- Local builds: `NODE_OPTIONS=--use-system-ca`.

## Review Focus

1. `verifyAdminAccess` CRON_SECRET bypass returns `isAdmin: true` with **no `userId`** → every hub write route must refuse (403) when `userId` is missing, since the audit needs an actor. (Test in Task 6.)
2. A user whose `users.role` is NULL must get User rights, not the empty set or "all". (Test in Task 3.)
3. Two admins editing one grid: a PUT must touch only the cells it lists, never rewrite the whole role. (Test in Task 7.)
4. A capability string in `role_permissions` that is not in the registry (removed later) is ignored, never a crash or an "allow". (Test in Task 3.)
5. A price like `0.004` rounds to `0.00` and must be blocked, not saved; `"12,5"` / `NaN` / `Infinity` / negative must be rejected. (Test in Task 5.)

---

### Task 1: Migration 0187 (tables, cost column, audit trigger, write functions)

**Files:**
- Create: `migrations/0187_roles_hub.sql`, `migrations/0187_roles_hub.selftest.sql`
- Create: `lib/roles/migration-0187-run.ts` (copy `lib/roles/migration-0186-run.ts`, change the `0186:` message prefixes to `0187:`)
- Test: `lib/roles/migration-0187.test.ts` (pattern of `lib/roles/migration-0186.test.ts` + PGlite run of 0184→0187)

**Interfaces:**
- Produces (SQL, all `SECURITY DEFINER`, `SET search_path = public, pg_temp`, EXECUTE revoked from PUBLIC/anon/authenticated, granted to service_role; every write function raises if `p_actor IS NULL` or `length(trim(p_reason)) < 3`, and locks the target `roles` row `FOR UPDATE`):
  - `admin_role_create(p_actor uuid, p_reason text, p_slug text, p_name text, p_rank int, p_clone_from uuid) RETURNS uuid` — refuses system slugs, `p_rank <= 0`, a rank in use by a live role; new role `theme = '{"skin":"default"}'`, permissions copied from `dealer`; with `p_clone_from`: copies description, badge_color, icon, theme, `role_package_prices`, `role_service_rates`, `role_permissions` from that role (refuses cloning `admin`/`sub_agent`). Audit action `create` or `clone`.
  - `admin_role_update(p_actor uuid, p_reason text, p_role_id uuid, p_patch jsonb) RETURNS void` — keys allowed: `name, description, badge_color, icon, theme`; other keys raise; refuses `admin`. Action `update`.
  - `admin_role_swap_rank(p_actor uuid, p_reason text, p_a uuid, p_b uuid) RETURNS void` — both live, ranked, neither `user`; swaps via a temporary rank (`-1`) in one transaction. Action `rank`.
  - `admin_role_archive(p_actor uuid, p_reason text, p_role_id uuid) RETURNS void` — refuses system roles and any role with `users.role = slug` (message `role has members`). Action `archive`.
  - `admin_role_set_prices(p_actor uuid, p_reason text, p_role_id uuid, p_changes jsonb, p_loss_override boolean) RETURNS int` — `p_changes` = `[{"package_id": uuid, "price": number|null}]`; null deletes the row; refuses price ≤ 0; refuses price < `packages.cost_price` unless `p_loss_override`; refuses `admin`/`sub_agent`/archived; sets `set_config('app.role_audit', json_build_object('actor',p_actor,'reason',p_reason,'loss_override',p_loss_override)::text, true)` before writing; returns rows changed. Touches only the listed packages.
  - `admin_role_set_rates(p_actor uuid, p_reason text, p_role_id uuid, p_changes jsonb) RETURNS int` — `[{"service_key": text, "value": number|null}]`; refuses system roles (`is_system`); null deletes. Action `rates`.
  - `admin_role_set_permissions(p_actor uuid, p_reason text, p_role_id uuid, p_caps text[]) RETURNS void` — replaces the set; refuses `admin`/`sub_agent`. Action `permissions`.
  - `admin_role_stats() RETURNS TABLE(role_id uuid, member_count bigint, priced_count bigint)` — `STABLE`, read-only.
- Tables: `role_permissions(role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE, capability text NOT NULL CHECK (capability ~ '^[a-z_]+(\.[a-z_]+)*$'), PRIMARY KEY (role_id, capability))`; `role_audit_log(id bigserial PK, actor_id uuid NULL, role_id uuid NOT NULL REFERENCES roles(id), action text NOT NULL, before jsonb, after jsonb, reason text, loss_override boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now())` + index `(role_id, created_at DESC)`; both RLS on, REVOKE ALL from PUBLIC/anon/authenticated, service_role CRUD on `role_permissions`, SELECT/INSERT only on `role_audit_log`.
- `ALTER TABLE packages ADD COLUMN IF NOT EXISTS cost_price numeric(10,2) NULL CHECK (cost_price IS NULL OR cost_price >= 0)`.
- Seeds: `user` and `dealer` get all 14 capabilities; `UPDATE roles SET theme = '{"skin":"dealer"}'` for dealer, `'{"skin":"default"}'` for user (only where theme = '{}').
- Triggers: `role_audit_log_append_only` BEFORE UPDATE OR DELETE raises; statement-level AFTER INSERT / UPDATE / DELETE triggers on `role_package_prices` with transition tables, one `role_audit_log` row per (statement, role_id) with `action = 'prices'` (context set) or `'price_external'` (context absent, `actor_id NULL`), `before`/`after` = `[{package_id, price}]`, `loss_override` from the context.

- [ ] **Step 1: Write the failing test** `lib/roles/migration-0187.test.ts`:
  - text: one transaction, `lock_timeout = '5s'`, one COMMIT; the run string from `buildRunString` ends `RAISE EXCEPTION 'SELFTEST_OK 0187…'`.
  - PGlite (apply 0184, 0185, 0186 then 0187 with the minimal `users`/`packages` stubs the 0186 test uses):
    - `it("seeds user and dealer with the 14 capability keys")` (inline the Global Constraints list; Task 2 asserts equality with the registry).
    - `it("set_prices with context writes one 'prices' audit row with actor, reason, before/after")`
    - `it("a direct UPDATE packages SET dealer_price writes a 'price_external' row with NULL actor")`
    - `it("set_prices refuses 0, refuses below cost without override, accepts with override and records loss_override")`
    - `it("set_prices only touches listed packages")`
    - `it("archive refuses a role with members and every system role")`
    - `it("create refuses 'admin', 'dealer', rank 0, a used rank; clone copies prices, rates, permissions, theme")`
    - `it("swap_rank swaps two custom roles and refuses 'user'")`
    - `it("role_audit_log rejects UPDATE and DELETE")`
    - `it("every write function refuses a NULL actor and a reason shorter than 3")`
    - `it("anon and authenticated cannot EXECUTE any admin_role_* function or SELECT the new tables")`
- [ ] **Step 2:** `npx vitest run lib/roles/migration-0187.test.ts` → FAIL (file missing).
- [ ] **Step 3:** Write `migrations/0187_roles_hub.sql` (header = runbook prechecks: role census, `role_package_prices` count, `role_permissions`/`role_audit_log` absent, quiet window) and the selftest DO block (asserts seeds, grants, one audited round trip, ends `RAISE EXCEPTION 'SELFTEST_OK 0187'`).
- [ ] **Step 4:** Run the test → PASS.
- [ ] **Step 5:** Commit `feat(roles): migration 0187 roles hub tables, audit and write functions`.

### Task 2: Capability registry, rights rules, nav data on capabilities

**Files:**
- Create: `lib/roles/capabilities.ts`, test `lib/roles/capabilities.test.ts`
- Modify: `lib/dashboard-nav-items.ts` (replace `roles: string[]` on `NavItem` with `cap?: Capability; subAgent?: boolean; subAgentOnly?: boolean`; `pickFirstVisiblePath` takes `rights`)
- Test: `lib/dashboard-nav-items.test.ts` (extend)

**Interfaces:**
- Produces:
  - `type Capability` (the 14 keys), `CAPABILITY_GROUPS: readonly { id: "buy" | "shop" | "account"; label: string }[]`, `CAPABILITIES: readonly { key: Capability; group: "buy" | "shop" | "account"; label: string; hint?: string }[]` (hint on `account.wallet`: "Most purchases are paid from the wallet."), `ALL_CAPABILITIES: readonly Capability[]`, `isCapability(x: unknown): x is Capability`.
  - `type RoleRights = { kind: "all" } | { kind: "sub_agent" } | { kind: "set"; caps: ReadonlySet<Capability> }`
  - `rightsFor(slug: string | null, roles: readonly RoleRow[], perms: ReadonlyMap<string /* role id */, ReadonlySet<Capability>>): RoleRights` — null slug → `"user"`; `admin` → all; `sub_agent` → sub_agent; unknown/archived → `{ kind: "set", caps: empty }`.
  - `canWith(rights: RoleRights, cap: Capability): boolean` — all → true; sub_agent → true (server never newly blocks sub-agents); set → has.
  - `navVisible(item: NavItem, slug: string, rights: RoleRights): boolean` — `subAgentOnly` → slug === "sub_agent"; slug === "sub_agent" → `item.subAgent === true`; all → true; no `cap` → true; else `rights.caps.has(item.cap)`.
  - `pickFirstVisiblePath(slug: string | null, rights: RoleRights, services, hiddenPages, dealerHasSubscription)`.
- Nav mapping (href → cap; `S` = `subAgent: true`): `/dashboard` none · data-packages `buy.data` · standard-bundles `buy.data` S · airtime `buy.airtime` · bills, broadband `buy.bills` S · results-checker, results-check `buy.results` S · my-orders `account.wallet` · afa-orders `buy.afa` · wallet `account.wallet` S · transactions `account.wallet` · top-performers `account.leaderboard` S · profile none S · developer `account.api` S · complaints none · upgrade `account.upgrade` · shop: my-shop, shop-orders, customers, blocked-numbers, shop-profit-logs, shop-pricing, shop-withdraw, shop-profile, payment-reverify `shop.storefront` S · text-orders `shop.text_orders` S · sms `shop.sms` S · ussd-shop `shop.bots` S · sub-agents, sub-agent-catalog `shop.subagents` · buy-stock `subAgentOnly`. (The parity test is the authority: if a current `roles` array disagrees with this list, match the array.)

- [ ] **Step 1: Failing tests:**
  - `it("nav parity: for user, dealer, sub_agent and admin the visible hrefs equal the pre-change roles arrays")` — frozen fixture `LEGACY_NAV_ROLES: Record<string, string[]>` copied from today's arrays; `user`/`dealer` rights = `{ kind: "set", caps: new Set(ALL_CAPABILITIES) }`.
  - `it("a custom role with all capabilities sees exactly what dealer sees")`; `it("a custom role with none sees only /dashboard, /dashboard/profile, /dashboard/complaints")`.
  - `it("rightsFor: null slug is user; archived and unknown roles get the empty set; admin all; sub_agent sub_agent")`.
  - `it("ALL_CAPABILITIES equals the 0187 seed list")` — parse the capability literals of the `role_permissions` seed in `migrations/0187_roles_hub.sql`.
- [ ] **Step 2:** `npx vitest run lib/roles/capabilities.test.ts lib/dashboard-nav-items.test.ts` → FAIL.
- [ ] **Step 3:** Implement; touch `components/layout/sidebar.tsx` only enough to compile (pass all-capabilities rights for user/dealer, `{kind:"all"}` for admin, `{kind:"sub_agent"}` for sub_agent until Task 3).
- [ ] **Step 4:** Tests PASS; `npx tsc --noEmit` shows no new errors.
- [ ] **Step 5:** Commit `feat(roles): capability registry and nav visibility by capability`.

### Task 3: Rights reads, `requireCapability`, `GET /api/user/role`, sidebar + bottom nav

**Files:**
- Create: `lib/roles/permissions-repo.ts` (+ test), `lib/roles/require-capability.ts` (+ test), `app/api/user/role/route.ts` (+ `route.test.ts`)
- Modify: `components/layout/sidebar.tsx` (skin ~119, role load ~140–175, filters ~300–318, dealer badge ~501), `components/layout/bottom-nav.tsx:155`

**Interfaces:**
- Consumes: Task 2 `RoleRights`, `rightsFor`, `canWith`, `navVisible`, `isCapability`; `loadRoles`, `RoleReadError`, `ROW_CAP` from `lib/roles/repo.ts`.
- Produces:
  - `loadRolePermissions(client): Promise<Map<string, Set<Capability>>>` — throws `RoleReadError`; drops strings failing `isCapability`; rejects a full page (`>= ROW_CAP`).
  - `rightsForUser(client, userId: string): Promise<{ slug: string; rights: RoleRights }>` — reads `users.role` (NULL → `"user"`); roles + permissions through a module cache with 60 s TTL; `__resetRightsCache(): void` for tests.
  - `requireCapability(client, userId: string, cap: Capability): Promise<NextResponse | null>` — `null` = allowed; denied → 403 `{ error: "This feature isn't available for your account." }`; read error → 503 `{ error: "Couldn't check your access. Please try again." }`.
  - `GET /api/user/role` (Bearer session like `app/api/user/keys/route.ts`) → `{ slug, name, badge_color, icon, theme: { skin: "default" | "dealer" }, rights: "all" | "sub_agent" | Capability[] }`; 401 no session; 503 read error. (Design said `/api/me/role`; `app/api/user/*` is the existing home for "me" routes.)
- Sidebar: fetch `/api/user/role` on mount and on pathname change; localStorage role only for first paint; skin = admin when `isAdmin`, else `theme.skin`; on 503 show only items with no `cap`; on a `/dashboard/*` path whose nav item exists but is not visible, `router.replace("/dashboard/unavailable")`. Bottom nav skin uses the same `theme.skin`.

- [ ] **Step 1: Failing tests:** `it("NULL users.role gets user rights")` (Review Focus 2); `it("unknown capability strings are ignored")` (Review Focus 4); `it("a read error rejects; requireCapability returns 503, never null")`; `it("cache: a second call within 60s does not read; after 60s it reads")` (fake timers); `it("sub_agent and admin are always allowed")`; route: 401 without token, 200 shape for dealer (`theme.skin` "dealer"), 503 on read error.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(roles): rights reads, requireCapability and role-driven sidebar`.

### Task 4: Gate dashboard session routes + guard test

**Files:**
- Create: `lib/roles/capability-routes.ts`, `lib/roles/capability-routes.guard.test.ts`
- Modify: each route file in `GATED_ROUTES` (one `requireCapability` call right after the session user is known, before any write)

**Interfaces:**
- Consumes: Task 3 `requireCapability`.
- Produces: `GATED_ROUTES: Readonly<Record<string, Capability>>` and `UNGATED_SESSION_ROUTES: Readonly<Record<string, string /* reason */>>`, keys = route dir relative to `app/api` (e.g. `"orders/purchase"`).
- Gated (starting map; the implementer opens each file to confirm it is a member-facing session action):
  - `buy.data`: orders/purchase, orders/create-bulk, standard-bundles/buy
  - `buy.airtime`: airtime/purchase · `buy.afa`: afa/submit · `buy.bills`: bills/pay, bills/verify, bills/saved
  - `buy.results`: results-checker/purchase, results-check/initialize, results-checker/my-orders/[id]/resend
  - `shop.storefront`: shop/create, shop/delete, shop/manage, shop/logo, shop/settings/[shopId], shop/open-after-pricing, shop/payment-reverify, dashboard/shops/[id]/rotate-slug
  - `shop.subagents`: shop/invites, shop/sub-agent-catalog, shop/sub-agent-requests, shop/sub-agent-requests/[id], shop/sub-agents/[id]
  - `shop.bots`: dashboard/ussd-shop/activate, dashboard/ussd-shop/display-name, dashboard/ussd-shop/whatsapp-activate
  - `shop.sms`: sms/activate, sms/sender-ids, sms/templates, sms/templates/[id], sms/units/purchase, sms/units/purchase-paystack, sms/units/purchase-wallet, sms/claim-bonus, shop/sms/send
  - `account.wallet`: wallet/create, wallet/debit, wallet/momo-claim, wallet/momo-sessions
  - `account.api`: user/keys, user/v2-keys
- Ungated with a recorded reason: read-only list/stats routes ("read-only"), auth/*, user/me, user/role, user/nav-new, user/update-profile, user/update-phone, user/verify-phone, user/complete-onboarding, user/notify-self, push/register, notifications/cleanup, review-prompt, ai/chat ("support chat"), shop/orders/create and shop/join/[handle] ("customer/sub-agent facing — keep selling"), shop/airtime/constraints, payments/initialize, user/withdrawals/*, leaderboard*, subscriptions/current, verify-phone-live, debug/shop. The implementer reads each file and records its real reason; any route that writes on the member's behalf and fits a capability moves to `GATED_ROUTES`.
- Guard rule: walk `app/api/**/route.ts` excluding `admin/`, `v1/`, `v2/`, `cron/`, `webhook/`, `webhooks/`, `public/`; a file containing `auth.getUser(` or `authenticate(request` must appear in exactly one map; each gated file must contain `requireCapability(` and the string literal of its capability; every map key must exist on disk.

- [ ] **Step 1: Failing test** `capability-routes.guard.test.ts` with the rule above.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Fill both maps; add the call to every gated route (use the route's existing service client; return the response when non-null). Extend one existing route test per capability group (e.g. `orders/purchase`) with `it("403 when the role lacks buy.data, before any write")`.
- [ ] **Step 4:** Guard + touched route tests PASS; full `npx vitest run` shows only the known failures.
- [ ] **Step 5:** Commit `feat(roles): enforce role rights on dashboard session routes`.

### Task 5: Pure hub validators and bulk price operations

**Files:** Create `lib/roles/admin/validate.ts`, `lib/roles/admin/bulk-prices.ts`, tests beside them.

**Interfaces:**
- Produces:
  - `type Result<T> = { ok: true; value: T } | { ok: false; error: string }`
  - `validateNewRole(input: unknown, existing: readonly RoleRow[]): Result<{ slug: string; name: string; rank: number; cloneFrom: string | null; reason: string }>`
  - `validateRolePatch(input: unknown): Result<{ name?: string; description?: string | null; badge_color?: BadgeColor; icon?: RoleIcon; theme?: { skin: "default" | "dealer" } }>`
  - `BADGE_COLORS = ["navy","purple","emerald","amber","rose","slate"] as const`, `type BadgeColor`; `ROLE_ICONS = ["Crown","Star","Gem","Rocket","Shield","Zap","Award","Briefcase"] as const`, `type RoleIcon`
  - `validatePriceChanges(input: unknown, costs: ReadonlyMap<string, number | null>): Result<{ changes: { package_id: string; price: number | null }[]; belowCost: string[] }>` — ≤ 1000 changes, unique ids, JSON numbers only, round2, ≤ 0 after rounding → error.
  - `validateRateChanges(input: unknown, allowedKeys: ReadonlySet<string>): Result<{ service_key: string; value: number | null }[]>` — 0–100, round2.
  - `validateCapabilities(input: unknown): Result<Capability[]>` — dedup; every item `isCapability`.
  - `validateReason(input: unknown): Result<string>` — trimmed, 3–300 chars.
  - `validateMove(input: unknown, roles: readonly RoleRow[]): Result<{ userIds: string[]; toRole: string; reason: string }>` — 1–200 uuids; target live and not `admin`/`sub_agent`.
  - `HUB_SERVICE_KEYS: readonly { key: string; label: string }[]` = `airtime_fee:mtn`, `airtime_fee:telecel`, `airtime_fee:at`, `cashback_share:airtime`, `cashback_share:bundles`, `cashback_share:bills`.
  - `bulkFromPublic(pkgs: readonly { id: string; price: number }[], percentOff: number): { changes: { package_id: string; price: number }[]; skipped: string[] }` and `bulkFromRole(source: ReadonlyMap<string, number>, deltaGhs: number): { changes; skipped }` — round2; results ≤ 0 go to `skipped`.

- [ ] **Step 1: Failing tests** incl. Review Focus 5: `0.004` → error; `"12,5"`, `NaN`, `Infinity`, `-1` → error; slugs `Admin`, `dealer`, `a`, 21 chars → error; move to `admin`/`sub_agent`/archived → error; 201 ids → error; `bulkFromPublic([{ id, price: 10 }], 15).changes[0].price === 8.5`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(roles): hub validators and bulk price operations`.

### Task 6: Hub API — roles list, create/clone, update, rank, archive, audit

**Files:** Create `app/api/admin/roles/route.ts` (GET, POST), `app/api/admin/roles/[id]/route.ts` (PATCH), `app/api/admin/roles/[id]/move/route.ts` (POST), `app/api/admin/roles/[id]/archive/route.ts` (POST), `app/api/admin/roles/[id]/audit/route.ts` (GET), `lib/roles/admin/route-helpers.ts`; tests beside each.

**Interfaces:**
- Consumes: Task 5 validators; 0187 functions; `loadRoles`.
- Produces:
  - `requireHubAdmin(request: NextRequest): Promise<{ adminId: string; db: SupabaseClient } | { response: NextResponse }>` — wraps `verifyAdminAccess`; 403 `{ error: "Admin user required" }` when `userId` is missing.
  - `GET /api/admin/roles` → `{ roles: { id, slug, name, description, badge_color, icon, rank, is_system, archived_at, theme, member_count, priced_count }[], package_total }`.
  - `POST /api/admin/roles` `{ slug, name, rank, clone_from?, reason }` → `201 { id }`.
  - `PATCH /api/admin/roles/[id]` `{ name?, description?, badge_color?, icon?, theme? }` → `{ ok: true }` (reason passed as `"basics edit"`).
  - `POST /api/admin/roles/[id]/move` `{ direction: "up" | "down", reason }` → swaps with the nearest live ranked neighbour (never `user`); 409 at the end of the ladder.
  - `POST /api/admin/roles/[id]/archive` `{ reason }` → 409 `{ error: "Move its N members first." }` when members exist.
  - `GET /api/admin/roles/[id]/audit?page=` → `{ entries: { at, actor_id, actor_email, action, summary, reason, loss_override }[], page, has_more }` merging `role_audit_log` and `admin_audit_log` `user_role_change` rows whose old or new role is this slug; 50 per page, newest first.
- Function errors map to 400 (validation text), 409 (members / rank in use), 500 otherwise (no detail leaked).

- [ ] **Step 1: Failing tests:** every route 401/403 for non-admin; **403 when the CRON bypass gives no userId** (Review Focus 1); create refuses `admin`; archive 409 with members; move at ladder end 409; audit merges both sources newest first.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(roles): admin roles API (list, create, clone, rank, archive, audit)`.

### Task 7: Hub API — prices, service rates, permissions

**Files:** Create `app/api/admin/roles/[id]/prices/route.ts`, `.../rates/route.ts`, `.../permissions/route.ts` (GET + PUT each); tests beside them.

**Interfaces:**
- Consumes: Task 5 validators; Task 6 `requireHubAdmin`; `rolePricesFor` (`lib/roles/repo.ts`) for effective prices; `airtimeFeeRateFor` (`lib/airtime-pricing.ts`) and `resolveBuyerShares` (`lib/cashback/buyer-share.ts`) for effective rates; 0187 functions.
- Produces:
  - `GET prices` → `{ editable, packages: { id, network, name, price, cost_price, role_price, effective_price, is_available }[] }` (`editable` false for admin/sub_agent).
  - `PUT prices` `{ changes, loss_override, reason }` → `{ changed }`; 409 `{ error, below_cost: string[] }` when below cost without override.
  - `GET rates` → `{ editable, rates: { service_key, label, value, effective }[] }` (`editable` false for system roles; `value` null when no row).
  - `PUT rates` `{ changes, reason }` → `{ changed }`; 403 for system roles.
  - `GET permissions` → `{ editable, capabilities: Capability[], member_count }`; `PUT permissions` `{ capabilities, reason }` → `{ ok: true }`; 403 for admin/sub_agent.

- [ ] **Step 1: Failing tests:** PUT prices passes exactly the listed cells to the function (Review Focus 3); below cost without override → 409 with ids; with override → `p_loss_override: true`; PUT rates on dealer → 403; GET rates for dealer shows `effective` = today's settings value; PUT permissions with an unknown capability → 400; any read error → 500 with nothing partial.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(roles): admin roles prices, rates and rights API`.

### Task 8: Hub API — members search and bulk move

**Files:** Create `app/api/admin/roles/[id]/members/route.ts` (GET), `app/api/admin/roles/members/move/route.ts` (POST); modify `lib/admin-users/account-ops.ts` (`changeUserRole` opts gain `reason?: string`, written into the audit row's `new_value.reason`); tests beside them.

**Interfaces:**
- Consumes: `changeUserRole(db, { userId, role, adminId, reason })`, Task 5 `validateMove`, Task 6 `requireHubAdmin`.
- Produces:
  - `GET members?q=&page=` → `{ members: { id, name, email, phone }[], total, page }`, 50 per page, `q` matched `ilike` on name/email/phone with `%`/`_` escaped.
  - `POST move` `{ user_ids, to_role, reason }` → `{ results: { user_id, status: "moved" | "skipped" | "error", reason?: string, note?: string }[] }` in input order; users processed sequentially; `changed: false` → skipped "already in role"; `ok: false` → skipped with its `error`; a thrown error → `error` for that user only; `note` (margin clamp) passed through.

- [ ] **Step 1: Failing tests:** target `admin` → 400 before any user is processed; 201 ids → 400; mixed batch returns per-user outcomes in input order; one throwing user does not stop the rest; reason reaches the audit row.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(roles): role members search and bulk move`.

### Task 9: "Our cost" on the packages admin page

**Files:** Modify `app/api/admin/packages/route.ts` (accept `cost_price` on create/update: number ≥ 0 rounded to 2dp, or null/"" → null), `app/admin/packages/page.tsx` (form field "Our cost (GHS)", table column); tests in `app/api/admin/packages/route.test.ts` (create if missing).

- [ ] **Step 1: Failing tests:** `cost_price: -1` → 400; `""` → stored null; `4.555` → 4.56; `app/api/shop/public-packages` and `app/api/user/package-prices` select lists exclude `cost_price`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(packages): admin-only our cost field`.

### Task 10: Hub UI — list, ladder, create/clone, Basics, Theme, Audit

**Files:** Create `app/admin/roles/page.tsx`, `app/admin/roles/[id]/page.tsx`, `app/admin/roles/_lib/api.ts` (`adminFetch` like `app/admin/gateway/_lib/api.ts`), `app/admin/roles/_components/{RoleList,CreateRoleDialog,BasicsTab,ThemeTab,AuditTab,RoleBadge}.tsx`; modify `lib/dashboard-nav-items.ts` (`{ href: "/admin/roles", label: "Roles & Tiers", icon: ShieldCheck, group: "admin-money" }` before "Dealer Plans") and `lib/nav-new.ts` (`"/admin/roles": { since: "2026-11-19" }`).

**Interfaces:** Consumes Task 6 routes, Task 5 `validateNewRole`, `BADGE_COLORS`, `ROLE_ICONS`. Produces `RoleBadge({ name, color, icon })` for Task 11.
- Pages use `DashboardLayout`, `PageHeaderBanner`, `useAdminProtected` (pattern `app/admin/gateway/page.tsx`). List: two columns at `lg:` (ladder card left; off-ladder + archived right); up/down disabled at the ends and for `user`/`admin`; admin row read-only, no editor link. Editor tabs: Basics · Prices · Services · Rights · Theme · Members · Audit (Task 11 fills Prices/Services/Rights/Members). Theme tab: skin radio, badge colour swatches, icon picker, live preview of sidebar header + badge.

- [ ] **Step 1:** Render tests (`@testing-library/react`, as in existing admin component tests): admin row has no edit link; `user` has no up/down; the create dialog rejects slug `Admin` via `validateNewRole`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `npx tsc --noEmit` no new errors.
- [ ] **Step 5:** Commit `feat(roles): roles hub list, ladder and basic editor tabs`.

### Task 11: Hub UI — Prices, Services, Rights, Members tabs

**Files:** Create `app/admin/roles/_components/{PricesTab,ServicesTab,RightsTab,MembersTab,SaveBar}.tsx`.

**Interfaces:** Consumes Task 7/8 routes, Task 5 `bulkFromPublic`, `bulkFromRole`, `validatePriceChanges`, `HUB_SERVICE_KEYS`, Task 2 `CAPABILITIES`, `CAPABILITY_GROUPS`.
- Prices: network filter; columns public / our cost / role price (input) / effective / margin vs cost; dirty cells highlighted; bulk "public − x%" and "copy from role ± GHS" fill a dirty preview; below-cost rows red and Save needs the "I know this sells at a loss" box; PUT sends dirty cells only.
- Services: six rows from `HUB_SERVICE_KEYS`; system roles read-only with links to `/admin/airtime/settings` and the cashback settings page.
- Rights: grouped checkboxes with hints, "copy from role"; save confirm shows `member_count`.
- Members: search, paging, select page / select all matching (client collects ids page by page, POSTs in chunks of 200 with a running tally); target select = User, Dealer, live custom roles; reason required; results table.
- SaveBar: reason (required ≥ 3 for prices/rates/rights/moves), Save/Discard, unsaved-changes guard on tab switch.

- [ ] **Step 1:** Render tests: PricesTab PUT body holds only edited cells; Save disabled while a below-cost row is dirty and the loss box is unticked; MembersTab target list excludes admin and sub_agent; ServicesTab read-only for dealer.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(roles): roles hub prices, services, rights and members tabs`.

### Task 12: Release (controller-run, owner-gated — not a subagent task)

- [ ] **Step 1:** Opus final review of the whole branch; fix findings test-first.
- [ ] **Step 2:** 0187 prod precheck (runbook header); build the self-rolling-back run string with `buildRunString`; run it on prod via the Management API → expect `SELFTEST_OK 0187`, nothing committed. **Ask owner OK.** Apply 0187; verify tables, seeds (2 × 14 capability rows), grants, EXECUTE revoked, triggers present, `role_audit_log` empty.
- [ ] **Step 3:** `next build` with placeholder env; check local/remote main for other sessions' commits; merge to main; push; Vercel READY; smoke (`/api/admin/roles` and `/api/user/role` 401 unauthenticated, home 200).
- [ ] **Step 4:** Parity on prod: user/dealer each hold 14 permission rows; menus for user/dealer/sub_agent/admin unchanged; price parity 0/N as in 0185.
- [ ] **Step 5:** Owner creates `super_dealer` (rank 20, a few prices below dealer) in the hub. Flip `CUSTOM_ROLE_ASSIGNMENT_ENABLED = true` (one commit, test updated), build, push, READY.
- [ ] **Step 6:** Move one test account into `super_dealer`; verify from data and UI: web price = role price, storefront base = role price with selling price unchanged, USSD price, airtime fee, menu and skin; move it back and confirm the storefront selling price did not move. Rollback = revert the flag commit.
- [ ] **Step 7:** Update memory (`project-custom-roles.md`); channel announcement draft (Post now / Hold).
