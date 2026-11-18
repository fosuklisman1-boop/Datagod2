# Custom Roles — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `roles` table, per-role package prices with a two-way `packages.dealer_price` mirror, a ladder-aware price resolver, and a `changeUserRole` that accepts custom roles — with **zero visible change** for existing users, dealers, shops and the mobile app.

**Architecture:** One additive migration (0184) adds `roles` (seeded with user/dealer/sub_agent/admin) and `role_package_prices`, backfills dealer rows from `packages.dealer_price`, and keeps both in sync with recursion-guarded triggers. A pure resolver in `lib/roles/` walks the rank ladder down to the public price; a thin repo layer loads roles/prices (chunked, fail-closed). `changeUserRole` keeps today's dealer paths byte-identical and adds a "recompute" margin strategy only for transitions that involve a custom role. No caller of the resolver yet — Phase 2 migrates readers.

**Tech Stack:** Next.js 15, Supabase Postgres, TypeScript, Vitest 4, PGlite (`@electric-sql/pglite`, optional — tests skip without it).

**Spec:** `docs/superpowers/specs/2026-11-18-custom-roles-design.md` (§5.1–5.4, §6 phase 1, §6a)

**Deferred from spec §5.1 (each lands with the phase that first reads it, YAGNI):** `role_service_rates` + its `_dealer` settings mirror (Phase 2, with the airtime/cashback/bills readers), `role_permissions` + `role_audit_log` (Phase 3, admin hub), `subscription_plans.role_id` (Phase 4), `role_price_schedules` + `role_promotion_rules` (Phase 5). Admin role memberships keep using `admin_audit_log` `user_role_change` (the legacy reversal reads it).

## Global Constraints

- Migration file: `migrations/0184_roles_foundation.sql` + `migrations/0184_roles_foundation.selftest.sql`; one `BEGIN;` … one `COMMIT;`, `SET LOCAL lock_timeout = '5s';`, `SET LOCAL statement_timeout = '60s';`, idempotent, header lists PRE-CHECKS. **Not applied by the implementing agent** (prod change protocol: precheck → self-rolling-back dry run → owner OK → apply → verify).
- Dry-run string built by code (`buildRunString`, copy the 0182/0183 pattern) — never by hand (0130 incident).
- New tables: RLS on, zero policies, `REVOKE ALL … FROM PUBLIC, anon, authenticated`, grants to `service_role` only.
- Price rule parity: dealer price used only when `> 0`; NULL/0 ⇔ no dealer row (spec §6a).
- Fallback (owner decision): blank role price → next lower-ranked non-archived role → … → `packages.price`.
- `sub_agent` and `admin` are off-ladder (`rank` NULL). `admin` stays assignable through update-role exactly as today; no custom role carries admin power (custom roles are `is_system = false` and nothing in this phase reads permissions).
- Margin rule for custom-role transitions (owner decision): keep the storefront selling price, shrink/grow the margin; clamp at 0.
- Reads that feed a price throw (`RoleReadError`) on any DB error — never fall back to a cheaper or default price.
- Chunk every `.in()` list at 500 ids.
- Code edits with Edit/Write only — no `sed`. No PII in logs (ids only).

## Review Focus

1. **Unknown / NULL / archived role slug** → resolver returns the public `packages.price` (never a cheaper tier). Test in Task 2.
2. **Admin clears dealer price in the old packages form (sets 0 or NULL)** → dealer row deleted, dealer pays public price, identical to `rolePrice(pkg, true)`. Test in Task 1 selftest + Task 2 parity.
3. **Trigger ping-pong** — writing either side once yields exactly one consistent row and no recursion error. Test in Task 1 selftest.
4. **More than 500 package ids** → loader returns every price (the "2000+ silently no-op'd" trap). Test in Task 3.
5. **Custom-role downgrade where margin would go negative** → margin clamps to 0, result `note` says how many packages clamped; concurrent identical change adjusts once (existing conditional write). Test in Task 4.

---

### Task 1: Migration 0184 — roles, role_package_prices, mirror, FK

