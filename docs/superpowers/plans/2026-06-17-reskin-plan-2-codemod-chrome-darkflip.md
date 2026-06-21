# Reskin Plan 2 — Color-Debt Codemod, Chrome, AI Widgets, Error Pages, Dark Flip

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Eliminate the hardcoded off-token color debt across `app/**` + `components/**`, tokenize the shared chrome and the 4 AI chat widgets, add token-driven error/404/loading pages, then flip the app to **dark by default** (toggle retained).

**Architecture:** A safe scripted codemod handles the collision-free **accent families** (purple/violet/indigo/fuchsia/cyan → `primary`); **status families** (green/red/yellow/amber/orange) are done by network-aware passes that must NOT touch MTN/Telecel/AT brand colors; chrome + widgets are hand-tokenized from known offenders; error pages are new files; the dark flip happens LAST so no `bg-white` strands on dark.

**Tech Stack:** Next.js 15, Tailwind (token-mapped), next-themes, lucide-react. Node (ESM) for the codemod script.

**Spec:** `docs/superpowers/specs/2026-06-17-compute-network-reskin-design.md` §7 (cross-cutting), §8 (3-pass codemod), §9 (dark flip).

**Hard exclusions (never modify in this plan):** `app/api/**`, `lib/**`, `app/globals.css`, `app/page.tsx` (done in Plan 1), `tailwind.config.ts`, `app/layout.tsx` (except Task 8), and **network brand colors** (`bg-mtn/telecel/at`, and literal `bg-yellow-400`/`bg-red-500` used as MTN/Telecel dots). **Never `git add -A`** — only scoped adds. **Do not touch the uncommitted SMS files** (`app/api/sms/**`, `app/api/webhooks/paystack/route.ts`, `lib/sms/**`) — they are unrelated WIP.

---

## File Structure

| Area | Files | Action |
|---|---|---|
| Codemod script | `scripts/reskin-codemod.mjs` | Create (accent families + bg-white) |
| Chrome | `components/layout/{sidebar,header,bottom-nav,dashboard-layout}.tsx`, `components/announcement-modal.tsx`, `components/push-opt-in-banner.tsx` | Modify |
| AI widgets | `components/home/AIChatWidget.tsx`, `components/shop/AIChatWidget.tsx`, `components/dashboard/AIChatWidget.tsx`, `components/admin/AdminAIChatWidget.tsx` | Modify |
| Error pages | `app/not-found.tsx`, `app/error.tsx`, `app/loading.tsx`, `app/global-error.tsx` | Create |
| Status codemod | all `app/**` + `components/**` (excl. above) | Modify (grouped) |
| Dark flip | `app/layout.tsx` | Modify (1 line) |

---

## Task 1: Safe scripted accent codemod

Accent families never collide with network brand colors, so they're safe to script. The script also reports remaining status/white/hex occurrences for later tasks.

**Files:** Create `scripts/reskin-codemod.mjs`

- [ ] **Step 1: Create the codemod script**

```js
// scripts/reskin-codemod.mjs — safe accent-family codemod for the emerald reskin.
// Replaces purple/violet/indigo/fuchsia/cyan utility colors with `primary`, and
// bg-white -> bg-card. Does NOT touch status families (green/red/yellow/amber/orange)
// or network colors — those need human judgment (network-color collisions).
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOTS = ['app', 'components']
const EXCLUDE_DIRS = ['app/api', 'node_modules', '.next']
const EXCLUDE_FILES = ['app/page.tsx', 'app/globals.css'] // page.tsx done in Plan 1
const EXT = new Set(['.tsx', '.ts', '.jsx', '.js'])
const ACCENTS = 'purple|violet|indigo|fuchsia|cyan'
// utility prefixes that take a color-shade
const PREFIX = 'bg|text|border|ring|from|to|via|fill|stroke|divide|outline|shadow|ring-offset|placeholder|decoration|accent|caret'

let filesChanged = 0
const report = [] // remaining off-token occurrences to hand-fix later

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (EXCLUDE_DIRS.some((d) => p.replaceAll('\\', '/').startsWith(d))) continue
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (EXT.has(extname(p)) && !EXCLUDE_FILES.includes(p.replaceAll('\\', '/'))) transform(p)
  }
}

function transform(file) {
  let src = readFileSync(file, 'utf8')
  const before = src
  // 1) accent families -> primary (drop the numeric shade and any /opacity stays)
  src = src.replace(
    new RegExp(`\\b(${PREFIX})-(?:${ACCENTS})-(\\d{2,3})(/\\d{1,3})?\\b`, 'g'),
    (_m, pfx, _shade, op) => `${pfx}-primary${op ?? ''}`
  )
  // 2) bg-white -> bg-card ; bg-black -> bg-background (leave text-white for review)
  src = src.replace(/\bbg-white\b/g, 'bg-card').replace(/\bbg-black\b/g, 'bg-background')
  if (src !== before) { writeFileSync(file, src); filesChanged++ }

  // 3) report remaining debt for later tasks (status families, text-white, hex, gradients)
  const rel = file.replaceAll('\\', '/')
  const status = (src.match(/\b(?:bg|text|border|ring|from|to|via)-(?:green|red|yellow|amber|orange|slate|gray)-\d{2,3}\b/g) || [])
  const white = (src.match(/\btext-white\b/g) || [])
  const hex = (src.match(/#[0-9a-fA-F]{6}\b/g) || [])
  if (status.length || white.length || hex.length) {
    report.push(`${rel}: status=${status.length} text-white=${white.length} hex=${hex.length}`)
  }
}

ROOTS.forEach(walk)
console.log(`\n[reskin-codemod] files changed: ${filesChanged}`)
console.log(`[reskin-codemod] files with remaining debt (status/white/hex): ${report.length}`)
report.sort().forEach((r) => console.log('  ' + r))
```

