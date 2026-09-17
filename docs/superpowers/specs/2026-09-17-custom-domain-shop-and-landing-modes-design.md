# Custom Domain Shop-Link + Landing-Page Toggles — Design

## Goal

Extend the existing custom-domains feature (`docs/superpowers/specs/2026-09-11-custom-domain-service-routing-design.md`, live on `main`) with three admin-configurable per-domain behaviors:

1. **Shop mode** — link a custom domain to an existing white-label shop (`user_shops`). Every request to that domain routes to that shop's storefront instead of the dashboard, exactly like a shop subdomain does today. Guest checkout is inherent (shops never require login), so this supersedes the standalone guest-purchase concept for any domain in this mode.
2. **`show_guest_purchase`** — for domains NOT in shop mode ("account mode"), toggles whether the existing global `GuestPurchaseButton` (an external link, e.g. to a WhatsApp ordering channel) appears on that domain's landing page.
3. **`show_landing_page`** — for account-mode domains, toggles whether `/` renders the marketing homepage at all; when off, `/` redirects straight to `/auth/login`.

Shop mode and the two account-mode toggles are mutually exclusive by construction: a domain is either shop-linked (mode 1) or it's an account-mode domain where 2 and 3 apply.

## Context

- `custom_domains` (migrations 0096, 0097) currently has `domain, services (text[]), site_name, logo_url, primary_color, is_active`. This spec adds three more columns to the same table — no new table.
- `middleware.ts` already resolves `customDomainConfig` via `resolveCustomDomain()` (`lib/custom-domain-lookup.ts`) and, for account-mode domains, redirects blocked-service paths via `getServiceRedirect()` (`lib/custom-domains.ts`). This spec adds two new branches ahead of that existing logic — shop-mode rewrite, then landing-page-hide redirect — both of which return/rewrite before the existing service-redirect code ever runs for a domain in either new mode.
- Shops already have a first-class subdomain rewrite: `getShopSubdomain()` in `middleware.ts` turns `<subdomain>.datagod.store/*` into an internal rewrite to `/shop/<subdomain>/*`. `user_shops.subdomain` (`migrations/0055_add_subdomain_to_user_shops.sql`) is `NOT NULL`, unique, auto-assigned by a DB trigger — always present, unlike the legacy `shop_slug`. This spec's shop-mode rewrite reuses the exact same `/shop/<handle>/*` target, using `subdomain` as the handle, so the entire downstream shop storefront (`app/shop/[slug]/page.tsx` and everything under it) works completely unmodified for routing purposes.
- `app/shop/[slug]/page.tsx`'s product area (lines ~894-929) has a 3-button sub-tab switcher: "Buy Data" (`activeTab: "products"`), "Buy Airtime" (`"airtime"`), "Results Vouchers" (`"vouchers"`) — mapping directly to `data_bundles`/`airtime`/`results_checker` from the existing `DomainService` union. `bulk_sms` has no shop equivalent. "Track Order" and "About Shop" tabs are not service-specific and stay visible unconditionally.
- `components/GuestPurchaseButton.tsx` is a global, admin-configured (via `support_settings`, a singleton table) external link — not an in-app checkout. Rendered twice in `app/page.tsx` (hero section, CTA section).
- `app/page.tsx` and `components/layout/sidebar.tsx`/`bottom-nav.tsx` already read branding via `useDomainBranding()` (`components/providers/domain-branding-provider.tsx`), whose `DomainBranding` interface currently carries `services, siteName, logoUrl, primaryColor`. This spec adds `showGuestPurchase`/`showLandingPage`/`linkedShopSubdomain` fields to that same context object, threaded the same way `services` already is (DB → `CustomDomainConfig` → middleware header → `app/layout.tsx` parse → context).

## Design

### 1. Migration — `migrations/0099_custom_domains_shop_and_landing.sql`

```sql
alter table custom_domains
  add column if not exists linked_shop_id uuid references user_shops(id) on delete set null,
  add column if not exists show_guest_purchase boolean not null default false,
  add column if not exists show_landing_page boolean not null default true;

create index if not exists idx_custom_domains_linked_shop_id on custom_domains(linked_shop_id);
```

No backfill needed — all three columns have safe defaults (`null`/`false`/`true`) matching "existing domains behave exactly as they do today" for every currently-configured row, including `clingshub.com`.

### 2. `lib/custom-domains.ts` — type + shop-mode path helper

`CustomDomainConfig` gains three fields. `linked_shop_subdomain` (not `linked_shop_id`) is what the config actually carries after lookup — the lookup query resolves the FK to the shop's `subdomain` at read time (see §3), so downstream code never needs a second query:

```ts
export interface CustomDomainConfig {
  domain: string
  services: DomainService[]
  site_name: string
  logo_url: string | null
  primary_color: string | null
  is_active: boolean
  linked_shop_subdomain: string | null   // non-null => shop mode
  show_guest_purchase: boolean
  show_landing_page: boolean
}
```

No new pure-logic functions are needed in this file — `getServiceRedirect`/`isPathAllowedForService` are untouched, since shop mode bypasses them entirely (see §4) and the two boolean toggles are plain passthrough flags, not routing logic.

### 3. `lib/custom-domain-lookup.ts` — join the linked shop's subdomain

The `select()` in `lookupExact()` changes from a flat column list to include the joined shop handle:

```ts
const { data, error } = await supabaseAdmin
  .from("custom_domains")
  .select("domain, services, site_name, logo_url, primary_color, is_active, show_guest_purchase, show_landing_page, linked_shop:user_shops!linked_shop_id(subdomain)")
  .eq("domain", host)
  .eq("is_active", true)
  .maybeSingle()
```

