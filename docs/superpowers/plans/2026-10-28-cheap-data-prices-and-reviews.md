# Cheap-Data Price Pages, Guides, Attribution & Review Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Win "cheap data / data price" searches with live full price lists, a comparison page and guides; measure which landing page each sign-up came from; collect Google reviews from customers with a completed order.

**Architecture:** Extends the 2026-10-27 SEO system. `lib/seo/live-facts.ts` gains the adjusted customer price and per-network price groups; the existing network product pages render them. New registry entries/pages reuse `components/seo/*`. Attribution is captured client-side, carried through sign-up, and stored on `users.signup_source`. The review card is a dashboard component fed by an authenticated route.

**Tech Stack:** Next.js 15 App Router, TypeScript, Supabase (PostgREST + service role), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-cheap-data-prices-and-reviews-design.md`

## Global Constraints

- Copy rules (test-enforced in `lib/seo/products.test.ts`): never "instant"; speed line `Usually delivered within minutes.`; refund line `If an order fails, you get your money back.`; wallet wording "fund your wallet with MoMo or card"; descriptions 120–160 chars; titles end `| DATAGOD`; no unconditional iShare/BigTime claims.
- Marketing pages: main site only (`assertMainSite` in metadata), own canonical + own twitter metadata (`buildProductMetadata`), metadata-stage `notFound()` when dark.
- Public price = `packages.price` adjusted with `getAdjustmentForNetwork` + `applyPriceAdjustment` from `lib/price-adjustment-service.ts`, reused verbatim. Never `dealer_price`. Never `getPriceAdjustments()` (swallows errors).
- Partial fact reads are never cached (`PartialFactsError`); a failed price source = data pages on without prices.
- Edit/Write tools only — no sed/shell edits of code. Tell subagents the same.
- `next build` with placeholder env passes before any push to main.
- Another session has **uncommitted** edits in the main repo to `lib/auth.ts`, `lib/auth-complete.ts`, `app/auth/signup/page.tsx`, `app/auth/complete-profile/page.tsx`. Task 7 must start from the latest `origin/main` and re-check those files; do not merge local `main`.

## Review Focus

1. **Migration not yet applied when the code deploys** → sign-up must still work. The `signup_source` write is a separate best-effort update after the profile upsert; its failure is logged (no PII) and ignored. Test in Task 7.
2. **Odd `packages.size` strings** ("1 gb", "1.5GB", "2000MB", "Unlimited", "") → parse or show "—" per-GB; never NaN on the page. Test in Task 1.
3. **Adjustment yields ≤ 0 or non-finite price** (e.g. -100%, null columns) → row excluded; null column = 0% (matches dashboard `|| 0`). Test in Task 1.
4. **Duplicate size rows within one stored network value** → show the cheapest one only. Test in Task 1.
5. **Hostile/oversized first-touch data** (huge referrer, script in utm, non-JSON localStorage) → sanitized, capped, never blocks sign-up. Test in Task 7.

---

### Task 1: Adjusted customer price + price groups in live facts

**Files:**
- Create: `lib/seo/data-prices.ts`, `lib/seo/data-prices.test.ts`
- Modify: `lib/seo/live-facts.ts`, `lib/seo/live-facts.test.ts`

**Interfaces:**
- Produces:
  - `parseSizeGb(size: string | null | undefined): number | null` — "1GB"→1, "1.5 gb"→1.5, "500MB"→0.5, "2000MB"→2 (1000 MB = 1 GB), else null.
  - `type PriceRow = { size: string; price: number; gb: number | null; perGb: number | null }`
  - `type PriceGroup = { network: string; rows: PriceRow[] }` (network = stored `packages.network` value)
  - `buildPriceGroups(rows: Array<{ network: string; size: string | null; price: number | string | null; is_available: boolean | null }>, adjustments: PriceAdjustments): Record<"MTN" | "Telecel" | "AT", PriceGroup[]>` — adjusted price via the reused helpers, ≤0/non-finite dropped, cheapest per (network value, size), rows sorted by `gb` asc (null gb last, then by price), groups sorted by network value.
  - `RawFacts` gains `priceAdjustments: PriceAdjustments | null` (null = read failed) and package rows gain `size`.
  - `LiveFacts` gains `prices: Record<"MTN" | "Telecel" | "AT", PriceGroup[]>` and `loadedAt: string` (ISO). `FAILED_RAW.priceAdjustments = null`.
  - Data products' `fromPrice` = min adjusted price; when `packages` OR `priceAdjustments` is null → data pages on, no prices, empty groups (existing failed-packages behaviour).

- [ ] **Step 1: Write failing tests** in `data-prices.test.ts`: `parseSizeGb` cases above plus `"Unlimited"`, `""`, `null` → null; `buildPriceGroups` with adjustments `{ price_adjustment_mtn: 10, … 0 }`: MTN 1GB price 5 → 5.5; duplicate MTN "1GB" rows 6 and 5 → one row price 5.5; `-100` adjustment → row dropped; "AT-iShare" and "AT-BigTime" rows → two AT groups using each column (`getAdjustmentForNetwork` mapping); unavailable rows skipped; `perGb` for "500MB" at 3 → 6.
- [ ] **Step 2:** In `live-facts.test.ts`: healthy loader reads the singleton `app_settings` row (`.is("key", null)`) columns `price_adjustment_mtn, price_adjustment_telecel, price_adjustment_at_ishare, price_adjustment_at_bigtime`; with MTN +10% and package price 4 → `fromPrice` 4.4; that read failing → `failed` contains `"price-adjust"`, mtn-data available with `fromPrice: null`; packages select is `"network, size, price, is_available"`. The fake db must distinguish the singleton row read (adjustments vs `ussd_shop_dial_code`) by the selected columns.
- [ ] **Step 3:** Run `npx vitest run lib/seo` → new tests FAIL.
- [ ] **Step 4:** Implement `data-prices.ts`; add source `"price-adjust"` to `loadRawFacts` (throws on error; null column → 0); wire `buildLiveFacts` (`loadedAt` set in `loadCompleteLiveFacts`/fallback path with `new Date().toISOString()`, tests may pass it in).
- [ ] **Step 5:** `npx vitest run lib/seo` → PASS; `npx tsc --noEmit` → only the 7 baseline errors in `lib/leaderboard/delivery.test.ts`.
- [ ] **Step 6:** Commit `feat(seo): adjusted customer prices and per-network price groups`.

### Task 2: Price tables on the network pages

**Files:**
- Create: `components/seo/price-table.tsx`, `components/seo/buy-button.tsx` (client)
- Modify: `components/seo/product-page.tsx`, `lib/seo/products.ts` (mtn/telecel/at title + description), `lib/seo/json-ld.ts` + its test

**Interfaces:**
- Consumes: `LiveFacts.prices`, `LiveFacts.loadedAt` (Task 1).
- Produces: `buildProductJsonLd` emits `AggregateOffer { lowPrice, highPrice, offerCount, priceCurrency: "GHS" }` for data products when groups are non-empty (else existing single-offer behaviour); `<BuyButton />` (href `/dashboard/data-packages` when a Supabase session exists client-side, else `/auth/signup`; renders `/auth/signup` on the server/first paint).

- [ ] **Step 1: Failing tests** in `json-ld.test.ts`: MTN facts with rows 5.5 and 20 → `offers["@type"] === "AggregateOffer"`, `lowPrice "5.50"`, `highPrice "20.00"`, `offerCount 2`; no rows → no AggregateOffer. `products.test.ts` existing rules still pass for the new titles ("MTN Data Bundle Prices Today - Cheap MTN Data in Ghana | DATAGOD", and equivalents for Telecel and AT).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement: `PriceTable` (one table per group; H3 per group only on AT when >1 group; columns Bundle / Price / Price per GB with "—"; caption "Prices updated <d MMM yyyy>" in `Africa/Accra` via `Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Accra", day: "numeric", month: "short", year: "numeric" })`); render it in `product-page.tsx` for the three data keys right after the hero; replace those pages' Buy links with `BuyButton`. Mobile-first, `lg:` widening, navy primary, existing `CARD` style.
- [ ] **Step 4:** `npx vitest run lib/seo` PASS; headless screenshot of `/mtn-data` at 500px and 1280px per `reference-headless-screenshots` with mocked facts or a dev server (placeholder env renders the no-prices state — acceptable; note it in the report).
- [ ] **Step 5:** Commit `feat(seo): full live price lists on network data pages`.