- [ ] **Step 2: Run the script**

Run: `node scripts/reskin-codemod.mjs`
Expected: prints "files changed: N" and a list of files with remaining status/white/hex debt. Save that list — it drives Task 6.

- [ ] **Step 3: Sanity-check the diff did not touch network colors**

Run (Grep tool or): confirm `bg-mtn`, `bg-telecel`, `bg-at`, `bg-yellow-400`, `bg-red-500` still appear unchanged in `git diff`. Confirm NO `-purple-`, `-violet-`, `-indigo-`, `-fuchsia-`, `-cyan-` remain: search `app/ components/` for `(bg|text|border|ring|from|to|via)-(purple|violet|indigo|fuchsia|cyan)-` → expected 0 (excluding `app/page.tsx`).

- [ ] **Step 4: Build**

Run: `npm run build` → must succeed. If a `text-white` now sits on a `bg-card` (illegible), note the file for Task 6; don't fix here.

- [ ] **Step 5: Commit (scoped)**

```bash
git add scripts/reskin-codemod.mjs app components
git commit -m "feat(reskin): scripted accent-family codemod (purple/violet/etc -> primary) + bg-white->bg-card"
```
(The scoped `git add app components` stages only reskin files; verify with `git status` that no `api/sms` files are staged — if any appear, `git restore --staged` them.)

---

## Task 2: Tokenize shared chrome

The highest-leverage hand-fixes (cascade to 40+ pages). A subagent reads each file and replaces the known hardcoded offenders + any remaining status colors with tokens. **Exclude network colors.**

**Files:** `components/layout/sidebar.tsx`, `components/layout/header.tsx`, `components/layout/bottom-nav.tsx`, `components/layout/dashboard-layout.tsx`, `components/announcement-modal.tsx`, `components/push-opt-in-banner.tsx`

Known offenders (from audit — replace these, then sweep each file for any remaining literal colors):
- **sidebar.tsx:** dealer gradient `bg-gradient-to-b from-[#1d1140] via-[#37146b] to-[#7c1bd6]` → `bg-sidebar` (or `bg-gradient-to-b from-sidebar to-card`); red order-count badges `bg-red-500`/`bg-red-600` → `bg-destructive`.
- **header.tsx:** dealer chrome `bg-amber-50/90 dark:bg-amber-950/40` → `bg-card/95`; avatar gradients (dealer `from-amber-400 to-amber-600 shadow-[0_0_10px_rgba(251,191,36,0.3)]`, default `from-primary to-violet-600`) → `from-primary to-brand-accent` + drop the rgba shadow or use `shadow-[0_0_10px_hsl(var(--primary)/0.3)]`; `text-red-600` logout → `text-destructive`.
- **bottom-nav.tsx:** FAB ring gradients (admin `from-... to-violet-700 ring-violet-100`, dealer `to-purple-700 ring-fuchsia-100`, default `from-primary to-violet-600 ring-primary/15`) → unify to `from-primary to-brand-accent ring-primary/15`; **FIX the `bg-card0` typo** (should be `bg-card` or the intended gradient `from-primary`) on lines ~45/47.
- **dashboard-layout.tsx:** dealer/admin conditional tints `bg-violet-50/40 dark:bg-violet-950/20` → `bg-card` or `bg-muted/40`.
- **announcement-modal.tsx:** button gradient `from-cyan-600 to-primary/80 hover:from-cyan-700` → `bg-primary hover:bg-primary/90`; close `hover:bg-red-50 hover:text-red-500` → `hover:bg-destructive/10 hover:text-destructive`.
- **push-opt-in-banner.tsx:** icon chip `bg-violet-100 text-violet-600` → `bg-primary/15 text-primary`.

