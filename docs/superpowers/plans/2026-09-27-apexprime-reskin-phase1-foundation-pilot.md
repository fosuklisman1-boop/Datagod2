# Apex Prime-Inspired Reskin — Foundation + Pilot Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the new navy/blue + amber "Apex Prime-inspired" design tokens and four reusable admin UI components (status pill, segmented pill toggle, gateway health card, page-header banner), then apply the page-header banner + status pill to the real Admin Dashboard hub page (`app/admin/page.tsx`) using its existing live stats — no fabricated data.

**Architecture:** New tokens are additive HSL custom properties in `app/globals.css`, defined only in `:root` (not `.dark`) so they're fixed/theme-independent by construction — no wrapper class needed. Each new component is a thin presentational `.tsx` wrapper over a pure, unit-tested class-name function in `lib/admin-theme.ts` (matching this codebase's existing test convention: `lib/*.test.ts` via Vitest, no component-render testing library installed).

**Tech Stack:** Next.js 15 (App Router), Tailwind CSS (HSL-token system), Vitest, existing `cn()` helper in `lib/utils.ts`.

**Out of scope (deliberately, discovered during planning — see note below):** Recoloring `components/layout/sidebar.tsx`. That file is a single ~1180-line component shared verbatim across `/dashboard/*` and `/admin/*` — an admin's sidebar always renders the same full item list (user items + admin section together) regardless of which page they're on, and it already branches per-role via ~25 repeated inline ternaries (`userRole === 'dealer' ? … : …`). Safely adding a third "admin" skin means deciding whether the switch is role-based or route-based and refactoring those ternaries into a shared helper — a real subsystem, not a quick add. It gets its own follow-up plan. `GatewayHealthCard` and `SegmentedPillToggle` are built and tested here as reusable primitives but are **not wired into a live page yet** — wiring `GatewayHealthCard` to real MTN provider status data is separate follow-up work (the data exists in `mtn_fulfillment_tracking`, but fetching/aggregating it is non-trivial and out of scope for a re-skin-only pass).

**Local verification, every task:** per direct instruction, every task ends with starting/confirming the dev server and opening the real local URL so you can see the change yourself before moving on — not just typecheck/build passing.

---

### Task 1: Add admin design tokens

**Files:**
- Modify: `app/globals.css` (add a new block after the existing `:root { … }` closing brace, i.e. after line 76, before `.dark {` starts at line 78)
- Modify: `tailwind.config.ts` (extend `colors`, near the existing `'brand-accent'` / `footer` entries around line 77-78)

- [ ] **Step 1: Add the new tokens to `app/globals.css`**

