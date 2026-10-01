# Custom Domain Page/Feature Toggles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin hide, per custom domain, any of 13 pages/features — the landing page, the "Buy as Guest" button, the "Join Channel" button, wallet/top-up, and 9 dealer-tool pages currently always hidden — plus fix the login/signup pages to show the domain's own branding instead of hardcoded "DATAGOD".

**Architecture:** A single `hidden_pages text[]` column on `custom_domains`, backed by a shared `TOGGLEABLE_PAGES` registry that is the one source of truth for every toggleable key. Entries with a `path` are blocked/redirected and nav-filtered generically by extending the existing `getServiceRedirect`/`isPathAllowedForService` functions (replacing the hardcoded `NON_SERVICE_GATED_PATHS` list they already used). The 3 path-less entries are gated individually at their one or two render sites via a new `isPageHidden(key, hiddenPages)` helper. The data flows through the exact pipeline `services`/`site_name`/`logo_url` already use: DB column → middleware header → `DomainBranding` context → page-level conditionals.

**Tech Stack:** Next.js 15 App Router (middleware + API routes), TypeScript, Supabase (service-role client via Management API for migration apply), Upstash Redis, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-custom-domain-page-toggles-design.md`

## Global Constraints

- The 13 toggleable keys (exact strings): `landing_page`, `guest_purchase`, `join_channel`, `wallet`, `afa_orders`, `upgrade`, `my_shop`, `shop_dashboard`, `sub_agents`, `sub_agent_catalog`, `ussd_shop`, `payment_reverify`, `buy_stock`.
- Migration default (every existing row AND every future row without an explicit value): `'{afa_orders,upgrade,my_shop,shop_dashboard,sub_agents,sub_agent_catalog,ussd_shop,payment_reverify,buy_stock}'` — preserves today's behavior exactly (9 dealer tools hidden, everything else shown).
- In the admin UI, a checked checkbox means *visible* (key is NOT in `hidden_pages`) — inverted from storage, because it reads more naturally.
- Landing-page-hide always redirects `/` to `/auth/login`, regardless of auth state.
- Wallet-hide also suppresses the low-balance (`< GHS 5`) `WalletOnboardingModal` nag on `/dashboard`.
- The signup page does NOT gain the "Buy as Guest" or "Join Channel" buttons — they stay login/homepage-only, matching today.
- The existing `services` multi-select mechanism (Data Bundles/Airtime/Results Checker/Bulk SMS) is untouched and stays a completely separate mechanism.
- `NON_SERVICE_GATED_PATHS` in `lib/custom-domains.ts` is deleted; its 9 paths move into the new registry.
- No automated tests exist for `middleware.ts`, `components/providers/domain-branding-provider.tsx`, `app/layout.tsx`, `components/layout/sidebar.tsx`, `components/layout/bottom-nav.tsx`, `app/page.tsx`, `app/auth/login-form.tsx`, `app/auth/signup/page.tsx`, `app/dashboard/page.tsx`, `app/admin/custom-domains/page.tsx` (established convention) — verify those via `npx tsc --noEmit` plus careful reading.

## Review Focus

- An admin explicitly un-hides a dealer-tool page (saves `hidden_pages` with a dealer-tool key removed) — that page must actually become reachable and show in nav, not stay hidden due to a stale default somewhere.
- Un-hiding `wallet` must also bring back the low-balance modal — it shouldn't stay suppressed by a check that only ever looked at the DB default.
- A nested sub-path of a hidden dealer-tool page (e.g. `/dashboard/sub-agent-catalog/add`) must still redirect, not just the bare path — the new array-based check needs the same prefix-matching the old hardcoded list had.
- The admin API must reject an unknown/garbage `hidden_pages` key (400), not silently store it and have it do nothing everywhere downstream.
- On the main site (no custom domain / `domainBranding.hiddenPages === []`), every new gate must be a true no-op — none of landing_page/guest_purchase/join_channel/wallet gating fires there.

---

### Task 1: Shared page registry + migration

**Files:**
- Create: `lib/custom-domain-pages.ts`
- Test: `lib/custom-domain-pages.test.ts`
- Create: `migrations/0100_custom_domain_page_toggles.sql`

**Interfaces:**
- Produces: `TOGGLEABLE_PAGES: ToggleablePage[]`, `interface ToggleablePage { key: string; label: string; group: "auth" | "dashboard"; path?: string }` — consumed by Task 2 (`lib/custom-domains.ts`), Task 11 (admin API route), and Task 12 (admin UI).

- [ ] **Step 1: Write the failing tests**

```ts
// lib/custom-domain-pages.test.ts
import { describe, it, expect } from "vitest"
import { TOGGLEABLE_PAGES } from "./custom-domain-pages"

