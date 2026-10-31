# Per-user Custom Data Bundle Prices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can put a user on "Custom price" and set a fixed price per data bundle package for them. That price is what the user pays on every channel, and it raises their shop or sub-agent profit without changing any shop's selling prices.

**Architecture:**
- A `users.pricing_mode` column (`role` | `custom`, default `role`) and a `user_package_prices` table. One transactional RPC is the only write path, and it audits every change to the existing `admin_audit_log` table.
- One pure resolver module (`lib/pricing/package-price.ts`) holds the price rule. Every charge point calls it in place of its own copy of "dealer_price if dealer, else price".
- Shop and sub-agent selling prices stay at role price + margin. Only the owner's profit changes, by (role price − custom price).

**Tech Stack:** Next.js route handlers, Supabase (Postgres + PostgREST, service-role client), Vitest, React (admin page with shadcn/ui `Dialog`).

**Spec:** `docs/superpowers/specs/2026-10-31-per-user-custom-prices-design.md`

---

## Decisions made while planning (differences from the spec)

1. **Audit log:** the spec proposed a new `user_package_price_audit` table. The repo already has `admin_audit_log` (`migrations/0069_admin_moderation_sms.sql`), which the bulk price tool uses. The RPC writes there instead, with `action = 'custom_price_set' | 'custom_price_removed' | 'pricing_mode_set'`.
2. **No global feature flag.** `pricing_mode` defaults to `role`, so nothing changes for anyone until an admin switches a user. The whole plan ships as one release: merge only after every task is done.
3. **Pages that stay on the role price, on purpose.** Selling prices are role price + margin, so these keep using the role price: `app/api/shop/public-packages`, `app/api/shop/invites/[code]`, `app/api/shop/dealer-price-list` (the public marketing list), `app/dashboard/shop-pricing` and `app/dashboard/sub-agent-catalog`. They are added to the guard test's allow-list in Task 12.
4. **Sub-agents** buying through their parent's catalog pay the parent's catalog price (`parent_price`), as today. A custom price replaces only the role price. The admin dialog says so for `sub_agent` users.
5. **Owner profit is never negative:** `max(0, margin + (role − cost))`.

## File map

| File | Change |
|---|---|
| `migrations/0142_user_package_prices.sql` | **Create.** Column, table, row-level security (RLS), self-update policy, RPC |
| `lib/pricing/migration.test.ts` | **Create.** Checks the migration text |
| `lib/pricing/package-price.ts` | **Create.** `rolePrice`, `effectivePrice`, `ownerSaving`, `getCustomPrices`, `customPricesForUser`, `CustomPriceReadError` |
| `lib/pricing/package-price.test.ts` | **Create** |
| `app/api/orders/purchase/route.ts` | Use the resolver |
| `app/api/orders/create-bulk/route.ts` | Use the resolver |
| `app/api/v1/orders/route.ts` | Use the resolver |
| `lib/products-catalog.ts` (+ `app/api/v1/products/route.ts`) | Use the resolver |
| `lib/api-v2/data-orders.ts`, `lib/api-v2/endpoints/data.ts`, `lib/api-v2/endpoints/data-deps.ts` | `priceForRole` delegates; new `customPrices` dep |
| `lib/ussd/handlers/bundles.ts` | `fetchBundles` and `handleConfirm` use the resolver |
| `lib/ussd-hubtel/catalog.ts`, `lib/ussd-hubtel/flows/data.ts`, `lib/ussd-hubtel/services.ts` | `priceForTier` takes custom prices |
| `lib/whatsapp-bot/router.ts` | `loadAllBundlesWa` uses the resolver |
| `lib/ai-tools.ts` | Two price sites use the resolver |
| `lib/shop-commerce/pricing.ts` | `shopOwnerPricing`; profit includes owner saving |
| `app/api/shop/orders/create/route.ts` | Profit and parent profit include owner saving |
| `app/api/admin/users/[id]/custom-prices/route.ts` | **Create.** Admin `GET` / `PUT` |
| `app/api/admin/users/[id]/custom-prices/route.test.ts` | **Create** |
| `lib/pricing/custom-prices-input.ts` (+ test) | **Create.** Pure validation of the `PUT` body |
| `components/admin/CustomPricesDialog.tsx` | **Create.** The dialog |
| `app/admin/users/page.tsx` | "Custom prices" action, badge, filter |
| `app/api/admin/users/route.ts` | Return `pricing_mode` in the list |
| `app/api/user/package-prices/route.ts` | **Create.** The caller's resolved prices, for displays |
| `app/api/shop/dealer-packages/route.ts` | Custom price in the `price` field |
| `app/dashboard/data-packages/page.tsx`, `app/dashboard/buy-stock/page.tsx` | Show the resolved price |
| `lib/pricing/guard.test.ts` | **Create.** No price rule outside the resolver |

Run all tests with `npx vitest run <path>`. Type-check with `npx tsc --noEmit -p .`. If `node_modules` is missing, run `npm ci` first.

---

### Task 1: Migration

**Files:**
- Create: `migrations/0142_user_package_prices.sql`
- Test: `lib/pricing/migration.test.ts`

The next free migration number was 0142 when this plan was written. If 0142 is taken, use the next one and rename the file and the test's file name to match.

- [ ] **Step 1: Write the failing test**

```ts
// lib/pricing/migration.test.ts
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const sql = readFileSync(join(process.cwd(), "migrations", "0142_user_package_prices.sql"), "utf8")

describe("0142_user_package_prices.sql", () => {
  it("adds users.pricing_mode with a role/custom check, default role", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS pricing_mode text NOT NULL DEFAULT 'role'/)
    expect(sql).toMatch(/CHECK \(pricing_mode IN \('role', 'custom'\)\)/)
  })

  it("creates user_package_prices keyed by (user_id, package_id) with a bounded price", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.user_package_prices/)
    expect(sql).toMatch(/PRIMARY KEY \(user_id, package_id\)/)
    expect(sql).toMatch(/CHECK \(price > 0 AND price <= 10000\)/)
    expect(sql).toMatch(/REFERENCES public\.users\(id\) ON DELETE CASCADE/)
    expect(sql).toMatch(/REFERENCES public\.packages\(id\) ON DELETE CASCADE/)
  })

  it("enables RLS and lets users read only their own rows", () => {
    expect(sql).toMatch(/ALTER TABLE public\.user_package_prices ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/FOR SELECT\s+USING \(user_id = \(SELECT auth\.uid\(\)\)\)/)
  })

  it("stops users changing their own pricing_mode (extends the 0045 policy)", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.get_current_user_pricing_mode\(\)/)
    expect(sql).toMatch(/AND role = public\.get_current_user_role\(\)\s+AND pricing_mode = public\.get_current_user_pricing_mode\(\)/)
  })

  it("defines the service-role-only write RPC that audits to admin_audit_log", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.set_user_custom_prices\(\s*p_admin uuid,\s*p_user uuid,\s*p_mode text,\s*p_prices jsonb\s*\)/)
    expect(sql).toMatch(/INSERT INTO public\.admin_audit_log/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.set_user_custom_prices\(uuid, uuid, text, jsonb\) FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.set_user_custom_prices\(uuid, uuid, text, jsonb\) TO service_role/)
  })

  it("is one transaction", () => {
    expect(sql.trim().startsWith("--")).toBe(true)
    expect(sql).toMatch(/^BEGIN;$/m)
    expect(sql).toMatch(/^COMMIT;$/m)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/pricing/migration.test.ts`
Expected: FAIL with `ENOENT: no such file or directory ... 0142_user_package_prices.sql`

- [ ] **Step 3: Write the migration**

```sql
-- 0142_user_package_prices.sql
--
-- Per-user custom data bundle prices (spec: docs/superpowers/specs/2026-10-31-per-user-custom-prices-design.md).
-- ADDITIVE. Idempotent (re-runnable). One transaction. NOT applied by the implementing agent.
--
--   users.pricing_mode   'role' (default: normal role pricing) | 'custom' (saved custom prices apply)
--   user_package_prices  one fixed price per (user, package); a package with no row uses the role price
--   set_user_custom_prices(p_admin, p_user, p_mode, p_prices)  the ONLY write path (service role):
--     p_mode    'role' | 'custom' | NULL (NULL = leave the mode as it is)
--     p_prices  jsonb array of {"package_id": uuid, "price": number|null}; null deletes that custom price.
--               NULL or [] = no price changes.
--     Writes one admin_audit_log row per actual change. Returns {"changed": <int>}.
--     Errors: RAISE EXCEPTION 'BAD_INPUT' (detail says why) and nothing is written.

BEGIN;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pricing_mode text NOT NULL DEFAULT 'role';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_pricing_mode_check') THEN
    ALTER TABLE public.users ADD CONSTRAINT users_pricing_mode_check CHECK (pricing_mode IN ('role', 'custom'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_package_prices (
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES public.packages(id) ON DELETE CASCADE,
  price      numeric(10,2) NOT NULL CHECK (price > 0 AND price <= 10000),
  set_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, package_id)
);

ALTER TABLE public.user_package_prices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own custom prices" ON public.user_package_prices;
CREATE POLICY "Users read own custom prices" ON public.user_package_prices
  FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- Users must not switch themselves to custom pricing. Same SECURITY DEFINER pattern as 0045
-- (a subquery on public.users inside the policy would recurse).
CREATE OR REPLACE FUNCTION public.get_current_user_pricing_mode()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT pricing_mode FROM public.users WHERE id = auth.uid()
$$;

DROP POLICY IF EXISTS "Users can update own profile" ON public.users;
CREATE POLICY "Users can update own profile" ON public.users
  FOR UPDATE
  USING (id = (SELECT auth.uid()))
  WITH CHECK (
    id = (SELECT auth.uid())
    AND role = public.get_current_user_role()
    AND pricing_mode = public.get_current_user_pricing_mode()
  );

CREATE OR REPLACE FUNCTION public.set_user_custom_prices(
  p_admin uuid,
  p_user uuid,
  p_mode text,
  p_prices jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_old_mode text;
  v_item     jsonb;
  v_pkg      uuid;
  v_new      numeric(10,2);
  v_old      numeric(10,2);
  v_changed  integer := 0;
BEGIN
  IF p_admin IS NULL OR p_user IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'admin and user are required';
  END IF;

  -- Lock the user row: concurrent saves for one user run one after the other.
  SELECT pricing_mode INTO v_old_mode FROM public.users WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'user not found';
  END IF;

  IF p_mode IS NOT NULL THEN
    IF p_mode NOT IN ('role', 'custom') THEN
      RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'pricing_mode must be role or custom';
    END IF;
    IF p_mode <> v_old_mode THEN
      UPDATE public.users SET pricing_mode = p_mode WHERE id = p_user;
      INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
      VALUES (p_admin, 'pricing_mode_set', p_user,
              jsonb_build_object('pricing_mode', v_old_mode), jsonb_build_object('pricing_mode', p_mode));
      v_changed := v_changed + 1;
    END IF;
  END IF;

  IF p_prices IS NOT NULL THEN
    IF jsonb_typeof(p_prices) <> 'array' THEN
      RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'prices must be an array';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_prices) LOOP
      IF jsonb_typeof(v_item) <> 'object' OR NOT (v_item ? 'package_id') OR NOT (v_item ? 'price') THEN
        RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'each price needs package_id and price';
      END IF;
      v_pkg := (v_item->>'package_id')::uuid;
      IF NOT EXISTS (SELECT 1 FROM public.packages WHERE id = v_pkg) THEN
        RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'unknown package';
      END IF;

      SELECT price INTO v_old FROM public.user_package_prices WHERE user_id = p_user AND package_id = v_pkg;
      IF NOT FOUND THEN v_old := NULL; END IF;

      IF jsonb_typeof(v_item->'price') = 'null' THEN
        IF v_old IS NOT NULL THEN
          DELETE FROM public.user_package_prices WHERE user_id = p_user AND package_id = v_pkg;
          INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
          VALUES (p_admin, 'custom_price_removed', p_user,
                  jsonb_build_object('package_id', v_pkg, 'price', v_old), NULL);
          v_changed := v_changed + 1;
        END IF;
      ELSE
        IF jsonb_typeof(v_item->'price') <> 'number' THEN
          RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'price must be a number or null';
        END IF;
        v_new := (v_item->>'price')::numeric;
        IF v_new <= 0 OR v_new > 10000 OR v_new <> round(v_new, 2) THEN
          RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'price must be > 0, <= 10000, at most 2 decimals';
        END IF;
        IF v_old IS DISTINCT FROM v_new THEN
          INSERT INTO public.user_package_prices (user_id, package_id, price, set_by)
          VALUES (p_user, v_pkg, v_new, p_admin)
          ON CONFLICT (user_id, package_id)
          DO UPDATE SET price = EXCLUDED.price, set_by = EXCLUDED.set_by, updated_at = now();
          INSERT INTO public.admin_audit_log (admin_id, action, target_user_id, old_value, new_value)
          VALUES (p_admin, 'custom_price_set', p_user,
                  CASE WHEN v_old IS NULL THEN NULL ELSE jsonb_build_object('package_id', v_pkg, 'price', v_old) END,
                  jsonb_build_object('package_id', v_pkg, 'price', v_new));
          v_changed := v_changed + 1;
        END IF;
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('changed', v_changed);
END
$fn$;

REVOKE ALL ON FUNCTION public.set_user_custom_prices(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_custom_prices(uuid, uuid, text, jsonb) TO service_role;

COMMIT;

-- Verify after apply:
--   SELECT pricing_mode, count(*) FROM public.users GROUP BY 1;              -- all 'role'
--   SELECT count(*) FROM public.user_package_prices;                          -- 0
--   SELECT has_function_privilege('authenticated', 'public.set_user_custom_prices(uuid,uuid,text,jsonb)', 'EXECUTE'); -- false
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/pricing/migration.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add migrations/0142_user_package_prices.sql lib/pricing/migration.test.ts
git commit -m "feat(pricing): migration for per-user custom data prices"
```

