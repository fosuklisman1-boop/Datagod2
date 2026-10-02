# Wildcard Shop Domains — Design

## Goal

Let an admin turn a custom domain into a shared, platform-wide storefront host: once enabled for a domain, every active shop automatically gets its own subdomain of that domain (e.g. `kofi.clingshub.com`, `ama.clingshub.com`), with zero per-shop configuration. This replaces — for that one domain — the single-shop `linked_shop_id` link shipped earlier today; the two remain mutually exclusive per domain, so other custom domains can still use the single-shop-link mode unaffected.

## Scope, confirmed in brainstorming

- **Eligibility:** every active, non-blocked shop platform-wide — not scoped to one sponsor's sub-agent hierarchy, not an admin-curated allowlist.
- **Opt-in:** none. The moment an admin enables wildcard mode for a domain, it applies automatically to every shop. No new per-shop field, no shop-owner setting.
- **Bare domain behavior:** wildcard mode replaces the single-shop link entirely. The domain's own root (`clingshub.com` with no subdomain) falls back to plain account/dashboard-mode handling — the same behavior as a domain that was never shop-linked at all — since there's no longer one designated "default" shop once wildcard mode is on.
- **Subdomain uniqueness:** unchanged. `user_shops.subdomain` is already globally unique (migration 0055); wildcard mode just exposes that same existing value under an additional parent domain, so no schema change to uniqueness is needed.
- **Vercel/DNS:** the Vercel-side wildcard attachment (`*.clingshub.com`) for this specific domain has already been performed directly via the Vercel API as part of this session (confirmed `verified: true`). The domain owner still needs to add one DNS record at their own provider — a CNAME, host `*`, value `cname.vercel-dns.com.` — before any subdomain actually resolves; confirmed live that this is still outstanding (`testprobe123.clingshub.com` returns a hard DNS NXDOMAIN today, not a routing error). This is a manual, external step this plan does not automate, same as every other domain-attachment step in this feature area.

## Context

- `custom_domains.linked_shop_id` (migration 0101, shipped earlier today) links a domain to exactly one shop; `app/api/admin/custom-domains/route.ts`'s `validateLinkedShopId` validates it, and `middleware.ts`'s `customDomainShopRewritePathname` rewrites every non-account-system path on that domain to `/shop/<that one shop's subdomain>/*`.
- `lib/custom-domain-lookup.ts`'s `resolveCustomDomain(host)` already has a subdomain-of-custom-domain fallback (migration/task from earlier today) that strips the first label off an unmatched host and checks whether the remainder is a registered, shop-linked domain whose linked shop's own subdomain exactly matches the stripped label.
- `lib/shop-service.ts`'s `getLinkedCustomDomain(subdomain)` (today's RPC-backed reverse lookup) answers "is THIS shop specifically linked to an active domain?" — keyed by the shop's own subdomain, calling a `SECURITY DEFINER` Postgres function (`get_linked_custom_domain`, migration 0103) because the browser client can't read `user_shops.id` under RLS.
- `user_shops` has `is_active`/`is_blocked` columns, already filtered by the existing "Active shops are publicly readable" RLS policy (`is_active = true AND is_blocked = false`, granted to `anon`).
- `app/admin/custom-domains/page.tsx`'s "Link to Shop" section (today's work) has the shop picker `<select>` and the derived DNS-instruction paragraph this plan's UI changes extend.

## Design

### 1. Migration — new column, mutual exclusivity enforced at the admin-route level

```sql
alter table custom_domains
  add column if not exists wildcard_shops_enabled boolean not null default false;
```

No DB-level CHECK constraint forcing `linked_shop_id is null when wildcard_shops_enabled`, to keep this a simple additive column — the admin route (see §4) is the one place both fields are ever written, and it enforces the exclusivity there: setting `wildcard_shops_enabled: true` always clears `linked_shop_id` to `null` in the same update, and setting a `linked_shop_id` always clears `wildcard_shops_enabled` to `false`.

### 2. `lib/custom-domains.ts` — `CustomDomainConfig` gains the new field

```ts
export interface CustomDomainConfig {
  // ...existing fields unchanged...
  wildcard_shops_enabled: boolean
}
```

