# Custom Domain Service Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a platform admin point a custom domain they own at this app, choose one of four services (Data Bundles, Airtime, Results Checker, Bulk SMS) to be that domain's front-and-center offering, and give the domain its own branding (name, logo, primary color) — while accounts, wallet, and order history stay shared with the main site.

**Architecture:** A new `custom_domains` table (platform-admin-managed) is looked up in `middleware.ts` by Host header, using an Upstash-Redis-backed cache (reusing the Redis instance pattern already in `middleware.ts`) with a `supabaseAdmin` fallback on a cache miss. A match sets `x-domain-*` request headers (mirroring the existing `x-nonce` mechanism) that `app/layout.tsx` reads and threads through a new `DomainBrandingProvider` client context. Consumers of that context (`components/layout/sidebar.tsx`, `app/page.tsx`) swap branding and hide nav entries for other services; `middleware.ts` itself redirects direct navigation to another service's dashboard routes back to the domain's own service. A new admin-only CRUD route + page manage the table.

**Tech Stack:** Next.js 15 App Router (middleware + API routes), TypeScript, Supabase (service-role client), Upstash Redis (`@upstash/redis`, already a dependency), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-custom-domain-service-routing-design.md`

## Global Constraints

- Platform-admin-managed only — no shop-owner/sub-agent-facing UI or logic (per the approved spec).
- The four services map to these existing route families and no others: `data_bundles` → `/dashboard/data-packages`; `airtime` → `/dashboard/airtime`; `results_checker` → `/dashboard/results-checker` and `/dashboard/results-check`; `bulk_sms` → `/dashboard/sms`. Every other route (`/dashboard`, `/dashboard/wallet`, `/dashboard/my-orders`, `/dashboard/transactions`, `/dashboard/profile`, `/dashboard/complaints`, all dealer/sub-agent routes, `/auth/*`, `/admin/*`) stays reachable on every domain — accounts/wallet/orders are shared everywhere.
- Every Redis or Supabase failure in the lookup path must fail open (render the main site normally, no branding, no gating) — never throw out of `middleware.ts`. A malformed branding value must never prevent `middleware.ts` from completing a request either (wrap header-setting in try/catch).
- Follow the existing codebase test convention: `lib/` pure-logic and I/O modules get Vitest unit tests with mocked dependencies (`vi.mock` of the imported module, not dependency injection — see the `customer-verification` precedent in Task 8). `middleware.ts`, `app/**/page.tsx`, and `components/**/*.tsx` are not unit-tested in this codebase — verify those via `npx tsc --noEmit` plus a manual check.
- Reuse existing infrastructure — do not introduce a new external service. Redis: reuse the `@upstash/redis` dependency and env vars (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) already used in `middleware.ts`. Logo storage: reuse the existing `admin-uploads` Supabase Storage bucket (public read, authenticated write — see `migrations/20260609_create_admin_uploads_bucket.sql`), not a new bucket.
- Automating Vercel domain attachment/DNS is out of scope — stays a manual admin step, called out in the admin UI copy.

---

### Task 1: Database migration

**Files:**
- Create: `migrations/0096_custom_domains.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: table `custom_domains` with columns `id uuid`, `domain text unique`, `service text` (check-constrained to `'data_bundles' | 'airtime' | 'results_checker' | 'bulk_sms'`), `site_name text`, `logo_url text`, `primary_color text`, `is_active boolean default true`, `created_at timestamptz`, `updated_at timestamptz`. Tasks 3 and 8 both query/write this table and depend on exactly these column names and types.

- [ ] **Step 1: Write the migration**

Create `migrations/0096_custom_domains.sql`:

```sql
-- Platform-admin-managed custom domains, each serving exactly one of four core
-- services with its own branding, while accounts/wallet/orders stay shared with
-- the main site. See docs/superpowers/specs/2026-09-11-custom-domain-service-routing-design.md.

create table if not exists custom_domains (
  id uuid primary key default gen_random_uuid(),
  domain text unique not null,
  service text not null check (service in ('data_bundles','airtime','results_checker','bulk_sms')),
  site_name text not null,
  logo_url text,
  primary_color text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table custom_domains enable row level security;

-- Public, unauthenticated read of active domains only — this is exactly what a
-- public website renders, and it's a defense-in-depth backstop (the app itself
-- reads this table via the service-role client, which bypasses RLS entirely).
-- Scoped deliberately, not a blanket USING(true) grant, per this project's RLS
-- incident history (see [[project-rls-grant-model]] in project memory).
create policy "custom_domains_public_read" on custom_domains
  for select to anon, authenticated
  using (is_active = true);

-- No insert/update/delete policy: writes only ever go through the service-role
-- admin API route (app/api/admin/custom-domains/route.ts), which bypasses RLS.
```

- [ ] **Step 2: Apply the migration**

Apply it the same way prior migrations in this repo were applied — via the Supabase SQL editor (paste the file contents) or the Supabase MCP `execute_sql` tool if connected this session. There is no local migration-runner script in this repo (confirmed: no `package.json` script named `migrate`).

- [ ] **Step 3: Verify**

Run this query against the database (SQL editor or MCP) and confirm it returns one row:

```sql
select table_name, column_name, data_type
from information_schema.columns
where table_name = 'custom_domains'
order by ordinal_position;
```

Expected: 9 rows (`id`, `domain`, `service`, `site_name`, `logo_url`, `primary_color`, `is_active`, `created_at`, `updated_at`) with the types from Step 1. Then run:

```sql
select policyname, roles, cmd from pg_policies where tablename = 'custom_domains';
```

Expected: exactly one row, `custom_domains_public_read`, `cmd = SELECT`.

- [ ] **Step 4: Commit**

```bash
git add migrations/0096_custom_domains.sql
git commit -m "feat(db): add custom_domains table for admin-managed service-branded domains"
```

---

### Task 2: Pure domain-service logic

**Files:**
- Create: `lib/custom-domains.ts`
- Test: Create `lib/custom-domains.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions, no I/O).
- Produces (all exported from `@/lib/custom-domains`, consumed by later tasks exactly as typed here):
  - `type DomainService = "data_bundles" | "airtime" | "results_checker" | "bulk_sms"`
  - `interface CustomDomainConfig { domain: string; service: DomainService; site_name: string; logo_url: string | null; primary_color: string | null; is_active: boolean }`
  - `getServiceRedirect(path: string, service: DomainService): string | null` — Task 4 (middleware).
  - `isPathAllowedForService(path: string, service: DomainService | null): boolean` — Task 6 (nav filtering).
  - `normalizeDomainHost(host: string | null): string | null` — available for future callers; not required by any other task in this plan, included because it's the natural pure counterpart to the header-parsing `middleware.ts` already needs.
  - `hexToHslTriplet(hex: string): string | null` — Task 5 (`DomainBrandingProvider`).
  - `isReservedDomainHost(domain: string, rootDomain: string): boolean` — Task 8 (admin API validation).

- [ ] **Step 1: Write the failing tests**

Create `lib/custom-domains.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import {
  getServiceRedirect,
  isPathAllowedForService,
  normalizeDomainHost,
  hexToHslTriplet,
  isReservedDomainHost,
} from "./custom-domains"

describe("getServiceRedirect", () => {
  it("returns null for a path belonging to the domain's own service", () => {
    expect(getServiceRedirect("/dashboard/data-packages", "data_bundles")).toBeNull()
    expect(getServiceRedirect("/dashboard/data-packages/foo", "data_bundles")).toBeNull()
  })

  it("returns null for account-wide paths regardless of service", () => {
    expect(getServiceRedirect("/dashboard/wallet", "airtime")).toBeNull()
    expect(getServiceRedirect("/dashboard/my-orders", "bulk_sms")).toBeNull()
    expect(getServiceRedirect("/dashboard/profile", "results_checker")).toBeNull()
    expect(getServiceRedirect("/admin/users", "data_bundles")).toBeNull()
  })

  it("redirects a path belonging to a different service to the domain's own service root", () => {
    expect(getServiceRedirect("/dashboard/airtime", "data_bundles")).toBe("/dashboard/data-packages")
    expect(getServiceRedirect("/dashboard/data-packages", "airtime")).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/sms", "results_checker")).toBe("/dashboard/results-checker")
  })

  it("treats both results-checker and results-check paths as the results_checker service", () => {
    expect(getServiceRedirect("/dashboard/results-checker", "results_checker")).toBeNull()
    expect(getServiceRedirect("/dashboard/results-check", "results_checker")).toBeNull()
    expect(getServiceRedirect("/dashboard/results-checker", "bulk_sms")).toBe("/dashboard/sms")
  })
})

