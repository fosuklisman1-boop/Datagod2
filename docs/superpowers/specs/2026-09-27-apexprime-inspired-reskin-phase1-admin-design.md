# Design Spec — Apex Prime–Inspired Reskin, Phase 1 (Foundation + Admin)

- **Date:** 2026-09-27
- **Branch:** main
- **Status:** Draft for review
- **Scope:** New app-wide design language (tokens + shared components) inspired by the UI/UX of Apex Prime's dashboard (apexprime.club — one of Datagod's MTN fulfillment providers), landed as its own foundation, then rolled out to the **admin panel** (`/admin/*`) as Phase 1. Customer storefront, dealer portal, and shop storefronts are out of scope here — they get their own follow-up specs (Phase 2–4), reusing this same foundation.

---

## 1. Goal

Replace the current **"Decentralized Compute Network"** identity (emerald `#34D399` on near-black, dark-default, mono technical metadata — landed 2026-06-17) with a new **navy/blue + amber** identity inspired by Apex Prime's dashboard: dark-navy permanent sidebar, gradient page-header banners, rounded white/card surfaces on a light blue-gray canvas, segmented pill toggles, and status/health cards — applied first to the admin panel, with the rest of the app to follow in later phases.

This is a **visual-language adaptation, not a literal clone.** We are not porting Apex Prime's marketing gimmicks (floating AI chat bubble, promo carousels, "join our community" / install-as-PWA popups) and we are not copying their inconsistent status-color choices (e.g. they use red for a *credit* event, "Fund Added" — we keep credit=green/debit=red).

## 2. Context (current state, verified against code)

- `app/globals.css` defines HSL-triplet tokens in `:root` (light) and `.dark` (dark), consumed via `hsl(var(--token))` in `tailwind.config.ts`. This token cascade is what makes a full reskin tractable — all 54 shadcn primitives in `components/ui/*` consume only tokens.
- Current brand primary is **emerald** (`--primary: 160 84% 30%` light / `34D399`-family dark); `--radius: 0.5rem`; fonts are **Inter** (display) / **DM Sans** (body) / **JetBrains Mono** (metadata/mono), wired via `next/font/google` in `app/layout.tsx` + `tailwind.config.ts` `fontFamily`.
- Network brand tokens `--mtn` / `--telecel` / `--at` are **frozen** — every past reskin has left these untouched, and this one does too.
- Dark mode is **default**, light is retained behind a toggle (`next-themes`, no `forcedTheme`).
- Admin layout lives in [components/layout/dashboard-layout.tsx](components/layout/dashboard-layout.tsx) + [components/layout/sidebar.tsx](components/layout/sidebar.tsx) — currently token-driven (light sidebar in light mode, dark surface in dark mode), ~30 admin sub-pages inherit it.
- Precedent for how this codebase executes a full reskin: [docs/superpowers/specs/2026-06-17-compute-network-reskin-design.md](docs/superpowers/specs/2026-06-17-compute-network-reskin-design.md) — token retint + 3-pass color-debt codemod + phased rollout plans. This spec follows the same mechanics.

## 3. Locked decisions

| Decision | Choice |
|---|---|
| Source aesthetic | Apex Prime dashboard (apexprime.club), visual language only — see §4 |
| Fidelity | Colors, layout patterns, typography, and core components. **Not** their AI chat bubble, promo carousels, or popup modals |
| Status-color semantics | Kept correct (credit=green, fail=red) — not copied from Apex Prime's inconsistent choices |
| Scope split | Foundation (tokens + shared components) lands once; rollout is **phased by surface**: Admin (this spec) → Customer storefront → Dealer → Shop storefronts |
| Dealer identity | Stays visually distinct (currently a purple "Bold Telco" gradient skin) — same new layout/component language, different accent token set, not the same navy/blue as admin |
| Dark mode | **Kept.** Content area (cards/tables/forms) still respects the existing light/dark toggle. The navy sidebar/header chrome is permanent — like Apex Prime's — regardless of theme |
| Radius / surfaces | Rounded-xl cards, soft shadows, light blue-gray page canvas (light mode); dark-mode card surfaces follow existing dark-mode contrast rules |

## 4. Design language

### 4.1 New/changed tokens

