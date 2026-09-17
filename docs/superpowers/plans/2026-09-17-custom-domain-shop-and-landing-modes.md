# Custom Domain Shop-Link + Landing-Page Toggles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a platform admin link a custom domain to an existing white-label shop (guest-checkout storefront replaces the dashboard entirely), or, for domains that stay in the existing dashboard mode, toggle whether the landing page renders at all and whether the guest-purchase button shows on it.

**Architecture:** `custom_domains` gains `linked_shop_id`, `show_guest_purchase`, `show_landing_page`. `middleware.ts` gets two new branches ahead of its existing service-redirect logic: a shop-mode rewrite (every path → `/shop/<linked shop's subdomain>/*`, mirroring the existing shop-subdomain rewrite) and a landing-page-hide redirect (`/` → `/auth/login`). The domain's existing `services` selection is reused, in shop mode, to gate the shop storefront's Buy Data/Airtime/Results Vouchers sub-tabs.

**Tech Stack:** Next.js 15 App Router (middleware + API routes), TypeScript, Supabase (service-role client via Management API for migration apply), Upstash Redis, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-17-custom-domain-shop-and-landing-modes-design.md` (builds on `docs/superpowers/specs/2026-09-11-custom-domain-service-routing-design.md`, live on `main`)

## Global Constraints

- Shop mode and the two account-mode toggles (`show_guest_purchase`, `show_landing_page`) are mutually exclusive by construction: when `linked_shop_id` is set, the shop-mode rewrite returns/short-circuits before either toggle is ever checked.
- `user_shops.subdomain` (not the legacy `shop_slug`) is the shop-mode rewrite target — it's `NOT NULL`, unique, and auto-assigned by a DB trigger, so it's always present, unlike `shop_slug`.
- The shop storefront's sub-tab switcher maps `data_bundles → "products"`, `airtime → "airtime"`, `results_checker → "vouchers"`. `bulk_sms` has no shop equivalent. If a shop-linked domain's `services` selection matches none of these three, fail open — show all three tabs, same as `services: null` — rather than render a button-less Products area.
- All three new columns default to values that make every currently-configured domain (including the live `clingshub.com` row) behave exactly as it does today: `linked_shop_id` null, `show_guest_purchase` false, `show_landing_page` true.
- Follow the existing codebase test convention: `lib/` modules and this feature's one admin API route get Vitest tests with mocked dependencies; `middleware.ts`, `app/layout.tsx`, `app/page.tsx`, `app/shop/[slug]/page.tsx`, and `app/admin/custom-domains/page.tsx` are not unit-tested (confirmed convention throughout this feature so far) — verify those via `npx tsc --noEmit` plus careful reading and, where practical, a live check against the deployed app.

---

### Task 1: Database migration

**Files:**
- Create: `migrations/0099_custom_domains_shop_and_landing.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `custom_domains` gains `linked_shop_id uuid references user_shops(id) on delete set null`, `show_guest_purchase boolean not null default false`, `show_landing_page boolean not null default true`, plus an index on `linked_shop_id`. Tasks 2 and 7 both depend on exactly these column names/types/defaults.

- [ ] **Step 1: Write the migration**

Create `migrations/0099_custom_domains_shop_and_landing.sql`:

```sql
-- Custom domains can now be linked to an existing white-label shop (guest
-- checkout is inherent to a shop, so it fully replaces the dashboard for that
-- domain), or, for domains that stay in dashboard/account mode, toggle
-- whether the landing page renders at all and whether the guest-purchase
-- button shows on it. See
-- docs/superpowers/specs/2026-09-17-custom-domain-shop-and-landing-modes-design.md.

alter table custom_domains
  add column if not exists linked_shop_id uuid references user_shops(id) on delete set null,
  add column if not exists show_guest_purchase boolean not null default false,
  add column if not exists show_landing_page boolean not null default true;

create index if not exists idx_custom_domains_linked_shop_id on custom_domains(linked_shop_id);
```

- [ ] **Step 2: Apply the migration to the live database**

This project applies migrations via the Supabase Management API (project ref `riijesduargxlzxuperj`), not a local runner. The access token lives in the project's gitignored `.mcp.json` (`SUPABASE_ACCESS_TOKEN`) — read it from there at runtime, never paste it into code or logs. From the project root:

```bash
node -e "
const fs = require('fs');
const sql = fs.readFileSync('migrations/0099_custom_domains_shop_and_landing.sql', 'utf8');
const token = fs.readFileSync('.mcp.json', 'utf8').match(/SUPABASE_ACCESS_TOKEN\":\s*\"([^\"]+)\"/)[1];
fetch('https://api.supabase.com/v1/projects/riijesduargxlzxuperj/database/query', {
  method: 'POST',
  headers: { Authorization: \`Bearer \${token}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
}).then(async r => { console.log('status:', r.status); console.log(await r.text()); });
"
```

Expected: `status: 201`, empty body (normal for DDL with no `RETURNING`).

- [ ] **Step 3: Verify against the live schema**

```bash
node -e "
const fs = require('fs');
const token = fs.readFileSync('.mcp.json', 'utf8').match(/SUPABASE_ACCESS_TOKEN\":\s*\"([^\"]+)\"/)[1];
const query = \"select column_name, data_type, column_default from information_schema.columns where table_name = 'custom_domains' and column_name in ('linked_shop_id','show_guest_purchase','show_landing_page') order by column_name\";
fetch('https://api.supabase.com/v1/projects/riijesduargxlzxuperj/database/query', {
  method: 'POST',
  headers: { Authorization: \`Bearer \${token}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
}).then(async r => console.log(await r.text()));
"
```