### Task 3: Refresh public prices on admin edits

**Files:**
- Modify: `app/api/admin/packages/route.ts`, `app/api/admin/packages/bulk-update-price/route.ts`, `app/api/admin/packages/toggle-availability/route.ts`, `app/api/admin/packages/delete/route.ts`, `app/api/admin/settings/route.ts`

- [ ] **Step 1:** After each successful write in the four package routes call `revalidateTag("seo-live-facts")` (import from `next/cache`). In the settings PUT, extend the existing `ussd_shop_dial_code` check: revalidate when that field or any `price_adjustment_*` field is in the body.
- [ ] **Step 2:** `npx tsc --noEmit` baseline only. **Step 3:** Commit `feat(seo): admin price edits refresh public price pages`.

### Task 4: `/cheapest-data-ghana` comparison page

**Files:**
- Create: `lib/seo/compare.ts`, `lib/seo/compare.test.ts`, `app/cheapest-data-ghana/page.tsx`, `components/seo/comparison.tsx`
- Modify: `lib/seo/products.ts` (+ `ProductKey` `"cheapest-data"`), `lib/seo/live-facts.ts` (availability), tests

**Interfaces:**
- Produces: `buildComparison(prices: LiveFacts["prices"]): { best: Array<{ network: "MTN" | "Telecel" | "AT"; perGb: number; size: string; price: number }>; sizes: Array<{ gb: 1 | 2 | 5 | 10; cells: Record<"MTN" | "Telecel" | "AT", number | null> }> }` — `best` only for networks with a per-GB value; `sizes` only rows where ≥1 network has that exact gb; per network the cheapest across its groups.
- `products["cheapest-data"].available` = any network has ≥1 price row.

