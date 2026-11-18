# Custom Roles — Phase 2d (Airtime fees & cashback shares onto per-role rates) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make airtime fee rates and cashback shares (which also covers bills and standard bundles) resolvable per role, with **zero fee/cashback change** for anyone today.

**Architecture:** Migration 0186 adds an empty `role_service_rates(role_id, service_key, value)` table — no triggers, no seed. A pure resolver walks the role ladder: the role's own row → lower roles' rows → when the walk reaches **dealer** it returns today's dealer value, when it reaches **user** it returns today's customer value (legacy settings stay the source of truth for those two). Every existing tier decision rule (six different ones for airtime, see Global Constraints) is preserved verbatim; each caller just turns its existing "dealer?" decision into a role slug and asks the resolver. With no rows in the table (prod today), every result equals today's.

**Tech Stack:** Next.js 15, Supabase Postgres, TypeScript, Vitest, PGlite (scratchpad runner).

**Spec:** `docs/superpowers/specs/2026-11-18-custom-roles-design.md` (§5.1 `role_service_rates`, §6 phase 2). Deviation (controller call): no two-way mirror to `admin_settings` — legacy keys are read as the dealer/user fallback instead (dealer & customer rates keep being edited where they are today; only custom roles get rows, from the Phase 3 hub).

## Global Constraints

- **Parity:** with `role_service_rates` empty (prod), every airtime fee rate and cashback share any caller uses equals today's.
- **Preserve every existing tier rule exactly** — this phase does NOT unify them (owner decision pending, Phase 3/4):
  - A `getDealerRateTier` (lib/sub-agents/dealer-rates.ts:29-48): dealer → dealer; sub_agent → dealer unless own shop `dealer_rates_enabled === false` (no shop row → customer); everything else incl. admin → customer.
  - B `dialerGetsDealerRate` (dealer-rates.ts:10-13): `rateTier` if set else `role === "dealer"`.
  - C shop owner dealer OR admin (`shopOwnerIsDealer`, lib/ussd-shop/handlers/airtime.ts local copy).
  - D shop owner dealer ONLY (lib/airtime-service.ts:347-349, app/api/shop/airtime/initialize/route.ts:204-205, public-constraints ~:50-54).
  - E dealer OR admin, sub_agent customer (app/api/shop/airtime/constraints ~:38-40).
  - F `role === "dealer"` (lib/products-catalog.ts:34).
  - G client re-implementation of A (app/dashboard/airtime/page.tsx ~:135-146).
  Mapping to a slug: a rule's "dealer" result → the caller's own role slug **if that role is a custom (non-system) role**, else `"dealer"`; a "customer" result → own custom slug if custom, else `"user"`. (Today no custom roles exist, so slugs are only "dealer"/"user".)