**Files:**
- Create: `migrations/0184_roles_foundation.sql`
- Create: `migrations/0184_roles_foundation.selftest.sql`
- Create: `lib/roles/migration-0184-run.ts` (copy of `lib/blocked-numbers/migration-0182-run.ts` with `0184` labels)
- Test: `lib/roles/migration-0184.test.ts`

**Interfaces:**
- Produces (DB):
  - `public.roles(id uuid PK default gen_random_uuid(), slug text UNIQUE NOT NULL CHECK (slug ~ '^[a-z][a-z0-9_]{1,31}$'), name text NOT NULL, description text, badge_color text, icon text, rank int NULL, is_system bool NOT NULL default false, is_public bool NOT NULL default false, fallback_role_id uuid NULL REFERENCES roles(id), theme jsonb NOT NULL default '{}', limits jsonb NOT NULL default '{}', archived_at timestamptz, created_at, updated_at)`; partial unique index on `rank WHERE rank IS NOT NULL AND archived_at IS NULL`.
  - Seed (ON CONFLICT (slug) DO NOTHING): `user` rank 0, `dealer` rank 10, `sub_agent` rank NULL, `admin` rank NULL — all `is_system = true`; dealer `is_public = true`, `fallback_role_id` = user.
  - Trigger `roles_protect_system`: BEFORE UPDATE/DELETE — refuses DELETE of a system row, refuses changing `slug`, `is_system` or setting `archived_at` on a system row.
  - `public.role_package_prices(role_id uuid REFERENCES roles(id) ON DELETE CASCADE, package_id uuid REFERENCES packages(id) ON DELETE CASCADE, price numeric(10,2) NOT NULL CHECK (price > 0), updated_at timestamptz default now(), PRIMARY KEY (role_id, package_id))`.
  - Backfill: one dealer row per package with `dealer_price > 0`.
  - Mirror triggers, both guarded by `IF pg_trigger_depth() > 1 THEN RETURN …`:
    - `packages_dealer_price_mirror` AFTER INSERT OR UPDATE OF dealer_price ON packages: `> 0` → upsert dealer row; NULL/≤0 → delete dealer row.
    - `role_package_prices_dealer_mirror` AFTER INSERT/UPDATE/DELETE ON role_package_prices, only when the row's role is `dealer`: write `packages.dealer_price` = new price, or NULL on delete.
  - `ALTER TABLE users ADD CONSTRAINT users_role_fk FOREIGN KEY (role) REFERENCES roles(slug) NOT VALID;` then `VALIDATE CONSTRAINT`. (NULL role stays allowed.)
- PRE-CHECKS in header: `SELECT to_regclass('public.roles')` → NULL; `SELECT DISTINCT role FROM users` → subset of {user, dealer, sub_agent, admin, NULL}; `SELECT count(*) FROM packages WHERE dealer_price > 0` → record N for the verify step.

- [ ] **Step 1: Write the failing test** `lib/roles/migration-0184.test.ts`, mirroring `lib/blocked-numbers/migration-0182.test.ts`:
  - text tests: one transaction, both SET LOCALs, exactly one COMMIT; run string has no COMMIT / bare `END;` and ends raising `SELFTEST_OK 0184`.
  - PGlite (skipIf no PGlite): before the run string create stubs `CREATE TABLE public.packages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), price numeric NOT NULL, dealer_price numeric); CREATE TABLE public.users(id uuid PRIMARY KEY, role text);` seeded with 3 packages (dealer_price 4.50, 0, NULL) and users with roles user/dealer/NULL. Assert the run string rejects with `/^SELFTEST_OK 0184/` and afterwards `to_regclass('public.roles')` is NULL (rolled back).
  - PGlite: migration applied for real (no selftest) is idempotent — running it twice succeeds and `SELECT count(*) FROM roles` = 4.
