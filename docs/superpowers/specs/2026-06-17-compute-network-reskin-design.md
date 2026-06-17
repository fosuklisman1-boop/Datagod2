# Design Spec — "Decentralized Compute Network" App-Wide Reskin

- **Date:** 2026-06-17
- **Branch:** feat/moolre-withdrawal-integration
- **Status:** Draft for review
- **Scope:** Full DATAGOD web app (Next.js 15) — establish a new dark/emerald design language, rebuild the landing page as the reference, and roll the language across all ~107 pages + cross-cutting surfaces.
- **Source aesthetic:** `decentralized-compute-network-DESIGN.md` (Neuform "Decentralized Compute Network" — emerald on near-black, mono technical metadata).

---

## 1. Goal

Replace the current light-default indigo/violet "Modern Fintech" look with a **faithful dark, technical "compute network" identity** — emerald `#34D399` on near-black `#030303`, mono metadata, console-style surfaces — applied consistently to **every page**, while keeping the app shippable throughout and a light theme retained behind the toggle.

The **landing page is the reference**: it both *defines* and *consumes* the language. All other pages follow via a token cascade + a disciplined color-debt codemod + chrome tokenization + a "language-only" treatment on data-dense surfaces.

## 2. Context (current state)

- Mature HSL-token system: `app/globals.css` defines tokens in `:root` (light) + `.dark`; `tailwind.config.ts` maps each via `hsl(var(--token))`; `darkMode: ['class']` via `next-themes`, **`defaultTheme: 'light'`**.
- All 54 shadcn primitives in `components/ui/*` consume only tokens → retinting `globals.css` re-skins everything token-driven in one edit.
- **Blocker:** ~2,136 hardcoded off-token colors across ~152 files (630+ literal classes, 301 `bg-white`/`text-white`, 36 mixed gradients, 92 hex, 5 rgba scrollbar) are invisible to the token swap.
- Only **Inter** is loaded; DM Sans + JetBrains Mono are not.

## 3. Locked decisions

| Decision | Choice |
|---|---|
| Direction | **Faithful** — literal compute-network (emerald on near-black, mono metadata, metric bars, console surfaces) |
| Theme mode | **Dark default + keep a working light theme** behind the toggle (two on-brand token sets) |
| Motion | **CSS-only** ambiance (grid + emerald radial glow + subtle transitions), `prefers-reduced-motion` safe |
| Functional pages | **Language-only** — palette/surfaces/borders/mono-metadata everywhere, but tables & forms stay calm and legible |
| Execution | **Approach A** — foundation + landing together first, then codemod → chrome → surface rollout |
| Plan shape | **One spec, phased shippable plans** |

## 4. Design language

### 4.1 Color tokens

Brand emerald sits at hue ~158°; success green is pushed to ~142° so "brand" never reads as "success." **Network brand tokens (`--mtn`, `--telecel`, `--at`) are frozen — never emeraldized.** Both sets live in `globals.css`. Values are HSL triplets (`H S% L%`) consumed via `hsl(var(--token))`; hex shown for reference.

**DARK (default) — `.dark`**

| Token | HSL | Hex |
|---|---|---|
| `--background` | `0 0% 1%` | #030303 |
| `--foreground` | `0 0% 98%` | #FAFAFA |
| `--card` / `--popover` | `240 5% 10%` | #18181B |
| `--secondary` / `--accent` / `--muted` (surfaces) | `240 4% 16%` / `240 4% 14%` | #27272A / #1F1F23 |
| `--muted-foreground` | `240 5% 65%` | #A1A1AA |
| `--primary` | `158 64% 52%` | #34D399 |
| `--primary-foreground` | `153 40% 8%` | near-black green |
| `--accent-soft` (emerald, low-opacity fills) | `158 64% 52%` | #34D399 |
| `--brand-accent` (NEW — blue, sparing) | `213 94% 68%` | #60A5FA |
| `--success` | `142 71% 45%` | #22C55E |
| `--warning` | `38 92% 50%` | #F59E0B |
| `--destructive` | `0 84% 60%` | #EF4444 |
| `--border` / `--input` / `--ring` | `240 4% 16%` / `158 64% 52%` | #27272A / emerald |
| `--footer` (NEW — deep surface) | `240 6% 3%` | #050506 |
| `--mtn` / `--telecel` / `--at` | unchanged (frozen) | #FFCC00 / #E3001B / #0A5BD3 |
| `--sidebar*` / `--chart-1` | follow `--primary` (emerald) | — |

**LIGHT (retained) — `:root`**