- [ ] **Step 1: Failing tests:** `buildComparison` picks the lowest per-GB (tie → cheaper price), omits 10GB when nobody sells it, null cell for a network lacking a size; live-facts availability true/false; registry entry passes all `products.test.ts` rules (path `/cheapest-data-ghana`, h1 "Cheapest data bundles in Ghana today", group "data", channels `["web"]`, FAQs incl. `speedFaq` + `refundFaq`, related `["mtn-data","telecel-data","at-data","airtime"]`, `hasOwnPage: true`); `discovery.test.ts`: sitemap/llms include it only when available.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; page is a two-export wrapper like `app/mtn-data/page.tsx` that renders the comparison inside the product page (add a slot in `renderProductPage` keyed by product key, mirroring the price table hook). Copy names only our own prices; no competitor claims.
- [ ] **Step 4:** Tests PASS. **Step 5:** Commit `feat(seo): cheapest data in Ghana comparison page`.

### Task 5: Guides

**Files:**
- Create: `lib/seo/guides.ts`, `lib/seo/guides.test.ts`, `app/guides/page.tsx`, `app/guides/[slug]/page.tsx`, `components/seo/guide-page.tsx`
- Modify: `lib/seo/discovery.ts` (+test) for sitemap and llms.txt

**Interfaces:**
- Produces: `type Guide = { slug: string; title: string; description: string; h1: string; published: boolean; sections: Array<{ heading: string; paragraphs: string[]; steps?: string[] }>; faqs: Faq[]; related: ProductKey[]; updated: string /* YYYY-MM-DD */ }`; `GUIDES: Guide[]`; `getPublishedGuide(slug): Guide | null`; `publishedGuides(): Guide[]`.
- Guides at launch: `buy-data-with-momo` (published) and `check-data-balance` (`published: false`, sections contain no codes until the owner supplies them).

