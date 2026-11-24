# AI assistants: knowledge of the whole site (design)

Date: 2026-11-24. Owner request: "the ai seems to not have knowledge about everything on the site (all of the ai surfaces)" → "fix all".

## Findings (prod, read-only, 2026-11-24)
- `ai_knowledge`: 23 active rows, ~5,600 chars, tagged dashboard/admin/storefront only. Whole services have no entry (shops and sub-agents, text-to-buy, bills, airtime, SMS platform, developer API, withdrawals, WhatsApp bots, custom roles, special bundles, subscriptions).
- Home chat gets storefront-tagged rows (label mapping); WhatsApp main bot gets knowledge only via `get_knowledge_base`; the WhatsApp shop bot and text-to-buy reader get none.
- `get_knowledge_base` matches the whole query as one ILIKE substring, so natural questions ("how do I withdraw my money") return nothing.
- Customer/dealer surfaces have no page guide (admin has `lib/ai-admin-catalog/pages.ts`).
- Injection is whole-section, all-or-nothing within 12,000 chars (Phase 3).

## Goals
- Every assistant (home, storefront, dashboard incl. dealers and shop owners, admin, WhatsApp main bot, WhatsApp shop bot) knows what exists on the site for its audience, where it lives, and how to do it.
- Natural-language questions find the right article.
- Knowledge stays current: new pages cannot ship without a guide entry (test).

## Non-goals
- Live prices, balances, stock: still from the existing tools, never written into articles.
- Changing what any assistant may DO (tools, cards, permissions).
- Text-to-buy reader (it parses SMS orders; it does not converse).

## Anti-goals
- Invented facts: every article states only what the code does; prices, fees, limits and timings that are configurable are described as "shown at checkout/on the page", never as numbers, unless they are fixed constants in code.
- Revealing fraud checks, abuse thresholds, internal limits, provider names customers don't see, secrets or admin-only workings to non-admin audiences.
- Breaking frozen prompts: `lib/ai-prompts/golden.test.ts` and `strict.test.ts` stay untouched and green.

## Design (approach: code-owned site guide + code-owned articles + keyword search; DB knowledge stays as the admin-editable layer)
1. `lib/ai-site-guide/` (code):
   - `types.ts`: `Audience = "public" | "customer" | "dealer" | "shop_owner" | "admin"`; `SiteArticle { id, title, audiences: Audience[], keywords: string[], summary (≤ 200 chars), body (≤ 2,500 chars) }`; `SitePage { path, title, audiences, purpose (≤ 160), tasks (1-5) }`.
   - `pages.ts`: every customer-facing page (`app/**/page.tsx` outside `app/admin` and `app/api`) with audiences. Coverage test: every such page has exactly one entry (dynamic segments `:x`), or is listed in `excluded-pages.ts` with a reason (e.g. auth callbacks).
   - `articles/*.ts`: one file per area, articles written by reading the code.
   - `audience.ts`: chat context + verified role → audiences (home/storefront → public; dashboard customer → public+customer; dealer → +dealer; shop owner → +shop_owner; admin → all).
   - `guide.ts`: `renderSiteGuide(audiences)` → a compact section: page list (title, path, one line) + article index (title + summary). Hard cap 7,000 chars per audience set (test).
   - `search.ts`: `searchSite(query, audiences, limit=5)` keyword search (lowercase tokens, stopwords removed, light stemming of plural/-ing/-ed, scores title > keywords > summary > body), returns whole articles.
2. Injection: the chat route's knowledge section = site guide (always, within its own cap) + DB knowledge (all-or-nothing within the remaining budget, as today). Same `appendKnowledge` slot, so golden prompt tests (which run without knowledge) are unchanged. WhatsApp main bot and WhatsApp shop bot prompts gain the same site-guide section for their audience (shop bot: public audience scoped to that shop's services).
3. `get_knowledge_base`: searches site articles first (keyword search, audience-filtered), then DB rows with token-based matching (each token ILIKE, escaped), merged and deduplicated, ≤ 5 results. Label mapping unchanged for DB rows; home/whatsapp map as today.
4. DB rows stay admin-editable and still override: the rule line tells the model that DB knowledge entries are the owner's latest word when they conflict with the site guide.

## Constraints
- Same review gates as before: fresh reviewer per task, opus final review. Content tasks are reviewed for accuracy against the code (sampled) and for the anti-goals.
- No prod writes; no migration. Push needs the owner's yes.
