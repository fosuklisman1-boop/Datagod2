# Shop Custom-Domain Subdomain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a custom domain is linked to a shop, that shop's own canonical/shareable URL becomes a subdomain of that custom domain (e.g. `https://theirshop.clingshub.com`), and that subdomain actually resolves to the shop's storefront.

**Architecture:** A new reverse lookup (`shopService.getLinkedCustomDomain(subdomain)`) answers "is this shop linked to an active custom domain?", keyed by the shop's own already-unique `subdomain` (never the internal `id`, which anonymous storefront visitors can't read). It's wired into both of the shop data layer's read paths (`getShop`, `getShopBySlug`) plus one dashboard page that bypasses them. `shopOrigin()` grows an optional second parameter to use it. Separately, `middleware.ts`'s domain resolver gains one more fallback — tried only after today's exact-host lookup misses — that recognizes `<linked shop's own subdomain>.<a registered, shop-linked domain>` as a hit for that same domain's config, so the new URL isn't just displayed correctly but actually routes.

**Tech Stack:** Next.js 15, TypeScript, Supabase (browser client + Postgres), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-02-shop-custom-domain-subdomain-design.md`

## Global Constraints

- Only the single shop a custom domain is already linked to (`custom_domains.linked_shop_id`) gets a domain-specific URL — no wildcard DNS, no change to `user_shops.subdomain`'s generation or global uniqueness.
- The URL is `<shop's own existing subdomain>.<the custom domain>` — never an admin-typed label, never the bare domain alone.
- A shop linked to more than one active domain picks the oldest linkage (`order by created_at ascending`, first result) — deterministic, not arbitrary.
- Every new lookup fails open: any query error, no match, or an inactive/unlinked domain all fall back to today's `<subdomain>.datagod.store` behavior — never throws, never breaks a page that's merely displaying a URL.
- No new caching layer for the shop-service-side reverse lookup (low-frequency, a shop owner's own dashboard load) — the existing Redis cache in `lib/custom-domain-lookup.ts` already covers the middleware-side lookup, keyed naturally by the exact subdomain host string.
- No automated test for `middleware.ts`, `app/admin/custom-domains/page.tsx`, or any of the 5 dashboard/storefront pages touched in Task 3 (established codebase convention) — verified via `npx tsc --noEmit` and manual/live checks instead.

## Review Focus

- A shop not linked to any domain must get `null` back from the new lookup, not a throw or a stale previous result — Task 1's tests cover this.
- A shop linked to a domain that's since been deactivated must be excluded by the `is_active = true` filter and fall back to the default URL — Task 1's tests cover this.
- A shop linked to more than one active domain must deterministically return the oldest linkage, not whichever row the query happens to return first — Task 1's tests cover this.
- Middleware's new subdomain fallback must NOT match when the stripped label is merely similar to, but not exactly, the linked shop's own subdomain (a typo, or a different shop's subdomain reused by coincidence) — granting access to the wrong shop's storefront under someone else's domain would be a real security-relevant mix-up, not just a cosmetic bug. Task 4's tests cover this.
- The new fallback must never fire when the exact-host lookup (or its existing www-toggle retry) already resolved the request — Task 4's tests include a regression case proving the pre-existing bare-domain and www-toggle behaviors are undisturbed.

---

### Task 1: `lib/shop-service.ts` — the reverse lookup

**Files:**
- Modify: `lib/shop-service.ts`
- Test: `lib/shop-service.test.ts` (new file)

**Interfaces:**
- Consumes: the existing `supabase` browser client (already imported in this file), `shopHandleOrFilter` (already imported).
- Produces: `shopService.getLinkedCustomDomain(subdomain: string): Promise<string | null>`. `shopService.getShop(userId)`'s return value and `PublicShop` (from `shopService.getShopBySlug`) both gain a `linked_custom_domain: string | null` field. Consumed by Task 2 (indirectly, via Task 3's call sites) and Task 3 directly.

- [ ] **Step 1: Write the failing tests**

Create `lib/shop-service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const selectMock = vi.fn()
const eqMock = vi.fn()
const notMock = vi.fn()
const orderMock = vi.fn()
const fromMock = vi.fn()

vi.mock("./supabase", () => ({
  supabase: { from: (...args: unknown[]) => fromMock(...args) },
}))

beforeEach(() => {
  vi.clearAllMocks()
  // Chainable builder: .from().select().eq().not().order() -> the final
  // awaited value. Each link returns `builder` except the terminal one,
  // which resolves via `builder.then` so `await builder` works directly
  // (matching how getLinkedCustomDomain will call it, with no `.single()`
  // or `.maybeSingle()` at the end — it needs the full row list to apply
  // the oldest-wins tie-break in application code).
})

function makeBuilder(result: { data: unknown; error: unknown }) {
  const builder: any = {
    select: selectMock.mockImplementation(() => builder),
    eq: eqMock.mockImplementation(() => builder),
    not: notMock.mockImplementation(() => builder),
    order: orderMock.mockImplementation(() => builder),
    then: (resolve: (v: typeof result) => void) => resolve(result),
  }
  return builder
}

describe("shopService.getLinkedCustomDomain", () => {
  it("returns null when the shop has no linked domain", async () => {
    fromMock.mockReturnValue(makeBuilder({ data: [], error: null }))
    const { shopService } = await import("./shop-service")

    const result = await shopService.getLinkedCustomDomain("my-shop")

    expect(result).toBeNull()
  })

  it("returns the domain when exactly one active row links a shop with this subdomain", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: [{ domain: "clingshub.com", created_at: "2026-09-01", linked_shop: { subdomain: "my-shop" } }],
      error: null,
    }))
    const { shopService } = await import("./shop-service")

    const result = await shopService.getLinkedCustomDomain("my-shop")

    expect(result).toBe("clingshub.com")
  })

  it("ignores rows linked to a DIFFERENT shop's subdomain", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: [{ domain: "otherbrand.com", created_at: "2026-09-01", linked_shop: { subdomain: "someone-else" } }],
      error: null,
    }))
    const { shopService } = await import("./shop-service")

    const result = await shopService.getLinkedCustomDomain("my-shop")

    expect(result).toBeNull()
  })

  it("picks the oldest linkage when more than one active domain links the same shop", async () => {
    fromMock.mockReturnValue(makeBuilder({
      data: [
        { domain: "newer.com", created_at: "2026-09-15", linked_shop: { subdomain: "my-shop" } },
        { domain: "older.com", created_at: "2026-08-01", linked_shop: { subdomain: "my-shop" } },
      ],
      error: null,
    }))
    const { shopService } = await import("./shop-service")

    const result = await shopService.getLinkedCustomDomain("my-shop")

    expect(result).toBe("older.com")
  })

  it("fails open to null on a query error", async () => {
    fromMock.mockReturnValue(makeBuilder({ data: null, error: { message: "db down" } }))
    const { shopService } = await import("./shop-service")

    const result = await shopService.getLinkedCustomDomain("my-shop")

    expect(result).toBeNull()
  })

  it("filters to active, shop-linked rows only — a deactivated domain's linkage must never surface even if the row is somehow still returned", async () => {
    // The mock can't simulate real Postgres-side filtering, so this proves
    // the query is actually CONSTRUCTED with the is_active/linked_shop_id
    // filters this function depends on entirely (there's no JS-side
    // is_active re-check — the query is the only thing excluding a
    // deactivated domain's row). A regression that silently drops either
    // .eq("is_active", true) or .not("linked_shop_id", "is", null) from the
    // implementation would pass every other test in this file but fail
    // this one.
    fromMock.mockReturnValue(makeBuilder({ data: [], error: null }))
    const { shopService } = await import("./shop-service")

    await shopService.getLinkedCustomDomain("my-shop")

    expect(eqMock).toHaveBeenCalledWith("is_active", true)
    expect(notMock).toHaveBeenCalledWith("linked_shop_id", "is", null)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/shop-service.test.ts`
Expected: FAIL — `shopService.getLinkedCustomDomain is not a function` (it doesn't exist yet).

- [ ] **Step 3: Implement `getLinkedCustomDomain`**

In `lib/shop-service.ts`, add this new method to the `shopService` object (place it right after `getShopBySlug`, before the `// Update shop` comment):

```ts
  // Reverse lookup: is this shop (identified by its own, already-globally-
  // unique subdomain — never its internal id, which anonymous storefront
  // visitors can't read under RLS) linked to an active custom domain?
  // Keyed by subdomain rather than id so this one function serves both
  // getShop (an authenticated owner's own dashboard) and getShopBySlug (a
  // fully anonymous storefront visitor) identically. Fetches every
  // active, shop-linked custom_domains row rather than filtering in SQL,
  // since this table is small (admin-managed, not a hot dataset) and a
  // plain equality filter on the embedded relation isn't reliably
  // supported by the query builder for a reverse one-to-many embed.
  // Fails open to null on any error or no match — a shop's displayed URL
  // must never break just because this lookup had a bad day.
  async getLinkedCustomDomain(subdomain: string): Promise<string | null> {
    const { data, error } = await supabase
      .from("custom_domains")
      .select("domain, created_at, linked_shop:user_shops!linked_shop_id(subdomain)")
      .eq("is_active", true)
      .not("linked_shop_id", "is", null)
      .order("created_at", { ascending: true })

    if (error) {
      console.error("[SHOP-SERVICE] Failed to resolve linked custom domain:", error)
      return null
    }
    const rows = (data ?? []) as unknown as Array<{ domain: string; linked_shop: { subdomain: string } | null }>
    const match = rows.find(row => row.linked_shop?.subdomain === subdomain)
    return match?.domain ?? null
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/shop-service.test.ts`
Expected: PASS (6/6)

- [ ] **Step 5: Wire it into `getShop` and `getShopBySlug`**

Replace (currently):

```ts
  // Get user's shop
  async getShop(userId: string) {
    const { data, error } = await supabase
      .from("user_shops")
      .select("*")
      .eq("user_id", userId)
      .single()

    if (error && error.code !== "PGRST116") throw error
    return data
  },
```

with:

```ts
  // Get user's shop
  async getShop(userId: string) {
    const { data, error } = await supabase
      .from("user_shops")
      .select("*")
      .eq("user_id", userId)
      .single()

    if (error && error.code !== "PGRST116") throw error
    if (!data) return data

    const linked_custom_domain = await shopService.getLinkedCustomDomain(data.subdomain)
    return { ...data, linked_custom_domain }
  },
```

Replace (currently):

```ts
  async getShopBySlug(slug: string): Promise<PublicShop | null> {
    const { data, error } = await supabase
      .from("user_shops")
      .select("shop_name, shop_slug, subdomain, description, logo_url, banner_url, is_active, is_blocked, parent_shop_id, airtime_markup_mtn, airtime_markup_telecel, airtime_markup_at, results_checker_markup_wassce, results_checker_markup_bece, results_checker_markup_novdec, results_check_markup, afa_price, custom_color, custom_color_2, section_divider_style, created_at")
      .or(shopHandleOrFilter(slug))
      .eq("is_active", true)
      .single()

    if (error && error.code !== "PGRST116") throw error
    return (data as unknown as PublicShop) ?? null
  },
```

with:

```ts
  async getShopBySlug(slug: string): Promise<PublicShop | null> {
    const { data, error } = await supabase
      .from("user_shops")
      .select("shop_name, shop_slug, subdomain, description, logo_url, banner_url, is_active, is_blocked, parent_shop_id, airtime_markup_mtn, airtime_markup_telecel, airtime_markup_at, results_checker_markup_wassce, results_checker_markup_bece, results_checker_markup_novdec, results_check_markup, afa_price, custom_color, custom_color_2, section_divider_style, created_at")
      .or(shopHandleOrFilter(slug))
      .eq("is_active", true)
      .single()

    if (error && error.code !== "PGRST116") throw error
    if (!data) return null

    const shop = data as unknown as PublicShop
    const linked_custom_domain = await shopService.getLinkedCustomDomain(shop.subdomain)
    return { ...shop, linked_custom_domain }
  },
```

- [ ] **Step 6: Extend the `PublicShop` interface**

Replace (currently):

```ts
export interface PublicShop {
  shop_name: string
  shop_slug: string
  subdomain: string
  description: string | null
  logo_url: string | null
  banner_url: string | null
  is_active: boolean
  is_blocked: boolean
  parent_shop_id: string | null
  airtime_markup_mtn: number | null
  airtime_markup_telecel: number | null
  airtime_markup_at: number | null
  results_checker_markup_wassce: number | null
  results_checker_markup_bece: number | null
  results_checker_markup_novdec: number | null
  results_check_markup: number | null
  afa_price: number | null
  custom_color: string | null
  custom_color_2: string | null
  section_divider_style: string | null
  created_at: string
}
```

with (adds exactly one field, `linked_custom_domain`, at the end):

```ts
export interface PublicShop {
  shop_name: string
  shop_slug: string
  subdomain: string
  description: string | null
  logo_url: string | null
  banner_url: string | null
  is_active: boolean
  is_blocked: boolean
  parent_shop_id: string | null
  airtime_markup_mtn: number | null
  airtime_markup_telecel: number | null
  airtime_markup_at: number | null
  results_checker_markup_wassce: number | null
  results_checker_markup_bece: number | null
  results_checker_markup_novdec: number | null
  results_check_markup: number | null
  afa_price: number | null
  custom_color: string | null
  custom_color_2: string | null
  section_divider_style: string | null
  created_at: string
  linked_custom_domain: string | null
}
```

- [ ] **Step 7: Typecheck and run the whole file's tests once more**

Run: `npx tsc --noEmit`
Expected: No errors referencing `lib/shop-service.ts`. (Errors will exist in the 5 files Task 3 hasn't touched yet — `shopOrigin` still only takes one argument there until Task 2/3 land; that's expected at this point.)

Run: `npx vitest run lib/shop-service.test.ts`
Expected: PASS (6/6), output pristine.

- [ ] **Step 8: Commit**

```bash
git add lib/shop-service.ts lib/shop-service.test.ts
git commit -m "feat(shop): add the shop-to-linked-custom-domain reverse lookup"
```

---

### Task 2: `lib/shop-url.ts` — `shopOrigin` becomes domain-aware

**Files:**
- Modify: `lib/shop-url.ts`
- Test: `lib/shop-url.test.ts` (new file)

**Interfaces:**
- Consumes: nothing from Task 1 directly (pure function, no imports needed).
- Produces: `shopOrigin(subdomain: string, linkedCustomDomain?: string | null): string`. Consumed by Task 3's 10 call sites.

- [ ] **Step 1: Write the failing tests**

Create `lib/shop-url.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { shopOrigin } from "./shop-url"

describe("shopOrigin", () => {
  it("builds the main-site URL when no linked domain is given", () => {
    expect(shopOrigin("my-shop")).toBe("https://my-shop.datagod.store")
  })

  it("builds the main-site URL when the linked domain is explicitly null", () => {
    expect(shopOrigin("my-shop", null)).toBe("https://my-shop.datagod.store")
  })

  it("builds the custom-domain subdomain URL when a linked domain is given", () => {
    expect(shopOrigin("my-shop", "clingshub.com")).toBe("https://my-shop.clingshub.com")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/shop-url.test.ts`
Expected: FAIL on the third test — `shopOrigin("my-shop", "clingshub.com")` currently returns `"https://my-shop.datagod.store"` (the second argument is silently ignored since the function doesn't accept one yet — this is a TypeScript excess-argument situation that vitest will still execute at runtime, so the test runs and its assertion fails).

- [ ] **Step 3: Implement the change**

Replace (currently):

```ts
// Builds the canonical external storefront URL for a shop, e.g.
// "https://my-shop.datagod.store". Use for share links, sitemap, and metadata.
export function shopOrigin(subdomain: string): string {
  return `https://${subdomain}.${ROOT_DOMAIN}`
}
```

with:

```ts
// Builds the canonical external storefront URL for a shop, e.g.
// "https://my-shop.datagod.store" — or, when this shop is linked to an
// active custom domain (shopService.getLinkedCustomDomain), a subdomain of
// that domain instead, e.g. "https://my-shop.clingshub.com". Use for share
// links, sitemap, and metadata.
export function shopOrigin(subdomain: string, linkedCustomDomain?: string | null): string {
  return `https://${subdomain}.${linkedCustomDomain || ROOT_DOMAIN}`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/shop-url.test.ts`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add lib/shop-url.ts lib/shop-url.test.ts
git commit -m "feat(shop): shopOrigin builds a custom-domain subdomain URL when linked"
```

---

### Task 3: Wire the new URL into all 10 call sites

**Files:**
- Modify: `app/shop/[slug]/page.tsx` (4 call sites)
- Modify: `app/dashboard/my-shop/page.tsx` (3 call sites)
- Modify: `app/dashboard/shop-profile/page.tsx` (1 call site)
- Modify: `app/dashboard/shop-pricing/page.tsx` (1 call site)
- Modify: `app/dashboard/customers/page.tsx` (1 call site, plus its own extra fetch — this file bypasses `shopService.getShop`)

**Interfaces:**
- Consumes: `shopOrigin(subdomain, linkedCustomDomain?)` (Task 2); `shop.linked_custom_domain` already present on the `shop` object in 4 of these 5 files, since `my-shop/page.tsx`, `shop-profile/page.tsx`, and `shop-pricing/page.tsx` already call `shopService.getShop(user.id)` (Task 1), and `app/shop/[slug]/page.tsx` already calls `shopService.getShopBySlug(slug)` (Task 1). `shopService.getLinkedCustomDomain(subdomain)` (Task 1), consumed directly only by `customers/page.tsx`, which fetches its `shop` state via its own direct Supabase query rather than `shopService.getShop`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: `app/shop/[slug]/page.tsx` — update its 4 call sites**

Re-read the file first to confirm these 4 lines still match (this file was touched by other work recently). Replace each exactly:

```ts
      href: shop.subdomain ? `${shopOrigin(shop.subdomain)}/afa` : `/shop/${shopSlug}/afa`,
```
→
```ts
      href: shop.subdomain ? `${shopOrigin(shop.subdomain, shop.linked_custom_domain)}/afa` : `/shop/${shopSlug}/afa`,
```

```ts
      onClick: () => { window.location.href = shop.subdomain ? `${shopOrigin(shop.subdomain)}/afa` : `/shop/${shopSlug}/afa` },
```
→
```ts
      onClick: () => { window.location.href = shop.subdomain ? `${shopOrigin(shop.subdomain, shop.linked_custom_domain)}/afa` : `/shop/${shopSlug}/afa` },
```

```ts
                item: shop?.subdomain ? shopOrigin(shop.subdomain) : `https://www.datagod.store/shop/${shopSlug}`,
```
→
```ts
                item: shop?.subdomain ? shopOrigin(shop.subdomain, shop?.linked_custom_domain) : `https://www.datagod.store/shop/${shopSlug}`,
```

```ts
                  shop?.subdomain ? shopOrigin(shop.subdomain) : `https://www.datagod.store/shop/${shopSlug}`,
```
→
```ts
                  shop?.subdomain ? shopOrigin(shop.subdomain, shop?.linked_custom_domain) : `https://www.datagod.store/shop/${shopSlug}`,
```

(The last two lines are textually identical to each other except indentation — if your editor's find-and-replace matches both at once, that's fine; both need the identical change.)

- [ ] **Step 2: `app/dashboard/my-shop/page.tsx` — update its 3 call sites**

Re-read the file first to confirm. Replace each exactly:

```ts
    const link = shop.subdomain ? shopOrigin(shop.subdomain) : `${window.location.origin}/shop/${shop.shop_slug}`
```
→
```ts
    const link = shop.subdomain ? shopOrigin(shop.subdomain, shop.linked_custom_domain) : `${window.location.origin}/shop/${shop.shop_slug}`
```

```ts
  const storefrontHref = shop.subdomain ? shopOrigin(shop.subdomain) : `/shop/${shop.shop_slug}`
```
→
```ts
  const storefrontHref = shop.subdomain ? shopOrigin(shop.subdomain, shop.linked_custom_domain) : `/shop/${shop.shop_slug}`
```

```ts
              {shop.subdomain ? shopOrigin(shop.subdomain) : `${typeof window !== "undefined" ? window.location.origin : ""}/shop/${shop.shop_slug}`}
```
→
```ts
              {shop.subdomain ? shopOrigin(shop.subdomain, shop.linked_custom_domain) : `${typeof window !== "undefined" ? window.location.origin : ""}/shop/${shop.shop_slug}`}
```

- [ ] **Step 3: `app/dashboard/shop-profile/page.tsx` — update its 1 call site**

Re-read the file first to confirm. Replace:

```ts
                  {shop.subdomain ? shopOrigin(shop.subdomain) : `datagod.store/shop/${shop.shop_slug}`}
```
with:

```ts
                  {shop.subdomain ? shopOrigin(shop.subdomain, shop.linked_custom_domain) : `datagod.store/shop/${shop.shop_slug}`}
```

- [ ] **Step 4: `app/dashboard/shop-pricing/page.tsx` — update its 1 call site**

Re-read the file first to confirm. Replace:

```ts
  const shopLink = shop ? (shop.subdomain ? shopOrigin(shop.subdomain) : `${typeof window !== "undefined" ? window.location.origin : ""}/shop/${shop.shop_slug}`) : ""
```
with:

```ts
  const shopLink = shop ? (shop.subdomain ? shopOrigin(shop.subdomain, shop.linked_custom_domain) : `${typeof window !== "undefined" ? window.location.origin : ""}/shop/${shop.shop_slug}`) : ""
```

- [ ] **Step 5: `app/dashboard/customers/page.tsx` — fetch the linked domain explicitly, then update its 1 call site**

This file does NOT call `shopService.getShop` — it queries `user_shops` directly, so it never gets `linked_custom_domain` for free the way the other 3 dashboard pages do. Re-read the file first to confirm this still matches (around line 66-67):

```ts
      const { data: shopRow } = await supabase.from("user_shops").select("*").eq("user_id", user!.id).maybeSingle()
      setShop(shopRow)
```

Replace with:

```ts
      const { data: shopRow } = await supabase.from("user_shops").select("*").eq("user_id", user!.id).maybeSingle()
      const linkedCustomDomain = shopRow ? await shopService.getLinkedCustomDomain(shopRow.subdomain) : null
      setShop(shopRow ? { ...shopRow, linked_custom_domain: linkedCustomDomain } : shopRow)
```

Confirm `shopService` is already imported at the top of this file (it is, since `shopHandleOrFilter`-style helpers and other shop utilities are already in use elsewhere in this codebase's dashboard pages) — if the import is missing, add it: `import { shopService } from "@/lib/shop-service"`.

Then replace the call site (currently):

```ts
  const shopLink = shop ? (shop.subdomain ? shopOrigin(shop.subdomain) : `${typeof window !== "undefined" ? window.location.origin : ""}/shop/${shop.shop_slug}`) : ""
```
with:

```ts
  const shopLink = shop ? (shop.subdomain ? shopOrigin(shop.subdomain, shop.linked_custom_domain) : `${typeof window !== "undefined" ? window.location.origin : ""}/shop/${shop.shop_slug}`) : ""
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: Zero errors project-wide. This is the last task touching files with a pending reference to `shopOrigin`'s old single-argument shape.

- [ ] **Step 7: Manual verification**

No automated test exists for any of these 5 files (confirmed convention). Confirm by reading: every call site now passes a second argument sourced from the same `shop` object already in scope at that point — none of them introduce a new fetch except `customers/page.tsx`'s explicit one. Start the dev server if you're able to and confirm `shop.linked_custom_domain` logs as `null` for every existing shop today (since no shop is currently linked to `clingshub.com` — it has `linked_shop_id: null` as of this plan's writing), meaning every one of these 10 call sites still produces the exact same `<subdomain>.datagod.store` URL as before. This is the true no-op check for this task.

- [ ] **Step 8: Commit**

```bash
git add "app/shop/[slug]/page.tsx" app/dashboard/my-shop/page.tsx app/dashboard/shop-profile/page.tsx app/dashboard/shop-pricing/page.tsx app/dashboard/customers/page.tsx
git commit -m "feat(shop): thread the linked custom domain into every shopOrigin call site"
```

---

### Task 4: `lib/custom-domain-lookup.ts` — resolve the new subdomain

**Files:**
- Modify: `lib/custom-domain-lookup.ts`
- Test: `lib/custom-domain-lookup.test.ts`

**Interfaces:**
- Consumes: `lookupExact(host)` (existing, private to this file), `CustomDomainConfig.linked_shop_subdomain` (existing field).
- Produces: `resolveCustomDomain(host)`'s behavior is extended, same signature. Consumed by `middleware.ts` (already calls it, no change needed there).

- [ ] **Step 1: Write the failing tests**

Add to `lib/custom-domain-lookup.test.ts`, inside the `describe("resolveCustomDomain", ...)` block (after the existing `"maps a null linked_shop join to a null linked_shop_subdomain"` test, before its closing `})`):

```ts
  it("resolves <linked shop's own subdomain>.<a registered, shop-linked domain> to that domain's config", async () => {
    redisGetMock.mockResolvedValue(null) // no cache hit for any host form tried
    maybeSingleMock
      .mockResolvedValueOnce({ data: null, error: null }) // miss for "theirshop.clingshub.com" itself
      .mockResolvedValueOnce({ data: null, error: null }) // miss for its www-toggled form
      .mockResolvedValueOnce({ data: { ...sampleRawRow, domain: "clingshub.com", linked_shop: { subdomain: "theirshop" } }, error: null }) // hit for the stripped remainder "clingshub.com"
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("theirshop.clingshub.com")

    expect(result?.domain).toBe("clingshub.com")
    expect(result?.linked_shop_subdomain).toBe("theirshop")
  })

  it("does NOT resolve a subdomain whose label doesn't match the linked shop's own subdomain", async () => {
    redisGetMock.mockResolvedValue(null)
    maybeSingleMock
      .mockResolvedValueOnce({ data: null, error: null }) // miss for "wrongshop.clingshub.com"
      .mockResolvedValueOnce({ data: null, error: null }) // miss for its www-toggled form
      .mockResolvedValueOnce({ data: { ...sampleRawRow, domain: "clingshub.com", linked_shop: { subdomain: "theirshop" } }, error: null }) // "clingshub.com" IS shop-linked, but to a DIFFERENT subdomain
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("wrongshop.clingshub.com")

    expect(result).toBeNull()
  })

  it("still resolves a bare registered custom domain directly, undisturbed by the new subdomain fallback", async () => {
    redisGetMock.mockResolvedValueOnce(null)
    maybeSingleMock.mockResolvedValueOnce({ data: sampleRawRow, error: null }) // exact hit on "checkresults.com" itself — no further lookups should happen
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("checkresults.com")

    expect(result).toEqual(sampleConfig)
    expect(maybeSingleMock).toHaveBeenCalledTimes(1)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/custom-domain-lookup.test.ts`
Expected: the first new test FAILs (`result` is `null` instead of the expected config) — the fallback doesn't exist yet. The second and third new tests PASS already (there's nothing yet that could wrongly match them) — this is fine; TDD's "watch it fail" requirement is satisfied by the first test, which is the one actually exercising new behavior.

- [ ] **Step 3: Implement the fallback**

Replace (currently):

```ts
export async function resolveCustomDomain(host: string): Promise<CustomDomainConfig | null> {
  const primary = await lookupExact(host)
  if (primary.kind === "found") return primary.config
  if (primary.kind === "error") return null
  if (primary.fromNegativeCache) return null // already conclusively resolved for both forms previously

  // Primary form definitively has no active row (a fresh, non-error miss) —
  // try the www-toggled variant before concluding this host has no custom domain.
  const altHost = toggleWwwVariant(host)
  const alt = await lookupExact(altHost)
  if (alt.kind === "found") {
    // Mirror the hit under the originally-requested host's own cache key too,
    // so a repeat request in this exact form is a straight cache hit next time.
    cacheSetPositive(host, alt.config)
    return alt.config
  }

  // Both forms are either genuinely absent or unreachable — negative-cache only
  // the forms we're actually sure about (an "error" outcome is never cached).
  if (alt.kind === "not_found") cacheSetNegative(altHost)
  cacheSetNegative(host)
  return null
}
```

with:

```ts
export async function resolveCustomDomain(host: string): Promise<CustomDomainConfig | null> {
  const primary = await lookupExact(host)
  if (primary.kind === "found") return primary.config
  if (primary.kind === "error") return null
  if (primary.fromNegativeCache) return null // already conclusively resolved for both forms previously

  // Primary form definitively has no active row (a fresh, non-error miss) —
  // try the www-toggled variant before concluding this host has no custom domain.
  const altHost = toggleWwwVariant(host)
  const alt = await lookupExact(altHost)
  if (alt.kind === "found") {
    // Mirror the hit under the originally-requested host's own cache key too,
    // so a repeat request in this exact form is a straight cache hit next time.
    cacheSetPositive(host, alt.config)
    return alt.config
  }

  // Neither the exact host nor its www-toggled variant matched directly. One
  // more possibility: host is <a shop's own subdomain>.<a registered,
  // shop-linked domain> — e.g. "theirshop.clingshub.com", where
  // "clingshub.com" is linked to a shop whose own subdomain is "theirshop".
  // Strip the first label and retry the lookup against the remainder; only
  // treat it as a hit if the remainder is itself an active, shop-linked
  // domain AND the stripped label exactly matches that linked shop's own
  // subdomain — anything else (a typo, an unrelated label, a domain that
  // isn't shop-linked at all) falls through to the ordinary not-found path
  // below, same as today.
  const firstDot = host.indexOf(".")
  if (firstDot > 0) {
    const label = host.slice(0, firstDot)
    const remainder = host.slice(firstDot + 1)
    const parent = await lookupExact(remainder)
    if (parent.kind === "found" && parent.config.linked_shop_subdomain === label) {
      cacheSetPositive(host, parent.config)
      return parent.config
    }
  }

  // Both forms are either genuinely absent or unreachable — negative-cache only
  // the forms we're actually sure about (an "error" outcome is never cached).
  if (alt.kind === "not_found") cacheSetNegative(altHost)
  cacheSetNegative(host)
  return null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/custom-domain-lookup.test.ts`
Expected: PASS (all tests in the file, including the 3 new ones and every pre-existing one).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `lib/custom-domain-lookup.ts`.

- [ ] **Step 6: Commit**

```bash
git add lib/custom-domain-lookup.ts lib/custom-domain-lookup.test.ts
git commit -m "feat(custom-domains): resolve <linked shop's subdomain>.<domain> to the linked domain's config"
```

---

### Task 5: Admin UI — surface the DNS instruction

**Files:**
- Modify: `app/admin/custom-domains/page.tsx`

**Interfaces:**
- Consumes: the `shops: ShopOption[]` list already loaded by this page's existing `loadShops()` (each entry already has `subdomain`), `form.linked_shop_id` and `form.domain` (existing form state).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the derived instruction line**

Re-read the file first to confirm the current structure around the "Link to Shop" field still matches (find the `<Label>Link to Shop (optional)</Label>` block). The current block reads:

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

Replace it with (adds one more conditional paragraph after the existing one, computing the exact subdomain hostname from whichever shop is currently selected and the domain field's current value):

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

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/admin/custom-domains/page.tsx`.

- [ ] **Step 3: Manual verification**

No automated test exists for this page (matches convention). Start the dev server, log in as admin, navigate to `/admin/custom-domains`, open "Add Domain" (or edit an existing row), type a domain, and pick a shop from the "Link to Shop" dropdown — confirm the new instruction line appears showing `<that shop's subdomain>.<the typed domain>` and disappears again if you clear either field.

- [ ] **Step 4: Commit**

```bash
git add app/admin/custom-domains/page.tsx
git commit -m "feat(custom-domains): show the exact subdomain hostname once a shop is linked"
```

---

### Task 6: End-to-end verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: the full feature (Tasks 1-5).
- Produces: nothing — final integration gate.

- [ ] **Step 1: Full suite + typecheck**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: every test passes except the same pre-existing, unrelated 9 failures in `lib/order-health-service.test.ts` that have been the established baseline all session; typecheck clean project-wide.

- [ ] **Step 2: Live check — confirm the no-op for every domain today**

No custom domain currently has a `linked_shop_id` set (confirmed at this plan's writing — `clingshub.com`'s `linked_shop_id` is `null`). Curl-check the live main site and `clingshub.com` after deploy and confirm both behave exactly as before — this feature's entire new code path is unreachable until an admin actually links a shop to a domain.

```bash
curl -s -o /dev/null -w "%{http_code}\n" -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "https://www.datagod.store/dashboard"
```

Expected: same result as before this feature (a redirect to login, unchanged).

- [ ] **Step 3: Live check — link a real shop and confirm the subdomain actually works**

Using the live admin UI on `clingshub.com` (or whichever test domain is appropriate), link an existing, real, active shop. Confirm the new instruction line shows the exact hostname. Separately (this is the one step that needs real-world DNS/Vercel cooperation and may need to be scheduled rather than done immediately): once that hostname is actually attached (DNS + Vercel, manual, outside this codebase), visit it and confirm it serves the linked shop's storefront, and that the shop owner's own dashboard (`/dashboard/my-shop`) now displays that subdomain as the shop's shareable link instead of `<subdomain>.datagod.store`.

- [ ] **Step 4: Restore test state**

Unlink the test shop from the test domain afterward (set "Link to Shop" back to "— None —") so the live configuration is left exactly as it was before this verification step, unless the user wants to keep the link as a real, intentional configuration.