- [ ] **Step 2: Run** `npx vitest run lib/roles/migration-0184.test.ts` — Expected: FAIL (file not found).
- [ ] **Step 3: Write the migration** per Interfaces above.
- [ ] **Step 4: Write the selftest** DO block (`$selftest$`, ends `RAISE EXCEPTION 'SELFTEST_OK 0184 …'`) asserting, each with a distinct `FAIL <name>`:
  - 4 seeded roles, ranks user 0 / dealer 10, sub_agent + admin NULL;
  - dealer rows = count of packages with dealer_price > 0;
  - `UPDATE packages SET dealer_price = 3.90` on a package → one dealer row at 3.90;
  - `UPDATE packages SET dealer_price = 0` → dealer row gone; set NULL → still gone;
  - `INSERT` into role_package_prices for dealer → `packages.dealer_price` equals it; `DELETE` it → `dealer_price` NULL;
  - a price row for a **non-dealer** role leaves `packages.dealer_price` untouched;
  - `price = 0` insert fails (check constraint) — catch inside a nested BEGIN/EXCEPTION;
  - `DELETE FROM roles WHERE slug = 'dealer'` fails; `UPDATE roles SET slug='x' WHERE slug='user'` fails;
  - `UPDATE users SET role = 'nope'` fails (FK);
  - RLS on both tables, zero policies, anon/authenticated no privilege on either.
- [ ] **Step 5: Run** `npx vitest run lib/roles/migration-0184.test.ts` — Expected: PASS (PGlite tests run if `@electric-sql/pglite` is installed; otherwise they show as skipped — install it in the scratchpad per `reference-pglite-sql-tests` and run once to see them pass).
- [ ] **Step 6: Commit** `git add migrations/0184_* lib/roles/migration-0184*` — `feat(roles): 0184 roles foundation migration (not applied)`

---

### Task 2: Pure ladder resolver

**Files:**
- Create: `lib/roles/ladder.ts`
- Test: `lib/roles/ladder.test.ts`

**Interfaces:**
- Consumes: `PricedPackage`, `rolePrice` from `lib/pricing/package-price.ts`.
- Produces:
  ```ts
  export type RoleRow = { id: string; slug: string; rank: number | null; is_system: boolean; archived_at: string | null }
  /** roleId -> (packageId -> price). Only prices > 0 are ever stored. */
  export type RolePriceMap = ReadonlyMap<string, ReadonlyMap<string, number>>
  /** The roles whose prices apply to `slug`, most specific first: the role itself, then lower-ranked non-archived roles by rank desc. Off-ladder role → [itself]. Unknown/archived slug → []. */
  export function priceLadder(roles: readonly RoleRow[], slug: string | null | undefined): RoleRow[]
  /** First price found walking priceLadder(slug); else Number(pkg.price). */
  export function resolveRolePrice(pkg: PricedPackage, slug: string | null | undefined, roles: readonly RoleRow[], prices: RolePriceMap): number
  ```

- [ ] **Step 1: Write failing tests** in `lib/roles/ladder.test.ts` with fixture roles `user(0)`, `dealer(10)`, `super(20)`, `agent(5, archived)`, `sub_agent(null)`, `admin(null)` and package `{ id: "p1", price: 6, dealer_price: 5 }`:
  - `priceLadder(roles, "super").map(r => r.slug)` → `["super", "dealer", "user"]` (archived `agent` skipped).
  - `priceLadder(roles, "sub_agent")` → `["sub_agent"]`; `"admin"` → `["admin"]`.
  - `priceLadder(roles, "nope")`, `(roles, null)`, `(roles, "agent")` → `[]`.
  - super has 4.60 → 4.60; super blank, dealer 5 → 5; super + dealer blank, user blank → 6.
  - unknown / null / archived slug → 6 (Review Focus 1).
  - **parity:** for packages `{price 6, dealer_price 5}`, `{price 6, dealer_price 0}`, `{price 6, dealer_price null}`, building `prices` the way the mirror would (dealer row only when `dealer_price > 0`): `resolveRolePrice(pkg, "dealer", …) === rolePrice(pkg, true)` and `resolveRolePrice(pkg, "user", …) === rolePrice(pkg, false)` and `"sub_agent"` → `rolePrice(pkg, false)` (Review Focus 2).
