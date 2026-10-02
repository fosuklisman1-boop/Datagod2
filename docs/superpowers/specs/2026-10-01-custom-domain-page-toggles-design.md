# Custom Domain Page/Feature Toggles — Design

**Date:** 2026-10-01
**Status:** Approved for planning

## Problem

A custom domain today can only be scoped by its `services` selection (Data Bundles/Airtime/Results Checker/Bulk SMS) and a hardcoded, non-configurable list of "dealer tool" pages that are always hidden (`NON_SERVICE_GATED_PATHS` in `lib/custom-domains.ts`). Several other pages/features have no gating at all — the marketing landing page, the "Buy as Guest" button, the "Join Channel" (Join Community) button, and the wallet/top-up feature — even though an admin running a custom domain may want to hide any of them (wallet/top-up specifically because direct payment for dashboard checkouts is coming soon, which will make the wallet-funding flow unnecessary on some domains).

Separately, the login and signup pages show "DATAGOD" branding and the default favicon unconditionally, never reading the custom domain's own `site_name`/`logo_url` — unlike the homepage (`app/page.tsx`), which already does this correctly.

Note: a prior, unimplemented design (`docs/superpowers/specs/2026-09-17-custom-domain-shop-and-landing-modes-design.md` / its plan) explored a narrower version of two of these toggles (landing page, guest-purchase button) plus a "shop mode" concept. This design supersedes it — it is not built on top of that work, and that plan/spec should be treated as dormant/superseded once this one ships.

## Design

### 1. Data model

One new column on `custom_domains`: `hidden_pages text[] not null default '{...9 dealer-tool keys...}'` (see migration below for the exact default array). A shared registry, `lib/custom-domain-pages.ts`, defines every toggleable page/feature once:

```ts
export interface ToggleablePage {
  key: string
  label: string
  group: "auth" | "dashboard"
  // Present only for entries with a dedicated route — drives uniform
  // middleware blocking + nav filtering. Absent for the 3 entries that are
  // gated at a specific render site instead of a whole route.
  path?: string
}

export const TOGGLEABLE_PAGES: ToggleablePage[] = [
  { key: "landing_page",   label: "Landing Page",            group: "auth" },
  { key: "guest_purchase", label: "Buy as Guest Button",      group: "auth" },
  { key: "join_channel",   label: "Join Channel Button",      group: "auth" },
  { key: "wallet",         label: "Wallet & Top-Up",          group: "dashboard", path: "/dashboard/wallet" },
  { key: "afa_orders",         label: "AFA Registration",      group: "dashboard", path: "/dashboard/afa-orders" },
  { key: "upgrade",            label: "Upgrade / Dealer Plans", group: "dashboard", path: "/dashboard/upgrade" },
  { key: "my_shop",            label: "My Shop",               group: "dashboard", path: "/dashboard/my-shop" },
  { key: "shop_dashboard",     label: "Shop Dashboard",        group: "dashboard", path: "/dashboard/shop-dashboard" },
  { key: "sub_agents",         label: "Sub-Agents",            group: "dashboard", path: "/dashboard/sub-agents" },
  { key: "sub_agent_catalog",  label: "Sub-Agent Catalog",      group: "dashboard", path: "/dashboard/sub-agent-catalog" },
  { key: "ussd_shop",          label: "USSD Shop",             group: "dashboard", path: "/dashboard/ussd-shop" },
  { key: "payment_reverify",   label: "Payment Re-verify",     group: "dashboard", path: "/dashboard/payment-reverify" },
  { key: "buy_stock",          label: "Buy Stock",             group: "dashboard", path: "/dashboard/buy-stock" },
]
```

Migration (`migrations/0100_custom_domain_page_toggles.sql`):

```sql
alter table custom_domains add column if not exists hidden_pages text[] not null default
  '{afa_orders,upgrade,my_shop,shop_dashboard,sub_agents,sub_agent_catalog,ussd_shop,payment_reverify,buy_stock}';
```

**Why this default is safe:** the 9 dealer-tool keys are currently *always hidden* on every custom domain (hardcoded); the 4 other keys (`landing_page`, `guest_purchase`, `join_channel`, `wallet`) are currently *always shown* (never gated). Postgres applies a column's default to every existing row when the column is added, not just future inserts — so every current domain ends up with exactly today's behavior (9 dealer tools hidden, everything else shown) with zero manual backfill. `NON_SERVICE_GATED_PATHS` is deleted; its 9 paths move into this registry/column.

### 2. Shared routing logic (`lib/custom-domains.ts`)

`CustomDomainConfig` gains `hidden_pages: string[]`.

