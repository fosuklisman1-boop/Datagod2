# Reskin Plan 1 — Foundation + Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the dark/emerald "Compute Network" design foundation (tokens, fonts, scrollbar) and rebuild the landing page (`app/page.tsx`) as the reference, while keeping the app working in light mode.

**Architecture:** Retint the existing HSL token layer in `app/globals.css` (both `:root` light and `.dark`) so all 54 shadcn primitives re-skin in one edit; wire Inter/DM Sans/JetBrains Mono via `next/font` + Tailwind `fontFamily`; then rebuild `app/page.tsx` section-by-section on those tokens. **Do NOT flip `defaultTheme` to dark in this plan** — that happens in Plan 2 after the color-debt codemod, so light-mode pages don't strand white surfaces.

**Tech Stack:** Next.js 15 (App Router), Tailwind CSS (token-mapped via `hsl(var(--token))`), `next-themes`, shadcn/ui, lucide-react.

**Spec:** `docs/superpowers/specs/2026-06-17-compute-network-reskin-design.md` (§4 tokens/type, §5 landing).

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `app/globals.css` | Design tokens (`:root` + `.dark`), `--radius`, scrollbar | Modify |
| `app/layout.tsx` | Wire 3 fonts onto `<body>`; PWA `themeColor` | Modify |
| `tailwind.config.ts` | `fontFamily` (sans/display/mono) + `brand-accent`/`footer` colors | Modify |
| `app/page.tsx` | Landing page — full rebuild in the language | Modify (rewrite) |
| `components/GuestPurchaseButton.tsx` | Off-token `secondary`/`text-white` variants | Modify |

**Out of this plan (documented, not silent):** the home `AIChatWidget` full restyle is deferred to **Plan 2** (with the other 3 widgets); it keeps its current violet until then. The landing page itself is fully on-token.

---

## Task 1: Wire the three fonts + new token colors

**Files:**
- Modify: `app/layout.tsx:2`, `app/layout.tsx:17`, `app/layout.tsx:199`, `app/layout.tsx:26`
- Modify: `tailwind.config.ts:11-77` (add `fontFamily` + 2 colors)

- [ ] **Step 1: Replace the font import in `app/layout.tsx`**

Replace line 2:
```tsx
import { Inter } from "next/font/google";
```
with:
```tsx
import { Inter, DM_Sans, JetBrains_Mono } from "next/font/google";
```

- [ ] **Step 2: Replace the font instantiation (`app/layout.tsx:17`)**

Replace:
```tsx
const inter = Inter({ subsets: ["latin"] });
```
with:
```tsx
// Per design spec: Inter = display/headings, DM Sans = body, JetBrains Mono = labels/metadata.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const dmSans = DM_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-dm-sans", display: "swap" });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-jetbrains", display: "swap" });
```

- [ ] **Step 3: Apply the font variables to `<body>` (`app/layout.tsx:199`)**

Replace:
```tsx
<body className={inter.className}>
```
with:
```tsx
<body className={`${dmSans.variable} ${inter.variable} ${jetbrains.variable} font-sans`}>
```

- [ ] **Step 4: Update the PWA `themeColor` (`app/layout.tsx:26`)**

Replace:
```tsx
  themeColor: "#4f46e5",
```
with:
```tsx
  themeColor: "#030303",
```

- [ ] **Step 5: Add `fontFamily` + two colors to `tailwind.config.ts`**

Inside `theme.extend`, add a `fontFamily` block (place it directly above `borderRadius` at line 78):
```ts
      fontFamily: {
        sans: ['var(--font-dm-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains)', 'ui-monospace', 'monospace'],
      },
```
And inside `theme.extend.colors` (after the `sidebar` block, before the closing `}` at line 77), add:
```ts
        'brand-accent': 'hsl(var(--brand-accent))',
        footer: 'hsl(var(--footer))',
```

- [ ] **Step 6: Verify the build compiles**

Run: `npm run build`
Expected: build succeeds (fonts resolve, no type errors). If it fails on `DM_Sans`/`JetBrains_Mono` import, confirm exact `next/font/google` export names (underscores).

- [ ] **Step 7: Commit**

