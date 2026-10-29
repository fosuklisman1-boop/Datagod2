# Cheap-data search pages + Google review prompt — design

Date: 2026-10-28. Owner: Datagod. Builds on the SEO system shipped 2026-10-27
(`docs/superpowers/specs/2026-10-27-seo-sitemap-product-pages-design.md`):
registry `lib/seo/products.ts`, live facts `lib/seo/live-facts.ts`
(`getLiveFacts()`, `unstable_cache` 1h, tag `seo-live-facts`), product pages via
`components/seo/product-page.tsx`, sitemap `app/sitemap.ts`, `/llms.txt`.

## Why

The owner wants DATAGOD to show up when Ghanaians search. Of all searcher
groups, **cheap data buyers** matter most this month ("cheap MTN data Ghana",
"MTN 1GB price", "buy data with MoMo", "Telecel data bundle prices"). Those
searchers want a **price list**; today our pages show only a "from" price.

New customers arrive via resellers, Google and social media, but nobody knows
the mix. So every new page should be measurable: we record where each sign-up
first landed.

Trust signals (Google reviews) help both Google ranking and AI recommendations.
A Google Business Profile already exists; it needs more reviews.

## Goals

1. Win "cheap data" and "data price" searches for MTN, Telecel and AT.
2. Show the **full live customer price list** publicly (owner decision 2026-10-28,
   superseding "starting-from only" for the three data pages).
3. Know which landing page each new sign-up came from.
4. Collect more Google reviews from real customers, fairly.

## Non-goals

- Pages for resellers, bills, results checker, bulk SMS, API (later rounds).
- Dealer / shop / sub-agent prices — never shown publicly.
- Competitor prices or "cheaper than X" claims about named competitors.
- Outreach, press, social posting (owner does these).
- Any change to checkout, order or payment logic.

## Anti-goals (failure even if it "works")

- A public price that differs from what a logged-in customer sees on
  `/dashboard/data-packages`.
- Two of our own pages competing for the same search (cannibalization).
- Review gating: asking "were you happy?" first and only sending happy
  customers to Google (against Google policy).
- A review prompt that nags (shows every visit) or appears before the customer
  has ever received an order.
- Breaking the 2026-10-27 copy rules: no "instant"; speed line "Usually
  delivered within minutes."; refund line "If an order fails, you get your
  money back."; marketing pages on the main site only.

## Decisions

### D1. The customer price (fixes a shipped bug too)

Customer-facing data prices are `packages.price` **adjusted by the per-network
percentage** in the singleton `app_settings` row (`key IS NULL`):
`price_adjustment_mtn`, `price_adjustment_telecel`, `price_adjustment_at_ishare`,
`price_adjustment_at_bigtime` — exactly as `lib/price-adjustment-service.ts`
(`getAdjustmentForNetwork`, `applyPriceAdjustment`) does for
`/dashboard/data-packages`. The shipped "from" prices use raw `packages.price`;
they must switch to the adjusted price as part of this work. The live-facts
loader reads the four adjustment columns as its own failable source (a failed
read = data pages stay on **without prices**, same fail-closed policy as a failed
packages read). Reuse the pure helpers; do not use `getPriceAdjustments()`
itself (it swallows errors into 0%, which would publish wrong prices and cache
them).

### D2. Full price list on the existing network pages (no new duplicate pages)

`/mtn-data`, `/telecel-data`, `/at-data` gain a **price table**: one row per
available package (`is_available = true`, positive adjusted price), sorted by
data size: columns *Bundle* (size as stored, e.g. "1GB"), *Price* (GH₵, 2 dp)
and *Price per GB*. Under the table: "Prices updated <date>" (the time the
facts were loaded, Africa/Accra, e.g. "28 Oct 2026") and a **Buy** button to
`/auth/signup` (unchanged CTA).

Titles/descriptions shift toward price searches, e.g. MTN:
"MTN Data Bundle Prices Today - Cheap MTN Data in Ghana | DATAGOD"
(builder writes the three within the existing 120–160 char description test).

JSON-LD: the page's Service offer becomes an `AggregateOffer`
(`lowPrice`, `highPrice`, `offerCount`, `priceCurrency: "GHS"`).

AT: packages.network has several AT values ("AT-iShare", "AT-BigTime", …).
Show one table per distinct stored network value that has available rows,
headed with that value's display name; never claim an AT product that has no
available rows (existing test bans unconditional iShare/BigTime claims).

Size → GB for *price per GB*: parse "1GB", "1.5GB", "500MB", "1000MB"
(1000 MB = 1 GB, the platform convention). Unparseable size → row shown,
per-GB cell "—", excluded from per-GB comparisons.

### D3. New comparison page `/cheapest-data-ghana`

H1 "Cheapest data bundles in Ghana today". Built only from our live prices:
- per network, the cheapest price per GB and the bundle that achieves it;
- a side-by-side table for common sizes (1GB, 2GB, 5GB, 10GB) where at least
  one network has that exact size available; empty cell "—";
- short neutral copy, FAQ (3–4 Qs incl. speed + refund lines), RelatedProducts,
  JSON-LD (FAQPage + BreadcrumbList), sitemap + `/llms.txt` entry, main site only.
Hidden (404 metadata-stage, like other dark pages) if no network has prices.
New registry entry, so it follows every existing registry rule/test.

### D4. Guides

`/guides` hub + two guides at launch:
- `/guides/buy-data-with-momo` — how to buy on DATAGOD: sign up, fund wallet
  with MoMo or card, pick bundle, pay from wallet; WhatsApp and USSD
  alternatives shown only when those channels are live (reuse facts). Links to
  the three price pages.