Steps:
- [ ] **Step 1:** For each file, read it, apply the offenders above, then search the file for any remaining `-(purple|violet|indigo|fuchsia|cyan|amber|red|green|yellow|orange|gray|slate)-\d` and `bg-white`/`text-white`/`#hex` and tokenize each with judgment (status→success/warning/destructive; neutral→muted/foreground/border; accent→primary/brand-accent). **Do not touch `bg-mtn/telecel/at` or any network-dot literal.**
- [ ] **Step 2:** `npm run build` → success.
- [ ] **Step 3:** Commit: `git add components/layout components/announcement-modal.tsx components/push-opt-in-banner.tsx && git commit -m "feat(reskin): tokenize shared chrome (sidebar/header/bottom-nav/layout + banners), fix bg-card0 typo"`

---

## Task 3: Tokenize the 4 AI chat widgets

**Files:** `components/home/AIChatWidget.tsx`, `components/shop/AIChatWidget.tsx`, `components/dashboard/AIChatWidget.tsx`, `components/admin/AdminAIChatWidget.tsx`

- [ ] **Step 1:** For each widget, read it and replace all hardcoded violet/purple/blue/indigo/cyan accent colors with `primary`/`brand-accent`, grays with `muted`/`muted-foreground`/`border`, `bg-white`→`bg-card`, red danger → `destructive`. Keep behavior identical (streaming dots, action buttons, hints, scroll button). The `animate-thinking` keyframe stays. Ensure the launcher button, header, message bubbles, and input use tokens so the widget reads emerald on dark and on light.
- [ ] **Step 2:** `npm run build` → success.
- [ ] **Step 3:** Commit: `git add components/home/AIChatWidget.tsx components/shop/AIChatWidget.tsx components/dashboard/AIChatWidget.tsx components/admin/AdminAIChatWidget.tsx && git commit -m "feat(reskin): tokenize the 4 AI chat widgets to emerald/tokens"`

---

## Task 4: Add token-driven error / 404 / loading pages

These don't exist today; without them a thrown error or 404 renders Next's default (off-brand white).

**Files:** Create `app/not-found.tsx`, `app/error.tsx`, `app/loading.tsx`, `app/global-error.tsx`