Expected: 3 rows — `linked_shop_id` (`uuid`, no default), `show_guest_purchase` (`boolean`, default `false`), `show_landing_page` (`boolean`, default `true`).

- [ ] **Step 4: Commit**

```bash
git add migrations/0099_custom_domains_shop_and_landing.sql
git commit -m "feat(db): add shop-link and landing-page toggle columns to custom_domains"
```

---

### Task 2: Type extension + lookup join

**Files:**
- Modify: `lib/custom-domains.ts:3-10` (`CustomDomainConfig`)
- Modify: `lib/custom-domain-lookup.ts:73-93` (`lookupExact`'s Supabase branch)
- Test: `lib/custom-domain-lookup.test.ts` (update fixtures, add join-mapping tests)

**Interfaces:**
- Consumes: `migrations/0099...` column names (Task 1).
- Produces: `CustomDomainConfig` now includes `linked_shop_subdomain: string | null`, `show_guest_purchase: boolean`, `show_landing_page: boolean`. Tasks 3 (middleware), 4 (layout/context), 6 (shop page), and 7 (admin route) all read these exact field names.

- [ ] **Step 1: Extend `CustomDomainConfig`**

In `lib/custom-domains.ts`, replace lines 3-10:

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
  // Non-null when this domain is linked to an existing shop — the shop's own
  // `subdomain` (not `shop_slug`), used directly as the middleware rewrite
  // target. Null means this domain stays in dashboard/account mode.
  linked_shop_subdomain: string | null
  show_guest_purchase: boolean
  show_landing_page: boolean
}
```

- [ ] **Step 2: Write the failing test — update fixtures and add a join-mapping case**

In `lib/custom-domain-lookup.test.ts`, replace the `sampleConfig` declaration (lines 54-61) with two fixtures — `sampleConfig` (the mapped shape Redis caches and callers receive) and `sampleRawRow` (the raw shape a fresh Supabase read returns, with the joined `linked_shop` object instead of a flat field):

```ts
const sampleConfig: CustomDomainConfig = {
  domain: "checkresults.com",
  services: ["results_checker"],
  site_name: "CheckResults",
  logo_url: null,
  primary_color: "#059669",
  is_active: true,
  linked_shop_subdomain: null,
  show_guest_purchase: false,
  show_landing_page: true,
}

const sampleRawRow = {
  domain: sampleConfig.domain,
  services: sampleConfig.services,
  site_name: sampleConfig.site_name,
  logo_url: sampleConfig.logo_url,
  primary_color: sampleConfig.primary_color,
  is_active: sampleConfig.is_active,
  show_guest_purchase: sampleConfig.show_guest_purchase,
  show_landing_page: sampleConfig.show_landing_page,
  linked_shop: null as { subdomain: string } | null,
}
```

Then update every existing `maybeSingleMock.mockResolvedValueOnce({ data: sampleConfig, error: null })` / `maybeSingleMock.mockResolvedValue({ data: sampleConfig, error: null })` call (these represent a *fresh Supabase read*, which now returns the raw joined shape, not the mapped one) to use `sampleRawRow` instead of `sampleConfig`. There are three such call sites in the file:
- Line 76: `maybeSingleMock.mockResolvedValueOnce({ data: sampleConfig, error: null })` → `{ data: sampleRawRow, error: null }`
- Line 124: `.mockResolvedValueOnce({ data: sampleConfig, error: null })` (the www-fallback hit) → `{ data: sampleRawRow, error: null }`
- Line 135: `maybeSingleMock.mockResolvedValueOnce({ data: sampleConfig, error: null })` → `{ data: sampleRawRow, error: null }`

Calls that represent a **Redis cache hit** (`redisGetMock.mockResolvedValueOnce(sampleConfig)`, lines 65 and 180) stay unchanged — Redis caches the already-mapped config, never the raw row.

Add one new test at the end of the `resolveCustomDomain` describe block (after the "fails open to null when Supabase throws" test, before its closing `})`):

```ts
  it("maps a joined linked_shop row to linked_shop_subdomain", async () => {
    redisGetMock.mockResolvedValueOnce(null)
    maybeSingleMock.mockResolvedValueOnce({
      data: { ...sampleRawRow, linked_shop: { subdomain: "clings" } },
      error: null,
    })
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("checkresults.com")

    expect(result?.linked_shop_subdomain).toBe("clings")
  })

  it("maps a null linked_shop join to a null linked_shop_subdomain", async () => {
    redisGetMock.mockResolvedValueOnce(null)
    maybeSingleMock.mockResolvedValueOnce({ data: sampleRawRow, error: null })
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("checkresults.com")

    expect(result?.linked_shop_subdomain).toBeNull()
  })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run lib/custom-domain-lookup.test.ts`
Expected: FAIL — `sampleRawRow`'s `linked_shop`/`show_guest_purchase`/`show_landing_page` fields aren't read/mapped by the implementation yet, so `result?.linked_shop_subdomain` is `undefined`, not `"clings"`/`null`; and the pre-existing tests fail their `toEqual(sampleConfig)` assertions because the implementation still returns `sampleRawRow`'s shape verbatim (with a `linked_shop` key, not `linked_shop_subdomain`, and missing the two booleans' correct pass-through since the select column list doesn't request them yet).

- [ ] **Step 4: Update the Supabase select + add the mapping**

In `lib/custom-domain-lookup.ts`, replace lines 73-93:

```ts
  try {
    const { data, error } = await supabaseAdmin
      .from("custom_domains")
      .select("domain, services, site_name, logo_url, primary_color, is_active")
      .eq("domain", host)
      .eq("is_active", true)
      .maybeSingle()

    if (error) {
      console.error("[CUSTOM-DOMAIN-LOOKUP] Supabase lookup failed:", error)
      return { kind: "error" }
    }
    if (!data) return { kind: "not_found", fromNegativeCache: false }

    const config = data as CustomDomainConfig
    cacheSetPositive(host, config)
    return { kind: "found", config }
  } catch (e) {
    console.error("[CUSTOM-DOMAIN-LOOKUP] Supabase lookup failed:", e instanceof Error ? e.message : e)
    return { kind: "error" }
  }
