# Wildcard Shop Domains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin flip one switch on a custom domain so that EVERY active, non-blocked shop platform-wide automatically becomes reachable as a subdomain of it (e.g. `kofi.clingshub.com`, `ama.clingshub.com`), replacing that domain's single-shop `linked_shop_id` link entirely, with zero per-shop configuration.

**Architecture:** Add one boolean column (`custom_domains.wildcard_shops_enabled`). Teach `lib/custom-domain-lookup.ts`'s existing subdomain-of-custom-domain fallback a second branch: instead of only matching one pre-linked shop's subdomain, it now also accepts ANY active, non-blocked shop's subdomain when the parent domain has wildcard mode on. Teach `middleware.ts` to rewrite to whichever shop subdomain the visitor actually typed (not a fixed one), guarded so a bare/`www.` visit to the wildcard domain itself is never misread as a shop label. Extend the existing `get_linked_custom_domain` SQL function (used by the reverse shop→domain lookup) with a priority-ordered UNION so a shop's own direct link always wins over a wildcard domain. Enforce domain-level mutual exclusivity (`linked_shop_id` vs `wildcard_shops_enabled`) only in the admin API route — no DB constraint.

**Tech Stack:** Next.js 15 (App Router) middleware + API routes, TypeScript, Supabase (Postgres + PostgREST), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-02-wildcard-shop-domains-design.md`

## Global Constraints

- `wildcard_shops_enabled` and `linked_shop_id` are mutually exclusive per domain row at all times — enforced ONLY in `app/api/admin/custom-domains/route.ts` (no DB `CHECK` constraint; see migration 0104).
- No new per-shop schema field, no per-shop opt-in/opt-out. Eligibility is automatic for every active (`is_active = true`), non-blocked (`is_blocked = false`) shop platform-wide the instant an admin enables wildcard mode for a domain.
- `get_linked_custom_domain(p_subdomain text) returns text` keeps its exact signature, `SECURITY DEFINER`, `set search_path = public`, `stable`, and `grant execute ... to anon, authenticated` — only its SQL body changes (migration 0105).
- `CustomDomainConfig`'s shape otherwise stays the same; `wildcard_shops_enabled: boolean` is the only new field this whole feature adds to it.
- The real Vercel wildcard DNS record (CNAME, host `*`, value `cname.vercel-dns.com.`) is a manual, external step the domain owner performs — nothing in this plan automates it.
- No new cache-invalidation mechanism beyond what already exists (the bare domain's own Redis key, already cleared by the existing PATCH/DELETE code in `app/api/admin/custom-domains/route.ts`). A shop-subdomain host that was positively cached under a wildcard domain may keep resolving for up to `CACHE_TTL_SECONDS` (5 minutes) after an admin disables wildcard mode or deactivates/blocks that shop — this is an accepted, already-documented limitation (same class as today's single-shop-link cache staleness), not a defect to fix in this plan.
- `middleware.ts` and `app/admin/custom-domains/page.tsx` get no automated tests (established repo convention) — verified via `tsc` + manual/live checks instead.

## Review Focus

- A bare-domain visit (`clingshub.com`, no subdomain) to a wildcard-enabled domain must render as plain account/dashboard mode, never attempt a bogus `/shop/clingshub/...` rewrite — covered by Task 3's "still resolves a bare wildcard-enabled domain directly, without running the shop-existence check at all" test, and by Task 4's explicit host-reconstruction guard (manually verified; no automated middleware test per convention).
- A `www.`-prefixed visit to a wildcard-enabled domain (`www.clingshub.com`) must never be misread as a shop literally named "www" — covered by Task 4's guard, which reuses `middleware.ts`'s existing `RESERVED_SUBDOMAINS` set.
- A label that isn't any active shop's subdomain (typo, deactivated shop, blocked shop, never existed) under a wildcard-enabled domain must fall through to the ordinary not-found path, never a crash or a wrong-shop rewrite — covered by Task 3's "does NOT resolve a label... when no active shop has that subdomain" test.
- A single admin API request that sets both `wildcard_shops_enabled: true` and a non-null `linked_shop_id` at once must resolve deterministically (wildcard wins, `linked_shop_id` forced null in the same write) rather than leaving the row in a contradictory state — covered by Task 6's dedicated POST/PATCH tests.
- A Redis cache entry written before this feature deploys (missing `wildcard_shops_enabled` entirely) must be treated as a cache miss and re-fetched from Supabase, never returned with `undefined` silently masquerading as `false` — covered by Task 3's cache-shape-guard test.

---

### Task 1: Migration — `wildcard_shops_enabled` column

**Files:**
- Create: `migrations/0104_custom_domains_wildcard_shops_enabled.sql`

**Interfaces:**
- Produces: `custom_domains.wildcard_shops_enabled boolean not null default false` — every later task reads/writes this column.

- [ ] **Step 1: Write the migration**

```sql
-- Lets an admin turn a custom domain into a shared, platform-wide
-- storefront host: when true, every active, non-blocked shop automatically
-- becomes reachable as <that shop's own subdomain>.<this domain> (see
-- lib/custom-domain-lookup.ts's resolveCustomDomain and migration 0105's
-- updated get_linked_custom_domain). Mutually exclusive with linked_shop_id
-- (migration 0101) — enforced only in app/api/admin/custom-domains/route.ts,
-- not with a DB CHECK constraint, to keep this column a simple additive
-- change.
alter table custom_domains
  add column if not exists wildcard_shops_enabled boolean not null default false;
