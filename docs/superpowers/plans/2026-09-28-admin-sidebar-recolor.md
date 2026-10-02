# Admin Sidebar Recolor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admin users a fixed-navy sidebar (reusing the unused `--admin-sidebar` tokens from Phase 1a), while `default` (plain user) and `dealer` skins stay pixel-identical to today, by extracting `components/layout/sidebar.tsx`'s ~33 duplicated inline ternaries into one pure, unit-tested function.

**Architecture:** A new `lib/sidebar-theme.ts` exports `sidebarSkinClasses(skin)`, returning a 9-field object of class strings for one of 3 skins (`'default' | 'dealer' | 'admin'`). `sidebar.tsx` computes `skin` once (`userRole === 'dealer' ? 'dealer' : isAdmin ? 'admin' : 'default'`) and every call site that currently re-derives the same 2-way ternary reads a field off that one object instead. `default`/`dealer` values are the verified-exact current literals (regression guard); only `admin` is new.

**Tech Stack:** Next.js 15, TypeScript, Tailwind CSS, Vitest, existing `cn()` helper.

**All 9 fields and their exact values per skin** (verified against the current file with `grep`, not from memory):

| Field | `default` (current, unchanged) | `dealer` (current, unchanged) | `admin` (new) |
|---|---|---|---|
| `container` | `bg-sidebar text-sidebar-foreground border-r border-sidebar-border` | `bg-sidebar text-sidebar-foreground border-r border-sidebar-border` | `bg-admin-sidebar text-admin-sidebar-foreground border-r border-white/10` |
| `logoSectionBorder` | `border-sidebar-border` | `border-white/10` | `border-white/10` |
| `userIdentityText` | `text-muted-foreground` | `text-primary` | `text-white/70` |
| `collapseButtonHover` | `text-sidebar-foreground hover:bg-accent` | `text-sidebar-foreground hover:bg-sidebar-accent` | `text-white hover:bg-white/10` |
| `navLinkActive` | `bg-primary/10 text-primary font-medium` | `bg-sidebar-accent text-sidebar-accent-foreground shadow-lg` | `bg-white/12 text-white font-medium` |
| `navLinkInactive` | `text-sidebar-foreground hover:bg-accent` | `text-primary hover:bg-card/10` | `text-white/65 hover:bg-white/8 hover:text-white` |
| `sectionBorder` | `border-sidebar-border` | `border-white/10` | `border-white/10` |
| `sectionLabelText` | `text-muted-foreground` | `text-primary/80` | `text-white/40` |
| `logoutText` | `text-sidebar-foreground hover:bg-destructive/10 hover:text-destructive` | `text-sidebar-foreground hover:bg-destructive/10 hover:text-destructive` | `text-white/80 hover:bg-destructive/10 hover:text-destructive` |