describe("isPathAllowedForService", () => {
  it("allows everything when service is null (main site/shop)", () => {
    expect(isPathAllowedForService("/dashboard/airtime", null)).toBe(true)
    expect(isPathAllowedForService("/dashboard/sms", null)).toBe(true)
  })

  it("allows own-service and account-wide paths", () => {
    expect(isPathAllowedForService("/dashboard/airtime", "airtime")).toBe(true)
    expect(isPathAllowedForService("/dashboard/wallet", "airtime")).toBe(true)
  })

  it("disallows another service's path", () => {
    expect(isPathAllowedForService("/dashboard/sms", "airtime")).toBe(false)
  })
})

describe("normalizeDomainHost", () => {
  it("lowercases and strips the port", () => {
    expect(normalizeDomainHost("CheckResults.com:3000")).toBe("checkresults.com")
  })

  it("returns null for a null host", () => {
    expect(normalizeDomainHost(null)).toBeNull()
  })
})

describe("hexToHslTriplet", () => {
  it("converts pure red", () => {
    expect(hexToHslTriplet("#FF0000")).toBe("0 100% 50%")
  })
  it("converts pure green", () => {
    expect(hexToHslTriplet("#00FF00")).toBe("120 100% 50%")
  })
  it("converts pure blue", () => {
    expect(hexToHslTriplet("#0000FF")).toBe("240 100% 50%")
  })
  it("converts white", () => {
    expect(hexToHslTriplet("#FFFFFF")).toBe("0 0% 100%")
  })
  it("converts black", () => {
    expect(hexToHslTriplet("#000000")).toBe("0 0% 0%")
  })
  it("converts mid-gray", () => {
    expect(hexToHslTriplet("#808080")).toBe("0 0% 50%")
  })
  it("accepts a hex without a leading #", () => {
    expect(hexToHslTriplet("FF0000")).toBe("0 100% 50%")
  })
  it("returns null for malformed input", () => {
    expect(hexToHslTriplet("not-a-color")).toBeNull()
    expect(hexToHslTriplet("#12")).toBeNull()
    expect(hexToHslTriplet("")).toBeNull()
  })
})

describe("isReservedDomainHost", () => {
  it("rejects the exact root domain", () => {
    expect(isReservedDomainHost("datagod.store", "datagod.store")).toBe(true)
  })
  it("rejects any single-label subdomain of the root domain", () => {
    expect(isReservedDomainHost("my-shop.datagod.store", "datagod.store")).toBe(true)
    expect(isReservedDomainHost("www.datagod.store", "datagod.store")).toBe(true)
  })
  it("is case-insensitive", () => {
    expect(isReservedDomainHost("DataGod.Store", "datagod.store")).toBe(true)
  })
  it("allows an unrelated custom domain", () => {
    expect(isReservedDomainHost("checkresults.com", "datagod.store")).toBe(false)
  })
  it("does not false-positive on a lookalike domain that merely shares trailing letters", () => {
    expect(isReservedDomainHost("notdatagod.store", "datagod.store")).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/custom-domains.test.ts`
Expected: FAIL — `lib/custom-domains.ts` does not exist yet.

- [ ] **Step 3: Implement `lib/custom-domains.ts`**

```ts
export type DomainService = "data_bundles" | "airtime" | "results_checker" | "bulk_sms"

export interface CustomDomainConfig {
  domain: string
  service: DomainService
  site_name: string
  logo_url: string | null
  primary_color: string | null
  is_active: boolean
}

const SERVICE_PATH_PREFIXES: Record<DomainService, string[]> = {
  data_bundles: ["/dashboard/data-packages"],
  airtime: ["/dashboard/airtime"],
  results_checker: ["/dashboard/results-checker", "/dashboard/results-check"],
  bulk_sms: ["/dashboard/sms"],
}

/**
 * Given the requested path and the domain's chosen service, return the path to
 * redirect to if this path belongs to a DIFFERENT service's family, else null
 * (the path is either service-agnostic — wallet, orders, auth, admin — or
 * already belongs to this domain's own service).
 */
export function getServiceRedirect(path: string, service: DomainService): string | null {
  const ownPrefixes = SERVICE_PATH_PREFIXES[service]
  if (ownPrefixes.some(p => path.startsWith(p))) return null

  const belongsToOtherService = (Object.entries(SERVICE_PATH_PREFIXES) as [DomainService, string[]][])
    .some(([s, prefixes]) => s !== service && prefixes.some(p => path.startsWith(p)))
  if (!belongsToOtherService) return null

  return ownPrefixes[0]
}

/** Convenience wrapper for nav filtering: true when `path` should be shown for `service`. */
export function isPathAllowedForService(path: string, service: DomainService | null): boolean {
  if (!service) return true
  return getServiceRedirect(path, service) === null
}

export function normalizeDomainHost(host: string | null): string | null {
  if (!host) return null
  return host.split(":")[0].toLowerCase()
}

/**
 * Converts a 6-digit hex color to the "H S% L%" triplet format used by the
 * shadcn-style CSS custom properties in app/globals.css (e.g. "160 84% 30%").
 * Returns null for anything that isn't a valid 6-digit hex color.
 */
export function hexToHslTriplet(hex: string): string | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!match) return null

  const int = parseInt(match[1], 16)
  const r = ((int >> 16) & 255) / 255
  const g = ((int >> 8) & 255) / 255
  const b = (int & 255) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2

  let h = 0
  let s = 0
  const delta = max - min
  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min)
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
    if (h < 0) h += 360
  }

  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`
}

/**
 * True if `domain` collides with the main app's own host shape — the exact
 * root domain, or a `<label>.<root>` shop-subdomain shape (see
 * getShopSubdomain in middleware.ts, which treats ANY single-label subdomain
 * of the root domain as shop-storefront territory) — which is already claimed
 * by existing routing and can never be assigned as a custom domain.
 */
export function isReservedDomainHost(domain: string, rootDomain: string): boolean {
  const host = domain.toLowerCase()
  const root = rootDomain.toLowerCase()
  if (host === root) return true
  if (host.endsWith(`.${root}`)) {
    const label = host.slice(0, -(`.${root}`.length))
    if (label && !label.includes(".")) return true
  }
  return false
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/custom-domains.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `lib/custom-domains.ts`.

- [ ] **Step 6: Commit**

```bash
git add lib/custom-domains.ts lib/custom-domains.test.ts
git commit -m "feat(custom-domains): add pure service-routing, hex-to-HSL, and domain-collision logic"
```

---

### Task 3: Redis-cached Supabase lookup

**Files:**
- Create: `lib/custom-domain-lookup.ts`
- Test: Create `lib/custom-domain-lookup.test.ts`

**Interfaces:**
- Consumes: `CustomDomainConfig` type (Task 2, `@/lib/custom-domains`); `supabaseAdmin` (`@/lib/supabase`, existing, service-role client — see `lib/shop-service.ts` and every other `lib/` module in this codebase for the same import).
- Produces (consumed by Task 4 and Task 8):
  - `resolveCustomDomain(host: string): Promise<CustomDomainConfig | null>`
  - `setCustomDomainCache(config: CustomDomainConfig): Promise<void>`
  - `clearCustomDomainCache(domain: string): Promise<void>`

  Callers decide WHEN it's worth calling `resolveCustomDomain` — this module has no knowledge of `ROOT_DOMAIN` or shop subdomains; Task 4's `middleware.ts` only calls it for a host that isn't the root domain and isn't a shop subdomain.

- [ ] **Step 1: Write the failing tests**

Create `lib/custom-domain-lookup.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const redisGetMock = vi.fn()
const redisSetMock = vi.fn()
const redisDelMock = vi.fn()

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(() => ({
    get: redisGetMock,
    set: redisSetMock,
    del: redisDelMock,
  })),
}))

