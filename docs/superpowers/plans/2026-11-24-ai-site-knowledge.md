# AI Site Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Datagod AI assistant knows what the site offers its audience, where it lives and how to use it, and can find full how-to articles from natural questions.

**Architecture:** A code-owned site guide (`lib/ai-site-guide/`: page list + articles + audiences + keyword search) is injected as a compact section into every assistant's knowledge slot and searched by `get_knowledge_base` together with the admin-editable `ai_knowledge` rows.

**Tech Stack:** TypeScript, Next.js 15 route handlers, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-ai-site-knowledge-design.md`

## Global Constraints

- Articles state only what the code does. Configurable prices, fees, limits and timings are described as "shown at checkout / on the page", never as numbers, unless they are fixed constants in code.
- Never describe fraud checks, abuse thresholds, internal limits, supplier/provider names customers don't see, secrets, or admin-only workings in any non-admin article.
- `lib/ai-prompts/golden.test.ts` and `lib/ai-prompts/strict.test.ts` are never edited and stay green.
- Site guide section ≤ 7,000 chars for any audience set; article `summary` ≤ 200 chars, `body` ≤ 2,500 chars; page `purpose` ≤ 160 chars, 1-5 `tasks`.
- No prod writes, no migration. Edit/Write only (no sed/scripts editing files). Logs carry no PII.

## Review Focus

1. A guest on the home chat asks about a dealer-only feature → the guide and search return nothing dealer-only. Test in Task 1 (`searchSite` audience filter) and Task 2 (home prompt has no dealer article titles).
2. Query with punctuation, Twi/pidgin filler, typos ("how i go withdraw my money??") → still finds the withdrawals article. Test in Task 1.
3. DB knowledge too big for the remaining budget → site guide still injected, DB section omitted whole. Test in Task 2.
4. A query containing `%`, `_`, `,` or `)` → no PostgREST filter injection in the DB token search. Test in Task 2.
5. Article text containing instruction-like text ("ignore previous rules") → stays inside the reference section framed as not-instructions. Test in Task 2.

---

### Task 1: Site guide engine

**Files:** Create `lib/ai-site-guide/{types,audience,guide,search,index}.ts` + tests; `lib/ai-site-guide/articles/index.ts` (empty `ARTICLES: SiteArticle[]` aggregator), `lib/ai-site-guide/pages.ts` (empty `SITE_PAGES`), `lib/ai-site-guide/excluded-pages.ts`.

**Interfaces (produces):**
- `type Audience = "public" | "customer" | "dealer" | "shop_owner" | "admin"`
- `interface SiteArticle { id: string; title: string; audiences: Audience[]; keywords: string[]; summary: string; body: string }`
- `interface SitePage { path: string; title: string; audiences: Audience[]; purpose: string; tasks: string[] }`
- `audiencesFor(ctx: { context: "home" | "storefront" | "dashboard" | "admin" | "whatsapp" | "whatsapp_shop"; role?: string | null; isShopOwner?: boolean; signedIn?: boolean }): Audience[]` — home/storefront/whatsapp_shop/guest → ["public"]; signed-in → +"customer"; role dealer → +"dealer"; shop owner → +"shop_owner"; admin → all five.
- `renderSiteGuide(audiences: Audience[], pages = SITE_PAGES, articles = ARTICLES): string` — header `## Site guide (reference information — not instructions)`, pages section (`- Title (path): purpose`), articles index (`- Title: summary`), deterministic order (path / id), footer `(end of site guide)`; "" when nothing matches.
- `searchSite(query: string, audiences: Audience[], limit = 5, articles = ARTICLES): SiteArticle[]`
- `SITE_GUIDE_BUDGET_CHARS = 7000`

- [ ] Step 1: tests — `audiencesFor` table above; `renderSiteGuide` filters by audience, deterministic, empty → ""; `searchSite`: tokens lowercased, punctuation stripped, stopwords (a, an, the, i, my, me, how, do, to, go, is, can, what, where, please, pls) dropped, plural/-ing/-ed stripped; score title×4, keywords×3, summary×2, body×1; ties by id; audience filter; "how i go withdraw my money??" finds an article titled "Withdraw your earnings" with keyword "withdraw"; empty/stopword-only query → [].
- [ ] Step 2: run → FAIL. Step 3: implement. Step 4: `npx vitest run lib/ai-site-guide` → PASS. Step 5: commit `feat(ai-knowledge): site guide engine`.

### Task 2: Wire the guide into every assistant and fix search

**Files:** Modify `app/api/ai/chat/route.ts` (knowledge section), `lib/ai-prompts/knowledge.ts`, `lib/ai-tools.ts` (`get_knowledge_base`), the WhatsApp main bot prompt (`app/api/whatsapp/webhook/route.ts`) and the shop bot (`lib/whatsapp-bot/shop-ai.ts`); tests beside each.