```

- [ ] **Step 2: Apply the migration against the live Supabase database**

Use the same mechanism already used for migrations 0101-0103 earlier today (the Supabase MCP tool if connected this session, or the Management API SQL-execution endpoint documented in this project's own Supabase access notes).

- [ ] **Step 3: Verify live**

Run:
```sql
select column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_name = 'custom_domains' and column_name = 'wildcard_shops_enabled';
```
Expected: exactly one row, `data_type = 'boolean'`, `column_default = 'false'`, `is_nullable = 'NO'`.

- [ ] **Step 4: Commit**

```bash
git add migrations/0104_custom_domains_wildcard_shops_enabled.sql
git commit -m "feat(custom-domains): add wildcard_shops_enabled column"
```

---

### Task 2: `lib/custom-domains.ts` — `CustomDomainConfig` gains the field

**Files:**
- Modify: `lib/custom-domains.ts:5-20`

**Interfaces:**
- Consumes: Task 1's `custom_domains.wildcard_shops_enabled` column.
- Produces: `CustomDomainConfig.wildcard_shops_enabled: boolean` — Task 3 populates it, Task 4 reads it, Task 6/7 write it.

- [ ] **Step 1: Edit the interface**

In `lib/custom-domains.ts`, change:

```ts
export interface CustomDomainConfig {
  domain: string
  services: DomainService[]
  site_name: string
  logo_url: string | null
  primary_color: string | null
  is_active: boolean
  hidden_pages: string[]
  // Non-null when this domain is linked to an existing shop — the shop's own
  // `subdomain` (not `shop_slug`), used directly as the middleware rewrite
  // target. Null means this domain stays in dashboard/account mode. (Showing
  // the guest-purchase button and the landing page itself are both already
  // covered by hidden_pages' own "guest_purchase"/"landing_page" keys — no
  // separate fields needed for those.)
  linked_shop_subdomain: string | null
}
```

to:

```ts
export interface CustomDomainConfig {
  domain: string
  services: DomainService[]
  site_name: string
  logo_url: string | null
  primary_color: string | null
  is_active: boolean
  hidden_pages: string[]
  // Non-null when this domain is linked to an existing shop — the shop's own
  // `subdomain` (not `shop_slug`), used directly as the middleware rewrite
  // target. Null means this domain stays in dashboard/account mode. (Showing
  // the guest-purchase button and the landing page itself are both already
  // covered by hidden_pages' own "guest_purchase"/"landing_page" keys — no
  // separate fields needed for those.)
  linked_shop_subdomain: string | null
  // True when every active, non-blocked shop platform-wide is reachable as
  // <that shop's own subdomain>.<this domain> — mutually exclusive with
  // linked_shop_subdomain being non-null (enforced in the admin API route,
  // not here; see migration 0104).
  wildcard_shops_enabled: boolean
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: new errors at every call site that constructs a `CustomDomainConfig` literal without `wildcard_shops_enabled` — these are exactly `lib/custom-domain-lookup.ts` (fixed in Task 3) and its test file (also fixed in Task 3). No other production file constructs this type directly.

- [ ] **Step 3: Commit**

```bash
git add lib/custom-domains.ts
git commit -m "feat(custom-domains): add wildcard_shops_enabled to CustomDomainConfig"
```

---

### Task 3: `lib/custom-domain-lookup.ts` — wildcard subdomain resolution

**Files:**
- Modify: `lib/custom-domain-lookup.ts:62-117` (`lookupExact`), `lib/custom-domain-lookup.ts:137-181` (`resolveCustomDomain`)
- Test: `lib/custom-domain-lookup.test.ts`

**Interfaces:**
- Consumes: `CustomDomainConfig.wildcard_shops_enabled` (Task 2); `supabaseAdmin` (service-role client, already imported in this file — no RLS/column-grant concern, unlike the browser-client RPC built this morning).
- Produces: `resolveCustomDomain(host)` now also resolves `<any active shop's own subdomain>.<a wildcard-enabled domain>` to that domain's `CustomDomainConfig`. No new exports.

- [ ] **Step 1: Update the shared test fixtures and Supabase mock in `lib/custom-domain-lookup.test.ts`**

Replace the file's `sampleConfig`/`sampleRawRow` (lines 54-74):

```ts
const sampleConfig: CustomDomainConfig = {
  domain: "checkresults.com",
  services: ["results_checker"],
  site_name: "CheckResults",
  logo_url: null,
  primary_color: "#059669",
  is_active: true,
  hidden_pages: [],
  linked_shop_subdomain: null,
  wildcard_shops_enabled: false,
}

const sampleRawRow = {
  domain: sampleConfig.domain,
  services: sampleConfig.services,
  site_name: sampleConfig.site_name,
  logo_url: sampleConfig.logo_url,
  primary_color: sampleConfig.primary_color,
  is_active: sampleConfig.is_active,
  hidden_pages: sampleConfig.hidden_pages,
  wildcard_shops_enabled: sampleConfig.wildcard_shops_enabled,
  linked_shop: null as { subdomain: string } | null,
}
```

Replace the file's `@/lib/supabase` mock (lines 22-35) — the existing shape only supports a 2-level `.eq().eq()` chain for the `custom_domains` lookup; the new wildcard-existence check queries `user_shops` with a 3-level `.eq().eq().eq()` chain, so the mock must dispatch on table name:

```ts
const maybeSingleMock = vi.fn()
const shopExistsMaybeSingleMock = vi.fn()
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "user_shops") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: shopExistsMaybeSingleMock,
                }),
              }),
            }),
          }),
        }
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: maybeSingleMock,
            }),
          }),
        }),
      }
    },
  },
}))
```

- [ ] **Step 2: Run the existing suite to confirm the fixture/mock change alone breaks nothing**

Run: `npx vitest run lib/custom-domain-lookup.test.ts`
Expected: PASS — every existing test still only calls `.from("custom_domains")` (the implicit default branch), so none of them touch `shopExistsMaybeSingleMock`.

- [ ] **Step 3: Write the 4 new failing tests**

Add to `lib/custom-domain-lookup.test.ts`, inside the `describe("resolveCustomDomain", ...)` block (anywhere after the existing fixture definitions):

```ts
  it("treats a cached config missing wildcard_shops_enabled (from before it existed) as a miss, not a crash", async () => {
    const staleConfig = {
      domain: sampleConfig.domain,
      services: sampleConfig.services,
      site_name: sampleConfig.site_name,
      logo_url: sampleConfig.logo_url,
      primary_color: sampleConfig.primary_color,
      is_active: sampleConfig.is_active,
      hidden_pages: sampleConfig.hidden_pages,
      linked_shop_subdomain: sampleConfig.linked_shop_subdomain,
    }
    redisGetMock.mockResolvedValueOnce(staleConfig)
    maybeSingleMock.mockResolvedValueOnce({ data: sampleRawRow, error: null })
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("checkresults.com")

    expect(maybeSingleMock).toHaveBeenCalled()
    expect(result).toEqual(sampleConfig)
  })

  it("resolves an active shop's own subdomain under a wildcard-enabled domain", async () => {
    redisGetMock.mockResolvedValue(null)
    maybeSingleMock
      .mockResolvedValueOnce({ data: null, error: null }) // miss for "kofi.clingshub.com" itself
      .mockResolvedValueOnce({ data: null, error: null }) // miss for its www-toggled form
      .mockResolvedValueOnce({
        data: { ...sampleRawRow, domain: "clingshub.com", wildcard_shops_enabled: true },
        error: null,
      }) // hit for the stripped remainder "clingshub.com", wildcard mode on
    shopExistsMaybeSingleMock.mockResolvedValueOnce({ data: { id: "shop-1" }, error: null }) // "kofi" is an active, non-blocked shop
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("kofi.clingshub.com")

    expect(result?.domain).toBe("clingshub.com")
    expect(result?.wildcard_shops_enabled).toBe(true)
  })

  it("does NOT resolve a label under a wildcard-enabled domain when no active shop has that subdomain", async () => {
    redisGetMock.mockResolvedValue(null)
    maybeSingleMock
      .mockResolvedValueOnce({ data: null, error: null }) // miss for "nosuchshop.clingshub.com"
      .mockResolvedValueOnce({ data: null, error: null }) // miss for its www-toggled form
      .mockResolvedValueOnce({
        data: { ...sampleRawRow, domain: "clingshub.com", wildcard_shops_enabled: true },
        error: null,
      })
    shopExistsMaybeSingleMock.mockResolvedValueOnce({ data: null, error: null }) // no active shop named "nosuchshop"
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("nosuchshop.clingshub.com")

    expect(result).toBeNull()
  })

  it("still resolves a bare wildcard-enabled domain directly, without running the shop-existence check at all", async () => {
    redisGetMock.mockResolvedValueOnce(null)
    maybeSingleMock.mockResolvedValueOnce({
      data: { ...sampleRawRow, domain: "clingshub.com", wildcard_shops_enabled: true },
      error: null,
    }) // exact hit on "clingshub.com" itself
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("clingshub.com")

    expect(result?.domain).toBe("clingshub.com")
    expect(maybeSingleMock).toHaveBeenCalledTimes(1)
    expect(shopExistsMaybeSingleMock).not.toHaveBeenCalled()
  })
```

- [ ] **Step 4: Run to verify the 4 new tests fail**

Run: `npx vitest run lib/custom-domain-lookup.test.ts`
Expected: the 4 new tests FAIL (the cache-guard test fails because `result` includes `wildcard_shops_enabled: undefined` instead of being treated as a miss; the 3 wildcard-branch tests fail because `resolveCustomDomain` has no wildcard branch yet, so they resolve to `null` or throw on the unexercised `shopExistsMaybeSingleMock`). All pre-existing tests still PASS.

- [ ] **Step 5: Implement — `lookupExact`'s select, mapping, and cache-shape guard**

In `lib/custom-domain-lookup.ts`, change the cache-shape guard (inside `lookupExact`):

```ts
      if (
        cached &&
        Array.isArray(cached.hidden_pages) &&
        (cached.linked_shop_subdomain === null || typeof cached.linked_shop_subdomain === "string")
      ) {
        return { kind: "found", config: cached }
      }
```

to:

```ts
      if (
        cached &&
        Array.isArray(cached.hidden_pages) &&
        (cached.linked_shop_subdomain === null || typeof cached.linked_shop_subdomain === "string") &&
        typeof cached.wildcard_shops_enabled === "boolean"
      ) {
        return { kind: "found", config: cached }
      }
```

Change the Supabase select:

```ts
      .select("domain, services, site_name, logo_url, primary_color, is_active, hidden_pages, linked_shop:user_shops!linked_shop_id(subdomain)")
```

to:

```ts
      .select("domain, services, site_name, logo_url, primary_color, is_active, hidden_pages, wildcard_shops_enabled, linked_shop:user_shops!linked_shop_id(subdomain)")
```

Change the row-to-config mapping:

```ts
    const row = data as typeof data & { linked_shop: { subdomain: string } | null }
    const config: CustomDomainConfig = {
      domain: row.domain,
      services: row.services,
      site_name: row.site_name,
      logo_url: row.logo_url,
      primary_color: row.primary_color,
      is_active: row.is_active,
      hidden_pages: row.hidden_pages,
      linked_shop_subdomain: row.linked_shop?.subdomain ?? null,
    }
```

to:

```ts
    const row = data as typeof data & { linked_shop: { subdomain: string } | null }
    const config: CustomDomainConfig = {
      domain: row.domain,
      services: row.services,
      site_name: row.site_name,
      logo_url: row.logo_url,
      primary_color: row.primary_color,
      is_active: row.is_active,
      hidden_pages: row.hidden_pages,
      linked_shop_subdomain: row.linked_shop?.subdomain ?? null,
      wildcard_shops_enabled: row.wildcard_shops_enabled,
    }
```

- [ ] **Step 6: Implement — the wildcard-existence helper and `resolveCustomDomain`'s second fallback check**

Add this new function anywhere above `resolveCustomDomain` (e.g. directly below `lookupExact`):

```ts
// Direct, non-embedded existence check against user_shops — safe to call
// with supabaseAdmin (service-role; no RLS/column-grant concern here,
// unlike the anon-facing RPC built this morning for the reverse shop->domain
// lookup). Used only by resolveCustomDomain's wildcard fallback below, to
// confirm a stripped host label is a real, currently-usable shop subdomain
// before treating a wildcard-enabled domain's visitor as that shop.
async function wildcardShopExists(subdomain: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("user_shops")
      .select("id")
      .eq("subdomain", subdomain)
      .eq("is_active", true)
      .eq("is_blocked", false)
      .maybeSingle()
    if (error) {
      console.error("[CUSTOM-DOMAIN-LOOKUP] Wildcard shop existence check failed:", error)
      return false
    }
    return !!data
  } catch (e) {
    console.error("[CUSTOM-DOMAIN-LOOKUP] Wildcard shop existence check failed:", e instanceof Error ? e.message : e)
    return false
  }
}
```

In `resolveCustomDomain`, change:

```ts
  const firstDot = host.indexOf(".")
  if (firstDot > 0) {
    const label = host.slice(0, firstDot)
    const remainder = host.slice(firstDot + 1)
    const parent = await lookupExact(remainder)
    if (parent.kind === "found" && parent.config.linked_shop_subdomain === label) {
      cacheSetPositive(host, parent.config)
      return parent.config
    }
    if (parent.kind === "error") return null
  }
```

to:

```ts
  const firstDot = host.indexOf(".")
  if (firstDot > 0) {
    const label = host.slice(0, firstDot)
    const remainder = host.slice(firstDot + 1)
    const parent = await lookupExact(remainder)
    if (parent.kind === "found" && parent.config.linked_shop_subdomain === label) {
      cacheSetPositive(host, parent.config)
      return parent.config
    }
    if (parent.kind === "found" && parent.config.wildcard_shops_enabled && (await wildcardShopExists(label))) {
      cacheSetPositive(host, parent.config)
      return parent.config
    }
    if (parent.kind === "error") return null
  }
```

- [ ] **Step 7: Run the full file to verify all tests pass**

Run: `npx vitest run lib/custom-domain-lookup.test.ts`
Expected: PASS — all previously-existing tests plus the 4 new ones.

- [ ] **Step 8: Commit**

```bash
git add lib/custom-domain-lookup.ts lib/custom-domain-lookup.test.ts
git commit -m "feat(custom-domains): resolve any active shop's subdomain under a wildcard-enabled domain"
```

---

### Task 4: `middleware.ts` — label-driven shop-mode rewrite under wildcard

**Files:**
- Modify: `middleware.ts:133-143`

**Interfaces:**
- Consumes: `customDomainConfig.wildcard_shops_enabled` and `.domain` (Tasks 2-3); `RESERVED_SUBDOMAINS` (already defined at `middleware.ts:27`); `hostname` (already computed at `middleware.ts:109`).
- Produces: no exported interface change — `customDomainShopRewritePathname` behaves the same for single-shop-linked domains, and now also rewrites correctly for wildcard-enabled domains.

- [ ] **Step 1: Implement**

In `middleware.ts`, change:

```ts
  const customDomainShopRewritePathname =
    customDomainConfig?.linked_shop_subdomain &&
    !path.startsWith("/shop/") &&
    !path.startsWith("/api") &&
    !path.startsWith("/_next") &&
    !path.startsWith("/auth") &&
    !path.startsWith("/dashboard") &&
    !path.startsWith("/admin") &&
    !PUBLIC_FILE.test(path)
      ? `/shop/${customDomainConfig.linked_shop_subdomain}${path === "/" ? "" : path}`
      : null
```

to:

```ts
  // Under wildcard mode (every active, non-blocked shop usable as a
  // subdomain of this one domain — see lib/custom-domain-lookup.ts), the
  // rewrite target is the REQUESTED subdomain label itself — e.g. "kofi"
  // from "kofi.clingshub.com" — not one fixed shop. resolveCustomDomain's
  // own subdomain-fallback lookup already confirmed this exact label is an
  // active, non-blocked shop's own subdomain before returning this config,
  // so middleware only re-derives the same label; it doesn't re-verify it.
  //
  // This must NOT fire for a bare-domain visit (hostname IS the domain
  // itself) or its "www." form: both resolve via resolveCustomDomain's
  // exact-host/www-toggle paths, not the subdomain-fallback path, so a
  // naive hostname.split(".")[0] there would wrongly extract "clingshub" or
  // "www" as if it were a real shop subdomain. RESERVED_SUBDOMAINS (defined
  // above for the ROOT_DOMAIN rewrite) already excludes "www" from ever
  // being a valid shop label, so reusing it here closes that case; the
  // `hostname === "<label>.<domain>"` reconstruction below is the
  // authoritative guard regardless of which label is involved.
  const strippedLabel = hostname && hostname.includes(".") ? hostname.slice(0, hostname.indexOf(".")) : null
  const wildcardLabelValid =
    !!customDomainConfig?.wildcard_shops_enabled &&
    !!strippedLabel &&
    !RESERVED_SUBDOMAINS.has(strippedLabel) &&
    hostname === `${strippedLabel}.${customDomainConfig.domain}`

  const shopModeSubdomain = wildcardLabelValid ? strippedLabel : customDomainConfig?.linked_shop_subdomain

  const customDomainShopRewritePathname =
    shopModeSubdomain &&
    !path.startsWith("/shop/") &&
    !path.startsWith("/api") &&
    !path.startsWith("/_next") &&
    !path.startsWith("/auth") &&
    !path.startsWith("/dashboard") &&
    !path.startsWith("/admin") &&
    !PUBLIC_FILE.test(path)
      ? `/shop/${shopModeSubdomain}${path === "/" ? "" : path}`
      : null
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Manual verification (no automated middleware test, per established convention)**

Trace through by hand and confirm against the code read above:
- `hostname = "kofi.clingshub.com"`, `customDomainConfig = { domain: "clingshub.com", wildcard_shops_enabled: true, ... }` → `strippedLabel = "kofi"`, not reserved, `"kofi.clingshub.com" === "kofi.clingshub.com"` → `wildcardLabelValid = true` → rewrites to `/shop/kofi/...`. Correct.
- `hostname = "clingshub.com"` (bare), same config, resolved via the EXACT-match path — meaning `customDomainConfig.domain === hostname` always holds here by construction (`lookupExact` only returns a config whose own `domain` field literally equals the queried host). `strippedLabel` still computes to `"clingshub"` (the string DOES contain a dot — it's the domain's own TLD separator, not a subdomain boundary) — but the reconstruction check `hostname === `${strippedLabel}.${customDomainConfig.domain}`` becomes `"clingshub.com" === "clingshub.clingshub.com"`, which is false (the right side is always strictly longer whenever `domain === hostname`) → `wildcardLabelValid = false` regardless of what `strippedLabel` happened to be → falls back to `customDomainConfig.linked_shop_subdomain`, which is `null` for a wildcard domain (mutually exclusive, Task 6) → no shop-mode rewrite → falls through to account-mode handling. Correct.
- `hostname = "www.clingshub.com"` (resolved via the www-toggle, so `customDomainConfig.domain = "clingshub.com"` — NOT equal to hostname this time) → `strippedLabel = "www"`. Here the reconstruction check alone is NOT enough: `${strippedLabel}.${domain}` = `"www.clingshub.com"`, which DOES equal `hostname` — so without a separate guard this would wrongly evaluate to `true`. This is exactly why `!RESERVED_SUBDOMAINS.has(strippedLabel)` is a load-bearing second condition, not a redundant one: `RESERVED_SUBDOMAINS.has("www")` is true → `wildcardLabelValid = false` → same fallback as above. Correct.
- A single-shop-linked (non-wildcard) domain, `customDomainConfig.wildcard_shops_enabled = false` → `wildcardLabelValid` short-circuits false immediately → `shopModeSubdomain = customDomainConfig.linked_shop_subdomain` → identical to today's pre-existing behavior. Correct.

- [ ] **Step 4: Commit**

```bash
git add middleware.ts
git commit -m "feat(custom-domains): rewrite to the requested shop label under wildcard mode"
```

---

### Task 5: Migration — `get_linked_custom_domain` gains wildcard priority

**Files:**
- Create: `migrations/0105_get_linked_custom_domain_wildcard_priority.sql`

**Interfaces:**
- Consumes: `custom_domains.wildcard_shops_enabled` (Task 1).
- Produces: `get_linked_custom_domain(p_subdomain text)` now also returns a wildcard-enabled domain when the shop has no direct link — same signature, same grants, no TypeScript change anywhere (`lib/shop-service.ts`'s `getLinkedCustomDomain`, and everything built on it — `getShop`, `getShopBySlug`, every `shopOrigin` call site, `app/shop/[slug]/layout.tsx`'s canonical URL — all pick this up automatically with zero code changes).

- [ ] **Step 1: Write the migration**

```sql
-- Extends migration 0103's get_linked_custom_domain to also consider
-- wildcard-enabled domains (migration 0104): every active, non-blocked
-- shop's own subdomain automatically resolves under such a domain, with
-- the shop's own direct link (if any) always taking priority, then the
-- oldest active row winning any further tie. Same SECURITY DEFINER
-- signature as 0103 — only the body changes, so no TypeScript call site
-- needs any change at all.

create or replace function get_linked_custom_domain(p_subdomain text)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select domain from (
    -- Priority 1: this shop is specifically linked to an active domain.
    select cd.domain, cd.created_at, 1 as priority
    from custom_domains cd
    join user_shops us on us.id = cd.linked_shop_id
    where cd.is_active = true and us.subdomain = p_subdomain

    union all

    -- Priority 2: any active domain has wildcard mode on — every active,
    -- non-blocked shop is automatically reachable under it, so the
    -- caller's own subdomain being active is enough; no shop-specific
    -- match needed.
    select cd.domain, cd.created_at, 2 as priority
    from custom_domains cd
    where cd.is_active = true and cd.wildcard_shops_enabled = true
  ) ranked
  order by priority asc, created_at asc
  limit 1
$$;

grant execute on function get_linked_custom_domain(text) to anon, authenticated;
```

- [ ] **Step 2: Apply the migration against the live Supabase database**

Same mechanism as Task 1, Step 2.

- [ ] **Step 3: Live-verify the priority logic with a non-persisting transaction**

Run this against the live database (it wraps everything in `begin`/`rollback`, so nothing is actually written — safe to run against production data, and avoids creating or mutating any real `custom_domains`/`user_shops` row):

```sql
begin;

insert into user_shops (id, user_id, shop_name, shop_slug, subdomain, is_active, is_blocked)
values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'Test Shop A', 'test-shop-a', 'wcard-test-shop-a', true, false);