- [ ] **Step 1: `app/not-found.tsx`**
```tsx
import Link from "next/link"
import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <div className="min-h-screen grid place-items-center bg-background px-6 text-center">
      <div className="max-w-md">
        <p className="font-mono text-xs uppercase tracking-widest text-primary">Error 404</p>
        <h1 className="mt-3 font-display text-3xl font-semibold text-foreground">Page not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">The page you’re looking for doesn’t exist or has moved.</p>
        <Link href="/" className="mt-6 inline-block"><Button>Back to home</Button></Link>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: `app/error.tsx`**
```tsx
"use client"
import { useEffect } from "react"
import { Button } from "@/components/ui/button"

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error) }, [error])
  return (
    <div className="min-h-screen grid place-items-center bg-background px-6 text-center">
      <div className="max-w-md">
        <p className="font-mono text-xs uppercase tracking-widest text-destructive">Something went wrong</p>
        <h1 className="mt-3 font-display text-3xl font-semibold text-foreground">Unexpected error</h1>
        <p className="mt-2 text-sm text-muted-foreground">An error occurred while loading this page. Please try again.</p>
        <Button onClick={reset} className="mt-6">Try again</Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: `app/loading.tsx`**
```tsx
export default function Loading() {
  return (
    <div className="min-h-screen grid place-items-center bg-background">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary" aria-label="Loading" />
    </div>
  )
}
```

- [ ] **Step 4: `app/global-error.tsx`** (renders OUTSIDE providers → inline styles only, no token classes)
```tsx
"use client"
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#030303", color: "#FAFAFA", fontFamily: "system-ui, sans-serif", textAlign: "center", padding: "24px" }}>
        <div style={{ maxWidth: 420 }}>
          <p style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", color: "#34D399" }}>Fatal error</p>
          <h1 style={{ marginTop: 12, fontSize: 28, fontWeight: 600 }}>The app crashed</h1>
          <p style={{ marginTop: 8, fontSize: 14, color: "#A1A1AA" }}>A critical error occurred. Reload to continue.</p>
          <button onClick={reset} style={{ marginTop: 24, background: "#34D399", color: "#04120c", border: 0, borderRadius: 8, padding: "10px 18px", fontWeight: 600, cursor: "pointer" }}>Reload</button>
        </div>
      </body>
    </html>
  )
}
```

- [ ] **Step 5:** `npm run build` → success. Commit: `git add app/not-found.tsx app/error.tsx app/loading.tsx app/global-error.tsx && git commit -m "feat(reskin): add token-driven 404/error/loading/global-error pages"`

---

## Task 5: Network-aware status-color codemod (grouped)

Now the status families. Because `red`/`yellow` collide with Telecel/MTN dots, this is done per directory group by subagents WITH judgment (use the script's report from Task 1 Step 2 to target only files that still have status debt). Groups: `components/**` (non-chrome), `app/auth/**` + `app/shop/**` + public, `app/dashboard/**`, `app/admin/**`.

Mapping (apply with judgment, skip network dots):
- `bg-{green}-50`→`bg-success/10`, `bg-{green}-100`→`bg-success/15`, `text-{green}-{600/700/800}`→`text-success`, `bg-{green}-{500/600}`→`bg-success`, `border-{green}-*`→`border-success/30`.
- `red`→`destructive`, `yellow|amber|orange`→`warning` (same shape). **But** if a `bg-red-500`/`bg-yellow-400` (or similar) is a Telecel/MTN brand dot/swatch, LEAVE it.
- neutral `gray|slate-{50..200}`→`muted`/`border`, `gray|slate-{400..600}` text→`muted-foreground`, dark `gray-900`→`bg-footer` (footer contexts only).
- `text-white`: → `text-primary-foreground` when on a `bg-primary`/emerald button; keep when on an already-dark surface (e.g. footer). Judgment per occurrence.

- [ ] **Step 1:** For each group, dispatch a subagent: read the files flagged in the Task-1 report for that group, apply the mapping with network-awareness, `npm run build`, commit per group (`git add app/<group>` scoped). Re-run the Task-1 report after each group to confirm status debt is shrinking.
- [ ] **Step 2:** After all groups, run the report again; expected: only network-dot literals + intentional `text-white`-on-dark remain. Document anything deliberately left.

---

## Task 6: Flip to dark by default + both-theme QA

Only after Tasks 1–5 (no `bg-white` strands on dark).

**Files:** `app/layout.tsx`

- [ ] **Step 1:** In `app/layout.tsx`, change `defaultTheme="light"` to `defaultTheme="dark"` on `<ThemeProvider>`. Keep `attribute="class" enableSystem={false} disableTransitionOnChange` and keep the `<ThemeToggle/>` in the header (light remains available).
- [ ] **Step 2:** `npm run build` → success.
- [ ] **Step 3: Playwright QA** — dev server, then screenshot in BOTH themes at desktop + 360px: landing, `/auth/login`, `/auth/signup`, a `/shop/<slug>` storefront if seedable, and (if auth is available) `/dashboard` + `/admin`. Confirm: dark is now default on first load; no stranded white cards; chrome (sidebar/header/bottom-nav) emerald not purple; AI widget emerald; status badges legible (success≠brand collision); network dots still MTN-yellow/Telecel-red/AT-blue.
- [ ] **Step 4:** Commit: `git add app/layout.tsx && git commit -m "feat(reskin): flip defaultTheme to dark (toggle retained)"`

---

## Acceptance (spec §13)
- No `-(purple|violet|indigo|fuchsia|cyan)-\d` anywhere in `app/**`/`components/**`.
- Status colors → success/warning/destructive tokens (network dots excepted).
- Chrome free of dealer purple/amber gradients; `bg-card0` typo fixed.
- 4 AI widgets emerald; 4 error/empty pages exist and are token/inline-dark.
- `defaultTheme="dark"`; toggle still works; both themes pass visual QA; network brand colors intact.
- `npm run build` green; `tsc --noEmit` green; the uncommitted SMS files remain untouched and unstaged throughout.