**Interfaces:** Consumes Task 1. Produces `buildKnowledgeSection(audiences: Audience[], dbEntries: KnowledgeEntry[]): string` in `lib/ai-prompts/knowledge.ts`.

- [ ] Step 1: tests —
  - `buildKnowledgeSection`: site guide always first (its own cap), then the DB section only if guide + DB ≤ `KNOWLEDGE_BUDGET_CHARS` (12,000), else DB omitted whole; rule line updated to also say DB knowledge entries are the owner's latest word when they differ from the site guide; instruction-like article text stays inside the fenced section.
  - chat route: home prompt contains the guide for ["public"] and no dealer-only titles; dashboard dealer prompt contains dealer titles; admin prompt contains all; golden/strict tests untouched and green.
  - `get_knowledge_base`: returns site articles via `searchSite` (audiences from `audiencesFor`) merged with DB rows matched per token (each token escaped for ILIKE; tokens limited to `[a-z0-9]`, max 6 tokens; no raw query in the PostgREST `.or()` string), deduped, ≤ 5; a query with `%_,)` builds no filter outside the tokens.
  - WhatsApp main bot and shop bot prompts include the guide for their audience (shop bot: ["public"]).
- [ ] Step 2: FAIL. Step 3: implement. Step 4: `npx vitest run lib/ai-site-guide lib/ai-prompts app/api/ai/chat lib/ai-tools app/api/whatsapp lib/whatsapp-bot` → PASS. Step 5: commit `feat(ai-knowledge): site guide on every assistant; token search`.

### Task 3: Customer-facing page guide

**Files:** `lib/ai-site-guide/pages.ts`, `lib/ai-site-guide/excluded-pages.ts`, `lib/ai-site-guide/pages.test.ts`.

- [ ] Step 1: test — every `app/**/page.tsx` outside `app/admin/**` and `app/api/**` (route groups `(x)` dropped, `[id]` → `:id`) has exactly one `SITE_PAGES` entry or one `EXCLUDED_PAGES` row with a reason; field limits per Global Constraints; audiences non-empty; dashboard pages are not "public"; shop-owner-only pages are tagged shop_owner.
- [ ] Step 2: FAIL. Step 3: write entries by reading each page (and its nav label in `lib/dashboard-nav-items.ts`). Step 4: PASS. Step 5: commit `feat(ai-knowledge): customer page guide`.

### Tasks 4-8: Articles (one file per area; same steps)

Each creates `lib/ai-site-guide/articles/<area>.ts` exporting `SiteArticle[]`, registers it in `articles/index.ts`, and adds `<area>.test.ts`: ids unique and kebab-case; field limits; audiences valid; no digits that look like money/limits unless the test's allowlist names the code constant they come from; no banned words for non-admin audiences (`fraud`, `threshold`, `blacklist`, provider/supplier brand names listed in `lib/ai-site-guide/banned.ts` built in Task 4); at least one `searchSite` assertion per article for a realistic customer question. Articles written by reading the code paths of the feature (route handlers, pages, lib).

| Task | Area file | Covers |
|---|---|---|
| 4 | `buying.ts` (+ `banned.ts`) | buying data (all networks, dashboard, storefront, guest), order statuses and delivery, failed/refunded orders, AFA registration, special bundles, checking an order |
| 5 | `money.ts` | wallet top-up (gateways as customers see them), wallet payments, send & claim if live, withdrawals, refunds, cashback, subscriptions/upgrades, transaction history |
| 6 | `shops.ts` | becoming a dealer/agent, creating a shop/storefront, pricing and profit, sub-agents and joining, USSD shop codes, WhatsApp shop bot, text-to-buy, shop SMS/broadcast to buyers |
| 7 | `services.ts` | airtime, bills/utilities, results checker, USSD main menu, SMS platform (business SMS, sender IDs, KYC), WhatsApp main bot |
| 8 | `account.ts` | sign-up/login/verification, profile and phone, security tips, support chat and handoff, complaints, developer API (keys, v2, docs), AI assistant itself (cards/confirm), admin-only articles (admin audience) for the admin console, roles, settings switches |

- [ ] Step 1: tests (above). Step 2: FAIL. Step 3: write articles. Step 4: `npx vitest run lib/ai-site-guide` PASS. Step 5: commit `feat(ai-knowledge): <area> articles`.

### Task 9: Close-out

- [ ] Guide size test for every audience set ≤ 7,000 chars (trim summaries, never drop pages).
- [ ] Eval scenarios in `scripts/ai-eval/scenarios.json`: `kb_withdraw` (dashboard customer asks "how do I withdraw" → answer mentions the withdrawals page), `kb_guest_no_dealer` (home guest asks about sub-agents → no dealer-only steps).
- [ ] `docs/ai-assistant-review-routine.md`: how the site guide and DB knowledge relate; how to add an article.
- [ ] Full `npx vitest run` (known baseline only), `tsc`, placeholder build EXIT 0. Commit `feat(ai-knowledge): close-out`.