insert into custom_domains (domain, services, site_name, is_active, linked_shop_id, wildcard_shops_enabled, created_at)
values
  ('wcard-test-direct.example', array['data_bundles']::text[], 'Direct', true, '00000000-0000-0000-0000-000000000001', false, now() - interval '2 days'),
  ('wcard-test-wild.example', array['data_bundles']::text[], 'Wild', true, null, true, now() - interval '1 day');

-- Shop A has BOTH a direct link AND an available wildcard domain — direct
-- link must win.
select get_linked_custom_domain('wcard-test-shop-a') as result_a;
-- Expected: 'wcard-test-direct.example'

-- A shop with no direct link at all still resolves via the wildcard domain.
insert into user_shops (id, user_id, shop_name, shop_slug, subdomain, is_active, is_blocked)
values
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000b', 'Test Shop B', 'test-shop-b', 'wcard-test-shop-b', true, false);
select get_linked_custom_domain('wcard-test-shop-b') as result_b;
-- Expected: 'wcard-test-wild.example'

rollback;
```

Expected: `result_a = 'wcard-test-direct.example'`, `result_b = 'wcard-test-wild.example'`. The `rollback` at the end means none of these rows persist — confirm with a follow-up `select count(*) from custom_domains where domain like 'wcard-test-%';` returning `0`.

No TypeScript test changes are needed for this task: `lib/shop-service.test.ts`'s 4 existing tests already fully cover `getLinkedCustomDomain`'s wiring (parameter passed through, success/null/error handling) by mocking whatever `rpc()` returns — none of that wiring changes here, only the SQL body the real database runs, which a TS-level mock can't observe. The priority logic itself is verified live, above.

- [ ] **Step 4: Commit**

```bash
git add migrations/0105_get_linked_custom_domain_wildcard_priority.sql
git commit -m "feat(custom-domains): prioritize a shop's direct link over a wildcard domain"
```

---

### Task 6: `app/api/admin/custom-domains/route.ts` — validation and mutual exclusivity

**Files:**
- Modify: `app/api/admin/custom-domains/route.ts`
- Test: `app/api/admin/custom-domains/route.test.ts`

**Interfaces:**
- Consumes: `custom_domains.wildcard_shops_enabled` (Task 1); `setCustomDomainCache`/`clearCustomDomainCache` (unchanged signatures).
- Produces: POST/PATCH accept a `wildcard_shops_enabled: boolean` body field; GET's response rows include it; mutual exclusivity with `linked_shop_id` is enforced server-side (wildcard wins if a single request sets both).

- [ ] **Step 1: Write the 6 failing tests**

Add to `app/api/admin/custom-domains/route.test.ts`, inside `describe("POST /api/admin/custom-domains", ...)`:

```ts
  it("rejects a non-boolean wildcard_shops_enabled on create", async () => {
    const res = await POST(postRequest({ domain: "clingshub.com", services: ["data_bundles"], site_name: "ClingsHub", wildcard_shops_enabled: "yes" }))
    expect(res.status).toBe(400)
  })

  it("accepts wildcard_shops_enabled and writes it to the inserted row and cache", async () => {
    const builder = makeBuilder({
      data: { id: "1", domain: "clingshub.com", services: ["data_bundles"], site_name: "ClingsHub", logo_url: null, primary_color: null, is_active: true, linked_shop_id: null, wildcard_shops_enabled: true },
      error: null,
    })
    fromMock.mockReturnValue(builder)

    const res = await POST(postRequest({ domain: "clingshub.com", services: ["data_bundles"], site_name: "ClingsHub", wildcard_shops_enabled: true }))

    expect(res.status).toBe(201)
    const insertedRow = builder.insert.mock.calls[0][0]
    expect(insertedRow.wildcard_shops_enabled).toBe(true)
    expect(insertedRow.linked_shop_id).toBeNull()
    expect(setCacheMock).toHaveBeenCalledWith(expect.objectContaining({ wildcard_shops_enabled: true }))
  })

  it("forces linked_shop_id to null when wildcard_shops_enabled is also set true in the same POST", async () => {
    const builder = makeBuilder({
      data: { id: "1", domain: "clingshub.com", services: ["data_bundles"], site_name: "ClingsHub", logo_url: null, primary_color: null, is_active: true, linked_shop_id: null, wildcard_shops_enabled: true },
      error: null,
    })
    fromMock.mockImplementation((table: string) =>
      table === "user_shops"
        ? makeBuilder({ data: { id: "11111111-1111-1111-1111-111111111111", subdomain: "myshop", is_active: true, is_blocked: false }, error: null })
        : builder
    )

    const res = await POST(postRequest({
      domain: "clingshub.com", services: ["data_bundles"], site_name: "ClingsHub",
      wildcard_shops_enabled: true, linked_shop_id: "11111111-1111-1111-1111-111111111111",
    }))

    expect(res.status).toBe(201)
    const insertedRow = builder.insert.mock.calls[0][0]
    expect(insertedRow.linked_shop_id).toBeNull()
    expect(insertedRow.wildcard_shops_enabled).toBe(true)
  })