```bash
git add app/layout.tsx tailwind.config.ts
git commit -m "feat(reskin): wire Inter/DM Sans/JetBrains Mono fonts + brand-accent/footer tokens"
```

---

## Task 2: Retint the design tokens (emerald dark + light)

**Files:**
- Modify: `app/globals.css:11-72` (`:root`), `app/globals.css:74-119` (`.dark`)

The token NAMES already exist and are mapped in `tailwind.config.ts`; we only change VALUES (HSL triplets) and add `--brand-accent` + `--footer`. Brand emerald hue ~158°; success ~142° (kept distinct). Network tokens (`--mtn/--telecel/--at`) are **unchanged**.

- [ ] **Step 1: Replace the entire `:root { … }` block (light) in `app/globals.css`**

Replace lines 11–72 with:
```css
:root {
  --radius: 0.5rem;

  /* surfaces */
  --background: 150 25% 98%;        /* #F7FAF8 */
  --foreground: 150 23% 10%;        /* #14201A */
  --card: 0 0% 100%;
  --card-foreground: 150 23% 10%;
  --popover: 0 0% 100%;
  --popover-foreground: 150 23% 10%;

  /* brand accent (emerald — deeper for contrast on light) */
  --primary: 160 84% 30%;           /* #059669 */
  --primary-foreground: 0 0% 100%;
  --accent-soft: 160 84% 30%;
  --brand-accent: 222 83% 53%;      /* #2563EB — sparing secondary accent */

  /* neutral support */
  --secondary: 150 16% 95%;
  --secondary-foreground: 150 23% 10%;
  --muted: 150 16% 95%;
  --muted-foreground: 150 8% 40%;   /* #5B6B62 */
  --accent: 150 16% 95%;
  --accent-foreground: 150 23% 10%;

  /* status (success kept at ~142° so brand emerald never reads as success) */
  --destructive: 0 72% 51%;
  --destructive-foreground: 0 0% 100%;
  --success: 142 71% 40%;           /* #16A34A */
  --success-foreground: 0 0% 100%;
  --warning: 32 95% 44%;            /* #D97706 */
  --warning-foreground: 0 0% 100%;

  /* network brand (FROZEN — never emeraldized) */
  --mtn: 48 100% 50%;
  --mtn-foreground: 0 0% 10%;
  --telecel: 353 100% 44%;
  --telecel-foreground: 0 0% 100%;
  --at: 215 92% 43%;
  --at-foreground: 0 0% 100%;

  /* lines & focus */
  --border: 150 12% 90%;            /* #E3E8E5 */
  --input: 150 12% 90%;
  --ring: 160 84% 30%;

  /* deep surface (footer) */
  --footer: 150 24% 8%;

  /* charts (chart-1 follows primary) */
  --chart-1: 160 84% 30%;
  --chart-2: 173 58% 39%;
  --chart-3: 197 37% 24%;
  --chart-4: 43 74% 66%;
  --chart-5: 27 87% 67%;

  /* sidebar */
  --sidebar: 0 0% 100%;
  --sidebar-foreground: 150 23% 10%;
  --sidebar-primary: 160 84% 30%;
  --sidebar-primary-foreground: 0 0% 100%;
  --sidebar-accent: 150 16% 95%;
  --sidebar-accent-foreground: 150 23% 10%;
  --sidebar-border: 150 12% 90%;
  --sidebar-ring: 160 84% 30%;
}
```

- [ ] **Step 2: Replace the entire `.dark { … }` block in `app/globals.css`**