Note `container`/`logoutText` happen to be identical across `default`/`dealer` today (verified: the current code literally has the same ternary on both branches) — this is existing, harmless duplication in the source, not a mistake in this table. Keep them as distinct fields anyway (matches the approved design spec's interface).

**Local verification, every task:** start/confirm the dev server and check the real local URL, not just typecheck/build passing.

---

### Task 1: `lib/sidebar-theme.ts` + tests

**Files:**
- Create: `lib/sidebar-theme.ts`
- Create: `lib/sidebar-theme.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/sidebar-theme.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sidebarSkinClasses } from './sidebar-theme'

describe('sidebarSkinClasses', () => {
  it('returns the exact current literal classes for "default" (regression guard)', () => {
    expect(sidebarSkinClasses('default')).toEqual({
      container: 'bg-sidebar text-sidebar-foreground border-r border-sidebar-border',
      logoSectionBorder: 'border-sidebar-border',
      userIdentityText: 'text-muted-foreground',
      collapseButtonHover: 'text-sidebar-foreground hover:bg-accent',
      navLinkActive: 'bg-primary/10 text-primary font-medium',
      navLinkInactive: 'text-sidebar-foreground hover:bg-accent',
      sectionBorder: 'border-sidebar-border',
      sectionLabelText: 'text-muted-foreground',
      logoutText: 'text-sidebar-foreground hover:bg-destructive/10 hover:text-destructive',
    })
  })

  it('returns the exact current literal classes for "dealer" (regression guard)', () => {
    expect(sidebarSkinClasses('dealer')).toEqual({
      container: 'bg-sidebar text-sidebar-foreground border-r border-sidebar-border',
      logoSectionBorder: 'border-white/10',
      userIdentityText: 'text-primary',
      collapseButtonHover: 'text-sidebar-foreground hover:bg-sidebar-accent',
      navLinkActive: 'bg-sidebar-accent text-sidebar-accent-foreground shadow-lg',
      navLinkInactive: 'text-primary hover:bg-card/10',
      sectionBorder: 'border-white/10',
      sectionLabelText: 'text-primary/80',
      logoutText: 'text-sidebar-foreground hover:bg-destructive/10 hover:text-destructive',
    })
  })

  it('returns the new fixed-navy classes for "admin"', () => {
    expect(sidebarSkinClasses('admin')).toEqual({
      container: 'bg-admin-sidebar text-admin-sidebar-foreground border-r border-white/10',
      logoSectionBorder: 'border-white/10',
      userIdentityText: 'text-white/70',
      collapseButtonHover: 'text-white hover:bg-white/10',
      navLinkActive: 'bg-white/12 text-white font-medium',
      navLinkInactive: 'text-white/65 hover:bg-white/8 hover:text-white',
      sectionBorder: 'border-white/10',
      sectionLabelText: 'text-white/40',
      logoutText: 'text-white/80 hover:bg-destructive/10 hover:text-destructive',
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/sidebar-theme.test.ts`
Expected: FAIL — `Failed to resolve import "./sidebar-theme"` (file doesn't exist yet).

- [ ] **Step 3: Create the minimal implementation**

Create `lib/sidebar-theme.ts`:

```ts
// Class-name mappings for the 3 sidebar skins (default/dealer/admin).
// default/dealer must always equal today's literal output -- they're a
// regression guard, not a design decision, while admin is new.
export type SidebarSkin = 'default' | 'dealer' | 'admin'

export interface SidebarSkinClasses {
  container: string
  logoSectionBorder: string
  userIdentityText: string
  collapseButtonHover: string
  navLinkActive: string
  navLinkInactive: string
  sectionBorder: string
  sectionLabelText: string
  logoutText: string
}

const SKIN_CLASSES: Record<SidebarSkin, SidebarSkinClasses> = {
  default: {
    container: 'bg-sidebar text-sidebar-foreground border-r border-sidebar-border',
    logoSectionBorder: 'border-sidebar-border',
    userIdentityText: 'text-muted-foreground',
    collapseButtonHover: 'text-sidebar-foreground hover:bg-accent',
    navLinkActive: 'bg-primary/10 text-primary font-medium',
    navLinkInactive: 'text-sidebar-foreground hover:bg-accent',
    sectionBorder: 'border-sidebar-border',
    sectionLabelText: 'text-muted-foreground',
    logoutText: 'text-sidebar-foreground hover:bg-destructive/10 hover:text-destructive',
  },
  dealer: {
    container: 'bg-sidebar text-sidebar-foreground border-r border-sidebar-border',
    logoSectionBorder: 'border-white/10',
    userIdentityText: 'text-primary',
    collapseButtonHover: 'text-sidebar-foreground hover:bg-sidebar-accent',
    navLinkActive: 'bg-sidebar-accent text-sidebar-accent-foreground shadow-lg',
    navLinkInactive: 'text-primary hover:bg-card/10',
    sectionBorder: 'border-white/10',
    sectionLabelText: 'text-primary/80',
    logoutText: 'text-sidebar-foreground hover:bg-destructive/10 hover:text-destructive',
  },
  admin: {
    container: 'bg-admin-sidebar text-admin-sidebar-foreground border-r border-white/10',
    logoSectionBorder: 'border-white/10',
    userIdentityText: 'text-white/70',
    collapseButtonHover: 'text-white hover:bg-white/10',
    navLinkActive: 'bg-white/12 text-white font-medium',
    navLinkInactive: 'text-white/65 hover:bg-white/8 hover:text-white',
    sectionBorder: 'border-white/10',
    sectionLabelText: 'text-white/40',
    logoutText: 'text-white/80 hover:bg-destructive/10 hover:text-destructive',
  },
}

export function sidebarSkinClasses(skin: SidebarSkin): SidebarSkinClasses {
  return SKIN_CLASSES[skin]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/sidebar-theme.test.ts`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: See it locally**

Run: `npm run dev` (leave it running for the rest of this plan)
Open: `http://localhost:3000` in your browser.
Expected: no visible change anywhere yet — this file isn't consumed by `sidebar.tsx` until Task 3.

- [ ] **Step 7: Commit**

```bash
git add lib/sidebar-theme.ts lib/sidebar-theme.test.ts
git commit -m "feat(sidebar): add sidebarSkinClasses with verified-exact default/dealer values + new admin skin

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Icon swaps

**Files:**
- Modify: `components/layout/sidebar.tsx:13,16,68,75`

- [ ] **Step 1: Confirm current lines before editing**

Run: `sed -n '12,17p;67,69p;74,76p' components/layout/sidebar.tsx`
Expected to see `Home,` on line 13, `Star,` on line 16 (inside the `lucide-react` import block), and the two menu-item objects using `icon: Home` (Dashboard, line 68) and `icon: Star` (AFA Orders, line 75). If these don't match, stop and report NEEDS_CONTEXT rather than guessing.

- [ ] **Step 2: Swap the imports**

In the `lucide-react` import block (starts at line 12 `import {`), change:
```ts
  Home,
```
to:
```ts
  Layers,
```
and change:
```ts
  Star,
```
to:
```ts
  IdCard,
```
(Same position in the import list, just the name — don't reorder the other imports.)

- [ ] **Step 3: Update the two menu-item references**

Line 68, change:
```ts
  { href: "/dashboard", label: "Dashboard", icon: Home, roles: ["user", "admin", "dealer"] },
```
to:
```ts
  { href: "/dashboard", label: "Dashboard", icon: Layers, roles: ["user", "admin", "dealer"] },
```

Line 75, change:
```ts
  { href: "/dashboard/afa-orders", label: "AFA Orders", icon: Star, roles: ["user", "admin", "dealer"] },
```
to:
```ts
  { href: "/dashboard/afa-orders", label: "AFA Orders", icon: IdCard, roles: ["user", "admin", "dealer"] },
```

- [ ] **Step 4: Confirm no other usages of `Home`/`Star` remain in this file**

Run: `grep -n "\bHome\b\|\bStar\b" components/layout/sidebar.tsx`
Expected: no output (both were only used in the import and their one respective menu item). If either name still appears somewhere else in the file, stop — you may have swapped an icon that's used in more than one place, which needs a different fix (add the new icon as an additional import rather than replacing).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (both `Layers` and `IdCard` are real exports of `lucide-react`, already a dependency of this project).

- [ ] **Step 6: See it locally**

With the dev server running, open `http://localhost:3000/dashboard` and log in as any user. Confirm the sidebar's "Dashboard" item now shows a stacked-layers icon (not a house), and "AFA Orders" shows an ID-card icon (not a star). This is visible to every role today, before Task 3's recolor — a good isolated checkpoint.

- [ ] **Step 7: Commit**

```bash
git add components/layout/sidebar.tsx
git commit -m "feat(sidebar): swap Dashboard/AFA Orders icons to Layers/IdCard

Closer visual match to Apex Prime's own sidebar, confirmed against a
live screenshot. Everything else keeps its current lucide-react icon.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire the skin + replace the 9 structural/chrome ternaries

**Files:**
- Modify: `components/layout/sidebar.tsx` (multiple exact locations, listed below)

- [ ] **Step 1: Add the import**

Near the top of `components/layout/sidebar.tsx`, alongside the other `@/` imports (e.g. near `import { useIsAdmin } from "@/hooks/use-admin"`), add:

```ts
import { sidebarSkinClasses, type SidebarSkin } from "@/lib/sidebar-theme"
```

- [ ] **Step 2: Compute `skin` and `c` once**

Find this block (currently around line 114-116):
```ts
  const [dealerHasSubscription, setDealerHasSubscription] = useState(false)
  const [roleLoading, setRoleLoading] = useState(true)

  const handleLogout = async () => {
```

Insert 2 new lines between the `useState` line and the blank line before `handleLogout`:
```ts
  const [dealerHasSubscription, setDealerHasSubscription] = useState(false)
  const [roleLoading, setRoleLoading] = useState(true)
  const skin: SidebarSkin = userRole === 'dealer' ? 'dealer' : isAdmin ? 'admin' : 'default'
  const c = sidebarSkinClasses(skin)

  const handleLogout = async () => {
```

(`isAdmin` is already destructured earlier in this component from `useIsAdmin()`; `userRole` is the existing local state a few lines above this block. No new data fetching.)

- [ ] **Step 3: Replace the container ternary**

Find (currently lines 286-295):
```tsx
      <div
        className={cn(
          "h-screen flex flex-col fixed left-0 top-0 z-40 transition-all duration-300 ease-in-out",
          userRole === 'dealer'
            ? "bg-sidebar text-sidebar-foreground border-r border-sidebar-border"
            : "bg-sidebar text-sidebar-foreground border-r border-sidebar-border",
          isOpen ? "w-64" : "w-20",
          isMobile && !isOpen && "-translate-x-full"
        )}
      >
```

Replace with:
```tsx
      <div
        className={cn(
          "h-screen flex flex-col fixed left-0 top-0 z-40 transition-all duration-300 ease-in-out",
          c.container,
          isOpen ? "w-64" : "w-20",
          isMobile && !isOpen && "-translate-x-full"
        )}
      >
```

- [ ] **Step 4: Replace the logo section border**

Find (currently lines 297-300):
```tsx
        <div className={cn(
          "p-6 border-b",
          userRole === 'dealer' ? "border-white/10" : "border-sidebar-border"
        )}>
```

Replace with:
```tsx
        <div className={cn(
          "p-6 border-b",
          c.logoSectionBorder
        )}>
```

- [ ] **Step 5: Replace the user-identity text color** (the `{user?.email}` line beneath the logo, not the "DATAGOD" site-name heading itself — a code review on Task 1 caught that the field name `siteNameText`/`userIdentityText` was misleading before this rename)

Find (currently lines 316-320):
```tsx
                <p className={cn(
                  "text-xs",
                  userRole === 'dealer' ? "text-primary" : "text-muted-foreground"
                )}>{user?.email || "User"}</p>
```

Replace with:
```tsx
                <p className={cn(
                  "text-xs",
                  c.userIdentityText
                )}>{user?.email || "User"}</p>
```

- [ ] **Step 6: Replace the collapse button hover**

Find (currently lines 329-336):
```tsx
            <Button
              onClick={() => setIsOpen(!isOpen)}
              variant="ghost"
              size="icon"
              className={cn(
                "w-full flex justify-center",
                userRole === 'dealer' ? "text-sidebar-foreground hover:bg-sidebar-accent" : "text-sidebar-foreground hover:bg-accent"
              )}
```

Replace with:
```tsx
            <Button
              onClick={() => setIsOpen(!isOpen)}
              variant="ghost"
              size="icon"
              className={cn(
                "w-full flex justify-center",
                c.collapseButtonHover
              )}
```

- [ ] **Step 7: Replace the 2 section wrapper borders + 2 section label texts**

There are 2 near-identical pairs — the SHOP section (currently lines 410-418) and the ADMIN section (currently lines 454-462). Find each:

```tsx
            <div className={cn(
              "pt-4 mt-4 border-t",
              userRole === 'dealer' ? "border-white/10" : "border-sidebar-border"
            )}>
              {isOpen && (
                <p className={cn(
                  "text-xs font-semibold px-3 mb-2",
                  userRole === 'dealer' ? "text-primary/80" : "text-muted-foreground"
                )}>SHOP</p>
              )}
```

Replace with (same for the ADMIN block below it, just keep its `>ADMIN<` text unchanged):
```tsx
            <div className={cn(
              "pt-4 mt-4 border-t",
              c.sectionBorder
            )}>
              {isOpen && (
                <p className={cn(
                  "text-xs font-semibold px-3 mb-2",
                  c.sectionLabelText
                )}>SHOP</p>
              )}
```

Do the same replacement for the ADMIN section block (the one containing `>ADMIN<` instead of `>SHOP<`, a bit further down) — identical ternary shape, just leave its `ADMIN` label text untouched.

- [ ] **Step 8: Replace the bottom Community/Logout wrapper border**

Find (currently around lines 1140-1145 — note this one has unusual spacing/line-break style in the source, `< div` with a space, matching it exactly):
```tsx
        < div className={
          cn(
            "p-4 pb-24 md:pb-4 border-t space-y-2",
            userRole === 'dealer' ? "border-white/10" : "border-sidebar-border"
          )
        }>
```

Replace with:
```tsx
        < div className={
          cn(
            "p-4 pb-24 md:pb-4 border-t space-y-2",
            c.sectionBorder
          )
        }>
```

- [ ] **Step 9: Replace the logout button classes**

Find (currently around line 1162-1168):
```tsx
          <Button
            variant="ghost"
            className={cn(
              "w-full justify-start gap-3",
              userRole === 'dealer' ? "text-sidebar-foreground hover:bg-destructive/10 hover:text-destructive" : "text-sidebar-foreground hover:bg-destructive/10 hover:text-destructive",
              !isOpen && "justify-center"
            )}
```

Replace with:
```tsx
          <Button
            variant="ghost"
            className={cn(
              "w-full justify-start gap-3",
              c.logoutText,
              !isOpen && "justify-center"
            )}
```

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (The ~31 nav-link ternaries are untouched until Task 4 — they still reference `userRole`, which is still declared, so this compiles fine as an intermediate state.)

- [ ] **Step 11: See it locally**

With the dev server running, open `http://localhost:3000/dashboard` logged in as a plain (non-admin, non-dealer) user. Confirm the sidebar looks **completely unchanged** from before this task (container/borders/text colors are byte-identical `default` values). If you have a dealer test account, check `/dashboard` as a dealer too — also unchanged.

**Correction (caught by code review, worth knowing even though this plan proceeds straight to Task 4 next):** unlike this step originally claimed, an *admin* user WOULD see a real, visible change right now — a half-navy/half-default sidebar. 7 of the 9 fields wired in this task (`container`, `logoSectionBorder`, `userIdentityText`, `collapseButtonHover`, `sectionBorder`, `sectionLabelText`, `logoutText`) already branch on `isAdmin`, but the ~31 nav-link ternaries (still untouched until Task 4) only branch on `userRole === 'dealer'` — so an admin gets the new navy container/borders with the OLD light-themed nav-link colors on top, a broken-looking intermediate state. This is safe only because Task 4 lands in the same uninterrupted session before anything is pushed — do not push/deploy after Task 3 alone.

- [ ] **Step 12: Commit**

```bash
git add components/layout/sidebar.tsx
git commit -m "feat(sidebar): wire skin computation, replace 9 structural ternaries with sidebarSkinClasses

default/dealer render byte-identical output to before -- only the
now-unused-until-Task-4 admin skin is new. Nav-link ternaries (~31
sites) are Task 4.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Replace all 31 nav-link ternaries

**Files:**
- Modify: `components/layout/sidebar.tsx` (31 exact locations, listed below)

Every one of these 31 sites has the exact same shape: a 3-line `userRole === 'dealer' ? (COND ? A : B) : (COND ? C : D),` block, where `COND` is either the loop variable `isActive` (2 sites) or a hardcoded `pathname === "<href>"` (29 sites, one per admin link). The fix is identical at every site: delete those 3 lines, replace with one line: `COND ? c.navLinkActive : c.navLinkInactive,` — keeping `COND` exactly as it already reads at that site (don't change what's being compared, only how the result maps to classes).

- [ ] **Step 1: Confirm all 31 sites before editing**

Run: `grep -n "bg-sidebar-accent text-sidebar-accent-foreground shadow-lg" components/layout/sidebar.tsx | wc -l`
Expected: `31`. If the count differs, something has changed since this plan was written — stop and report NEEDS_CONTEXT with the actual count and a fresh `grep -n` listing, rather than guessing which sites to touch.

- [ ] **Step 2: Worked example #1 — the `isActive` shape (2 sites: the `menuItems.map` loop and the `shopItems.map` loop)**

Find this exact block (appears twice, in two different `.map()` loops — once for `menuItems`, once for `shopItems`):
```tsx
                    className={cn(
                      "w-full justify-start gap-3 transition-all duration-200",
                      userRole === 'dealer'
                        ? (isActive ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-lg" : "text-primary hover:bg-card/10")
                        : (isActive ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                      !isOpen && "justify-center",
                      isLoading && "opacity-70"
                    )}
```

Replace both occurrences with:
```tsx
                    className={cn(
                      "w-full justify-start gap-3 transition-all duration-200",
                      isActive ? c.navLinkActive : c.navLinkInactive,
                      !isOpen && "justify-center",
                      isLoading && "opacity-70"
                    )}
```

- [ ] **Step 3: Worked example #2 — the `pathname === "<href>"` shape (the remaining 29 sites, one per hardcoded admin `<Link>`)**

Each of these 29 sites has this exact shape (only the href string inside the two `pathname === "..."` comparisons changes between sites — everything else, including indentation, is identical):
```tsx
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    userRole === 'dealer'
                      ? (pathname === "/admin/whatever" ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-lg" : "text-primary hover:bg-card/10")
                      : (pathname === "/admin/whatever" ? "bg-primary/10 text-primary font-medium" : "text-sidebar-foreground hover:bg-accent"),
                    !isOpen && "justify-center",
                    loadingPath === "/admin/whatever" && "opacity-70"
                  )}
```

Replace with (same href, both places it appeared inside the deleted ternary collapse into the one you keep):
```tsx
                  className={cn(
                    "w-full justify-start gap-3 transition-all duration-200",
                    pathname === "/admin/whatever" ? c.navLinkActive : c.navLinkInactive,
                    !isOpen && "justify-center",
                    loadingPath === "/admin/whatever" && "opacity-70"
                  )}
```

Apply this exact transformation — using each site's own real href in place of `/admin/whatever` above, which is already visible in that site's `loadingPath === "..."` line right below the ternary you're replacing — at every one of these hrefs (one site per href, in the order they appear in the file): `/admin`, `/admin/security`, `/admin/settings`, `/admin/settings/mtn`, `/admin/sms-health`, `/admin/sms`, `/admin/sms-centre`, `/admin/ai-settings`, `/admin/scheduled-tasks`, `/admin/subscriptions`, `/admin/subscribers`, `/admin/orders`, `/admin/api-keys`, `/admin/rate-limits`, `/admin/withdrawal-history`, `/admin/phone-verification`, `/admin/mtn-registration`, `/admin/user-phone-audit`, `/admin/airtime`, `/admin/airtime/settings`, `/admin/results-checker`, `/admin/results-check-requests`, `/admin/custom-domains`, `/admin/whatsapp`, `/admin/ai-knowledge`, `/admin/transactions`, `/admin/payment-attempts`, `/admin/payment-reverify`, `/admin/ussd-shops`.

That's 2 (Step 2) + 29 (Step 3) = 31 sites total, matching Step 1's count.

- [ ] **Step 4: Confirm no `userRole === 'dealer'` ternaries remain in the nav-link shape**

Run: `grep -n "bg-sidebar-accent text-sidebar-accent-foreground shadow-lg" components/layout/sidebar.tsx | wc -l`
Expected: `0` — every occurrence from Step 1 has been replaced. If it's not 0, list the remaining lines (`grep -n "bg-sidebar-accent text-sidebar-accent-foreground shadow-lg" components/layout/sidebar.tsx`) and fix the ones you missed before moving on.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the full test suite**

Run: `npm run test:run`
Expected: all tests pass (this task only touches JSX class composition, no logic change — nothing should break).

- [ ] **Step 7: See it locally — the real payoff**

With the dev server running:
1. Open `http://localhost:3000/dashboard` as a plain user — sidebar should look completely unchanged (still the `default` skin).
2. Log in as an admin and open `http://localhost:3000/dashboard` — the ENTIRE sidebar (main items, SHOP section, ADMIN section, active-page highlight, logout) should now render fixed dark-navy with white text, matching the approved mockup. Click through a few nav items and confirm the active-item highlight (`bg-white/12`) tracks correctly.
3. Toggle the site's light/dark theme while viewing as admin — the sidebar should NOT change (fixed navy either way); only the main content area should respond to the toggle.
4. Navigate to any `/admin/*` page as that same admin — sidebar stays the same navy (it's role-based, not route-based, per the approved design).
5. If you have a dealer test account, confirm their sidebar is completely unchanged from before this plan (still their existing purple "Bold Telco" look).

- [ ] **Step 8: Commit**

```bash
git add components/layout/sidebar.tsx
git commit -m "feat(sidebar): replace all 31 nav-link ternaries with sidebarSkinClasses

Admins now get a fixed-navy sidebar across every page (role-based, not
route-based, per the approved design). default/dealer skins render
byte-identical output to before this whole plan.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Full verification pass

- [ ] **Step 1: Full test suite**

Run: `npm run test:run`
Expected: all tests pass, including the 3 new ones in `lib/sidebar-theme.test.ts`.

- [ ] **Step 2: Full typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: succeeds, no new warnings/errors attributable to these changes.

- [ ] **Step 4: Final local walkthrough**

With `npm run dev` running:
- Plain user on `/dashboard`: sidebar unchanged (still emerald/default).
- Dealer on `/dashboard` (if you have a test account): sidebar unchanged (still purple).
- Admin on `/dashboard` and 2-3 different `/admin/*` pages, in both light and dark theme: sidebar is fixed navy throughout, active-item highlight works, Dashboard shows the Layers icon, AFA Orders shows the IdCard icon, collapse/expand button still works.
- Confirm the sidebar's collapse/expand toggle button (unrelated to this plan) still works exactly as before for all 3 roles.

- [ ] **Step 5: Update the sidebar spec's status**

In `docs/superpowers/specs/2026-09-28-admin-sidebar-recolor-design.md`, change the `Status:` line from `Draft for review` to `Shipped`.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-09-28-admin-sidebar-recolor-design.md
git commit -m "docs(spec): mark admin sidebar recolor as shipped

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