`data.linked_shop?.subdomain ?? null` becomes `linked_shop_subdomain` on the cached `CustomDomainConfig`. This keeps the shop handle always fresh (re-resolved on every cache miss, same 300s positive / 60s negative TTL as everything else already cached here) rather than denormalizing it onto `custom_domains` at write time, avoiding a staleness-on-shop-rename class of bug for a value that's cheap to join.

### 4. `middleware.ts` — two new branches ahead of the existing service-redirect

```ts
if (customDomainConfig) {
  if (customDomainConfig.linked_shop_subdomain) {
    const url = request.nextUrl.clone()
    url.pathname = `/shop/${customDomainConfig.linked_shop_subdomain}${path === "/" ? "" : path}`
    return NextResponse.rewrite(url)
  }

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

Shop mode is a **rewrite** (URL bar stays on the custom domain), matching the existing shop-subdomain behavior exactly — not a redirect. It applies to every path, not just `/`, so a deep link like `custom-domain.com/checkout` also lands correctly inside the shop. The `x-domain-*` branding headers (site name/logo/color) still get set as today for a shop-mode domain — the shop storefront page can use them the same way the dashboard pages do (see §6), even though its own `shop_name`/`logo_url` fields are the shop's real identity; branding headers only drive the sub-tab service filter here, not a second re-skin of the shop.

### 5. `components/providers/domain-branding-provider.tsx` + `app/layout.tsx` — thread the new fields

`DomainBranding` gains `showGuestPurchase: boolean`, `showLandingPage: boolean` (both default `true`/`false` respectively in `DEFAULT_BRANDING` to match "no restriction" on the main site — irrelevant there since `services` being `null` already short-circuits every consumer). `linkedShopSubdomain` is **not** threaded into `DomainBranding` — once middleware has rewritten to `/shop/<subdomain>/*`, the shop page's own existing data-fetching (by slug from the URL) is the source of truth; the branding context doesn't need to carry it.

`app/layout.tsx` reads two new headers, `x-domain-guest-purchase` and `x-domain-landing-page` (each `"1"`/`"0"`, set by middleware alongside the existing four), parsed as booleans with the same safe-default-on-missing behavior as `services`.

### 6. `app/page.tsx` — gate `GuestPurchaseButton`

Both existing occurrences:

```tsx
{(!domainBranding.services || domainBranding.showGuestPurchase) && (
  <GuestPurchaseButton variant="outline" className="w-full sm:w-auto" />
)}
```

No-op for the main site (`services` is `null` there) and for any domain with the landing page hidden (that request never reaches this component — middleware redirected before render).

### 7. `app/shop/[slug]/page.tsx` — gate the 3-button service sub-switcher

Reads `useDomainBranding()`. When `domainBranding.services` is set (this request arrived via a shop-linked custom domain), the sub-tab switcher (lines ~898-929) only renders the buttons whose service is in that array — `"products"` for `data_bundles`, `"airtime"` for `airtime`, `"vouchers"` for `results_checker` — and `activeTab`'s initial value defaults to the first allowed one instead of always `"products"` (a domain that selected only `airtime` shouldn't default into an empty/hidden Products tab). When `domainBranding.services` is `null` (today's subdomain/path access, unaffected), every button shows exactly as now. "Track Order" and "About Shop" (the two other top-level `tabs`) are untouched — not service-gated.

Edge case: a shop-linked domain whose `services` selection maps to none of the three shop tabs (only meaningful value today: `["bulk_sms"]` alone, since Bulk SMS has no shop equivalent) would otherwise render zero buttons and no valid `activeTab` at all. Fail open in that case — show all three tabs, same as `services: null` — rather than render a broken, button-less Products area. This mirrors this feature's existing fail-open philosophy (an unusable restriction is treated as no restriction, not as a dead end).

## Error handling

- A `linked_shop_id` whose shop was deleted: `on delete set null` means the domain silently falls back to account mode rather than rewriting to a 404'd shop — the domain still renders (marketing homepage or service dashboard, per its other settings), just no longer shop-linked. No special-cased error page.
- Admin API validation (`app/api/admin/custom-domains/route.ts`): `linked_shop_id`, if provided, must reference an existing row in `user_shops` (checked via a lookup before insert/update, mirroring the existing reserved-domain check's "validate before writing" pattern) — reject with 400 rather than relying on the FK constraint to surface a raw Postgres error.

## Testing

- `lib/custom-domain-lookup.test.ts`: extend the existing mock query-builder to return a joined `linked_shop` object on a hit; add a case confirming `linked_shop_subdomain` is `null` when the join returns no row (unlinked domain) and populated when it does.
- `app/api/admin/custom-domains/route.test.ts`: new cases — rejects a `linked_shop_id` that doesn't exist in `user_shops`; accepts a valid one; defaults `show_guest_purchase`/`show_landing_page` correctly when omitted on create.
- `middleware.ts`, `app/page.tsx`, `app/shop/[slug]/page.tsx`: no automated tests (existing convention) — typecheck + manual/live verification, consistent with every other middleware/page change in this feature so far.

## Out of scope

- Changing what happens on `linked_shop_id` shop-ownership transfer or shop deletion beyond the `on delete set null` fallback above.
- A UI on the shop-owner's side ("My Shop" settings) to request/claim a custom domain themselves — this remains a platform-admin-only action via `/admin/custom-domains`, per the original feature's approved scope.
- Per-domain override of the guest-purchase URL/button text (confirmed out of scope in this session — reuses the single global `support_settings` value).
- Any change to the shop storefront's own branding (shop name/logo) — the custom domain's `site_name`/`logo_url` only drive the sub-tab service filter's underlying `services` array in shop mode, not a re-skin of the shop's own identity.