- [ ] **Step 1: Failing tests:** every guide obeys the copy rules (reuse the products-test helpers: no "instant", 120–160 description, title suffix); unpublished guide → `getPublishedGuide` null and absent from sitemap/llms; published guide present at `/guides/<slug>`; `/guides` hub in sitemap only when ≥1 published.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. `[slug]` page: `generateStaticParams` from published guides, metadata via `buildProductMetadata`-style helper (own canonical, twitter), `assertMainSite`, `notFound()` for unknown/unpublished at metadata stage; JSON-LD `Article` (headline, dateModified = `updated`, publisher DATAGOD) + `BreadcrumbList` + FAQ. Buy-data guide mentions WhatsApp/USSD only when `facts.products.whatsapp/ussd.available`.
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat(seo): guides hub and buy-data-with-MoMo guide`.

### Task 6: Google review card

**Files:**
- Create: `lib/review-prompt.ts`, `lib/review-prompt.test.ts`, `app/api/admin/settings/google-review-url/route.ts`, `components/admin/google-review-url-card.tsx`, `app/api/review-prompt/route.ts`, `components/dashboard/review-prompt-card.tsx`
- Modify: `app/admin/settings/page.tsx`, `app/dashboard/layout.tsx`

**Interfaces:**
- Produces:
  - `validateReviewUrl(v: unknown): { ok: true; value: string | null } | { ok: false; error: string }` — empty → null; only `https:` with host `g.page`, `search.google.com`, `www.google.com`, `maps.app.goo.gl`, `g.co`; max 500 chars.
  - `parseReviewUrl(raw: unknown): string | null` (stored JSON `{ "url": … }` in `app_settings` key `google_review_url`).
  - `type ReviewCardState = { dismissedAt?: string; clicked?: boolean }`; `shouldShowReviewCard(state: ReviewCardState | null, now: Date): boolean` — false if clicked; false if dismissed < 30 days ago; else true.
  - `GET /api/review-prompt` (Bearer token, `supabase.auth.getUser`) → `{ show: boolean; url: string | null }`; `show` = url set AND the user has ≥1 `status = "completed"` order in the sources `/dashboard/my-orders` reads (implementer lists them in the report after checking that page; `combined_orders_view` by `shop_owner_id` is one) using `count: "exact", head: true`.
- [ ] **Step 1: Failing tests** for `validateReviewUrl` (accepts `https://g.page/r/abc/review`, `https://search.google.com/local/writereview?placeid=X`; rejects `http://g.page/x`, `https://evil.com/g.page`, `javascript:…`, 501 chars), `parseReviewUrl`, `shouldShowReviewCard` (29 vs 31 days, clicked, null state).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. Admin route mirrors `app/api/admin/settings/public-ussd-codes/route.ts` (verifyAdminAccess, GET 500 on read error, POST validate + upsert). Admin card includes the help text from spec D6 verbatim. Dashboard card: fetch once, read/write localStorage key `dg_review_card` in try/catch, buttons "Rate us on Google" (`target="_blank" rel="noopener noreferrer"`, sets clicked) and "Not now" (sets dismissedAt). No satisfaction question.
- [ ] **Step 4:** PASS + tsc baseline. **Step 5:** Commit `feat: Google review prompt for customers with a completed order`.

### Task 7: Sign-up attribution (auth + schema — fresh reviewer mandatory)