| Token | HSL | Hex |
|---|---|---|
| `--background` | `150 25% 98%` | #F7FAF8 |
| `--foreground` | `150 23% 10%` | #14201A |
| `--card` | `0 0% 100%` | #FFFFFF |
| `--muted-foreground` | `150 8% 40%` | #5B6B62 |
| `--primary` (deeper for contrast) | `160 84% 30%` | #059669 |
| `--brand-accent` | `222 83% 53%` | #2563EB |
| `--success` / `--warning` / `--destructive` | `142 71% 40%` / `32 95% 44%` / `0 72% 51%` | #16A34A / #D97706 / #DC2626 |
| `--border` / `--input` | `150 12% 90%` | #E3E8E5 |
| `--footer` | `150 23% 8%` | deep (footer stays dark in both themes) |

Also: `--radius` → `0.5rem` (8px, per source). Convert the 5 rgba scrollbar rules in `globals.css` to reference emerald `--primary`.

### 4.2 Typography (per source spec)

Three roles, wired via `next/font/google` in CSS-variable mode + `tailwind.config.ts` `fontFamily`:

| Role | Family | Tailwind | Usage |
|---|---|---|---|
| Display / headings | **Inter** (500–600, tight tracking) | `font-display` | hero + section headings |
| Body / UI | **DM Sans** (400–500) | `font-sans` (default on `<body>`) | all body copy, controls |
| Labels / metadata | **JetBrains Mono** (600) | `font-mono` | eyebrows, metric values, IDs, slugs, timestamps, PINs, table numerics, status badges |

`app/layout.tsx`: instantiate the three fonts with `variable: '--font-inter' | '--font-dm-sans' | '--font-jetbrains'`, `subsets:['latin']`, `display:'swap'` (minimal DM Sans weights for mobile payload). Body `className` = `${dmSans.variable} ${inter.variable} ${jetbrains.variable} font-sans`. `tailwind.config.ts`: `sans:['var(--font-dm-sans)',…]`, `display:['var(--font-inter)',…]`, `mono:['var(--font-jetbrains)',…]`.

### 4.3 Motion (CSS-only)

Grid lines + emerald radial glow behind marketing/summary surfaces; masked/staggered entrance; hover lift on cards; scroll-triggered fade-ins (IntersectionObserver). All gated by `prefers-reduced-motion`. **No WebGL.** Keep glow cheap for low-end mobile.

### 4.4 Component vocabulary

