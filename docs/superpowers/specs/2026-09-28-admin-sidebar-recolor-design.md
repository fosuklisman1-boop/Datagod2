# Design Spec — Admin Sidebar Recolor

- **Date:** 2026-09-28
- **Branch:** main
- **Status:** Draft for review
- **Scope:** Give admin users a fixed-navy sidebar (matching the Apex Prime-inspired identity from Phase 1a), while leaving the plain-user and dealer sidebar skins pixel-identical to today. Follow-up to [docs/superpowers/specs/2026-09-27-apexprime-inspired-reskin-phase1-admin-design.md](2026-09-27-apexprime-inspired-reskin-phase1-admin-design.md), which explicitly deferred this work as its own subsystem.

---

## 1. Goal

`components/layout/sidebar.tsx` is one ~1180-line component shared verbatim across `/dashboard/*` and `/admin/*` for every role. It already branches its visual style on `userRole === 'dealer'` via ~25 repeated inline ternaries (plus ~8 more for structural chrome — container, borders, section labels). This spec adds a third branch for admins, using the fixed-navy tokens already added (but unused) in Phase 1a (`--admin-sidebar`/`--admin-sidebar-foreground`), and — because adding a third branch to 33 already-duplicated ternaries would double the exact problem this task exists to fix — extracts the style-mapping logic into one pure, unit-tested function.

## 2. Skin selection

One `skin: 'default' | 'dealer' | 'admin'` computed once per render:

```ts
const skin: SidebarSkin = userRole === 'dealer' ? 'dealer' : isAdmin ? 'admin' : 'default'
```

`isAdmin` is the existing `useIsAdmin()` result already in scope in this component (the same flag that already gates whether the ADMIN nav section renders at all) — no new data fetch. Dealer keeps precedence over admin, matching the existing code's own ordering. **`default` and `dealer` render pixel-identical output to today** — this spec only adds the `admin` branch; it does not restyle the other two.

## 3. Extracting the duplication: `lib/sidebar-theme.ts`

A new file (mirrors the `lib/admin-theme.ts` pattern from Phase 1a) exports one function returning every skin-dependent class string the component needs, computed once:

```ts
export type SidebarSkin = 'default' | 'dealer' | 'admin'

export interface SidebarSkinClasses {
  container: string
  logoSectionBorder: string
  siteNameText: string
  collapseButtonHover: string
  navLinkActive: string
  navLinkInactive: string
  sectionBorder: string
  sectionLabelText: string
  logoutText: string
}

export function sidebarSkinClasses(skin: SidebarSkin): SidebarSkinClasses { /* ... */ }
```

Every one of the ~33 inline ternaries in `sidebar.tsx` is replaced by a single `const c = sidebarSkinClasses(skin)` near the top of the component, with call sites reading `c.navLinkActive` / `c.container` / etc. instead of re-deriving the same conditional inline.

**Regression safety:** two of the current ternaries are already dead code — the sidebar container classes and the logout button classes are byte-identical in both the `dealer` and non-dealer branches today (`"bg-sidebar text-sidebar-foreground border-r border-sidebar-border"` either way, for example). `sidebarSkinClasses('default', ...)` and `sidebarSkinClasses('dealer', ...)` must reproduce **today's exact literal output** for all 9 fields, verified by unit tests asserting the precise current strings — not just "looks similar." Only `'admin'` gets genuinely new values.

## 4. Admin skin values

| Field | Value | Rationale |
|---|---|---|
| `container` | `bg-admin-sidebar text-admin-sidebar-foreground border-r border-white/10` | Uses the Phase 1a tokens (`--admin-sidebar` navy, fixed regardless of theme) for their first real consumer |
| `logoSectionBorder` / `sectionBorder` | `border-white/10` | Same as dealer's existing dark-surface treatment |
| `siteNameText` | `text-white/70` | Readable subtext on navy |
| `collapseButtonHover` | `text-white hover:bg-white/10` | |
| `navLinkActive` | `bg-white/12 text-white font-medium` | User-picked "subtle white overlay" — matches Apex Prime's own sidebar treatment exactly |
| `navLinkInactive` | `text-white/65 hover:bg-white/8 hover:text-white` | |
| `sectionLabelText` | `text-white/40` | |
| `logoutText` | `text-white/80 hover:bg-destructive/10 hover:text-destructive` | `destructive` token already has adequate contrast on dark surfaces (verified in Phase 1a's dark-mode variant) |

Fixed regardless of the site's light/dark toggle — same "theme-independent by construction" reasoning as the Phase 1a banner (the tokens are defined only in `:root`, never redefined in `.dark`).

## 5. Icon swaps

Two icon choices get swapped for closer visual matches to Apex Prime's iconography, confirmed against a real screenshot of their mobile sidebar. Everything else Datagod currently uses (`Wallet`, `Store`, `Send`, `GraduationCap`, etc.) is already an equal-or-better semantic match and stays as-is — this is not a wholesale icon-library change, Datagod stays on `lucide-react` (used app-wide):

| Nav item | Current | New | File:line |
|---|---|---|---|
| Dashboard | `Home` | `Layers` | `components/layout/sidebar.tsx:13,68` |
| AFA Orders | `Star` | `IdCard` | `components/layout/sidebar.tsx:16,75` |

## 6. Out of scope

- Restyling the `default` or `dealer` skins in any way (explicitly pixel-identical to today)
- Splitting `sidebar.tsx` into smaller sub-components (the file stays large; only the style-mapping logic is extracted, not the JSX structure — a bigger refactor than this task needs)
- The mobile hamburger-drawer's own background color, which — per a live screenshot from the user — may already render as white/light on Apex Prime's actual mobile view, differently from their desktop's fixed-navy rail. Datagod's own mobile drawer reuses the same `Sidebar` component and will simply inherit whatever `container` class the skin resolves to (navy, matching the new desktop admin skin) — no separate mobile-specific treatment is being designed here. Worth revisiting later if it looks wrong on a real device.
- Any change to which nav items appear, their hrefs, roles, or ordering — this is a re-skin only.

## 7. Verification

- Unit tests for `sidebarSkinClasses`: all 3 skins × all 9 fields, with `'default'` and `'dealer'` asserting the literal current output strings (regression guard), `'admin'` asserting the new table above
- `npm run test:run`, `npx tsc --noEmit`, `npm run build` all clean
- Manual local check (dev server): an admin's sidebar is fixed navy on both `/dashboard` and any `/admin/*` page, in both light and dark theme; a plain user's and a dealer's sidebar look completely unchanged from before this change