```

Add to `describe("PATCH /api/admin/custom-domains", ...)`:

```ts
  it("rejects a non-boolean wildcard_shops_enabled on update", async () => {
    const res = await PATCH(postRequest({ id: "1", wildcard_shops_enabled: "yes" }, "PATCH"))
    expect(res.status).toBe(400)
  })

  it("clears linked_shop_id in the same update when PATCH turns wildcard_shops_enabled on", async () => {
    const builder = makeBuilder({
      data: { id: "1", domain: "clingshub.com", services: ["data_bundles"], site_name: "ClingsHub", logo_url: null, primary_color: null, is_active: true, linked_shop_id: null, wildcard_shops_enabled: true },
      error: null,
    })
    fromMock.mockReturnValue(builder)

    const res = await PATCH(postRequest({ id: "1", wildcard_shops_enabled: true }, "PATCH"))

    expect(res.status).toBe(200)
    const updatePayload = builder.update.mock.calls[0][0]
    expect(updatePayload.wildcard_shops_enabled).toBe(true)
    expect(updatePayload.linked_shop_id).toBeNull()
  })

  it("clears wildcard_shops_enabled in the same update when PATCH sets a linked_shop_id", async () => {
    const builder = makeBuilder({
      data: { id: "1", domain: "clingshub.com", services: ["data_bundles"], site_name: "ClingsHub", logo_url: null, primary_color: null, is_active: true, linked_shop_id: "11111111-1111-1111-1111-111111111111", wildcard_shops_enabled: false },
      error: null,
    })
    fromMock.mockImplementation((table: string) =>
      table === "user_shops"
        ? makeBuilder({ data: { id: "11111111-1111-1111-1111-111111111111", subdomain: "myshop", is_active: true, is_blocked: false }, error: null })
        : builder
    )

    const res = await PATCH(postRequest({ id: "1", linked_shop_id: "11111111-1111-1111-1111-111111111111" }, "PATCH"))

    expect(res.status).toBe(200)
    const updatePayload = builder.update.mock.calls[0][0]
    expect(updatePayload.linked_shop_id).toBe("11111111-1111-1111-1111-111111111111")
    expect(updatePayload.wildcard_shops_enabled).toBe(false)
  })