---

### Task 2: Price resolver

**Files:**
- Create: `lib/pricing/package-price.ts`
- Test: `lib/pricing/package-price.test.ts`

`isDealer` is a boolean the caller works out exactly as it does today. Some callers count `admin` as a dealer (shop code) and some do not (dashboard purchase). Keeping that decision with the caller means switching to the resolver changes no existing price.

- [ ] **Step 1: Write the failing test**

```ts
// lib/pricing/package-price.test.ts
import { describe, it, expect } from "vitest"
import {
  CustomPriceReadError,
  NO_CUSTOM_PRICES,
  customPricesForUser,
  effectivePrice,
  getCustomPrices,
  ownerSaving,
  rolePrice,
} from "./package-price"

const pkg = { id: "p1", price: 10, dealer_price: 8 }

describe("rolePrice", () => {
  it("dealer gets dealer_price when > 0", () => expect(rolePrice(pkg, true)).toBe(8))
  it("dealer gets price when dealer_price is 0, null or missing", () => {
    expect(rolePrice({ id: "p", price: 10, dealer_price: 0 }, true)).toBe(10)
    expect(rolePrice({ id: "p", price: 10, dealer_price: null }, true)).toBe(10)
    expect(rolePrice({ id: "p", price: 10 }, true)).toBe(10)
  })
  it("non-dealer gets price", () => expect(rolePrice(pkg, false)).toBe(10))
  it("accepts numeric strings from PostgREST", () => expect(rolePrice({ id: "p", price: "10.50", dealer_price: "9.25" }, true)).toBe(9.25))
})

describe("effectivePrice", () => {
  it("custom price wins over the role price", () => {
    expect(effectivePrice(pkg, true, new Map([["p1", 7.5]]))).toBe(7.5)
    expect(effectivePrice(pkg, false, new Map([["p1", 7.5]]))).toBe(7.5)
  })
  it("falls back to the role price when the package has no custom price", () => {
    expect(effectivePrice(pkg, true, new Map([["other", 1]]))).toBe(8)
    expect(effectivePrice(pkg, false, NO_CUSTOM_PRICES)).toBe(10)
  })
})

describe("ownerSaving", () => {
  it("is role price minus custom price", () => expect(ownerSaving(pkg, true, new Map([["p1", 7]]))).toBe(1))
  it("is 0 with no custom price", () => expect(ownerSaving(pkg, true, NO_CUSTOM_PRICES)).toBe(0))
  it("is negative when the custom price is above the role price", () => expect(ownerSaving(pkg, false, new Map([["p1", 12]]))).toBe(-2))
  it("rounds to pesewas", () => expect(ownerSaving({ id: "p1", price: 10.1, dealer_price: null }, false, new Map([["p1", 9.9]]))).toBe(0.2))
})

// Minimal PostgREST-shaped fake: users -> single(); user_package_prices -> thenable.
function client(opts: { mode?: string | null; userError?: boolean; rows?: unknown[]; pricesError?: boolean }) {
  const calls: string[] = []
  return {
    calls,
    from(table: string) {
      calls.push(table)
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve(
            opts.userError
              ? { data: null, error: { message: "boom" } }
              : { data: opts.mode === null ? null : { pricing_mode: opts.mode ?? "role" }, error: null }
          ),
        then: (res: any, rej: any) =>
          Promise.resolve(opts.pricesError ? { data: null, error: { message: "boom" } } : { data: opts.rows ?? [], error: null }).then(res, rej),
      }
      return chain
    },
  }
}

describe("getCustomPrices", () => {
  it("returns nothing for no user", async () => {
    const c = client({})
    expect((await getCustomPrices(c as any, null)).size).toBe(0)
    expect(c.calls).toEqual([])
  })
  it("returns nothing in role mode without reading prices", async () => {
    const c = client({ mode: "role", rows: [{ package_id: "p1", price: 5 }] })
    expect((await getCustomPrices(c as any, "u1")).size).toBe(0)
    expect(c.calls).toEqual(["users"])
  })
  it("returns nothing when the user row is missing", async () => {
    expect((await getCustomPrices(client({ mode: null }) as any, "u1")).size).toBe(0)
  })
  it("returns the saved prices in custom mode", async () => {
    const m = await getCustomPrices(client({ mode: "custom", rows: [{ package_id: "p1", price: "5.50" }, { package_id: "p2", price: 3 }] }) as any, "u1")
    expect(m.get("p1")).toBe(5.5)
    expect(m.get("p2")).toBe(3)
  })
  it("throws CustomPriceReadError when the user read fails", async () => {
    await expect(getCustomPrices(client({ userError: true }) as any, "u1")).rejects.toBeInstanceOf(CustomPriceReadError)
  })
  it("throws CustomPriceReadError when the price read fails", async () => {
    await expect(getCustomPrices(client({ mode: "custom", pricesError: true }) as any, "u1")).rejects.toBeInstanceOf(CustomPriceReadError)
  })
  it("ignores malformed rows", async () => {
    const m = await getCustomPrices(client({ mode: "custom", rows: [{ package_id: "p1", price: "x" }, { package_id: null, price: 2 }, { package_id: "p3", price: 0 }] }) as any, "u1")
    expect(m.size).toBe(0)
  })
})

describe("customPricesForUser", () => {
  it("skips the users read when the mode is already known", async () => {
    const c = client({ rows: [{ package_id: "p1", price: 4 }] })
    const m = await customPricesForUser(c as any, { id: "u1", pricing_mode: "custom" })
    expect(m.get("p1")).toBe(4)
    expect(c.calls).toEqual(["user_package_prices"])
  })
  it("role mode reads nothing", async () => {
    const c = client({})
    expect((await customPricesForUser(c as any, { id: "u1", pricing_mode: "role" })).size).toBe(0)
    expect(c.calls).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/pricing/package-price.test.ts`
Expected: FAIL with `Failed to resolve import "./package-price"`

- [ ] **Step 3: Write the resolver**

