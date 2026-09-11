# Custom Domain Service Routing — Design

## Goal

Let a platform admin point an arbitrary custom domain (a domain they own, attached to the Vercel project) at this app, choose ONE of four core services (Data Bundles, Airtime, Results Checker, Bulk SMS) to be that domain's front-and-center offering, and give the domain its own branding (name, logo, primary color) — while accounts, wallet, and order history stay shared with the main site and every other domain. Platform-admin-managed only; not exposed to shop owners/sub-agents.

## Context

- `middleware.ts` already resolves the Host header to a shop-subdomain rewrite (`getShopSubdomain`, lines 39-56) and uses Upstash Redis at the edge for a per-IP rate limit (`cookieIssuanceRedis`/`cookieIssuanceLimiter`, lines 10-22) — the established pattern for Redis usage in this file, including graceful fail-open on Redis errors (lines 206-215).
- `lib/shop-url.ts` is the existing precedent for a small pure lib module holding host-parsing logic, consumed by both middleware and client components.
- `app/globals.css` defines shadcn-style HSL custom properties per theme: `--primary: 160 84% 30%` (light, line 23), `158 64% 52%` (dark, line 86) — a per-domain accent color needs to override this triplet, not a raw hex.
- `components/layout/sidebar.tsx` `menuItems`/`shopItems` (lines 63-87) are flat arrays of `{href, label, icon, roles}`, already filtered client-side by role. The four service-specific entries are `/dashboard/data-packages`, `/dashboard/airtime`, `/dashboard/results-checker` + `/dashboard/results-check` (both belong to the Results Checker service), and `/dashboard/sms`. `components/layout/bottom-nav.tsx` has the mobile equivalent.
- `lib/admin-auth.ts` `verifyAdminAccess()` is the existing pattern for admin API route auth (service-role Supabase client + `CRON_SECRET` bypass for cron callers) — reuse for the new admin CRUD route.
- `lib/shop-service.ts` `uploadNetworkLogo()` (lines 956-982) is the existing precedent for a Supabase Storage logo upload (`supabase.storage.from(bucket).upload()` + `getPublicUrl()`) — reuse the same shape against a new `custom-domain-logos` bucket.
- Latest migration is `migrations/0095_whitelist_provider_selection.sql` → this feature's migration is `0096_custom_domains.sql`.
- [[project-rls-grant-model]]: migration 0060 granted blanket authenticated CRUD plus bare `USING(true)` policies across tables, which has already caused one real exposure incident. The new table needs a deliberate, narrow policy from the start, not the inherited default.

## Design

### 1. Data model — `migrations/0096_custom_domains.sql`

```sql
create table custom_domains (
  id uuid primary key default gen_random_uuid(),
  domain text unique not null,              -- lowercase host, no protocol/www, e.g. "checkresults.com"
  service text not null check (service in ('data_bundles','airtime','results_checker','bulk_sms')),
  site_name text not null,
  logo_url text,
  primary_color text,                        -- hex, e.g. "#059669"; null = default app color
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table custom_domains enable row level security;

-- Public, unauthenticated read of active domains only — middleware runs with no user
-- session, and this data is exactly what a public website renders anyway, so a scoped
-- public-read policy is intentional and safe (not the blanket USING(true) pattern
-- that caused the prior RLS incident).
create policy "custom_domains_public_read" on custom_domains
  for select to anon, authenticated
  using (is_active = true);

-- No insert/update/delete policy — writes go through the service-role admin API route only.
```

### 2. `lib/custom-domains.ts` — pure resolution + route-gating logic

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

// Given the requested path and the domain's chosen service, return the path to redirect
// to if this path belongs to a DIFFERENT service's family, else null (the path is either
// service-agnostic — wallet, orders, auth, admin — or already belongs to this domain's
// own service).
export function getServiceRedirect(path: string, service: DomainService): string | null {
  const ownPrefixes = SERVICE_PATH_PREFIXES[service]
  if (ownPrefixes.some(p => path.startsWith(p))) return null

  const belongsToOtherService = Object.entries(SERVICE_PATH_PREFIXES)
    .some(([s, prefixes]) => s !== service && prefixes.some(p => path.startsWith(p)))
  if (!belongsToOtherService) return null

  return ownPrefixes[0]
}