- **Buttons:** primary = solid emerald, text near-black (`--primary-foreground`); secondary/outline = transparent + `border-border`; ghost.
- **Surfaces/cards:** `bg-card` (#18181B) + `border-border` (#27272A), radius 8px; elevated nested surfaces at #1F1F23.
- **Eyebrow:** emerald mono uppercase + glow dot.
- **Metric bar:** mono `label · value` strip (marketing + dashboard/admin summaries only).
- **Console/telemetry card:** node-list surface (marketing + dashboard summaries; NOT on dense tables).
- **Status badges:** pill, mono, tinted alpha fill + border in `success`/`warning`/`destructive` (dark-aware, never solid light pastels).
- **Tables:** `bg-card`, `border-border` rows, JetBrains-Mono numerics, token status badges, quiet borders, no glow.
- **Inputs:** `bg-[#0e0e10]` deep field, `border-border`, mono field labels.

### 4.5 "Language-only" rule (functional pages)

Dashboard/admin/forms adopt palette + surfaces + borders + mono metadata, but **stay calm and legible**: no metric-bars/glow/LIVE-dots on dense data; high-contrast text; AA contrast on every badge.

### 4.6 Mobile rules ("reflow, not hide")

Nothing `display:none`-dropped. Sidebars → existing bottom-nav; dense tables → stacked cards; metric bars/channels → horizontal-scroll mono chips; services 2-up→1-up; CTAs full-width stacked; sticky blurred nav; tap targets ≥44px; AA contrast.

## 5. Landing page (the reference) — `app/page.tsx`

Rebuild section-by-section in the language; preserve content inventory, `#how-it-works` anchor, `scrollToGuide`, and all JSON-LD schema scripts.

1. **Nav** (sticky, blurred): logo (emerald→blue chip) + `DATAGOD`; mono links (`NETWORKS / SERVICES / HOW IT WORKS / SHOPS`); `Sign In` ghost + `Get Started` solid-emerald; theme toggle. Mobile: logo + Get Started + hamburger.
2. **Metric bar** (new): mono `Delivery ~8s · Uptime 99.99% · Orders 500,000+ · AI · 5 assistants`.
3. **Hero:** Inter display headline, `10 seconds` in emerald→blue gradient; sub; CTAs (guest buy + Get started + Buy-without-account); trust stats; **Join Community** link (emerald-tint outline, wired to `useCommunityLink`). Right side = **AI assistants card** (replaces the old wallet balance): rows for `WEB` (browse/track), `SHOP` (find & checkout), `WHATSAPP` (order by chat, reverify stuck top-ups, complaints, human handoff), `DEALER` (place wallet orders, today's sales, manage USSD), `ADMIN` (fulfil & manage by chat), with an "Ask DATAGOD anything…" input. CSS grid + emerald glow behind.
4. **Network strip:** MTN/Telecel/AT chips (brand dots) + `+ Airtime · AFA · Results checker` — already token-driven; reskin to dark surfaces.
5. **Services showcase** (NEW, grouped story — use → resell → reach):
   - *Buy & use:* Data Bundles, Airtime, AFA Registration, Results Checker, Results Check Service, Wallet.
   - *Earn & grow:* Your Own Shop, **Your Own USSD** (short code, customers buy with no internet — `manage_my_ussd_shop`/`get_my_shop`), Sub-Agent Network, Instant Withdrawals, Bulk SMS.
   - *Order from anywhere:* Web · WhatsApp bot · USSD · Mobile app · Developer API.
   - One consistent lucide line-icon set, emerald as accent.
6. **How it works:** all 3 tabs + all 18 mini-mockups preserved; step badges → emerald gradient; every status color in mockups → `success/warning/destructive` tokens; mono spans (PIN, slug, join-link) in JetBrains.
7. **CTA band:** emerald-glow dark band (replaces `from-primary to-purple-600`).
8. **Footer:** `bg-gray-900` → `--footer` (#050506); `border-gray-800` → `border-border`; blue lock icon → emerald.
9. **Home AI chat widget:** blue/gray/purple/red → emerald + tokens (see §7).

## 6. Page archetypes (every other page maps to one)

Each archetype's **full feature inventory** (from a code-level audit) must be preserved through the reskin. Customer-facing archetypes stay rich; data-dense ones use "language-only."

### 6.1 Auth (login / signup / forgot / reset / complete-profile / mobile-handoff)
Split layout: brand panel (logo, 3-feature checklist, "₵2M+ delivered" stat) + form panel. Features: Google OAuth (redirect passthrough); email + password (show/hide); forgot link; guest button; community button; signup adds first/last name, **phone + Send OTP → 6-digit verify + 60s resend + spam hint**, **password-strength bar**, confirm-password mismatch, **terms checkbox → terms modal**, "signups disabled" feature-flag state; forgot/reset (token, success auto-redirect); complete-profile (Google handoff: progress bar, avatar, OTP, terms); mobile-handoff token sign-in; role-based redirects + sub-agent query params; AI chat widget.

### 6.2 Shop storefront (`shop/[slug]`)
Header (logo, name, @slug, WhatsApp, hamburger). Tabs: **Buy Data / Buy Airtime / Results Vouchers** (+ Products / Track Order / About in mobile sidebar). Data: network selector (2/4-col, plan counts, OOS), package grid (instant badge, empty state). Airtime: name/email/beneficiary/amount, fee toggle, price summary. Results Vouchers sub-tabs: **Buy** (WASSCE/BECE/NOVDEC, qty ±, bulk pricing, success list w/ serial+PIN copy + Excel receipt), **Retrieve** (by phone/reference + resend SMS), **Check My Results** (own-voucher vs combo, school/private, index/year/DOB, WhatsApp). Checkout modal (name/email/phone, summary) + **OTP verify + MoMo direct-charge live modal (poll)**; Paystack redirect fallback. About (shop info, 24/7, terms); Track Order (phone search). Turnstile + honeypot + ARIA. AI chat widget; announcement modal; maintenance banner. Role variants: sub-agent inherited pricing; ordering-disabled; OTP-required; results-check-disabled.

### 6.3 Agent dashboard (hub + chrome)
**Chrome (tokenize — kills purple/amber dealer gradients):** sidebar (18 user + 7 shop items + 20+ admin items, pending/unread badges, collapse/expand, dealer crown); header (PWA install, theme toggle, notification bell + badge, support dropdown, cart, avatar menu → Profile/API Keys/Logout); notification-center dropdown; bottom-nav + FAB (mobile). **Hub:** greeting + Buy Data; wallet hero (Top Up / Buy Data / My Orders); account card (role/status/member-since); 5-KPI strip (Total/Completed/Processing/Pending/Failed); quick actions (5); **bulk-orders form** (network dropdown, Text/Excel tabs, CSV template, Validate → results table, summary, clear, Submit → confirm modal); recent activity. **Modals:** wallet onboarding; phone-verify (grace) + phone-required (hard block, non-dismissable); announcement (15s countdown). Dealer purple→emerald theming; sub-agent → buy-stock redirect. (All ~30 dashboard sub-pages inherit this archetype + token cascade.)

### 6.4 Admin (hub + dense pages)
**Hub:** 7 KPI/balance cards (Total Users, Shops, Sub-Agents, Orders, Revenue + Users Wallet Balance, Profit Balance); pending-approvals alert; **14 module cards**; platform metrics. **Orders (3 tabs):** Pending (Download-All + network dialog, table: Order ID/Type/Network/Size/Phone/Price/Date), Downloaded (search, network/date/status filters, batch cards, redownload, bulk delete), Fulfillment (auto-fulfill toggle, Code Craft dashboard, sync, manual MTN fulfill single/bulk). **Users:** search + role filter, export emails/phones/all, table, user-stats dialog (Wallet/Orders/Shop/Withdrawals tabs), balance manage, change password, danger zone (suspend/delete). All status via tokens; "language-only" calm at density. AdminAIChatWidget global. (All ~30 admin sub-pages inherit.)

### 6.5 Checkout / confirmation / tracking
Multi-step progress indicator (step circles + % bar); review (summary, masked details, Edit, total); confirmation (order number mono, proceed-to-payment, "what happens next", "no charge until payment" alert); post-payment confirmation (success hero, order number + **copy-to-clipboard**, order/payment status badges, package + delivery info, next-steps, **WhatsApp support**); airtime confirmation (Paystack verify, success/fail); order-status/tracking (phone search, order cards, **payment-reverify** for pending); error-recovery (alert, error code, draft-saved card). OrderContext-driven.

## 7. Cross-cutting surfaces (gap fixes from the completeness critic)

These do **not** auto-convert and are explicitly in scope:

- **AI chat widgets ×4** (`home`, `shop`, `dashboard`, `admin`) — hardcoded violet across all four; on the landing + every app page. Tokenize: violet/blue/gray/red → emerald + `--card`/`--border`/`--muted`/`--destructive`. Streaming dots, action buttons, hints, scrollbars.
- **Error/empty pages (new — none exist today):** add token-driven `app/not-found.tsx`, `app/error.tsx`, `app/loading.tsx`, and `app/global-error.tsx`. `global-error` renders outside providers → use **inline dark styles** (no token classes).
- **Maintenance screen:** re-verify; tokenize any literal colors.
- **PWA:** `manifest.json` `theme_color` (#4f46e5→emerald) + `background_color` (→#030303); `<meta name="theme-color">`; `offline.html` dark restyle (#0a0a0f/#6366f1/#f1f5f9 → tokens/literals). Splash screens (18+ PNG) + `og-image` are **raster assets** → flagged as a regeneration task (tooling/manual), not code.
- **Push opt-in banner / announcement modal / toasts (sonner):** tokenize violet/cyan/red → emerald + tokens.
- **Christmas/seasonal theme:** `ChristmasThemeProvider` frost rgba colors — tokenize or gate so it can't reintroduce off-brand colors over emerald.
- **Scrollbar:** rgba → emerald `--primary` (in `globals.css`, P0).

## 8. Color-debt codemod (the critical nuance)

The codemod is **not** a flat "purple→emerald." It is **three reviewed passes**, each per-file, excluding `--mtn`/`--telecel`/`--at` utilities and the network hex used in mockups/badges:

1. **Neutral / surface:** `bg-white`→`bg-card`|`bg-background` (context), `text-white`→`text-foreground`|`text-primary-foreground` (on colored bg), `bg-gray-50/100`→`bg-muted`, `text-gray-500/600`→`text-muted-foreground`, `border-gray-200`→`border-border`, `bg-gray-900`(footer)→`--footer`.
2. **Status:** the badge idiom `bg-green-100 text-green-800`→ **dark-aware tinted fill** `bg-success/10 text-success border-success/30` (alpha fills, not solid light pastels); green→`success`, red→`destructive`, yellow/amber/orange→`warning`. Verify WCAG AA on dark.
3. **Accent / brand:** purple/violet/indigo/fuchsia/cyan → `primary` (emerald) or `brand-accent`; mixed gradients `from-primary to-purple-600` → emerald→deeper-emerald (buttons/badges) or emerald→`brand-accent` (hero only) — **both stops normalized**.

Also fix the pre-existing `bg-card0` typo in `bottom-nav.tsx`. Review every codemod diff (prior mechanical-replace scar tissue exists).

## 9. Theme mode + dark-default flip

Keep `next-themes` + the toggle. Apply the emerald retint to **both** `:root` and `.dark`. Flip `defaultTheme: 'light' → 'dark'` **after** P0 (tokens/fonts) + P2 (chrome) + a first codemod pass over the highest-traffic surfaces (landing, auth, dashboard hub, storefront), gated on **both-theme visual QA**. Do **not** use `forcedTheme`/remove the toggle (light is retained per the locked decision).

## 10. Rollout roadmap (phased, shippable plans)

- **Plan 1 — Foundation + Landing (P0 + landing).** Retint `globals.css` (dark + light), `--radius`→0.5rem, scrollbar tokens, `--footer`/`--brand-accent`; wire 3 fonts + `tailwind.config` `fontFamily`; motion utilities. Rebuild `app/page.tsx` + deps (`GuestPurchaseButton`, home AI widget). Verify 54 primitives cascade in both themes. Do **not** flip dark-default yet.
- **Plan 2 — Codemod + Chrome + Widgets + Error pages + dark flip (P1 + P2 + gaps).** 3-pass codemod across 152 files; tokenize `sidebar`/`header`/`bottom-nav`/`dashboard-layout` + `announcement-modal` + `push-opt-in-banner`; tokenize the 4 AI widgets; add the 4 error/empty pages; fix `bg-card0`. Then flip `defaultTheme→dark` with both-theme QA.
- **Plan 3 — Public surfaces (P3).** Auth, join, storefront, checkout/confirmation/tracking, legal/vouchers/admin-setup.
- **Plan 4 — Agent dashboard (P4).** Hub, finance/tables, shop mgmt, operations — table legibility on dark.
- **Plan 5 — Admin (P5).** Hub, orders, users, finance, shop/network, comms, config, specialized, fulfillment (heaviest color debt).
- **Plan 6 — Email + PWA + seasonal + assets (P6).** Email-template emerald hex map; manifest/offline/theme-color; Christmas theme; flag splash/OG raster regeneration.

## 11. Risks & mitigations

- **Table legibility at density** → status tokens + AA verification before "done."
- **Hardcoded-color regressions** (~2,136) → 3-pass reviewed codemod; nothing token-blind ships.
- **Brand≈success collision** → hue-separate (primary ~158° vs success ~142°).
- **Premature dark flip** strands `bg-white`/hex → flip only after chrome + core codemod; both-theme QA gate.
- **Email/inline hex** ignore CSS vars → re-pick emerald hex literals (P6).
- **Codemod scar tissue** (`bg-card0`) → review every diff.
- **Mobile font payload** (2 new families) → latin subset, `display:swap`, minimal DM Sans weights.
- **Network tokens** must be excluded from the codemod color map.
- **Christmas overlay** could reintroduce off-brand colors → tokenize/gate.

## 12. Out of scope

- **Mobile Expo app** (`mobile/`) — separate codebase, separate effort.
- **USSD response screens** — plain text, no visual UI.
- **Raster asset regeneration** (PWA splash PNGs, OG image) — listed but handled as a design-asset task, not code.

## 13. Acceptance criteria

- `npm run build` passes; no console errors; `npm run test:run` green.
- Tokens defined in **both** `:root` and `.dark`; 54 primitives cascade; light theme remains on-brand.
- Fonts: Inter (display) / DM Sans (body) / JetBrains Mono (metadata) wired and used per role.
- Landing: all 9 sections + full services showcase + AI card + community + USSD; **no off-token colors** in `app/page.tsx` + deps (except frozen network tokens); JSON-LD + anchors preserved; mobile @360px shows everything (no `display:none` drops); `prefers-reduced-motion` respected.
- Each archetype's full feature inventory (§6) preserved.
- Cross-cutting (§7): 4 AI widgets reskinned; 4 error/empty pages added; PWA/offline/manifest emerald; Christmas gated.
- Every "done" surface passes **both-theme** visual QA + **WCAG AA** contrast on text and badges.

## 14. Open questions

- Exact emerald lightness for light-mode `--primary` (#059669 vs #10B981) — tune during Plan 1 against real components.
- Whether to regenerate PWA splash/OG now or defer (asset task).
