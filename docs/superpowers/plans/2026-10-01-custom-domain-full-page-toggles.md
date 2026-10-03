# Custom Domain Full Page Toggles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `hidden_pages` toggle system to cover every remaining sidebar page (19 keys total, up from 13), and make the dashboard land a user on the next visible page instead of a dead end when their expected destination is hidden.

**Architecture:** `ToggleablePage.path?: string` becomes `paths?: string[]` so one key can bundle sibling routes (My Shop's 7 pages as one unit). The sidebar's `menuItems`/`shopItems` data moves into a new shared module alongside a pure `pickFirstVisiblePath()` function; a new hook sources role/subscription/domain data and calls it; `app/dashboard/page.tsx` uses the hook to redirect onward (or to a new terminal "nothing available" page) when `dashboard_home` is hidden for the current domain.

**Tech Stack:** Next.js 15 App Router, TypeScript, React hooks, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-custom-domain-full-page-toggles-design.md` (extends `docs/superpowers/specs/2026-10-01-custom-domain-page-toggles-design.md`, live on `main`)

## Global Constraints

- `ToggleablePage.group` becomes `"auth" | "core" | "tools"` (was `"auth" | "dashboard"`).
- 6 new keys, exact group assignments: `dashboard_home`, `my_orders`, `transactions`, `profile`, `complaints`, `wallet` → `"core"`; `developer` → `"tools"`.
- `my_shop` (existing key) gains 6 more paths — its `paths` array becomes exactly: `/dashboard/my-shop`, `/dashboard/shop-orders`, `/dashboard/customers`, `/dashboard/shop-profit-logs`, `/dashboard/shop-pricing`, `/dashboard/shop-withdraw`, `/dashboard/shop-profile`.
- `shop_dashboard` (existing key) moves from the old `"dashboard"` group into `"tools"`.
- Services-gated pages (Data Packages, Buy Airtime, Results Checker, Bulk SMS) are explicitly **not** added to `TOGGLEABLE_PAGES` — they stay on the separate, untouched `services` mechanism.
- The 4 places `/dashboard` is hardcoded as a redirect target outside the dashboard page itself (`middleware.ts`, `GoogleAuthButton`, `role-guard.tsx`, the login form's default `redirectTo`) are **not** touched by this plan.
- `DEFAULT_HIDDEN_PAGES` (the admin UI's new-domain form default) stays exactly the original 9 dealer-tool keys — none of the 6 new keys or `my_shop`'s new paths are added to it.
- No automated tests exist for `components/layout/sidebar.tsx`, `hooks/use-first-visible-path.ts`, `app/dashboard/unavailable/page.tsx`, `app/dashboard/page.tsx`, `app/admin/custom-domains/page.tsx` (established convention) — verify those via `npx tsc --noEmit` plus careful reading.

## Review Focus

- Hiding `my_shop` must block all 7 of its bundled paths, not just `/dashboard/my-shop` — a partial bundle (e.g. the matching logic only checking the first array element) would silently leave 6 shop pages reachable.
- `pickFirstVisiblePath` must correctly combine all three independent gates (role membership, the dealer-subscription special case, and services/hidden_pages) rather than just one — a page that passes role but fails hidden_pages (or vice versa) must still be skipped.
- `pickFirstVisiblePath` must return `null` (not throw, not return a bogus path) when literally nothing is reachable for a role, so the "nothing available" fallback actually triggers instead of crashing or silently landing on a blocked page.
- The async role/subscription fetch inside `useFirstVisiblePath` must not fire the redirect before both have resolved — an early read of `dealerHasSubscription`'s default-`false` state would incorrectly skip "Upgrade" for a dealer who actually has a subscription, for one render.
- On the main site (no custom domain, `services: null`, `hiddenPages: []`), `pickFirstVisiblePath` must return `/dashboard` (the first menuItem) for every role that can see it — a true no-op, since nothing there is gated at all today.

---

### Task 1: Registry expansion

**Files:**
- Modify: `lib/custom-domain-pages.ts`
- Test: `lib/custom-domain-pages.test.ts`

**Interfaces:**
- Produces: `ToggleablePage.paths?: string[]` (renamed from `path?: string`), `ToggleablePage.group: "auth" | "core" | "tools"` (was `"auth" | "dashboard"`), 19 total entries. Consumed by Task 2 (`lib/custom-domains.ts`), Task 3 (`lib/dashboard-nav-items.ts`), Task 9 (admin UI), and `app/dashboard/page.tsx` (already a consumer, fixed in Task 7).

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `lib/custom-domain-pages.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { TOGGLEABLE_PAGES } from "./custom-domain-pages"

describe("TOGGLEABLE_PAGES", () => {
  it("has no duplicate keys", () => {
    const keys = TOGGLEABLE_PAGES.map(p => p.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("has exactly 19 entries: 3 auth, 6 core, 10 tools", () => {
    expect(TOGGLEABLE_PAGES.filter(p => p.group === "auth")).toHaveLength(3)
    expect(TOGGLEABLE_PAGES.filter(p => p.group === "core")).toHaveLength(6)
    expect(TOGGLEABLE_PAGES.filter(p => p.group === "tools")).toHaveLength(10)
  })

  it("includes exactly the 9 original dealer-tool paths plus the new Developer/API tool", () => {
    const toolPaths = TOGGLEABLE_PAGES
      .filter(p => p.group === "tools" && p.key !== "my_shop")
      .flatMap(p => p.paths ?? [])
    expect(toolPaths.slice().sort()).toEqual([
      "/dashboard/afa-orders",
      "/dashboard/buy-stock",
      "/dashboard/developer",
      "/dashboard/payment-reverify",
      "/dashboard/shop-dashboard",
      "/dashboard/sub-agent-catalog",
      "/dashboard/sub-agents",
      "/dashboard/upgrade",
      "/dashboard/ussd-shop",
    ])
  })

  it("has no paths for the 3 standalone auth-group entries", () => {
    const authEntries = TOGGLEABLE_PAGES.filter(p => p.group === "auth")
    expect(authEntries.map(p => p.key).slice().sort()).toEqual(["guest_purchase", "join_channel", "landing_page"])
    expect(authEntries.every(p => p.paths === undefined)).toBe(true)
  })

  it("wallet has a single path and sits in the core group", () => {
    const wallet = TOGGLEABLE_PAGES.find(p => p.key === "wallet")
    expect(wallet?.paths).toEqual(["/dashboard/wallet"])
    expect(wallet?.group).toBe("core")
  })

  it("the 5 other core keys each have exactly one path", () => {
    const coreKeys = ["dashboard_home", "my_orders", "transactions", "profile", "complaints"]
    for (const key of coreKeys) {
      const entry = TOGGLEABLE_PAGES.find(p => p.key === key)
      expect(entry?.paths).toHaveLength(1)
    }
  })

  it("my_shop bundles exactly its 7 routes (Overview + 6 sibling pages) as one unit", () => {
    const myShop = TOGGLEABLE_PAGES.find(p => p.key === "my_shop")
    expect(myShop?.paths?.slice().sort()).toEqual([
      "/dashboard/customers",
      "/dashboard/my-shop",
      "/dashboard/shop-orders",
      "/dashboard/shop-pricing",
      "/dashboard/shop-profile",
      "/dashboard/shop-profit-logs",
      "/dashboard/shop-withdraw",
    ])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/custom-domain-pages.test.ts`
Expected: FAIL — the current registry still uses `path` (singular) and the `"dashboard"` group value, so every assertion above mismatches.

- [ ] **Step 3: Implement the registry**

Replace the entire contents of `lib/custom-domain-pages.ts`:

```ts
export interface ToggleablePage {
  key: string
  label: string
  group: "auth" | "core" | "tools"
  // Present only for entries with one or more dedicated routes — drives
  // uniform middleware blocking + nav filtering (see getServiceRedirect /
  // isPathAllowedForService in lib/custom-domains.ts). Absent for the 3
  // entries gated at a specific render site instead of a whole route. An
  // array (not a single string) so one key can bundle sibling routes as
  // one unit — e.g. my_shop's 7 pages all hide/show together.
  paths?: string[]
}

export const TOGGLEABLE_PAGES: ToggleablePage[] = [
  { key: "landing_page",   label: "Landing Page",        group: "auth" },
  { key: "guest_purchase", label: "Buy as Guest Button",  group: "auth" },
  { key: "join_channel",   label: "Join Channel Button",  group: "auth" },

  { key: "dashboard_home", label: "Dashboard Home",  group: "core", paths: ["/dashboard"] },
  { key: "my_orders",      label: "My Orders",       group: "core", paths: ["/dashboard/my-orders"] },
  { key: "transactions",   label: "Transactions",    group: "core", paths: ["/dashboard/transactions"] },
  { key: "profile",        label: "Profile",         group: "core", paths: ["/dashboard/profile"] },
  { key: "complaints",     label: "My Complaints",   group: "core", paths: ["/dashboard/complaints"] },
  { key: "wallet",         label: "Wallet & Top-Up", group: "core", paths: ["/dashboard/wallet"] },

  { key: "developer",          label: "Developer / API",        group: "tools", paths: ["/dashboard/developer"] },
  { key: "afa_orders",         label: "AFA Registration",       group: "tools", paths: ["/dashboard/afa-orders"] },
  { key: "upgrade",            label: "Upgrade / Dealer Plans", group: "tools", paths: ["/dashboard/upgrade"] },
  { key: "my_shop",            label: "My Shop",                group: "tools", paths: [
    "/dashboard/my-shop", "/dashboard/shop-orders", "/dashboard/customers",
    "/dashboard/shop-profit-logs", "/dashboard/shop-pricing",
    "/dashboard/shop-withdraw", "/dashboard/shop-profile",
  ] },
  { key: "shop_dashboard",     label: "Shop Dashboard",         group: "tools", paths: ["/dashboard/shop-dashboard"] },
  { key: "sub_agents",         label: "Sub-Agents",             group: "tools", paths: ["/dashboard/sub-agents"] },
  { key: "sub_agent_catalog",  label: "Sub-Agent Catalog",      group: "tools", paths: ["/dashboard/sub-agent-catalog"] },
  { key: "ussd_shop",          label: "USSD Shop",              group: "tools", paths: ["/dashboard/ussd-shop"] },
  { key: "payment_reverify",   label: "Payment Re-verify",      group: "tools", paths: ["/dashboard/payment-reverify"] },
  { key: "buy_stock",          label: "Buy Stock",              group: "tools", paths: ["/dashboard/buy-stock"] },
]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/custom-domain-pages.test.ts`
Expected: PASS (all 7 cases)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: Errors in every other file that reads `.path` on a `ToggleablePage` (`lib/custom-domains.ts`, `app/dashboard/page.tsx`) — this is expected at this point in the plan; Tasks 2 and 7 fix them. Confirm there are no errors specifically inside `lib/custom-domain-pages.ts` or its test.

- [ ] **Step 6: Commit**

```bash
git add lib/custom-domain-pages.ts lib/custom-domain-pages.test.ts
git commit -m "feat(custom-domains): expand the page registry to 19 keys, support multi-path bundles"
```

---

### Task 2: `lib/custom-domains.ts` — match against bundled paths

**Files:**
- Modify: `lib/custom-domains.ts:55`
- Test: `lib/custom-domains.test.ts`

**Interfaces:**
- Consumes: `ToggleablePage.paths?: string[]` (Task 1).
- Produces: `getServiceRedirect`/`isPathAllowedForService` unchanged signatures, but now correctly block every path a hidden key's `paths` array lists, not just a single one. Consumed by Task 3 (`pickFirstVisiblePath`), `components/layout/sidebar.tsx`, `middleware.ts` (both already call these functions, no change needed at those call sites).

- [ ] **Step 1: Write the failing test**

Add to `lib/custom-domains.test.ts`, inside the `describe("getServiceRedirect", ...)` block, after the existing `"redirects /dashboard/wallet when wallet is hidden..."` test:

```ts
  it("hiding my_shop blocks all 7 of its bundled paths, not just /dashboard/my-shop", () => {
    expect(getServiceRedirect("/dashboard/my-shop", ["airtime"], ["my_shop"])).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/shop-orders", ["airtime"], ["my_shop"])).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/customers", ["airtime"], ["my_shop"])).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/shop-profit-logs", ["airtime"], ["my_shop"])).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/shop-pricing", ["airtime"], ["my_shop"])).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/shop-withdraw", ["airtime"], ["my_shop"])).toBe("/dashboard/airtime")
    expect(getServiceRedirect("/dashboard/shop-profile", ["airtime"], ["my_shop"])).toBe("/dashboard/airtime")
  })

  it("does not block my_shop's paths when my_shop is not in hiddenPages", () => {
    expect(getServiceRedirect("/dashboard/shop-pricing", ["airtime"], [])).toBeNull()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/custom-domains.test.ts`
Expected: FAIL — `lib/custom-domains.ts:55` still reads `p.path` (now `undefined` on every entry after Task 1's rename), so `hiddenPaths` is always empty and nothing ever matches.

- [ ] **Step 3: Implement the change**

Replace line 55:

```ts
  const hiddenPaths = TOGGLEABLE_PAGES.filter(p => p.path && hiddenPages.includes(p.key)).map(p => p.path!)
```

with:

```ts
  const hiddenPaths = TOGGLEABLE_PAGES.filter(p => p.paths && hiddenPages.includes(p.key)).flatMap(p => p.paths!)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/custom-domains.test.ts`
Expected: PASS (every test in the file, including all pre-existing ones)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: Errors only in `app/dashboard/page.tsx` (fixed in Task 7). No errors inside `lib/custom-domains.ts` or its test.

- [ ] **Step 6: Commit**

```bash
git add lib/custom-domains.ts lib/custom-domains.test.ts
git commit -m "feat(custom-domains): match hidden-page redirects against bundled paths arrays"
```

---

### Task 3: Shared nav-item data + `pickFirstVisiblePath`

**Files:**
- Create: `lib/dashboard-nav-items.ts`
- Test: `lib/dashboard-nav-items.test.ts`

**Interfaces:**
- Consumes: `isPathAllowedForService` (`lib/custom-domains.ts`, already supports multi-path bundles per Task 2).
- Produces: `menuItems: NavItem[]`, `shopItems: NavItem[]` (same shape sidebar.tsx currently defines inline), `pickFirstVisiblePath(role: string | null, services: DomainService[] | null, hiddenPages: string[], dealerHasSubscription: boolean): string | null`. Consumed by Task 4 (`sidebar.tsx`) and Task 5 (`hooks/use-first-visible-path.ts`).

- [ ] **Step 1: Write the failing tests**

```ts
// lib/dashboard-nav-items.test.ts
import { describe, it, expect } from "vitest"
import { pickFirstVisiblePath } from "./dashboard-nav-items"

// NOTE on `services`: lib/custom-domains.ts's isPathAllowedForService/
// getServiceRedirect treat `services === null` OR `services === []` as
// "unrestricted — allow everything, including every hidden_pages entry".
// That's correct for the real main site (no custom domain row at all), but
// it means a test that wants hiddenPages to actually take effect MUST pass
// a concrete, non-empty services array — exactly like a real custom domain
// always has at least one service selected. Passing `null` anywhere below
// except the explicit "main site" test would silently make the hiddenPages
// argument a no-op and prove nothing.

describe("pickFirstVisiblePath", () => {
  it("returns the first menuItem for the main site (services null, nothing hidden)", () => {
    expect(pickFirstVisiblePath("user", null, [], false)).toBe("/dashboard")
  })

  it("skips a hidden dashboard_home and returns the next role-eligible, non-hidden item", () => {
    const allServices = ["data_bundles", "airtime", "results_checker", "bulk_sms"]
    expect(pickFirstVisiblePath("user", allServices, ["dashboard_home"], false)).toBe("/dashboard/data-packages")
  })

  it("respects role membership — a sub_agent lands on wallet, not on a results-checker page this domain doesn't even sell", () => {
    // services: ["data_bundles"] excludes results_checker, so
    // results-checker/results-check (the only sub_agent-eligible menuItems
    // ahead of wallet) are services-blocked, same as a real domain that
    // only sells data bundles.
    expect(pickFirstVisiblePath("sub_agent", ["data_bundles"], [], false)).toBe("/dashboard/wallet")
  })

  it("the dealer-subscription special case: a dealer with no active subscription skips Upgrade and lands on the next reachable item", () => {
    // services: ["bulk_sms"] is the one single-service selection that
    // excludes all 4 of menuItems' own services-gated paths (data-packages/
    // airtime/results-checker/results-check) — bulk_sms's own page,
    // /dashboard/sms, lives in shopItems, not menuItems — so this cleanly
    // isolates the hidden_pages-only items in between, same trick the
    // my_shop-bundle test below reuses.
    const hideEverythingBeforeUpgrade = [
      "dashboard_home", "my_orders", "afa_orders", "wallet", "transactions",
      "profile", "developer", "complaints",
    ]
    expect(pickFirstVisiblePath("dealer", ["bulk_sms"], hideEverythingBeforeUpgrade, false)).toBe("/dashboard/my-shop")
  })

  it("Upgrade IS reachable for a dealer who has an active subscription, once everything ahead of it is hidden", () => {
    const hideEverythingBeforeUpgrade = [
      "dashboard_home", "my_orders", "afa_orders", "wallet", "transactions",
      "profile", "developer", "complaints",
    ]
    expect(pickFirstVisiblePath("dealer", ["bulk_sms"], hideEverythingBeforeUpgrade, true)).toBe("/dashboard/upgrade")
  })

  it("hiding my_shop skips all 7 of its bundled routes, landing on the next distinct reachable item", () => {
    // services: ["data_bundles"] excludes bulk_sms, so shopItems' own
    // /dashboard/sms entry (not part of the my_shop bundle) is blocked for
    // an unrelated reason — proving the walk lands on /dashboard/ussd-shop
    // specifically because all 7 my_shop paths were skipped as one unit,
    // not because of where /dashboard/sms happens to sit in the list.
    const hidden = ["wallet", "profile", "developer", "my_shop"]
    expect(pickFirstVisiblePath("sub_agent", ["data_bundles"], hidden, false)).toBe("/dashboard/ussd-shop")
  })

  it("returns null when every reachable item for this role is hidden or services-gated away", () => {
    const hidden = [
      "wallet", "profile", "developer", "my_shop", "ussd_shop", "payment_reverify", "buy_stock",
    ]
    // services: ["data_bundles"] — sub_agent has no role access to
    // data-packages/airtime anyway, and results-checker/results-check are
    // services-blocked (results_checker not selected); every other
    // sub_agent-reachable item is in `hidden`.
    expect(pickFirstVisiblePath("sub_agent", ["data_bundles"], hidden, false)).toBeNull()
  })

  it("returns null for a null role (not yet loaded / signed out)", () => {
    expect(pickFirstVisiblePath(null, null, [], false)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/dashboard-nav-items.test.ts`
Expected: FAIL — `Cannot find module './dashboard-nav-items'`

- [ ] **Step 3: Implement the module**

```ts
// lib/dashboard-nav-items.ts
import {
  Layers, Package, ShoppingCart, IdCard, Wallet, History, User, AlertCircle,
  Store, Settings, Users, ShoppingBag, Zap, Sparkles, Smartphone, Activity,
  GraduationCap, Send, Code2, Tag, Banknote,
  type LucideIcon,
} from "lucide-react"
import { isPathAllowedForService, type DomainService } from "./custom-domains"

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  roles: string[]
}

export const menuItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: Layers, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/data-packages", label: "Data Packages", icon: Package, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/airtime", label: "Buy Airtime", icon: Smartphone, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/results-checker", label: "Results Checker", icon: GraduationCap, roles: ["user", "admin", "dealer", "sub_agent"] },
  { href: "/dashboard/results-check", label: "Check Results", icon: GraduationCap, roles: ["user", "admin", "dealer", "sub_agent"] },
  { href: "/dashboard/my-orders", label: "My Orders", icon: ShoppingCart, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/afa-orders", label: "AFA Orders", icon: IdCard, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/wallet", label: "Wallet", icon: Wallet, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/transactions", label: "Transactions", icon: History, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/profile", label: "Profile", icon: User, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/developer", label: "Developer / API", icon: Code2, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/complaints", label: "My Complaints", icon: AlertCircle, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/upgrade", label: "Upgrade to Dealer", icon: Sparkles, roles: ["user", "admin", "dealer"] },
]

export const shopItems: NavItem[] = [
  { href: "/dashboard/my-shop", label: "Overview", icon: Store, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-orders", label: "Orders", icon: ShoppingCart, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/customers", label: "Customers", icon: Users, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-profit-logs", label: "Profit Logs", icon: Activity, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-pricing", label: "Pricing", icon: Tag, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/sms", label: "SMS", icon: Send, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-withdraw", label: "Withdraw", icon: Banknote, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-profile", label: "Shop Profile", icon: Settings, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/ussd-shop", label: "USSD/WhatsApp Bot", icon: Smartphone, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/payment-reverify", label: "Payment Reverify", icon: Zap, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/sub-agents", label: "Sub-Agents", icon: Users, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/sub-agent-catalog", label: "Sub-Agent Catalog", icon: Package, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/buy-stock", label: "Buy Data", icon: ShoppingBag, roles: ["sub_agent"] },
]

/**
 * Walks menuItems then shopItems in order and returns the first href that
 * passes every filter sidebar.tsx itself already applies when rendering:
 * role membership, the one dealer-subscription special case (Upgrade is
 * hidden from a dealer with no active subscription), and the domain's
 * services/hidden_pages gating. Returns null if nothing qualifies (e.g.
 * every page for this role has been hidden) — callers fall back to
 * /dashboard/unavailable in that case.
 */
export function pickFirstVisiblePath(
  role: string | null,
  services: DomainService[] | null,
  hiddenPages: string[],
  dealerHasSubscription: boolean
): string | null {
  if (!role) return null
  const allItems = [...menuItems, ...shopItems]
  for (const item of allItems) {
    if (!item.roles.includes(role)) continue
    if (item.href === "/dashboard/upgrade" && role === "dealer" && !dealerHasSubscription) continue
    if (!isPathAllowedForService(item.href, services, hiddenPages)) continue
    return item.href
  }
  return null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/dashboard-nav-items.test.ts`
Expected: PASS (all 8 cases)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `lib/dashboard-nav-items.ts`. Errors remain in `components/layout/sidebar.tsx` (still has its own local, now-duplicate `menuItems`/`shopItems`, harmless duplication at this point) and `app/dashboard/page.tsx` (Task 7) — expected, not this task's problem.

- [ ] **Step 6: Commit**

```bash
git add lib/dashboard-nav-items.ts lib/dashboard-nav-items.test.ts
git commit -m "feat(custom-domains): extract shared nav items, add pickFirstVisiblePath"
```

---

### Task 4: Sidebar sources its nav items from the shared module

**Files:**
- Modify: `components/layout/sidebar.tsx:69-99` (replace the two local consts with an import), icon import list (`:13-53`)

**Interfaces:**
- Consumes: `menuItems`, `shopItems` (Task 3). No signature change to anything sidebar.tsx exports — this is a pure refactor.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace the local consts with an import**

Re-read the current file first to confirm lines 69-99 still match (this file was touched by the merge earlier today). Delete this exact block (currently lines 69-99, immediately before `export function Sidebar() {`):

```ts
const menuItems = [
  { href: "/dashboard", label: "Dashboard", icon: Layers, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/data-packages", label: "Data Packages", icon: Package, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/airtime", label: "Buy Airtime", icon: Smartphone, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/results-checker", label: "Results Checker", icon: GraduationCap, roles: ["user", "admin", "dealer", "sub_agent"] },
  { href: "/dashboard/results-check", label: "Check Results", icon: GraduationCap, roles: ["user", "admin", "dealer", "sub_agent"] },
  { href: "/dashboard/my-orders", label: "My Orders", icon: ShoppingCart, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/afa-orders", label: "AFA Orders", icon: IdCard, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/wallet", label: "Wallet", icon: Wallet, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/transactions", label: "Transactions", icon: History, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/profile", label: "Profile", icon: User, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/developer", label: "Developer / API", icon: Code2, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/complaints", label: "My Complaints", icon: AlertCircle, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/upgrade", label: "Upgrade to Dealer", icon: Sparkles, roles: ["user", "admin", "dealer"] },
]

const shopItems = [
  { href: "/dashboard/my-shop", label: "Overview", icon: Store, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-orders", label: "Orders", icon: ShoppingCart, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/customers", label: "Customers", icon: Users, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-profit-logs", label: "Profit Logs", icon: Activity, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-pricing", label: "Pricing", icon: Tag, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/sms", label: "SMS", icon: Send, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-withdraw", label: "Withdraw", icon: Banknote, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/shop-profile", label: "Shop Profile", icon: Settings, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/ussd-shop", label: "USSD/WhatsApp Bot", icon: Smartphone, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/payment-reverify", label: "Payment Reverify", icon: Zap, roles: ["user", "admin", "sub_agent", "dealer"] },
  { href: "/dashboard/sub-agents", label: "Sub-Agents", icon: Users, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/sub-agent-catalog", label: "Sub-Agent Catalog", icon: Package, roles: ["user", "admin", "dealer"] },
  { href: "/dashboard/buy-stock", label: "Buy Data", icon: ShoppingBag, roles: ["sub_agent"] },
]
```

Then add the replacement import right after the existing `import { isPathAllowedForService } from "@/lib/custom-domains"` line (currently line 8):

```ts
import { isPathAllowedForService } from "@/lib/custom-domains"
import { menuItems, shopItems } from "@/lib/dashboard-nav-items"
```

- [ ] **Step 2: Remove now-unused icon imports**

Run `npx eslint components/layout/sidebar.tsx` and remove any icon from the big `lucide-react` import block (`Layers, Package, ShoppingCart, ...`) that it flags as unused — these are icons that were only ever referenced by the two consts just removed. Do **not** remove an icon still flagged as used elsewhere in the file (e.g. in a button, badge, or other piece of this component's own JSX) — only ones ESLint actually reports as unused.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `components/layout/sidebar.tsx`. Errors remain only in `app/dashboard/page.tsx` (Task 7).

- [ ] **Step 4: Manual verification**

No automated test exists for this file (matches convention). Confirm by reading: `menuItems`/`shopItems` imported from `lib/dashboard-nav-items.ts` have the exact same shape (href/label/icon/roles) as what was removed — this is meant to be a behavior-preserving refactor, not a change to what renders.

- [ ] **Step 5: Commit**

```bash
git add components/layout/sidebar.tsx
git commit -m "refactor(custom-domains): sidebar sources its nav items from the shared module"
```

---

### Task 5: `useFirstVisiblePath` hook

**Files:**
- Create: `hooks/use-first-visible-path.ts`

**Interfaces:**
- Consumes: `pickFirstVisiblePath` (Task 3), `useUserRole` (`hooks/use-user-role.ts`, existing), `useDomainBranding` (existing).
- Produces: `useFirstVisiblePath(): { path: string | null; loading: boolean }`. Consumed by Task 7 (`app/dashboard/page.tsx`).

- [ ] **Step 1: Implement the hook**

```ts
// hooks/use-first-visible-path.ts
"use client"

import { useEffect, useState } from "react"
import { useUserRole } from "./use-user-role"
import { useDomainBranding } from "@/components/providers/domain-branding-provider"
import { supabase } from "@/lib/supabase"
import { pickFirstVisiblePath } from "@/lib/dashboard-nav-items"

export interface FirstVisiblePathResult {
  path: string | null
  loading: boolean
}

/**
 * Resolves the first sidebar page this signed-in user can actually reach on
 * the current domain — used by app/dashboard/page.tsx to redirect onward
 * when dashboard_home itself is hidden. Sources role (useUserRole) and the
 * dealer-active-subscription check independently of components/layout/
 * sidebar.tsx's own equivalent fetch, since this hook may run on a page
 * that never mounts the sidebar.
 */
export function useFirstVisiblePath(): FirstVisiblePathResult {
  const { role, loading: roleLoading } = useUserRole()
  const domainBranding = useDomainBranding()
  const [dealerHasSubscription, setDealerHasSubscription] = useState(false)
  const [subLoading, setSubLoading] = useState(true)

  useEffect(() => {
    if (roleLoading) return
    if (role !== "dealer") {
      setSubLoading(false)
      return
    }
    let cancelled = false
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) {
        if (!cancelled) setSubLoading(false)
        return
      }
      const { data: sub } = await supabase
        .from("user_subscriptions")
        .select("id")
        .eq("user_id", user.id)
        .eq("status", "active")
        .maybeSingle()
      if (!cancelled) {
        setDealerHasSubscription(!!sub)
        setSubLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [role, roleLoading])

  const loading = roleLoading || subLoading
  const path = loading
    ? null
    : pickFirstVisiblePath(role, domainBranding.services, domainBranding.hiddenPages, dealerHasSubscription)

  return { path, loading }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `hooks/use-first-visible-path.ts`. Errors remain only in `app/dashboard/page.tsx` (Task 7).

- [ ] **Step 3: Manual verification**

No automated tests exist for any hook in this codebase (confirmed convention — `hooks/*.test.ts` has zero matches). Confirm by reading: while `roleLoading` is true, `loading` stays `true` and `path` stays `null` — the hook never returns a premature result before role is known; once role resolves to something other than `"dealer"`, `subLoading` is immediately set `false` (the subscription fetch is skipped entirely, since only dealers need it).

- [ ] **Step 4: Commit**

```bash
git add hooks/use-first-visible-path.ts
git commit -m "feat(custom-domains): add useFirstVisiblePath hook"
```

---

### Task 6: The "nothing available" terminal page

**Files:**
- Create: `app/dashboard/unavailable/page.tsx`

**Interfaces:**
- Consumes: `useAuth` (existing, for `logout`).
- Produces: route `/dashboard/unavailable`. Consumed by Task 7 (`app/dashboard/page.tsx`, as a redirect target).

- [ ] **Step 1: Implement the page**

```tsx
// app/dashboard/unavailable/page.tsx
"use client"

import { AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/hooks/use-auth"

export default function DashboardUnavailablePage() {
  const { logout } = useAuth()

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <AlertCircle className="h-10 w-10 text-muted-foreground" />
      <h1 className="text-xl font-bold text-foreground">No features are currently available</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        This domain isn't currently configured to show any pages for your account. Please contact the site owner, or sign out and try a different account.
      </p>
      <Button onClick={() => logout()} variant="outline">Sign Out</Button>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/dashboard/unavailable/page.tsx`.

- [ ] **Step 3: Manual verification**

No automated test exists for this page (matches convention). Confirm by reading: this page does not import or render `DashboardLayout` (deliberately standalone, no sidebar) — a mostly-hidden sidebar would look broken if rendered here. It's still protected by `middleware.ts`'s existing `path.startsWith("/dashboard")` unauthenticated-user redirect, since `/dashboard/unavailable` matches that prefix — an unauthenticated visitor is bounced to login before ever reaching this page, same as any other dashboard route.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/unavailable/page.tsx
git commit -m "feat(custom-domains): add the dashboard_home-hidden terminal fallback page"
```

---

### Task 7: Wire the redirect-on-hidden logic into the dashboard page

**Files:**
- Modify: `app/dashboard/page.tsx` (imports, component body, the `visiblePromoServices` filter)

**Interfaces:**
- Consumes: `useFirstVisiblePath` (Task 5), `/dashboard/unavailable` (Task 6).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the import and the redirect-on-mount effect**

Re-read the current file first to confirm these anchors still match (this file was touched by both this morning's plan and today's merge). Replace this exact import line (currently line 21):

```ts
import { getServicePrimaryPath, isPageHidden } from "@/lib/custom-domains"
```

with:

```ts
import { getServicePrimaryPath, isPageHidden } from "@/lib/custom-domains"
import { useFirstVisiblePath } from "@/hooks/use-first-visible-path"
```

Then replace this exact block (currently lines 147-148, the start of `export default function DashboardPage()`'s body):

```ts
  const domainBranding = useDomainBranding()
  const primaryService = domainBranding.services?.[0] ?? null
```

with:

```ts
  const domainBranding = useDomainBranding()
  const primaryService = domainBranding.services?.[0] ?? null
  const { path: firstVisiblePath, loading: firstVisiblePathLoading } = useFirstVisiblePath()
  const dashboardHomeHidden = isPageHidden("dashboard_home", domainBranding.hiddenPages)

  useEffect(() => {
    if (!dashboardHomeHidden || firstVisiblePathLoading) return
    router.replace(firstVisiblePath ?? "/dashboard/unavailable")
  }, [dashboardHomeHidden, firstVisiblePathLoading, firstVisiblePath, router])
```

(`router` — from `useRouter()` at the top of this component — and `useEffect` are already imported/in scope in this file; `isPageHidden` is already imported on the line you just edited.)

- [ ] **Step 2: Guard the page's own render while the redirect is pending**

Replace this exact block (currently lines 449-458 — the existing "redirect happens in useEffect" guard, right before `const getGreeting = ...`):

```ts
  // Redirect happens in useEffect, but render nothing while waiting
  if (!user) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin text-[#1b388b]" />
        </div>
      </DashboardLayout>
    )
  }
```

with:

```ts
  // Redirect happens in useEffect, but render nothing while waiting
  if (!user) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin text-[#1b388b]" />
        </div>
      </DashboardLayout>
    )
  }

  // dashboard_home is hidden for this domain — useEffect above is
  // redirecting onward; render nothing but a spinner while that resolves.
  if (dashboardHomeHidden) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="w-8 h-8 animate-spin text-[#1b388b]" />
        </div>
      </DashboardLayout>
    )
  }
```

(`Loader2` and `DashboardLayout` are already imported in this file.)

- [ ] **Step 3: Fix the `visiblePromoServices` filter for the new `paths` array shape**

Re-read the current filter first to confirm it still matches (it was added in this morning's plan). Replace:

```ts
  const visiblePromoServices = PROMO_SERVICES.filter(svc => {
    const page = TOGGLEABLE_PAGES.find(p => p.path === svc.href)
    return !page || !isPageHidden(page.key, domainBranding.hiddenPages)
  })
```

with:

```ts
  const visiblePromoServices = PROMO_SERVICES.filter(svc => {
    const page = TOGGLEABLE_PAGES.find(p => p.paths?.includes(svc.href))
    return !page || !isPageHidden(page.key, domainBranding.hiddenPages)
  })
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: Zero errors project-wide — this is the last file with a pending reference to the old `.path` shape.

- [ ] **Step 5: Manual verification**

No automated test exists for this file (matches convention). Confirm by reading: on the main site and every existing custom domain (none of which have `dashboard_home` in `hidden_pages`, since it's a brand-new key absent from every existing row's array), `dashboardHomeHidden` is `false` for all of them — the new `useEffect` and early-return never fire, a true no-op. Confirm the early-return's loading spinner and the `useEffect`'s redirect target agree (both gated on the same `dashboardHomeHidden` value, computed once).

- [ ] **Step 6: Commit**

```bash
git add app/dashboard/page.tsx
git commit -m "feat(custom-domains): redirect to the next visible page when dashboard_home is hidden"
```

---

### Task 8: Admin UI — three groups

**Files:**
- Modify: `app/admin/custom-domains/page.tsx`

**Interfaces:**
- Consumes: `TOGGLEABLE_PAGES` with `group: "auth" | "core" | "tools"` (Task 1).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Replace the two-group checklist with three**

Re-read the current file first to confirm the two existing `.filter(p => p.group === "auth")` / `.filter(p => p.group === "dashboard")` blocks still match (added this morning). Replace:

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

with:

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
                  <Label>Visible Pages — Core Pages</Label>
                  <div className="space-y-2">
                    {TOGGLEABLE_PAGES.filter(p => p.group === "core").map(p => (
                      <label key={p.key} className="flex items-center gap-2 text-sm cursor-pointer">
                        <Checkbox checked={!form.hidden_pages.includes(p.key)} onCheckedChange={() => toggleHiddenPage(p.key)} />
                        {p.label}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Visible Pages — Dealer & Business Tools</Label>
                  <div className="space-y-2">
                    {TOGGLEABLE_PAGES.filter(p => p.group === "tools").map(p => (
                      <label key={p.key} className="flex items-center gap-2 text-sm cursor-pointer">
                        <Checkbox checked={!form.hidden_pages.includes(p.key)} onCheckedChange={() => toggleHiddenPage(p.key)} />
                        {p.label}
                      </label>
                    ))}
                  </div>
                </div>
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/admin/custom-domains/page.tsx`.

- [ ] **Step 3: Manual verification**

No automated test exists for this page (matches convention). Start the dev server, log in as admin, navigate to `/admin/custom-domains`, open the edit dialog for an existing domain, and confirm: three labeled groups render (Login/Signup/Homepage, Core Pages, Dealer & Business Tools), each showing the correct subset of the 19 keys, and the dialog (already scrollable from an earlier fix) comfortably fits all three.

- [ ] **Step 4: Commit**

```bash
git add app/admin/custom-domains/page.tsx
git commit -m "feat(custom-domains): split the admin checklist into 3 groups (auth, core, tools)"
```

---

### Task 9: End-to-end verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: the full feature (Tasks 1-8).
- Produces: nothing — final integration gate.

- [ ] **Step 1: Full suite + typecheck**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: every test passes (the pre-existing suite plus every new test from Tasks 1, 2, 3); the pre-existing `lib/order-health-service.test.ts` failures (9 of them, unrelated to this feature) are the only failures, matching the baseline confirmed throughout today's session; typecheck clean project-wide.

- [ ] **Step 2: Live check — hide Dashboard Home and confirm the fallback lands correctly**

Using the live admin UI on a real attached custom domain (e.g. `clingshub.com`): uncheck "Dashboard Home" (and leave everything else visible), save. Then, logged in as a user on that domain, navigate to `/dashboard` directly and confirm it redirects to the first other visible page (e.g. `/dashboard/data-packages` or whatever that domain's services/role make reachable) rather than showing dashboard content.

- [ ] **Step 3: Live check — hide everything reachable for a test role, confirm the terminal page**

On the same test domain, hide every page a test account's role can reach (all core + tools keys, plus set services to something that doesn't unlock any of the 4 core service pages for that role). Confirm visiting `/dashboard` lands on `/dashboard/unavailable`, shows the message and Sign Out button, and Sign Out actually works.

- [ ] **Step 4: Restore the test domain to its known-good state**

Re-check every box (empty `hidden_pages` array, or re-apply the domain's original configuration) so it's left exactly as it was before this plan's verification steps.

- [ ] **Step 5: Confirm the main site is unaffected**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" "https://www.datagod.store/dashboard"
```

Expected: `200` (or a redirect to login if not authenticated in this check), ordinary dashboard — untouched by any of this plan's changes, consistent with the "no-op for current main-site traffic" invariant every task in this plan individually verified.