```

with:

```ts
  try {
    const { data, error } = await supabaseAdmin
      .from("custom_domains")
      .select("domain, services, site_name, logo_url, primary_color, is_active, show_guest_purchase, show_landing_page, linked_shop:user_shops!linked_shop_id(subdomain)")
      .eq("domain", host)
      .eq("is_active", true)
      .maybeSingle()

    if (error) {
      console.error("[CUSTOM-DOMAIN-LOOKUP] Supabase lookup failed:", error)
      return { kind: "error" }
    }
    if (!data) return { kind: "not_found", fromNegativeCache: false }

    const row = data as typeof data & { linked_shop: { subdomain: string } | null }
    const config: CustomDomainConfig = {
      domain: row.domain,
      services: row.services,
      site_name: row.site_name,
      logo_url: row.logo_url,
      primary_color: row.primary_color,
      is_active: row.is_active,
      show_guest_purchase: row.show_guest_purchase,
      show_landing_page: row.show_landing_page,
      linked_shop_subdomain: row.linked_shop?.subdomain ?? null,
    }
    cacheSetPositive(host, config)
    return { kind: "found", config }
  } catch (e) {
    console.error("[CUSTOM-DOMAIN-LOOKUP] Supabase lookup failed:", e instanceof Error ? e.message : e)
    return { kind: "error" }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/custom-domain-lookup.test.ts`
Expected: PASS — every test in the file green, including the two new ones from Step 2 and every pre-existing test from earlier tasks in this feature.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `lib/custom-domains.ts` or `lib/custom-domain-lookup.ts`.

- [ ] **Step 7: Commit**

```bash
git add lib/custom-domains.ts lib/custom-domain-lookup.ts lib/custom-domain-lookup.test.ts
git commit -m "feat(custom-domains): extend CustomDomainConfig with shop-link and landing-page fields, join the linked shop's subdomain"
```

---

### Task 3: Middleware — shop-mode rewrite + landing-page-hide redirect

**Files:**
- Modify: `middleware.ts:122-129`

**Interfaces:**
- Consumes: `CustomDomainConfig.linked_shop_subdomain`, `.show_landing_page`, `.services` (Task 2).
- Produces: nothing consumed by later tasks — this is the routing enforcement point, terminal for this feature's request flow.

- [ ] **Step 1: Add the two new branches ahead of the existing service-redirect**

Re-read the current `middleware.ts` first to confirm lines 122-129 still match (this file is actively touched by other concurrent work on this repo — confirm before editing, don't assume). Replace:

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
    // Shop mode: every path, including "/", rewrites into the linked shop's
    // storefront — mirroring the exact rewrite getShopSubdomain's caller uses
    // above, just triggered by a custom-domain lookup instead of subdomain
    // parsing. A rewrite (not a redirect) keeps the browser's URL bar on the
    // custom domain. This is mutually exclusive with everything below it —
    // shop mode never falls through to the landing-page or service checks.
    if (customDomainConfig.linked_shop_subdomain) {
      const url = request.nextUrl.clone()
      url.pathname = `/shop/${customDomainConfig.linked_shop_subdomain}${path === "/" ? "" : path}`
      return NextResponse.rewrite(url)
    }

    // Account mode with the landing page hidden: "/" skips the marketing
    // homepage entirely and goes straight to login.
    if (!customDomainConfig.show_landing_page && path === "/") {
      const url = request.nextUrl.clone()
      url.pathname = "/auth/login"
      return NextResponse.redirect(url)
    }

    const serviceRedirectPath = getServiceRedirect(path, customDomainConfig.services)
    if (serviceRedirectPath) {
      const url = request.nextUrl.clone()
      url.pathname = serviceRedirectPath
      return NextResponse.redirect(url)
    }
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `middleware.ts`.

- [ ] **Step 3: Manual verification**

No automated test exists for this file (matches convention). Re-read the modified function once, top to bottom, and confirm: for `customDomainConfig === null` (every request today — no domain has `linked_shop_id` or `show_landing_page: false` set yet), both new branches are unreachable, so this change is a no-op for all current traffic. Confirm the shop-mode branch runs strictly before the landing-page-hide branch, which runs strictly before the existing service-redirect — the three are checked in that fixed order, and the first one that fires returns immediately.

- [ ] **Step 4: Commit**

```bash
git add middleware.ts
git commit -m "feat(custom-domains): add shop-mode rewrite and landing-page-hide redirect to middleware"
```

---

### Task 4: Branding context — thread the two new booleans

**Files:**
- Modify: `components/providers/domain-branding-provider.tsx:6-18`
- Modify: `app/layout.tsx:128-138`
- Modify: `middleware.ts` header-building block (`buildRequestHeaders`)

**Interfaces:**
- Consumes: `CustomDomainConfig.show_guest_purchase`, `.show_landing_page` (Task 2).
- Produces: `DomainBranding` gains `showGuestPurchase: boolean`, `showLandingPage: boolean`. Tasks 5 (`app/page.tsx`) and 6 (`app/shop/[slug]/page.tsx`, only reads `.services`, already available) consume `showGuestPurchase` from `useDomainBranding()`.

- [ ] **Step 1: Set two new request headers in `middleware.ts`**

Re-read the current `buildRequestHeaders` function first to confirm exact line numbers (it's in the same file Task 3 just modified, in this same task sequence, so line numbers have shifted from Task 3's edit — locate it by searching for `h.delete("x-domain-services")`). Add two more header clears and two more conditional sets, alongside the existing four:

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
    h.delete("x-domain-guest-purchase")
    h.delete("x-domain-landing-page")
    if (customDomainConfig) {
      try {
        h.set("x-domain-services", customDomainConfig.services.join(","))
        h.set("x-domain-site-name", customDomainConfig.site_name)
        if (customDomainConfig.logo_url) h.set("x-domain-logo", customDomainConfig.logo_url)
        if (customDomainConfig.primary_color) h.set("x-domain-color", customDomainConfig.primary_color)
        h.set("x-domain-guest-purchase", customDomainConfig.show_guest_purchase ? "1" : "0")
        h.set("x-domain-landing-page", customDomainConfig.show_landing_page ? "1" : "0")
      } catch (e) {
```

(The `try`/`catch` and everything after it inside the `if (customDomainConfig)` block is unchanged — only these two new lines are inserted before the closing of the `try`.)

- [ ] **Step 2: Extend `DomainBranding`**

In `components/providers/domain-branding-provider.tsx`, replace lines 6-18:

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
  showGuestPurchase: boolean
  showLandingPage: boolean
}

