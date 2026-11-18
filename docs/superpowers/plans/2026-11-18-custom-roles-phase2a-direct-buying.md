# Custom Roles — Phase 2a (Direct buying onto the role resolver) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every *direct-buying* data-package price (web buy, bulk, the dashboard price list, `/products`, API v1, API v2 incl. its SQL RPC) from the hard-coded `role === "dealer"` rule onto the Phase 1 role resolver — with **zero price change** for every existing user, because the only roles that exist are the four system roles and the dealer prices are mirrored.

**Architecture:** A thin async seam `lib/roles/pricing.ts` turns (role, packages) into a `package id → base price` map via `rolePricesFor` (Phase 1), with an explicit per-caller admin rule. Callers load that map once per request and price with `priceWith(base, pkg, custom)` (custom price still wins). Charge paths refuse with the existing 503 `MSG_PRICES_UNAVAILABLE` on `RoleReadError`, before any debit. API v2's SQL RPC gains an additive acceptance clause through a new SQL ladder function `role_price_for` (migration 0185) so a future custom-role price is not rejected; nothing it accepts today is removed.

**Tech Stack:** Next.js 15, Supabase JS, Postgres 17 (Supabase), TypeScript, Vitest, PGlite (scratchpad runner).

**Spec:** `docs/superpowers/specs/2026-11-18-custom-roles-design.md` (§5.2, §5.7, §6 phase 2). Phase 1 plan: `docs/superpowers/plans/2026-11-18-custom-roles-phase1-foundation.md`.

**Scope note:** Phase 2 is split. 2a = this plan. 2b shops & sub-agents · 2c USSD/WhatsApp/AI/SMS tiers · 2d airtime/cashback/bills/withdrawal rates · 2e mobile + display pages + flip `CUSTOM_ROLE_ASSIGNMENT_ENABLED`. The flag stays `false` throughout 2a.

## Global Constraints

- **Parity:** with only system roles present, every price any caller returns or charges must equal what it returns today. Dealer prices come from the 0184 mirror, so `rolePricesFor("dealer")` ≡ `rolePrice(pkg, true)` and `rolePricesFor("user"|"sub_agent")` ≡ `rolePrice(pkg, false)`.
- **Admin rule is per caller and preserved:** every 2a caller prices `admin` as a normal user today (`role === "dealer"` only), so every 2a caller uses `admin: "as_user"`. Shops (2b) use `"as_dealer"`. Never change a caller's admin behaviour in this phase.
- Custom price (user on `pricing_mode = 'custom'`) still wins over the role base, exactly as `effectivePrice` does now.
- **Charge paths fail closed:** `RoleReadError` → HTTP 503 with `MSG_PRICES_UNAVAILABLE`, before any wallet debit or order insert (same handling as `CustomPriceReadError`). **Display paths** may fall back to the public price, never a cheaper one (`/api/user/package-prices` keeps its existing 503 on read failure).
- No new behaviour for custom roles is reachable: `CUSTOM_ROLE_ASSIGNMENT_ENABLED` stays `false`.
- Migration 0185: one `BEGIN;`/`COMMIT;`, `SET LOCAL lock_timeout = '5s'`, `SET LOCAL statement_timeout = '60s'`, idempotent, PRE-CHECKS header, selftest file, run string built by code (`buildRunString` pattern from `lib/roles/migration-0184-run.ts`). **Not applied by the implementer.**
- Code edits with Edit/Write only, never `sed`. No PII in logs. TDD.

## Review Focus

1. **Admin buying directly** (web, bulk, v1, v2) still pays the public price, not the dealer price. Test in Task 1 (`pricingSlug`) and each route task.
2. **A user on custom pricing** still pays their custom price, not the role base. Test in Task 1 + Task 2.
3. **Roles/role-price read failure on a charge path** → 503, wallet untouched, no order row. Test in Tasks 2 and 4.
4. **A bulk request with many packages** prices every row from one base map (no per-row DB read), and a package missing from the map is never priced at 0. Test in Task 2.
5. **API v2 RPC:** a price that is valid today is still accepted after 0185; a price matching no tier is still rejected. Test in Task 5 selftest.

---

### Task 1: `lib/roles/pricing.ts` seam

**Files:** Create `lib/roles/pricing.ts`; Test `lib/roles/pricing.test.ts`

**Interfaces:**
- Consumes: `rolePricesFor`, `RoleReadError` (`lib/roles/repo.ts`); `PricedPackage`, `CustomPrices`, `rolePrice`, `effectivePrice` (`lib/pricing/package-price.ts`).
- Produces:
  ```ts
  export type AdminPricing = "as_user" | "as_dealer"
  /** The slug whose ladder prices this role. admin → "dealer" | "user" per rule; null/undefined/"" → "user"; anything else unchanged. */
  export function pricingSlug(role: string | null | undefined, admin: AdminPricing): string
  /** package id (String) → base price for every pkg. Throws RoleReadError. */
  export async function roleBasePrices(client: { from(t: string): any }, role: string | null | undefined, pkgs: readonly PricedPackage[], opts: { admin: AdminPricing }): Promise<Map<string, number>>
  /** custom.get(id) ?? base.get(id); throws Error("no base price for package <id>") if neither (never 0). */
  export function priceWith(base: ReadonlyMap<string, number>, pkg: { id: string | number }, custom: CustomPrices): number
  /** Display paths only: roleBasePrices, but on RoleReadError returns the public price map. */
  export async function roleBasePricesOrPublic(client, role, pkgs, opts): Promise<Map<string, number>>
  ```