Replace lines 74–119 with:
```css
.dark {
  --background: 0 0% 1%;            /* #030303 */
  --foreground: 0 0% 98%;          /* #FAFAFA */
  --card: 240 5% 10%;              /* #18181B */
  --card-foreground: 0 0% 98%;
  --popover: 240 5% 10%;
  --popover-foreground: 0 0% 98%;

  --primary: 158 64% 52%;           /* #34D399 */
  --primary-foreground: 153 45% 8%;
  --accent-soft: 158 64% 52%;
  --brand-accent: 213 94% 68%;      /* #60A5FA */

  --secondary: 240 4% 16%;          /* #27272A */
  --secondary-foreground: 0 0% 98%;
  --muted: 240 4% 14%;
  --muted-foreground: 240 5% 65%;   /* #A1A1AA */
  --accent: 240 4% 16%;
  --accent-foreground: 0 0% 98%;

  --destructive: 0 84% 60%;
  --destructive-foreground: 0 0% 98%;
  --success: 142 71% 45%;           /* #22C55E */
  --success-foreground: 153 45% 8%;
  --warning: 38 92% 50%;
  --warning-foreground: 0 0% 10%;

  --mtn: 48 100% 50%;
  --mtn-foreground: 0 0% 10%;
  --telecel: 353 90% 58%;
  --telecel-foreground: 0 0% 100%;
  --at: 215 90% 60%;
  --at-foreground: 0 0% 100%;

  --border: 240 4% 16%;            /* #27272A */
  --input: 240 4% 16%;
  --ring: 158 64% 52%;

  --footer: 240 6% 3%;             /* #050506 */

  --chart-1: 158 64% 52%;
  --chart-2: 173 58% 45%;
  --chart-3: 197 37% 40%;
  --chart-4: 43 74% 66%;
  --chart-5: 27 87% 67%;

  --sidebar: 240 6% 6%;
  --sidebar-foreground: 0 0% 90%;
  --sidebar-primary: 158 64% 52%;
  --sidebar-primary-foreground: 153 45% 8%;
  --sidebar-accent: 240 4% 14%;
  --sidebar-accent-foreground: 0 0% 98%;
  --sidebar-border: 240 4% 14%;
  --sidebar-ring: 158 64% 52%;
}
```

- [ ] **Step 3: Verify the emerald primary is present (sanity grep)**

Run: `rg "158 64% 52%" app/globals.css`
Expected: at least 4 matches (`--primary`, `--accent-soft`, `--ring`, `--sidebar-primary`, `--chart-1` in `.dark`).

- [ ] **Step 4: Verify the build compiles**

Run: `npm run build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add app/globals.css
git commit -m "feat(reskin): retint design tokens to emerald (dark #030303 + light) + footer/radius"
```

---

## Task 3: Tokenize the scrollbar

**Files:**
- Modify: `app/globals.css:130-165` (webkit scrollbar rules)

- [ ] **Step 1: Replace the global scrollbar-thumb colors**

In `app/globals.css`, replace:
```css
::-webkit-scrollbar-thumb {
  background: rgba(100, 150, 255, 0.6);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: rgba(100, 150, 255, 0.9);
}
```
with:
```css
::-webkit-scrollbar-thumb {
  background: hsl(var(--primary) / 0.45);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: hsl(var(--primary) / 0.75);
}
```

- [ ] **Step 2: Replace the nav scrollbar colors**

Replace:
```css
nav::-webkit-scrollbar-track {
  background: rgba(59, 130, 246, 0.15);
}

nav::-webkit-scrollbar-thumb {
  background: rgba(59, 130, 246, 0.5);
  border-radius: 3px;
}

nav::-webkit-scrollbar-thumb:hover {
  background: rgba(59, 130, 246, 0.8);
}
```
with:
```css
nav::-webkit-scrollbar-track {
  background: hsl(var(--primary) / 0.12);
}

nav::-webkit-scrollbar-thumb {
  background: hsl(var(--primary) / 0.5);
  border-radius: 3px;
}

nav::-webkit-scrollbar-thumb:hover {
  background: hsl(var(--primary) / 0.8);
}
```

- [ ] **Step 3: Verify no rgba scrollbar colors remain**

Run: `rg "rgba\(" app/globals.css`
Expected: no matches (all scrollbar rgba removed).

- [ ] **Step 4: Commit**

```bash
git add app/globals.css
git commit -m "feat(reskin): tokenize scrollbar colors to emerald primary"
```

---

## Task 4: Verify the foundation cascade (both themes)

This task confirms the token retint cascaded to existing shadcn primitives before we touch the landing page.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: server on http://localhost:3000.

- [ ] **Step 2: Screenshot an existing token-driven page in light mode**

