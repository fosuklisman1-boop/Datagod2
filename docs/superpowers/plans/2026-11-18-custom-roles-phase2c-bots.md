# Custom Roles — Phase 2c (USSD, WhatsApp, AI and SMS buyer tiers onto the role resolver) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price data bundles on the non-shop bot channels — Uzo USSD (`lib/ussd`), SMS text-to-buy (shares Uzo), Hubtel USSD (`lib/ussd-hubtel`), the WhatsApp main bot (`lib/whatsapp-bot/router.ts`, confirm shares Uzo) and the AI chat tools (`lib/ai-tools.ts`) — through the role resolver instead of `tier === "dealer"`, with **zero price change** for any caller.

**Architecture:** The existing tier label (`"regular" | "dealer" | "sub_agent"`, or the `app_settings.ussd_price_tier` default for unknown callers) stays exactly as it is: it is stored in Redis sessions and recorded on orders, and the sub-agent branch still prices through `subAgentCost(s)` (Phase 2b). Next to it we carry a new **price role** (a role slug) used only for pricing. Pricing becomes `priceWith(roleBasePrices(client, priceRole, pkgs, { admin: "as_user" }), pkg, custom)`. Sessions created before deploy have no price role; they fall back to `tierToSlug(tier)`, which reproduces today's rule exactly.

**Tech Stack:** Next.js 15, Supabase JS, TypeScript, Vitest. No migration.

**Spec:** `docs/superpowers/specs/2026-11-18-custom-roles-design.md` (§5.2, §5.7, §6 phase 2). Seams: `lib/roles/pricing.ts` (2a), `lib/shop-commerce/pricing.ts` (2b, sub-agent costs).

## Global Constraints

- **Parity:** with only system roles (prod today), every bot menu price and every confirmed/charged price equals today's.
- **Admin rule on these channels is `"as_user"`** (today `decideTier`/`resolveBuyerTier` give admin `"regular"`). Never change it here.
- **Tier label unchanged:** `effectivePriceTier` values, what gets stored in sessions and what gets recorded on orders (e.g. `price_tier`) must not change. The price role is a new, additional field.
- **Unknown callers** (no `users` row for the phone): price role = `tierToSlug(app_settings.ussd_price_tier ?? "regular")` (`"dealer"` → `"dealer"`, anything else → `"user"`), exactly today's behaviour.
- **In-flight sessions** (created before deploy, no price role): `priceRole ?? tierToSlug(tier)` everywhere a session is priced.
- **Sub-agent tier** keeps pricing via `subAgentCost(s)` (parent's role base + wholesale); unchanged.
- **Failure handling:** a `RoleReadError` is handled exactly like the channel's existing `CustomPriceReadError` handling at the same point (menus degrade the way they do today on a custom-price failure; confirm refuses before any payment prompt, wallet debit or order insert).
- **Out of scope:** airtime/fee tiers (`lib/ussd/resolve-dialer.ts` `rateTier`, `dialerGetsDealerRate`, `airtimeBaseFeeRate`) — Phase 2d; shop bots (`lib/ussd-shop`, `lib/whatsapp-bot/shop-router.ts`) — done in 2b; the admin `ussd_price_tier` picker — Phase 4.
- `CUSTOM_ROLE_ASSIGNMENT_ENABLED` stays `false`. Edit/Write only, never `sed`. No PII in logs (no phone numbers). TDD.

## Review Focus

1. **Admin dialling USSD / messaging the bot** still gets the public price (tier "regular"). Test in Task 1.
2. **Unknown caller with `ussd_price_tier = "dealer"`** still gets dealer prices. Test in Task 1.
3. **A session created before deploy** (no price role) prices exactly as today. Test in Tasks 2 and 3.
4. **Menu price = confirm price** for the same session (no drift between list and charge). Test in Tasks 2–4.
5. **Role read failure at confirm** → refused, nothing charged, no payment prompt. Test in Tasks 2–4.

---

### Task 1: Price role resolution

**Files:** Create `lib/ussd/price-role.ts` + test; Modify `lib/ussd/buyer-tier.ts` (`BuyerTier`, `resolveBuyerTier`), `lib/ussd/types.ts:~171` (session type), `lib/ussd-hubtel/catalog.ts` (`CallerContext`, `decideTier`, `resolveCaller`), `lib/ussd-hubtel/types.ts:~74` (session type); extend their tests.

**Interfaces:**
- Produces:
  ```ts
  // lib/ussd/price-role.ts
  /** Today's rule for a tier label: "dealer" → "dealer"; anything else (incl. "regular", "sub_agent", unknown) → "user". */
  export function tierToSlug(tier: string | null | undefined): string
  /** Price role for a caller: known role → pricingSlug(role, "as_user"); unknown caller → tierToSlug(defaultTier). */
  export function buyerPriceRole(role: string | null | undefined, defaultTier: string | null | undefined): string
  /** Session/legacy-safe: priceRole if set, else tierToSlug(tier). */
  export function sessionPriceRole(s: { priceRole?: string | null; effectivePriceTier?: string | null }): string
  ```
  `BuyerTier` and `CallerContext` gain `priceRole: string`; both USSD session types gain `priceRole?: string`. `resolveBuyerTier`/`resolveCaller` set it with `buyerPriceRole(userRow?.role, defaultTier)` and leave every existing field's value unchanged. `decideTier` unchanged.
- [ ] **Step 1: failing tests:** `tierToSlug`: dealer→dealer, regular→user, sub_agent→user, undefined→user, "gold"→user. `buyerPriceRole`: ("dealer",·)→dealer, ("admin",·)→user, ("user",·)→user, ("sub_agent",·)→sub_agent, ("gold",·)→gold, (undefined,"dealer")→dealer, (undefined,"regular")→user, (undefined,undefined)→user. `sessionPriceRole`: {priceRole:"gold"}→gold; {effectivePriceTier:"dealer"}→dealer; {}→user. `resolveBuyerTier`/`resolveCaller` return the same `effectivePriceTier` as before for dealer/admin/user/sub_agent(with and without parent)/unknown(default regular|dealer) plus the expected `priceRole`.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run lib/ussd lib/ussd-hubtel`).
- [ ] **Step 5:** commit `feat(roles): bot callers carry a price role next to the tier`.

### Task 2: Uzo USSD + SMS text-to-buy

**Files:** Modify `lib/ussd/handlers/bundles.ts` (`fetchBundles` ~:91 and its callers ~:139-:188 — store `priceRole` in the session at the network step; `handleConfirm` ~:320-:351), `lib/text-to-buy/catalogue.ts` (~:84 `fetchAllBundles`, ~:136, ~:178, ~:211 — pass/store the price role), and the shared `fetchAllBundles` wherever it lives; extend tests.

**Interfaces:** Consumes Task 1 (`sessionPriceRole`, `BuyerTier.priceRole`); `roleBasePrices`, `priceWith` (`lib/roles/pricing.ts`).
- Menu: non-sub-agent rows priced `priceWith(base, row, custom)` with `base = roleBasePrices(supabase, priceRole, rows, { admin: "as_user" })` loaded once per page/list. Add the price role as a new optional trailing parameter where needed (callers that don't pass it fall back to `tierToSlug(tier)`).
- Confirm: `sessionPriceRole(session)`; base loaded before any payment prompt/debit/insert; `RoleReadError` handled like the existing `CustomPriceReadError` at that point.
- [ ] **Step 1: failing tests:** dealer/admin/user/unknown-default-dealer parity on menu and confirm; a `role_package_prices` row for role `user` 5.5 reflected on both; a session without `priceRole` but tier "dealer" prices at dealer (legacy session); menu price = confirm price; role read failure at confirm → refused, no payment/debit/insert. SMS lane: the same parity through its entry point (`catalogue.ts`).
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run lib/ussd lib/text-to-buy`).
- [ ] **Step 5:** commit `feat(roles): Uzo USSD and text-to-buy price through the role resolver`.