- [ ] **Step 1: failing tests:** `pricingSlug("admin","as_user")="user"`, `("admin","as_dealer")="dealer"`, `(null,…)="user"`, `("dealer",…)="dealer"`, `("sub_agent",…)="sub_agent"`, `("gold",…)="gold"`. **Parity** with a fake client holding the four seeded roles and dealer rows built from fixture packages `{price 6, dealer_price 5}`, `{6, 0}`, `{6, null}`: for each role in `user|dealer|sub_agent|admin` × admin rule, `priceWith(await roleBasePrices(...), pkg, NO_CUSTOM_PRICES) === effectivePrice(pkg, <old isDealer for that caller>, NO_CUSTOM_PRICES)` where old isDealer = `role === "dealer"` for `as_user` and `role === "dealer" || role === "admin"` for `as_dealer`. Custom map `{p1: 4.2}` → 4.2. `priceWith` with id absent from both → throws. `roleBasePrices` on a failing fake → rejects `RoleReadError`; `roleBasePricesOrPublic` → public prices.
- [ ] **Step 2:** `npx vitest run lib/roles/pricing.test.ts` → FAIL (module missing).
- [ ] **Step 3:** implement (pure wrappers; no new queries beyond `rolePricesFor`).
- [ ] **Step 4:** same command → PASS.
- [ ] **Step 5:** commit `feat(roles): pricing seam with per-caller admin rule`.

### Task 2: Web buy, bulk and API v1 charge paths

**Files:** Modify `app/api/orders/purchase/route.ts:~186-215`, `app/api/orders/create-bulk/route.ts:~150-200`, `app/api/v1/orders/route.ts:~175-190`; extend their existing route tests (find them next to each route or under `__tests__`; if a route has none, add `route.test.ts` beside it using the fake-client pattern of `app/api/admin/users/update-role/route.test.ts`).

**Interfaces:** Consumes Task 1 (`roleBasePrices`, `priceWith`, `AdminPricing`), `RoleReadError`.

- Each route: load custom prices as today, then `base = await roleBasePrices(db, userRole, [pkg(s)], { admin: "as_user" })`, then `priceWith(base, pkg, custom)`. `RoleReadError` is handled exactly like `CustomPriceReadError` (503 `MSG_PRICES_UNAVAILABLE`), before any debit/insert. Bulk loads ONE base map for all distinct packages in the request.
- [ ] **Step 1: failing tests per route:** (a) dealer parity — dealer charged `dealer_price`; (b) admin charged `price`; (c) user on custom pricing charged the custom price; (d) roles read fails → 503, no wallet update, no order insert; (e) bulk: 3 rows over 2 packages → exactly one `role_package_prices` read; (f) a `role_package_prices` row for role `user` at 5.5 makes a `user` pay 5.5 (proves the route now reads the resolver, not `role === "dealer"`).
- [ ] **Step 2:** run the three route test files → new tests FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run → PASS; then `npx vitest run app/api/orders app/api/v1 lib/roles lib/pricing`.
- [ ] **Step 5:** commit `feat(roles): web, bulk and v1 orders price through the role resolver`.

### Task 3: Display price list and `/products`

**Files:** Modify `app/api/user/package-prices/route.ts`, `lib/products-catalog.ts:~30-60`; tests beside each (create if absent).

- `/api/user/package-prices`: `roleBasePrices(..., { admin: "as_user" })`; `RoleReadError` → 503 `{ error: "Failed to load prices" }` (same as its other read failures).
- `lib/products-catalog.ts` `buildDataBundles`: take the base map from `roleBasePricesOrPublic(..., { admin: "as_user" })` (display fallback, mirrors its existing `.catch(() => NO_CUSTOM_PRICES)`); `buildAirtime(isDealer)` untouched (2d).
- [ ] **Step 1: failing tests:** dealer/user/admin parity; `user` role row 5.5 shown as 5.5; package-prices read failure → 503; products-catalog read failure → public prices.
- [ ] **Step 2–4:** run → FAIL → implement → PASS.
- [ ] **Step 5:** commit `feat(roles): price list and products catalog use the role resolver`.

### Task 4: API v2 TypeScript

**Files:** Modify `lib/api-v2/data-orders.ts:166-172` (`priceForRole`), `lib/api-v2/endpoints/data.ts` (deps interface ~line 107; call sites ~368, ~502, ~773), `lib/api-v2/endpoints/data-deps.ts:~89`; extend the existing v2 data endpoint tests and their fake deps.