### 3. `lib/custom-domain-lookup.ts` — two parallel subdomain-resolution paths

`lookupExact`'s Supabase select gains `wildcard_shops_enabled` alongside the existing columns, and `resolveCustomDomain`'s existing subdomain-fallback block splits into two checks against the same resolved `parent` config, tried in this order once the remainder is found active:

1. **Existing single-shop check (unchanged):** `parent.config.linked_shop_subdomain === label` → return `parent.config` (today's behavior, untouched).
2. **New wildcard check:** else, if `parent.config.wildcard_shops_enabled`, query `user_shops` for an active, non-blocked row with `subdomain = label` (a direct, non-embedded query — safe for `anon`, no `id`-join problem since this only needs existence, not a join). If found, return `parent.config` the same way (the existing shop-mode rewrite in `middleware.ts` already targets whatever subdomain the *path* implies via `customDomainShopRewritePathname`'s own label — wait: **this needs one more piece**, see §4 below for how `middleware.ts` picks up the matched label rather than only ever using `linked_shop_subdomain`).

Since `linked_shop_id` and `wildcard_shops_enabled` are mutually exclusive by construction (§1), a domain is never in both states at once — these two checks never both apply to the same `parent.config`, so there's no ambiguity about which one fires.

### 4. `middleware.ts` — the shop-mode rewrite target becomes label-driven under wildcard mode

Currently, `customDomainShopRewritePathname` always rewrites to `/shop/${customDomainConfig.linked_shop_subdomain}${...}` — correct for single-shop mode, but wrong for wildcard mode, where the target shop varies per request (it's whichever shop's subdomain the visitor actually typed). Under wildcard mode, the rewrite target must be the REQUESTED subdomain label itself (already proven, by the lookup in §3, to be an active shop's own subdomain) — not a fixed value from the domain's config.

`resolveCustomDomain`'s return value doesn't change shape (still just `CustomDomainConfig`), but `middleware.ts` itself needs the matched label when in wildcard mode. Simplest approach: middleware re-derives it the same way the lookup did — `customDomainConfig.wildcard_shops_enabled` is true, split `hostname` on its first `.` to get the same label, and use THAT as the rewrite target instead of `linked_shop_subdomain`:

```ts
const shopModeSubdomain = customDomainConfig?.wildcard_shops_enabled
  ? hostname.split(".")[0]
  : customDomainConfig?.linked_shop_subdomain

const customDomainShopRewritePathname =
  shopModeSubdomain &&
  !path.startsWith("/shop/") && ...(unchanged exclusions)...
    ? `/shop/${shopModeSubdomain}${path === "/" ? "" : path}`
    : null
```

This re-derivation is cheap (string split, no extra query) and consistent: by the time middleware runs this, `resolveCustomDomain` has ALREADY confirmed (via the Redis-cached or fresh lookup in §3) that this exact label is a valid, active shop subdomain — middleware doesn't need to re-verify it, just reuse the same derivation.

The bare-domain case (no subdomain, visiting `clingshub.com` directly) is unaffected: `hostname.split(".")[0]` would be the WHOLE domain label (e.g. `"clingshub"`), which — critically — is never itself a valid `user_shops.subdomain` match target for THIS check, because the bare-domain request doesn't go through the subdomain-fallback path at all (it resolves via the EXACT host match in `lookupExact`, not the stripped-label fallback) — so `customDomainConfig.wildcard_shops_enabled` is still true for that exact-match config, but `shopModeSubdomain` would incorrectly compute `"clingshub"` as if it were a shop label. **This is a real edge case the implementation must guard against:** the label-rewrite logic above must only apply when the request reached this config via the SUBDOMAIN fallback (i.e., `hostname !== customDomainConfig.domain`), not via an exact match on the bare domain itself. The plan's tasks must make this distinction explicit (e.g., by checking `hostname !== customDomainConfig.domain` before computing `shopModeSubdomain`, so a bare-domain visit to a wildcard-enabled domain correctly falls through to account-mode handling instead of attempting a bogus "shop named clingshub" rewrite).

### 5. `lib/shop-service.ts` — `getLinkedCustomDomain` becomes a combined lookup

The existing RPC-backed function is extended (same name, same call sites, no new call sites needed) to also check wildcard eligibility, with direct-link priority over wildcard:

```sql
-- get_linked_custom_domain(p_subdomain text), updated body:
select domain from (
  -- Priority 1: this shop is specifically linked to an active domain.
  select cd.domain, cd.created_at, 1 as priority
  from custom_domains cd
  join user_shops us on us.id = cd.linked_shop_id
  where cd.is_active = true and us.subdomain = p_subdomain

  union all

  -- Priority 2: any active domain has wildcard mode on (this shop doesn't
  -- need to match anything specific — just needs to itself be active, which
  -- the caller already knows since it's asking about its own subdomain).
  select cd.domain, cd.created_at, 2 as priority
  from custom_domains cd
  where cd.is_active = true and cd.wildcard_shops_enabled = true
) ranked
order by priority asc, created_at asc
limit 1
```

Still a single `SECURITY DEFINER` function, same signature, same `GRANT EXECUTE` — only the body changes. Every existing call site (`getShop`, `getShopBySlug`, all 10 `shopOrigin` sites, `app/shop/[slug]/layout.tsx`'s canonical URL) picks this up automatically with no code changes outside `lib/shop-service.ts`'s own migration.

### 6. `app/admin/custom-domains/page.tsx` — the new checkbox and mutual exclusivity

A new checkbox, "Enable wildcard mode — any active shop can use `<domain>` as an alternate URL," placed next to the existing "Link to Shop" dropdown. Selecting a shop in the dropdown unchecks and disables the checkbox; checking the checkbox clears and disables the dropdown (mirrored both ways, enforced client-side for UX — the admin route is the actual source of truth per §1).

The derived DNS-instruction paragraph changes shape when wildcard mode is checked: instead of showing one specific hostname, it explains the domain owner needs a wildcard DNS record (`*`, CNAME, pointing at Vercel) rather than one exact hostname — a materially bigger, one-time ask compared to the single-shop case's per-link instruction.

`app/api/admin/custom-domains/route.ts`'s POST/PATCH validation gains a `wildcard_shops_enabled` boolean field (parsed the same way `is_active` already is), and whichever of `linked_shop_id`/`wildcard_shops_enabled` is being set in a given request clears the other in the same update.

## Error handling

- The new `user_shops` existence check in §3 fails open (query error → treat as "not a valid shop label," same as a genuine not-found) — consistent with every other lookup in this file.
- A shop that's deactivated or blocked AFTER a wildcard-domain request was already cached (via the existing Redis positive cache) could keep resolving for up to `CACHE_TTL_SECONDS` — same class of staleness this morning's single-shop cache entries already have; this plan does not introduce a new invalidation mechanism beyond what's already there.

## Testing

- `lib/custom-domain-lookup.test.ts`: new cases for the wildcard branch — an active shop's subdomain under a wildcard-enabled domain resolves; an unrecognized label under the same domain does not; a wildcard-enabled domain's bare-domain visit does NOT get mis-routed as a shop rewrite.
- `lib/shop-service.test.ts`: extend the RPC-mock tests to cover the new priority behavior (a shop with both a direct link AND an available wildcard domain prefers the direct link) — since the matching logic is now entirely in SQL (same pattern as this morning's fix), these are tests of the RPC call's wiring, with the actual priority logic verified live against the real database before this ships (same verification discipline used for migration 0103 this morning).
- `app/admin/custom-domains/page.tsx`, `middleware.ts`: no automated tests (established convention) — verified via `tsc` + manual/live checks, including a real end-to-end check once the domain owner's DNS record is in place.

## Out of scope

- Automating the domain owner's DNS record addition (a real, external, manual step — same as every other domain-attachment step in this feature area).
- Any per-shop opt-out or customization of their wildcard-mode subdomain (always automatic, always the shop's own existing `subdomain` value).
- Supporting more than one wildcard-enabled domain with different precedence rules beyond the simple "oldest wins" tie-break already used elsewhere in this feature area.