const DEFAULT_BRANDING: DomainBranding = {
  services: null,
  siteName: null,
  logoUrl: null,
  primaryColor: null,
  showGuestPurchase: false,
  showLandingPage: true,
}
```

(These two defaults are irrelevant on the main site — every consumer of `showGuestPurchase`/`showLandingPage` only checks them when `services` is non-null, i.e. actually on a branded domain, exactly like every other field in this context.)

- [ ] **Step 3: Parse the two new headers in `app/layout.tsx`**

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
  const domainBranding: DomainBranding = {
    services: parsedServices.length > 0 ? parsedServices : null,
    siteName: headersList.get("x-domain-site-name"),
    logoUrl: headersList.get("x-domain-logo"),
    primaryColor: headersList.get("x-domain-color"),
    showGuestPurchase: headersList.get("x-domain-guest-purchase") === "1",
    showLandingPage: headersList.get("x-domain-landing-page") !== "0",
  };
```

(`showLandingPage` defaults to `true` on a missing/absent header — `!== "0"` rather than `=== "1"` — matching `show_landing_page`'s own DB default of `true` and keeping this a no-op for the main site, where the header is never set at all.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `middleware.ts`, `components/providers/domain-branding-provider.tsx`, or `app/layout.tsx`.

- [ ] **Step 5: Manual verification**

No automated tests exist for these three files (matches convention). Confirm by reading: on the main site (no `customDomainConfig`), `buildRequestHeaders` never sets either new header, so `app/layout.tsx` reads `null` for both `headersList.get(...)` calls, producing `showGuestPurchase: false` and `showLandingPage: true` — the same values `DEFAULT_BRANDING` already has, so this is a no-op end to end for all current traffic.

- [ ] **Step 6: Commit**

```bash
git add middleware.ts components/providers/domain-branding-provider.tsx app/layout.tsx
git commit -m "feat(custom-domains): thread show_guest_purchase/show_landing_page through headers and branding context"
```

---

### Task 5: Homepage — gate the guest-purchase button

**Files:**
- Modify: `app/page.tsx:394`, `:700`

**Interfaces:**
- Consumes: `useDomainBranding().showGuestPurchase: boolean` (Task 4). `domainBranding` is already destructured in this component (`app/page.tsx:311`, from the earlier homepage-branding task) — no new import or hook call needed.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Gate both `GuestPurchaseButton` occurrences**

Re-read the current file first to confirm lines 394 and 700 still match exactly (this file has multiple unrelated sections between the two occurrences). Replace each occurrence of:

```tsx
              <GuestPurchaseButton variant="outline" className="w-full sm:w-auto" />
```

with:

```tsx
              {(!domainBranding.services || domainBranding.showGuestPurchase) && (
                <GuestPurchaseButton variant="outline" className="w-full sm:w-auto" />
              )}
```

Do this at both locations (line 394 and line 700) — they're identical lines in two different sections of the page, so apply the same replacement to each independently.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/page.tsx`.

- [ ] **Step 3: Manual verification**

No automated test exists for this file (matches convention). Confirm: on the main site, `domainBranding.services` is `null`, so `!domainBranding.services` is `true` and both buttons render exactly as before — a no-op. On any existing branded domain (e.g. `clingshub.com`, which has `show_guest_purchase: false` from Task 1's migration default), `domainBranding.services` is non-null and `domainBranding.showGuestPurchase` is `false`, so both buttons are hidden — this is a real, intended behavior change for that domain (previously they weren't gated at all and always showed), consistent with "off by default" from the spec.

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat(custom-domains): gate the homepage guest-purchase button by show_guest_purchase"
```

---

### Task 6: Shop storefront — gate the service sub-tab switcher

**Files:**
- Modify: `app/shop/[slug]/page.tsx:3-40` (imports), `:62` (`activeTab` initial state), `:894-929` (sub-tab switcher)

**Interfaces:**
- Consumes: `useDomainBranding().services: DomainService[] | null` (already exists from the original custom-domains feature; `showGuestPurchase`/`showLandingPage` are not needed by this file). `getServicePrimaryPath` is not needed here either — this task only filters which buttons render and picks a default tab, it doesn't redirect.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Import `useDomainBranding` and a service→tab map**

Re-read the current file's import block first (lines 1-40) to confirm nothing has shifted. Add after the existing import at line 20 (`import { useResendCooldown } from "@/lib/use-resend-cooldown"`):

```ts
import { useDomainBranding } from "@/components/providers/domain-branding-provider"
import type { DomainService } from "@/lib/custom-domains"
```

- [ ] **Step 2: Compute the allowed tab set and a sensible default `activeTab`**

Re-read lines 50-65 first to confirm the component's opening and the `activeTab` state declaration still match. Immediately after the line `export default function ShopStorefront() {` (currently line 50) and before the existing `const [activeTab, setActiveTab] = useState<...>("products")` (currently line 62 — there will be other state/hooks between these two lines; insert this new logic directly above the `activeTab` line specifically, not at the very top of the function body), add:

```ts
  const domainBranding = useDomainBranding()
  // Maps each service to its shop sub-tab. Fail open (all three) when a
  // shop-linked domain's services selection matches none of them — e.g. a
  // domain scoped only to "bulk_sms", which has no shop equivalent — rather
  // than render a button-less Products area with no valid default tab.
  const SERVICE_TAB_MAP: Partial<Record<DomainService, "products" | "airtime" | "vouchers">> = {
    data_bundles: "products",
    airtime: "airtime",
    results_checker: "vouchers",
  }
  const allowedTabs: Array<"products" | "airtime" | "vouchers"> = domainBranding.services
    ? (() => {
        const mapped = domainBranding.services
          .map(s => SERVICE_TAB_MAP[s])
          .filter((t): t is "products" | "airtime" | "vouchers" => Boolean(t))
        return mapped.length > 0 ? mapped : ["products", "airtime", "vouchers"]
      })()
    : ["products", "airtime", "vouchers"]
```

Then change the `activeTab` initial value from the hardcoded `"products"` to the first allowed tab:

Replace:
```ts
  const [activeTab, setActiveTab] = useState<"products" | "airtime" | "vouchers" | "about" | "track-order">("products")
```

with:
```ts
  const [activeTab, setActiveTab] = useState<"products" | "airtime" | "vouchers" | "about" | "track-order">(allowedTabs[0])
```

- [ ] **Step 3: Filter the sub-tab switcher's three buttons**

Re-read lines 890-930 first to confirm the sub-tab switcher block still matches exactly (find it by searching for `{/* Sub-tab Switcher */}`). Wrap each of the three `<button>` elements in a conditional on `allowedTabs.includes(...)`. Replace:

```tsx
                {/* Sub-tab Switcher */}
                <div className="flex p-1.5 bg-muted rounded-2xl w-full sm:w-fit mx-auto sm:mx-0 shadow-inner">
                  <button
                    onClick={() => setActiveTab("products")}
                    className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold transition-all duration-300 ${activeTab === "products"
                        ? "bg-card text-primary shadow-md scale-[1.02]"
                        : "text-muted-foreground hover:text-foreground hover:bg-card/50"
                      }`}
                  >
                    <ShoppingCart className="w-5 h-5" />
                    Buy Data
                  </button>
                  <button
                    onClick={() => setActiveTab("airtime")}
                    className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold transition-all duration-300 ${activeTab === "airtime"
                        ? "bg-card text-primary shadow-md scale-[1.02]"
                        : "text-muted-foreground hover:text-foreground hover:bg-card/50"
                      }`}
                  >
                    <Zap className="w-5 h-5" />
                    Buy Airtime
                  </button>
                  <button
                    onClick={() => setActiveTab("vouchers")}
                    className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold transition-all duration-300 ${activeTab === "vouchers"
                        ? "bg-card text-primary shadow-md scale-[1.02]"
                        : "text-muted-foreground hover:text-foreground hover:bg-card/50"
                      }`}
                  >
                    <GraduationCap className="w-5 h-5" />
                    Results Vouchers
                  </button>
                </div>
```

with:

```tsx
                {/* Sub-tab Switcher */}
                <div className="flex p-1.5 bg-muted rounded-2xl w-full sm:w-fit mx-auto sm:mx-0 shadow-inner">
                  {allowedTabs.includes("products") && (
                    <button
                      onClick={() => setActiveTab("products")}
                      className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold transition-all duration-300 ${activeTab === "products"
                          ? "bg-card text-primary shadow-md scale-[1.02]"
                          : "text-muted-foreground hover:text-foreground hover:bg-card/50"
                        }`}
                    >
                      <ShoppingCart className="w-5 h-5" />
                      Buy Data
                    </button>
                  )}
                  {allowedTabs.includes("airtime") && (
                    <button
                      onClick={() => setActiveTab("airtime")}
                      className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold transition-all duration-300 ${activeTab === "airtime"
                          ? "bg-card text-primary shadow-md scale-[1.02]"
                          : "text-muted-foreground hover:text-foreground hover:bg-card/50"
                        }`}
                    >
                      <Zap className="w-5 h-5" />
                      Buy Airtime
                    </button>
                  )}
                  {allowedTabs.includes("vouchers") && (
                    <button
                      onClick={() => setActiveTab("vouchers")}
                      className={`flex-1 sm:flex-none flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-bold transition-all duration-300 ${activeTab === "vouchers"
                          ? "bg-card text-primary shadow-md scale-[1.02]"
                          : "text-muted-foreground hover:text-foreground hover:bg-card/50"
                        }`}
                    >
                      <GraduationCap className="w-5 h-5" />
                      Results Vouchers
                    </button>
                  )}
                </div>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/shop/[slug]/page.tsx`.

- [ ] **Step 5: Manual verification**

No automated test exists for this file (matches convention; it's a large, already-untested page). Confirm by reading: when accessed via a shop subdomain or path (`domainBranding.services` is `null` there — this page is not exclusively reached through a shop-linked custom domain), `allowedTabs` is unconditionally `["products", "airtime", "vouchers"]` and `activeTab`'s initial value is `allowedTabs[0]` = `"products"` — identical to today's hardcoded default. This is a no-op for every existing shop subdomain/path visit.

- [ ] **Step 6: Commit**

```bash
git add "app/shop/[slug]/page.tsx"
git commit -m "feat(custom-domains): gate the shop storefront's service sub-tabs by the linked domain's selected services"
```

---

### Task 7: Admin API route — shop-link validation + new toggle fields

**Files:**
- Modify: `app/api/admin/custom-domains/route.ts`
- Test: `app/api/admin/custom-domains/route.test.ts`

**Interfaces:**
- Consumes: `user_shops` table (existing, via `supabase.from("user_shops")`).
- Produces: `POST`/`PATCH` accept `linked_shop_id` (string UUID or `null`, optional), `show_guest_purchase` (boolean, optional, defaults `false` on create), `show_landing_page` (boolean, optional, defaults `true` on create). `GET` includes all three in its `select()`. Task 8 (admin UI) calls this route with exactly these field names.

- [ ] **Step 1: Write the failing tests**

Re-read the current `app/api/admin/custom-domains/route.test.ts` first (it already has ~16 tests from earlier tasks in this feature) to confirm its exact current structure before adding to it — in particular confirm the `makeBuilder`/`fromMock` mocking pattern and the `postRequest` helper are still shaped as before. Add these new test cases inside the existing `describe("POST /api/admin/custom-domains", ...)` block (after its last existing `it(...)`, before the block's closing `})`):

```ts
  it("rejects a linked_shop_id that doesn't exist in user_shops", async () => {
    // Every fromMock() call in this test resolves the same way — the
    // validation lookup finds nothing, and the route must return 400 before
    // ever reaching a second, differently-shaped call (the custom_domains
    // insert), so a single uniform mock is sufficient here.
    fromMock.mockReturnValue(makeBuilder({ data: null, error: null }))
    const res = await POST(postRequest({ domain: "checkresults.com", services: ["data_bundles"], site_name: "X", linked_shop_id: "11111111-1111-1111-1111-111111111111" }))
    expect(res.status).toBe(400)
  })

  it("accepts a valid linked_shop_id and defaults show_guest_purchase/show_landing_page", async () => {
    fromMock.mockImplementation((table: string) =>
      table === "user_shops"
        ? makeBuilder({ data: { id: "11111111-1111-1111-1111-111111111111" }, error: null })
        : makeBuilder({
            data: { id: "1", domain: "checkresults.com", services: ["data_bundles"], site_name: "X", logo_url: null, primary_color: null, is_active: true, linked_shop_id: "11111111-1111-1111-1111-111111111111", show_guest_purchase: false, show_landing_page: true },
            error: null,
          })
    )
    const res = await POST(postRequest({ domain: "checkresults.com", services: ["data_bundles"], site_name: "X", linked_shop_id: "11111111-1111-1111-1111-111111111111" }))
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(setCacheMock).toHaveBeenCalledWith(expect.objectContaining({ show_guest_purchase: false, show_landing_page: true }))
  })
```

Add this new test inside the existing `describe("PATCH /api/admin/custom-domains", ...)` block:

```ts
  it("rejects a non-boolean show_landing_page on update", async () => {
    const res = await PATCH(postRequest({ id: "1", show_landing_page: "yes" }, "PATCH"))
    expect(res.status).toBe(400)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run app/api/admin/custom-domains/route.test.ts`
Expected: FAIL — the route doesn't read `linked_shop_id`/`show_guest_purchase`/`show_landing_page` from the request body yet, and `fromMock` isn't yet called with a `"user_shops"` table argument anywhere in the implementation, so the new tests' mock setups go unused and the assertions on status/cache calls fail.

- [ ] **Step 3: Implement the route changes**

In `app/api/admin/custom-domains/route.ts`, add a shop-existence check helper after `parseServices` (after line 25):

```ts
/** Validates an optional linked_shop_id: undefined/null is fine (no shop
 * linked); a non-null value must reference an existing row in user_shops. */
async function validateLinkedShopId(raw: unknown): Promise<{ linkedShopId: string | null } | { error: string }> {
  if (raw === undefined || raw === null || raw === "") return { linkedShopId: null }
  if (typeof raw !== "string") return { error: "'linked_shop_id' must be a string or null" }
  const { data, error } = await supabase.from("user_shops").select("id").eq("id", raw).maybeSingle()
  if (error) return { error: "Failed to validate linked_shop_id" }
  if (!data) return { error: `No shop found with id "${raw}"` }
  return { linkedShopId: raw }
}
```

In `POST`, after the existing `siteName`/`servicesResult` validation block and before the `isReservedDomainHost` check, add:

```ts
    const linkedShopResult = await validateLinkedShopId(body.linked_shop_id)
    if ("error" in linkedShopResult) {
      return NextResponse.json({ error: linkedShopResult.error }, { status: 400 })
    }
    const { linkedShopId } = linkedShopResult
    const showGuestPurchase = typeof body.show_guest_purchase === "boolean" ? body.show_guest_purchase : false
    const showLandingPage = typeof body.show_landing_page === "boolean" ? body.show_landing_page : true
```

Replace the existing `row` construction:

```ts
    const row = { domain, services, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true }
```

with:

```ts
    const row = {
      domain, services, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true,
      linked_shop_id: linkedShopId, show_guest_purchase: showGuestPurchase, show_landing_page: showLandingPage,
    }
```

And the `setCustomDomainCache` call right after the insert:

```ts
    await setCustomDomainCache({
      domain, services, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true,
    })
```

with:

```ts
    await setCustomDomainCache({
      domain, services, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true,
      linked_shop_subdomain: null, // freshly created row has no shop join result cached yet; the next read re-resolves it correctly
      show_guest_purchase: showGuestPurchase, show_landing_page: showLandingPage,
    })
```

In `PATCH`, inside the `updates` object-building block, after the existing `if (body.is_active !== undefined) {...}` block, add:

```ts
    if (body.linked_shop_id !== undefined) {
      const linkedShopResult = await validateLinkedShopId(body.linked_shop_id)
      if ("error" in linkedShopResult) {
        return NextResponse.json({ error: linkedShopResult.error }, { status: 400 })
      }
      updates.linked_shop_id = linkedShopResult.linkedShopId
    }
    if (body.show_guest_purchase !== undefined) {
      if (typeof body.show_guest_purchase !== "boolean") return NextResponse.json({ error: "'show_guest_purchase' must be a boolean" }, { status: 400 })
      updates.show_guest_purchase = body.show_guest_purchase
    }
    if (body.show_landing_page !== undefined) {
      if (typeof body.show_landing_page !== "boolean") return NextResponse.json({ error: "'show_landing_page' must be a boolean" }, { status: 400 })
      updates.show_landing_page = body.show_landing_page
    }
```

Update the two `setCustomDomainCache`/select-column-list spots that read `data.*` after the PATCH's update — replace:

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
        linked_shop_subdomain: null, // see the POST handler's identical comment — re-resolved fresh on next read
        show_guest_purchase: data.show_guest_purchase, show_landing_page: data.show_landing_page,
      })
    } else {
      await clearCustomDomainCache(data.domain)
    }
```

Finally, update `GET`'s `select()` column list — replace:

```ts
    .select("id, domain, services, site_name, logo_url, primary_color, is_active, created_at, updated_at")
```

with:

```ts
    .select("id, domain, services, site_name, logo_url, primary_color, is_active, linked_shop_id, show_guest_purchase, show_landing_page, created_at, updated_at")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/api/admin/custom-domains/route.test.ts`
Expected: PASS — all tests green (the pre-existing ones plus the new ones from Step 1).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/api/admin/custom-domains/route.ts`.

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/custom-domains/route.ts app/api/admin/custom-domains/route.test.ts
git commit -m "feat(custom-domains): admin API validates linked_shop_id and accepts the two landing-page toggle fields"
```

---

### Task 8: Admin UI — shop picker + two toggles

**Files:**
- Modify: `app/admin/custom-domains/page.tsx`

**Interfaces:**
- Consumes: `GET/POST/PATCH /api/admin/custom-domains` with `linked_shop_id`, `show_guest_purchase`, `show_landing_page` (Task 7). A new `GET /api/admin/shops-list`-style lookup is NOT introduced — this task queries `user_shops` directly from the client via the existing `supabase` browser client already imported in this file (same pattern the page already uses for Supabase Storage uploads), scoped to a simple `id, shop_name, subdomain` select for the picker.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Extend the row/form types and add shop-list state**

Re-read the current file first (it may have shifted slightly from concurrent edits elsewhere in the repo, though this specific admin page is unlikely to have been touched by anything outside this feature). Replace the `CustomDomainRow` interface and `EMPTY_FORM`:

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
  linked_shop_id: string | null
  show_guest_purchase: boolean
  show_landing_page: boolean
  created_at: string
  updated_at: string
}

interface ShopOption {
  id: string
  shop_name: string
  subdomain: string
}
```

Replace:

```ts
const EMPTY_FORM = { domain: "", services: [] as DomainService[], site_name: "", logo_url: "", primary_color: "" }
```

with:

```ts
const EMPTY_FORM = {
  domain: "", services: [] as DomainService[], site_name: "", logo_url: "", primary_color: "",
  linked_shop_id: null as string | null, show_guest_purchase: false, show_landing_page: true,
}
```

Add shop-list state and a loader, right after the existing `const [uploadingLogo, setUploadingLogo] = useState(false)` line:

```ts
  const [shops, setShops] = useState<ShopOption[]>([])

  const loadShops = async () => {
    const { data } = await supabase.from("user_shops").select("id, shop_name, subdomain").order("shop_name")
    setShops(data || [])
  }
```

Add a call to `loadShops()` inside the existing `useEffect(() => { loadDomains() }, [])` — replace:

```ts
  useEffect(() => {
    loadDomains()
  }, [])
```

with:

```ts
  useEffect(() => {
    loadDomains()
    loadShops()
  }, [])
```

- [ ] **Step 2: Thread the three new fields through `openEdit`, `handleSave`, and `handleToggleActive`'s sibling logic**

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
      linked_shop_id: row.linked_shop_id,
      show_guest_purchase: row.show_guest_purchase,
      show_landing_page: row.show_landing_page,
    })
    setDialogOpen(true)
  }
