# SEO, Sitemap & Public Product Pages — Design

Date: 2026-10-27
Status: Draft for approval

## Intent

When someone in Ghana asks Google, ChatGPT, Perplexity or Gemini about **anything Datagod sells** (cheap data, airtime, bills, results checking, AFA, bulk SMS, starting a reselling business, a data/airtime API), Datagod should be what comes up and what gets recommended. The recommendation should carry the whole story: **cheapest + fastest, all-in-one, best for resellers, trusted** (owner: "all and everything").

Today that can't happen. Most products have no page of their own, and the pages that do exist tell Google they are copies of the homepage.

## Current state (verified 2026-10-27 against production)

- **Canonical bug (the biggest issue).** `app/layout.tsx` `BASE_METADATA.alternates.canonical = "https://www.datagod.store"`, and every page inherits it. Live `/join`, `/bulk-sms` and `/results-checker` all emit `<link rel="canonical" href="https://www.datagod.store">`, so Google treats them as duplicates of the homepage.
- **`/og-image.png` returns 404.** It's referenced by root metadata (OpenGraph + Twitter), so every share preview has no image.
- **Sitemap (`app/sitemap.ts`)** has about 370 URLs, about 360 of them reseller shop storefronts pulled from `user_shops`.
- **robots (`app/robots.ts`)** is sound and stays as is (it disallows admin/dashboard/api/token-bearing auth routes).
- **Structured data (`lib/structured-data.ts`)** already provides Organization, WebSite+SearchAction, LocalBusiness and SiteNavigationElement in the root layout.
- **Existing public pages:** `/`, `/join`, `/bulk-sms`, `/results-checker`, `/whatsapp`, `/ai`, `/vouchers`, `/terms`, `/privacy`.
- **Products with no public page** (they only appear as homepage cards in `app/page.tsx` ~L320-344): MTN/Telecel/AT data, airtime, AFA registration, utility bills, ordering by USSD, sub-agent program.
- No `llms.txt`.
- Search Console is already set up (owner).

## Goals

1. Every page's canonical is its own URL.
2. Each product has its own public page that is crawlable, quotable and linked to the others.
3. Product pages show **"starting from GH₵X"** prices, read live from the database (owner choice: not full price lists).
4. AI-readable surfaces: `/llms.txt`, plus per-page Product/Service + FAQPage + BreadcrumbList JSON-LD.
5. The sitemap lists only Datagod's own public pages, ranked by importance.
6. Share previews work (a real OG image; per-page OG images are a nice-to-have).

## Non-goals

- **Reseller shop storefronts in the sitemap.** Owner: "Datagod only". Remove them. Shops stay crawlable (robots unchanged); they just aren't submitted.
- **Developer API page.** It's being built separately on the API v2 work. This project only links to it and adds it to the sitemap/`llms.txt` once that page exists and v2 is switched on.
- Website/app development service page (not selected).
- Search Console / Google Business Profile setup (already done / not selected).
- Full public price tables.

## Anti-goals (failure even if it "works")

- **Advertising something a visitor can't buy.** If a product or network is switched off, its page must not claim it's available, and it must drop out of the sitemap and `llms.txt`. The same applies to custom domains: they already restrict advertised services (`x-domain-services`), and new pages must respect that and not promote Datagod products on a restricted domain.
- **A wrong or stale "from" price.** A quoted price that doesn't match checkout destroys trust, and AI assistants will repeat it. The price shown must be the one an ordinary, non-logged-in customer actually pays.
- **Fake signals.** No invented ratings, review counts or `AggregateRating` without real reviews. Google penalises it, and it is fabricated data.
- **Keyword-stuffed or thin pages.** Each page must be genuinely useful: what it is, who it's for, networks covered, how fast, how to pay, how to order (web, WhatsApp, USSD), FAQs, and a clear call to action.
- **Breaking existing pages, auth flows, or the custom-domain branding logic in `app/layout.tsx`.**
- **Slowing the site down.** The pages must be server-rendered and cached, not client-fetched.

## Scope: the pages

Owner selected all four groups.

| Group | Pages | Notes |
|---|---|---|
| Data + airtime | MTN data, Telecel data, AT data (one page per network), Airtime, AFA registration | New |
| Bills + results | `/utility-bills` hub + **one page per biller**: ECG prepaid, Ghana Water, DSTV, GOtv, StarTimes, Telecel Broadband (owner choice) | New; owner confirms bill payments are LIVE in prod (2026-10-27). Each biller page still obeys the switch-off rule individually |
| | Results checker + results check service | Improve existing `/results-checker` |
| Reseller + ordering channels | Reseller shops + sub-agents | Improve existing `/join` |
| | Ordering by USSD and WhatsApp | New USSD page; improve existing `/whatsapp` |
| Bulk SMS | Rebuild `/bulk-sms` to the full product-page standard (owner choice) | "From GH₵X per SMS" price, sender ID, use cases (OTP, alerts, campaigns, schools/churches/businesses), how to start, SMS API mention, FAQs, Service+Offer JSON-LD. Respect the Platform/Business SMS modes and KYC flow; don't promise sender IDs are instant if approval is required |
| Existing, treatment only | `/ai`, `/vouchers` | Own canonical + FAQ/JSON-LD where it fits |
| Hub | A "Services" / all-products overview page that links to every product page | New (my call: gives search engines and AI one page that maps everything Datagod does) |