```

- [ ] **Step 2: Run to verify the 6 new tests fail**

Run: `npx vitest run app/api/admin/custom-domains/route.test.ts`
Expected: the 6 new tests FAIL (the route doesn't recognize `wildcard_shops_enabled` at all yet — the non-boolean-rejection tests fail because nothing validates it, and the write/clear tests fail because the field is absent from `insertedRow`/`updatePayload`). All pre-existing tests still PASS.

- [ ] **Step 3: Implement — GET's select list**

In `app/api/admin/custom-domains/route.ts`, change:

```ts
    .select("id, domain, services, site_name, logo_url, primary_color, is_active, linked_shop_id, hidden_pages, created_at, updated_at")
```

to:

```ts
    .select("id, domain, services, site_name, logo_url, primary_color, is_active, linked_shop_id, hidden_pages, wildcard_shops_enabled, created_at, updated_at")
```

- [ ] **Step 4: Implement — the validator helper**

Add this function near `parseHiddenPages` (e.g. directly below it, above `export async function GET`):

```ts
/** Validates an optional `wildcard_shops_enabled` request field: undefined
 * defaults to false (unchanged), anything else must be a boolean. */
function parseWildcardShopsEnabled(raw: unknown): { wildcardShopsEnabled: boolean } | { error: string } {
  if (raw === undefined) return { wildcardShopsEnabled: false }
  if (typeof raw !== "boolean") return { error: "'wildcard_shops_enabled' must be a boolean" }
  return { wildcardShopsEnabled: raw }
}
```

- [ ] **Step 5: Implement — POST**

In the `POST` handler, change:

```ts
    const linkedShopResult = await validateLinkedShopId(body.linked_shop_id)
    if ("error" in linkedShopResult) {
      return NextResponse.json({ error: linkedShopResult.error }, { status: 400 })
    }
    const { linkedShopId, linkedShopSubdomain } = linkedShopResult

    const row = {
      domain, services, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true,
      linked_shop_id: linkedShopId,
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
      linked_shop_subdomain: linkedShopSubdomain,
      hidden_pages: data.hidden_pages,
    })