const maybeSingleMock = vi.fn()
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: maybeSingleMock,
          }),
        }),
      }),
    }),
  },
}))

const ORIGINAL_ENV = process.env

beforeEach(() => {
  vi.clearAllMocks()
  process.env = {
    ...ORIGINAL_ENV,
    UPSTASH_REDIS_REST_URL: "https://fake-upstash.example.com",
    UPSTASH_REDIS_REST_TOKEN: "fake-token",
  }
})

const sampleConfig = {
  domain: "checkresults.com",
  service: "results_checker" as const,
  site_name: "CheckResults",
  logo_url: null,
  primary_color: "#059669",
  is_active: true,
}

describe("resolveCustomDomain", () => {
  it("returns the cached config on a Redis hit without querying Supabase", async () => {
    redisGetMock.mockResolvedValueOnce(sampleConfig)
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("checkresults.com")

    expect(result).toEqual(sampleConfig)
    expect(maybeSingleMock).not.toHaveBeenCalled()
  })

  it("queries Supabase and fills the cache on a Redis miss", async () => {
    redisGetMock.mockResolvedValueOnce(null)
    maybeSingleMock.mockResolvedValueOnce({ data: sampleConfig, error: null })
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("checkresults.com")

    expect(result).toEqual(sampleConfig)
    expect(redisSetMock).toHaveBeenCalledWith("custom_domain:checkresults.com", sampleConfig, { ex: 300 })
  })

  it("returns null and does not cache when no active row matches", async () => {
    redisGetMock.mockResolvedValueOnce(null)
    maybeSingleMock.mockResolvedValueOnce({ data: null, error: null })
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("unknown-domain.com")

    expect(result).toBeNull()
    expect(redisSetMock).not.toHaveBeenCalled()
  })

  it("falls back to Supabase and still returns a result when Redis throws", async () => {
    redisGetMock.mockRejectedValueOnce(new Error("redis down"))
    maybeSingleMock.mockResolvedValueOnce({ data: sampleConfig, error: null })
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("checkresults.com")

    expect(result).toEqual(sampleConfig)
  })

  it("fails open to null when Supabase throws", async () => {
    redisGetMock.mockResolvedValueOnce(null)
    maybeSingleMock.mockRejectedValueOnce(new Error("db down"))
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("checkresults.com")

    expect(result).toBeNull()
  })
})