```

In `handleSave`, both the PATCH and POST request bodies need the three new fields. Replace:

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
              linked_shop_id: form.linked_shop_id,
              show_guest_purchase: form.show_guest_purchase,
              show_landing_page: form.show_landing_page,
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
              linked_shop_id: form.linked_shop_id,
              show_guest_purchase: form.show_guest_purchase,
              show_landing_page: form.show_landing_page,
            }),
          })
```

- [ ] **Step 3: Add the shop picker and two toggles to the dialog form**

Insert a shop picker right after the existing "Services" `<div className="space-y-2">...</div>` block and before the "Site Name" block. Use a plain `<select>` (this page doesn't otherwise use the shadcn `Select` component — it was replaced by checkboxes for `services` earlier in this feature — so a native select keeps this addition self-contained without pulling that component back in):

```tsx
                <div className="space-y-2">
                  <Label>Link to Shop (optional)</Label>
                  <select
                    value={form.linked_shop_id ?? ""}
                    onChange={e => setForm(f => ({ ...f, linked_shop_id: e.target.value || null }))}
                    className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">— None (dashboard mode) —</option>
                    {shops.map(s => (
                      <option key={s.id} value={s.id}>{s.shop_name} ({s.subdomain})</option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Linking a shop makes this domain show that shop&apos;s storefront (guest checkout) instead of the dashboard. Services above then filter which of the shop&apos;s Buy Data/Airtime/Results Vouchers tabs show.
                  </p>
                </div>
```

Insert the two toggles right after the existing "Primary Color" block, before the closing `</div>` of the form's `space-y-4` container (i.e. immediately before `</div>\n              <DialogFooter>`), but only rendered when no shop is linked (they're account-mode-only per the spec):