export function normalizeDomainHost(host: string | null): string | null {
  if (!host) return null
  return host.split(":")[0].toLowerCase()
}
```

### 3. Redis cache + Supabase fallback — `lib/custom-domain-lookup.ts` (new module, separate from the pure logic above because it does I/O)

- Reuses the same Upstash Redis instance middleware already constructs, under a new key prefix `custom_domain:<host>`.
- `resolveCustomDomain(host)`:
  1. Return `null` immediately if `host === ROOT_DOMAIN` or `getShopSubdomain(host)` is non-null — the shop-subdomain path keeps priority, and normal main-site/shop traffic pays zero added latency.
  2. `GET custom_domain:<host>` from Redis. Hit → `JSON.parse` and return.
  3. Miss → query Supabase (`select * from custom_domains where domain = eq.host and is_active = eq.true limit 1`, anon client, using the public-read policy from §1). Found → `SET custom_domain:<host>` in Redis with a 5-minute TTL (a safety net against a missed cache invalidation, not the primary invalidation mechanism — see §6) and return it. Not found → return `null` without caching the negative result, so a domain added seconds ago doesn't stay invisible for the TTL window.
  4. Any Redis or Supabase error → return `null` (fail open to normal main-site rendering, matching the existing fail-open pattern at middleware.ts:206-215).

### 4. Middleware wiring (`middleware.ts`)

After the existing shop-subdomain rewrite logic, when `shopSubdomain` is null, call `resolveCustomDomain(host)`. If a config comes back:

- Set request headers `x-domain-service`, `x-domain-site-name`, `x-domain-logo`, `x-domain-color` via the existing `buildRequestHeaders()` helper (same mechanism already used for `x-nonce`).
- Compute `getServiceRedirect(path, config.service)`; if non-null, `NextResponse.redirect` to that path on the same host.

### 5. Branding application

- `app/layout.tsx` (server component) reads the four `x-domain-*` headers via `headers()` and passes them into a new client context, `components/providers/domain-branding-provider.tsx`, exposing `useDomainBranding() → { service, siteName, logoUrl, primaryColor }`. Default (`service: null`) means "no restriction" — today's main-site/shop behavior, completely unchanged.
- When `primaryColor` is set, the provider injects a `<style>` tag overriding `--primary` (converted from the stored hex to the `H S% L%` triplet format already used in `globals.css`) under a bare `:root` selector, so it wins in both light and dark mode without touching the two theme blocks.
- `components/layout/sidebar.tsx` and `bottom-nav.tsx`: the four service-specific menu entries gain an optional `services?: DomainService[]` tag. The render filter drops any item whose `services` is set and doesn't include the current domain's service; when `service` is null (main site/shop), filtering is a no-op.
- Two concrete branding anchors swap to `siteName`/`logoUrl` whenever `useDomainBranding().service` is non-null: the sidebar's existing "Logo Section" (`components/layout/sidebar.tsx:289-305`, currently a hardcoded `favicon-v2.jpeg` image + `<h1>DATAGOD</h1>` — this is the persistent dashboard chrome), and the marketing homepage's header/footer wordmark (`app/page.tsx:339` and `:708`, plus the hardcoded `"DATAGOD"`/`datagod.store` JSON-LD block at `:320-327`, which should use `siteName`/the request host instead when branding is active). The rest of `app/page.tsx`'s marketing copy (shop/sub-agent pitch, mockups) is untouched — see Out of scope.

### 6. Admin CRUD

- `app/api/admin/custom-domains/route.ts`: GET (list), POST (create), PATCH (update), DELETE, all behind `verifyAdminAccess()` with the service-role client. POST/PATCH validate `domain` (strip any pasted `http(s)://`, `www.`, trailing slash; lowercase; basic hostname shape) and `service` (one of the 4 enum values), reject if `domain` collides with `ROOT_DOMAIN` or matches the shop-subdomain shape (that host is already claimed). On success, write-through to Redis (`SET`/`DEL` the same `custom_domain:<domain>` key) so the change is live immediately rather than waiting on the 5-minute TTL.
- `app/admin/custom-domains/page.tsx`: table of existing domains (domain, service badge, site name, logo thumbnail, color swatch, active toggle) plus an add/edit form. Logo upload reuses the `uploadNetworkLogo` pattern (shop-service.ts:956) against a new `custom-domain-logos` storage bucket.
- Static note on the page: saving here does not attach the domain in Vercel or point its DNS — that remains a manual step (Vercel project → Settings → Domains) since it's infrequent and there's no stored Vercel API token in this environment.

## Error handling

- Unmapped custom host (attached in Vercel but no matching `custom_domains` row, or `is_active = false`): `resolveCustomDomain` returns `null`, headers stay unset, the page renders exactly like the main site today — no dedicated error page.
- Redis unavailable: already-optional in this file (`cookieIssuanceRedis` is `null` when env vars are unset) — `resolveCustomDomain` falls back to a direct Supabase lookup per request in that case, and fails fully open (no branding, no gating) if Supabase also errors.
- Admin submits a domain colliding with `ROOT_DOMAIN` or the shop-subdomain shape: the API route rejects with 400 before it ever reaches the table.

## Testing

- `lib/custom-domains.test.ts`: table-driven tests of `getServiceRedirect()` — own-service paths pass through untouched, other-service paths redirect to the right target, account-wide paths (`/dashboard/wallet`, `/dashboard/my-orders`, `/dashboard/profile`, admin routes) always return `null`.
- `lib/custom-domain-lookup.test.ts`: fake Redis + fake Supabase client (existing fake-client pattern, [[reference-testing]]) covering cache hit, miss-then-cache-fill, not-found, and Redis-error fail-open.
- Admin API route test: create/update/delete against a fake service-role client, including the `ROOT_DOMAIN`/shop-subdomain collision rejection.

## Out of scope

- Automating Vercel domain attachment or DNS via the Vercel API — no stored Vercel token this session; stays a manual admin step, documented in the admin UI.
- Per-domain favicon, meta description, or homepage hero copy rewrites — only header branding (name/logo/color) and nav/route restriction are in scope for this pass.
- Sub-agent/dealer self-service custom domains — platform-admin-only per the approved design; the data model doesn't preclude extending this later, but no shop-owner-facing UI or logic is built now.
- Multi-service domains — `service` is a single enum column; one service per domain.
