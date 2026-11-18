# Custom Roles — Phase 2b (Shops & sub-agents onto the role resolver) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every shop data-package price — the shared shop core (feeding web storefront, USSD/Hubtel/WhatsApp/SMS shop bots and AI shop tools), the direct-shop order route, sub-agent costs, and the owner/sub-agent pricing routes and pages — off `role === 'dealer' || role === 'admin'` onto the role resolver, with **zero price change** for any shop, owner, sub-agent or customer.

**Architecture:** `lib/shop-commerce/pricing.ts` keeps its public function signatures (`fetchShopBundles`, `verifyBundlePrice`, `subAgentCosts`, `subAgentCost`, `subAgentBundles`, `directShopPricing`) so the ~15 channel callers don't change. Internally, `OwnerPricing` changes from `{ isDealer, custom }` to `{ slug, custom }` (slug = `pricingSlug(role, "as_dealer")`), and every `rolePrice(pkg, isDealer)` / `ownerSaving(pkg, isDealer, custom)` becomes a lookup in a base map from `roleBasePrices(..., { admin: "as_dealer" })`. A role read failure inside the shop core is rethrown as `CustomPriceReadError`, so every caller's existing refuse/hide handling applies unchanged. Owner pages stop computing base prices in the browser and read them from a new authenticated route.

**Tech Stack:** Next.js 15, Supabase JS, TypeScript, Vitest. No migration.

**Spec:** `docs/superpowers/specs/2026-11-18-custom-roles-design.md` (§5.2, §5.7, §6 phase 2). Seam: `lib/roles/pricing.ts` (Phase 2a).

## Global Constraints