```tsx
                {!form.linked_shop_id && (
                  <>
                    <div className="flex items-center justify-between">
                      <div>
                        <Label>Show Guest-Purchase Button</Label>
                        <p className="text-xs text-muted-foreground">Shows the "Buy as Guest" link on this domain's landing page.</p>
                      </div>
                      <Switch checked={form.show_guest_purchase} onCheckedChange={v => setForm(f => ({ ...f, show_guest_purchase: v }))} />
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <Label>Show Landing Page</Label>
                        <p className="text-xs text-muted-foreground">When off, visiting this domain goes straight to login instead of the marketing homepage.</p>
                      </div>
                      <Switch checked={form.show_landing_page} onCheckedChange={v => setForm(f => ({ ...f, show_landing_page: v }))} />
                    </div>
                  </>
                )}
```

- [ ] **Step 4: Show shop-link status in the table**

Replace the table's "Services" `<TableCell>`:

```tsx
                      <TableCell className="space-x-1">
                        {row.services.map(s => <Badge key={s} variant="outline">{SERVICE_LABELS[s]}</Badge>)}
                      </TableCell>
```

with:

```tsx
                      <TableCell className="space-x-1">
                        {row.linked_shop_id ? (
                          <Badge>{shops.find(s => s.id === row.linked_shop_id)?.shop_name || "Linked Shop"}</Badge>
                        ) : (
                          row.services.map(s => <Badge key={s} variant="outline">{SERVICE_LABELS[s]}</Badge>)
                        )}
                      </TableCell>
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/admin/custom-domains/page.tsx`.