- [ ] **Step 2: Run** `npx vitest run lib/roles/ladder.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** both functions in `lib/roles/ladder.ts` (pure, no imports beyond the types/`rolePrice` for tests).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(roles): ladder price resolver with dealer parity`

---

### Task 3: Roles repo (DB reads, chunked, fail-closed)

**Files:**
- Create: `lib/roles/repo.ts`
- Test: `lib/roles/repo.test.ts` (fake client in the style of `lib/admin-users/test-fake-db.ts`)

**Interfaces:**
- Consumes: `RoleRow`, `RolePriceMap`, `resolveRolePrice` (Task 2); `PricedPackage`.
- Produces:
  ```ts
  export class RoleReadError extends Error {}          // name "RoleReadError"
  export const ROLE_ID_CHUNK = 500
  export async function loadRoles(client: { from(t: string): any }): Promise<RoleRow[]>                 // select id, slug, rank, is_system, archived_at from roles
  export async function loadRolePrices(client, roleIds: readonly string[], packageIds: readonly string[]): Promise<RolePriceMap>  // chunks packageIds by ROLE_ID_CHUNK; skips rows with price <= 0 / non-finite
  export async function rolePricesFor(client, slug: string | null | undefined, pkgs: readonly PricedPackage[]): Promise<Map<string, number>>  // packageId -> resolved price; loads only the ladder's role ids
  ```
  Every function throws `RoleReadError` on `error` or a thrown client call; never returns partial data.

- [ ] **Step 1: Write failing tests:**
  - `loadRoles` maps rows; a `{ error }` response → rejects `RoleReadError`; a throwing `from()` → rejects `RoleReadError`.
  - `loadRolePrices` with 1,201 package ids issues 3 `.in("package_id", …)` calls of ≤ 500 and returns all 1,201 prices (Review Focus 4); an error on the 2nd chunk → rejects `RoleReadError` (no partial map).
  - `rolePricesFor(client, "super", pkgs)` queries `role_package_prices` with `role_id in [super, dealer, user]` only and returns the Task 2 fallback results; `rolePricesFor(client, "nope", pkgs)` makes no price query and returns public prices.