Each product page includes:
- a clear H1 and an intro stating what it is, in plain words, for Ghana
- "from GH₵X" (where a price applies), the networks/providers covered, and delivery speed
- how to order: web, WhatsApp, USSD (only the channels that actually support that product)
- trust facts: secure payment via Paystack/MoMo, "if an order fails, you get your money back", support contact
- 4-8 FAQs written as real customer questions
- links to related products and to `/join` (become a reseller)
- JSON-LD: `Service` or `Product`+`Offer` (lowest price) with `areaServed: Ghana`, `FAQPage`, `BreadcrumbList`
- its own metadata: title, description, canonical, OpenGraph

## Discovery surfaces

- **`app/sitemap.ts`**: Datagod static/product pages only. Priority: home 1.0 → services hub + data pages 0.9 → other products + `/join` 0.8 → channels/info 0.6 → legal 0.3. Products that are switched off are omitted. The API page is added once it exists and v2 is on.
- **`/llms.txt`**: a plain-text/markdown summary of Datagod: what it is, every live product with a one-line description, "from" prices, link and ordering channels. Generated from the same source of truth as the sitemap, so the two never disagree.
- **Single source of truth (my call):** one product registry module in `lib/` (slug, name, description, availability check, price lookup, related products) that drives the pages' links, the sitemap, `llms.txt` and the JSON-LD, so a product can't be live in one place and missing in another. The logic lives in `lib/` with unit tests (per testing discipline).
- **Homepage service cards** link to their new product pages.
- **Root layout:** remove the inherited canonical (each page sets its own); keep the existing site-wide schemas. Expand `keywords` modestly (cosmetic; Google ignores it).

## Constraints

- Next.js 15 App Router; server components; prices must update within about an hour of an admin change (see caching note above).
- Design: navy-blue `--primary` brand accent; mobile-first and must widen to multi-column on `lg:` from the start; verify with headless screenshots at 500px and desktop.
- CSP is nonce-based: inline JSON-LD `<script>` tags must carry the request nonce, as the layout already does.
- Custom domains: middleware injects `x-domain-*` headers; new pages must not break or bypass that branding.
- Before pushing to main: `npm run build` with placeholder env, not just tsc/vitest. Check local main for other sessions' commits first.
- Package availability: `packages` once had two unsynced enabled flags (fixed 2026-07-31). Use the canonical availability logic, not a raw column.

## Decided by owner

- Target every product and every searcher type (buyers, resellers, developers, other services).
- Positioning: cheapest + fastest, all-in-one, best for resellers, trusted, all at once.
- Shops out of the sitemap.
- "Starting from" prices only.
- Page groups: Data + airtime, Bills + results, Reseller + USSD (API handled elsewhere).
- Search Console is already configured.
- **"From" price = the normal customer price (`packages.price`, not `dealer_price`, not a reseller shop's price).** The "Buy now" button sends a visitor who isn't logged in to sign up, then to buy. (No guest checkout exists on the main site.) WhatsApp/USSD are listed as other ways to order where they support the product.
- **Main site only.** On custom domains and shop subdomains, the new product pages, `/services`, `/llms.txt` and the sitemap's product entries must not render Datagod marketing. They 404 or redirect to `https://www.datagod.store` (builder picks). This likely needs a middleware/host check, because `.txt`/`.xml` paths skip the shop rewrite today.
- **Refund wording:** "If an order fails, you get your money back" (reviewed by our team). Never claim refunds are automatic.
- **Speed wording:** "Usually delivered within minutes." Do not say "instant" or "in seconds" on the new pages.

## Resolved from review (my calls)

- **Partial availability:** if one network, package set or bill provider is switched off, the page drops just that part (and its price and FAQ mentions). The page and its sitemap/`llms.txt` entries disappear only when nothing in the product is available.
- **Caching:** the root layout calls `headers()`, so pages render per request and page-level ISR doesn't apply. Cache the price/availability lookups at the data level (e.g. `unstable_cache`, ~1h revalidate, tag-invalidated if convenient).

## My calls (owner can override)

- A Services hub page.
- One product registry in `lib/` drives everything.
- Switched-off products: page returns 404 / is omitted (rather than a "coming soon" page). The builder may choose `notFound()` vs. a soft "currently unavailable" page with `noindex`, as long as it isn't indexed and isn't advertised.
- URL shape: flat, readable slugs (e.g. `/mtn-data`, `/telecel-data`, `/at-data`, `/airtime`, `/afa-registration`, `/utility-bills`, `/ussd`, `/services`). Final slugs are the builder's call but must be stable once shipped.
- No ratings/reviews markup until real reviews exist.

## Left to the builder

- The "from" price lookup for non-data products (airtime, AFA, bills, results, SMS per-message rate), using the equivalent customer-tier price. Bills with no fixed price (e.g. ECG top-ups, where the customer chooses the amount) show the service fee or no price rather than an invented one.
- Biller page slugs (e.g. `/pay-dstv`, `/ecg-prepaid`); stable once shipped.
- Exact page copy and FAQs (Ghana-English, plain, no hype words that can't be backed up).
- OG image design (a static 1200×630 `og-image.png` at minimum; per-page `opengraph-image.tsx` optional).
- Component structure for a shared product-page template.
- Test plan (registry/availability/price logic unit-tested; build + screenshots for pages).