Use the webapp-testing skill (Playwright) to navigate to `http://localhost:3000/auth/login` and capture a screenshot.
Expected: emerald primary button + emerald focus ring (was indigo); white card on faint-emerald background; **no layout breakage**. (Note: hardcoded gradients on the login brand panel will still be indigo — that's expected, fixed in Plan 2/3.)

- [ ] **Step 3: Screenshot the same page in dark mode**

In the browser, set dark mode (run in DevTools console: `localStorage.theme='dark'; location.reload()` — or toggle via the header on a page that has the toggle). Re-screenshot `/auth/login`.
Expected: near-black `#030303` background, `#18181B` cards, emerald primary — primitives cascaded. Hardcoded colors remain off (expected).

- [ ] **Step 4: Record the result**

Confirm in the task notes: "Token cascade verified — shadcn primitives are emerald in both themes; remaining off-colors are hardcoded (Plan 2 codemod)." No commit (verification only).

---

## Task 5: Landing — rebuild Nav + Metric bar

From here we rewrite `app/page.tsx`. Keep the top-of-file `"use client"`, the imports, the `Step` component, the mockup components (retinted in Task 8), the `HomeAIChatWidget`, `useCommunityLink`, and the JSON-LD `WebSite` schema script. Replace the visual sections.

**Files:**
- Modify: `app/page.tsx` (imports + nav region, lines ~6-11 imports and ~338-356 nav)

- [ ] **Step 1: Update the lucide import line to include new icons**

Ensure these icons are imported (add any missing to the existing `lucide-react` import at lines 6-11): `Cpu`, `Hash`, `Globe`, `Smartphone`, `Code2`, `Database`, `Send`, `FileCheck2`, `Search`, `Store`. Keep all existing icons used by the retained mockups.

- [ ] **Step 2: Replace the `<nav>` (lines 338-356) with the dark language nav**

```tsx
      {/* Navigation */}
      <nav className="sticky top-0 z-50 flex items-center justify-between px-4 sm:px-6 py-4 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="flex items-center gap-3">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-primary to-brand-accent" />
          <h1 className="text-lg sm:text-xl font-display font-semibold text-foreground tracking-tight">DATAGOD</h1>
        </div>
        <div className="hidden md:flex items-center gap-6">
          {["Networks", "Services", "How it works", "Shops"].map((l) => (
            <a key={l} href="#how-it-works" className="font-mono text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors">{l}</a>
          ))}
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <Link href="/auth/login"><Button variant="ghost" className="font-display">Sign In</Button></Link>
          <Link href="/auth/signup"><Button className="font-display">Get Started</Button></Link>
        </div>
      </nav>
```

- [ ] **Step 3: Add the metric bar as the first element inside the hero `<section>` (replaces the eyebrow badge region)**

Immediately inside `<section ... py-8 sm:py-20>` (line 359), before the hero grid, add:
```tsx
        {/* Metric bar */}
        <div className="mb-8 flex flex-wrap gap-x-7 gap-y-2 border-b border-border pb-5 font-mono text-[11px] text-muted-foreground">
          <span>Delivery <span className="text-primary">~8s</span></span>
          <span>Uptime <span className="text-primary">99.99%</span></span>
          <span>Orders <span className="text-primary">500,000+</span></span>
          <span>AI <span className="text-primary">5 assistants</span></span>
        </div>
```

- [ ] **Step 4: Verify build + commit**

Run: `npm run build` → Expected: success.
```bash
git add app/page.tsx
git commit -m "feat(reskin): landing nav + metric bar in dark/emerald language"
```

---

## Task 6: Landing — rebuild Hero + AI assistants card + Community link

**Files:**
- Modify: `app/page.tsx` (hero grid region, ~lines 360-430)

- [ ] **Step 1: Replace the hero grid (the `<div className="grid items-center ...">` block) with copy + AI card**

```tsx
        <div className="relative grid items-center gap-10 lg:grid-cols-2">
          {/* ambient grid + glow */}
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 opacity-30 [mask-image:radial-gradient(circle_at_75%_0,#000,transparent_72%)]"
               style={{ backgroundImage: "linear-gradient(hsl(var(--border)) 1px,transparent 1px),linear-gradient(90deg,hsl(var(--border)) 1px,transparent 1px)", backgroundSize: "36px 36px" }} />
          {/* Left: copy */}
          <div className="text-center lg:text-left">
            <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-primary mb-4">
              <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_10px_hsl(var(--primary))]" /> Instant delivery · all networks
            </span>
            <h2 className="font-display text-3xl sm:text-5xl font-semibold tracking-tight text-foreground leading-[1.04]">
              Buy data &amp; airtime in{" "}
              <span className="bg-gradient-to-r from-primary to-brand-accent bg-clip-text text-transparent">10 seconds.</span>
            </h2>
            <p className="mt-4 text-base sm:text-lg text-muted-foreground max-w-xl mx-auto lg:mx-0">
              Instant bundles for MTN, Telecel and AT — pay from your wallet, or open your own shop and resell to earn. Built for Ghana.
            </p>
            <div className="mt-5 flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
              <Link href="/auth/signup"><Button size="lg" className="gap-2 w-full sm:w-auto">Get started <ArrowRight className="w-4 h-4" /></Button></Link>
              <GuestPurchaseButton variant="outline" className="w-full sm:w-auto" />
            </div>
            <div className="mt-6 flex justify-center lg:justify-start gap-8">
              <div><div className="font-display text-2xl font-bold text-foreground">3</div><div className="text-xs text-muted-foreground">networks</div></div>
              <div><div className="font-display text-2xl font-bold text-foreground">500k+</div><div className="text-xs text-muted-foreground">orders delivered</div></div>
              <div><div className="font-display text-2xl font-bold text-foreground">~8s</div><div className="text-xs text-muted-foreground">avg delivery</div></div>
            </div>
            {communityLoading ? (
              <div className="mt-5 flex justify-center lg:justify-start"><Skeleton className="h-11 w-full sm:w-56 rounded-md" /></div>
            ) : communityLink ? (
              <a href={communityLink} target="_blank" rel="noopener noreferrer" className="mt-5 inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 font-display text-sm font-semibold text-primary hover:bg-primary/15 transition-colors">
                <MessageCircle className="w-4 h-4" /> Join Community
              </a>
            ) : null}
          </div>
          {/* Right: AI assistants card */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-display text-sm font-semibold text-foreground"><Cpu className="w-[18px] h-[18px] text-primary" /> DATAGOD AI</div>
              <span className="flex items-center gap-1.5 font-mono text-[9px] text-primary"><span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]" />ONLINE</span>
            </div>
            <p className="mt-1 mb-3 text-[11px] text-muted-foreground">One assistant — tuned for every surface you use.</p>
            {[
              ["WEB", "Browse plans, track any order, explain dealer pricing."],
              ["SHOP", "Find bundles & start checkout for you."],
              ["WHATSAPP", "Order by chat, re-verify stuck top-ups, file complaints."],
              ["DEALER", "“Buy 5GB MTN for 024…”, today’s sales, manage USSD."],
              ["ADMIN", "Fulfil orders & manage users, shops & payouts by chat."],
            ].map(([tag, txt]) => (
              <div key={tag} className="flex gap-3 border-t border-border py-2">
                <div className="w-16 shrink-0 font-mono text-[9px] leading-snug text-primary">{tag}</div>
                <div className="text-[11px] text-muted-foreground">{txt}</div>
              </div>
            ))}
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2.5">
              <span className="flex-1 text-[11px] text-muted-foreground">Ask DATAGOD anything…</span>
              <span className="grid h-[22px] w-[22px] place-items-center rounded-md bg-primary text-primary-foreground"><ArrowRight className="w-3 h-3" /></span>
            </div>
          </div>
        </div>
```

- [ ] **Step 2: Remove the now-orphaned old phone-mockup block** (the `<div className="hidden lg:flex justify-center">…</div>` that held the old wallet phone, ~lines 406-429). Delete it entirely (replaced by the AI card above).

- [ ] **Step 3: Verify build + commit**

Run: `npm run build` → success.
```bash
git add app/page.tsx
git commit -m "feat(reskin): landing hero with AI assistants card + community link"
```

---

## Task 7: Landing — Network strip + Services showcase

**Files:**
- Modify: `app/page.tsx` (network strip ~lines 433-438; replace the old Features Grid ~lines 441-470 with the Services showcase)

- [ ] **Step 1: Replace the network strip chips with token versions**

```tsx
        {/* Network strip */}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3 sm:mt-14">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-bold text-foreground"><span className="grid h-5 w-5 place-items-center rounded bg-mtn text-mtn-foreground text-[10px] font-black">M</span> MTN</span>
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-bold text-foreground"><span className="grid h-5 w-5 place-items-center rounded bg-telecel text-telecel-foreground text-[10px] font-black">T</span> Telecel</span>
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-bold text-foreground"><span className="grid h-5 w-5 place-items-center rounded bg-at text-at-foreground text-[10px] font-black">A</span> AT iShare</span>
          <span className="rounded-full border border-border bg-card px-4 py-2 text-sm text-muted-foreground">+ Airtime · AFA · Results checker</span>
        </div>
```

- [ ] **Step 2: Replace the old 4-card Features Grid with the grouped Services showcase**

```tsx
        {/* Services showcase */}
        <div className="mt-14 sm:mt-20">
          {([
            ["Buy & use", [
              [Database, "Data Bundles", "MTN, Telecel, AT-iShare & AT-BigTime — in seconds.", null],
              [Zap, "Airtime", "Top up any network instantly from your wallet.", null],
              [UserPlus, "AFA Registration", "Register AFA / iShare numbers without the queue.", null],
              [FileCheck2, "Results Checker", "WASSCE, BECE & NovDec PINs delivered instantly.", null],
              [Search, "Results Check Service", "No PIN to spare? We check your results for you.", null],
              [Wallet, "Wallet", "Load once via Paystack, then buy fast — no card each time.", null],
            ]],
            ["Earn & grow", [
              [Store, "Your Own Shop", "A white-label storefront with your name, logo & prices.", "RESELL"],
              [Hash, "Your Own USSD", "Get a short USSD code — customers buy with no internet.", "NEW"],
              [Users, "Sub-Agent Network", "Recruit sellers under you and earn on every sale.", null],
              [Banknote, "Instant Withdrawals", "Cash out profits to Mobile Money or bank — verified.", null],
              [Send, "Bulk SMS", "Campaigns with your own sender ID, address book & templates.", null],
            ]],
          ] as const).map(([group, items]) => (
            <div key={group} className="mb-8">
              <div className="mb-4 flex items-center gap-3 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                {group}<span className="h-px flex-1 bg-border" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
                {items.map(([Icon, title, desc, tag]) => (
                  <div key={title} className="rounded-xl border border-border bg-card p-4 sm:p-5 transition-colors hover:border-primary">
                    <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg border border-primary/25 bg-primary/10"><Icon className="h-[18px] w-[18px] text-primary" /></div>
                    <h3 className="mb-1.5 flex items-center gap-2 font-display font-semibold text-foreground">{title}{tag && <span className="rounded-full border border-primary/30 px-1.5 py-0.5 font-mono text-[8px] text-primary">{tag}</span>}</h3>
                    <p className="text-sm text-muted-foreground">{desc}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {/* Channels */}
          <div className="mb-2 flex items-center gap-3 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Order from anywhere<span className="h-px flex-1 bg-border" /></div>
          <div className="flex flex-wrap gap-2.5">
            {[[Globe, "Web storefront"], [MessageCircle, "WhatsApp bot"], [Hash, "USSD"], [Smartphone, "Mobile app"], [Code2, "Developer API"]].map(([Icon, label]) => (
              <span key={label as string} className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3.5 py-2.5 font-display text-sm font-semibold text-foreground"><Icon className="h-[15px] w-[15px] text-primary" /> {label}</span>
            ))}
          </div>
        </div>
```

- [ ] **Step 3: Verify build + commit**

Run: `npm run build` → success. Confirm `Banknote`, `Users`, `Wallet`, `Zap`, `UserPlus` are imported (they already are in the original file; add `Database`, `Hash`, `Globe`, `Smartphone`, `Code2`, `Send`, `FileCheck2`, `Search`, `Store` if missing).
```bash
git add app/page.tsx
git commit -m "feat(reskin): landing network strip + grouped services showcase"
```

---

## Task 8: Landing — tokenize How-It-Works mockups + rebuild CTA + Footer

The `Step` component and the 18 `Mock*` components are **retained** structurally; apply this exhaustive color-token replacement across the whole file (it also cleans the `Step` badge and tip callouts). Then rewrite the CTA band and footer.

**Files:**
- Modify: `app/page.tsx` (`Step` at lines 17-54; `Mock*` at 56-305; how-it-works tips; CTA 695-707; footer 710-749)

- [ ] **Step 1: Apply this find → replace color map across `app/page.tsx`** (replace ALL occurrences of each):

| Find | Replace |
|---|---|
| `bg-gradient-to-r from-primary to-purple-600` (and `bg-gradient-to-br from-primary to-purple-600`) | `bg-primary` (drop the gradient entirely) |
| `bg-gradient-to-br from-primary to-violet-600` (and `bg-gradient-to-r from-primary to-violet-600`) | `bg-primary` (drop the gradient entirely) |
| `text-white` (on emerald buttons/badges) | `text-primary-foreground` |
| `bg-green-50` | `bg-success/10` |
| `text-green-500` / `text-green-600` / `text-green-700` | `text-success` |
| `bg-green-500` | `bg-success` |
| `border-green-*` | `border-success/30` |
| `bg-yellow-50` | `bg-warning/10` |
| `text-yellow-600` / `text-yellow-700` | `text-warning` |
| `text-orange-600` | `text-warning` |
| `bg-amber-50` + `text-amber-800` (tip box) | `bg-warning/10` + `text-warning` |
| `border-amber-*` | `border-warning/30` |
| `bg-purple-50` + `text-purple-800` (tip box) | `bg-primary/10` + `text-primary` |
| `text-purple-600` | `text-primary` |
| `bg-purple-600` | `bg-primary` |
| `bg-primary/5` (tip box) | keep (already token) |
| `bg-muted/40` (mockup backgrounds) | keep (already token) |

Leave **`bg-mtn` / `bg-telecel` / `bg-at` / `bg-yellow-400` (MTN dot) / `bg-red-500` (Telecel dot)** in the `MockNetworkPicker` network swatches **unchanged** — they represent telco brand colors. (If a swatch uses `bg-primary` for AT-iShare, keep it.)

- [ ] **Step 2: Replace the How-It-Works section header badge (line ~477)**

Replace:
```tsx
            <span className="inline-block px-3 py-1 bg-primary/10 text-primary text-xs font-bold rounded-full uppercase tracking-wider mb-3">
              How It Works
            </span>
```
with:
```tsx
            <span className="inline-block mb-3 font-mono text-[11px] uppercase tracking-wider text-primary">How It Works</span>
```
And add `font-display` to the section `<h2>` headings throughout the file (the hero `h2`, the how-it-works `h2`, the CTA `h2`): add the class `font-display` to each `<h2>`.

- [ ] **Step 3: Replace the CTA band (lines 695-707)**

```tsx
      {/* CTA Section */}
      <section className="relative border-t border-border py-12 sm:py-16 text-center"
               style={{ backgroundImage: "radial-gradient(500px 200px at 50% 0, hsl(var(--primary) / 0.16), transparent 70%)" }}>
        <div className="max-w-4xl mx-auto px-4 sm:px-6 space-y-4 sm:space-y-6">
          <h2 className="font-display text-2xl sm:text-3xl md:text-4xl font-semibold text-foreground">Ready to get started?</h2>
          <p className="text-sm sm:text-lg text-muted-foreground">Join thousands who trust DATAGOD for data, airtime &amp; more.</p>
          <Link href="/auth/signup"><Button size="lg" className="w-full sm:w-auto">Create your free account</Button></Link>
        </div>
      </section>
```

- [ ] **Step 4: Replace the footer (lines 710-749) — tokenized deep surface**

```tsx
      {/* Footer */}
      <footer className="bg-footer text-muted-foreground py-10 sm:py-12 border-t border-border">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6 sm:gap-8 mb-8">
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="h-5 w-5 rounded bg-gradient-to-br from-primary to-brand-accent" />
                <span className="font-display font-semibold text-foreground">DATAGOD</span>
              </div>
              <p className="text-sm">Your trusted data hub for Ghana — data, airtime, AFA, vouchers &amp; SMS.</p>
            </div>
            {[["Product", ["How It Works", "Services", "Pricing"]], ["Company", ["About", "Blog", "Contact"]], ["Legal", ["Privacy", "Terms", "Cookies"]]].map(([h, items]) => (
              <div key={h as string}>
                <h4 className="mb-4 font-mono text-[11px] uppercase tracking-wider text-foreground/80">{h}</h4>
                <ul className="space-y-2 text-sm">
                  {(items as string[]).map((i) => <li key={i}><a href="#how-it-works" className="hover:text-foreground">{i}</a></li>)}
                </ul>
              </div>
            ))}
          </div>
          <div className="border-t border-border pt-8 text-center text-sm">
            <p>&copy; 2026 DATAGOD. All rights reserved.</p>
          </div>
        </div>
      </footer>
```

- [ ] **Step 5: Verify no off-token colors remain in the landing (network tokens excepted)**

Run: `rg -n "purple-|violet-|indigo-|gray-9|to-purple|to-violet|bg-green-50|text-green-[567]|bg-yellow-50|amber-50|blue-400" app/page.tsx`
Expected: **no matches**. (If any remain, apply the Step 1 map to them.)

- [ ] **Step 6: Build + commit**

Run: `npm run build` → success.
```bash
git add app/page.tsx
git commit -m "feat(reskin): tokenize how-it-works mockups + rebuild CTA + footer"
```

---

## Task 9: Restyle GuestPurchaseButton

**Files:**
- Modify: `components/GuestPurchaseButton.tsx:47-51`

- [ ] **Step 1: Replace the `buttonStyles` map**

Replace:
```tsx
    const buttonStyles = {
        primary: 'bg-primary hover:bg-primary/90 text-white',
        secondary: 'bg-gray-600 hover:bg-gray-700 text-white',
        outline: 'border-2 border-primary text-primary hover:bg-primary/5'
    }
```
with:
```tsx
    const buttonStyles = {
        primary: 'bg-primary hover:bg-primary/90 text-primary-foreground',
        secondary: 'bg-secondary hover:bg-secondary/80 text-secondary-foreground',
        outline: 'border-2 border-primary text-primary hover:bg-primary/5'
    }
```

- [ ] **Step 2: Build + commit**

Run: `npm run build` → success.
```bash
git add components/GuestPurchaseButton.tsx
git commit -m "feat(reskin): tokenize GuestPurchaseButton variants"
```

---

## Task 10: Verify the landing in both themes + mobile, finalize

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Screenshot the landing — desktop, dark**

Use webapp-testing (Playwright): set dark mode (`localStorage.theme='dark'`), navigate to `http://localhost:3000/`, viewport 1280×900, full-page screenshot.
Expected: emerald-on-near-black hero with AI card + metric bar; services showcase grouped; tokenized how-it-works; deep footer. No indigo/purple anywhere.

- [ ] **Step 3: Screenshot the landing — desktop, light**

Set light mode (`localStorage.theme='light'`), reload, screenshot.
Expected: emerald-on-light, white cards, legible; no broken contrast.

- [ ] **Step 4: Screenshot the landing — mobile (360px), dark**

Viewport 360×780, dark, full-page screenshot.
Expected: nav collapses (links hidden, Sign In + Get Started visible), hero stacks with AI card below, metric bar wraps, services 1-up, nothing `display:none`-dropped. Tap targets ≥44px.

- [ ] **Step 5: Confirm acceptance**

Verify against spec §13: build passes; `rg` from Task 8 Step 5 is clean; JSON-LD `WebSite` script still present (`rg "application/ld\+json" app/page.tsx` → 1 match); `#how-it-works` anchor intact (`rg 'id="how-it-works"' app/page.tsx` → 1 match). Record screenshots in the task notes.

- [ ] **Step 6: Final commit (if any cleanup)**

```bash
git add -A
git commit -m "test(reskin): verify landing in both themes + mobile" --allow-empty
```

---

## Notes for the executor

- **Do not flip `defaultTheme` to dark** — Plan 2 does that after the codemod.
- The home `AIChatWidget` keeps its current violet until Plan 2; that's expected, not a bug.
- If `npm run build` flags an unused import you removed (e.g. `Package`, `CreditCard` no longer used after the features grid was replaced), delete it from the lucide import line.
- Network brand colors (`bg-mtn/telecel/at`, MTN-yellow/Telecel-red dots in `MockNetworkPicker`) must stay — never tokenize them to emerald.