describe("setCustomDomainCache / clearCustomDomainCache", () => {
  it("writes the config to Redis under the domain key", async () => {
    const { setCustomDomainCache } = await import("./custom-domain-lookup")
    await setCustomDomainCache(sampleConfig)
    expect(redisSetMock).toHaveBeenCalledWith("custom_domain:checkresults.com", sampleConfig, { ex: 300 })
  })

  it("deletes the domain key from Redis", async () => {
    const { clearCustomDomainCache } = await import("./custom-domain-lookup")
    await clearCustomDomainCache("checkresults.com")
    expect(redisDelMock).toHaveBeenCalledWith("custom_domain:checkresults.com")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/custom-domain-lookup.test.ts`
Expected: FAIL — `lib/custom-domain-lookup.ts` does not exist yet.

- [ ] **Step 3: Implement `lib/custom-domain-lookup.ts`**

```ts
import { Redis } from "@upstash/redis"
import { supabaseAdmin } from "@/lib/supabase"
import type { CustomDomainConfig } from "@/lib/custom-domains"

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    })
  : null

const CACHE_TTL_SECONDS = 5 * 60
const cacheKey = (domain: string) => `custom_domain:${domain}`

/**
 * Resolve a custom domain's config. Callers decide when this is worth calling
 * (e.g. middleware skips it entirely for the root domain and shop subdomains).
 * Fails open (returns null, meaning "render the main site normally") on any
 * Redis or Supabase error, and on a domain with no active row.
 */
export async function resolveCustomDomain(host: string): Promise<CustomDomainConfig | null> {
  if (redis) {
    try {
      const cached = await redis.get<CustomDomainConfig>(cacheKey(host))
      if (cached) return cached
    } catch (e) {
      console.error("[CUSTOM-DOMAIN-LOOKUP] Redis read failed, falling back to Supabase:", e instanceof Error ? e.message : e)
    }
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("custom_domains")
      .select("domain, service, site_name, logo_url, primary_color, is_active")
      .eq("domain", host)
      .eq("is_active", true)
      .maybeSingle()

    if (error || !data) return null

    const config = data as CustomDomainConfig
    if (redis) {
      redis.set(cacheKey(host), config, { ex: CACHE_TTL_SECONDS }).catch(e =>
        console.error("[CUSTOM-DOMAIN-LOOKUP] Redis cache-fill failed (non-fatal):", e instanceof Error ? e.message : e)
      )
    }
    return config
  } catch (e) {
    console.error("[CUSTOM-DOMAIN-LOOKUP] Supabase lookup failed:", e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Write-through cache update — called by the admin API route right after a
 * successful create/update so the change is live immediately instead of
 * waiting on CACHE_TTL_SECONDS.
 */
export async function setCustomDomainCache(config: CustomDomainConfig): Promise<void> {
  if (!redis) return
  try {
    await redis.set(cacheKey(config.domain), config, { ex: CACHE_TTL_SECONDS })
  } catch (e) {
    console.error("[CUSTOM-DOMAIN-LOOKUP] Redis cache write failed (non-fatal):", e instanceof Error ? e.message : e)
  }
}

/** Called by the admin API route on delete, or when is_active flips to false. */
export async function clearCustomDomainCache(domain: string): Promise<void> {
  if (!redis) return
  try {
    await redis.del(cacheKey(domain))
  } catch (e) {
    console.error("[CUSTOM-DOMAIN-LOOKUP] Redis cache clear failed (non-fatal):", e instanceof Error ? e.message : e)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/custom-domain-lookup.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `lib/custom-domain-lookup.ts`.

- [ ] **Step 6: Commit**

```bash
git add lib/custom-domain-lookup.ts lib/custom-domain-lookup.test.ts
git commit -m "feat(custom-domains): add Redis-cached Supabase lookup with fail-open error handling"
```

---

### Task 4: Middleware wiring

**Files:**
- Modify: `middleware.ts`

**Interfaces:**
- Consumes: `resolveCustomDomain(host: string): Promise<CustomDomainConfig | null>` (Task 3); `getServiceRedirect(path: string, service: DomainService): string | null` (Task 2).
- Produces: request headers `x-domain-service`, `x-domain-site-name`, `x-domain-logo`, `x-domain-color`, consumed by Task 5 (`app/layout.tsx`).

- [ ] **Step 1: Add imports**

In `middleware.ts`, after the existing imports (after line 5, `import { Redis } from "@upstash/redis"`):

```ts
import { resolveCustomDomain } from "@/lib/custom-domain-lookup"
import { getServiceRedirect } from "@/lib/custom-domains"
```

- [ ] **Step 2: Resolve the custom domain and wire the redirect + headers**

Replace lines 71-98 (from `const shopSubdomain = ...` through the end of `makeResponse`):

```ts
  const shopSubdomain = getShopSubdomain(request.headers.get("host"))
  const rewritePathname =
    shopSubdomain &&
    !path.startsWith("/shop/") &&
    !path.startsWith("/api") &&
    !path.startsWith("/_next") &&
    !PUBLIC_FILE.test(path)
      ? `/shop/${shopSubdomain}${path === "/" ? "" : path}`
      : null

  // Builds request headers that include the nonce for the layout server component.
  const buildRequestHeaders = () => {
    const h = new Headers(request.headers)
    h.set("x-nonce", nonce)
    return h
  }

  // Produces the outgoing response: a rewrite to the storefront path on a shop
  // subdomain (URL bar unchanged), or a normal passthrough on the main host.
  const makeResponse = () => {
    const init = { request: { headers: buildRequestHeaders() } }
    if (rewritePathname) {
      const url = request.nextUrl.clone()
      url.pathname = rewritePathname
      return NextResponse.rewrite(url, init)
    }
    return NextResponse.next(init)
  }
```

with:

```ts
  const shopSubdomain = getShopSubdomain(request.headers.get("host"))
  const rewritePathname =
    shopSubdomain &&
    !path.startsWith("/shop/") &&
    !path.startsWith("/api") &&
    !path.startsWith("/_next") &&
    !PUBLIC_FILE.test(path)
      ? `/shop/${shopSubdomain}${path === "/" ? "" : path}`
      : null

  // ── Custom domain resolution ────────────────────────────────────────────────
  // A host that isn't the root domain and isn't a shop subdomain may be an
  // admin-configured custom domain (its own branding, scoped to one service).
  // Unmapped/unknown hosts fail open to normal main-site rendering — see
  // lib/custom-domain-lookup.ts.
  const hostname = request.headers.get("host")?.split(":")[0].toLowerCase() ?? null
  const customDomainConfig =
    !shopSubdomain && hostname && hostname !== ROOT_DOMAIN
      ? await resolveCustomDomain(hostname)
      : null

  if (customDomainConfig) {
    const serviceRedirectPath = getServiceRedirect(path, customDomainConfig.service)
    if (serviceRedirectPath) {
      const url = request.nextUrl.clone()
      url.pathname = serviceRedirectPath
      return NextResponse.redirect(url)
    }
  }

  // Builds request headers that include the nonce for the layout server component,
  // plus the resolved custom-domain branding (if any) for app/layout.tsx to read.
  const buildRequestHeaders = () => {
    const h = new Headers(request.headers)
    h.set("x-nonce", nonce)
    if (customDomainConfig) {
      try {
        h.set("x-domain-service", customDomainConfig.service)
        h.set("x-domain-site-name", customDomainConfig.site_name)
        if (customDomainConfig.logo_url) h.set("x-domain-logo", customDomainConfig.logo_url)
        if (customDomainConfig.primary_color) h.set("x-domain-color", customDomainConfig.primary_color)
      } catch (e) {
        // A malformed branding value must never take down every request to this
        // domain — skip branding for this request rather than throwing out of
        // middleware.
        console.error("[MIDDLEWARE] Failed to set custom-domain branding headers:", e instanceof Error ? e.message : e)
      }
    }
    return h
  }

  // Produces the outgoing response: a rewrite to the storefront path on a shop
  // subdomain (URL bar unchanged), or a normal passthrough on the main host.
  const makeResponse = () => {
    const init = { request: { headers: buildRequestHeaders() } }
    if (rewritePathname) {
      const url = request.nextUrl.clone()
      url.pathname = rewritePathname
      return NextResponse.rewrite(url, init)
    }
    return NextResponse.next(init)
  }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `middleware.ts`.

- [ ] **Step 4: Manual verification**

No test file exists for `middleware.ts` in this codebase (matches the established convention — verify via typecheck plus a manual check). Start the dev server (`npm run dev`) and confirm normal behavior is unaffected for a host with no `custom_domains` row yet (none exist until Task 9 seeds one):

```bash
curl -sD - -o /dev/null -H "Host: some-unmapped-domain.example.com" http://localhost:3000/
```

Expected: `200`, and the response is the normal main-site homepage (unaffected — this host resolves to `null` since Step 2's Supabase query in Task 3 finds no row, so `customDomainConfig` stays `null` and every branch this task added is a no-op).

- [ ] **Step 5: Commit**

```bash
git add middleware.ts
git commit -m "feat(custom-domains): resolve custom domains in middleware, redirecting blocked-service paths and threading branding headers"
```

---

### Task 5: DomainBrandingProvider + layout wiring

**Files:**
- Create: `components/providers/domain-branding-provider.tsx`
- Modify: `app/layout.tsx:1-3` (imports), `:107-121` (header reading), `:206-218` (provider nesting)

**Interfaces:**
- Consumes: `hexToHslTriplet(hex: string): string | null`, `type DomainService` (Task 2, `@/lib/custom-domains`); the `x-domain-*` request headers (Task 4).
- Produces (consumed by Task 6 and Task 7):
  - `interface DomainBranding { service: DomainService | null; siteName: string | null; logoUrl: string | null; primaryColor: string | null }`
  - `useDomainBranding(): DomainBranding`
  - `<DomainBrandingProvider branding={DomainBranding}>{children}</DomainBrandingProvider>`

- [ ] **Step 1: Create the provider**

Create `components/providers/domain-branding-provider.tsx`:

```tsx
"use client"

import { createContext, useContext, type ReactNode } from "react"
import { hexToHslTriplet, type DomainService } from "@/lib/custom-domains"

export interface DomainBranding {
  service: DomainService | null
  siteName: string | null
  logoUrl: string | null
  primaryColor: string | null
}

const DEFAULT_BRANDING: DomainBranding = {
  service: null,
  siteName: null,
  logoUrl: null,
  primaryColor: null,
}

const DomainBrandingContext = createContext<DomainBranding>(DEFAULT_BRANDING)

/** Returns the current request's custom-domain branding, or the default
 * (all-null, `service: null` meaning "no restriction") on the main site/shop. */
export function useDomainBranding(): DomainBranding {
  return useContext(DomainBrandingContext)
}

export function DomainBrandingProvider({
  branding,
  children,
}: {
  branding: DomainBranding
  children: ReactNode
}) {
  const hsl = branding.primaryColor ? hexToHslTriplet(branding.primaryColor) : null

  return (
    <DomainBrandingContext.Provider value={branding}>
      {hsl && <style>{`:root { --primary: ${hsl}; }`}</style>}
      {children}
    </DomainBrandingContext.Provider>
  )
}
```

- [ ] **Step 2: Read the headers in `app/layout.tsx`**

Add an import after the existing `import { headers } from "next/headers";` (line 3):

```ts
import { DomainBrandingProvider, type DomainBranding } from "@/components/providers/domain-branding-provider";
import type { DomainService } from "@/lib/custom-domains";
```

Replace lines 112-115 (from the nonce comment through `const nonce = ...`):

```ts
  // Read the per-request nonce injected by middleware so inline scripts
  // satisfy the nonce-based Content-Security-Policy.
  const headersList = await headers();
  const nonce = headersList.get("x-nonce") ?? "";
```

with:

```ts
  // Read the per-request nonce injected by middleware so inline scripts
  // satisfy the nonce-based Content-Security-Policy.
  const headersList = await headers();
  const nonce = headersList.get("x-nonce") ?? "";

  // Read the custom-domain branding (if any) that middleware resolved for this
  // request's Host header — null on the main site and on shop subdomains.
  const domainBranding: DomainBranding = {
    service: headersList.get("x-domain-service") as DomainService | null,
    siteName: headersList.get("x-domain-site-name"),
    logoUrl: headersList.get("x-domain-logo"),
    primaryColor: headersList.get("x-domain-color"),
  };
```

- [ ] **Step 3: Wrap the tree in the provider**

Replace lines 206-218 (from `<ThemeProvider ...>` through its closing tag):

```tsx
          <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange nonce={nonce}>
            <AuthProvider>
              <ServiceWorkerRegister />
              <PeriodicSyncRegister />
              <BackgroundSyncRegister />
              <PushNotificationRegister />
              <PushOptInBanner />
              <ChristmasThemeProvider />
              <InactivityLogoutProvider />
              {children}
              <Toaster />
            </AuthProvider>
          </ThemeProvider>
```

with:

```tsx
          <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange nonce={nonce}>
            <DomainBrandingProvider branding={domainBranding}>
              <AuthProvider>
                <ServiceWorkerRegister />
                <PeriodicSyncRegister />
                <BackgroundSyncRegister />
                <PushNotificationRegister />
                <PushOptInBanner />
                <ChristmasThemeProvider />
                <InactivityLogoutProvider />
                {children}
                <Toaster />
              </AuthProvider>
            </DomainBrandingProvider>
          </ThemeProvider>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `components/providers/domain-branding-provider.tsx` or `app/layout.tsx`.

- [ ] **Step 5: Manual verification**

No test file exists for either file (client provider + root layout, matches the established convention). Start the dev server and confirm the app still renders normally at `http://localhost:3000/` — the provider defaults to `DEFAULT_BRANDING` (all null) when no `x-domain-*` headers are present, so this step should be a no-op visually. Full branding verification happens end-to-end in Task 10, once a real `custom_domains` row exists.

- [ ] **Step 6: Commit**

```bash
git add components/providers/domain-branding-provider.tsx app/layout.tsx
git commit -m "feat(custom-domains): add DomainBrandingProvider, wired from middleware headers in the root layout"
```

---

### Task 6: Sidebar nav filtering + logo/name branding

**Files:**
- Modify: `components/layout/sidebar.tsx:6` (import), `:289-309` (Logo Section), `:347-352` (menuItems filter), `:407` (shopItems filter)

**Interfaces:**
- Consumes: `useDomainBranding(): DomainBranding` (Task 5, `@/components/providers/domain-branding-provider`); `isPathAllowedForService(path: string, service: DomainService | null): boolean` (Task 2, `@/lib/custom-domains`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add imports and read the branding context**

In `components/layout/sidebar.tsx`, after the existing import (line 6, `import { supabase } from "@/lib/supabase"`):

```ts
import { useDomainBranding } from "@/components/providers/domain-branding-provider"
import { isPathAllowedForService } from "@/lib/custom-domains"
```

Inside `export function Sidebar() {` (line 89), after the existing `const { logout, user } = useAuth()` (line 93):

```ts
  const domainBranding = useDomainBranding()
```

- [ ] **Step 2: Swap the Logo Section branding**

Replace lines 294-305:

```tsx
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="bg-card p-2 rounded-lg flex-shrink-0 relative">
              <img src="/favicon-v2.jpeg" alt="DATAGOD Logo" className="w-6 h-6 rounded-lg object-cover" />
              {userRole === 'dealer' && (
                <div className="absolute -top-3 -right-3 rotate-12">
                  <Crown className="w-5 h-5 text-brand-accent fill-brand-accent/80 drop-shadow-md" />
                </div>
              )}
            </div>
            {isOpen && (
              <div>
                <h1 className="text-xl font-bold">DATAGOD</h1>
```

with:

```tsx
          <Link href="/dashboard" className="flex items-center gap-3">
            <div className="bg-card p-2 rounded-lg flex-shrink-0 relative">
              <img
                src={domainBranding.logoUrl || "/favicon-v2.jpeg"}
                alt={domainBranding.siteName ? `${domainBranding.siteName} Logo` : "DATAGOD Logo"}
                className="w-6 h-6 rounded-lg object-cover"
              />
              {userRole === 'dealer' && (
                <div className="absolute -top-3 -right-3 rotate-12">
                  <Crown className="w-5 h-5 text-brand-accent fill-brand-accent/80 drop-shadow-md" />
                </div>
              )}
            </div>
            {isOpen && (
              <div>
                <h1 className="text-xl font-bold">{domainBranding.siteName || "DATAGOD"}</h1>
```

- [ ] **Step 3: Filter `menuItems` by service**

Replace lines 347-352:

```ts
            menuItems.filter(item => {
            if (!userRole || !item.roles.includes(userRole)) return false
            // Hide upgrade page for dealers with no subscription end-date (permanent dealers)
            if (item.href === '/dashboard/upgrade' && userRole === 'dealer' && !dealerHasSubscription) return false
            return true
          }).map((item) => {
```

with:

```ts
            menuItems.filter(item => {
            if (!userRole || !item.roles.includes(userRole)) return false
            // Hide upgrade page for dealers with no subscription end-date (permanent dealers)
            if (item.href === '/dashboard/upgrade' && userRole === 'dealer' && !dealerHasSubscription) return false
            // On a custom domain scoped to one service, hide nav entries for the other services.
            if (!isPathAllowedForService(item.href, domainBranding.service)) return false
            return true
          }).map((item) => {
```

- [ ] **Step 4: Filter `shopItems` by service**

Replace line 407:

```tsx
              {shopItems.filter(item => userRole && item.roles.includes(userRole)).map((item) => {
```

with:

```tsx
              {shopItems.filter(item => userRole && item.roles.includes(userRole) && isPathAllowedForService(item.href, domainBranding.service)).map((item) => {
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `components/layout/sidebar.tsx`.

- [ ] **Step 6: Manual verification**

No test file exists for this component (matches the established convention). Start the dev server, log in, and confirm the dashboard sidebar renders exactly as before (all items visible, DATAGOD logo/name) — `domainBranding.service` is `null` on `localhost:3000`, so `isPathAllowedForService` returns `true` for every item and every branch this task added is a no-op. Full per-service filtering verification happens end-to-end in Task 10.

- [ ] **Step 7: Commit**

```bash
git add components/layout/sidebar.tsx
git commit -m "feat(custom-domains): filter sidebar nav by domain service, swap logo/name to domain branding"
```

---

### Task 7: Homepage branding

**Files:**
- Modify: `app/page.tsx:15` (import), `:308-309` (hook), `:313-333` (JSON-LD), `:336-340` (nav), `:696` (CTA text), `:706-708` (footer wordmark), `:722` (copyright)

**Interfaces:**
- Consumes: `useDomainBranding(): DomainBranding` (Task 5, `@/components/providers/domain-branding-provider`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the import and read the branding context**

After the existing import (line 15, `import { Skeleton } from "@/components/ui/skeleton"`):

```ts
import { useDomainBranding } from "@/components/providers/domain-branding-provider"
```

Replace line 308-309:

```ts
export default function HomePage() {
  const { communityLink, loading: communityLoading } = useCommunityLink()
```

with:

```ts
export default function HomePage() {
  const { communityLink, loading: communityLoading } = useCommunityLink()
  const domainBranding = useDomainBranding()
```

- [ ] **Step 2: Swap the JSON-LD site name**

Replace line 320 (`name: "DATAGOD",`) — inside the `WebSite` schema block at lines 313-333 — with:

```ts
            name: domainBranding.siteName || "DATAGOD",
```

(`url` and `potentialAction.target.urlTemplate` stay pointed at `datagod.store` — rewriting them to the actual custom-domain host would require passing the raw hostname through as well, which risks a hydration mismatch between server and client renders of this `dangerouslySetInnerHTML` block; out of scope for this pass, per the spec's exclusion of full per-domain SEO metadata.)

- [ ] **Step 3: Swap the nav wordmark**

Replace lines 337-340:

```tsx
        <div className="flex items-center gap-3">
          <div aria-hidden className="h-7 w-7 rounded-lg bg-gradient-to-br from-primary to-brand-accent" />
          <h1 className="text-lg sm:text-xl font-display font-semibold text-foreground tracking-tight">DATAGOD</h1>
        </div>
```

with:

```tsx
        <div className="flex items-center gap-3">
          {domainBranding.logoUrl ? (
            <img src={domainBranding.logoUrl} alt={`${domainBranding.siteName || "DATAGOD"} logo`} className="h-7 w-7 rounded-lg object-cover" />
          ) : (
            <div aria-hidden className="h-7 w-7 rounded-lg bg-gradient-to-br from-primary to-brand-accent" />
          )}
          <h1 className="text-lg sm:text-xl font-display font-semibold text-foreground tracking-tight">{domainBranding.siteName || "DATAGOD"}</h1>
        </div>
```

- [ ] **Step 4: Swap the CTA wordmark**

Replace line 696:

```tsx
          <p className="text-sm sm:text-lg text-muted-foreground">Join thousands who trust DATAGOD for data, airtime &amp; more.</p>
```

with:

```tsx
          <p className="text-sm sm:text-lg text-muted-foreground">Join thousands who trust {domainBranding.siteName || "DATAGOD"} for data, airtime &amp; more.</p>
```

- [ ] **Step 5: Swap the footer wordmark and copyright**

Replace lines 705-710:

```tsx
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div aria-hidden className="h-5 w-5 rounded bg-gradient-to-br from-primary to-brand-accent" />
                <span className="font-display font-semibold text-foreground">DATAGOD</span>
              </div>
              <p className="text-sm">Your trusted data hub for Ghana — data, airtime, AFA, vouchers &amp; SMS.</p>
            </div>
```

with:

```tsx
            <div>
              <div className="flex items-center gap-2 mb-3">
                {domainBranding.logoUrl ? (
                  <img src={domainBranding.logoUrl} alt={`${domainBranding.siteName || "DATAGOD"} logo`} className="h-5 w-5 rounded object-cover" />
                ) : (
                  <div aria-hidden className="h-5 w-5 rounded bg-gradient-to-br from-primary to-brand-accent" />
                )}
                <span className="font-display font-semibold text-foreground">{domainBranding.siteName || "DATAGOD"}</span>
              </div>
              <p className="text-sm">Your trusted data hub for Ghana — data, airtime, AFA, vouchers &amp; SMS.</p>
            </div>
```

Replace line 722:

```tsx
            <p>&copy; 2026 DATAGOD. All rights reserved.</p>
```

with:

```tsx
            <p>&copy; 2026 {domainBranding.siteName || "DATAGOD"}. All rights reserved.</p>
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/page.tsx`.

- [ ] **Step 7: Manual verification**

No test file exists for this page (matches the established convention). Load `http://localhost:3000/` and confirm the homepage renders exactly as before — `domainBranding` is all-null here, so every ternary in this task falls through to the original `"DATAGOD"` text and the original gradient-div logo placeholder. Full per-domain branding verification happens end-to-end in Task 10.

- [ ] **Step 8: Commit**

```bash
git add app/page.tsx
git commit -m "feat(custom-domains): swap homepage wordmark/logo to domain branding when set"
```

---

### Task 8: Admin CRUD API route

**Files:**
- Create: `app/api/admin/custom-domains/route.ts`
- Test: Create `app/api/admin/custom-domains/route.test.ts`

**Interfaces:**
- Consumes: `verifyAdminAccess(request: NextRequest): Promise<{isAdmin: boolean; userId?: string; errorResponse?: NextResponse}>` (`@/lib/admin-auth`, existing — see `app/api/admin/settings/customer-verification/route.ts` for the exact precedent this task mirrors); `supabaseAdmin` (`@/lib/supabase`); `isReservedDomainHost`, `type DomainService` (Task 2); `setCustomDomainCache`, `clearCustomDomainCache` (Task 3).
- Produces: `GET`, `POST`, `PATCH`, `DELETE` route handlers at `/api/admin/custom-domains`, consumed by Task 9's admin page. Request/response shapes:
  - `GET` → `{ domains: Array<{id, domain, service, site_name, logo_url, primary_color, is_active, created_at, updated_at}> }`
  - `POST` body `{ domain: string, service: string, site_name: string, logo_url?: string, primary_color?: string }` → `201 { domain: {...row} }` or `400`/`409`/`500`
  - `PATCH` body `{ id: string, service?, site_name?, logo_url?, primary_color?, is_active? }` → `200 { domain: {...row} }` or `400`/`404`/`500`
  - `DELETE` with `?id=` query param → `200 { success: true }` or `400`/`500`

- [ ] **Step 1: Write the failing tests**

Create `app/api/admin/custom-domains/route.test.ts`:

```ts
import { GET, POST, PATCH, DELETE } from "./route"
import { NextRequest } from "next/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => ({ isAdmin: true, userId: "admin-1" })),
}))

const setCacheMock = vi.fn(async () => {})
const clearCacheMock = vi.fn(async () => {})
vi.mock("@/lib/custom-domain-lookup", () => ({
  setCustomDomainCache: setCacheMock,
  clearCustomDomainCache: clearCacheMock,
}))

const fromMock = vi.fn()
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: (...args: any[]) => fromMock(...args) },
}))

function makeBuilder(result: { data: any; error: any }) {
  const builder: any = {
    select: vi.fn(() => builder),
    insert: vi.fn(() => builder),
    update: vi.fn(() => builder),
    delete: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    single: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (v: typeof result) => void) => resolve(result),
  }
  return builder
}

function postRequest(body: unknown, method = "POST") {
  return new NextRequest("http://localhost/api/admin/custom-domains", {
    method,
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/admin/custom-domains", () => {
  it("returns the list of configured domains", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: [{ id: "1", domain: "checkresults.com", service: "results_checker", site_name: "CheckResults", logo_url: null, primary_color: null, is_active: true, created_at: "2026-01-01", updated_at: "2026-01-01" }],
      error: null,
    }))
    const res = await GET(new NextRequest("http://localhost/api/admin/custom-domains"))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.domains).toHaveLength(1)
  })
})

describe("POST /api/admin/custom-domains", () => {
  it("rejects an unrecognized service", async () => {
    const res = await POST(postRequest({ domain: "checkresults.com", service: "not-a-service", site_name: "CheckResults" }))
    expect(res.status).toBe(400)
  })

  it("rejects a missing site_name", async () => {
    const res = await POST(postRequest({ domain: "checkresults.com", service: "results_checker", site_name: "" }))
    expect(res.status).toBe(400)
  })

  it("rejects a domain that collides with the root domain", async () => {
    const res = await POST(postRequest({ domain: "datagod.store", service: "airtime", site_name: "X" }))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/collides/)
  })

  it("rejects a domain that collides with the shop-subdomain shape", async () => {
    const res = await POST(postRequest({ domain: "my-shop.datagod.store", service: "airtime", site_name: "X" }))
    expect(res.status).toBe(400)
  })

  it("normalizes a pasted https://www. URL before storing it, and write-throughs the cache", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: { id: "1", domain: "checkresults.com", service: "results_checker", site_name: "CheckResults", logo_url: null, primary_color: null, is_active: true },
      error: null,
    }))

    const res = await POST(postRequest({ domain: "https://www.CheckResults.com/", service: "results_checker", site_name: "CheckResults" }))
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.domain.domain).toBe("checkresults.com")
    expect(setCacheMock).toHaveBeenCalledWith(expect.objectContaining({ domain: "checkresults.com" }))
  })

  it("returns 409 when the domain already exists", async () => {
    fromMock.mockReturnValue(makeBuilder({ data: null, error: { code: "23505", message: "duplicate key" } }))
    const res = await POST(postRequest({ domain: "checkresults.com", service: "results_checker", site_name: "CheckResults" }))
    expect(res.status).toBe(409)
  })
})

describe("PATCH /api/admin/custom-domains", () => {
  it("requires an id", async () => {
    const res = await PATCH(postRequest({ site_name: "New Name" }, "PATCH"))
    expect(res.status).toBe(400)
  })

  it("clears the cache instead of writing to it when is_active is set to false", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: { id: "1", domain: "checkresults.com", service: "results_checker", site_name: "CheckResults", logo_url: null, primary_color: null, is_active: false },
      error: null,
    }))

    const res = await PATCH(postRequest({ id: "1", is_active: false }, "PATCH"))

    expect(res.status).toBe(200)
    expect(clearCacheMock).toHaveBeenCalledWith("checkresults.com")
    expect(setCacheMock).not.toHaveBeenCalled()
  })
})

describe("DELETE /api/admin/custom-domains", () => {
  it("requires an id query param", async () => {
    const req = new NextRequest("http://localhost/api/admin/custom-domains", { method: "DELETE" })
    const res = await DELETE(req)
    expect(res.status).toBe(400)
  })

  it("clears the cache for the deleted domain", async () => {
    fromMock.mockReturnValue(makeBuilder({ data: { id: "1", domain: "checkresults.com" }, error: null }))
    const req = new NextRequest("http://localhost/api/admin/custom-domains?id=1", { method: "DELETE" })
    const res = await DELETE(req)
    expect(res.status).toBe(200)
    expect(clearCacheMock).toHaveBeenCalledWith("checkresults.com")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run app/api/admin/custom-domains/route.test.ts`
Expected: FAIL — `app/api/admin/custom-domains/route.ts` does not exist yet.

- [ ] **Step 3: Implement the route**

Create `app/api/admin/custom-domains/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { isReservedDomainHost, type DomainService } from "@/lib/custom-domains"
import { setCustomDomainCache, clearCustomDomainCache } from "@/lib/custom-domain-lookup"

const VALID_SERVICES: DomainService[] = ["data_bundles", "airtime", "results_checker", "bulk_sms"]
const ROOT_DOMAIN = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "datagod.store").toLowerCase()

function normalizeDomainInput(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "")
}

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { data, error } = await supabase
    .from("custom_domains")
    .select("id, domain, service, site_name, logo_url, primary_color, is_active, created_at, updated_at")
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[CUSTOM-DOMAINS] GET error:", error)
    return NextResponse.json({ error: "Failed to fetch custom domains" }, { status: 500 })
  }
  return NextResponse.json({ domains: data })
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const body = await request.json()
    const domain = normalizeDomainInput(String(body.domain || ""))
    const service = body.service as string
    const siteName = String(body.site_name || "").trim()
    const logoUrl = body.logo_url ? String(body.logo_url) : null
    const primaryColor = body.primary_color ? String(body.primary_color) : null

    if (!domain || !domain.includes(".")) {
      return NextResponse.json({ error: "A valid domain is required" }, { status: 400 })
    }
    if (!VALID_SERVICES.includes(service as DomainService)) {
      return NextResponse.json({ error: `'service' must be one of: ${VALID_SERVICES.join(", ")}` }, { status: 400 })
    }
    if (!siteName) {
      return NextResponse.json({ error: "'site_name' is required" }, { status: 400 })
    }
    if (isReservedDomainHost(domain, ROOT_DOMAIN)) {
      return NextResponse.json(
        { error: `"${domain}" collides with the main app's own domain routing and can't be used as a custom domain` },
        { status: 400 }
      )
    }

    const row = { domain, service, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true }
    const { data, error } = await supabase.from("custom_domains").insert(row).select().single()

    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return NextResponse.json({ error: `"${domain}" is already configured` }, { status: 409 })
      }
      throw error
    }

    await setCustomDomainCache({
      domain, service: service as DomainService, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true,
    })

    return NextResponse.json({ domain: data }, { status: 201 })
  } catch (error) {
    console.error("[CUSTOM-DOMAINS] POST error:", error)
    return NextResponse.json({ error: "Failed to create custom domain" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const body = await request.json()
    const id = String(body.id || "")
    if (!id) return NextResponse.json({ error: "'id' is required" }, { status: 400 })

    const updates: Record<string, unknown> = {}
    if (body.service !== undefined) {
      if (!VALID_SERVICES.includes(body.service as DomainService)) {
        return NextResponse.json({ error: `'service' must be one of: ${VALID_SERVICES.join(", ")}` }, { status: 400 })
      }
      updates.service = body.service
    }
    if (body.site_name !== undefined) {
      const siteName = String(body.site_name).trim()
      if (!siteName) return NextResponse.json({ error: "'site_name' cannot be empty" }, { status: 400 })
      updates.site_name = siteName
    }
    if (body.logo_url !== undefined) updates.logo_url = body.logo_url ? String(body.logo_url) : null
    if (body.primary_color !== undefined) updates.primary_color = body.primary_color ? String(body.primary_color) : null
    if (body.is_active !== undefined) {
      if (typeof body.is_active !== "boolean") return NextResponse.json({ error: "'is_active' must be a boolean" }, { status: 400 })
      updates.is_active = body.is_active
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 })
    }
    updates.updated_at = new Date().toISOString()

    const { data, error } = await supabase.from("custom_domains").update(updates).eq("id", id).select().single()
    if (error) throw error
    if (!data) return NextResponse.json({ error: "Domain not found" }, { status: 404 })

    if (data.is_active) {
      await setCustomDomainCache({
        domain: data.domain, service: data.service, site_name: data.site_name,
        logo_url: data.logo_url, primary_color: data.primary_color, is_active: data.is_active,
      })
    } else {
      await clearCustomDomainCache(data.domain)
    }

    return NextResponse.json({ domain: data })
  } catch (error) {
    console.error("[CUSTOM-DOMAINS] PATCH error:", error)
    return NextResponse.json({ error: "Failed to update custom domain" }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const id = request.nextUrl.searchParams.get("id")
  if (!id) return NextResponse.json({ error: "'id' query param is required" }, { status: 400 })

  const { data, error } = await supabase.from("custom_domains").delete().eq("id", id).select().maybeSingle()
  if (error) {
    console.error("[CUSTOM-DOMAINS] DELETE error:", error)
    return NextResponse.json({ error: "Failed to delete custom domain" }, { status: 500 })
  }
  if (data) await clearCustomDomainCache(data.domain)

  return NextResponse.json({ success: true })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/api/admin/custom-domains/route.test.ts`
Expected: PASS — all 10 tests green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/api/admin/custom-domains/route.ts`.

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/custom-domains/route.ts app/api/admin/custom-domains/route.test.ts
git commit -m "feat(custom-domains): add admin CRUD API route for custom domains"
```

---

### Task 9: Admin UI page

**Files:**
- Create: `app/admin/custom-domains/page.tsx`
- Modify: `components/layout/sidebar.tsx` (add nav link + `Globe` icon import)

**Interfaces:**
- Consumes: `GET/POST/PATCH/DELETE /api/admin/custom-domains` (Task 8); `uploadNetworkLogo`-style Supabase Storage upload pattern against the existing `admin-uploads` bucket (see `lib/shop-service.ts:956-982` for the precedent this mirrors).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the admin nav link**

In `components/layout/sidebar.tsx`, add `Globe` to the `lucide-react` import list (after `Send,` at line 45):

```ts
  Send,
  MessageSquare,
  Globe,
} from "lucide-react"
```

After the `/admin/results-check-requests` `<Link>` block (ends around line 955, immediately before the next admin nav section), add:

```tsx
              <Link href="/admin/custom-domains" onClick={() => handleNavigation("/admin/custom-domains")}>
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/custom-domains" ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-lg" : "text-primary hover:bg-card/10")
                      : (pathname === "/admin/custom-domains" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/custom-domains" && "opacity-70"
                  )}
                  title={!isOpen ? "Custom Domains" : undefined}
                  disabled={loadingPath === "/admin/custom-domains"}
                >
                  {loadingPath === "/admin/custom-domains" ? (
                    <Loader2 className="w-5 h-5 flex-shrink-0 animate-spin" />
                  ) : (
                    <Globe className="w-5 h-5 flex-shrink-0" />
                  )}
                  {isOpen && "Custom Domains"}
                </Button>
              </Link>
```

To find the exact insertion point (line numbers have shifted from Task 6's earlier edits), search the file for `href="/admin/results-check-requests"` — that `<Link>` block's structure is identical in shape to the one being added above. Insert the new `<Link href="/admin/custom-domains" ...>...</Link>` block immediately after that block's closing `</Link>` (i.e. directly after the `</Link>` that closes the `/admin/results-check-requests` link, before whatever admin nav item currently follows it).

- [ ] **Step 2: Create the admin page**

Create `app/admin/custom-domains/page.tsx`:

```tsx
"use client"

import { useEffect, useState } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Loader2, Plus, Pencil, Trash2 } from "lucide-react"
import { supabase } from "@/lib/supabase"
import { toast } from "sonner"

type DomainService = "data_bundles" | "airtime" | "results_checker" | "bulk_sms"

interface CustomDomainRow {
  id: string
  domain: string
  service: DomainService
  site_name: string
  logo_url: string | null
  primary_color: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

const SERVICE_LABELS: Record<DomainService, string> = {
  data_bundles: "Data Bundles",
  airtime: "Airtime",
  results_checker: "Results Checker",
  bulk_sms: "Bulk SMS",
}

const EMPTY_FORM = { domain: "", service: "data_bundles" as DomainService, site_name: "", logo_url: "", primary_color: "" }

export default function CustomDomainsPage() {
  const [domains, setDomains] = useState<CustomDomainRow[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<CustomDomainRow | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)

  const authHeader = async () => {
    const { data: { session } } = await supabase.auth.getSession()
    return { Authorization: `Bearer ${session?.access_token}` }
  }

  const loadDomains = async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/admin/custom-domains", { headers: await authHeader() })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Failed to load domains")
      setDomains(body.domains || [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load domains")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadDomains()
  }, [])

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setDialogOpen(true)
  }

  const openEdit = (row: CustomDomainRow) => {
    setEditing(row)
    setForm({
      domain: row.domain,
      service: row.service,
      site_name: row.site_name,
      logo_url: row.logo_url || "",
      primary_color: row.primary_color || "",
    })
    setDialogOpen(true)
  }

  const handleLogoUpload = async (file: File) => {
    setUploadingLogo(true)
    try {
      const path = `custom-domains/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, "_")}`
      const { error: uploadError } = await supabase.storage.from("admin-uploads").upload(path, file, { upsert: true })
      if (uploadError) throw uploadError
      const { data } = supabase.storage.from("admin-uploads").getPublicUrl(path)
      setForm(f => ({ ...f, logo_url: data.publicUrl }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Logo upload failed")
    } finally {
      setUploadingLogo(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const headers = { "Content-Type": "application/json", ...(await authHeader()) }
      const res = editing
        ? await fetch("/api/admin/custom-domains", {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              id: editing.id,
              service: form.service,
              site_name: form.site_name,
              logo_url: form.logo_url || null,
              primary_color: form.primary_color || null,
            }),
          })
        : await fetch("/api/admin/custom-domains", {
            method: "POST",
            headers,
            body: JSON.stringify({
              domain: form.domain,
              service: form.service,
              site_name: form.site_name,
              logo_url: form.logo_url || null,
              primary_color: form.primary_color || null,
            }),
          })

      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Save failed")

      toast.success(editing ? "Domain updated" : "Domain added")
      setDialogOpen(false)
      await loadDomains()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed")
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async (row: CustomDomainRow) => {
    try {
      const headers = { "Content-Type": "application/json", ...(await authHeader()) }
      const res = await fetch("/api/admin/custom-domains", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ id: row.id, is_active: !row.is_active }),
      })
      if (!res.ok) throw new Error((await res.json()).error || "Update failed")
      await loadDomains()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed")
    }
  }

  const handleDelete = async (row: CustomDomainRow) => {
    if (!confirm(`Remove "${row.domain}"? This cannot be undone.`)) return
    try {
      const res = await fetch(`/api/admin/custom-domains?id=${row.id}`, { method: "DELETE", headers: await authHeader() })
      if (!res.ok) throw new Error((await res.json()).error || "Delete failed")
      toast.success("Domain removed")
      await loadDomains()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed")
    }
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Custom Domains</h1>
            <p className="text-sm text-muted-foreground">
              Point a domain you own at one service, with its own name/logo/color. Accounts, wallet, and orders stay shared with the main site.
            </p>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={openCreate}><Plus className="w-4 h-4 mr-2" /> Add Domain</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editing ? "Edit Domain" : "Add Domain"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label>Domain</Label>
                  <Input
                    value={form.domain}
                    onChange={e => setForm(f => ({ ...f, domain: e.target.value }))}
                    placeholder="checkresults.com"
                    disabled={!!editing}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Service</Label>
                  <Select value={form.service} onValueChange={v => setForm(f => ({ ...f, service: v as DomainService }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(SERVICE_LABELS) as DomainService[]).map(s => (
                        <SelectItem key={s} value={s}>{SERVICE_LABELS[s]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Site Name</Label>
                  <Input value={form.site_name} onChange={e => setForm(f => ({ ...f, site_name: e.target.value }))} placeholder="CheckResults" />
                </div>
                <div className="space-y-2">
                  <Label>Logo</Label>
                  <div className="flex items-center gap-3">
                    {form.logo_url && <img src={form.logo_url} alt="Logo preview" className="w-10 h-10 rounded object-cover" />}
                    <Input
                      type="file"
                      accept="image/*"
                      disabled={uploadingLogo}
                      onChange={e => e.target.files?.[0] && handleLogoUpload(e.target.files[0])}
                    />
                    {uploadingLogo && <Loader2 className="w-4 h-4 animate-spin" />}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Primary Color</Label>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      value={form.primary_color || "#059669"}
                      onChange={e => setForm(f => ({ ...f, primary_color: e.target.value }))}
                      className="w-10 h-10 rounded border border-border"
                    />
                    <Input value={form.primary_color} onChange={e => setForm(f => ({ ...f, primary_color: e.target.value }))} placeholder="#059669" />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleSave} disabled={saving || !form.domain || !form.site_name}>
                  {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  {editing ? "Save Changes" : "Add Domain"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Configured Domains</CardTitle>
            <CardDescription>
              Saving here does not attach the domain in Vercel or point its DNS — add it under your Vercel project&apos;s Settings → Domains and point DNS per Vercel&apos;s instructions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin" /></div>
            ) : domains.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No custom domains configured yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Domain</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Site Name</TableHead>
                    <TableHead>Active</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {domains.map(row => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.domain}</TableCell>
                      <TableCell><Badge variant="outline">{SERVICE_LABELS[row.service]}</Badge></TableCell>
                      <TableCell className="flex items-center gap-2">
                        {row.logo_url && <img src={row.logo_url} alt="" className="w-5 h-5 rounded object-cover" />}
                        {row.site_name}
                      </TableCell>
                      <TableCell><Switch checked={row.is_active} onCheckedChange={() => handleToggleActive(row)} /></TableCell>
                      <TableCell className="text-right space-x-2">
                        <Button variant="ghost" size="icon" onClick={() => openEdit(row)}><Pencil className="w-4 h-4" /></Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(row)}><Trash2 className="w-4 h-4 text-destructive" /></Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/admin/custom-domains/page.tsx` or `components/layout/sidebar.tsx`. (`toast` from `"sonner"` is already used this way in `app/admin/withdrawals/page.tsx` and 9 other admin pages, so no new dependency is introduced.)

- [ ] **Step 4: Manual verification**

No test file exists for this page (matches the established convention). Start the dev server, log in as an admin, navigate to `/admin/custom-domains`, and confirm: the empty state renders; "Add Domain" opens the dialog; filling in a domain (e.g. `test-domain.example.com`), selecting a service, and a site name, then saving, creates a row and shows it in the table; toggling "Active" and deleting both work without errors.

- [ ] **Step 5: Commit**

```bash
git add app/admin/custom-domains/page.tsx components/layout/sidebar.tsx
git commit -m "feat(custom-domains): add admin UI for managing custom domains"
```

---

### Task 10: End-to-end verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: the full feature (Tasks 1-9).
- Produces: nothing — this task exists to catch integration issues no single task's unit tests or typecheck can, per the writing-plans convention that a multi-component feature gets one final integration gate.

- [ ] **Step 1: Seed a real custom domain via the admin UI**

With the dev server running and logged in as admin, go to `/admin/custom-domains` and add a domain using a hostname you can fake via a `Host` header locally, e.g. `domain: test.local`, `service: airtime`, `site_name: TestAirtime`, a logo image, and `primary_color: #2563EB`.

- [ ] **Step 2: Verify the service redirect**

```bash
curl -sD - -o /dev/null -H "Host: test.local" http://localhost:3000/dashboard/data-packages
```

Expected: `307` or `308` redirect with `Location: /dashboard/airtime`.

```bash
curl -sD - -o /dev/null -H "Host: test.local" http://localhost:3000/dashboard/wallet
```

Expected: no redirect (passes through — account-wide route).

- [ ] **Step 3: Verify branding in the browser**

Add `127.0.0.1 test.local` to your hosts file (or use a browser extension / `curl`'s `--resolve` flag to point `test.local` at `127.0.0.1:3000`), then load `http://test.local:3000/`. Confirm: the homepage nav and footer show "TestAirtime" and the uploaded logo instead of "DATAGOD"; the `--primary` CSS variable reflects `#2563EB` (inspect any `bg-primary`/`text-primary` element's computed color, or check `getComputedStyle(document.documentElement).getPropertyValue('--primary')` in the browser console — expect the HSL triplet for `#2563EB`, i.e. `217 91% 53%` per `hexToHslTriplet`).

- [ ] **Step 4: Verify nav filtering**

Log in on `http://test.local:3000/` and open the dashboard sidebar. Confirm "Data Packages", "Results Checker", "Check Results", and "SMS" are hidden from the nav, while "Buy Airtime", "Wallet", "My Orders", "Transactions", "Profile" and the sub-agent/dealer items are all still present.

- [ ] **Step 5: Verify the main site and an existing shop are unaffected**

Load `http://localhost:3000/` and an existing shop subdomain (e.g. `http://any-existing-shop.localhost:3000/` if one exists in dev data). Confirm both render exactly as before this feature — no branding swap, no nav filtering, no redirects.

- [ ] **Step 6: Clean up the test row**

Delete the `test.local` row from `/admin/custom-domains` (it was only for this verification).

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — every test in the repo green, including all new ones from Tasks 2, 3, and 8.

Run: `npx tsc --noEmit`
Expected: No errors anywhere in the repo.