```

to:

```ts
    const wildcardResult = parseWildcardShopsEnabled(body.wildcard_shops_enabled)
    if ("error" in wildcardResult) {
      return NextResponse.json({ error: wildcardResult.error }, { status: 400 })
    }
    const linkedShopResult = await validateLinkedShopId(body.linked_shop_id)
    if ("error" in linkedShopResult) {
      return NextResponse.json({ error: linkedShopResult.error }, { status: 400 })
    }
    let { linkedShopId, linkedShopSubdomain } = linkedShopResult
    const wildcardShopsEnabled = wildcardResult.wildcardShopsEnabled

    // Mutual exclusivity (migration 0104): a domain can never both be
    // linked to one shop and wildcard-enabled. Wildcard wins if a single
    // request somehow sets both — the admin UI's own checkbox/dropdown
    // never submits both at once in practice (see app/admin/custom-domains/
    // page.tsx), so this only resolves a malformed/direct-API request
    // deterministically rather than leaving an inconsistent row.
    if (wildcardShopsEnabled) {
      linkedShopId = null
      linkedShopSubdomain = null
    }

    const row = {
      domain, services, site_name: siteName, logo_url: logoUrl, primary_color: primaryColor, is_active: true,
      linked_shop_id: linkedShopId,
      wildcard_shops_enabled: wildcardShopsEnabled,
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
      linked_shop_subdomain: linkedShopSubdomain,
      wildcard_shops_enabled: wildcardShopsEnabled,
      hidden_pages: data.hidden_pages,
    })
