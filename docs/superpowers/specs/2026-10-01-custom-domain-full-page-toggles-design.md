# Custom Domain Full Page Toggles — Design

**Date:** 2026-10-01
**Status:** Approved for planning

## Problem

The page/feature toggle system shipped earlier today (`docs/superpowers/specs/2026-10-01-custom-domain-page-toggles-design.md`) covers 13 keys: 9 dealer-tool pages, wallet/top-up, and 3 auth-page features (landing page, Buy as Guest, Join Channel). Testing it surfaced two gaps:

1. **"Dashboard is still showing" when the landing page is hidden for a logged-in user.** Hiding `landing_page` redirects `/` → `/auth/login`, but middleware's own pre-existing, unrelated "bounce authenticated users off auth pages" logic then immediately redirects `/auth/login` → `/dashboard` for anyone already signed in. The admin's intent — hide everything, land the visitor somewhere sensible — was never actually wrong, but it surfaced a bigger gap: **most of the sidebar isn't toggleable at all.** `/dashboard` itself, `My Orders`, `Transactions`, `Profile`, `Complaints`, `Developer/API`, and 6 of `My Shop`'s 7 pages (everything except Overview) have no hide mechanism whatsoever.
2. The user confirmed the real ask is broader: every sidebar page should be individually toggleable, and when a user's expected landing page is hidden, they should land on the next visible page instead of a dead end.

## Design

### 1. Registry expansion

`ToggleablePage.path?: string` becomes `paths?: string[]` (every existing single-path entry becomes a one-element array — mechanical, no behavior change for them). `getServiceRedirect`'s hidden-path matching iterates `paths` instead of checking one string.

Six new keys (group changes below), plus `my_shop` extended to bundle its 6 sibling routes as one unit — hiding "My Shop" hides the whole section, not page-by-page:

```ts
{ key: "dashboard_home", label: "Dashboard Home",  group: "core",  paths: ["/dashboard"] },
{ key: "my_orders",      label: "My Orders",       group: "core",  paths: ["/dashboard/my-orders"] },
{ key: "transactions",   label: "Transactions",    group: "core",  paths: ["/dashboard/transactions"] },
{ key: "profile",        label: "Profile",         group: "core",  paths: ["/dashboard/profile"] },
{ key: "complaints",     label: "My Complaints",   group: "core",  paths: ["/dashboard/complaints"] },
{ key: "developer",      label: "Developer / API", group: "tools", paths: ["/dashboard/developer"] },

// my_shop (existing key) extended:
{ key: "my_shop", label: "My Shop", group: "tools", paths: [
  "/dashboard/my-shop", "/dashboard/shop-orders", "/dashboard/customers",
  "/dashboard/shop-profit-logs", "/dashboard/shop-pricing",
  "/dashboard/shop-withdraw", "/dashboard/shop-profile",
] },
```