**Interfaces:**
- `DataDeps` gains `basePrices(role: string, pkgs: readonly PricedPackage[]): Promise<Map<string, number>>` (throws `RoleReadError`); `data-deps.ts` wires it to `roleBasePrices(client, role, pkgs, { admin: "as_user" })`.
- `priceForRole` becomes `priceForRole(base: ReadonlyMap<string, number>, pkg: { id?: string; price: number; dealer_price: number | null }, custom?: CustomPrices): number` → `priceWith(base, { id: pkg.id ?? "" }, custom)`. Each endpoint loads `base` once (single: its package; bulk: all distinct packages; price list: all listed rows) next to where it loads `custom`, and maps `RoleReadError` the same way it maps `CustomPriceReadError` today.
- [ ] **Step 1: failing tests:** single, bulk and price-list: dealer parity, admin public, custom wins, `user` row 5.5 → 5.5, base read failure handled exactly like the custom-price failure (same status/body as today's `CustomPriceReadError` path, nothing placed).
- [ ] **Step 2–4:** run `npx vitest run lib/api-v2` → FAIL → implement → PASS.
- [ ] **Step 5:** commit `feat(roles): API v2 prices through the role resolver`.

### Task 5: Migration 0185 — SQL ladder + v2 RPC acceptance

**Files:** Create `migrations/0185_role_price_sql.sql`, `migrations/0185_role_price_sql.selftest.sql`, `lib/roles/migration-0185-run.ts` (copy of the 0184 runner, labels 0185), `lib/roles/migration-0185.test.ts`.

**Interfaces (DB):**
- `public.role_price_for(p_role text, p_package uuid) RETURNS numeric` — `STABLE`, `SECURITY DEFINER`, `SET search_path = public`, EXECUTE revoked from PUBLIC/anon/authenticated. Walks the same ladder as `lib/roles/ladder.ts`: the role itself (if non-archived), then non-archived roles with `rank < its rank` by rank desc (off-ladder role → itself only; unknown/archived/NULL → none); first `role_package_prices.price` found, else `packages.price`. NULL if the package doesn't exist.
- `place_api_v2_order`: `CREATE OR REPLACE` with the body **identical to 0142** except the price-acceptance condition gains one additive disjunct: `OR p_price = public.role_price_for(u.role, p.id)` (inside the same EXISTS that already joins `users u`; if it doesn't, join `public.users u ON u.id = p_user_id` there). Nothing currently accepted is removed.
- PRE-CHECKS: 0184 applied (`to_regclass('public.roles')` NOT NULL); current `place_api_v2_order` definition equals 0142's (record `md5(pg_get_functiondef('public.place_api_v2_order(uuid,uuid,uuid,text,numeric,numeric,text,text,text)'::regprocedure))` before apply).
- [ ] **Step 1: failing test** `lib/roles/migration-0185.test.ts`: text rules (one txn, SET LOCALs, one COMMIT, run string safe); **copy-drift**: the 0185 function body equals 0142's apart from the one added disjunct (normalise CRLF before comparing); PGlite blocks (skip without PGlite).
- [ ] **Step 2–3:** write migration + selftest. Selftest (distinct `FAIL` names): `role_price_for('dealer', pkg)` = dealer_price for a package with dealer_price > 0, = price when dealer_price is 0/NULL; `('user', pkg)` = price; `('admin', pkg)` = price; `('nope', pkg)` = price; insert a temp custom role `selftest_gold` rank 20 with a price row → `role_price_for('selftest_gold', pkg)` = that price, and for a second package without a row = dealer price (ladder fallback); `prosecdef` true and `search_path=public`; anon/authenticated cannot EXECUTE; `pg_get_functiondef(place_api_v2_order)` contains the new disjunct.
- [ ] **Step 4:** `npx vitest run lib/roles/migration-0185.test.ts` → PASS; scratchpad PGlite runner (template `scratchpad/run0184.cjs`): apply 0184 then 0185 on stubs; if `place_api_v2_order`'s referenced tables make it impractical in PGlite, create only `role_price_for` there and say so in the report → `SELFTEST_OK 0185`.
- [ ] **Step 5:** commit `feat(roles): 0185 SQL role_price_for + v2 RPC accepts ladder price (not applied)`.

### Task 6: Branch verification

- [ ] `npx tsc --noEmit` clean for touched paths; full `npx vitest run` → only the 12 known pre-existing failures (order-health ×9, admin-users/migration, pricing/migration, standard-bundles/runtime getBuyerTier).
- [ ] `NODE_OPTIONS=--use-system-ca` placeholder-env `next build` → exit 0.
- [ ] Final whole-branch review (opus) over the 2a range.
- [ ] Prod: 0185 precheck → self-rolling-back dry run → owner OK → apply → verify (`role_price_for` parity over all 47 packages for dealer/user/admin vs `rolePrice`). Deploy order: either order is safe (TS never calls `role_price_for`; the RPC change is additive).