```

- [ ] **Step 6: Implement — PATCH**

In the `PATCH` handler, change:

```ts
    if (body.linked_shop_id !== undefined) {
      const linkedShopResult = await validateLinkedShopId(body.linked_shop_id)
      if ("error" in linkedShopResult) {
        return NextResponse.json({ error: linkedShopResult.error }, { status: 400 })
      }
      updates.linked_shop_id = linkedShopResult.linkedShopId
    }
    if (body.hidden_pages !== undefined) {
```

to:

```ts
    if (body.wildcard_shops_enabled !== undefined) {
      const wildcardResult = parseWildcardShopsEnabled(body.wildcard_shops_enabled)
      if ("error" in wildcardResult) {
        return NextResponse.json({ error: wildcardResult.error }, { status: 400 })
      }
      updates.wildcard_shops_enabled = wildcardResult.wildcardShopsEnabled
    }
    if (body.linked_shop_id !== undefined) {
      const linkedShopResult = await validateLinkedShopId(body.linked_shop_id)
      if ("error" in linkedShopResult) {
        return NextResponse.json({ error: linkedShopResult.error }, { status: 400 })
      }
      updates.linked_shop_id = linkedShopResult.linkedShopId
    }
    // Mutual exclusivity (migration 0104), same precedence as POST above:
    // whichever of the two fields THIS request sets to an "on" value wins
    // and clears the other in the SAME update, so two separate PATCH calls
    // (one per field, as the admin UI's mutually-exclusive checkbox/dropdown
    // naturally sends) always converge correctly even though the client
    // never has to send the cleared field itself.
    if (updates.wildcard_shops_enabled === true) {
      updates.linked_shop_id = null
    } else if (updates.linked_shop_id) {
      updates.wildcard_shops_enabled = false
    }
    if (body.hidden_pages !== undefined) {
```

Then, further down in the same handler, change both `setCustomDomainCache` calls' object literals to include the new field — change:

```ts
      if (shopLookupFailed) {
        // Don't write a config we know may have the wrong linked_shop_subdomain —
        // clear the cache instead so the next request re-resolves it fresh from
        // Supabase, rather than caching a guessed value for up to 5 minutes.
        await clearCustomDomainCache(data.domain)
      } else {
        await setCustomDomainCache({
          domain: data.domain, services: data.services, site_name: data.site_name,
          logo_url: data.logo_url, primary_color: data.primary_color, is_active: data.is_active,
          linked_shop_subdomain: linkedShopSubdomain,
          hidden_pages: data.hidden_pages,
        })
      }
```

to:

```ts
      if (shopLookupFailed) {
        // Don't write a config we know may have the wrong linked_shop_subdomain —
        // clear the cache instead so the next request re-resolves it fresh from
        // Supabase, rather than caching a guessed value for up to 5 minutes.
        await clearCustomDomainCache(data.domain)
      } else {
        await setCustomDomainCache({
          domain: data.domain, services: data.services, site_name: data.site_name,
          logo_url: data.logo_url, primary_color: data.primary_color, is_active: data.is_active,
          linked_shop_subdomain: linkedShopSubdomain,
          wildcard_shops_enabled: data.wildcard_shops_enabled,
          hidden_pages: data.hidden_pages,
        })
      }
```

- [ ] **Step 7: Run the full file to verify all tests pass**

Run: `npx vitest run app/api/admin/custom-domains/route.test.ts`
Expected: PASS — all previously-existing tests plus the 6 new ones.

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 9: Commit**

```bash
git add app/api/admin/custom-domains/route.ts app/api/admin/custom-domains/route.test.ts
git commit -m "feat(custom-domains): validate wildcard_shops_enabled, enforce mutual exclusivity with linked_shop_id"
```

---

### Task 7: `app/admin/custom-domains/page.tsx` — wildcard checkbox and mutual exclusivity UI

**Files:**
- Modify: `app/admin/custom-domains/page.tsx`

**Interfaces:**
- Consumes: Task 6's `GET`/`POST`/`PATCH` `wildcard_shops_enabled` field.
- Produces: no exported interface — final UI surface for this feature.

- [ ] **Step 1: Interface and form-state**

Change:

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
  hidden_pages: string[]
  created_at: string
  updated_at: string
}
```

to:

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
  wildcard_shops_enabled: boolean
  hidden_pages: string[]
  created_at: string
  updated_at: string
}
```

Change:

```ts
const EMPTY_FORM = {
  domain: "", services: [] as DomainService[], site_name: "", logo_url: "", primary_color: "",
  linked_shop_id: null as string | null,
  hidden_pages: DEFAULT_HIDDEN_PAGES as string[],
}
```

to:

```ts
const EMPTY_FORM = {
  domain: "", services: [] as DomainService[], site_name: "", logo_url: "", primary_color: "",
  linked_shop_id: null as string | null,
  wildcard_shops_enabled: false,
  hidden_pages: DEFAULT_HIDDEN_PAGES as string[],
}
```

- [ ] **Step 2: `openEdit` and `handleSave`**

Change:

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
      hidden_pages: row.hidden_pages,
    })
    setDialogOpen(true)
  }
```

to:

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
      wildcard_shops_enabled: row.wildcard_shops_enabled,
      hidden_pages: row.hidden_pages,
    })
    setDialogOpen(true)
  }