**Files:**
- Create: `migrations/0140_users_signup_source.sql`, `lib/signup-source.ts`, `lib/signup-source.test.ts`, `components/first-touch-capture.tsx` (client), `app/api/admin/signup-sources/route.ts`, `components/admin/signup-sources-card.tsx`
- Modify: `app/layout.tsx` (mount capture), `lib/auth.ts` (signUp metadata), `app/api/auth/signup/route.ts` (best-effort write), `app/auth/complete-profile/page.tsx` (OAuth path), `app/admin/settings/page.tsx`

**Interfaces:**
- Produces:
  - Migration: `alter table public.users add column if not exists signup_source jsonb;` (no backfill, no index). Applied to prod only via the prod change protocol with the owner's OK, **before** this task's code deploys.
  - `type SignupSource = { landing: string; ref: string | null; utm_source?: string; utm_medium?: string; utm_campaign?: string; at: string }`
  - `buildFirstTouch(url: URL, referrer: string, now: Date): SignupSource | null` — null for paths starting `/dashboard`, `/admin`, `/auth`; `landing` = pathname only (max 200); `ref` = referrer host only, null when same-site or empty; utm values `[A-Za-z0-9._-]` only, max 60 each.
  - `sanitizeSignupSource(v: unknown): SignupSource | null` — re-validates anything read back (localStorage or metadata); `at` must parse as a date.
  - `readFirstTouch(storage: Pick<Storage, "getItem">, now: Date): SignupSource | null` — honours the 30-day window; `recordFirstTouch(storage, source, now)` writes only when no valid entry exists. Key `dg_first_touch`.
  - `countByLanding(rows: Array<{ signup_source: unknown }>): Array<{ landing: string; count: number }>` — invalid/null → `"unknown"`, sorted desc.
- [ ] **Step 0:** `git fetch origin` and diff `origin/main` against the branch for `lib/auth.ts`, `lib/auth-complete.ts`, `app/auth/signup/page.tsx`, `app/auth/complete-profile/page.tsx`; rebase onto `origin/main` first if they changed.
- [ ] **Step 1: Failing tests** for every function above, incl. Review Focus 5 inputs (`<script>` in utm dropped, 10 kB referrer → host only, non-JSON storage → null, storage `getItem` throwing → null) and a route-level test for `/api/auth/signup` showing the profile upsert succeeds and the response is 200 when the follow-up `signup_source` update returns an error (Review Focus 1), using the fake-client pattern from `reference-testing`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. `FirstTouchCapture` runs in `useEffect`, only when `isMainSiteHost(window.location.host)`, all storage in try/catch. `lib/auth.ts` adds `signup_source: readFirstTouch(...)` to `options.data` (omitted when null). `/api/auth/signup`: after the existing upsert succeeds, read the verified user's `user_metadata.signup_source` (from the `getUser(token)` result it already has), sanitize, and if non-null `update({ signup_source })` where `id = userId` and `signup_source is null`; errors logged without PII and ignored. Complete-profile page: include sanitized `signup_source` in its existing `users` update only when the row's value is null. Admin route (verifyAdminAccess) selects `signup_source` from `users` where `created_at >= now-30d` (chunk/limit 5000) → `countByLanding`; admin card renders the table.
- [ ] **Step 4:** All tests PASS, tsc baseline, `next build` with placeholder env passes.
- [ ] **Step 5:** Commit `feat: record which page each sign-up first landed on`.

**Ruling recorded for reviewers:** the 0060 grant model lets authenticated users update their own `users` row, so a user could overwrite their own `signup_source`. Accepted: it is self-reported attribution only, never used for money or permissions, sanitized on read and rendered as escaped text.

---

## Ship order

Tasks 1–6 can merge and deploy without the migration. Task 7 needs migration 0140 applied first (owner OK, prod change protocol), then merge + push, watch deploy, live checks: `/mtn-data` shows a price table whose MTN 1GB price equals the dashboard's, `/cheapest-data-ghana` 200, `/guides/buy-data-with-momo` 200, `/guides/check-data-balance` 404, sitemap includes the new URLs, a test sign-up stores `signup_source`.