Only brand-identity tokens change. `--success` / `--warning` / `--destructive`, network tokens (`--mtn`/`--telecel`/`--at`), and the font stack are **not** touched by this spec.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--primary` | `217 91% 35%` (~#1e3a8a→#2563eb, expressed as a gradient utility, not a flat fill) | same hue, adjusted lightness for dark-mode contrast | Page-header banner gradient, primary buttons, wallet/balance chip |
| `--sidebar` (NEW: permanent, not `.dark`-gated) | `222 47% 8%` (~#0f1420 navy) | same | Admin nav rail background, in both themes |
| `--sidebar-foreground` | near-white | near-white | Nav rail text/icons |
| `--accent-amber` (NEW) | `38 92% 58%` (~#f5a623) | same | Segmented-toggle active state, highlight badges |
| `--accent-orange` (NEW) | `25 95% 53%` (~#f97316) | same | Secondary CTA buttons |
| `--surface` (page background, light mode) | `220 33% 96%` (~#eef2f9) | unchanged (existing dark background) | Page canvas behind cards |

`--radius` stays as-is (0.5rem) — Apex Prime's rounding is close enough to the existing scale that a token change isn't warranted; card components will use `rounded-xl`/`rounded-2xl` utility overrides where the source uses a visibly larger radius (banners, hero cards).

### 4.2 Component vocabulary (new shared components)

Built once in `components/ui/` or `components/admin/`, then reused across every phase:

- **Page-header banner** — navy→blue gradient block, page title + one-line subtitle. Replaces plain `<h1>` page titles across `/admin/*`.
- **Segmented pill toggle** — rounded pill switcher, amber active state. Replaces plain tabs for binary/small choices (e.g. provider path toggles, filter switches).
- **Status/health card** — icon + colored latency/progress bar + status line. First real use: the MTN provider health/status views on the admin Overview and provider-settings pages (currently plain tables — see [project-fulfillment-providers.md](../../../../.claude/projects/c--Users-User2--gemini-antigravity-ide-scratch-Datagod2/memory/project-fulfillment-providers.md) for what's tracked today).
- **Pill status badges** — rounded colored labels for order/transaction/provider states, correct semantics enforced (not Apex Prime's literal color choices).
- **Sidebar nav rail** — permanent dark-navy sidebar, grouped sections (icon + label, collapsible groups), replacing the current token-driven (theme-following) sidebar for admin only.

### 4.3 Mobile

Sidebar collapses to a hamburger drawer (navy, full-height overlay). Stat/KPI rows that are currently a horizontal grid collapse to a 3-up strip inside the gradient banner on narrow viewports, consistent with Apex Prime's mobile dashboard. Nothing is `display:none`-dropped — dense tables reflow to stacked cards, matching the existing mobile-rules precedent from the 2026-06-17 reskin (§4.6 of that spec).

## 5. Phase 1 scope: Admin panel

- Token additions in `app/globals.css` / `tailwind.config.ts` (additive — does not remove `--success`/`--warning`/`--destructive`/network tokens/fonts)
- The 5 new shared components above, built as real reusable components
- Applied across every `/admin/*` page: sidebar nav, page headers, cards, tables, badges, forms
- An interactive design-preview mockup (same pattern as the `design-preview/index.html` served on :4100 from the 2026-06-04 reskin) so the direction can be visually signed off before the codemod touches real admin pages
- 3-pass color-debt codemod scoped to admin-only files (surface/neutral → status → accent), following the reviewed-diff discipline from the 2026-06-17 reskin's §8, applied only within `app/admin/**` and admin-only shared components this time

## 6. Rollout roadmap (future phases, not detailed here)

- **Phase 2 — Customer storefront.** Public buy-flow pages, checkout/confirmation/tracking.
- **Phase 3 — Dealer portal.** Same layout/component language, distinct accent tokens (keeps its own identity per §3).
- **Phase 4 — Shop storefronts.** White-label sub-agent shops.

Each phase gets its own spec → plan → implementation cycle, reusing this spec's foundation tokens/components without redefining them.

## 7. Verification

- `npm run build` passes, `tsc` clean, `npm run test:run` green (no route/data/logic changes — this is a re-skin only)
- Visual sign-off on the design-preview mockup (light + dark) before any real admin page is touched
- Manual click-through of core admin flows post-reskin (orders, providers, settings, users) to confirm zero functional regression
- Before/after screenshot diff on a handful of representative admin pages (dashboard hub, an orders table, a settings page) to make regressions easy to spot
- WCAG AA contrast check on the new status badges and sidebar text, in both themes

## 8. Out of scope

- Customer storefront, dealer portal, shop storefronts (Phases 2–4, separate specs)
- Mobile Expo app (`mobile/`) — separate codebase
- Apex Prime's AI chat bubble, promo carousel, install-as-PWA banner, and popup modals — explicitly not ported (per §3)
- Email templates, PWA manifest/splash assets — unaffected by this phase

## 9. Open questions

- Exact gradient stops for the page-header banner (navy start/blue end) — tune during build against real admin pages in both light and dark mode.
- Whether the admin sidebar's permanent-navy chrome reads acceptably against dark-mode content (near-black background) or needs a slightly lighter navy for separation — verify on the design-preview mockup.