### Task 3: Hubtel USSD

**Files:** Modify `lib/ussd-hubtel/catalog.ts` (`priceForTier`), `lib/ussd-hubtel/flows/data.ts` (~:34-:39 store `priceRole` in session; ~:48, ~:72 menu paging; ~:104-:130 confirm), `lib/ussd-hubtel/testing/fakes.ts:~109`; extend tests.

**Interfaces:**
- `priceForTier(pkg, tier, offer, custom, base?: ReadonlyMap<string, number>)` — non-sub-agent: `priceWith(base, pkg, custom)` when `base` given; the confirm path always passes it (`roleBasePrices(supabase, sessionPriceRole(session), [pkg], { admin: "as_user" })`), loaded before the payment step. Sub-agent branch unchanged.
- Menus use the shared Uzo `fetchBundles` (Task 2) — pass `sessionPriceRole(session)` through.
- [ ] **Step 1: failing tests:** same matrix as Task 2 for the Hubtel flow incl. legacy session and confirm refusal on role read failure; fakes default `priceRole` derived via `tierToSlug`.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run lib/ussd-hubtel`).
- [ ] **Step 5:** commit `feat(roles): Hubtel USSD prices through the role resolver`.

### Task 4: WhatsApp main bot + AI chat tools

**Files:** Modify `lib/whatsapp-bot/router.ts` (~:99-:135 `loadAllBundlesWa`, ~:181, ~:317 — store/pass `priceRole`; confirm already shares Uzo `handleConfirm`), `lib/ai-tools.ts` (~:1284-:1318 `get_available_packages`: non-admin listing priced via `roleBasePrices(..., pricingSlug(ctx.userRole, "as_user") ...)`, admin's raw listing at ~:1297-:1306 unchanged; ~:1941-:1976 order tool: price role = `buyerPriceRole(role, ussd_price_tier)`, keep `effectivePriceTier` exactly as today for recording at ~:2018); extend tests.
- [ ] **Step 1: failing tests:** WhatsApp menu parity (dealer/admin/user/legacy session) and menu = confirm; AI `get_available_packages` dealer/user/admin-non-raw parity and `user` row 5.5; AI order tool quote parity, unknown caller with default tier, and role read failure → the tool returns its existing "prices unavailable"-style refusal without placing anything.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run lib/whatsapp-bot lib/ai-tools`).
- [ ] **Step 5:** commit `feat(roles): WhatsApp bot and AI tools price through the role resolver`.

### Task 5: Branch verification

- [ ] `npx tsc --noEmit` clean for touched paths; full `npx vitest run` → only the 12 known pre-existing failures.
- [ ] `NODE_OPTIONS=--use-system-ca` placeholder-env `next build` → exit 0 (run only when no implementer is editing).
- [ ] Final whole-range review (opus).
- [ ] No production DB change in 2c. Redis session compatibility is covered by the legacy-session fallback.