- **Parity:** with only system roles (prod today), every shop price, owner profit, sub-agent cost and parent profit equals today's.
- **Admin rule for shops is `"as_dealer"`** (today: `role === 'dealer' || role === 'admin'`). Every shop pricing site in this plan uses it. Never change it here.
- Direct shop selling price stays `role base + margin`; owner profit stays `margin + saving` where saving = `base − (custom ?? base)` (today's `ownerSaving`). Sub-agent cost stays `parent base + parent's active wholesale margin`; parent profit stays `wholesale + parent saving`.
- **Error contract:** a role/role-price read failure inside `lib/shop-commerce/pricing.ts` is rethrown as `CustomPriceReadError` (message "Could not read role prices"), so callers keep their existing behaviour (display lists nothing / confirm refuses / order route 503). New routes outside the core return 503 on `RoleReadError`.
- **Out of scope (do not touch):** `shopOwnerIsDealer` (still used for the shop AIRTIME fee tier — Phase 2d — and the invites page `dealerRatesEnabled` display), every dealer/admin **access gate** (`dealer-packages` 403, buy-stock page gate, my-shop badge — rights are Phase 3), airtime anything, non-shop buyer tiers (USSD/WhatsApp main menus — Phase 2c).
- Stored `parent_price` snapshots remain display-only and are never read on a charge path (as today).
- `CUSTOM_ROLE_ASSIGNMENT_ENABLED` stays `false`. Edit/Write only, never `sed`. No PII in logs. TDD.
- Deploy requires 0184 (dealer prices only come from `role_package_prices`) — prod has it.

## Review Focus

1. **Admin-owned shop:** storefront, bots and direct order still use the DEALER price as base (not public). Test in Tasks 1 and 2.
2. **Sub-agent under a dealer/admin parent:** cost = parent dealer price + wholesale, unchanged; under a `user` parent = public + wholesale. Test in Task 1.
3. **Owner on custom pricing:** selling price unchanged (base + margin), profit = margin + (base − custom). Test in Tasks 1 and 2.
4. **Role read failure:** bot menus list nothing, confirm refuses, storefront order 503 — nothing charged. Test in Tasks 1 and 2.
5. **Package with dealer_price 0/NULL** in a dealer-owned shop prices at public `price`, never 0. Test in Task 1.

---

### Task 1: Shop core (`lib/shop-commerce/pricing.ts`)

**Files:** Modify `lib/shop-commerce/pricing.ts`; extend its tests (find `lib/shop-commerce/pricing.test.ts` and any `*.test.ts` covering `subAgentCosts` / `fetchShopBundles` / `verifyBundlePrice`).

**Interfaces:**
- Consumes: `pricingSlug`, `roleBasePrices`, `priceWith` (`lib/roles/pricing.ts`); `RoleReadError` (`lib/roles/repo.ts`); `CustomPriceReadError`.
- Produces:
  ```ts
  export type OwnerPricing = { slug: string; custom: CustomPrices }   // was { isDealer, custom }
  shopOwnerPricing(shopId, client?): Promise<OwnerPricing>            // slug = pricingSlug(users.role, "as_dealer"); "user" when shop/user missing
  /** base map for an owner over pkgs; RoleReadError → CustomPriceReadError("Could not read role prices"). */
  export async function ownerBasePrices(client, owner: OwnerPricing, pkgs: readonly PricedPackage[]): Promise<Map<string, number>>
  /** today's ownerSaving, from the base map: round2(base − priceWith(base, pkg, custom)) || 0 */
  export function ownerSavingFrom(base: ReadonlyMap<string, number>, pkg: { id: string | number }, custom: CustomPrices): number
  ```
  `fetchShopBundles`, `verifyBundlePrice`, `subAgentCosts`, `subAgentCost`, `subAgentBundles`, `directShopPricing` keep their exported signatures and return shapes. `subAgentCosts(...).parent` becomes the new `OwnerPricing` (callers that read `.parent.isDealer` are updated in Task 3). Remove `basePrice()` if nothing outside the core uses it (grep first); otherwise leave it.
- [ ] **Step 1: failing tests** with a fake client serving `user_shops`, `users`, `roles` (0184 seed: user 0, dealer 10, sub_agent/admin NULL), `role_package_prices` (dealer rows), `packages`, `shop_packages`, `sub_agent_catalog`, `sub_agent_shop_packages` (reuse the existing tests' fakes and extend them):
  - owner dealer / admin / user: `verifyBundlePrice` verifiedPrice = (dealer|dealer|public) + margin; profit unchanged vs today's numbers.
  - owner custom mode (dealer, custom 4.2 on a dealer-5 package, margin 1): selling 6, profit = 1 + 0.8.
  - `subAgentCosts`: dealer parent → cost dealer + wholesale; admin parent → same; user parent → public + wholesale; parentProfit = wholesale + saving.
  - package dealer_price 0 in a dealer shop → base = public price.
  - a `role_package_prices` row for role `user` 5.5 makes a user-owned shop's base 5.5 (proves the resolver is read).
  - roles read fails → `fetchShopBundles` returns [] (display) and `verifyBundlePrice` / `subAgentCosts` reject with `CustomPriceReadError`.
- [ ] **Step 2:** run the shop-commerce tests → new ones FAIL.
- [ ] **Step 3:** implement; load each base map ONCE per call over the packages that call prices.
- [ ] **Step 4:** run → PASS; then `npx vitest run lib/shop-commerce lib/ussd-shop lib/ussd-hubtel lib/whatsapp-bot lib/text-to-buy lib/sub-agents lib/ussd lib/ai-tools lib/roles` (callers must still pass unchanged).
- [ ] **Step 5:** commit `feat(roles): shop core prices through the role resolver`.

### Task 2: Direct-shop order route + public storefront

**Files:** Modify `app/api/shop/orders/create/route.ts:~400-450` (direct-shop branch: `owner.isDealer` → base map), `lib/shop-commerce/public-packages.ts:~45-70, ~190-210` (drop inline `isDealer && dealer_price > 0`; owner pricing via `shopOwnerPricing` + `ownerBasePrices`); tests beside each (extend existing; create `route.role-pricing.test.ts` / `public-packages.role-pricing.test.ts` if cleaner).

**Interfaces:** Consumes Task 1 (`shopOwnerPricing`, `ownerBasePrices`, `ownerSavingFrom`, `directShopPricing`).
- orders/create: base map loaded before any wallet/payment/insert; `CustomPriceReadError` keeps its existing 503 handling.
- public-packages: `selling_price` = base + margin; the `exactPriceIds`/"charged" parity check uses the same base map; on `CustomPriceReadError` keep its existing display behaviour (read the code: if it already degrades, keep that; never show a price below what the order route will charge).
- [ ] **Step 1: failing tests:** admin-owned shop storefront selling price = dealer + margin and the order route charges exactly that; user-owned shop = public + margin; custom-mode owner: order charges base + margin, profit margin + saving; roles read failure → order 503 with nothing debited/inserted; storefront `user` role row 5.5 → 5.5 + margin.
- [ ] **Step 2–4:** FAIL → implement → PASS; `npx vitest run app/api/shop lib/shop-commerce`.
- [ ] **Step 5:** commit `feat(roles): shop orders and storefront use the role resolver`.

### Task 3: Owner & sub-agent routes + owner base-price route

**Files:** Modify `app/api/shop/sub-agent-catalog/route.ts:~130-215`, `app/api/shop/parent-packages/route.ts:~40-100`, `app/api/shop/dealer-packages/route.ts:~55-65`; Create `app/api/shop/owner-base-prices/route.ts`; tests beside each.

- `sub-agent-catalog` (parent branch, ~177-214): base via `shopOwnerPricing` + `ownerBasePrices` of the caller's shop (as_dealer), replacing inline `isDealer && dealer_price`; response keeps `is_dealer` (now `slug === "dealer"`; clients stop using it in Task 4) and gains `base_price` per catalog row. Sub-agent branch (~136-168): `offers.parent.isDealer` → `offers.parent.slug === "dealer"`.
- `parent-packages`: parent's base via `shopOwnerPricing(parentShopId)` + `ownerBasePrices`; add `base_price` per item; keep existing fields.
- `dealer-packages`: keep the dealer/admin 403 gate exactly; `price` = caller's base via `roleBasePrices(db, role, pkgs, { admin: "as_dealer" })` (was `rolePrice(pkg, true)`); `RoleReadError` → 503.
- **New** `GET /api/shop/owner-base-prices` (Bearer auth like `/api/user/package-prices`): `{ base: { [packageId]: number } }` for every available package, priced for the caller as a shop owner (`as_dealer`, no custom prices); 401 unauthenticated; 503 `{ error: "Failed to load prices" }` on `RoleReadError`; `Cache-Control: no-store`. Route files export only HTTP handlers / route config (Next.js rule).
- [ ] **Step 1: failing tests** per route: dealer/admin/user parity, `user` role row 5.5 reflected, 503 on read failure, dealer-packages still 403 for user/sub_agent.
- [ ] **Step 2–4:** FAIL → implement → PASS; `npx vitest run app/api/shop`.
- [ ] **Step 5:** commit `feat(roles): owner and sub-agent shop routes price through the role resolver`.

### Task 4: Owner pricing pages

**Files:** Modify `app/dashboard/shop-pricing/page.tsx:~250-300` (`getBasePrice`, `isDealer`), `app/dashboard/sub-agent-catalog/page.tsx:~40-115` (`getBasePrice`, `isDealer` state); Create `lib/shop-commerce/owner-base-price.ts` + test.

- Extract `ownerDisplayBase(pkg: { id: string; price: number | string; parent_price?: number | null }, base: Record<string, number> | null): number` → `pkg.parent_price` if a number (sub-agent rows, shop-pricing only), else `base?.[pkg.id]`, else `Number(pkg.price)` (public — never cheaper).
- Both pages fetch `/api/shop/owner-base-prices` once (same auth-header helper they already use) and use `ownerDisplayBase`. Remove the `dealer_price`/`isDealer` arithmetic from both pages' price logic. If the fetch fails, keep the page usable with public prices and show the page's existing error toast pattern.
- [ ] **Step 1: failing tests** for `ownerDisplayBase` (map hit, missing → public, parent_price wins, string price coerced).
- [ ] **Step 2–4:** FAIL → implement → PASS; `npx tsc --noEmit` clean for both pages.
- [ ] **Step 5:** commit `feat(roles): owner pricing pages read server base prices`.

### Task 5: Branch verification

- [ ] `npx tsc --noEmit` clean for touched paths; full `npx vitest run` → only the 12 known pre-existing failures.
- [ ] `NODE_OPTIONS=--use-system-ca` placeholder-env `next build` → exit 0.
- [ ] Final whole-range review (opus).
- [ ] No production DB change in 2b.