- [ ] **Step 6: Manual verification**

No automated test exists for this page (matches convention). Start the dev server, log in as admin, navigate to `/admin/custom-domains`, and confirm: the shop dropdown populates with existing shops; selecting one hides the two toggle switches; saving with a shop selected round-trips correctly on re-opening the edit dialog; saving without a shop selected shows the two toggles and persists their state; the table shows a shop badge instead of service badges for a shop-linked row.

- [ ] **Step 7: Commit**

```bash
git add app/admin/custom-domains/page.tsx
git commit -m "feat(custom-domains): admin UI gets a shop picker and the two landing-page toggle switches"
```

---

### Task 9: End-to-end verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: the full feature (Tasks 1-8).
- Produces: nothing — final integration gate, per this feature's own established convention (mirrors Task 10 of the original custom-domain-service-routing plan).

- [ ] **Step 1: Full suite + typecheck**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: every test passes (the pre-existing suite plus every new test from Tasks 2 and 7); typecheck clean project-wide.

- [ ] **Step 2: Live check — shop mode**

Using the live admin UI (`/admin/custom-domains` on the deployed app) and a domain already attached in Vercel with DNS pointed (e.g. `clingshub.com`, already live from the original feature): edit it, select an existing shop (e.g. "clings") in the shop picker, save. Then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "https://clingshub.com/"
curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "https://clingshub.com/" | grep -o "Shop Products\|Buy Data\|Buy Airtime\|Results Vouchers"
```

Expected: `200`, and the page contains the shop storefront's own markup (e.g. "Buy Data" from the sub-tab switcher), not the marketing homepage's content — confirming the rewrite landed the request inside `/shop/<subdomain>`. If the linked shop's domain has `services: ["data_bundles"]` only (as `clingshub.com` does from the original feature), "Buy Airtime" and "Results Vouchers" should NOT appear in that grep output, only "Buy Data".

- [ ] **Step 3: Live check — landing-page-hide (revert shop link first)**

Un-link the shop from `clingshub.com` (set "Link to Shop" back to "— None —") and turn on "Show Landing Page" = off, save. Then:

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "https://clingshub.com/"
```

Expected: a redirect status with `Location` pointing at `/auth/login`.

- [ ] **Step 4: Restore `clingshub.com` to its known-good state**

Set "Show Landing Page" back to on (the default) and leave "Link to Shop" as "— None —" and "Show Guest-Purchase Button" as off, matching this domain's state before this plan's verification steps — Task 9 is a verification gate, not a place to leave the live domain in a test configuration.

- [ ] **Step 5: Confirm the main site and an unrelated existing domain config are unaffected**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "https://www.datagod.store/"
```

Expected: `200`, ordinary main-site homepage — untouched by any of this plan's changes, consistent with the "no-op for current main-site traffic" invariant every task in this plan individually verified.