```ts
// lib/pricing/package-price.ts
/**
 * The ONE place the data bundle price rule lives (spec: docs/superpowers/specs/2026-10-31-per-user-custom-prices-design.md).
 *
 *   role price      dealer_price when the caller is priced as a dealer and dealer_price > 0, else price
 *   effective price the user's custom price for the package when they are in 'custom' mode, else the role price
 *
 * `isDealer` is decided by each caller exactly as before (some count admins as dealers, some do not), so
 * moving a caller onto this module never changes an existing price.
 */

export type PricedPackage = {
  id: string | number
  price: number | string
  dealer_price?: number | string | null
}

/** package id -> custom price. Empty = no custom prices apply. */
export type CustomPrices = ReadonlyMap<string, number>

export const NO_CUSTOM_PRICES: CustomPrices = new Map()

export class CustomPriceReadError extends Error {
  constructor(message = "Could not read custom prices") {
    super(message)
    this.name = "CustomPriceReadError"
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function rolePrice(pkg: PricedPackage, isDealer: boolean): number {
  const dealer = pkg.dealer_price == null ? 0 : Number(pkg.dealer_price)
  return isDealer && dealer > 0 ? dealer : Number(pkg.price)
}

export function effectivePrice(pkg: PricedPackage, isDealer: boolean, custom: CustomPrices): number {
  const c = custom.get(String(pkg.id))
  return c !== undefined ? c : rolePrice(pkg, isDealer)
}

/**
 * How much less this owner pays than their role price (negative when the custom price is higher).
 * Shops sell at role price + margin; the owner's profit is margin + ownerSaving.
 */
export function ownerSaving(pkg: PricedPackage, isDealer: boolean, custom: CustomPrices): number {
  return round2(rolePrice(pkg, isDealer) - effectivePrice(pkg, isDealer, custom))
}

/** Minimal client shape (the service-role Supabase client satisfies it). */
type ClientLike = { from(table: string): any }

async function readPrices(client: ClientLike, userId: string): Promise<CustomPrices> {
  let res: { data: unknown; error: unknown }
  try {
    res = await client.from("user_package_prices").select("package_id, price").eq("user_id", userId)
  } catch {
    throw new CustomPriceReadError()
  }
  if (res.error || !Array.isArray(res.data)) throw new CustomPriceReadError()
  const out = new Map<string, number>()
  for (const row of res.data as Array<{ package_id: unknown; price: unknown }>) {
    const price = Number(row.price)
    if (row.package_id == null || !Number.isFinite(price) || price <= 0) continue
    out.set(String(row.package_id), price)
  }
  return out
}

/** Use when the caller already loaded the user's pricing_mode (saves a query). */
export async function customPricesForUser(
  client: ClientLike,
  user: { id: string; pricing_mode?: string | null } | null | undefined
): Promise<CustomPrices> {
  if (!user?.id || user.pricing_mode !== "custom") return NO_CUSTOM_PRICES
  return readPrices(client, user.id)
}

/**
 * The custom prices that apply to this user right now: empty unless users.pricing_mode = 'custom'.
 * Read fresh on every call (never cached), so an admin's change applies to the next request.
 * Throws CustomPriceReadError on any read failure: charge paths must refuse the request, never fall back.
 */
export async function getCustomPrices(client: ClientLike, userId: string | null | undefined): Promise<CustomPrices> {
  if (!userId) return NO_CUSTOM_PRICES
  let res: { data: { pricing_mode?: string } | null; error: unknown }
  try {
    res = await client.from("users").select("pricing_mode").eq("id", userId).maybeSingle()
  } catch {
    throw new CustomPriceReadError()
  }
  if (res.error) throw new CustomPriceReadError()
  return customPricesForUser(client, res.data ? { id: userId, pricing_mode: res.data.pricing_mode } : null)
}

/** Charge-path message when custom prices cannot be read. Nothing has been charged. */
export const MSG_PRICES_UNAVAILABLE = "Prices are temporarily unavailable. Please try again."
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/pricing/package-price.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add lib/pricing/package-price.ts lib/pricing/package-price.test.ts
git commit -m "feat(pricing): shared data bundle price resolver"
```

---

### Task 3: Dashboard purchase and bulk orders

**Files:**
- Modify: `app/api/orders/purchase/route.ts:169-197`
- Modify: `app/api/orders/create-bulk/route.ts:140-182`

These routes have no tests, and their price logic becomes a single resolver call, which Task 2 covers. Task 12's guard test keeps them on the resolver.

- [ ] **Step 1: Update `app/api/orders/purchase/route.ts`**

Add the import beside the other imports at the top:

```ts
import { CustomPriceReadError, MSG_PRICES_UNAVAILABLE, effectivePrice, getCustomPrices } from "@/lib/pricing/package-price"
```

Replace:

```ts
    // Determine correct price based on role
    let validatedPrice = packageData.price
    if (userRole === "dealer" && packageData.dealer_price && packageData.dealer_price > 0) {
      validatedPrice = packageData.dealer_price
    }
```

with:

```ts
    // Role price, or the user's custom price when an admin has put them on custom pricing.
    // A failed custom-price read refuses the purchase (nothing debited): never charge a possibly wrong price.
    let validatedPrice: number
    try {
      const custom = await getCustomPrices(supabaseAdmin, userId)
      validatedPrice = effectivePrice({ id: packageId, ...packageData }, userRole === "dealer", custom)
    } catch (e) {
      if (e instanceof CustomPriceReadError) {
        return NextResponse.json({ error: MSG_PRICES_UNAVAILABLE }, { status: 503 })
      }
      throw e
    }
```

- [ ] **Step 2: Update `app/api/orders/create-bulk/route.ts`**

Add the same import. Change the package select to include `id`:

```ts
      .select("id, network, size, price, dealer_price")
```

After `const userRole = userData?.role || "user"`, add:

```ts
    let custom: Awaited<ReturnType<typeof getCustomPrices>>
    try {
      custom = await getCustomPrices(supabase, userId)
    } catch (e) {
      if (e instanceof CustomPriceReadError) {
        return NextResponse.json({ error: MSG_PRICES_UNAVAILABLE }, { status: 503 })
      }
      throw e
    }
```

Replace:

```ts
        verifiedPrice = (userRole === "dealer" && pkg.dealer_price && pkg.dealer_price > 0)
          ? pkg.dealer_price
          : pkg.price
```

with:

```ts
        verifiedPrice = effectivePrice(pkg, userRole === "dealer", custom)
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p . 2>&1 | grep -E "orders/(purchase|create-bulk)"`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add app/api/orders/purchase/route.ts app/api/orders/create-bulk/route.ts
git commit -m "feat(pricing): dashboard purchase and bulk orders use custom prices"
```

---

### Task 4: API v1 orders and products catalog

**Files:**
- Modify: `app/api/v1/orders/route.ts:160-173`
- Modify: `lib/products-catalog.ts:31-62`, `app/api/v1/products/route.ts`
- Test: `lib/products-catalog.test.ts`

- [ ] **Step 1: Write the failing catalog test**

In `lib/products-catalog.test.ts`, the hoisted fake handles `packages` and `afa_registration_prices`. Give the existing `packagesRows` fixtures ids (`id: "p1"`, `"p5"`, `"p2"`, in both the initial state and `beforeEach`), and add state and two tables to `fake.from`:

```ts
    // in state:
    pricingMode: "role" as string,
    customRows: [] as { package_id: string; price: number }[],

    // in fake.from, before the throw:
      if (table === "users") {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { pricing_mode: state.pricingMode }, error: null }) }) }) }
      }
      if (table === "user_package_prices") {
        return { select: () => ({ eq: () => Promise.resolve({ data: state.customRows, error: null }) }) }
      }