describe("TOGGLEABLE_PAGES", () => {
  it("has no duplicate keys", () => {
    const keys = TOGGLEABLE_PAGES.map(p => p.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("includes exactly the 9 dealer-tool paths previously hardcoded in NON_SERVICE_GATED_PATHS", () => {
    const dealerToolPaths = TOGGLEABLE_PAGES
      .filter(p => p.group === "dashboard" && p.key !== "wallet")
      .map(p => p.path)
    expect(dealerToolPaths.slice().sort()).toEqual([
      "/dashboard/afa-orders",
      "/dashboard/buy-stock",
      "/dashboard/my-shop",
      "/dashboard/payment-reverify",
      "/dashboard/shop-dashboard",
      "/dashboard/sub-agent-catalog",
      "/dashboard/sub-agents",
      "/dashboard/upgrade",
      "/dashboard/ussd-shop",
    ])
  })

  it("has no path for the 3 standalone auth-group entries", () => {
    const authEntries = TOGGLEABLE_PAGES.filter(p => p.group === "auth")
    expect(authEntries.map(p => p.key).slice().sort()).toEqual(["guest_purchase", "join_channel", "landing_page"])
    expect(authEntries.every(p => p.path === undefined)).toBe(true)
  })

  it("wallet has both a path and sits in the dashboard group", () => {
    const wallet = TOGGLEABLE_PAGES.find(p => p.key === "wallet")
    expect(wallet?.path).toBe("/dashboard/wallet")
    expect(wallet?.group).toBe("dashboard")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/custom-domain-pages.test.ts`
Expected: FAIL — `Cannot find module './custom-domain-pages'`

- [ ] **Step 3: Implement the registry**

```ts
// lib/custom-domain-pages.ts

export interface ToggleablePage {
  key: string
  label: string
  group: "auth" | "dashboard"
  // Present only for entries with a dedicated route — drives uniform
  // middleware blocking + nav filtering (see getServiceRedirect /
  // isPathAllowedForService in lib/custom-domains.ts). Absent for the 3
  // entries gated at a specific render site instead of a whole route.
  path?: string
}

export const TOGGLEABLE_PAGES: ToggleablePage[] = [
  { key: "landing_page",   label: "Landing Page",       group: "auth" },
  { key: "guest_purchase", label: "Buy as Guest Button", group: "auth" },
  { key: "join_channel",   label: "Join Channel Button", group: "auth" },
  { key: "wallet",             label: "Wallet & Top-Up",        group: "dashboard", path: "/dashboard/wallet" },
  { key: "afa_orders",         label: "AFA Registration",       group: "dashboard", path: "/dashboard/afa-orders" },
  { key: "upgrade",            label: "Upgrade / Dealer Plans", group: "dashboard", path: "/dashboard/upgrade" },
  { key: "my_shop",            label: "My Shop",                group: "dashboard", path: "/dashboard/my-shop" },
  { key: "shop_dashboard",     label: "Shop Dashboard",         group: "dashboard", path: "/dashboard/shop-dashboard" },
  { key: "sub_agents",         label: "Sub-Agents",             group: "dashboard", path: "/dashboard/sub-agents" },
  { key: "sub_agent_catalog",  label: "Sub-Agent Catalog",      group: "dashboard", path: "/dashboard/sub-agent-catalog" },
  { key: "ussd_shop",          label: "USSD Shop",              group: "dashboard", path: "/dashboard/ussd-shop" },
  { key: "payment_reverify",   label: "Payment Re-verify",      group: "dashboard", path: "/dashboard/payment-reverify" },
  { key: "buy_stock",          label: "Buy Stock",              group: "dashboard", path: "/dashboard/buy-stock" },
]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/custom-domain-pages.test.ts`
Expected: PASS (all 4 cases)

- [ ] **Step 5: Write the migration**

```sql
-- migrations/0100_custom_domain_page_toggles.sql

-- Lets an admin hide, per custom domain, any of the 13 toggleable
-- pages/features defined in lib/custom-domain-pages.ts. See
-- docs/superpowers/specs/2026-10-01-custom-domain-page-toggles-design.md.
--
-- The default array is deliberately NOT empty: the 9 dealer-tool keys are
-- currently always hidden on every custom domain (hardcoded in the
-- now-deleted NON_SERVICE_GATED_PATHS), while the other 4 keys
-- (landing_page, guest_purchase, join_channel, wallet) are currently
-- always shown (never gated at all). Postgres applies a new column's
-- default to every EXISTING row, not just future inserts, so every
-- current domain ends up with exactly today's behavior.
alter table custom_domains add column if not exists hidden_pages text[] not null default
  '{afa_orders,upgrade,my_shop,shop_dashboard,sub_agents,sub_agent_catalog,ussd_shop,payment_reverify,buy_stock}';
```

- [ ] **Step 6: Apply the migration to the live database**

This project applies migrations via the Supabase Management API (project ref `riijesduargxlzxuperj`). The access token lives in the project's gitignored `.mcp.json` (`SUPABASE_ACCESS_TOKEN`) — read it from there at runtime, never paste it into code or logs. From the project root:

```bash
node -e "
const fs = require('fs');
const sql = fs.readFileSync('migrations/0100_custom_domain_page_toggles.sql', 'utf8');
const token = JSON.parse(fs.readFileSync('.mcp.json', 'utf8')).mcpServers.supabase.env.SUPABASE_ACCESS_TOKEN;
fetch('https://api.supabase.com/v1/projects/riijesduargxlzxuperj/database/query', {
  method: 'POST',
  headers: { Authorization: \`Bearer \${token}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
}).then(async r => { console.log('status:', r.status); console.log(await r.text()); });
"
```

Expected: `status: 201`, empty body (normal for DDL with no `RETURNING`).

- [ ] **Step 7: Verify against the live schema**

```bash
node -e "
const fs = require('fs');
const token = JSON.parse(fs.readFileSync('.mcp.json', 'utf8')).mcpServers.supabase.env.SUPABASE_ACCESS_TOKEN;
const query = \"select column_name, data_type, column_default from information_schema.columns where table_name = 'custom_domains' and column_name = 'hidden_pages'\";
fetch('https://api.supabase.com/v1/projects/riijesduargxlzxuperj/database/query', {
  method: 'POST',
  headers: { Authorization: \`Bearer \${token}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
}).then(async r => console.log(await r.text()));
"
```

Expected: one row — `hidden_pages`, `ARRAY`, a default mentioning the 9 dealer-tool keys.

- [ ] **Step 8: Commit**

```bash
git add lib/custom-domain-pages.ts lib/custom-domain-pages.test.ts migrations/0100_custom_domain_page_toggles.sql
git commit -m "feat(custom-domains): add shared page/feature toggle registry + hidden_pages column"
```

---

### Task 2: `lib/custom-domains.ts` — generalize the redirect/gating logic

**Files:**
- Modify: `lib/custom-domains.ts`
- Test: `lib/custom-domains.test.ts`

**Interfaces:**
- Consumes: `TOGGLEABLE_PAGES` (Task 1).
- Produces: `CustomDomainConfig` gains `hidden_pages: string[]`. `getServiceRedirect(path, services, hiddenPages = [])`, `isPathAllowedForService(path, services, hiddenPages = [])` — both gain a third parameter; existing 2-arg call sites still compile (default `[]`) but now redirect/allow nothing extra until updated. New: `isPageHidden(key: string, hiddenPages: string[]): boolean`. `NON_SERVICE_GATED_PATHS` is deleted. Tasks 3-10 all consume these exact names.

- [ ] **Step 1: Write the failing tests**

Replace lines 58-75 of `lib/custom-domains.test.ts` (the `"redirects non-service dealer/business-management paths..."` and `"does not redirect non-service dealer/business-management paths when service is null"` tests) with:

```ts
  const ALL_DEALER_TOOL_KEYS = [
    "afa_orders", "upgrade", "my_shop", "shop_dashboard", "sub_agents",
    "sub_agent_catalog", "ussd_shop", "payment_reverify", "buy_stock",
  ]

  it("redirects dealer/business-management paths to the first selected service when those pages are hidden", () => {
    expect(getServiceRedirect("/dashboard/afa-orders", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/upgrade", ["data_bundles"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/data-packages")
    expect(getServiceRedirect("/dashboard/my-shop", ["data_bundles"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/data-packages")
    expect(getServiceRedirect("/dashboard/my-shop/settings", ["data_bundles"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/data-packages")
    expect(getServiceRedirect("/dashboard/shop-dashboard", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/sub-agents", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/sub-agent-catalog", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/sub-agent-catalog/add", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/ussd-shop", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/payment-reverify", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/buy-stock", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe("/dashboard/airtime")
  })

  it("does NOT redirect a dealer-tool path when its key is not in hiddenPages (admin has shown it)", () => {
    expect(getServiceRedirect("/dashboard/my-shop", ["airtime"], [])).toBeNull()
    expect(getServiceRedirect("/dashboard/upgrade", ["airtime"], ["afa_orders"])).toBeNull()
  })

  it("defaults to nothing hidden when hiddenPages is omitted entirely", () => {
    expect(getServiceRedirect("/dashboard/my-shop", ["airtime"])).toBeNull()
  })

  it("does not redirect dealer/business-management paths when service is null (main site), regardless of hiddenPages", () => {
    expect(isPathAllowedForService("/dashboard/my-shop", null, ALL_DEALER_TOOL_KEYS)).toBe(true)
    expect(isPathAllowedForService("/dashboard/sub-agents", null, ALL_DEALER_TOOL_KEYS)).toBe(true)
  })
```

Replace lines 97-101 (the `"disallows non-service dealer/business-management paths on a branded domain"` test in the `isPathAllowedForService` describe block) with:

```ts
  it("disallows dealer/business-management paths on a branded domain when they're hidden", () => {
    expect(isPathAllowedForService("/dashboard/my-shop", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe(false)
    expect(isPathAllowedForService("/dashboard/afa-orders", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe(false)
    expect(isPathAllowedForService("/dashboard/upgrade", ["airtime"], ALL_DEALER_TOOL_KEYS)).toBe(false)
  })

  it("allows a dealer-tool path once it's no longer in hiddenPages", () => {
    expect(isPathAllowedForService("/dashboard/my-shop", ["airtime"], [])).toBe(true)
  })
```

Add a new describe block at the end of the file:

```ts
describe("isPageHidden", () => {
  it("returns true when the key is in hiddenPages", () => {
    expect(isPageHidden("landing_page", ["landing_page", "wallet"])).toBe(true)
  })

  it("returns false when the key is not in hiddenPages", () => {
    expect(isPageHidden("landing_page", ["wallet"])).toBe(false)
  })

  it("returns false for an empty hiddenPages array", () => {
    expect(isPageHidden("wallet", [])).toBe(false)
  })
})
```

Add `isPageHidden` to the existing top-of-file import list (it currently imports `getServiceRedirect, getServicePrimaryPath, isPathAllowedForService, normalizeDomainHost, hexToHslTriplet, isReservedDomainHost`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/custom-domains.test.ts`
Expected: FAIL — the new/changed assertions expect dealer-tool paths to redirect only when `hiddenPages` explicitly lists them, but the current implementation still always redirects them via the hardcoded `NON_SERVICE_GATED_PATHS`; `isPageHidden` doesn't exist yet.

- [ ] **Step 3: Implement the changes**

Replace the `NON_SERVICE_GATED_PATHS` block (lines 19-33):

```ts
// Dealer/business-management tools that aren't tied to any one of the four
// core services — hidden and blocked on any branded domain, regardless of
// which services are selected, unless a selected service's own path already
// covers the route (e.g. bulk_sms already covers /dashboard/sms).
const NON_SERVICE_GATED_PATHS = [
  "/dashboard/afa-orders",
  "/dashboard/upgrade",
  "/dashboard/my-shop",
  "/dashboard/shop-dashboard",
  "/dashboard/sub-agents",
  "/dashboard/sub-agent-catalog",
  "/dashboard/ussd-shop",
  "/dashboard/payment-reverify",
  "/dashboard/buy-stock",
]
```

with:

```ts
import { TOGGLEABLE_PAGES } from "./custom-domain-pages"
```

(add this import near the top of the file, alongside any other imports — there are none currently, so it becomes the file's first line).

Replace `getServiceRedirect` and `isPathAllowedForService`:

```ts
export function getServiceRedirect(path: string, services: DomainService[]): string | null {
  if (!services || services.length === 0) return null

  // Recognized-service check first, filtering out any unrecognized value
  // defensively (e.g. a stale cached/header entry referencing a since-removed
  // service) so it never crashes rendering.
  const validServices = services.filter(s => SERVICE_PATH_PREFIXES[s])
  if (validServices.length === 0) return null

  const ownPrefixes = validServices.flatMap(s => SERVICE_PATH_PREFIXES[s])
  if (ownPrefixes.some(p => path.startsWith(p))) return null

  const belongsToOtherService = (Object.entries(SERVICE_PATH_PREFIXES) as [DomainService, string[]][])
    .some(([s, prefixes]) => !validServices.includes(s) && prefixes.some(p => path.startsWith(p)))
  const belongsToNonServiceGated = NON_SERVICE_GATED_PATHS.some(p => path.startsWith(p))
  if (!belongsToOtherService && !belongsToNonServiceGated) return null

  return getServicePrimaryPath(validServices[0])
}

/** Convenience wrapper for nav filtering: true when `path` should be shown for `services`. */
export function isPathAllowedForService(path: string, services: DomainService[] | null): boolean {
  if (!services || services.length === 0) return true
  return getServiceRedirect(path, services) === null
}
```

with:

```ts
export function getServiceRedirect(path: string, services: DomainService[], hiddenPages: string[] = []): string | null {
  if (!services || services.length === 0) return null

  // Recognized-service check first, filtering out any unrecognized value
  // defensively (e.g. a stale cached/header entry referencing a since-removed
  // service) so it never crashes rendering.
  const validServices = services.filter(s => SERVICE_PATH_PREFIXES[s])
  if (validServices.length === 0) return null

  const ownPrefixes = validServices.flatMap(s => SERVICE_PATH_PREFIXES[s])
  if (ownPrefixes.some(p => path.startsWith(p))) return null

  const belongsToOtherService = (Object.entries(SERVICE_PATH_PREFIXES) as [DomainService, string[]][])
    .some(([s, prefixes]) => !validServices.includes(s) && prefixes.some(p => path.startsWith(p)))
  const hiddenPaths = TOGGLEABLE_PAGES.filter(p => p.path && hiddenPages.includes(p.key)).map(p => p.path!)
  const belongsToHiddenPage = hiddenPaths.some(p => path.startsWith(p))
  if (!belongsToOtherService && !belongsToHiddenPage) return null

  return getServicePrimaryPath(validServices[0])
}

/** Convenience wrapper for nav filtering: true when `path` should be shown for `services`. */
export function isPathAllowedForService(path: string, services: DomainService[] | null, hiddenPages: string[] = []): boolean {
  if (!services || services.length === 0) return true
  return getServiceRedirect(path, services, hiddenPages) === null
}

/** True when `key` (a TOGGLEABLE_PAGES key) is hidden for the current domain. */
export function isPageHidden(key: string, hiddenPages: string[]): boolean {
  return hiddenPages.includes(key)
}
```

Update `CustomDomainConfig`:

```ts
export interface CustomDomainConfig {
  domain: string
  services: DomainService[]
  site_name: string
  logo_url: string | null
  primary_color: string | null
  is_active: boolean
}
```

with:

```ts
export interface CustomDomainConfig {
  domain: string
  services: DomainService[]
  site_name: string
  logo_url: string | null
  primary_color: string | null
  is_active: boolean
  hidden_pages: string[]
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/custom-domains.test.ts`
Expected: PASS (every test in the file, including all pre-existing ones unrelated to this change)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: Errors in every other file that calls `getServiceRedirect`/`isPathAllowedForService` or constructs a `CustomDomainConfig` without `hidden_pages` — this is expected at this point in the plan; Tasks 3, 4, 6 fix each one. Confirm there are no errors specifically inside `lib/custom-domains.ts` itself.

- [ ] **Step 6: Commit**

```bash
git add lib/custom-domains.ts lib/custom-domains.test.ts
git commit -m "feat(custom-domains): generalize dealer-tool gating into the hidden_pages registry"
```

---

### Task 3: `lib/custom-domain-lookup.ts` — read and round-trip `hidden_pages`

**Files:**
- Modify: `lib/custom-domain-lookup.ts:76`
- Test: `lib/custom-domain-lookup.test.ts`

**Interfaces:**
- Consumes: `CustomDomainConfig.hidden_pages` (Task 2).
- Produces: `resolveCustomDomain()` now returns `hidden_pages` in every config it resolves — consumed by Task 4 (middleware).

- [ ] **Step 1: Write the failing test**

In `lib/custom-domain-lookup.test.ts`, add `hidden_pages: []` to the existing `sampleConfig` fixture:

```ts
const sampleConfig: CustomDomainConfig = {
  domain: "checkresults.com",
  services: ["results_checker"],
  site_name: "CheckResults",
  logo_url: null,
  primary_color: "#059669",
  is_active: true,
  hidden_pages: [],
}
```

Add a new test inside the `describe("resolveCustomDomain", ...)` block, after the `"queries Supabase and fills the cache on a Redis miss"` test:

```ts
  it("round-trips a non-empty hidden_pages array through a fresh Supabase read", async () => {
    redisGetMock.mockResolvedValueOnce(null)
    maybeSingleMock.mockResolvedValueOnce({ data: { ...sampleConfig, hidden_pages: ["wallet", "upgrade"] }, error: null })
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("checkresults.com")

    expect(result?.hidden_pages).toEqual(["wallet", "upgrade"])
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/custom-domain-lookup.test.ts`
Expected: FAIL — every test asserting `toEqual(sampleConfig)` now fails because the implementation's `select()` doesn't fetch `hidden_pages`, so the returned config is missing that field; the new round-trip test fails for the same reason.

- [ ] **Step 3: Update the Supabase select**

Replace line 76:

```ts
      .select("domain, services, site_name, logo_url, primary_color, is_active")
```

with:

```ts
      .select("domain, services, site_name, logo_url, primary_color, is_active, hidden_pages")
```

(No other code in this file changes — `const config = data as CustomDomainConfig` already casts the full row, so adding the column to the select is sufficient.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/custom-domain-lookup.test.ts`
Expected: PASS (every test in the file)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `lib/custom-domain-lookup.ts`.

- [ ] **Step 6: Commit**

```bash
git add lib/custom-domain-lookup.ts lib/custom-domain-lookup.test.ts
git commit -m "feat(custom-domains): include hidden_pages in the resolved domain config"
```

---

### Task 4: Middleware — landing-page redirect + pass `hidden_pages` through

**Files:**
- Modify: `middleware.ts:7, 122-129, 142-151`

**Interfaces:**
- Consumes: `CustomDomainConfig.hidden_pages` (Task 3), `getServiceRedirect`, `isPageHidden` (Task 2).
- Produces: `x-domain-hidden-pages` request header — consumed by Task 5 (`app/layout.tsx`).

- [ ] **Step 1: Update the import**

Replace line 7:

```ts
import { getServiceRedirect, normalizeDomainHost } from "@/lib/custom-domains"
```

with:

```ts
import { getServiceRedirect, isPageHidden, normalizeDomainHost } from "@/lib/custom-domains"
```

- [ ] **Step 2: Add the landing-page-hide redirect and pass `hidden_pages` to the service redirect**

Re-read the current file first to confirm lines 122-129 still match (this file is actively touched by other concurrent work on this repo — confirm before editing, don't assume). Replace:

```ts
  if (customDomainConfig) {
    const serviceRedirectPath = getServiceRedirect(path, customDomainConfig.services)
    if (serviceRedirectPath) {
      const url = request.nextUrl.clone()
      url.pathname = serviceRedirectPath
      return NextResponse.redirect(url)
    }
  }
```

with:

```ts
  if (customDomainConfig) {
    // Landing-page-hide: "/" skips the marketing homepage entirely and goes
    // straight to login, regardless of auth state. Checked before the
    // service-redirect below since "/" would otherwise just fall through as
    // an unrestricted account-wide path.
    if (isPageHidden("landing_page", customDomainConfig.hidden_pages) && path === "/") {
      const url = request.nextUrl.clone()
      url.pathname = "/auth/login"
      return NextResponse.redirect(url)
    }

    const serviceRedirectPath = getServiceRedirect(path, customDomainConfig.services, customDomainConfig.hidden_pages)
    if (serviceRedirectPath) {
      const url = request.nextUrl.clone()
      url.pathname = serviceRedirectPath
      return NextResponse.redirect(url)
    }
  }
```

- [ ] **Step 3: Add the new header**

Replace:

```ts
    h.delete("x-domain-services")
    h.delete("x-domain-site-name")
    h.delete("x-domain-logo")
    h.delete("x-domain-color")
    if (customDomainConfig) {
      try {
        h.set("x-domain-services", customDomainConfig.services.join(","))
        h.set("x-domain-site-name", customDomainConfig.site_name)
        if (customDomainConfig.logo_url) h.set("x-domain-logo", customDomainConfig.logo_url)
        if (customDomainConfig.primary_color) h.set("x-domain-color", customDomainConfig.primary_color)
      } catch (e) {
```

with:

```ts
    h.delete("x-domain-services")
    h.delete("x-domain-site-name")
    h.delete("x-domain-logo")
    h.delete("x-domain-color")
    h.delete("x-domain-hidden-pages")
    if (customDomainConfig) {
      try {
        h.set("x-domain-services", customDomainConfig.services.join(","))
        h.set("x-domain-site-name", customDomainConfig.site_name)
        if (customDomainConfig.logo_url) h.set("x-domain-logo", customDomainConfig.logo_url)
        if (customDomainConfig.primary_color) h.set("x-domain-color", customDomainConfig.primary_color)
        h.set("x-domain-hidden-pages", customDomainConfig.hidden_pages.join(","))
      } catch (e) {
```

(The `try`/`catch` and everything after it is unchanged — only these two new lines are inserted.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `middleware.ts`.

- [ ] **Step 5: Manual verification**

No automated test exists for this file (matches convention). Re-read the modified function once, top to bottom, and confirm: when `customDomainConfig === null` (every request on the main site today), the new branch is unreachable and the new header is deleted but never set — a no-op. Confirm the landing-page branch runs strictly before the service-redirect call, which runs strictly before the rest of the function.

- [ ] **Step 6: Commit**

```bash
git add middleware.ts
git commit -m "feat(custom-domains): add landing-page-hide redirect, thread hidden_pages through middleware"
```

---

### Task 5: Branding context — thread `hiddenPages` through

**Files:**
- Modify: `components/providers/domain-branding-provider.tsx:6-18`
- Modify: `app/layout.tsx:133-138`

**Interfaces:**
- Consumes: `x-domain-hidden-pages` header (Task 4).
- Produces: `DomainBranding` gains `hiddenPages: string[]` — consumed by Tasks 6-10.

- [ ] **Step 1: Extend `DomainBranding`**

Replace lines 6-18 of `components/providers/domain-branding-provider.tsx`:

```ts
export interface DomainBranding {
  services: DomainService[] | null
  siteName: string | null
  logoUrl: string | null
  primaryColor: string | null
}

const DEFAULT_BRANDING: DomainBranding = {
  services: null,
  siteName: null,
  logoUrl: null,
  primaryColor: null,
}
```

with:

```ts
export interface DomainBranding {
  services: DomainService[] | null
  siteName: string | null
  logoUrl: string | null
  primaryColor: string | null
  hiddenPages: string[]
}

const DEFAULT_BRANDING: DomainBranding = {
  services: null,
  siteName: null,
  logoUrl: null,
  primaryColor: null,
  hiddenPages: [],
}
```

- [ ] **Step 2: Parse the new header in `app/layout.tsx`**

Replace lines 133-138:

```ts
  const domainBranding: DomainBranding = {
    services: parsedServices.length > 0 ? parsedServices : null,
    siteName: headersList.get("x-domain-site-name"),
    logoUrl: headersList.get("x-domain-logo"),
    primaryColor: headersList.get("x-domain-color"),
  };
```

with:

```ts
  const rawHiddenPages = headersList.get("x-domain-hidden-pages");
  const domainBranding: DomainBranding = {
    services: parsedServices.length > 0 ? parsedServices : null,
    siteName: headersList.get("x-domain-site-name"),
    logoUrl: headersList.get("x-domain-logo"),
    primaryColor: headersList.get("x-domain-color"),
    hiddenPages: rawHiddenPages ? rawHiddenPages.split(",").filter(Boolean) : [],
  };
```

(`.filter(Boolean)` guards against `"".split(",")` producing `[""]` when a domain has nothing hidden — `hidden_pages.join(",")` on an empty array is `""`.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: Errors in every file that constructs a `DomainBranding` object without `hiddenPages` (Tasks 6-10 each fix one). Confirm no errors specifically inside `domain-branding-provider.tsx` or `app/layout.tsx`.

- [ ] **Step 4: Manual verification**

No automated tests exist for these two files (matches convention). Confirm by reading: on the main site, `buildRequestHeaders` never sets `x-domain-hidden-pages`, so `headersList.get(...)` returns `null`, producing `hiddenPages: []` — the same value `DEFAULT_BRANDING` already has. No-op end to end.

- [ ] **Step 5: Commit**

```bash
git add components/providers/domain-branding-provider.tsx app/layout.tsx
git commit -m "feat(custom-domains): thread hiddenPages through the branding context"
```

---

### Task 6: Nav filtering — sidebar + bottom nav

**Files:**
- Modify: `components/layout/sidebar.tsx:364, 419`
- Modify: `components/layout/bottom-nav.tsx:9-10, 61-67`

**Interfaces:**
- Consumes: `domainBranding.hiddenPages` (Task 5), `isPathAllowedForService` (Task 2), `isPageHidden` (Task 2).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Pass `hiddenPages` at both `sidebar.tsx` call sites**

Re-read the current file first to confirm these two lines still match (other concurrent work may have shifted them). Replace line 364:

```ts
            if (!isPathAllowedForService(item.href, domainBranding.services)) return false
```

with:

```ts
            if (!isPathAllowedForService(item.href, domainBranding.services, domainBranding.hiddenPages)) return false
```

Replace line 419:

```ts
              {shopItems.filter(item => userRole && item.roles.includes(userRole) && isPathAllowedForService(item.href, domainBranding.services)).map((item) => {
```

with:

```ts
              {shopItems.filter(item => userRole && item.roles.includes(userRole) && isPathAllowedForService(item.href, domainBranding.services, domainBranding.hiddenPages)).map((item) => {
```

- [ ] **Step 2: Fix the hardcoded Wallet slot in `bottom-nav.tsx`**

This file does NOT currently filter `USER_NAV` through `isPathAllowedForService` at all — it's a fixed 5-slot array with `/dashboard/wallet` hardcoded directly in. Update the import (line 10):

```ts
import { getServicePrimaryPath, type DomainService } from "@/lib/custom-domains"
```

with:

```ts
import { getServicePrimaryPath, isPageHidden, type DomainService } from "@/lib/custom-domains"
```

Replace the `USER_NAV` array (currently lines 61-67):

```ts
  const USER_NAV = [
    { href: "/dashboard",             label: "Home",    icon: Home,        isFab: false },
    { href: "/dashboard/wallet",      label: "Wallet",  icon: Wallet,      isFab: false },
    { href: fabHref,                  label: fabLabel,  icon: Package,     isFab: true },
    { href: "/dashboard/my-orders",   label: "Orders",  icon: ShoppingBag, isFab: false },
    { href: shopSlotHref,             label: shopSlotLabel, icon: ShopSlotIcon, isFab: false },
  ]
```

with:

```ts
  const USER_NAV = [
    { href: "/dashboard",             label: "Home",    icon: Home,        isFab: false },
    ...(isPageHidden("wallet", domainBranding.hiddenPages)
      ? []
      : [{ href: "/dashboard/wallet", label: "Wallet", icon: Wallet, isFab: false }]),
    { href: fabHref,                  label: fabLabel,  icon: Package,     isFab: true },
    { href: "/dashboard/my-orders",   label: "Orders",  icon: ShoppingBag, isFab: false },
    { href: shopSlotHref,             label: shopSlotLabel, icon: ShopSlotIcon, isFab: false },
  ]
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `components/layout/sidebar.tsx` or `components/layout/bottom-nav.tsx`.

- [ ] **Step 4: Manual verification**

No automated tests exist for either file (matches convention). Confirm by reading: on the main site, `domainBranding.hiddenPages` is `[]`, so `isPathAllowedForService(...)` behaves exactly as before (its `services === null` early-return is unaffected by the new third argument) and `isPageHidden("wallet", [])` is `false`, so `USER_NAV` still has all 5 slots. No-op for all current traffic.

- [ ] **Step 5: Commit**

```bash
git add components/layout/sidebar.tsx components/layout/bottom-nav.tsx
git commit -m "feat(custom-domains): respect hidden_pages in sidebar and bottom-nav filtering"
```

---

### Task 7: Homepage — gate guest-purchase and join-channel

**Files:**
- Modify: `app/page.tsx:17, 394, 401-407, 700`

**Interfaces:**
- Consumes: `useDomainBranding().hiddenPages`, `isPageHidden` (Task 2, 5). `domainBranding` is already destructured in this component (`const domainBranding = useDomainBranding()`, line 311) — no new hook call needed.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the import**

Add below the existing `useDomainBranding` import (line 17):

```ts
import { isPageHidden } from "@/lib/custom-domains"
```

- [ ] **Step 2: Gate the first `GuestPurchaseButton` and the "Join Community" button**

Re-read the current file first to confirm these lines still match (this file has multiple unrelated sections). Replace:

```tsx
            <div className="mt-5 flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
              <Link href="/auth/signup"><Button size="lg" className="gap-2 w-full sm:w-auto">Get started <ArrowRight className="w-4 h-4" /></Button></Link>
              <GuestPurchaseButton variant="outline" className="w-full sm:w-auto" />
            </div>
```

with:

```tsx
            <div className="mt-5 flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
              <Link href="/auth/signup"><Button size="lg" className="gap-2 w-full sm:w-auto">Get started <ArrowRight className="w-4 h-4" /></Button></Link>
              {!isPageHidden("guest_purchase", domainBranding.hiddenPages) && (
                <GuestPurchaseButton variant="outline" className="w-full sm:w-auto" />
              )}
            </div>
```

Replace:

```tsx
            {communityLoading ? (
              <div className="mt-5 flex justify-center lg:justify-start"><Skeleton className="h-11 w-full sm:w-56 rounded-md" /></div>
            ) : communityLink ? (
              <a href={communityLink} target="_blank" rel="noopener noreferrer" className="mt-5 inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 font-display text-sm font-semibold text-primary hover:bg-primary/15 transition-colors">
                <MessageCircle className="w-4 h-4" /> Join Community
              </a>
            ) : null}
```

with:

```tsx
            {!isPageHidden("join_channel", domainBranding.hiddenPages) && (
              communityLoading ? (
                <div className="mt-5 flex justify-center lg:justify-start"><Skeleton className="h-11 w-full sm:w-56 rounded-md" /></div>
              ) : communityLink ? (
                <a href={communityLink} target="_blank" rel="noopener noreferrer" className="mt-5 inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 font-display text-sm font-semibold text-primary hover:bg-primary/15 transition-colors">
                  <MessageCircle className="w-4 h-4" /> Join Community
                </a>
              ) : null
            )}
```

- [ ] **Step 3: Gate the second `GuestPurchaseButton`**

Replace:

```tsx
              <Link href="/auth/signup">
                <Button className="gap-2 w-full sm:w-auto">
                  Create Free Account
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              <GuestPurchaseButton variant="outline" className="w-full sm:w-auto" />
```

with:

```tsx
              <Link href="/auth/signup">
                <Button className="gap-2 w-full sm:w-auto">
                  Create Free Account
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              {!isPageHidden("guest_purchase", domainBranding.hiddenPages) && (
                <GuestPurchaseButton variant="outline" className="w-full sm:w-auto" />
              )}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/page.tsx`.

- [ ] **Step 5: Manual verification**

No automated test exists for this file (matches convention). Confirm: on the main site, `domainBranding.hiddenPages` is `[]`, so `isPageHidden(...)` is always `false` and all three elements render exactly as before — a no-op.

- [ ] **Step 6: Commit**

```bash
git add app/page.tsx
git commit -m "feat(custom-domains): gate homepage guest-purchase and join-channel buttons by hidden_pages"
```

---

### Task 8: Login page — gate buttons + fix branding

**Files:**
- Modify: `app/auth/login-form.tsx`

**Interfaces:**
- Consumes: `useDomainBranding()`, `isPageHidden` (Task 2, 5).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add imports and the branding hook call**

Replace:

```ts
import GuestPurchaseButton from "@/components/GuestPurchaseButton"
import GoogleAuthButton from "@/components/GoogleAuthButton"
import { useCommunityLink } from "@/hooks/use-community-link"
import { MessageCircle, Mail, Lock, Eye, EyeOff, Check } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
```

with:

```ts
import GuestPurchaseButton from "@/components/GuestPurchaseButton"
import GoogleAuthButton from "@/components/GoogleAuthButton"
import { useCommunityLink } from "@/hooks/use-community-link"
import { useDomainBranding } from "@/components/providers/domain-branding-provider"
import { isPageHidden } from "@/lib/custom-domains"
import { MessageCircle, Mail, Lock, Eye, EyeOff, Check } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
```

Replace:

```ts
  const { communityLink, loading: communityLoading } = useCommunityLink()
```

with:

```ts
  const { communityLink, loading: communityLoading } = useCommunityLink()
  const domainBranding = useDomainBranding()
```

- [ ] **Step 2: Fix the desktop brand-panel logo and name**

Replace:

```tsx
        <Link href="/" className="relative flex items-center gap-3">
          <div className="rounded-xl bg-card/15 p-2">
            <img src="/favicon-v2.jpeg" alt="DATAGOD" className="h-7 w-7 rounded-lg object-cover" />
          </div>
          <span className="text-xl font-extrabold tracking-tight">DATAGOD</span>
        </Link>
```

with:

```tsx
        <Link href="/" className="relative flex items-center gap-3">
          <div className="rounded-xl bg-card/15 p-2">
            <img src={domainBranding.logoUrl || "/favicon-v2.jpeg"} alt={domainBranding.siteName || "DATAGOD"} className="h-7 w-7 rounded-lg object-cover" />
          </div>
          <span className="text-xl font-extrabold tracking-tight">{domainBranding.siteName || "DATAGOD"}</span>
        </Link>
```

- [ ] **Step 3: Fix the mobile logo and name**

Replace:

```tsx
          <div className="mb-8 flex items-center justify-center gap-2 lg:hidden">
            <div className="rounded-lg bg-card p-2 shadow-sm">
              <img src="/favicon-v2.jpeg" alt="DATAGOD" className="h-7 w-7 rounded-md object-cover" />
            </div>
            <span className="text-lg font-extrabold tracking-tight">DATAGOD</span>
          </div>
```

with:

```tsx
          <div className="mb-8 flex items-center justify-center gap-2 lg:hidden">
            <div className="rounded-lg bg-card p-2 shadow-sm">
              <img src={domainBranding.logoUrl || "/favicon-v2.jpeg"} alt={domainBranding.siteName || "DATAGOD"} className="h-7 w-7 rounded-md object-cover" />
            </div>
            <span className="text-lg font-extrabold tracking-tight">{domainBranding.siteName || "DATAGOD"}</span>
          </div>
```

- [ ] **Step 4: Gate the `GuestPurchaseButton`**

Replace:

```tsx
          <div className="mt-4">
            <GuestPurchaseButton variant="secondary" className="w-full" />
          </div>
```

with:

```tsx
          {!isPageHidden("guest_purchase", domainBranding.hiddenPages) && (
            <div className="mt-4">
              <GuestPurchaseButton variant="secondary" className="w-full" />
            </div>
          )}
```

- [ ] **Step 5: Gate the "Join Community" button**

Replace:

```tsx
          {communityLoading ? (
            <Skeleton className="mt-3 h-10 w-full rounded-md" />
          ) : communityLink ? (
            <a href={communityLink} target="_blank" rel="noopener noreferrer" className="mt-3 block">
              <Button type="button" className="w-full gap-2 bg-success hover:bg-success/90 text-primary-foreground">
                <MessageCircle className="h-4 w-4" /> Join Community
              </Button>
            </a>
          ) : null}
```

with:

```tsx
          {!isPageHidden("join_channel", domainBranding.hiddenPages) && (
            communityLoading ? (
              <Skeleton className="mt-3 h-10 w-full rounded-md" />
            ) : communityLink ? (
              <a href={communityLink} target="_blank" rel="noopener noreferrer" className="mt-3 block">
                <Button type="button" className="w-full gap-2 bg-success hover:bg-success/90 text-primary-foreground">
                  <MessageCircle className="h-4 w-4" /> Join Community
                </Button>
              </a>
            ) : null
          )}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/auth/login-form.tsx`.

- [ ] **Step 7: Manual verification**

No automated test exists for this file (matches convention). Confirm: on the main site, `domainBranding.siteName`/`.logoUrl` are both `null` (falls back to "DATAGOD"/`/favicon-v2.jpeg`, identical to before) and `hiddenPages` is `[]` (both buttons still render). No-op for current traffic; a branded domain sees its own name/logo and can have either button hidden.

- [ ] **Step 8: Commit**

```bash
git add app/auth/login-form.tsx
git commit -m "feat(custom-domains): gate login-page buttons by hidden_pages, fix hardcoded DATAGOD branding"
```

---

### Task 9: Signup page — fix branding

**Files:**
- Modify: `app/auth/signup/page.tsx:17-ish (imports), 78 (component start), 321-326, 349-354`

**Interfaces:**
- Consumes: `useDomainBranding()` (Task 5).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the import and hook call**

Add alongside this file's existing imports (after `import GoogleAuthButton from "@/components/GoogleAuthButton"`):

```ts
import { useDomainBranding } from "@/components/providers/domain-branding-provider"
```

Replace the start of the component:

```ts
export default function SignupPage() {

  const [isLoading, setIsLoading] = useState(false)
```

with:

```ts
export default function SignupPage() {
  const domainBranding = useDomainBranding()

  const [isLoading, setIsLoading] = useState(false)
```

- [ ] **Step 2: Fix the desktop brand-panel logo and name**

Replace:

```tsx
          <Link href="/" className="relative flex items-center gap-3">
            <div className="rounded-xl bg-card/15 p-2">
              <img src="/favicon-v2.jpeg" alt="DATAGOD" className="h-7 w-7 rounded-lg object-cover" />
            </div>
            <span className="text-xl font-extrabold tracking-tight">DATAGOD</span>
          </Link>
```

with:

```tsx
          <Link href="/" className="relative flex items-center gap-3">
            <div className="rounded-xl bg-card/15 p-2">
              <img src={domainBranding.logoUrl || "/favicon-v2.jpeg"} alt={domainBranding.siteName || "DATAGOD"} className="h-7 w-7 rounded-lg object-cover" />
            </div>
            <span className="text-xl font-extrabold tracking-tight">{domainBranding.siteName || "DATAGOD"}</span>
          </Link>
```

- [ ] **Step 3: Fix the mobile logo and name**

Replace:

```tsx
            <div className="mb-8 flex items-center justify-center gap-2 lg:hidden">
              <div className="rounded-lg bg-card p-2 shadow-sm">
                <img src="/favicon-v2.jpeg" alt="DATAGOD" className="h-7 w-7 rounded-md object-cover" />
              </div>
              <span className="text-lg font-extrabold tracking-tight">DATAGOD</span>
            </div>
```

with:

```tsx
            <div className="mb-8 flex items-center justify-center gap-2 lg:hidden">
              <div className="rounded-lg bg-card p-2 shadow-sm">
                <img src={domainBranding.logoUrl || "/favicon-v2.jpeg"} alt={domainBranding.siteName || "DATAGOD"} className="h-7 w-7 rounded-md object-cover" />
              </div>
              <span className="text-lg font-extrabold tracking-tight">{domainBranding.siteName || "DATAGOD"}</span>
            </div>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/auth/signup/page.tsx`.

- [ ] **Step 5: Manual verification**

No automated test exists for this file (matches convention). Confirm: on the main site, `domainBranding.siteName`/`.logoUrl` are both `null`, so both spots fall back to "DATAGOD"/`/favicon-v2.jpeg` exactly as before — a no-op.

- [ ] **Step 6: Commit**

```bash
git add app/auth/signup/page.tsx
git commit -m "feat(custom-domains): fix signup page to use the domain's own branding instead of hardcoded DATAGOD"
```

---

### Task 10: Dashboard home — gate wallet hero, Top Up button, and the low-balance modal

**Files:**
- Modify: `app/dashboard/page.tsx:16, 381-384, 408-436, 516-518`

**Interfaces:**
- Consumes: `useDomainBranding().hiddenPages`, `isPageHidden` (Task 2, 5). `domainBranding` is already destructured in this component (`const domainBranding = useDomainBranding()`, line 97) — no new hook call needed.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the import**

Replace line 16:

```ts
import { getServicePrimaryPath, type DomainService } from "@/lib/custom-domains"
```

with:

```ts
import { getServicePrimaryPath, isPageHidden, type DomainService } from "@/lib/custom-domains"
```

- [ ] **Step 2: Suppress the low-balance modal when wallet is hidden**

Replace:

```tsx
      <WalletOnboardingModal
        open={showOnboarding && !onboardingLoading}
        onComplete={completeOnboarding}
      />
```

with:

```tsx
      <WalletOnboardingModal
        open={showOnboarding && !onboardingLoading && !isPageHidden("wallet", domainBranding.hiddenPages)}
        onComplete={completeOnboarding}
      />
```

- [ ] **Step 3: Gate the wallet hero card**

Re-read the current file first to confirm this block still matches (find it by searching for `data-tour="wallet-balance"`). Wrap the entire wallet hero `<Card>` (from `<Card data-tour="wallet-balance" ...>` through its matching closing `</Card>`, currently spanning these exact lines):

```tsx
          <Card
            data-tour="wallet-balance"
            className={`lg:col-span-2 border-0 text-primary-foreground relative overflow-hidden ${isDealer
              ? "bg-gradient-to-br from-primary to-brand-accent"
              : "bg-gradient-to-br from-primary to-primary"
              }`}
          >
            <div className="absolute -right-10 -top-12 w-48 h-48 rounded-full bg-card/10" />
            <CardContent className="p-6 relative">
              <p className="text-sm font-medium text-white/85">Wallet Balance</p>
              <p className="text-4xl font-extrabold tracking-tight tabular-nums mt-2">
                GHS {Math.max(0, walletBalance || 0).toFixed(2)}
              </p>
              <p className="text-xs text-white/75 mt-1">Available funds</p>
              <div className="flex flex-wrap gap-2 mt-5">
                <Button onClick={() => router.push("/dashboard/wallet")} className="bg-card text-primary hover:bg-card/90 font-semibold">
                  ＋ Top Up
                </Button>
                <Button onClick={() => router.push(primaryService ? getServicePrimaryPath(primaryService) : "/dashboard/data-packages")} className="bg-card/15 text-white hover:bg-card/25 border-0">
                  {primaryService ? SERVICE_QUICK_LABELS[primaryService] : "Buy Data"}
                </Button>
                <Button onClick={() => router.push("/dashboard/my-orders")} className="bg-card/15 text-white hover:bg-card/25 border-0">
                  My Orders
                </Button>
              </div>
            </CardContent>
          </Card>
```

with the same block wrapped in a conditional:

```tsx
          {!isPageHidden("wallet", domainBranding.hiddenPages) && (
            <Card
              data-tour="wallet-balance"
              className={`lg:col-span-2 border-0 text-primary-foreground relative overflow-hidden ${isDealer
                ? "bg-gradient-to-br from-primary to-brand-accent"
                : "bg-gradient-to-br from-primary to-primary"
                }`}
            >
              <div className="absolute -right-10 -top-12 w-48 h-48 rounded-full bg-card/10" />
              <CardContent className="p-6 relative">
                <p className="text-sm font-medium text-white/85">Wallet Balance</p>
                <p className="text-4xl font-extrabold tracking-tight tabular-nums mt-2">
                  GHS {Math.max(0, walletBalance || 0).toFixed(2)}
                </p>
                <p className="text-xs text-white/75 mt-1">Available funds</p>
                <div className="flex flex-wrap gap-2 mt-5">
                  <Button onClick={() => router.push("/dashboard/wallet")} className="bg-card text-primary hover:bg-card/90 font-semibold">
                    ＋ Top Up
                  </Button>
                  <Button onClick={() => router.push(primaryService ? getServicePrimaryPath(primaryService) : "/dashboard/data-packages")} className="bg-card/15 text-white hover:bg-card/25 border-0">
                    {primaryService ? SERVICE_QUICK_LABELS[primaryService] : "Buy Data"}
                  </Button>
                  <Button onClick={() => router.push("/dashboard/my-orders")} className="bg-card/15 text-white hover:bg-card/25 border-0">
                    My Orders
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
```

(The sibling account-meta `<Card>` right after this one, and the surrounding `grid gap-4 lg:grid-cols-3` div, are untouched — CSS grid reflows fine with one fewer item.)

- [ ] **Step 4: Gate the second "Top Up Wallet" button**

Replace:

```tsx
            <Button variant="outline" onClick={() => router.push("/dashboard/my-orders")} className="font-semibold">
              View My Orders
            </Button>
            <Button variant="outline" onClick={() => router.push("/dashboard/wallet")} className="font-semibold">
              Top Up Wallet
            </Button>
          </CardContent>
        </Card>
```

with:

```tsx
            <Button variant="outline" onClick={() => router.push("/dashboard/my-orders")} className="font-semibold">
              View My Orders
            </Button>
            {!isPageHidden("wallet", domainBranding.hiddenPages) && (
              <Button variant="outline" onClick={() => router.push("/dashboard/wallet")} className="font-semibold">
                Top Up Wallet
              </Button>
            )}
          </CardContent>
        </Card>
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/dashboard/page.tsx`.

- [ ] **Step 6: Manual verification**

No automated test exists for this file (matches convention). Confirm: on the main site, `domainBranding.hiddenPages` is `[]`, so `isPageHidden("wallet", [])` is always `false` — the modal's `open` condition, the hero card, and the Top Up button all behave exactly as before. No-op for current traffic. Also confirm the modal's suppression is reversible, not a one-way flag: `isPageHidden` is a pure, stateless check of the current `hiddenPages` array on every render — there's no "already dismissed while hidden" state stored anywhere, so the moment an admin removes `wallet` from `hidden_pages`, the very next render re-evaluates `showOnboarding && !onboardingLoading && !isPageHidden(...)` fresh and the modal returns if the balance is still under GHS 5.

- [ ] **Step 7: Commit**

```bash
git add app/dashboard/page.tsx
git commit -m "feat(custom-domains): gate dashboard wallet widgets and low-balance modal by hidden_pages"
```

---

### Task 11: Admin API route — validate and persist `hidden_pages`

**Files:**
- Modify: `app/api/admin/custom-domains/route.ts`
- Test: `app/api/admin/custom-domains/route.test.ts`

**Interfaces:**
- Consumes: `TOGGLEABLE_PAGES` (Task 1).
- Produces: `GET` includes `hidden_pages`. `POST`/`PATCH` accept an optional `hidden_pages: string[]` — validated against known keys, 400 on an unrecognized one. Task 12 (admin UI) calls this route with exactly this field name.

- [ ] **Step 1: Write the failing tests**

Add to `app/api/admin/custom-domains/route.test.ts`, inside `describe("POST /api/admin/custom-domains", ...)`, after the `"returns 409 when the domain already exists"` test:

```ts
  it("rejects a non-array hidden_pages", async () => {
    const res = await POST(postRequest({ domain: "checkresults.com", services: ["results_checker"], site_name: "CheckResults", hidden_pages: "wallet" }))
    expect(res.status).toBe(400)
  })

  it("rejects an unknown hidden_pages key", async () => {
    const res = await POST(postRequest({ domain: "checkresults.com", services: ["results_checker"], site_name: "CheckResults", hidden_pages: ["not_a_real_key"] }))
    expect(res.status).toBe(400)
  })

  it("accepts a valid hidden_pages array and write-throughs it to the cache", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: { id: "1", domain: "checkresults.com", services: ["results_checker"], site_name: "CheckResults", logo_url: null, primary_color: null, is_active: true, hidden_pages: ["wallet"] },
      error: null,
    }))
    const res = await POST(postRequest({ domain: "checkresults.com", services: ["results_checker"], site_name: "CheckResults", hidden_pages: ["wallet"] }))
    expect(res.status).toBe(201)
    expect(setCacheMock).toHaveBeenCalledWith(expect.objectContaining({ hidden_pages: ["wallet"] }))
  })

  it("omits hidden_pages from the insert row when not provided, relying on the column default", async () => {
    const builder = makeBuilder({
      data: { id: "1", domain: "checkresults.com", services: ["results_checker"], site_name: "CheckResults", logo_url: null, primary_color: null, is_active: true, hidden_pages: ["afa_orders"] },
      error: null,
    })
    fromMock.mockReturnValue(builder)

    const res = await POST(postRequest({ domain: "checkresults.com", services: ["results_checker"], site_name: "CheckResults" }))
    expect(res.status).toBe(201)

    const insertedRow = builder.insert.mock.calls[0][0]
    expect(Object.keys(insertedRow)).not.toContain("hidden_pages")
    // The cache write uses the DB-returned value (the column's own default), not an empty array.
    expect(setCacheMock).toHaveBeenCalledWith(expect.objectContaining({ hidden_pages: ["afa_orders"] }))
  })
```

Add to the `describe("PATCH /api/admin/custom-domains", ...)` block:

```ts
  it("rejects an unknown hidden_pages key on update", async () => {
    const res = await PATCH(postRequest({ id: "1", hidden_pages: ["bogus"] }, "PATCH"))
    expect(res.status).toBe(400)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run app/api/admin/custom-domains/route.test.ts`
Expected: FAIL — the route doesn't read/validate `hidden_pages` yet, so it's silently dropped (the 400-expecting tests fail because nothing rejects it; the 201-expecting tests' cache assertions fail because `hidden_pages` is never passed to `setCustomDomainCache`).

- [ ] **Step 3: Implement the route changes**

Add the import and validator after the existing imports/`parseServices`:

```ts
import { isReservedDomainHost, type DomainService } from "@/lib/custom-domains"
import { TOGGLEABLE_PAGES } from "@/lib/custom-domain-pages"
```

(add the second import line)

```ts
const VALID_PAGE_KEYS = new Set(TOGGLEABLE_PAGES.map(p => p.key))

/** Validates a `hidden_pages` request field: must be an array of known
 * TOGGLEABLE_PAGES keys (empty array is valid — "nothing hidden"). Returns
 * the deduplicated array, or an error message. */
function parseHiddenPages(raw: unknown): { hiddenPages: string[] } | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: "'hidden_pages' must be an array of page keys" }
  }
  const invalid = raw.find(k => !VALID_PAGE_KEYS.has(k as string))
  if (invalid !== undefined) {
    return { error: `'hidden_pages' contains an unknown key: "${invalid}"` }
  }
  return { hiddenPages: Array.from(new Set(raw as string[])) }
}
```

(add this function after `parseServices`)

In `GET`, replace:

```ts
    .select("id, domain, services, site_name, logo_url, primary_color, is_active, created_at, updated_at")
```

with:

```ts
    .select("id, domain, services, site_name, logo_url, primary_color, is_active, hidden_pages, created_at, updated_at")
```

In `POST`, replace:

```ts
    if (!siteName) {
      return NextResponse.json({ error: "'site_name' is required" }, { status: 400 })
    }
    if (isReservedDomainHost(domain, ROOT_DOMAIN)) {
```

with:

```ts
    if (!siteName) {
      return NextResponse.json({ error: "'site_name' is required" }, { status: 400 })
    }
    let hiddenPages: string[] | undefined
    if (body.hidden_pages !== undefined) {
      const hiddenPagesResult = parseHiddenPages(body.hidden_pages)
      if ("error" in hiddenPagesResult) {
        return NextResponse.json({ error: hiddenPagesResult.error }, { status: 400 })
      }
      hiddenPages = hiddenPagesResult.hiddenPages
    }
    if (isReservedDomainHost(domain, ROOT_DOMAIN)) {
```

Replace:

```ts
    const row = { domain, services, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true }
    const { data, error } = await supabase.from("custom_domains").insert(row).select().single()

    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return NextResponse.json({ error: `"${domain}" is already configured` }, { status: 409 })
      }
      throw error
    }

    await setCustomDomainCache({
      domain, services, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true,
    })
```

with:

```ts
    const row = {
      domain, services, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true,
      ...(hiddenPages !== undefined ? { hidden_pages: hiddenPages } : {}),
    }
    const { data, error } = await supabase.from("custom_domains").insert(row).select().single()

    if (error) {
      if ((error as { code?: string }).code === "23505") {
        return NextResponse.json({ error: `"${domain}" is already configured` }, { status: 409 })
      }
      throw error
    }

    await setCustomDomainCache({
      domain, services, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true,
      hidden_pages: data.hidden_pages,
    })
```

In `PATCH`, replace:

```ts
    if (body.is_active !== undefined) {
      if (typeof body.is_active !== "boolean") return NextResponse.json({ error: "'is_active' must be a boolean" }, { status: 400 })
      updates.is_active = body.is_active
    }

    if (Object.keys(updates).length === 0) {
```

with:

```ts
    if (body.is_active !== undefined) {
      if (typeof body.is_active !== "boolean") return NextResponse.json({ error: "'is_active' must be a boolean" }, { status: 400 })
      updates.is_active = body.is_active
    }
    if (body.hidden_pages !== undefined) {
      const hiddenPagesResult = parseHiddenPages(body.hidden_pages)
      if ("error" in hiddenPagesResult) {
        return NextResponse.json({ error: hiddenPagesResult.error }, { status: 400 })
      }
      updates.hidden_pages = hiddenPagesResult.hiddenPages
    }

    if (Object.keys(updates).length === 0) {
```

Replace:

```ts
    if (data.is_active) {
      await setCustomDomainCache({
        domain: data.domain, services: data.services, site_name: data.site_name,
        logo_url: data.logo_url, primary_color: data.primary_color, is_active: data.is_active,
      })
    } else {
      await clearCustomDomainCache(data.domain)
    }
```

with:

```ts
    if (data.is_active) {
      await setCustomDomainCache({
        domain: data.domain, services: data.services, site_name: data.site_name,
        logo_url: data.logo_url, primary_color: data.primary_color, is_active: data.is_active,
        hidden_pages: data.hidden_pages,
      })
    } else {
      await clearCustomDomainCache(data.domain)
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/api/admin/custom-domains/route.test.ts`
Expected: PASS (every test in the file, including all pre-existing ones)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/api/admin/custom-domains/route.ts`.

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/custom-domains/route.ts app/api/admin/custom-domains/route.test.ts
git commit -m "feat(custom-domains): admin API validates and persists hidden_pages"
```

---

### Task 12: Admin UI — the toggle checklist

**Files:**
- Modify: `app/admin/custom-domains/page.tsx`

**Interfaces:**
- Consumes: `TOGGLEABLE_PAGES` (Task 1), `GET`/`POST`/`PATCH /api/admin/custom-domains` with `hidden_pages` (Task 11).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the import and extend the row/form types**

Add below the existing imports:

```ts
import { TOGGLEABLE_PAGES } from "@/lib/custom-domain-pages"
```

Replace `CustomDomainRow`:

```ts
interface CustomDomainRow {
  id: string
  domain: string
  services: DomainService[]
  site_name: string
  logo_url: string | null
  primary_color: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}
```

with:

```ts
interface CustomDomainRow {
  id: string
  domain: string
  services: DomainService[]
  site_name: string
  logo_url: string | null
  primary_color: string | null
  is_active: boolean
  hidden_pages: string[]
  created_at: string
  updated_at: string
}
```

Replace `EMPTY_FORM`:

```ts
const EMPTY_FORM = { domain: "", services: [] as DomainService[], site_name: "", logo_url: "", primary_color: "" }
```

with:

```ts
// Matches migrations/0100's own column default — a brand-new domain's
// checklist should visually start in the same state a freshly-inserted row
// actually has (dealer tools unchecked/hidden, everything else checked/shown).
const DEFAULT_HIDDEN_PAGES = [
  "afa_orders", "upgrade", "my_shop", "shop_dashboard", "sub_agents",
  "sub_agent_catalog", "ussd_shop", "payment_reverify", "buy_stock",
]

const EMPTY_FORM = {
  domain: "", services: [] as DomainService[], site_name: "", logo_url: "", primary_color: "",
  hidden_pages: DEFAULT_HIDDEN_PAGES as string[],
}
```

- [ ] **Step 2: Add the toggle handler, thread `hidden_pages` through `openEdit` and `handleSave`**

Add alongside the existing `toggleService` function:

```ts
  const toggleHiddenPage = (key: string) => {
    setForm(f => ({
      ...f,
      hidden_pages: f.hidden_pages.includes(key)
        ? f.hidden_pages.filter(k => k !== key)
        : [...f.hidden_pages, key],
    }))
  }
```

Replace `openEdit`:

```ts
  const openEdit = (row: CustomDomainRow) => {
    setEditing(row)
    setForm({
      domain: row.domain,
      services: row.services,
      site_name: row.site_name,
      logo_url: row.logo_url || "",
      primary_color: row.primary_color || "",
    })
    setDialogOpen(true)
  }
```

with:

```ts
  const openEdit = (row: CustomDomainRow) => {
    setEditing(row)
    setForm({
      domain: row.domain,
      services: row.services,
      site_name: row.site_name,
      logo_url: row.logo_url || "",
      primary_color: row.primary_color || "",
      hidden_pages: row.hidden_pages,
    })
    setDialogOpen(true)
  }
```

In `handleSave`, both request bodies need `hidden_pages: form.hidden_pages`. Replace:

```ts
      const res = editing
        ? await fetch("/api/admin/custom-domains", {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              id: editing.id,
              services: form.services,
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
              services: form.services,
              site_name: form.site_name,
              logo_url: form.logo_url || null,
              primary_color: form.primary_color || null,
            }),
          })
```

with:

```ts
      const res = editing
        ? await fetch("/api/admin/custom-domains", {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              id: editing.id,
              services: form.services,
              site_name: form.site_name,
              logo_url: form.logo_url || null,
              primary_color: form.primary_color || null,
              hidden_pages: form.hidden_pages,
            }),
          })
        : await fetch("/api/admin/custom-domains", {
            method: "POST",
            headers,
            body: JSON.stringify({
              domain: form.domain,
              services: form.services,
              site_name: form.site_name,
              logo_url: form.logo_url || null,
              primary_color: form.primary_color || null,
              hidden_pages: form.hidden_pages,
            }),
          })
```

- [ ] **Step 3: Add the two grouped checklists to the dialog form**

Insert right after the existing "Primary Color" `<div className="space-y-2">...</div>` block, before the closing `</div>` of the form's `space-y-4` container (i.e. immediately before `</div>\n              <DialogFooter>`):

```tsx
                <div className="space-y-2">
                  <Label>Visible Pages — Login / Signup / Homepage</Label>
                  <div className="space-y-2">
                    {TOGGLEABLE_PAGES.filter(p => p.group === "auth").map(p => (
                      <label key={p.key} className="flex items-center gap-2 text-sm cursor-pointer">
                        <Checkbox checked={!form.hidden_pages.includes(p.key)} onCheckedChange={() => toggleHiddenPage(p.key)} />
                        {p.label}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Visible Pages — Dashboard Tools</Label>
                  <div className="space-y-2">
                    {TOGGLEABLE_PAGES.filter(p => p.group === "dashboard").map(p => (
                      <label key={p.key} className="flex items-center gap-2 text-sm cursor-pointer">
                        <Checkbox checked={!form.hidden_pages.includes(p.key)} onCheckedChange={() => toggleHiddenPage(p.key)} />
                        {p.label}
                      </label>
                    ))}
                  </div>
                </div>
```

- [ ] **Step 4: Show a "Hidden" count badge in the table**

Replace the table header row:

```tsx
                    <TableHead>Domain</TableHead>
                    <TableHead>Services</TableHead>
                    <TableHead>Site Name</TableHead>
                    <TableHead>Active</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
```

with:

```tsx
                    <TableHead>Domain</TableHead>
                    <TableHead>Services</TableHead>
                    <TableHead>Site Name</TableHead>
                    <TableHead>Active</TableHead>
                    <TableHead>Hidden</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
```

Replace the "Active" `<TableCell>` and the row that follows it:

```tsx
                      <TableCell><Switch checked={row.is_active} onCheckedChange={() => handleToggleActive(row)} /></TableCell>
                      <TableCell className="text-right space-x-2">
```

with:

```tsx
                      <TableCell><Switch checked={row.is_active} onCheckedChange={() => handleToggleActive(row)} /></TableCell>
                      <TableCell>
                        {row.hidden_pages.length > 0 && <Badge variant="secondary">{row.hidden_pages.length} hidden</Badge>}
                      </TableCell>
                      <TableCell className="text-right space-x-2">
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/admin/custom-domains/page.tsx`.

- [ ] **Step 6: Manual verification**

No automated test exists for this page (matches convention). Start the dev server, log in as admin, navigate to `/admin/custom-domains`. Confirm: both checklists render with the correct default checked state for a new domain (dealer tools unchecked, the other 4 checked); un-checking "Landing Page" and saving round-trips correctly on re-opening the edit dialog; the table shows a "N hidden" badge only when `hidden_pages` is non-empty.

- [ ] **Step 7: Commit**

```bash
git add app/admin/custom-domains/page.tsx
git commit -m "feat(custom-domains): admin UI gets the page/feature visibility checklist"
```

---

### Task 13: End-to-end verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: the full feature (Tasks 1-12).
- Produces: nothing — final integration gate.

- [ ] **Step 1: Full suite + typecheck**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: every test passes (the pre-existing suite plus every new/modified test from Tasks 1, 2, 3, 11); typecheck clean project-wide.

- [ ] **Step 2: Live check — un-hide a dealer-tool page**

Using the live admin UI (`/admin/custom-domains` on the deployed app) and a domain already attached in Vercel with DNS pointed: edit it, check "Upgrade / Dealer Plans" (removing `upgrade` from `hidden_pages`), save. Then, logged in as a user on that domain, confirm `/dashboard/upgrade` is now reachable and appears in the sidebar nav, where it previously redirected away.

- [ ] **Step 3: Live check — hide the landing page**

On the same test domain, uncheck "Landing Page", save. Then:

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "https://<test-domain>/"
```

Expected: a redirect status with `Location` pointing at `/auth/login`.

- [ ] **Step 4: Live check — hide wallet, then un-hide it**

On the same test domain, uncheck "Wallet & Top-Up", save. Logged in as a user on that domain with a wallet balance under GHS 5, confirm: the dashboard home no longer shows the Wallet Balance hero card or either "Top Up" button, the low-balance modal doesn't appear on load, the sidebar/bottom-nav no longer show a Wallet entry, and navigating directly to `/dashboard/wallet` redirects away. Then re-check "Wallet & Top-Up" and save — reload the dashboard and confirm all of the above reverses: the hero card, both Top Up buttons, the low-balance modal, and the nav entry are all back, and `/dashboard/wallet` is reachable again. This confirms the suppression is live/stateless, not a one-way flag an admin can't undo.

- [ ] **Step 5: Restore the test domain to its known-good state**

Re-check every box on the test domain (empty `hidden_pages` array, or re-apply its original configuration) so it's left exactly as it was before this plan's verification steps.

- [ ] **Step 6: Confirm the main site is unaffected**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "https://www.datagod.store/"
```

Expected: `200`, ordinary main-site homepage — untouched by any of this plan's changes, consistent with the "no-op for current main-site traffic" invariant every task in this plan individually verified.
