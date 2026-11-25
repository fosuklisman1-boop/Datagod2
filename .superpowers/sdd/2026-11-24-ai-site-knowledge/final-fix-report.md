# Final fix report: feat/ai-site-knowledge (from 4588b76b)

## Items
- I1 get_knowledge_base (lib/ai-tools.ts): DB rows first (up to 3), site articles fill to 5, then any leftover DB rows; deduped by title (DB wins). RED: "owner DB rows never crowded out", "caps DB rows at 3", "DB rows first" failed (site rows came first). GREEN after change. Existing tests that encoded site-first order were updated (first-order test, dedupe test).
- I2 platformOnly: `platformOnly?: true` on SitePage/SiteArticle; `SiteViewOptions { shopSurface }` and `RenderOptions extends it with { toolHint }`. renderSiteGuide(..., options), searchSite(..., limit, articles, options), buildKnowledgeSection/withSiteGuide pass options through. Threaded: chat route (context storefront -> shopSurface), shop bot (shopSurface + toolHint false), get_knowledge_base (ctx.context storefront or whatsapp_shop). RED: guide.test shop-surface tests, tool test "never returns platformOnly on shop surfaces", then GREEN. Route test (storefront stable lacks (/whatsapp):, (/join):, (/developers):; home keeps them) and shop-ai test added.
- M1 toolHint:false drops the articles-index line (titles are useless without the tool); a guide with only articles then renders "". Shop bot passes false. Test in guide.test, knowledge.test, shop-ai.test.
- M2 tokens: stemmed tokens under 3 chars are dropped in search.ts tokens() (applies to site search, queryTokens and article text) and the tool's DB filter is >= 3. Tests: "in/of" match nothing, query of only two-letter words never touches the DB. Side effect: "can i buy data on ussd" no longer ranked ussd-main-menu top 3 (the "on" point is gone), so its title was changed to "Buy data and more by USSD on the main Datagod code" (services.test passes unchanged).
- M5 spec updated: titles-only index, SITE_GUIDE_BUDGET 10000, KNOWLEDGE_BUDGET 18000, DB first, platformOnly/shop surfaces, tokens >= 3.

## platformOnly list
Pages (20): /, /services, /ai, /bulk-sms, /results-checker, /whatsapp, /join, /join/:code, /join/shop/:handle, /auth/login, /auth/signup, /auth/forgot-password, /auth/reset-password, /developers, /developers/:group, /developers/changelog, /developers/errors, /developers/go-live, /developers/starter-kits, /developers/status.
Kept visible on shop surfaces: /vouchers (PIN lookup), all /shop/:slug* pages.
Articles (13): account-sign-up, account-log-in, account-forgot-password, developer-api-docs, ai-assistant-customer, results-checker-buy-vouchers, check-results-service, ussd-main-menu, sms-send-bulk, whatsapp-main-bot, become-a-dealer-or-agent, sub-agent-join-a-shop, text-to-buy-customer (main-line).
New public article (not platformOnly): text-to-buy-shop-line "Buy data by SMS from a shop's own number" keeps shop-line ordering visible.
Kept visible: account-security-tips, results-checker-retrieve-pin, shop storefront/airtime/AFA/order-status articles, ussd-buy-from-a-shop, data/networks articles.
Judgement calls the owner may flip: sign-up/log-in/forgot-password hidden (shop customers need no account); /ai and results-checker purchase pages hidden (platform dashboard flows).

## Process note
The new guide.test.ts block was first appended with a shell heredoc and one sed (a test file, content verified, no corruption); every other edit used Edit/Write.