- [ ] **Step 2: Run** `npx vitest run lib/roles/repo.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `lib/roles/repo.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(roles): fail-closed chunked roles repo`

---

### Task 4: `changeUserRole` accepts custom roles (dealer paths unchanged)

**Files:**
- Modify: `lib/admin-users/account-ops.ts` (`ASSIGNABLE_ROLES`, `RoleChangeResult`, `changeUserRole`, new helpers)
- Create: `lib/roles/margin-strategy.ts`
- Modify: `app/api/admin/users/update-role/route.ts:21-25` (validation)
- Test: `lib/roles/margin-strategy.test.ts`; extend `app/api/admin/users/update-role/route.test.ts`

**Interfaces:**
- Consumes: `loadRoles`, `rolePricesFor`, `RoleReadError` (Task 3).
- Produces:
  ```ts
  // lib/roles/margin-strategy.ts
  export type MarginStrategy = "legacy" | "recompute" | "none"
  /** latestRecompute = the user's latest user_role_change audit row has new_value.margin_mode === "recompute". */
  export function marginStrategy(oldRole: string, newRole: string, opts: { isCustom: (slug: string) => boolean; latestRecompute: boolean }): MarginStrategy
  /** New margin keeping selling price fixed: max(0, round2(margin + oldBase - newBase)); clamped=true when the max applied. */
  export function recomputeMargin(margin: number, oldBase: number, newBase: number): { margin: number; clamped: boolean }

  // lib/admin-users/account-ops.ts
  export const SYSTEM_ROLES = ["user", "admin", "sub_agent", "dealer"] as const   // ASSIGNABLE_ROLES kept as an alias for the bulk parser
  changeUserRole(db, opts: { userId: string; role: string; adminId?: string | null })  // role widened to string
  ```
- Rules (`marginStrategy`), in order:
  1. either side custom (`isCustom`) → `"recompute"`;
  2. `oldRole === "dealer"`, `newRole !== "admin"`, `latestRecompute` → `"recompute"`;
  3. `newRole === "dealer"` or (`oldRole === "dealer"` and `newRole !== "admin"`) → `"legacy"` (today's code path, untouched);
  4. otherwise `"none"`.
- `changeUserRole` changes:
  - target must be a `SYSTEM_ROLES` member or a non-archived row from `loadRoles`; else `{ ok:false, status:400, error:"Unknown role" }`. `RoleReadError` → 500 "Couldn't load roles, so the role was not changed. Try again."
  - a shop with `parent_shop_id` cannot move to `dealer` **or any custom role** (same 400 message, "Dealers" → "this role").
  - `"recompute"`: for each `shop_packages` row of the user's shop, `oldBase`/`newBase` from `rolePricesFor(old)` / `rolePricesFor(new)`; write `recomputeMargin(...)` when it differs; audit `new_value: { role, margin_mode: "recompute", margin_adjustments }`; when any clamped, result `note: "<n> shop packages hit a 0 margin; their selling price rose. Check the shop's prices."`
  - `"legacy"` / `"none"`: existing code, byte-identical.
  - push label uses the role's `name` for custom roles.
- Route: replace the static `ASSIGNABLE_ROLES.includes` check with passing the string through (validation now lives in `changeUserRole`). Bulk parser untouched this phase.

- [ ] **Step 1: Write failing tests** `lib/roles/margin-strategy.test.ts`:
  - table: (user→dealer)=legacy, (dealer→user)=legacy, (dealer→admin)=none, (user→admin)=none, (user→super)=recompute, (super→dealer)=recompute, (dealer→user, latestRecompute)=recompute, (dealer→admin, latestRecompute)=none.
  - `recomputeMargin(1, 5, 6)` → `{ margin: 0, clamped: false }`; `(0.5, 5, 6)` → `{ margin: 0, clamped: true }` (Review Focus 5); `(1, 6, 4.6)` → `{ margin: 2.4, clamped: false }`.
- [ ] **Step 2: Extend** `update-role/route.test.ts`: (a) `role: "super"` with `super` in fake roles → 200, shop margin moved by base difference, audit has `margin_mode: "recompute"`; (b) `role: "nope"` → 400 "Unknown role"; (c) sub-agent shop → `super` → 400; (d) roles read error → 500, no `users` write; (e) existing dealer/user cases still pass unchanged; (f) clamp case returns the `note`.
- [ ] **Step 3: Run** `npx vitest run lib/roles app/api/admin/users lib/admin-users` — Expected: new tests FAIL, existing pass.
- [ ] **Step 4: Implement** `margin-strategy.ts`, then the `account-ops.ts` and route changes.
- [ ] **Step 5: Run** the same command — Expected: all PASS. Then `npx vitest run` — Expected: only the 9 known order-health failures.
- [ ] **Step 6: Commit** — `feat(roles): changeUserRole accepts custom roles with recompute margins`

---

### Task 5: Branch verification (no deploy)

- [ ] **Step 1:** `npx tsc --noEmit` — Expected: no new errors in `lib/roles/**`, `lib/admin-users/**`, `app/api/admin/users/**`.
- [ ] **Step 2:** placeholder-env `next build` (per `feedback-run-next-build-before-pushing-main`) — Expected: build succeeds.
- [ ] **Step 3:** fresh-reviewer gate (money + schema): opus final review of the branch diff against the spec §5.1–5.4/§6a and this plan's Review Focus.
- [ ] **Step 4:** prepare the prod runbook in the PR body: pre-checks, printed dry-run string (`buildRunString`), apply, verify (`count(dealer rows) = N`; spot-check 3 packages' `dealer_price` unchanged; `SELECT DISTINCT role FROM users` all in `roles`). **Stop for owner OK before applying.**