- `/guides/check-data-balance` — balance-check codes per network. **The codes
  must be confirmed by the owner before this guide is published**; until then
  it ships hidden (not in sitemap, 404). Codes live in the guide content, not
  guessed by the builder.

Guides are static content in a small typed registry (title, description,
sections, FAQs, related product keys), rendered with the same layout pieces
(JsonLd with `Article` + `BreadcrumbList`, FAQ, RelatedProducts). In sitemap
and `/llms.txt` when published.

### D5. Sign-up attribution (first touch)

On any main-site page, the first visit stores
`{ landing: pathname, ref: referrer host or null, utm_source, utm_medium,
utm_campaign, at: ISO time }` in `localStorage` (key `dg_first_touch`), kept
30 days, never overwritten while valid. Sign-up passes it as
`signup_source` in the existing `authService.signUp(..., metadata)` call
(auth user metadata). Values are length-capped and stripped of query strings
other than the three utm keys (no PII, no tokens). Missing/blocked storage =
no attribution, sign-up unaffected.

Admin view: a card on `/admin/settings` (or the admin home, builder's call)
"Sign-ups by landing page, last 30 days": counts per `landing`, plus
"unknown". Reading mechanism is the builder's call with this constraint:
admin-only server route (`verifyAdminAccess`), no new public read path,
prefer no schema change; if one is needed, it goes through the normal
migration + review gate.

### D6. Google review card

- Admin setting: `/admin/settings` card "Google review link", stored in
  `app_settings` key `google_review_url` (same key-value pattern as
  `public_ussd_codes`). Accepted: `https://` URLs on `g.page`,
  `search.google.com`, `www.google.com`, `maps.app.goo.gl` or `g.co`;
  anything else rejected. Empty = feature off (ships off).
- Dashboard card for **every signed-in user** (customers, dealers, resellers)
  who has **at least one completed order**: "Enjoying DATAGOD? Leave us a
  Google review" + button opening the link in a new tab
  (`rel="noopener noreferrer"`).
- Frequency: dismiss ("Not now") hides it 30 days; clicking the button hides
  it for good. Stored per user (builder's call: localStorage is acceptable).
- No satisfaction pre-question, no filtering by order outcome beyond "has a
  completed order" (anti review gating).
- Admin card includes help text for finding the link: *On Google, search your
  business name while signed in to the Google account that manages the
  profile → in the Business Profile panel choose "Ask for reviews" (or "Get
  more reviews") → copy the review link → paste here.*

## Constraints

- Next.js 15 App Router, existing SEO modules; TDD with Vitest; logic in `lib/`.
- Edit/Write tools only for code (no sed).
- Every public page: own canonical, own twitter metadata, main-site-only
  (`assertMainSite`), noindex/404 when dark.
- Prices never cached from a partial read (existing `PartialFactsError` rule).
- `next build` with placeholder env before pushing main.

## Settled after the builder check (designer's calls unless marked owner)

1. **Customer price = the non-dealer price** (owner: "customer price").
   `/dashboard/data-packages` selects `packages` with only `is_available = true`
   and swaps in `dealer_price` for dealers; the public price is what a plain
   user sees: `packages.price` adjusted by `getAdjustmentForNetwork` +
   `applyPriceAdjustment`, **reused verbatim, quirks included** (same mapping
   as the dashboard is the requirement). The loader's packages select adds
   `size`. No other visibility filters exist.
2. **Freshness:** admin edits must refresh public prices: every admin route
   that writes `packages.price` / `is_available` (single + bulk) and the
   settings PUT when any `price_adjustment_*` field changes call
   `revalidateTag("seo-live-facts")`. Changes made outside the admin UI may
   lag up to 1 hour (accepted).
3. **Attribution storage:** a migration adds nullable `users.signup_source
   jsonb`. Captured client-side as D5 describes and written onto the user's
   own profile row server-side by the existing profile-finalising path(s),
   covering **every sign-up path** (email sign-up and the Google/OAuth
   complete-profile path). The admin card reads `users.signup_source` through
   an admin-only route. This touches auth code and the schema → fresh
   reviewer mandatory (review gates). Under the existing grant model (0060)
   a user can update their own `users` row, so they could overwrite their own
   `signup_source`; accepted, because it is self-reported attribution only,
   never used for money or permissions, sanitized on read and rendered as
   escaped text. Server writes are write-once (only when the column is null).
4. **First-touch capture** runs on main-site pages except `/dashboard/*`,
   `/admin/*` and `/auth/*` (a landing on those records nothing).
5. **"Completed order"** = the signed-in user has at least one row with status
   `completed` in the order tables their own dashboard order history reads
   (builder lists them in the plan). Rows later flipped to failed/reversed no
   longer count. Checked by a new authenticated server route
   (`GET /api/review-prompt` → `{ show: boolean, url: string | null }`),
   which is also how the link reaches the client; no public read path.
6. **Review card** is one shared component mounted once in each dashboard
   layout (customer, dealer, reseller) that exists; localStorage for
   dismiss/clicked is accepted (per device).
7. **Dark rules:** a network page stays as today (dark when that network has
   no available priced package; on a failed packages/adjustment read, on
   without prices). `/cheapest-data-ghana` is dark only when **no** network
   has prices. AT shows one sub-table (H3) per stored AT network value that
   has available rows.
8. **Buy button:** signed-in visitors go to `/dashboard/data-packages`,
   others to `/auth/signup`.

## Left to the builder

- Exact copy within the rules above; table styling (match product pages,
  navy primary, mobile-first, `lg:` multi-column).
- Where the attribution admin card lives; how it reads metadata.
- Guide registry shape.

## Open (owner)

- Balance-check codes per network for `/guides/check-data-balance` (D4).
- Paste the Google review link in `/admin/settings` after launch (D6).