`getServiceRedirect(path, services)` becomes `getServiceRedirect(path, services, hiddenPages)`. Its path-ownership logic is unchanged; only the "does this path belong to a blocked bucket" check changes source — instead of checking the hardcoded `NON_SERVICE_GATED_PATHS` constant, it checks `TOGGLEABLE_PAGES` entries whose `key` is in `hiddenPages` and whose `path` is a prefix of the requested path.

`isPathAllowedForService(path, services, hiddenPages)` gains the same third parameter and passes it through.

A new helper for the 3 path-less entries:

```ts
export function isPageHidden(key: string, hiddenPages: string[]): boolean {
  return hiddenPages.includes(key)
}
```

### 3. Middleware + branding context — threading `hidden_pages` through

Same pipeline `services`/`site_name`/`logo_url` already use, extended with one more field, end to end:

- `lib/custom-domain-lookup.ts`: add `hidden_pages` to the Supabase `select()` and the mapped `CustomDomainConfig`.
- `middleware.ts`: one new branch *before* the existing service-redirect call — if `isPageHidden("landing_page", customDomainConfig.hidden_pages)` and `path === "/"`, redirect to `/auth/login`. The existing `getServiceRedirect` call passes `customDomainConfig.hidden_pages` as its new third argument. The header-building block gains `x-domain-hidden-pages` (comma-joined keys), alongside the existing four `x-domain-*` headers.
- `components/providers/domain-branding-provider.tsx`: `DomainBranding` gains `hiddenPages: string[]`, defaulting to `[]`.
- `app/layout.tsx`: parses `x-domain-hidden-pages` into `hiddenPages` (split on `,`, empty/absent → `[]`).
- `components/layout/sidebar.tsx`: existing `isPathAllowedForService(item.href, domainBranding.services)` calls pass `domainBranding.hiddenPages` as the new third argument.
- `components/layout/bottom-nav.tsx`: this file does **not** currently filter its nav items through `isPathAllowedForService` at all — `USER_NAV` is a fixed 5-slot array (Home, Wallet, FAB, Orders, Shop/Profile) with `"/dashboard/wallet"` hardcoded directly into it. Add one targeted fix: when `isPageHidden("wallet", domainBranding.hiddenPages)`, drop the Wallet slot from `USER_NAV` (4 items instead of 5) rather than leaving a nav icon that points at a now-blocked route. The `shopSlotHref` fallback to `/dashboard/shop-dashboard` (used when no `primaryService` is set) has the same kind of gap for the `shop_dashboard` key — middleware already blocks that route server-side if hidden (section 3's generic `path`-based redirect still applies there regardless of what the nav shows), so a stale nav icon that bounces on tap is a pre-existing-shaped cosmetic limitation of this file's hardcoded 5-slot design, not a new hole this spec introduces. Fixing it generically is out of scope here; only the Wallet slot gets the explicit fix, since wallet is this spec's own toggle.

Every piece defaults to a no-op on the main site (no header set → empty array → nothing hidden beyond what the migration default already preserves).

### 4. The 3 path-less features — specific render sites

- **`landing_page`**: fully handled in middleware (section 3) — no page-level change.
- **`guest_purchase`**: wrap both `<GuestPurchaseButton>` occurrences in `app/page.tsx` (lines 394, 700) and the one in `app/auth/login-form.tsx` (line 209) with `{!isPageHidden("guest_purchase", domainBranding.hiddenPages) && (...)}`. Signup page is explicitly out of scope — it has neither button today and none is being added.
- **`join_channel`**: wrap the "Join Community" button block in `app/auth/login-form.tsx` (lines 212-220) the same way.
- **`wallet`**: three gated things in `app/dashboard/page.tsx`, all on the same `!isPageHidden("wallet", domainBranding.hiddenPages)` check:
  - The wallet hero card (lines 408-426).
  - The second "Top Up Wallet" button (line 516-517).
  - `useOnboarding()`'s `showOnboarding` (triggers whenever wallet balance < GHS 5, from `hooks/use-onboarding.ts`) is AND'd with the same check before being passed to `<WalletOnboardingModal open={...}>` — the low-balance nag never fires when wallet is hidden on that domain.
  - The nav entry (sidebar/bottom-nav) is covered generically by section 3, since `wallet` has a `path`.

### 5. Login/signup branding fix (independent of the toggle system)

`app/auth/login-form.tsx` and `app/auth/signup/page.tsx` each hardcode `"DATAGOD"` text and `src="/favicon-v2.jpeg"` in two spots (desktop brand panel, mobile logo) and never import `useDomainBranding`. Fix: import it, and replace each hardcoded value with the same fallback pattern `app/page.tsx` already uses — `domainBranding.siteName || "DATAGOD"` and `domainBranding.logoUrl || "/favicon-v2.jpeg"`. No new data needed; `siteName`/`logoUrl` already exist on `DomainBranding`. No-op on the main site (both are `null` there).

### 6. Admin API route (`app/api/admin/custom-domains/route.ts`)

A `parseHiddenPages(raw)` validator mirrors the existing `parseServices(raw)`: `raw` must be an array (empty is valid — "nothing hidden"); every entry must be a known `TOGGLEABLE_PAGES` key, else a 400 naming the bad value; result is deduplicated.

- `GET`'s `select()` adds `hidden_pages`.
- `POST` accepts an optional `hidden_pages`; when omitted, the inserted row relies on the column's own default (today's dealer-tools-hidden behavior) rather than the route hardcoding a duplicate default.
- `PATCH` validates `hidden_pages` when present, same shape as every other optional field.
- Both `setCustomDomainCache` call sites add `hidden_pages` to their payload.