- Cashback: storefront and bot quotes stay hard-wired to the customer share (unchanged). Only the buyer-tier paths (`getBuyerTier`, airtime-service `isBuyerDealer`) move.
- **Failure handling:** a `role_service_rates`/roles read failure on a CHARGE path refuses the purchase before any debit/payment (same as each path's existing settings-read failure); on DISPLAY paths fall back to the legacy tier value.
- Withdrawals are NOT role-dependent today → out of scope (per-role withdrawal perks are a new Phase 5 feature). Per-shop `airtime_markup_*` and `dealer_rates_enabled` unchanged.
- Migration 0186: one BEGIN/COMMIT, SET LOCALs, idempotent, PRE-CHECKS header, selftest, run string built with the hardened `lib/roles/migration-0185-run.ts` approach (copy to `migration-0186-run.ts`). Not applied by the implementer.
- `CUSTOM_ROLE_ASSIGNMENT_ENABLED` stays false. Edit/Write only, never `sed`. No PII in logs. TDD.

## Review Focus

1. **Admin buying airtime** gets exactly today's rate on every channel (customer on wallet/USSD/AI; dealer as a shop owner in bots/constraints; customer as a shop owner on wallet/initialize). Test in Tasks 3–4.
2. **Sub-agent with `dealer_rates_enabled` false vs true** keeps customer vs dealer rate. Test in Task 3.
3. **Missing legacy key** (default 5%) still defaults the same. Test in Task 2.
4. **Cashback share for a dealer on bills/standard bundles/v1/v2 bundles** unchanged; storefront/bots still customer share. Test in Task 5.
5. **Read failure** on a charge path refuses before any debit. Test in Tasks 3–5.

---

### Task 1: Migration 0186 — `role_service_rates`

**Files:** Create `migrations/0186_role_service_rates.sql`, `.selftest.sql`, `lib/roles/migration-0186-run.ts` (copy of migration-0185-run.ts, labels 0186), `lib/roles/migration-0186.test.ts`.

- Table `public.role_service_rates(role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE, service_key text NOT NULL CHECK (service_key ~ '^[a-z_]+:[a-z0-9_]+$'), value numeric(6,2) NOT NULL CHECK (value >= 0 AND value <= 100), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (role_id, service_key))`. RLS on, zero policies, REVOKE from PUBLIC/anon/authenticated, service_role grants. No seed, no triggers.
- Service keys used in this phase: `airtime_fee:mtn|telecel|at`, `cashback_share:airtime|bundles|bills` and `cashback_share:<serviceKey>` for per-service overrides (serviceKey normalised to `[a-z0-9_]`).
- PRE-CHECKS: `to_regclass('public.role_service_rates')` NULL; `to_regclass('public.roles')` NOT NULL.
- [ ] Tests: text rules + run-string safety (reuse 0185's negative cases); selftest (distinct FAILs): table exists, RLS on, 0 policies, anon/authenticated no privilege, CHECK rejects 101 and -1 and a bad key, FK cascade on role delete (temp custom role), PK uniqueness. PGlite runner in scratchpad → SELFTEST_OK 0186, rollback leaves no table, apply twice OK.
- [ ] Commit `feat(roles): 0186 role_service_rates table (not applied)`.

### Task 2: Rate resolver

**Files:** Create `lib/roles/service-rates.ts` + test.

```ts
export type LegacyRates = { customer: number; dealer: number }
/** Pure: walk priceLadder(slug); first row found wins; reaching "dealer" → legacy.dealer; reaching "user" → legacy.customer; empty/unknown ladder → legacy.customer. */
export function resolveServiceRate(slug: string, serviceKey: string, roles: readonly RoleRow[], rows: ReadonlyMap<string, ReadonlyMap<string, number>>, legacy: LegacyRates): number
/** Loads roles + this ladder's rows for the keys (one query each; fail-closed RoleReadError). */
export async function serviceRatesFor(client, slug: string, serviceKeys: readonly string[], legacy: (key: string) => LegacyRates): Promise<Map<string, number>>
/** A tier decision ("dealer"|"customer") + the caller's real role → the slug to resolve with (custom role keeps its own slug). */
export function rateSlug(tierIsDealer: boolean, role: string | null | undefined, roles: readonly RoleRow[]): string
```
- [ ] Tests: empty table → dealer slug = legacy.dealer, user = legacy.customer, unknown = legacy.customer; custom role row wins; custom role without row falls to next lower (dealer → legacy.dealer); `rateSlug(true,"admin")`→"dealer", `(false,"admin")`→"user", `(true,"gold")`→"gold" when gold is a non-system role; read failure → RoleReadError.
- [ ] Commit `feat(roles): per-role service rate resolver with legacy fallback`.

### Task 3: Airtime — central rate + bot/USSD/SMS/AI callers

**Files:** Modify `lib/airtime-pricing.ts:46-51` (add `airtimeFeeRateFor(network, slug)` using Task 2 with legacy = today's two `admin_settings` keys incl. the default-5 rule; keep `airtimeBaseFeeRate(network, isDealer)` as a thin wrapper `→ airtimeFeeRateFor(network, isDealer ? "dealer" : "user")` so untouched callers keep working), `lib/ussd/resolve-dialer.ts` (add `rateRole` next to `rateTier` via `rateSlug`), `lib/sub-agents/dealer-rates.ts` (add `dialerRateRole(d)` = `d.rateRole ?? (dialerGetsDealerRate(d) ? "dealer" : "user")`), callers: `lib/ussd/handlers/airtime.ts:~87-88,205,320`, `lib/ussd-hubtel/flows/airtime.ts:~45,116,192` (+ services.ts feeRate dep signature), `lib/text-to-buy/services/airtime.ts:~100`, `lib/ai-tools.ts:~1706,1818`, shop bots `lib/ussd-shop/handlers/airtime.ts:~61-79`, `lib/ussd-hubtel/shop-services.ts:~63`, `lib/whatsapp-bot/shop-router.ts:~153` (rule C preserved → slug via `rateSlug(shopOwnerIsDealer, ownerRole)`); tests.
- [ ] Tests per channel: dealer/admin/user/sub_agent(toggle on/off/no shop) rates identical to today's; a custom-role row (seeded in the fake) is used where its rule says so; settings/roles read failure → the channel's existing refusal before any charge.
- [ ] Commit `feat(roles): airtime fee rates resolve per role on bots and USSD`.

### Task 4: Airtime — web wallet, shop storefront, display

**Files:** `lib/airtime-service.ts:~347-376` (rule A buyer / rule D shop owner), `app/api/shop/airtime/initialize/route.ts:~204-207` (D), `app/api/shop/airtime/constraints/route.ts:~38-46` (E), `app/api/shop/airtime/public-constraints/route.ts:~50-54` (D), `lib/products-catalog.ts:~34,76` (F, display), `app/dashboard/airtime/page.tsx:~135-176` (G) — replace the client re-implementation with a server value: add the caller's effective airtime rates to an existing authenticated endpoint the page already calls (or a new `GET /api/airtime/my-rates` → `{ rates: { mtn, telecel, at } }`, Bearer auth, caller's own data only, no-store); tests.
- [ ] Tests: each site's numbers identical to today for dealer/admin/user/sub_agent; custom-role row used; charge-path read failure refuses before debit/payment; dashboard shows server rates (fallback: today's customer rate, never lower).
- [ ] Commit `feat(roles): web and shop airtime fees resolve per role`.

### Task 5: Cashback buyer share (bills, standard bundles, airtime, API bundles)

**Files:** `lib/cashback/quote.ts:~9,100-101` (buyer becomes a slug; share = `serviceRatesFor(...)` key `cashback_share:<serviceKey>` then `cashback_share:<group>`, legacy = today's `overrides[serviceKey]` / `shares[group]` customer & dealer — overrides precedence identical to today), `lib/bills/runtime.ts:~13` (`getBuyerTier` → also return the slug via `rateSlug`), callers `lib/bills/service.ts:~173`, `lib/standard-bundles/service.ts:~208`, `app/api/cashback/rates/route.ts:~25`, `app/api/v1/bundles/route.ts:~58`, `lib/api-v2/endpoints/bundles-deps.ts:~103`, `lib/airtime-service.ts:~376`, `lib/cashback/rates.ts:~15-37` (display); storefront/bot quotes untouched; tests.
- [ ] Tests: dealer/customer shares identical across all listed callers incl. per-service overrides; custom-role row used (group and per-service); storefront/bots still customer; read failure on charge refuses / on display falls back to legacy.
- [ ] Commit `feat(roles): cashback buyer share resolves per role`.

### Task 6: Verification

- [ ] tsc clean on touched paths; full vitest → only the 12 known pre-existing failures; placeholder build exit 0 (only when no implementer is editing).
- [ ] Final whole-range review (opus).
- [ ] Prod: 0186 precheck → hardened dry run → owner OK → apply → verify (table empty, RLS, grants). Code safe to deploy only AFTER 0186 (resolver reads the table).
