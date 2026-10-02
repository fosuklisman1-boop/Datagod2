# Shop Custom-Domain Subdomain — Design

## Goal

When an admin links a shop to a custom domain (`custom_domains.linked_shop_id`, shipped earlier today), that shop's own canonical/shareable URL should become a subdomain of that custom domain — e.g. `https://theirshop.clingshub.com` instead of `https://theirshop.datagod.store` — and that subdomain must actually route to the shop's storefront, not just display correctly.

## Scope

Confirmed in brainstorming:

- **Only the one shop a custom domain is already linked to** gets this — not every sub-agent who happens to sign up while visiting that domain. There is still exactly one shop per custom domain; this feature only changes what URL that one relationship is presented and reached through.
- **A specific subdomain, not the bare domain.** The custom domain's root already rewrites to the linked shop (shipped), but the shop's own *canonical* URL becomes `<shop's existing subdomain>.<the custom domain>` — reusing the shop's own already-unique `user_shops.subdomain` value, not a new admin-typed label.
- **No wildcard DNS.** The domain owner adds one more specific DNS record (same manual process as the root domain today), not a wildcard. No schema change to `user_shops.subdomain`'s uniqueness is needed, since no new subdomain string is introduced — the existing one is just also served under an additional parent domain.

## Context

- `custom_domains.linked_shop_id` (migration `0101_custom_domains_shop_link.sql`) is a plain FK to `user_shops(id)`, `on delete set null`, no uniqueness constraint — multiple domains could in principle link the same shop.
- Today's lookup direction is domain → shop only: `lib/custom-domain-lookup.ts`'s `lookupExact()` selects `linked_shop:user_shops!linked_shop_id(subdomain)` when resolving a *domain* host. There is no shop → domain lookup anywhere.
- `middleware.ts`'s `resolveCustomDomain(host)` (called from `lib/custom-domain-lookup.ts`) does exact-host equality lookups only (`.eq("domain", host)`) — no suffix/wildcard matching exists anywhere in this codebase today.
- `lib/shop-url.ts`'s `shopOrigin(subdomain: string): string` is the single function that builds every shareable shop URL (`https://<subdomain>.datagod.store`). It is called from 10 sites across 5 files — `app/shop/[slug]/page.tsx` (×4: AFA link ×2, structured-data schema, package schema), `app/dashboard/my-shop/page.tsx` (×3: copy-link, storefront href, displayed code block), `app/dashboard/shop-profile/page.tsx` (×1), `app/dashboard/shop-pricing/page.tsx` (×1), `app/dashboard/customers/page.tsx` (×1) — all synchronous, all passing `shop.subdomain` from already-loaded local `shop` state.
- `lib/shop-service.ts`'s `shopService.getShop(userId)` is the single shared function behind all 4 dashboard pages' `shop` state (also used by `shop-withdraw`, `payment-reverify`, `shop-profit-logs`, `shop-orders`, `shop-dashboard`, `sub-agent-catalog`, `sms` — this feature does not need to touch those, since they don't call `shopOrigin`). `shopService.getShopBySlug(slug)` is the equivalent for the public storefront (`app/shop/[slug]/page.tsx` and others).

## Design

### 1. Reverse lookup: shop → linked custom domain

New function in `lib/shop-service.ts` (co-located with the shop data layer, not `lib/custom-domains.ts`, since it's keyed by shop id, not by host):

```ts
async getLinkedCustomDomain(shopId: string): Promise<string | null>
```

Queries `custom_domains` for an active row (`is_active = true`) whose `linked_shop_id` matches, ordered `created_at asc`, `limit(1)` — the oldest linkage wins if a shop is ever linked to more than one domain (no uniqueness constraint prevents this; picking a single deterministic answer avoids ambiguity rather than trying to support multi-domain branding for one shop, which nobody has asked for). Returns the domain string, or `null` on no match or any query error (fail open to "not linked" — never let this lookup break the pages that call it).

### 2. `shopService.getShop()` / `getShopBySlug()` carry the linked domain

Both gain an additional `linked_custom_domain: string | null` field on their return value, populated via the new reverse lookup (one extra query alongside the existing shop-row fetch; the two existing TypeScript interfaces these functions return both gain this one field). This is the single extension point — every one of the 10 `shopOrigin` call sites already goes through one of these two functions to get its `shop` object, so none of them need their own separate lookup.

### 3. `shopOrigin()` becomes domain-aware

```ts
export function shopOrigin(subdomain: string, linkedCustomDomain?: string | null): string {
  return linkedCustomDomain
    ? `https://${subdomain}.${linkedCustomDomain}`
    : `https://${subdomain}.${ROOT_DOMAIN}`
}
```

Every call site is updated to pass `shop.linked_custom_domain` as the second argument (e.g. `shopOrigin(shop.subdomain, shop.linked_custom_domain)`). The parameter is optional so any caller that genuinely has no linked-domain concept (none currently, but defensive) still compiles and falls back to today's behavior.

### 4. Middleware resolves the new subdomain

`lib/custom-domain-lookup.ts`'s `resolveCustomDomain(host)` gains one more fallback, tried only when the existing exact-host lookup (and its existing www-toggle retry) both miss:

1. Split `host` on the first `.` — e.g. `"theirshop.clingshub.com"` → label `"theirshop"`, remainder `"clingshub.com"`.
2. Look up the remainder as a candidate custom domain (the existing exact-lookup machinery, reused — not a new query shape).
3. If found, active, and shop-linked, fetch that linked shop's own `subdomain` (already resolved as part of the existing domain lookup's join) and compare it to the stripped label.
4. On a match, return that same `CustomDomainConfig` — `middleware.ts`'s existing shop-mode rewrite (`customDomainShopRewritePathname`) then fires exactly as it already does for the bare root domain, completely unchanged.
5. No match at any step → `null`, same as any other unrecognized host today.

This is a single-label strip-and-retry, not a suffix scan against every row — it costs at most one extra lookup, and only on a host that already failed the normal exact-match path (i.e., never on the far more common main-site/shop-subdomain/bare-custom-domain traffic, which all resolve on the first attempt as today).

Caching: the existing Redis positive/negative cache (`lib/custom-domain-lookup.ts`'s `cacheSetPositive`/`cacheSetNegative`) naturally covers this too, keyed by the exact subdomain host string — no new cache key scheme needed.

### 5. Admin UX: surfacing the DNS instruction

`app/admin/custom-domains/page.tsx`'s "Link to Shop" section gains a derived, read-only line once a shop is selected in the dropdown — e.g.:

> Once linked, ask the domain owner to also point `theirshop.clingshub.com` at Vercel (a DNS record, same as the root domain), then attach that exact hostname under your Vercel project's Settings → Domains.

Computed client-side from the selected shop's own `subdomain` (already available in the `shops` list the picker already loads) and the domain field's current value — no new stored field, no new admin input.

## Error handling

- Reverse lookup query failure (network/DB error): fails open to `null` (not linked) — a shop's URL falls back to `<subdomain>.datagod.store` rather than breaking the dashboard page that's displaying it.
- A shop linked to a domain that's since been deactivated (`is_active = false`): the reverse lookup's `is_active = true` filter excludes it, so `shopOrigin` falls back automatically — consistent with how a deactivated domain already stops being resolved by middleware today.
- The new middleware fallback never fires for a host with no dot before the first label match (e.g. `"clingshub.com"` itself splits to label `"clingshub"` / remainder `"com"` — `"com"` will never match an active custom domain row, so this naturally no-ops for the bare domain, which is already handled by the existing exact-match path anyway).

## Testing

- `lib/shop-service.test.ts` (new or extended, matching the fake-client convention used elsewhere): `getLinkedCustomDomain` — returns the domain on a match, `null` on no match, `null` on a query error, picks the oldest when more than one active row links the same shop.
- `lib/custom-domain-lookup.test.ts`: new cases for `resolveCustomDomain`'s subdomain-of-custom-domain fallback — matches when the stripped label equals the linked shop's subdomain; does NOT match when the label is anything else (e.g. a typo, or a different shop's subdomain); does not fire when the exact-host lookup already hit.
- `lib/shop-url.test.ts` (new, if no such file exists yet — confirm during planning): `shopOrigin` — returns the custom-domain form when a linked domain is passed, falls back to the main-site form when it's `null`/`undefined`/omitted.
- `middleware.ts`, `app/admin/custom-domains/page.tsx`, the 5 dashboard-page call sites: no automated tests (established convention) — verified via `tsc` + manual/live checks, consistent with every other middleware/page change in this feature area so far.

## Out of scope

- Wildcard DNS / per-sub-agent custom-domain subdomains (explicitly rejected in brainstorming — this spec covers only the single already-linked shop per domain).
- Any change to `user_shops.subdomain`'s generation or global uniqueness.
- Supporting more than one "canonical" URL per shop simultaneously in the UI (a shop linked to 2 domains still shows exactly one derived URL, per the oldest-wins tie-break above).
- Automating the Vercel domain attachment itself (no Vercel API token is available in this environment, per the original custom-domain feature's own documented constraint) — the admin still performs that step manually, same as today's root-domain attachment.