### 7. Admin UI (`app/admin/custom-domains/page.tsx`)

`CustomDomainRow` and `EMPTY_FORM` gain `hidden_pages: string[]`. `EMPTY_FORM.hidden_pages` is pre-populated with the same 9 dealer-tool keys as the migration's column default (not `[]`) — so a brand-new domain's checklist visually starts in the same state a freshly-inserted row actually has (dealer tools unchecked/hidden, the other 4 checked/visible), and the form always sends an explicit `hidden_pages` array on save rather than relying on the server's omitted-field default.

Replace the single "Services" checkbox block with two grouped checklists built directly from `TOGGLEABLE_PAGES`, both writing into the same `form.hidden_pages: string[]` — checked = *visible* (not in the array), unchecked = *hidden* (in the array); this reads more naturally in the UI than the inverted storage semantics:

- **"Login / Signup / Homepage"** group (`TOGGLEABLE_PAGES` entries with `group: "auth"`): Landing Page, Buy as Guest Button, Join Channel Button.
- **"Dashboard Tools"** group (`group: "dashboard"`): Wallet & Top-Up, then the 9 dealer-tool pages.

The existing "Services" checkbox block (Data Bundles/Airtime/Results Checker/Bulk SMS) is unchanged and stays separate — it is not folded into this registry.

Table gains one more column, "Hidden," showing a count badge (e.g. "3 hidden") when `row.hidden_pages.length > 0`, nothing otherwise.

### Out of scope

- No changes to the existing `services` multi-select mechanism — it stays a separate, already-working system.
- No changes to the dormant "shop mode"/`linked_shop_id` concept from the 2026-09-17 spec — this design supersedes only the two toggles that spec also covered (`show_landing_page`, `show_guest_purchase`), not its shop-linking idea.
- Signup page does not gain the Buy as Guest or Join Channel buttons — they stay login-only, matching today.
- No retroactive change to which domains currently have dealer tools hidden — the migration default preserves exactly today's state for every existing row.
- `bottom-nav.tsx`'s Shop/Profile slot still falls back to a `/dashboard/shop-dashboard` href when that page is hidden and no `primaryService` is set — middleware blocks the route either way (the tap just bounces), but the nav icon itself isn't swapped out, unlike the Wallet slot. Left as-is; only `wallet` gets the explicit nav fix in section 3.

## Testing

- `lib/custom-domains.test.ts`: extend for `getServiceRedirect`/`isPathAllowedForService`'s new `hiddenPages` parameter — a hidden-by-key dealer-tool path redirects/blocks the same way `NON_SERVICE_GATED_PATHS` used to; an un-hidden one (admin toggled it back on) does not; `isPageHidden` for each of the 3 path-less keys.
- `lib/custom-domain-lookup.test.ts`: `hidden_pages` round-trips through the mapped config, matching the existing `services` test pattern.
- `app/api/admin/custom-domains/route.test.ts`: `parseHiddenPages` rejects a non-array, rejects an unknown key, dedupes, accepts empty array, defaults correctly on POST when omitted.
- `middleware.ts`, `components/providers/domain-branding-provider.tsx`, `app/layout.tsx`, `components/layout/sidebar.tsx`, `app/page.tsx`, `app/auth/login-form.tsx`, `app/auth/signup/page.tsx`, `app/dashboard/page.tsx`, `app/admin/custom-domains/page.tsx` are not unit-tested in this codebase (established convention for these files) — verified via `npx tsc --noEmit` plus careful reading, consistent with how the dormant 2026-09-17 plan handled the same files.