```

Reset both in `beforeEach` (`h.state.pricingMode = "role"; h.state.customRows = []`). Then add these to `describe("buildProductsCatalog")`:

```ts
  it("data bundles use the user's custom price in custom mode", async () => {
    h.state.pricingMode = "custom"
    h.state.customRows = [{ package_id: "p1", price: 4.25 }]
    const res = await buildProductsCatalog("dealer", "u1")
    expect(res.data_bundles.find((b) => b.network === "MTN" && b.size_gb === "1")!.price).toBe(4.25)
    expect(res.data_bundles.find((b) => b.network === "MTN" && b.size_gb === "5")!.price).toBe(24.5)
  })

  it("custom prices are ignored in role mode", async () => {
    h.state.customRows = [{ package_id: "p1", price: 4.25 }]
    const res = await buildProductsCatalog("dealer", "u1")
    expect(res.data_bundles.find((b) => b.network === "MTN" && b.size_gb === "1")!.price).toBe(5.8)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/products-catalog.test.ts`
Expected: FAIL; the custom-mode test gets 5.8 instead of 4.25.

- [ ] **Step 3: Update `lib/products-catalog.ts`**

```ts
import { effectivePrice, getCustomPrices, NO_CUSTOM_PRICES, type CustomPrices } from "@/lib/pricing/package-price"

export async function buildProductsCatalog(role: string, userId?: string): Promise<ProductsCatalogResponse> {
  const isDealer = role === "dealer"
  // Display only: on a read failure show role prices (the order endpoint re-prices and refuses on failure).
  const custom = await getCustomPrices(supabase, userId).catch(() => NO_CUSTOM_PRICES)

  const [dataBundles, airtime, resultsChecker, afa] = await Promise.all([
    buildDataBundles(isDealer, custom),
    buildAirtime(isDealer),
    buildResultsChecker(),
    buildAfa(),
  ])

  return { data_bundles: dataBundles, airtime, results_checker: resultsChecker, afa }
}

async function buildDataBundles(isDealer: boolean, custom: CustomPrices): Promise<ProductsCatalogResponse["data_bundles"]> {
  const { data, error } = await supabase
    .from("packages")
    .select("id, network, size, price, dealer_price")
    .eq("is_available", true)

  if (error) {
    console.error("[PRODUCTS-CATALOG] Failed to fetch packages:", error)
    return []
  }
  if (!data) return []

  return data.map((row: any) => ({
    network: row.network,
    size_gb: row.size,
    price: effectivePrice(row, isDealer, custom),
  }))
}
```

In `app/api/v1/products/route.ts`, pass the authenticated user's id into `buildProductsCatalog`. The route already loads the API user to get `role`; pass that user's `id` as the second argument.

- [ ] **Step 4: Update `app/api/v1/orders/route.ts`**

Add the import:

```ts
import { CustomPriceReadError, effectivePrice, getCustomPrices } from "@/lib/pricing/package-price"
```

Replace:

```ts
  const orderPrice = user.role === "dealer" && pkg.dealer_price > 0 ? Number(pkg.dealer_price) : Number(pkg.price)
```

with:

```ts
  let orderPrice: number
  try {
    orderPrice = effectivePrice(pkg, user.role === "dealer", await getCustomPrices(supabase, user.id))
  } catch (e) {
    if (e instanceof CustomPriceReadError) {
      return NextResponse.json({ success: false, error: "Prices are temporarily unavailable. Please retry." }, { status: 503 })
    }
    throw e
  }
```

- [ ] **Step 5: Run the tests and type-check**

Run: `npx vitest run lib/products-catalog.test.ts app/api/v1 && npx tsc --noEmit -p . 2>&1 | grep -E "products-catalog|api/v1"`
Expected: tests PASS; no type errors listed

- [ ] **Step 6: Commit**

```bash
git add lib/products-catalog.ts lib/products-catalog.test.ts app/api/v1/products/route.ts app/api/v1/orders/route.ts
git commit -m "feat(pricing): API v1 orders and products use custom prices"
```

---

### Task 5: API v2 data endpoints

**Files:**
- Modify: `lib/api-v2/data-orders.ts:165-169`
- Modify: `lib/api-v2/endpoints/data.ts` (`DataDeps` at :86, `priceAndValidate` :322-334, bulk slots :441-462, packages list :704-716)
- Modify: `lib/api-v2/endpoints/data-deps.ts` (the `realDataDeps` wiring at :71)
- Test: `lib/api-v2/endpoints/data.test.ts`

- [ ] **Step 1: Write the failing tests**

In `lib/api-v2/endpoints/data.test.ts`, add `customPrices: vi.fn(async (_u: string) => new Map<string, number>() as ReadonlyMap<string, number>),` to the `deps` object in `makeDeps`, and `d.customPrices` to the array in `allFns`. Import `CustomPriceReadError` from `@/lib/pricing/package-price`. Then add, using the file's own `PKGS`, `body`, `LIVE` and `makeDeps`:

```ts
describe("custom prices", () => {
  it("live purchase charges the user's custom price", async () => {
    const d = makeDeps()
    d.customPrices.mockResolvedValue(new Map([["p-mtn-1", 3.25]]))
    await purchaseHandler(d)(body({ recipient: "0249990490", reference: "REF-CP1" }), LIVE)
    expect(d.store.placeV2Order.mock.calls[0][0]).toMatchObject({ price: 3.25, packageId: "p-mtn-1" })
    expect(d.customPrices).toHaveBeenCalledWith(LIVE.userId)
  })

  it("live purchase answers 503 and places nothing when custom prices cannot be read", async () => {
    const d = makeDeps()
    d.customPrices.mockRejectedValue(new CustomPriceReadError())
    const r = await purchaseHandler(d)(body({ recipient: "0249990491", reference: "REF-CP2" }), LIVE)
    expect(r.error?.status).toBe(503)
    expectNoMoney(d)
  })

  it("bulk prices each new order with the custom price", async () => {
    const d = makeDeps()
    d.customPrices.mockResolvedValue(new Map([["p-mtn-1", 3.25]]))
    await bulkHandler(d)({ orders: [body({ recipient: "0249990492", reference: "REF-CP3" })] }, LIVE)
    expect(d.store.placeV2Order.mock.calls[0][0]).toMatchObject({ price: 3.25 })
  })

  it("GET packages lists the custom price", async () => {
    const d = makeDeps()
    d.customPrices.mockResolvedValue(new Map([["p-mtn-1", 3.25]]))
    const r = await listPackagesHandler(d)({}, LIVE)
    expect((r.data as any).packages.find((p: any) => p.network === "MTN" && p.size_gb === 1).price).toBe(3.25)
  })
})
```

If the bulk body shape differs (check an existing `bulkHandler` test in this file), copy that test's request shape and keep the assertion.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/api-v2/endpoints/data.test.ts`
Expected: FAIL; the price is 8 (the dealer role price), and the 503 test places an order.

- [ ] **Step 3: Implement**

In `lib/api-v2/data-orders.ts`, replace `priceForRole` with:

```ts
import { effectivePrice, NO_CUSTOM_PRICES, type CustomPrices } from "@/lib/pricing/package-price"

/** v1 rule (dealers pay dealer_price when positive), plus the user's custom price when one applies. */
export function priceForRole(
  role: string,
  pkg: { id?: string; price: number; dealer_price: number | null },
  custom: CustomPrices = NO_CUSTOM_PRICES
): number {
  return effectivePrice({ id: pkg.id ?? "", ...pkg }, role === "dealer", custom)
}
```

In `lib/api-v2/endpoints/data.ts`, add to `DataDeps`:

```ts
  /** The caller's custom prices (empty unless they are on custom pricing). Throws CustomPriceReadError on a read failure. */
  customPrices(userId: string): Promise<CustomPrices>
```

Add a helper next to `priceAndValidate`:

```ts
/** null = the read failed; the caller answers 503 and places nothing. */
async function loadCustom(deps: DataDeps, ctx: V2Context): Promise<CustomPrices | null> {
  try {
    return await deps.customPrices(ctx.userId)
  } catch {
    return null
  }
}
```

In `priceAndValidate`, replace `const price = priceForRole(ctx.role, pkg)` with:

```ts
  const custom = await loadCustom(deps, ctx)
  if (!custom) return { ok: false, result: fail(503, MSG_UNAVAILABLE) }
  const price = priceForRole(ctx.role, pkg, custom)
```

In the bulk slot builder, load once inside the `if (hasNew) { ... }` block:

```ts
  let custom: CustomPrices = NO_CUSTOM_PRICES
  if (hasNew) {
    const rows = await deps.store.listAvailablePackages()
    if (!rows) return { ok: false, result: fail(503, MSG_UNAVAILABLE) }
    packages = usable(rows)
    cfg = await deps.prefixConfig()
    const c = await loadCustom(deps, ctx)
    if (!c) return { ok: false, result: fail(503, MSG_UNAVAILABLE) }
    custom = c
  }
```

and use `priceForRole(ctx.role, pkg, custom)` in `slots.push(...)`.

In the packages list handler, after `if (!rows) return fail(503, MSG_UNAVAILABLE)`:

```ts
    const custom = await loadCustom(deps, ctx)
    if (!custom) return fail(503, MSG_UNAVAILABLE)
```

and use `priceForRole(ctx.role, r, custom)`.

Import `CustomPrices` and `NO_CUSTOM_PRICES` from `@/lib/pricing/package-price` in `data.ts`.

In `lib/api-v2/endpoints/data-deps.ts`, add this to the returned deps object:

```ts
    customPrices: (userId) => getCustomPrices(client, userId),
```

with `import { getCustomPrices } from "@/lib/pricing/package-price"`.

Sandbox (test-key) purchases go through `priceAndValidate` too, so they also use custom prices, matching what live would charge.

- [ ] **Step 4: Run the tests and type-check**

Run: `npx vitest run lib/api-v2 app/api/v2 && npx tsc --noEmit -p . 2>&1 | grep -E "api-v2|api/v2"`
Expected: PASS; no type errors listed. Fix any other `DataDeps` fakes the type check reports by adding `customPrices: async () => new Map()`.

- [ ] **Step 5: Commit**

```bash
git add lib/api-v2 app/api/v2
git commit -m "feat(pricing): API v2 data endpoints use custom prices"
```

---

### Task 6: USSD, Hubtel USSD, WhatsApp and AI tools

**Files:**
- Modify: `lib/ussd/handlers/bundles.ts` (`fetchBundles` :34-81, callers :149, :191, :200, confirm :342-345)
- Modify: `lib/ussd-hubtel/catalog.ts:28-41`, `lib/ussd-hubtel/flows/data.ts:31,46,51,68,87-97`, `lib/ussd-hubtel/services.ts` (the `fetchBundles` dep)
- Modify: `lib/whatsapp-bot/router.ts:86-124` and its callers
- Modify: `lib/ai-tools.ts:1303-1308`, `:1925-1950`
- Test: `lib/ussd-hubtel/catalog.test.ts`, `lib/ussd-hubtel/flows/data` tests in `lib/ussd-hubtel/router.test.ts` where `deps.fetchBundles` is faked, and `lib/ai-tools.test.ts`

In these channels the custom price applies only to a caller matched to a user account (`userId` set) on the regular or dealer tier. The `sub_agent` tier keeps the parent's catalog price.

- [ ] **Step 1: Write the failing test for `priceForTier`**

Add to `lib/ussd-hubtel/catalog.test.ts`:

```ts
describe("priceForTier with custom prices", () => {
  const pkg = { id: "p1", price: 10, dealer_price: 8 }
  it("custom price wins on the dealer and regular tiers", () => {
    expect(priceForTier(pkg, "dealer", null, new Map([["p1", 6]])).price).toBe(6)
    expect(priceForTier(pkg, "regular", null, new Map([["p1", 6]])).price).toBe(6)
  })
  it("sub_agent tier keeps the parent's catalog price", () => {
    expect(priceForTier(pkg, "sub_agent", { parent_price: 9, wholesale_margin: 1 }, new Map([["p1", 6]])).price).toBe(9)
  })
  it("no custom prices = unchanged", () => {
    expect(priceForTier(pkg, "dealer").price).toBe(8)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/ussd-hubtel/catalog.test.ts`
Expected: FAIL; it gets 8 or 10 instead of 6.

- [ ] **Step 3: Implement `priceForTier`**

In `lib/ussd-hubtel/catalog.ts`:

```ts
import { effectivePrice, NO_CUSTOM_PRICES, type CustomPrices } from "@/lib/pricing/package-price"

/** Mirrors the price verification in lib/ussd/handlers/bundles.ts handleConfirm. */
export function priceForTier(
  pkg: { id?: string; price: number | string; dealer_price?: number | string | null },
  tier: string,
  catalogRow?: { parent_price: number | string; wholesale_margin: number | string } | null,
  custom: CustomPrices = NO_CUSTOM_PRICES
): { price: number; parentProfit: number | null } {
  if (tier === "sub_agent") {
    return {
      price: catalogRow ? Number(catalogRow.parent_price) : Number(pkg.price),
      parentProfit: catalogRow ? Number(catalogRow.wholesale_margin) : null,
    }
  }
  return { price: effectivePrice({ id: pkg.id ?? "", ...pkg }, tier === "dealer", custom), parentProfit: null }
}
```

- [ ] **Step 4: USSD `fetchBundles` and `handleConfirm` in `lib/ussd/handlers/bundles.ts`**

Add the import:

```ts
import { effectivePrice, getCustomPrices, NO_CUSTOM_PRICES, MSG_PRICES_UNAVAILABLE } from "@/lib/pricing/package-price"
```

Give `fetchBundles` a fifth parameter, `userId?: string`. In the regular/dealer branch:

```ts
  // Display: a failed read shows role prices; handleConfirm re-prices and refuses on failure.
  const custom = await getCustomPrices(supabase, userId).catch(() => NO_CUSTOM_PRICES)
  const bundles: BundleOption[] = (data ?? []).map((row: any) => ({
    id: row.id,
    size: row.size,
    price: effectivePrice(row, priceTier === 'dealer', custom),
  }))
```

Pass the user id at the three call sites: `userRow?.id` at :149, and `session.userId` at :191 and :200.

In `handleConfirm`, change the package select to include `id` if it does not already, and replace:

```ts
    const useDealer = priceTier === 'dealer' && pkg.dealer_price && Number(pkg.dealer_price) > 0
    verifiedPrice = useDealer ? Number(pkg.dealer_price) : Number(pkg.price)
```

with:

```ts
    let custom
    try {
      custom = await getCustomPrices(supabase, session.userId)
    } catch {
      return endSession(MSG_PRICES_UNAVAILABLE)
    }
    verifiedPrice = effectivePrice({ id: bundleId!, ...pkg }, priceTier === 'dealer', custom)
```

Use the end-session helper `handleConfirm` already uses for its "Package no longer available" exit (read the function and call the same helper with the same argument shape).

- [ ] **Step 5: Hubtel USSD `lib/ussd-hubtel/flows/data.ts`**

`deps.fetchBundles` has the same signature as the USSD `fetchBundles`. Pass `caller.userId` at :31 and `session.userId` at :46, :51 and :68; Hubtel sessions carry `userId` from `CallerContext`. Update the `fetchBundles` dep type in `lib/ussd-hubtel/services.ts` and in the flow-kit deps interface to take the optional `userId`.

At confirm (:87-97), change the select to `"id, price, dealer_price, is_available"`, then:

```ts
  let custom
  try {
    custom = await getCustomPrices(deps.supabase, session.userId)
  } catch {
    return finish(ctx, MSG_PRICES_UNAVAILABLE)
  }
  const { price, parentProfit } = priceForTier(pkg, tier, catalogRow, custom)
```

with `import { getCustomPrices, MSG_PRICES_UNAVAILABLE } from "@/lib/pricing/package-price"`.

- [ ] **Step 6: WhatsApp `lib/whatsapp-bot/router.ts`**

Give `loadAllBundlesWa` a fourth parameter, `userId?: string`, and replace the regular/dealer mapping with:

```ts
  const custom = await getCustomPrices(supabase, userId).catch(() => NO_CUSTOM_PRICES)
  return (data ?? []).map((r: any) => ({
    id: r.id,
    size: String(r.size),
    price: effectivePrice(r, priceTier === 'dealer', custom),
  }))
```

Pass `session.userId` at every call of `loadAllBundlesWa` (`grep -n "loadAllBundlesWa(" lib/whatsapp-bot/router.ts`). The WhatsApp confirm step uses the USSD `handleConfirm` path, so Step 4 already covers the charge.

- [ ] **Step 7: AI tools `lib/ai-tools.ts`**

At :1303-1308 (`get_available_packages`, customer view), the function already knows the user (`ctx`). Before the `return sanitize(...)`:

```ts
        const custom = await getCustomPrices(supabaseAdmin, ctx.userId).catch(() => NO_CUSTOM_PRICES)
```

and use `price: effectivePrice(p as any, isDealer, custom)`. Use the user-id field `ctx` really has; read the tool context type at the top of the file.

At :1948, replace the `tierPrice` expression with:

```ts
        let tierPrice: number
        try {
          tierPrice = effectivePrice(pkg, effectivePriceTier === "dealer", await getCustomPrices(supabaseAdmin, resolvedUserId))
        } catch {
          return { error: "prices_unavailable", message: "Prices are temporarily unavailable. Ask the customer to try again shortly." }
        }
```

This only seeds a USSD order. The payment path re-prices in `handleConfirm`.

- [ ] **Step 8: Run the tests and type-check**

Run: `npx vitest run lib/ussd lib/ussd-hubtel lib/whatsapp-bot lib/ai-tools.test.ts && npx tsc --noEmit -p . 2>&1 | grep -E "ussd|whatsapp|ai-tools"`
Expected: PASS; no type errors listed. Where an existing fake `fetchBundles` or Supabase client now gets an extra `users` read, that read returns no `pricing_mode`, which means role mode, so prices are unchanged.

- [ ] **Step 9: Commit**

```bash
git add lib/ussd lib/ussd-hubtel lib/whatsapp-bot lib/ai-tools.ts lib/ai-tools.test.ts
git commit -m "feat(pricing): USSD, WhatsApp and AI tools use custom prices"
```

---

### Task 7: Shop pricing library (USSD shop, WhatsApp shop, Hubtel shop)

**Files:**
- Modify: `lib/shop-commerce/pricing.ts`
- Test: `lib/shop-commerce/pricing.test.ts`

Rule: selling prices do not change, and the owner's profit grows by `ownerSaving`.

- Direct shop: `verifiedPrice = role + margin` (unchanged); `profitAmount = max(0, margin + saving)`.
- Sub-agent, new model (`sub_agent_shop_packages`): `verifiedPrice = parent_price + sub margin` (unchanged); `parentProfitAmount = max(0, parent_price − parentCost)`, where `parentCost = effectivePrice` for the parent.
- Sub-agent, old model (`sub_agent_catalog`): `verifiedPrice = role + wholesale + sub margin` (unchanged); `parentProfitAmount = max(0, wholesale + saving)`.

- [ ] **Step 1: Write the failing tests**

Add to `lib/shop-commerce/pricing.test.ts`. The file's `fakeClient` returns one canned response per table, so `users` serves both the role read and the `pricing_mode` read:

```ts
describe("custom prices (owner saving)", () => {
  it("regular shop: selling price unchanged, profit includes the owner's saving", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer", pricing_mode: "custom" } },
      user_package_prices: { data: [{ package_id: "p1", price: 6 }] },
      shop_packages: { data: { profit_margin: 2, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } },
    })
    // role (dealer) 8 + margin 2 = 10 selling; saving 8 - 6 = 2 -> profit 4
    expect(await verifyBundlePrice("s1", "p1", undefined, client)).toEqual({ verifiedPrice: 10, profitAmount: 4, parentProfitAmount: 0 })
  })

  it("sub-agent new model: parent profit = parent_price - parent's custom cost", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "parent" } },
      users: { data: { role: "dealer", pricing_mode: "custom" } },
      user_package_prices: { data: [{ package_id: "p1", price: 6 }] },
      sub_agent_shop_packages: { data: { parent_price: 9, sub_agent_profit_margin: 1, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } },
    })
    expect(await verifyBundlePrice("sub", "p1", "parentShop", client)).toEqual({ verifiedPrice: 10, profitAmount: 1, parentProfitAmount: 3 })
  })

  it("sub-agent old model: parent profit = wholesale + saving, selling price unchanged", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "parent" } },
      users: { data: { role: "dealer", pricing_mode: "custom" } },
      user_package_prices: { data: [{ package_id: "p1", price: 6 }] },
      sub_agent_shop_packages: { data: null },
      sub_agent_catalog: { data: { wholesale_margin: 1, sub_agent_profit_margin: 1, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } },
    })
    // selling 8 + 1 + 1 = 10; parent profit 1 + (8 - 6) = 3
    expect(await verifyBundlePrice("sub", "p1", "parentShop", client)).toEqual({ verifiedPrice: 10, profitAmount: 1, parentProfitAmount: 3 })
  })

  it("profit never goes below 0 when the custom price is above the role price", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "user", pricing_mode: "custom" } },
      user_package_prices: { data: [{ package_id: "p1", price: 15 }] },
      shop_packages: { data: { profit_margin: 2, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } },
    })
    expect((await verifyBundlePrice("s1", "p1", undefined, client))!.profitAmount).toBe(0)
  })

  it("returns null (refuse) when the owner's custom prices cannot be read", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer", pricing_mode: "custom" } },
      user_package_prices: { data: null, error: { message: "boom" } },
      shop_packages: { data: { profit_margin: 2, packages: { id: "p1", price: 10, dealer_price: 8, is_available: true } } },
    })
    expect(await verifyBundlePrice("s1", "p1", undefined, client)).toBeNull()
  })

  it("fetchShopBundles selling prices are unchanged by custom prices", async () => {
    const client = fakeClient({
      user_shops: { data: { user_id: "u1" } },
      users: { data: { role: "dealer", pricing_mode: "custom" } },
      user_package_prices: { data: [{ package_id: "p1", price: 6 }] },
      shop_packages: { data: [{ package_id: "p1", profit_margin: 2 }] },
      packages: { data: [{ id: "p1", size: "1GB", price: 10, dealer_price: 8 }] },
    })
    expect((await fetchShopBundles("s1", "MTN", undefined, client))[0].price).toBe(10)
  })
})
```

The fake's `select().eq()` chain resolves to `{ data, error }`; for the `user_package_prices` read it must resolve an array. Pass `data` as an array as shown above.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run lib/shop-commerce/pricing.test.ts`
Expected: FAIL; profits come out without the saving (2, 1, 1), and the null case returns a price.

- [ ] **Step 3: Implement in `lib/shop-commerce/pricing.ts`**

Add the imports and a helper that reads the owner once:

```ts
import { customPricesForUser, effectivePrice, ownerSaving, rolePrice, type CustomPrices } from "@/lib/pricing/package-price"

/** The shop owner's pricing: dealer flag (dealer/admin, as shopOwnerIsDealer) and custom prices. Throws CustomPriceReadError. */
export async function shopOwnerPricing(
  shopId: string,
  client: SupabaseClientLike = supabase
): Promise<{ isDealer: boolean; custom: CustomPrices }> {
  const { data: shop } = await client.from("user_shops").select("user_id").eq("id", shopId).single()
  if (!shop?.user_id) return { isDealer: false, custom: new Map() }
  const { data: user } = await client.from("users").select("role, pricing_mode").eq("id", shop.user_id).single()
  const isDealer = user?.role === "dealer" || user?.role === "admin"
  const custom = await customPricesForUser(client, user ? { id: shop.user_id, pricing_mode: user.pricing_mode } : null)
  return { isDealer, custom }
}
```

Change `basePrice` to delegate (its tests keep passing):

```ts
export function basePrice(pkg: { price: number; dealer_price?: number | null }, isDealer: boolean): number {
  return rolePrice({ id: "", ...pkg }, isDealer)
}
```

`fetchShopBundles` stays on `basePrice` (role price). Selling prices must not change, so leave it alone.

In `verifyBundlePrice`:
- add `id` to every `packages!inner(...)` select (`packages!inner(id, price, dealer_price, is_available)`);
- replace `shopOwnerIsDealer(...)` there with `shopOwnerPricing(...)`;
- wrap the body in `try { ... } catch { return null }` so a `CustomPriceReadError` refuses the order (callers already treat null as "cannot sell this now").

The three branches become:

```ts
    // new model
    if (sapRow && (sapRow as any).packages?.is_available) {
      profitAmount = Number(sapRow.sub_agent_profit_margin)
      const cost = effectivePrice((sapRow as any).packages, parent.isDealer, parent.custom)
      parentProfitAmount = Math.max(0, Number(sapRow.parent_price) - cost)
      verifiedPrice = Number(sapRow.parent_price) + profitAmount
    }

    // old model
      const pkg = (catalogRow as any).packages
      profitAmount = Number(catalogRow.sub_agent_profit_margin)
      const wholesale = Number(catalogRow.wholesale_margin)
      parentProfitAmount = Math.max(0, wholesale + ownerSaving(pkg, parent.isDealer, parent.custom))
      verifiedPrice = basePrice(pkg, parent.isDealer) + wholesale + profitAmount

    // direct shop
    const pkg = (shopPkg as any).packages
    const margin = Number(shopPkg.profit_margin)
    profitAmount = Math.max(0, margin + ownerSaving(pkg, owner.isDealer, owner.custom))
    verifiedPrice = basePrice(pkg, owner.isDealer) + margin
```

Here `parent = await shopOwnerPricing(parentShopId, client)` and `owner` comes from `shopOwnerPricing(shopId, client)` in the existing `Promise.all`.

Keep `shopOwnerIsDealer` exported; the airtime callers still use it.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run lib/shop-commerce lib/ussd-hubtel lib/whatsapp-bot lib/ussd`
Expected: PASS, including every existing `fetchShopBundles` and `verifyBundlePrice` test unchanged.

- [ ] **Step 5: Commit**

```bash
git add lib/shop-commerce/pricing.ts lib/shop-commerce/pricing.test.ts
git commit -m "feat(pricing): shop owners' custom prices raise their profit, not selling prices"
```

---

### Task 8: Web storefront shop orders

**Files:**
- Modify: `app/api/shop/orders/create/route.ts` (direct shop :386-424, sub-agent parent profit :572-613)

The rule is the same as Task 7.

- [ ] **Step 1: Direct shop branch (:386-424)**

Replace the owner role lookup and price lines with:

```ts
      let owner: { isDealer: boolean; custom: CustomPrices }
      try {
        owner = await shopOwnerPricing(shop_id, supabase)
      } catch {
        return NextResponse.json({ error: MSG_PRICES_UNAVAILABLE }, { status: 503 })
      }
```

and change the select to `"profit_margin, packages(id, size, price, dealer_price, is_available)"`. Then:

```ts
      const pkg = shopPkg.packages as any
      verifiedSize = pkg?.size || ""
      // Selling price stays role price + margin; the owner's custom price only raises their profit.
      verifiedBasePrice = rolePrice(pkg, owner.isDealer)
      const margin = Number(shopPkg.profit_margin || 0)
      verifiedProfitMargin = Math.max(0, margin + ownerSaving(pkg, owner.isDealer, owner.custom))
      verifiedTotalPrice = verifiedBasePrice + margin
```

The `verifiedTotalPrice` line deliberately uses `margin`, not `verifiedProfitMargin`.

- [ ] **Step 2: Sub-agent parent profit (:572-613)**

Replace the parent role lookup with `shopOwnerPricing(parent_shop_id, supabase)` (on a throw, return the same 503), add `id` to `package:packages(id, price, dealer_price)`, and set:

```ts
          parent_profit_amount = Math.max(0, Number(catalogEntry.wholesale_margin || 0) + ownerSaving(pkg, parent.isDealer, parent.custom))
```

In the `sub_agent_catalog` fallback pricing block (:330-379), keep `verifiedBasePrice = adminPrice + margin`, which is the role price, so the selling price is unchanged. Compute `adminPrice` with `rolePrice(pkg, isParentDealer)` in place of the inline ternary.

Imports:

```ts
import { MSG_PRICES_UNAVAILABLE, ownerSaving, rolePrice, type CustomPrices } from "@/lib/pricing/package-price"
import { shopOwnerPricing } from "@/lib/shop-commerce/pricing"
```

- [ ] **Step 3: Type-check and run the shop tests**

Run: `npx tsc --noEmit -p . 2>&1 | grep "shop/orders/create"; npx vitest run lib/shop-commerce app/api/shop`
Expected: no type errors; tests PASS

- [ ] **Step 4: Commit**

```bash
git add app/api/shop/orders/create/route.ts
git commit -m "feat(pricing): storefront shop orders credit owner savings from custom prices"
```

---

### Task 9: Admin API

**Files:**
- Create: `lib/pricing/custom-prices-input.ts`, `lib/pricing/custom-prices-input.test.ts`
- Create: `app/api/admin/users/[id]/custom-prices/route.ts`, `app/api/admin/users/[id]/custom-prices/route.test.ts`

- [ ] **Step 1: Write the failing validation test**

```ts
// lib/pricing/custom-prices-input.test.ts
import { describe, it, expect } from "vitest"
import { parseCustomPricesBody } from "./custom-prices-input"

const P1 = "11111111-1111-1111-1111-111111111111"

describe("parseCustomPricesBody", () => {
  it("accepts a mode alone", () => expect(parseCustomPricesBody({ pricing_mode: "custom" })).toEqual({ ok: true, value: { pricing_mode: "custom", prices: [] } }))
  it("accepts prices and null removals", () => {
    expect(parseCustomPricesBody({ prices: [{ package_id: P1, price: 5.5 }, { package_id: P1.replace(/1/g, "2"), price: null }] })).toEqual({
      ok: true,
      value: { pricing_mode: null, prices: [{ package_id: P1, price: 5.5 }, { package_id: P1.replace(/1/g, "2"), price: null }] },
    })
  })
  it("rejects an empty body", () => expect(parseCustomPricesBody({}).ok).toBe(false))
  it("rejects a bad mode", () => expect(parseCustomPricesBody({ pricing_mode: "vip" }).ok).toBe(false))
  it("rejects bad prices with per-row errors", () => {
    const r = parseCustomPricesBody({ prices: [{ package_id: P1, price: 0 }, { package_id: "x", price: 1 }, { package_id: P1, price: 1.234 }, { package_id: P1, price: 10001 }, { package_id: P1, price: "5" }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["0", "1", "2", "3", "4"])
  })
  it("rejects a duplicate package", () => expect(parseCustomPricesBody({ prices: [{ package_id: P1, price: 1 }, { package_id: P1, price: 2 }] }).ok).toBe(false))
  it("rejects more than 500 rows", () => expect(parseCustomPricesBody({ prices: Array.from({ length: 501 }, () => ({ package_id: P1, price: 1 })) }).ok).toBe(false))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/pricing/custom-prices-input.test.ts`
Expected: FAIL with `Failed to resolve import "./custom-prices-input"`

- [ ] **Step 3: Implement the validation**

```ts
// lib/pricing/custom-prices-input.ts
export type PricingMode = "role" | "custom"
export interface CustomPricesInput {
  pricing_mode: PricingMode | null
  prices: { package_id: string; price: number | null }[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_ROWS = 500

/** Same rules as the set_user_custom_prices RPC, checked up front so the admin gets per-row errors. */
export function parseCustomPricesBody(
  body: unknown
): { ok: true; value: CustomPricesInput } | { ok: false; error: string; errors: Record<string, string> } {
  const bad = (error: string, errors: Record<string, string> = {}) => ({ ok: false as const, error, errors })
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("Body must be an object")
  const b = body as Record<string, unknown>

  let pricing_mode: PricingMode | null = null
  if (b.pricing_mode !== undefined) {
    if (b.pricing_mode !== "role" && b.pricing_mode !== "custom") return bad("pricing_mode must be role or custom")
    pricing_mode = b.pricing_mode
  }

  const prices: CustomPricesInput["prices"] = []
  if (b.prices !== undefined) {
    if (!Array.isArray(b.prices)) return bad("prices must be an array")
    if (b.prices.length > MAX_ROWS) return bad(`At most ${MAX_ROWS} prices per save`)
    const errors: Record<string, string> = {}
    const seen = new Set<string>()
    b.prices.forEach((row, i) => {
      const r = (row ?? {}) as Record<string, unknown>
      if (typeof r.package_id !== "string" || !UUID.test(r.package_id)) return void (errors[i] = "Unknown package")
      if (seen.has(r.package_id)) return void (errors[i] = "Package listed twice")
      seen.add(r.package_id)
      if (r.price === null) return void prices.push({ package_id: r.package_id, price: null })
      const p = r.price
      if (typeof p !== "number" || !Number.isFinite(p)) return void (errors[i] = "Price must be a number")
      if (p <= 0) return void (errors[i] = "Price must be more than 0")
      if (p > 10000) return void (errors[i] = "Price must be at most 10,000")
      if (Math.round(p * 100) !== p * 100) return void (errors[i] = "At most 2 decimal places")
      prices.push({ package_id: r.package_id, price: p })
    })
    if (Object.keys(errors).length) return bad("Some prices are invalid", errors)
  }

  if (pricing_mode === null && prices.length === 0) return bad("Nothing to save")
  return { ok: true, value: { pricing_mode, prices } }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/pricing/custom-prices-input.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing route test**

```ts
// app/api/admin/users/[id]/custom-prices/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => {
  const state = {
    isAdmin: true,
    user: { id: "u1", role: "dealer", pricing_mode: "custom" } as any,
    packages: [{ id: "p1", network: "MTN", size: "1", price: 10, dealer_price: 8, is_available: true }],
    prices: [{ package_id: "p1", price: 6 }],
    rpcCalls: [] as any[],
    rpcError: null as any,
  }
  const chain = (result: any) => {
    const c: any = { select: () => c, eq: () => c, order: () => c, maybeSingle: () => Promise.resolve(result), then: (r: any, j: any) => Promise.resolve(result).then(r, j) }
    return c
  }
  const fake = {
    from: (t: string) =>
      t === "users" ? chain({ data: state.user, error: null })
      : t === "packages" ? chain({ data: state.packages, error: null })
      : t === "user_package_prices" ? chain({ data: state.prices, error: null })
      : (() => { throw new Error(`unexpected table ${t}`) })(),
    rpc: (name: string, args: any) => {
      state.rpcCalls.push({ name, args })
      return Promise.resolve(state.rpcError ? { data: null, error: state.rpcError } : { data: { changed: 1 }, error: null })
    },
  }
  return { state, fake }
})

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () =>
    h.state.isAdmin ? { isAdmin: true, userId: "admin-1" } : { isAdmin: false, errorResponse: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }) }
  ),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

import { GET, PUT } from "./route"

const ctx = { params: Promise.resolve({ id: "u1" }) }
const put = (body: unknown) => new NextRequest("http://x/api/admin/users/u1/custom-prices", { method: "PUT", body: JSON.stringify(body) })
const P1 = "11111111-1111-1111-1111-111111111111"

beforeEach(() => {
  h.state.isAdmin = true
  h.state.user = { id: "u1", role: "dealer", pricing_mode: "custom" }
  h.state.rpcCalls = []
  h.state.rpcError = null
})

describe("GET custom-prices", () => {
  it("403 for non-admins", async () => {
    h.state.isAdmin = false
    expect((await GET(new NextRequest("http://x"), ctx)).status).toBe(403)
  })
  it("returns mode, role and packages with custom prices", async () => {
    const res = await GET(new NextRequest("http://x"), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      user: { id: "u1", role: "dealer", pricing_mode: "custom" },
      packages: [{ id: "p1", network: "MTN", size: "1", price: 10, dealer_price: 8, role_price: 8, custom_price: 6 }],
    })
  })
  it("404 for an unknown user", async () => {
    h.state.user = null
    expect((await GET(new NextRequest("http://x"), ctx)).status).toBe(404)
  })
})

describe("PUT custom-prices", () => {
  it("403 for non-admins", async () => {
    h.state.isAdmin = false
    expect((await PUT(put({ pricing_mode: "role" }), ctx)).status).toBe(403)
  })
  it("400 with per-row errors and no RPC call on a bad price", async () => {
    const res = await PUT(put({ prices: [{ package_id: P1, price: -1 }] }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).errors).toEqual({ "0": "Price must be more than 0" })
    expect(h.state.rpcCalls).toEqual([])
  })
  it("calls the RPC once with the admin, user, mode and prices", async () => {
    const res = await PUT(put({ pricing_mode: "custom", prices: [{ package_id: P1, price: 5 }] }), ctx)
    expect(res.status).toBe(200)
    expect(h.state.rpcCalls).toEqual([{ name: "set_user_custom_prices", args: { p_admin: "admin-1", p_user: "u1", p_mode: "custom", p_prices: [{ package_id: P1, price: 5 }] } }])
  })
  it("maps an RPC BAD_INPUT to 400 and other errors to 500", async () => {
    h.state.rpcError = { message: "BAD_INPUT", details: "unknown package" }
    expect((await PUT(put({ pricing_mode: "custom" }), ctx)).status).toBe(400)
    h.state.rpcError = { message: "connection reset" }
    expect((await PUT(put({ pricing_mode: "custom" }), ctx)).status).toBe(500)
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run "app/api/admin/users/[id]/custom-prices"`
Expected: FAIL with `Failed to resolve import "./route"`

- [ ] **Step 7: Implement the route**

```ts
// app/api/admin/users/[id]/custom-prices/route.ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { rolePrice } from "@/lib/pricing/package-price"
import { parseCustomPricesBody } from "@/lib/pricing/custom-prices-input"

export const dynamic = "force-dynamic"

const supabase = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
type Ctx = { params: Promise<{ id: string }> }

/** A user's pricing mode and every available data package with their custom price (admin only). */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse
  const { id } = await params
  const db = supabase()

  const { data: user, error: userErr } = await db.from("users").select("id, role, pricing_mode").eq("id", id).maybeSingle()
  if (userErr) return NextResponse.json({ error: "Failed to load user" }, { status: 500 })
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })

  const [pkgs, prices] = await Promise.all([
    db.from("packages").select("id, network, size, price, dealer_price, is_available").eq("is_available", true).order("network").order("size"),
    db.from("user_package_prices").select("package_id, price").eq("user_id", id),
  ])
  if (pkgs.error || prices.error) return NextResponse.json({ error: "Failed to load prices" }, { status: 500 })

  const custom = new Map((prices.data ?? []).map((r: any) => [String(r.package_id), Number(r.price)]))
  // Same dealer rule the dashboard purchase path uses for this user.
  const isDealer = user.role === "dealer"
  return NextResponse.json({
    user: { id: user.id, role: user.role, pricing_mode: user.pricing_mode ?? "role" },
    packages: (pkgs.data ?? []).map((p: any) => ({
      id: p.id,
      network: p.network,
      size: p.size,
      price: Number(p.price),
      dealer_price: p.dealer_price == null ? null : Number(p.dealer_price),
      role_price: rolePrice(p, isDealer),
      custom_price: custom.get(String(p.id)) ?? null,
    })),
  })
}

/** Set the pricing mode and/or custom prices in one transaction (set_user_custom_prices RPC, audited). */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse
  if (!adminId) return NextResponse.json({ error: "Admin session required" }, { status: 403 })
  const { id } = await params

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const parsed = parseCustomPricesBody(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, errors: parsed.errors }, { status: 400 })

  const { data, error } = await supabase().rpc("set_user_custom_prices", {
    p_admin: adminId,
    p_user: id,
    p_mode: parsed.value.pricing_mode,
    p_prices: parsed.value.prices,
  })
  if (error) {
    if (String(error.message).includes("BAD_INPUT")) {
      return NextResponse.json({ error: (error as any).details || "Invalid input" }, { status: 400 })
    }
    console.error("[CUSTOM-PRICES] save failed:", error.message)
    return NextResponse.json({ error: "Failed to save prices" }, { status: 500 })
  }
  return NextResponse.json({ success: true, changed: (data as any)?.changed ?? 0 })
}
```

The `CRON_SECRET` bypass in `verifyAdminAccess` returns no `userId`, so `PUT` refuses it: every change must name a real admin for the audit log.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run lib/pricing "app/api/admin/users/[id]/custom-prices"`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add lib/pricing/custom-prices-input.ts lib/pricing/custom-prices-input.test.ts "app/api/admin/users/[id]/custom-prices"
git commit -m "feat(pricing): admin API to set a user's pricing mode and custom prices"
```

---

### Task 10: Admin dialog, badge and filter

**Files:**
- Create: `components/admin/CustomPricesDialog.tsx`
- Modify: `app/admin/users/page.tsx` (actions near :613-640, dialogs after :996)
- Modify: `app/api/admin/users/route.ts` (add `pricing_mode` to the list select)

- [ ] **Step 1: Create the dialog**

```tsx
// components/admin/CustomPricesDialog.tsx
"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { supabase } from "@/lib/supabase"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

type Mode = "role" | "custom"
interface Row { id: string; network: string; size: string; price: number; dealer_price: number | null; role_price: number; custom_price: number | null }

export function CustomPricesDialog({ userId, userLabel, open, onOpenChange, onSaved }: {
  userId: string | null
  userLabel: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: (mode: Mode) => void
}) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [role, setRole] = useState("")
  const [mode, setMode] = useState<Mode>("role")
  const [savedMode, setSavedMode] = useState<Mode>("role")
  const [rows, setRows] = useState<Row[]>([])
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  const authHeaders = async (): Promise<Record<string, string>> => {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
  }

  useEffect(() => {
    if (!open || !userId) return
    setLoading(true)
    setErrors({})
    ;(async () => {
      try {
        const res = await fetch(`/api/admin/users/${userId}/custom-prices`, { headers: await authHeaders(), cache: "no-store" })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || "Failed to load prices")
        setRole(json.user.role)
        setMode(json.user.pricing_mode)
        setSavedMode(json.user.pricing_mode)
        setRows(json.packages)
        setInputs(Object.fromEntries(json.packages.map((p: Row) => [p.id, p.custom_price == null ? "" : p.custom_price.toFixed(2)])))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to load prices")
        onOpenChange(false)
      } finally {
        setLoading(false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userId])

  const byNetwork = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of rows) m.set(r.network, [...(m.get(r.network) ?? []), r])
    return [...m.entries()]
  }, [rows])

  // Rows whose input differs from the saved custom price: a number to set, "" to remove.
  const changes = useMemo(() => rows.flatMap((r) => {
    const raw = (inputs[r.id] ?? "").trim()
    const saved = r.custom_price == null ? "" : r.custom_price.toFixed(2)
    if (raw === saved || (raw !== "" && Number(raw) === r.custom_price)) return []
    return [{ package_id: r.id, price: raw === "" ? null : Number(raw) }]
  }), [rows, inputs])

  const warningFor = (r: Row): string | null => {
    const raw = (inputs[r.id] ?? "").trim()
    if (raw === "" || !Number.isFinite(Number(raw))) return null
    const v = Number(raw)
    if (r.dealer_price != null && r.dealer_price > 0 && v < r.dealer_price) return "Below the dealer price: may be below cost"
    if (v > r.role_price) return "Above this user's role price: reduces their shop profit"
    return null
  }

  const save = async () => {
    if (!userId) return
    setSaving(true)
    setErrors({})
    try {
      const body: Record<string, unknown> = {}
      if (mode !== savedMode) body.pricing_mode = mode
      if (changes.length) body.prices = changes
      if (!Object.keys(body).length) {
        onOpenChange(false)
        return
      }
      const res = await fetch(`/api/admin/users/${userId}/custom-prices`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(await authHeaders()) },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) {
        // errors are keyed by index into `changes`; map back to package ids for the inputs.
        if (json.errors) setErrors(Object.fromEntries(Object.entries(json.errors).map(([i, msg]) => [changes[Number(i)]?.package_id, String(msg)])))
        throw new Error(json.error || "Failed to save")
      }
      toast.success("Prices saved")
      onSaved?.(mode)
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Custom prices: {userLabel}</DialogTitle>
          <DialogDescription>
            Fixed data bundle prices for this user. A blank price uses their normal {role || "role"} price.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium">Pricing</span>
              <div className="inline-flex rounded-md border p-0.5" role="radiogroup" aria-label="Pricing mode">
                {(["role", "custom"] as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => setMode(m)}
                    className={`rounded px-3 py-1 text-sm ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                  >
                    {m === "role" ? "Role price" : "Custom price"}
                  </button>
                ))}
              </div>
            </div>
            {mode === "role" && (
              <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                This user pays role prices. Custom prices below are saved but not in use until you switch to Custom price.
              </p>
            )}
            {role === "sub_agent" && (
              <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                Sub-agents buying through their parent's catalog still pay the parent's price.
              </p>
            )}

            {byNetwork.map(([network, list]) => (
              <section key={network} className="space-y-2">
                <h3 className="text-sm font-semibold">{network}</h3>
                {list.map((r) => {
                  const warn = warningFor(r)
                  return (
                    <div key={r.id} className="grid grid-cols-[4rem_1fr_7rem_auto] items-center gap-2 text-sm">
                      <span className="font-medium">{r.size}GB</span>
                      <span className="text-muted-foreground">
                        Role GHS {r.role_price.toFixed(2)}
                        {r.dealer_price != null && r.dealer_price > 0 && <> · Dealer {r.dealer_price.toFixed(2)}</>}
                      </span>
                      <Input
                        inputMode="decimal"
                        placeholder="—"
                        aria-label={`${network} ${r.size}GB custom price`}
                        value={inputs[r.id] ?? ""}
                        onChange={(e) => setInputs((s) => ({ ...s, [r.id]: e.target.value }))}
                      />
                      <Button type="button" variant="ghost" size="sm" disabled={!inputs[r.id]} onClick={() => setInputs((s) => ({ ...s, [r.id]: "" }))}>
                        Clear
                      </Button>
                      {(errors[r.id] || warn) && (
                        <p className={`col-span-4 text-xs ${errors[r.id] ? "text-destructive" : "text-warning"}`}>{errors[r.id] ?? warn}</p>
                      )}
                    </div>
                  )
                })}
              </section>
            ))}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

Check that the imports match the repo: `@/lib/supabase` (browser client), `sonner`, and `@/components/ui/{dialog,button,input}`. Use whatever `app/admin/users/page.tsx` imports for each one.

- [ ] **Step 2: Wire the dialog into `app/admin/users/page.tsx`**

- Add the state `const [customPricesUser, setCustomPricesUser] = useState<{ id: string; label: string } | null>(null)`.
- Next to the existing per-user action buttons (around :613-640), add a button styled like its neighbours with the label "Custom prices". Its `onClick` is `() => setCustomPricesUser({ id: user.id, label: user.email ?? user.id })`.
- After the last `</Dialog>` (:996 onward), render:

```tsx
        <CustomPricesDialog
          userId={customPricesUser?.id ?? null}
          userLabel={customPricesUser?.label ?? ""}
          open={!!customPricesUser}
          onOpenChange={(o) => { if (!o) setCustomPricesUser(null) }}
          onSaved={(mode) => setUsers((list) => list.map((u) => (u.id === customPricesUser?.id ? { ...u, pricing_mode: mode } : u)))}
        />
```

Use the page's real users-state setter name in place of `setUsers`.

- Badge: in the role cell of each user row, add `{user.pricing_mode === "custom" && <Badge variant="outline">Custom pricing</Badge>}`, using the page's existing `Badge` import, or a styled `span` if it has none.
- Filter: add a "Custom pricing only" option to the page's existing role filter control. It filters on `u.pricing_mode === "custom"`. Add `pricing_mode?: string` to the page's user type.

- [ ] **Step 3: Return `pricing_mode` from `app/api/admin/users/route.ts`**

Add `pricing_mode` to the `users` select list in the `GET` handler.

- [ ] **Step 4: Type-check, lint and smoke test in the browser**

Run: `npx tsc --noEmit -p . 2>&1 | grep -E "admin/users|CustomPricesDialog"; npx next lint --file components/admin/CustomPricesDialog.tsx --file app/admin/users/page.tsx`
Expected: no errors

Run the app with the `run` skill. Log in as an admin, open Admin → Users, click "Custom prices" on a test user, switch to Custom price, set one price, and save. Then reopen the dialog and check that the mode and price persisted. Check that the price shows on the user's dashboard (after Task 11).

- [ ] **Step 5: Commit**

```bash
git add components/admin/CustomPricesDialog.tsx app/admin/users/page.tsx app/api/admin/users/route.ts
git commit -m "feat(pricing): admin Custom prices dialog with role/custom toggle"
```

---

### Task 11: What the user sees

**Files:**
- Create: `app/api/user/package-prices/route.ts` (+ `route.test.ts`)
- Modify: `app/api/shop/dealer-packages/route.ts:38-61`
- Modify: `app/dashboard/data-packages/page.tsx:162-186`, `app/dashboard/buy-stock/page.tsx:163-172`

- [ ] **Step 1: Write the failing test for the caller's price endpoint**

```ts
// app/api/user/package-prices/route.test.ts
import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  user: { id: "u1" } as any,
  role: "dealer",
  mode: "custom",
  packages: [{ id: "p1", price: 10, dealer_price: 8 }, { id: "p2", price: 5, dealer_price: null }],
  prices: [{ package_id: "p1", price: 6 }],
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: h.user ? null : { message: "no" } }) },
    from: (t: string) => {
      const result =
        t === "users" ? { data: { role: h.role, pricing_mode: h.mode }, error: null }
        : t === "packages" ? { data: h.packages, error: null }
        : { data: h.prices, error: null }
      const c: any = { select: () => c, eq: () => c, single: () => Promise.resolve(result), maybeSingle: () => Promise.resolve(result), then: (r: any, j: any) => Promise.resolve(result).then(r, j) }
      return c
    },
  }),
}))

import { GET } from "./route"
const req = () => new NextRequest("http://x/api/user/package-prices", { headers: { Authorization: "Bearer t" } })

describe("GET /api/user/package-prices", () => {
  it("returns the caller's resolved price per package", async () => {
    const res = await GET(req())
    expect(await res.json()).toEqual({ pricing_mode: "custom", prices: { p1: 6, p2: 5 } })
  })
  it("401 without a valid session", async () => {
    h.user = null
    expect((await GET(req())).status).toBe(401)
    h.user = { id: "u1" }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/api/user/package-prices`
Expected: FAIL with `Failed to resolve import "./route"`

- [ ] **Step 3: Implement the endpoint**

```ts
// app/api/user/package-prices/route.ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { customPricesForUser, effectivePrice } from "@/lib/pricing/package-price"

export const dynamic = "force-dynamic"

/** The signed-in user's price for every available data package (display only; order routes re-price). */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (!auth?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data: authData, error: authErr } = await db.auth.getUser(auth.slice(7))
  if (authErr || !authData?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = authData.user.id

  const { data: user } = await db.from("users").select("role, pricing_mode").eq("id", userId).single()
  const { data: pkgs, error } = await db.from("packages").select("id, price, dealer_price").eq("is_available", true)
  if (error) return NextResponse.json({ error: "Failed to load prices" }, { status: 500 })

  let custom
  try {
    custom = await customPricesForUser(db, { id: userId, pricing_mode: user?.pricing_mode })
  } catch {
    return NextResponse.json({ error: "Failed to load prices" }, { status: 503 })
  }
  // Same dealer rule as /api/orders/purchase, the route this page buys through.
  const isDealer = user?.role === "dealer"
  const prices = Object.fromEntries((pkgs ?? []).map((p: any) => [p.id, effectivePrice(p, isDealer, custom)]))
  return NextResponse.json({ pricing_mode: user?.pricing_mode ?? "role", prices })
}
```

- [ ] **Step 4: Dashboard data packages page**

In `app/dashboard/data-packages/page.tsx` `loadPackages`, replace the `if (userRole === "dealer") { ... }` block with:

```ts
      let processedPackages = data || []
      // Server-resolved prices (role or custom) so the shown price is what /api/orders/purchase charges.
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const res = session?.access_token
          ? await fetch("/api/user/package-prices", { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" })
          : null
        if (res?.ok) {
          const { prices } = await res.json()
          processedPackages = processedPackages.map((pkg: any) => (prices[pkg.id] != null ? { ...pkg, price: prices[pkg.id] } : pkg))
        } else if (userRole === "dealer") {
          processedPackages = processedPackages.map((pkg: any) => ({ ...pkg, price: pkg.dealer_price > 0 ? pkg.dealer_price : pkg.price }))
        }
      } catch {
        if (userRole === "dealer") {
          processedPackages = processedPackages.map((pkg: any) => ({ ...pkg, price: pkg.dealer_price > 0 ? pkg.dealer_price : pkg.price }))
        }
      }
```

The fallback keeps today's display if the endpoint is unreachable. Add `app/dashboard/data-packages/page.tsx` to the guard test's allow-list in Task 12, because this fallback mentions `dealer_price`.

- [ ] **Step 5: Dealer packages API and buy-stock page**

In `app/api/shop/dealer-packages/route.ts`, select `pricing_mode` with `role`, and before the `map`:

```ts
        let custom
        try {
            custom = await customPricesForUser(supabase, { id: user.id, pricing_mode: userData.pricing_mode })
        } catch {
            return NextResponse.json({ error: "Prices are temporarily unavailable" }, { status: 503 })
        }
```

In the map, set `price: effectivePrice(pkg, true, custom)`. This route gives dealers and admins the dealer price, which matches what `shop/orders/create` verifies against for the dealer's own shop.

In `app/dashboard/buy-stock/page.tsx` :170, replace the `parent_price:` ternary with `parent_price: pkg.price`. The API now sends the resolved price.

- [ ] **Step 6: Run the tests and type-check**

Run: `npx vitest run app/api/user lib/pricing && npx tsc --noEmit -p . 2>&1 | grep -E "package-prices|dealer-packages|data-packages|buy-stock"`
Expected: PASS; no errors listed

- [ ] **Step 7: Commit**

```bash
git add app/api/user/package-prices app/api/shop/dealer-packages/route.ts app/dashboard/data-packages/page.tsx app/dashboard/buy-stock/page.tsx
git commit -m "feat(pricing): users see their custom prices on the dashboard"
```

---

### Task 12: Guard test against new copies of the price rule

**Files:**
- Create: `lib/pricing/guard.test.ts`

- [ ] **Step 1: Write the test**

```ts
// lib/pricing/guard.test.ts
import { describe, it, expect } from "vitest"
import { execSync } from "child_process"

// Files allowed to mention dealer_price. Every one either edits package prices (admin), shows the
// role price on purpose (selling prices stay role + margin), or only passes the column through.
const ALLOWED = new Set([
  "lib/pricing/package-price.ts",
  "lib/bulk-package-pricing.ts",
  "app/admin/packages/page.tsx",
  "app/api/admin/packages/route.ts",
  "app/api/admin/packages/bulk-update-price/route.ts",
  "app/api/admin/users/update-role/route.ts",
  "app/api/admin/users/[id]/custom-prices/route.ts",
  "components/admin/CustomPricesDialog.tsx",
  "lib/api-v2/order-store.ts",
  "lib/api-v2/bundles.ts",
  "app/api/shop/public-packages/route.ts",
  "app/api/shop/invites/[code]/route.ts",
  "app/api/shop/dealer-price-list/route.ts",
  "app/api/shop/sub-agent-catalog/route.ts",
  "app/api/shop/parent-packages/route.ts",
  "app/dashboard/shop-pricing/page.tsx",
  "app/dashboard/sub-agent-catalog/page.tsx",
  "app/dashboard/data-packages/page.tsx",
  "lib/ai-tools.ts",
])

// A copy of the rule looks like `dealer_price && ... > 0 ? ... dealer_price` or `dealer_price ?? price`.
const RULE = /dealer_price[^\n]{0,80}(>\s*0|\?\?)[^\n]{0,80}(dealer_price|\.price)/

describe("price rule lives only in lib/pricing/package-price.ts", () => {
  it("no other file re-implements the dealer/role price choice", () => {
    const out = execSync(`git grep -l "dealer_price" -- "app/**/*.ts" "app/**/*.tsx" "lib/**/*.ts" ":!*.test.ts"`, { encoding: "utf8" })
    const offenders = out.split("\n").filter(Boolean).filter((f) => {
      if (ALLOWED.has(f)) return false
      const src = execSync(`git show :${JSON.stringify(f).slice(1, -1)}`, { encoding: "utf8" })
      return RULE.test(src)
    })
    expect(offenders).toEqual([])
  })
})
```

`lib/ai-tools.ts` is allowed because its admin view lists `dealer_price` as a field; Task 6 moved its two price choices onto the resolver. The test reads the staged file contents (`git show :path`), so stage (`git add`) your changes before running it.

- [ ] **Step 2: Run it**

Run: `git add -A && npx vitest run lib/pricing/guard.test.ts`
Expected: PASS. If a file is listed, it still copies the rule. Move it onto `effectivePrice` or `rolePrice`. Add it to `ALLOWED` only if it must show the role price on purpose, with a comment saying why.

- [ ] **Step 3: Commit**

```bash
git add lib/pricing/guard.test.ts
git commit -m "test(pricing): guard against new copies of the price rule"
```

---

### Task 13: Spec sync and full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-31-per-user-custom-prices-design.md`

- [ ] **Step 1: Bring the spec in line with this plan**

Edit the spec so it matches the "Decisions made while planning" at the top of this plan:
- replace the `user_package_price_audit` table with the `admin_audit_log` actions;
- remove the `custom_prices_enabled` flag (rollout is "ship as one release; `pricing_mode` defaults to `role`");
- in "Charge points", drop `lib/api-v2/bundles.ts`, `public-packages`, `invites`, `dealer-price-list`, `sub-agent-catalog`, `shop-pricing` and `sub-agent-catalog` page with the reason (role price on purpose), and add `app/api/user/package-prices`;
- add the sub-agent note and the `max(0, …)` profit rule.

- [ ] **Step 2: Run the whole suite and the type check**

Run: `npx vitest run 2>&1 | tail -5; npx tsc --noEmit -p . 2>&1 | tail -5`
Expected: every new test passes. Before this work, 9 tests in `lib/order-health-service.test.ts` already failed on `main`; confirm that the same 9 and no others fail. The type check shows no new errors in the files this plan touched.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-31-per-user-custom-prices-design.md
git commit -m "docs: sync custom prices spec with the implementation plan"
```

- [ ] **Step 4: Release notes for whoever deploys**

1. Apply `migrations/0142_user_package_prices.sql` in Supabase, then run its "Verify after apply" queries.
2. Deploy the app.
3. Smoke test: put a test dealer on Custom price with one custom price. Buy that bundle from the dashboard and check that the wallet debit equals the custom price. Switch them back to Role price and check that the next purchase is charged the dealer price.