`wallet` moves from its current ad hoc placement into `group: "core"` (it's a core account feature, not a dealer tool). Registry grows from 13 to 19 keys. Services-gated pages (Data Packages, Buy Airtime, Results Checker, Bulk SMS) are explicitly **not** added — they stay on the existing, separate `services` allowlist mechanism, confirmed unchanged.

Migration default (the asymmetric-default trick that keeps every existing domain's behavior identical) stays exactly as-is for the 9 original dealer-tool keys — none of the 6 new keys or the `my_shop` path extension are in that default array, since none of the 6 new pages/the 6 newly-bundled shop sub-pages were ever hidden before. A new migration just adds the column-default-unaffecting registry entries (the registry is pure TypeScript, no DB change needed beyond what Task 1 of the earlier plan already did — `hidden_pages` is already a generic `text[]`, it doesn't need to know about new keys at the schema level at all).

### 2. Shared nav-item module + "first visible page" resolution

Extract the plain data (`href`, `label`, `icon`, `roles`) from `components/layout/sidebar.tsx`'s `menuItems`/`shopItems` arrays into a new file, `lib/dashboard-nav-items.ts` (both `sidebar.tsx` and `app/dashboard/page.tsx` are already `"use client"`, so this is a same-side extraction, not a server/client split). `sidebar.tsx` imports it for rendering, unchanged behavior.

The same file exports `getFirstVisiblePath(role, domainBranding, dealerHasSubscription): string | null` — walks `menuItems` then `shopItems` in order, returns the first `href` whose item passes all three existing filters (role membership, the one dealer-subscription special case currently applied only to `/dashboard/upgrade`, and `isPathAllowedForService`/`isPageHidden`), or `null` if nothing qualifies.

`app/dashboard/page.tsx` calls this on mount: if `dashboard_home` is itself hidden for this domain, it `router.replace()`s to the result instead of rendering dashboard content — to the first visible path, or to `/dashboard/unavailable` (Section 3) if `null`.

**The other 4 places `/dashboard` is hardcoded as a redirect target do not change**: `middleware.ts`'s auth-page bounce, `GoogleAuthButton`'s default, `role-guard.tsx`'s default, and the login form's default `redirectTo`. They keep landing on `/dashboard` as today; the dashboard page itself decides whether to show its content or hand off. This avoids needing role/subscription data inside middleware (which only knows about auth state today, not role), at the cost of one extra client-side hop when `dashboard_home` happens to be hidden — acceptable since that's an uncommon admin configuration, not the default path.

### 3. The "nothing available" screen

New route `app/dashboard/unavailable/page.tsx` — standalone (no `DashboardLayout`/sidebar, since a mostly-hidden sidebar would look broken), centered message ("No features are currently available on this domain"), a sign-out button, nothing else. Never itself a `TOGGLEABLE_PAGES` entry — the one guaranteed-reachable terminal fallback. Still naturally covered by middleware's existing `path.startsWith("/dashboard")` auth check, so an unauthenticated visitor is bounced to login first, same as any other dashboard route.

### 4. Admin UI — three groups instead of two

`ToggleablePage.group` becomes `"auth" | "core" | "tools"` (was `"auth" | "dashboard"`). The admin checklist renders three `.filter()` blocks instead of two:

- **"Login / Signup / Homepage"** (unchanged, 3): Landing Page, Buy as Guest Button, Join Channel Button.
- **"Core Pages"** (new, 6): Dashboard Home, My Orders, Transactions, Profile, My Complaints, Wallet & Top-Up.
- **"Dealer & Business Tools"** (10): AFA Registration, Upgrade/Dealer Plans, My Shop, Sub-Agents, Sub-Agent Catalog, USSD Shop, Payment Re-verify, Buy Stock, Developer/API.

(`shop_dashboard` — a pre-existing key from the earlier plan — also moves into "Dealer & Business Tools"; it was previously in the single "dashboard" group.)

`DEFAULT_HIDDEN_PAGES` (the admin UI's new-domain form default, and the migration's own column default) is unchanged — still exactly the original 9 dealer-tool keys. None of the 6 new keys or `my_shop`'s extended paths are added to it, since none of those pages were ever hidden by default before.

### Out of scope

- Services-gated pages (Data Bundles/Airtime/Results Checker/Bulk SMS) stay on the separate, untouched `services` mechanism.
- The 4 hardcoded `/dashboard` redirect call sites outside the dashboard page itself are not touched.
- No per-role customization of the fallback order beyond what `getFirstVisiblePath` already does by walking the existing role-filtered list.

## Testing

- `lib/dashboard-nav-items.test.ts`: `getFirstVisiblePath` — returns the first role-eligible, non-hidden item; skips a hidden one and returns the next; returns `null` when everything for a role is hidden; respects the dealer-subscription special case for Upgrade.
- `lib/custom-domain-pages.test.ts`: extend for the 6 new keys + `my_shop`'s 7-path bundle (no duplicate keys, correct group values, `my_shop`'s paths array has exactly 7 entries).
- `lib/custom-domains.test.ts`: extend `getServiceRedirect`/`isPathAllowedForService` tests for a multi-path entry (hiding `my_shop` blocks all 7 of its paths, not just `/dashboard/my-shop`).
- `app/dashboard/page.tsx`, `app/dashboard/unavailable/page.tsx`, `components/layout/sidebar.tsx`: no automated tests (established convention) — verified via `npx tsc --noEmit` plus careful reading and a live check.
