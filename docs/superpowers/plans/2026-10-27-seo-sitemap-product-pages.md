# SEO, Sitemap & Public Product Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Datagod product discoverable and recommendable by search engines and AI assistants. Fix the canonical bug, add a public page per product with live "from" prices, and rebuild the sitemap, `llms.txt` and structured data from one product registry.

**Architecture:** A single product registry (`lib/seo/products.ts`, static content) plus a cached live-facts loader (`lib/seo/live-facts.ts`, availability + lowest customer price per product) feed everything: the product pages (one shared server-component template), JSON-LD, `/services`, `sitemap.ts` and `/llms.txt`. Pure builders are unit-tested; thin fetch layers are not. Marketing pages render only on the main host.

**Tech Stack:** Next.js 15 App Router (server components), Supabase (service-role reads), `unstable_cache`, Vitest, Tailwind (navy `--primary`).

**Spec:** `docs/superpowers/specs/2026-10-27-seo-sitemap-product-pages-design.md`

**Branch/worktree:** `feat/seo-product-pages` at `../Datagod2-seo`, based on `origin/main` @ `4cee4871` (already contains `/developers`, the API page built separately).

## Global Constraints

- Site URL: `https://www.datagod.store`. Root domain from `NEXT_PUBLIC_ROOT_DOMAIN` (default `datagod.store`).
- "From" price = **customer** price: `packages.price` (never `dealer_price`, never a shop price). Availability column is **`packages.is_available`** (not `active`).
- Refund copy, verbatim: **"If an order fails, you get your money back."** Never say refunds are automatic.
- Speed copy, verbatim: **"Usually delivered within minutes."** Never "instant" or "in seconds" on the new pages.
- No `AggregateRating` / review markup anywhere new (call `generateProductSchema` without `rating`/`reviewCount`, or don't use it).
- Buy CTA → `/auth/signup` (no guest checkout). Secondary link "Already have an account? Log in" → `/auth/login`.
- Marketing pages, `/services`, `/llms.txt` and sitemap product entries exist **only on the main host**. Custom domains (request header `x-domain-site-name` present) → `notFound()`. Shop subdomains are already rewritten to `/shop/<sub>/…` by middleware, except file-extension paths (`/llms.txt`, `/sitemap.xml`), which must self-check the host.
- Switched off → page `notFound()` and omitted from sitemap/`llms.txt`/`/services`. Partially off → drop only that part (network, biller, exam board).
- Live facts are cached with `unstable_cache`, `revalidate: 3600`, tag `seo-live-facts`. The root layout calls `headers()`, so pages are dynamic and page-level ISR doesn't apply.
- Inline JSON-LD `<script>` must carry the CSP nonce from `headers().get("x-nonce")`.
- Design: navy `--primary`; mobile-first plus `lg:` multi-column from the start; check screenshots at 500px and 1440px (headless Chrome).
- Code edits via Edit/Write tools only (no sed). TDD for everything in `lib/seo/`.
- Before any push to main: `npm run build` with placeholder env; check local main against origin for other sessions' commits.

## Review Focus

1. **A price lookup that finds zero rows or a null price** (a network with every package disabled, a missing AFA price row): expect that part to be hidden, never "from GH₵0" or "GH₵NaN". Tested in Task 3 (`buildLiveFacts` null/empty cases).
2. **A request to `/llms.txt` or `/sitemap.xml` on a custom domain or shop subdomain**: expect 404 / an empty sitemap, not Datagod marketing. Tested in Task 1 (`isMainSiteHost`) and Task 8 (route guards).
3. **The Supabase read failing (timeout/outage)**: expect pages to still render without prices (the product is treated as available, prices hidden) rather than a 500 or every product 404ing. Tested in Task 3 (`loadLiveFacts` catch → `FALLBACK_FACTS`).
4. **An admin entering a malformed USSD code** (`*920`, `920#`, script text): expect it to be rejected at save and never rendered. Tested in Task 2 (`parseUssdCodes`).
5. **An ECG/Water bill, which has no fixed price**: expect no "from" price and no `Offer` in JSON-LD (the service is described without a price). Tested in Task 3 and Task 4.

---

### Task 1: Host guard + canonical fix

**Files:**
- Create: `lib/seo/site.ts`, `lib/seo/site.test.ts`
- Modify: `app/layout.tsx` (delete `alternates` from `BASE_METADATA`, ~L81-83)
- Modify (add `alternates: { canonical: "<own url>" }` to existing `metadata`): `app/page.tsx` (home, `SITE_URL`), `app/join/page.tsx`, `app/bulk-sms/page.tsx`, `app/results-checker/page.tsx`, `app/whatsapp/page.tsx`, `app/ai/page.tsx`, `app/vouchers/layout.tsx`, `app/terms/page.tsx`, `app/privacy/page.tsx`, `app/developers/page.tsx`

**Interfaces — Produces:**
- `SITE_URL = "https://www.datagod.store"`
- `absoluteUrl(path: string): string`: `absoluteUrl("/mtn-data") === "https://www.datagod.store/mtn-data"`, `absoluteUrl("/") === SITE_URL`
- `isMainSiteHost(host: string | null, rootDomain?: string): boolean`
- `assertMainSite(): Promise<void>`: server-only; reads `headers()`, calls `notFound()` if `x-domain-site-name` is present.

- [ ] **Step 1: Write failing tests** in `lib/seo/site.test.ts`:
  - `isMainSiteHost` true for `www.datagod.store`, `datagod.store`, `WWW.DATAGOD.STORE:443`, `localhost:3000`, `127.0.0.1:3000`, `datagod-git-x.vercel.app`
  - false for `myshop.datagod.store`, `a.b.datagod.store`, `cheapdata.com`, `null`, `""`
  - `absoluteUrl` cases above, plus `absoluteUrl("mtn-data")` (no leading slash) gives the same result as with one
- [ ] **Step 2:** `npx vitest run lib/seo/site.test.ts`. Expect FAIL (module missing).
- [ ] **Step 3:** Implement `lib/seo/site.ts`. Strip the port, lowercase, then compare.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Remove `alternates` from root `BASE_METADATA`; add an own canonical to each listed page. Run `npx tsc --noEmit`. Expect no new errors.
- [ ] **Step 6: Commit** `fix(seo): give every public page its own canonical; add host guard helpers`

### Task 2: Admin-editable public USSD codes

**Files:**
- Create: `lib/seo/ussd-codes.ts`, `lib/seo/ussd-codes.test.ts`, `app/api/admin/settings/public-ussd-codes/route.ts`
- Modify: `app/admin/settings/page.tsx` (new card "Public USSD codes (shown on website)")

Storage: `app_settings` key `public_ussd_codes`, value = JSON string `{"main":"*xxx#","shop":"*xxx*SHOPCODE#"}`. Follow the GET/POST pattern of `app/api/admin/settings/balance-threshold/route.ts` (`verifyAdminAccess`, `supabaseAdmin`, upsert on `key`). No migration.

**Interfaces — Produces:**
- `type PublicUssdCodes = { main: string | null; shop: string | null }`
- `parseUssdCodes(raw: unknown): PublicUssdCodes`: tolerant reader (invalid → null per field)
- `validateUssdCodesInput(body: unknown): { ok: true; value: PublicUssdCodes } | { ok: false; error: string }`
- `USSD_CODE_RE = /^\*\d{2,4}(\*[0-9A-Za-z]{1,12})*#$/` (the `shop` code may contain the literal placeholder `SHOPCODE` in a segment)
- `getPublicUssdCodes(db: SupabaseClient): Promise<PublicUssdCodes>`

- [ ] **Step 1: Write failing tests**:
  - `*920#` and `*920*44#` valid
  - `*920*SHOPCODE#` valid for `shop`
  - `*920`, `920#`, `<script>`, `*920#;drop`, and a 40-char string all invalid
  - empty string clears the field (→ `null`)
  - `parseUssdCodes('{"main":"*920#","shop":"bad"}')` → `{ main: "*920#", shop: null }`
  - `parseUssdCodes(null)` → both null
- [ ] **Step 2:** Run. Expect FAIL.
- [ ] **Step 3:** Implement `lib/seo/ussd-codes.ts`.
- [ ] **Step 4:** Run. Expect PASS.
- [ ] **Step 5:** Route: GET returns `{ codes }`; POST validates via `validateUssdCodesInput` (400 on error), upserts, and calls `revalidateTag("seo-live-facts")`. Admin card: two inputs plus Save, with a help line: "Leave empty to hide. Use SHOPCODE where each shop's own code goes."
- [ ] **Step 6: Commit** `feat(seo): admin-editable public USSD codes`

### Task 3: Product registry + live facts

**Files:**
- Create: `lib/seo/products.ts`, `lib/seo/products.test.ts`, `lib/seo/live-facts.ts`, `lib/seo/live-facts.test.ts`

**Interfaces — Produces (`products.ts`, static, no I/O):**
```ts
export type ProductKey =
  | "mtn-data" | "telecel-data" | "at-data" | "airtime" | "afa-registration"
  | "utility-bills" | "ecg-prepaid" | "ghana-water" | "pay-dstv" | "pay-gotv" | "startimes" | "telecel-broadband"
  | "results-checker" | "bulk-sms" | "join" | "ussd" | "whatsapp" | "developers"
export type ProductGroup = "data" | "airtime" | "bills" | "education" | "business" | "channels"
export interface Faq { question: string; answer: string }
export interface ProductEntry {
  key: ProductKey; path: string; name: string; h1: string
  title: string;          // <= 60 chars, ends "| DATAGOD"
  description: string;    // 120-160 chars
  group: ProductGroup; summary: string; bullets: string[]
  channels: Array<"web" | "whatsapp" | "ussd">
  faqs: Faq[]             // 4-8
  related: ProductKey[]
  priority: number        // sitemap priority
  biller?: BillerKey      // bills pages only
  network?: "MTN" | "Telecel" | "AT"
  hasOwnPage: boolean     // false for existing hand-built pages (join, results-checker, bulk-sms, whatsapp, developers)
}
export const PRODUCTS: readonly ProductEntry[]
export function getProduct(key: ProductKey): ProductEntry
```
Paths: `/mtn-data`, `/telecel-data`, `/at-data`, `/airtime`, `/afa-registration`, `/utility-bills`, `/ecg-prepaid`, `/ghana-water`, `/pay-dstv`, `/pay-gotv`, `/startimes`, `/telecel-broadband`, `/results-checker`, `/bulk-sms`, `/join`, `/ussd`, `/whatsapp`, `/developers`. Priorities: data 0.9; airtime/afa/bills hub/results/bulk-sms/join 0.8; individual billers 0.7; ussd/whatsapp/developers 0.6. Copy rules: plain Ghana English; every FAQ set includes one refund FAQ and one speed FAQ that use the verbatim Global Constraints wording; mention MoMo/Paystack payment.

**Interfaces — Produces (`live-facts.ts`):**
```ts
export interface ProductFacts { available: boolean; fromPrice: number | null; parts: string[] } // parts = live networks / billers / exam boards
export type LiveFacts = { products: Record<ProductKey, ProductFacts>; ussd: PublicUssdCodes }
export interface RawFacts {
  packages: Array<{ network: string; price: number | string | null; is_available: boolean | null }>
  airtimeEnabled: Record<"MTN" | "Telecel" | "AT", boolean>; airtimeMin: number
  afaPrice: number | null
  bills: BillsConfig | null
  results: Array<{ board: "WASSCE" | "BECE" | "NOVDEC"; enabled: boolean; price: number | null }>
  smsPricePerCredit: number | null
  apiV2Enabled: boolean
  ussd: PublicUssdCodes
}
export function buildLiveFacts(raw: RawFacts): LiveFacts      // pure
export const FALLBACK_FACTS: LiveFacts                      // all available except ussd, all prices null
export const getLiveFacts: () => Promise<LiveFacts>         // unstable_cache(loadLiveFacts, ["seo-live-facts"], { revalidate: 3600, tags: ["seo-live-facts"] })
```
Sources for `loadLiveFacts` (service-role `supabaseAdmin`; on any throw → `FALLBACK_FACTS`, logged without PII):
- `packages` (`network, price, is_available`); match the network by case-insensitive prefix: `mtn`, `telecel`, `at`/`airteltigo`/`ishare`
- `isAirtimeEnabled(net)` / `getAirtimeLimits().min` (`lib/airtime-pricing.ts`)
- `afa_registration_prices` where `is_active = true`, `.maybeSingle()`
- `getBillsConfig` (`lib/bills/config.ts`)
- `admin_settings` `results_checker_enabled_{wassce|bece|novdec}` (`.enabled !== false`) and `results_checker_price_{board}` (`.price`)
- `admin_settings` `sms_price_per_credit` (`.amount`)
- `getConfig` (`lib/api-v2/store.ts`) `.enabled`
- `getPublicUssdCodes` (Task 2)

Rules in `buildLiveFacts`:
- data per network: available if ≥1 package has `is_available === true` and a finite positive price; `fromPrice` = min such price
- airtime: available if any network enabled, `parts` = enabled networks, `fromPrice` = `airtimeMin`
- afa: available if `afaPrice > 0`
- bills hub: available if `bills.enabled` and ≥1 biller enabled; each biller page follows its own flag; `fromPrice` is always `null` (customer chooses the amount)
- results: available if any board is enabled with a price; `fromPrice` = min
- bulk-sms: always available; `fromPrice` = `smsPricePerCredit`
- developers: `apiV2Enabled`
- join / whatsapp: always available
- ussd: available only if `ussd.main` is non-null

- [ ] **Step 1: Write failing tests** (`products.test.ts`):
  - keys and paths are unique
  - every `related` key exists
  - every `BillerKey` from `lib/bills/billers.ts` has exactly one entry with that `biller`
  - every title ≤ 60 chars; every description is 120-160 chars
  - FAQ count is 4-8
  - no entry's text matches `/instant|in seconds|automatic(ally)? refund/i`
- [ ] **Step 2: Write failing tests** (`live-facts.test.ts`):
  - MTN rows `[{price: 5, avail}, {price: 3.5, avail}, {price: 2, is_available: false}]` → `mtn-data` `{ available: true, fromPrice: 3.5 }`
  - Telecel rows all unavailable → `telecel-data.available === false`
  - a `price: null` / `"abc"` row is ignored (no `NaN`, no `0`)
  - `afaPrice: null` → afa unavailable
  - bills `enabled: false` → hub and every biller unavailable
  - bills on with only DSTV → `pay-dstv` available, `ecg-prepaid` not, hub `parts === ["DSTV"]`
  - results: BECE disabled → `parts` excludes BECE and `fromPrice` = min of the remaining boards
  - `ussd.main: null` → ussd unavailable
  - `apiV2Enabled: false` → developers unavailable
  - `FALLBACK_FACTS`: everything available except `ussd` (no code known), all `fromPrice` null, `ussd` codes both null
- [ ] **Step 3:** `npx vitest run lib/seo`. Expect FAIL.
- [ ] **Step 4:** Implement both modules (registry copy included).
- [ ] **Step 5:** `npx vitest run lib/seo`. Expect PASS.
- [ ] **Step 6: Commit** `feat(seo): product registry and cached live facts`

### Task 4: JSON-LD builders + shared product page template

**Files:**
- Create: `lib/seo/json-ld.ts`, `lib/seo/json-ld.test.ts`, `components/seo/json-ld-script.tsx`, `components/seo/product-page.tsx`, `components/seo/faq-section.tsx`, `components/seo/related-products.tsx`
- Create: `lib/seo/page-meta.ts` (with tests in `json-ld.test.ts`)

**Interfaces — Produces:**
- `buildProductJsonLd(p: ProductEntry, f: ProductFacts): object[]`: returns `[Service (+ offers: Offer{price: fromPrice.toFixed(2), priceCurrency: "GHS", availability: InStock} only when fromPrice != null; provider: Organization DATAGOD; areaServed: Country Ghana), FAQPage, BreadcrumbList(Home → [Services →] name)]`
- `buildProductMetadata(p: ProductEntry): Metadata`: title, description, `alternates.canonical = absoluteUrl(p.path)`, openGraph `url`/`title`/`description`/`images: ["/og-image.png"]`
- `<JsonLd data={object | object[]} />`: async server component; reads the nonce
- `renderProductPage(key: ProductKey): Promise<JSX.Element>`: `await assertMainSite()`; `getLiveFacts()`; `notFound()` if unavailable; renders hero (h1, summary, "From GH₵X" when known, the speed line, CTA → `/auth/signup` + login link), live `parts` chips, bullets, "How to order" (only `p.channels`; USSD shows `ussd.main` when set), trust strip (refund line, MoMo/Paystack, support), FAQ section, related products (only available ones), `<JsonLd>`
- `productPageMetadata(key: ProductKey): Promise<Metadata>`: same as `buildProductMetadata`, but returns `{ robots: { index: false } }` on a custom domain

- [ ] **Step 1: Write failing tests**:
  - with `fromPrice: 3.5` → the Service has `offers.price === "3.50"` and `priceCurrency === "GHS"`
  - with `fromPrice: null` → no `offers` key
  - the serialized output never contains `"AggregateRating"` or `"review"`
  - the FAQPage has `mainEntity.length === p.faqs.length`
  - breadcrumb item URLs are absolute
  - `buildProductMetadata(getProduct("mtn-data")).alternates.canonical === "https://www.datagod.store/mtn-data"`
- [ ] **Step 2:** Run. Expect FAIL. **Step 3:** Implement. **Step 4:** Run. Expect PASS.
- [ ] **Step 5:** Build the components (navy `--primary`; hero stacks on mobile; `lg:grid-cols-2` hero, `lg:grid-cols-3` bullets/related).
- [ ] **Step 6: Commit** `feat(seo): JSON-LD builders and shared product page template`

### Task 5: New product pages

**Files (each is a two-export wrapper: `export const generateMetadata = () => productPageMetadata("<key>")` and `export default () => renderProductPage("<key>")`):**
- Create: `app/mtn-data/page.tsx`, `app/telecel-data/page.tsx`, `app/at-data/page.tsx`, `app/airtime/page.tsx`, `app/afa-registration/page.tsx`, `app/utility-bills/page.tsx`, `app/ecg-prepaid/page.tsx`, `app/ghana-water/page.tsx`, `app/pay-dstv/page.tsx`, `app/pay-gotv/page.tsx`, `app/startimes/page.tsx`, `app/telecel-broadband/page.tsx`, `app/ussd/page.tsx`

`/utility-bills` additionally lists each live biller as a card linking to its page (pass via the `parts`-driven related section, or a `childKeys` render in the template when `p.key === "utility-bills"`). `/ussd` shows `ussd.main` prominently and explains the shop code format from `ussd.shop` when set.

- [ ] **Step 1:** Confirm none of these paths already exist in `app/` and none collide with a middleware rewrite or a `RESERVED_SUBDOMAINS` path. Expect no collisions.
- [ ] **Step 2:** Create the files.
- [ ] **Step 3:** `npm run dev`. Request each path and expect 200 with a canonical equal to its own URL. Request one with header `x-domain-site-name: Test`; expect 404.
- [ ] **Step 4:** Screenshots of `/mtn-data`, `/utility-bills`, `/pay-dstv` and `/ussd` at 500px and 1440px. Check the navy accent, no horizontal scroll, and multi-column on desktop.
- [ ] **Step 5: Commit** `feat(seo): public product pages for data, airtime, AFA, bills and USSD`

### Task 6: Upgrade existing pages + homepage links

**Files:**
- Modify: `app/bulk-sms/page.tsx`: rebuild to the product standard. Keep its existing sections that are still accurate. Add a "From GH₵X per SMS" hero (`facts["bulk-sms"].fromPrice`, 3 decimals), sender ID (approval required; don't promise instant), use cases (OTP, alerts, campaigns, schools/churches/businesses), the SMS API mention linking `/developers` only when it's available, registry FAQs, and `<JsonLd data={buildProductJsonLd(...)}>`.
- Modify: `app/join/page.tsx`, `app/results-checker/page.tsx`, `app/whatsapp/page.tsx`: add `<FaqSection faqs={getProduct(key).faqs} />`, `<RelatedProducts …/>` and `<JsonLd>`. Results checker shows "From GH₵X" and only live boards. Don't restructure the rest.
- Modify: `app/page.tsx` service cards (~L320-344): wrap each card in a `Link` to its registry path (Data Bundles → `/services#data`, Airtime → `/airtime`, AFA → `/afa-registration`, Utility Bills → `/utility-bills`, Results Checker/Check Service → `/results-checker`, Bulk SMS → `/bulk-sms`, Reseller Shops/Sub-Agent → `/join`, Developer API → `/developers`, Order From Anywhere → `/ussd`). Add a "See all services" link → `/services`.
- Modify: `app/layout.tsx` `keywords`: add "AFA registration Ghana", "pay DSTV online Ghana", "ECG prepaid online", "WASSCE results checker", "bulk SMS Ghana", "data reseller Ghana", "data bundle API Ghana".

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** `npx tsc --noEmit` and `npx vitest run`. Expect no new failures (9 known order-health failures excepted).
- [ ] **Step 3:** Screenshots of `/bulk-sms` and `/` at 500px and 1440px.
- [ ] **Step 4: Commit** `feat(seo): upgrade bulk SMS, join, results and WhatsApp pages; link homepage cards`

### Task 7: Services hub

**Files:**
- Create: `app/services/page.tsx`, `lib/seo/services-hub.ts` (+ test in `products.test.ts`)

**Interfaces — Produces:** `groupAvailableProducts(facts: LiveFacts): Array<{ group: ProductGroup; label: string; anchor: string; items: ProductEntry[] }>`. Excludes unavailable products; group order data, airtime, bills, education, business, channels; anchors `data`, `airtime`, `bills`, `education`, `business`, `channels`.

- [ ] **Step 1: Failing test:** with bills off, there's no `bills` group; with everything on, there are 6 groups in order and the `data` group has 3 items.
- [ ] **Step 2:** Run. FAIL. **Step 3:** Implement. **Step 4:** Run. PASS.
- [ ] **Step 5:** The page has metadata (title "All DATAGOD Services: Data, Airtime, Bills & More | DATAGOD", canonical `/services`), `assertMainSite()`, a grouped card grid with "From GH₵X" per item, an ItemList + BreadcrumbList via `<JsonLd>`, and a CTA to `/auth/signup`.
- [ ] **Step 6: Commit** `feat(seo): services hub page`

### Task 8: Sitemap, llms.txt, OG image

**Files:**
- Create: `lib/seo/discovery.ts`, `lib/seo/discovery.test.ts`, `app/llms.txt/route.ts`, `public/og-image.png`
- Modify: `app/sitemap.ts` (replace the body)

**Interfaces — Produces:**
- `buildSitemapEntries(facts: LiveFacts, now: Date): MetadataRoute.Sitemap`: home (1.0, daily), `/services` (0.9, weekly), every available registry entry (its priority, weekly), `/vouchers` 0.5, `/ai` 0.6, `/terms` and `/privacy` 0.3 yearly. **No shop URLs. No `user_shops` query.**
- `buildLlmsTxt(facts: LiveFacts): string`: markdown in the llmstxt.org shape: `# DATAGOD`, a `> ` one-line summary (Ghana's all-in-one platform for data bundles, airtime, bill payments, results checkers, bulk SMS and reselling), then `## Products` (one line per available product: `- [Name](absolute url): summary. From GH₵X.` when priced), `## Ways to order` (web; WhatsApp; USSD with `ussd.main` only when set), `## For resellers`, `## For developers` (only when developers is available), `## Trust` (the verbatim refund and speed lines, plus Paystack/MoMo).

Route guards: `app/llms.txt/route.ts` GET → if `!isMainSiteHost(headers().get("host"))` return 404, else `text/plain; charset=utf-8` with `Cache-Control: public, max-age=3600`. `sitemap.ts` → `isMainSiteHost` false ⇒ `return []`.

- [ ] **Step 1: Failing tests:**
  - the sitemap has no `/shop/` and no non-`www.datagod.store` host
  - bills off → no `/utility-bills` or biller URLs
  - URLs are unique
  - `/services` is present
  - `llms.txt` contains `# DATAGOD`, the verbatim refund and speed lines, and `From GH₵3.50` for MTN at 3.5
  - USSD is absent when `ussd.main` is null
  - developers is absent when unavailable
  - the output has no `instant`
- [ ] **Step 2:** Run. FAIL. **Step 3:** Implement. **Step 4:** Run. PASS.
- [ ] **Step 5:** OG image: render a 1200×630 HTML card (navy background, DATAGOD wordmark, "Data · Airtime · Bills · Results · SMS · Reseller shops", `www.datagod.store`) with headless Chrome to `public/og-image.png`. Check that the file is 1200×630 and under 300 KB.
- [ ] **Step 6:** Dev check: `/sitemap.xml` has about 30 URLs and no shops; `/llms.txt` returns 200 text; `curl -H "Host: myshop.localhost:3000"` isn't representative, so rely on the unit test for the host guard.
- [ ] **Step 7: Commit** `feat(seo): registry-driven sitemap, llms.txt and share image`

### Task 9: Verify, review, ship

- [ ] **Step 1:** `npx vitest run` and `npx tsc --noEmit`. Expect only the 9 known order-health failures.
- [ ] **Step 2:** `npm run build` with placeholder env. Expect success (catches route-export violations).
- [ ] **Step 3:** Fresh reviewer (`ecc:seo-specialist` + `ecc:code-reviewer`) on the whole branch. Verify and re-grade findings; fix them with failing tests first.
- [ ] **Step 4:** Ask the user for OK to merge. Then check local main vs `origin/main` for other sessions' commits, merge, push, and watch the Vercel deploy.
- [ ] **Step 5: Live checks:**
  - each new URL returns 200 with its own canonical
  - `/og-image.png` returns 200
  - `/sitemap.xml` has no shop URLs
  - `/llms.txt` returns 200
  - Google Rich Results Test passes on `/mtn-data` and `/bulk-sms`
- [ ] **Step 6:** Ask the user to set both USSD codes in `/admin/settings` and to resubmit the sitemap in Search Console. Update the memory files (spec/plan pointers; bills are LIVE per the owner, 2026-10-27).