```

In `handleSave`, add `wildcard_shops_enabled: form.wildcard_shops_enabled,` to BOTH the PATCH body and the POST body object literals (alongside the existing `linked_shop_id: form.linked_shop_id,` line in each).

- [ ] **Step 3: The "Link to Shop" dropdown becomes mutually exclusive with the new checkbox**

Change:

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
                  {form.linked_shop_id && form.domain && (() => {
                    const linkedShop = shops.find(s => s.id === form.linked_shop_id)
                    if (!linkedShop) return null
                    const shopHostname = `${linkedShop.subdomain}.${form.domain}`
                    return (
                      <p className="text-xs text-muted-foreground">
                        This shop&apos;s own shareable URL will become <code className="font-mono">{shopHostname}</code>. Ask the domain owner to also point that exact hostname at Vercel (a DNS record, same as the root domain above — not a wildcard), then attach <code className="font-mono">{shopHostname}</code> under your Vercel project&apos;s Settings → Domains.
                      </p>
                    )
                  })()}
                </div>
```

to:

```tsx
                <div className="space-y-2">
                  <Label>Link to Shop (optional)</Label>
                  <select
                    value={form.linked_shop_id ?? ""}
                    onChange={e => setForm(f => ({
                      ...f,
                      linked_shop_id: e.target.value || null,
                      wildcard_shops_enabled: e.target.value ? false : f.wildcard_shops_enabled,
                    }))}
                    disabled={form.wildcard_shops_enabled}
                    className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
                  >
                    <option value="">— None (dashboard mode) —</option>
                    {shops.map(s => (
                      <option key={s.id} value={s.id}>{s.shop_name} ({s.subdomain})</option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    Linking a shop makes this domain show that shop&apos;s storefront (guest checkout) instead of the dashboard. Services above then filter which of the shop&apos;s Buy Data/Airtime/Results Vouchers tabs show.
                  </p>
                  {form.linked_shop_id && form.domain && (() => {
                    const linkedShop = shops.find(s => s.id === form.linked_shop_id)
                    if (!linkedShop) return null
                    const shopHostname = `${linkedShop.subdomain}.${form.domain}`
                    return (
                      <p className="text-xs text-muted-foreground">
                        This shop&apos;s own shareable URL will become <code className="font-mono">{shopHostname}</code>. Ask the domain owner to also point that exact hostname at Vercel (a DNS record, same as the root domain above — not a wildcard), then attach <code className="font-mono">{shopHostname}</code> under your Vercel project&apos;s Settings → Domains.
                      </p>
                    )
                  })()}
                </div>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={form.wildcard_shops_enabled}
                      disabled={!!form.linked_shop_id}
                      onCheckedChange={(checked) => setForm(f => ({
                        ...f,
                        wildcard_shops_enabled: !!checked,
                        linked_shop_id: checked ? null : f.linked_shop_id,
                      }))}
                    />
                    Enable wildcard mode — any active shop can use {form.domain || "this domain"} as an alternate URL
                  </label>
                  {form.wildcard_shops_enabled && (
                    <p className="text-xs text-muted-foreground">
                      Every active shop automatically gets its own subdomain here (e.g. <code className="font-mono">kofi.{form.domain || "yourdomain.com"}</code>, <code className="font-mono">ama.{form.domain || "yourdomain.com"}</code>) — no per-shop setup needed. Ask the domain owner to add a WILDCARD DNS record instead of one exact hostname: a CNAME, host <code className="font-mono">*</code>, pointing at <code className="font-mono">cname.vercel-dns.com.</code> — then attach <code className="font-mono">*.{form.domain || "yourdomain.com"}</code> under your Vercel project&apos;s Settings → Domains.
                    </p>
                  )}
                </div>
```

- [ ] **Step 4: Table badge**

Change:

```tsx
                      <TableCell className="space-x-1">
                        {row.linked_shop_id ? (
                          <Badge>{shops.find(s => s.id === row.linked_shop_id)?.shop_name || "Linked Shop"}</Badge>
                        ) : (
                          row.services.map(s => <Badge key={s} variant="outline">{SERVICE_LABELS[s]}</Badge>)
                        )}
                      </TableCell>
```

to:

```tsx
                      <TableCell className="space-x-1">
                        {row.wildcard_shops_enabled ? (
                          <Badge variant="secondary">Wildcard — any shop</Badge>
                        ) : row.linked_shop_id ? (
                          <Badge>{shops.find(s => s.id === row.linked_shop_id)?.shop_name || "Linked Shop"}</Badge>
                        ) : (
                          row.services.map(s => <Badge key={s} variant="outline">{SERVICE_LABELS[s]}</Badge>)
                        )}
                      </TableCell>
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Manual verification**

Start the dev server, open `/admin/custom-domains`, and confirm by hand:
- Checking the new wildcard checkbox clears and disables the "Link to Shop" dropdown.
- Picking a shop in the dropdown clears and disables the wildcard checkbox.
- The DNS-instruction text switches between the single-hostname form and the wildcard form as the checkbox toggles.
- A saved wildcard-enabled domain shows the "Wildcard — any shop" badge in the table instead of a service list or a linked-shop name.

- [ ] **Step 7: Commit**

```bash
git add app/admin/custom-domains/page.tsx
git commit -m "feat(custom-domains): add wildcard-mode checkbox, mutually exclusive with Link to Shop"
```