Insert this new block immediately after the `:root { … }` block closes (after line 76's `}`, before `.dark {` on line 78):

```css
/* ===========================================================================
   ADMIN TOKENS — Apex Prime-inspired navy/blue + amber identity.
   Defined ONLY in :root (never redefined in .dark) so they are fixed
   across both themes by construction — no wrapper class needed.
   Scope: admin panel only. Does not touch --primary/--success/--warning/
   --destructive/--mtn/--telecel/--at, which stay exactly as they are.
   =========================================================================== */
:root {
  --admin-sidebar: 222 47% 8%;        /* #0f1420 */
  --admin-sidebar-foreground: 0 0% 98%;
  --admin-banner-from: 224 76% 33%;   /* #1e3a8a */
  --admin-banner-to: 217 91% 53%;     /* #2563eb */
  --admin-accent: 217 91% 53%;        /* #2563eb */
  --admin-accent-soft: 214 95% 93%;   /* #dbeafe */
  --admin-amber: 38 92% 58%;          /* #f5a623 */
  --admin-orange: 25 95% 53%;         /* #f97316 -- secondary CTA buttons, unused until a follow-up plan wires a CTA into the banner */
}
```

Note: the design spec (§4.1) also lists a `--surface` token for a light-mode-only page-canvas color change. This plan deliberately does **not** add it — the pilot page's canvas stays on the app's existing `--background`/`--card` tokens. The Apex-inspired identity's defining traits are the sidebar, banner, and pill/badge patterns; a bespoke page-background tone is a minor difference not worth a new token + follow-up light/dark tuning pass in this narrow pilot. Revisit if it's missed once more pages are migrated.

- [ ] **Step 2: Wire the tokens into Tailwind**

In `tailwind.config.ts`, find the `colors: { … }` object (it has entries like `'brand-accent': 'hsl(var(--brand-accent))',` and `footer: 'hsl(var(--footer))',` right before `fontFamily:` starts at line 80). Add these four entries in the same place, same style:

```ts
        'admin-sidebar': {
          DEFAULT: 'hsl(var(--admin-sidebar))',
          foreground: 'hsl(var(--admin-sidebar-foreground))',
        },
        'admin-banner-from': 'hsl(var(--admin-banner-from))',
        'admin-banner-to': 'hsl(var(--admin-banner-to))',
        'admin-accent': {
          DEFAULT: 'hsl(var(--admin-accent))',
          soft: 'hsl(var(--admin-accent-soft))',
        },
        'admin-amber': 'hsl(var(--admin-amber))',
        'admin-orange': 'hsl(var(--admin-orange))',
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors (this is a CSS/config-only change).

- [ ] **Step 4: See it locally**

Run: `npm run dev` (leave it running)
Open: `http://localhost:3000/admin` in your browser.
Expected: page looks **completely unchanged** — these tokens aren't consumed by anything yet, this step only confirms the dev server still boots cleanly with the new CSS/config.

- [ ] **Step 5: Commit**

```bash
git add app/globals.css tailwind.config.ts
git commit -m "feat(admin): add navy/blue/amber design tokens for Apex Prime-inspired reskin

Additive only -- defined in :root only (not .dark) so they're fixed
across themes by construction. Nothing consumes them yet."
```

---

### Task 2: `StatusPill` component

**Files:**
- Create: `lib/admin-theme.ts`
- Create: `lib/admin-theme.test.ts`
- Create: `components/admin/status-pill.tsx`

- [ ] **Step 1: Write the failing test**

Create `lib/admin-theme.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { statusPillClasses } from './admin-theme'

describe('statusPillClasses', () => {
  it('returns success-token classes for "success"', () => {
    expect(statusPillClasses('success')).toBe('bg-success/10 text-success border border-success/30')
  })

  it('returns warning-token classes for "warning"', () => {
    expect(statusPillClasses('warning')).toBe('bg-warning/10 text-warning border border-warning/30')
  })

  it('returns destructive-token classes for "danger"', () => {
    expect(statusPillClasses('danger')).toBe('bg-destructive/10 text-destructive border border-destructive/30')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/admin-theme.test.ts`
Expected: FAIL — `Failed to resolve import "./admin-theme"` (file doesn't exist yet).

- [ ] **Step 3: Create `lib/admin-theme.ts` with the minimal implementation**

```ts
export type StatusPillVariant = 'success' | 'warning' | 'danger'

export function statusPillClasses(variant: StatusPillVariant): string {
  switch (variant) {
    case 'success':
      return 'bg-success/10 text-success border border-success/30'
    case 'warning':
      return 'bg-warning/10 text-warning border border-warning/30'
    case 'danger':
      return 'bg-destructive/10 text-destructive border border-destructive/30'
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/admin-theme.test.ts`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Create the component**

Create `components/admin/status-pill.tsx`:

```tsx
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { statusPillClasses, type StatusPillVariant } from '@/lib/admin-theme'

export function StatusPill({
  variant,
  children,
  className,
}: {
  variant: StatusPillVariant
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold',
        statusPillClasses(variant),
        className
      )}
    >
      {children}
    </span>
  )
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: See it locally**

This component isn't wired into a page yet (that happens in Task 7), so there's nothing new to see at `/admin` — confirm the dev server (still running from Task 1) has no compile errors in the terminal after this change, and that `http://localhost:3000/admin` still loads normally.

- [ ] **Step 8: Commit**

```bash
git add lib/admin-theme.ts lib/admin-theme.test.ts components/admin/status-pill.tsx
git commit -m "feat(admin): add StatusPill component with correct success/warning/danger semantics"
```

---

### Task 3: `SegmentedPillToggle` component

**Files:**
- Modify: `lib/admin-theme.ts`
- Modify: `lib/admin-theme.test.ts`
- Create: `components/admin/segmented-pill-toggle.tsx`

- [ ] **Step 1: Write the failing test**

Add to `lib/admin-theme.test.ts` (new `describe` block, alongside the existing `statusPillClasses` one):

```ts
import { segmentedPillItemClasses } from './admin-theme'

describe('segmentedPillItemClasses', () => {
  it('returns the amber active state when active', () => {
    expect(segmentedPillItemClasses(true)).toBe('bg-admin-amber text-slate-900 font-bold')
  })

  it('returns the transparent inactive state when not active', () => {
    expect(segmentedPillItemClasses(false)).toBe('bg-transparent text-current font-medium hover:bg-white/10')
  })
})
```

(Add the `import { segmentedPillItemClasses } from './admin-theme'` to the top of the file alongside the existing `statusPillClasses` import — one `import { statusPillClasses, segmentedPillItemClasses } from './admin-theme'` line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/admin-theme.test.ts`
Expected: FAIL — `segmentedPillItemClasses is not a function` (or import error).

- [ ] **Step 3: Add the minimal implementation**

Append to `lib/admin-theme.ts`:

```ts
export function segmentedPillItemClasses(isActive: boolean): string {
  return isActive
    ? 'bg-admin-amber text-slate-900 font-bold'
    : 'bg-transparent text-current font-medium hover:bg-white/10'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/admin-theme.test.ts`
Expected: PASS — 5 tests green (3 from Task 2 + 2 new).

- [ ] **Step 5: Create the component**

Create `components/admin/segmented-pill-toggle.tsx`:

```tsx
'use client'

import { cn } from '@/lib/utils'
import { segmentedPillItemClasses } from '@/lib/admin-theme'

export interface SegmentedPillOption {
  label: string
  value: string
}

export function SegmentedPillToggle({
  options,
  value,
  onChange,
  className,
}: {
  options: SegmentedPillOption[]
  value: string
  onChange: (value: string) => void
  className?: string
}) {
  return (
    <div className={cn('inline-flex rounded-full bg-white/10 p-1', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-full px-4 py-1.5 text-sm transition-colors',
            segmentedPillItemClasses(option.value === value)
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: See it locally**

Not wired into a page yet. Confirm the dev server terminal shows no compile errors and `http://localhost:3000/admin` still loads normally.

- [ ] **Step 8: Commit**

```bash
git add lib/admin-theme.ts lib/admin-theme.test.ts components/admin/segmented-pill-toggle.tsx
git commit -m "feat(admin): add SegmentedPillToggle component (reusable primitive, not yet wired to a page)"
```

---

### Task 4: `GatewayHealthCard` component

**Files:**
- Modify: `lib/admin-theme.ts`
- Modify: `lib/admin-theme.test.ts`
- Create: `components/admin/gateway-health-card.tsx`

- [ ] **Step 1: Write the failing test**

Add to `lib/admin-theme.test.ts`:

```ts
import { gatewayStatus, gatewayBarColorClass } from './admin-theme'

describe('gatewayStatus', () => {
  it('is "optimal" at 99% uptime or above', () => {
    expect(gatewayStatus(99)).toBe('optimal')
    expect(gatewayStatus(99.9)).toBe('optimal')
    expect(gatewayStatus(100)).toBe('optimal')
  })

  it('is "degraded" between 90% (inclusive) and 99%', () => {
    expect(gatewayStatus(90)).toBe('degraded')
    expect(gatewayStatus(98.9)).toBe('degraded')
  })

  it('is "down" below 90%', () => {
    expect(gatewayStatus(89.9)).toBe('down')
    expect(gatewayStatus(0)).toBe('down')
  })
})

describe('gatewayBarColorClass', () => {
  it('maps each status to the matching semantic token', () => {
    expect(gatewayBarColorClass('optimal')).toBe('bg-success')
    expect(gatewayBarColorClass('degraded')).toBe('bg-warning')
    expect(gatewayBarColorClass('down')).toBe('bg-destructive')
  })
})
```

(Update the top-of-file import to `import { statusPillClasses, segmentedPillItemClasses, gatewayStatus, gatewayBarColorClass } from './admin-theme'`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/admin-theme.test.ts`
Expected: FAIL — `gatewayStatus is not a function`.

- [ ] **Step 3: Add the minimal implementation**

Append to `lib/admin-theme.ts`:

```ts
export type GatewayStatus = 'optimal' | 'degraded' | 'down'

export function gatewayStatus(uptimePct: number): GatewayStatus {
  if (uptimePct >= 99) return 'optimal'
  if (uptimePct >= 90) return 'degraded'
  return 'down'
}

export function gatewayBarColorClass(status: GatewayStatus): string {
  switch (status) {
    case 'optimal':
      return 'bg-success'
    case 'degraded':
      return 'bg-warning'
    case 'down':
      return 'bg-destructive'
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/admin-theme.test.ts`
Expected: PASS — 10 tests green.

- [ ] **Step 5: Create the component**

Create `components/admin/gateway-health-card.tsx`:

```tsx
import { gatewayStatus, gatewayBarColorClass } from '@/lib/admin-theme'

export function GatewayHealthCard({
  label,
  badgeText,
  badgeBg,
  badgeFg,
  latencyMs,
  uptimePct,
}: {
  label: string
  badgeText: string
  badgeBg: string
  badgeFg: string
  latencyMs: number
  uptimePct: number
}) {
  const status = gatewayStatus(uptimePct)
  const barClass = gatewayBarColorClass(status)
  const barWidth = Math.max(0, Math.min(100, uptimePct))

  return (
    <div className="flex-1 rounded-xl border border-border p-3.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="flex h-6 w-6 items-center justify-center rounded-md text-[8px] font-extrabold"
            style={{ background: badgeBg, color: badgeFg }}
          >
            {badgeText}
          </div>
          <span className="text-sm font-semibold text-foreground">{label}</span>
        </div>
        <span className="text-xs text-muted-foreground">{latencyMs}ms</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-border">
        <div className={`h-full rounded-full ${barClass}`} style={{ width: `${barWidth}%` }} />
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">
        Status: <span className="font-bold capitalize">{status}</span> · Uptime {uptimePct}%
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: See it locally**

Not wired into a page yet (real MTN provider status wiring is out of scope for this plan — see the plan header). Confirm the dev server terminal shows no compile errors and `http://localhost:3000/admin` still loads normally.

- [ ] **Step 8: Commit**

```bash
git add lib/admin-theme.ts lib/admin-theme.test.ts components/admin/gateway-health-card.tsx
git commit -m "feat(admin): add GatewayHealthCard component (reusable primitive, real-data wiring is follow-up work)"
```

---

### Task 5: `AdminPageHeaderBanner` component

**Files:**
- Create: `components/admin/page-header-banner.tsx`

No new pure logic here (it's a straightforward gradient container — the "logic" is just the two admin banner tokens from Task 1), so this task skips the test-first steps and goes straight to the component, consistent with Task 1's reasoning.

- [ ] **Step 1: Create the component**

Create `components/admin/page-header-banner.tsx`:

```tsx
import type { ReactNode } from 'react'

export function AdminPageHeaderBanner({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children?: ReactNode
}) {
  return (
    <div className="rounded-2xl bg-gradient-to-r from-admin-banner-from to-admin-banner-to p-6 sm:p-7">
      <h1 className="font-display text-xl font-bold text-white sm:text-2xl">{title}</h1>
      <p className="mt-1 text-sm text-white/80">{subtitle}</p>
      {children && <div className="mt-5">{children}</div>}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: See it locally**

Not wired into a page yet (Task 7 does that). Confirm the dev server terminal shows no compile errors and `http://localhost:3000/admin` still loads normally.

- [ ] **Step 4: Commit**

```bash
git add components/admin/page-header-banner.tsx
git commit -m "feat(admin): add AdminPageHeaderBanner component"
```

---

### Task 6: Apply the banner + stat cards to the real Admin Dashboard hub

**Files:**
- Modify: `app/admin/page.tsx:135-145` (the `<DashboardLayout>` open + `<h1>` title — real return path, not the early-return loading/error path at lines 122-127)

This wires the new banner into the **real** page using its **existing live data** (`stats.totalOrders`, `stats.totalRevenue`, `stats.totalUsers` — already fetched by `loadStats()` earlier in the same file). No new data fetching, no fabricated numbers, no route/logic changes — a re-skin of the header only.

- [ ] **Step 1: Read the current header block to confirm nothing has shifted before editing**

Run: `grep -n "Page Header\|Admin Dashboard\|Manage packages" app/admin/page.tsx`
Expected output includes `137:        {/* Page Header */}` and `139:          <h1 ... >Admin Dashboard</h1>` and `140:          <p ...>Manage packages, users, and shop approvals</p>`. If this doesn't match, re-locate the block by the `Page Header` comment before editing — something else has changed the file since this plan was written.

- [ ] **Step 2: Replace the plain gradient-text header with the new banner**

In `app/admin/page.tsx`, replace this exact block (lines 137-141):

```tsx
        {/* Page Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold bg-gradient-to-r from-red-600 via-primary to-pink-600 bg-clip-text text-transparent">Admin Dashboard</h1>
          <p className="text-muted-foreground mt-1 font-medium">Manage packages, users, and shop approvals</p>
        </div>
```

With:

```tsx
        {/* Page Header */}
        <AdminPageHeaderBanner
          title="Admin Dashboard"
          subtitle="Manage packages, users, and shop approvals"
        >
          <div className="flex flex-wrap gap-3">
            <div className="flex-1 min-w-[140px] rounded-xl bg-white/10 p-3">
              <div className="font-display text-2xl font-bold text-white">{formatCount(stats?.totalOrders ?? 0)}</div>
              <div className="mt-0.5 text-[11px] uppercase tracking-wide text-white/75">Total Orders</div>
            </div>
            <div className="flex-1 min-w-[140px] rounded-xl bg-white/10 p-3">
              <div className="font-display text-2xl font-bold text-white">GHS {(stats?.totalRevenue ?? 0).toFixed(2)}</div>
              <div className="mt-0.5 text-[11px] uppercase tracking-wide text-white/75">Total Revenue</div>
            </div>
            <div className="flex-1 min-w-[140px] rounded-xl bg-white/10 p-3">
              <div className="font-display text-2xl font-bold text-white">{formatCount(stats?.totalUsers ?? 0)}</div>
              <div className="mt-0.5 text-[11px] uppercase tracking-wide text-white/75">Total Users</div>
            </div>
          </div>
        </AdminPageHeaderBanner>
```

Everything else in the file (the `space-y-6` wrapper, the `{stats && (...)}` KPI-card block starting right after, and everything below it) stays exactly as-is — only this one `<div>...</div>` block is replaced. The subtitle text is the exact existing copy, unchanged. `stats` is typed `DashboardStats | null` (line 26-42 of this same file) and only becomes non-null once `loadStats()` resolves — `stats?.totalOrders ?? 0` shows `0` in the tiles for the brief moment before it loads, matching how the rest of the page already guards `stats` with `{stats && (...)}` rather than crashing.

- [ ] **Step 3: Add the import**

At the top of `app/admin/page.tsx`, alongside the other `@/components/*` imports (near line 5's `import { DashboardLayout } from "@/components/layout/dashboard-layout"`), add:

```tsx
import { AdminPageHeaderBanner } from "@/components/admin/page-header-banner"
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If there's a type error on `stats?.totalOrders`, confirm `DashboardStats` (defined at line 26-37 of the same file) has `totalOrders: number`, `totalRevenue: number`, `totalUsers: number` — it does per the interface already in the file.

- [ ] **Step 5: See it locally**

Run: `npm run dev` (if not already running from earlier tasks)
Open: `http://localhost:3000/admin` in your browser, logged in as an admin.
Expected: the plain red→pink gradient-text title is replaced by a navy→blue gradient banner card containing "Admin Dashboard" / "Platform overview and live order activity." plus three stat tiles (Total Orders / Total Revenue / Total Users) showing your **real** current numbers — not placeholders. Toggle light/dark mode (existing toggle) and confirm the banner looks the same in both (it should — the admin-banner tokens are theme-independent by construction from Task 1). The rest of the page (the 7 KPI cards below, module cards, etc.) is unchanged.

- [ ] **Step 6: Commit**

```bash
git add app/admin/page.tsx
git commit -m "feat(admin): replace plain gradient-text title with AdminPageHeaderBanner on the dashboard hub

Uses the page's existing live stats (totalOrders/totalRevenue/totalUsers) --
no new data fetching, no route or logic changes."
```

---

### Task 7: Full verification pass

- [ ] **Step 1: Run the full test suite**

Run: `npm run test:run`
Expected: all tests pass, including the 10 new ones in `lib/admin-theme.test.ts`.

- [ ] **Step 2: Full typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build succeeds with no new warnings/errors attributable to these changes.

- [ ] **Step 4: Final local walkthrough**

With `npm run dev` running, open `http://localhost:3000/admin`:
- Confirm the new banner + stat tiles render with real numbers, in both light and dark mode.
- Confirm nothing else on the page moved, broke, or changed color unexpectedly (the 7 KPI cards, module cards, platform metrics below the banner should look exactly as they did before this plan).
- Click through 2-3 other `/admin/*` pages (e.g. `/admin/orders`, `/admin/settings`) to confirm they're **unaffected** — this plan only touched the dashboard hub page; everything else stays on the old plain-title look until a follow-up plan rolls the banner out further.

- [ ] **Step 5: Update the design spec's status**

In `docs/superpowers/specs/2026-09-27-apexprime-inspired-reskin-phase1-admin-design.md`, change the `Status:` line from `Draft for review` to `Phase 1a (foundation + dashboard-hub pilot) shipped; remaining admin pages + sidebar recolor pending follow-up plans`.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-09-27-apexprime-inspired-reskin-phase1-admin-design.md
git commit -m "docs(spec): mark phase 1a (foundation + dashboard-hub pilot) as shipped"
```

---

## Follow-up plans (not part of this plan)

- **Sidebar recolor** — needs a decision (role-based vs. route-based skin switch) and a refactor of `components/layout/sidebar.tsx`'s ~25 repeated inline ternaries into a shared helper before a third "admin" skin can be added cleanly.
- **Remaining ~29 admin pages** — roll the `AdminPageHeaderBanner` + `StatusPill` pattern out page by page (or via a scoped codemod, per the design spec's §5), using this plan's dashboard-hub migration as the reference.
- **`GatewayHealthCard` real-data wiring** — hook it up to actual MTN provider status (`mtn_fulfillment_tracking`) once a suitable aggregation endpoint exists.
- **Phases 2-4** (customer storefront, dealer, shop storefronts) — separate specs per the original design doc's rollout roadmap.
