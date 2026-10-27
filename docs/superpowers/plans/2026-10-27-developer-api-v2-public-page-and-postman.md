# Developer API v2 — Plan 7: Public /developers page and Postman collection

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** A public, professional, Flexy-style `/developers` page (layout A: one long page, sticky side nav, tabbed cURL/Node/PHP/Python samples) rendered from the existing docs registry, plus downloadable Postman collection and sandbox/live environments generated from the same registry so they cannot drift.

**Architecture:** No new data. `lib/api-v2/docs/registry.ts` (`v2DocsRegistry`, `V2_BASE_URL`) and the shared kit `components/developer/docs/DocsPage.tsx` already render the docs inside the dashboard (`app/dashboard/developer/page.tsx`). Add (1) a pure generator `lib/api-v2/docs/postman.ts`, (2) three download route handlers that generate on request, (3) the public page `app/developers/page.tsx` with a header, hero and Postman buttons around `DocsPage`, (4) a Postman button in the dashboard docs tab via the existing `top` prop, (5) sitemap entry.

**Risk tier:** Tier 2 (public content, no money, no auth). No migrations. A fresh reviewer pass is still required because the page is public: no secrets, no real keys or phones in examples, no internal ids.

## Constraints

- v1 and all v2 routes untouched. Edit with Edit/Write tools, never `sed`. CRLF files (registry.ts) are not edited in this plan.
- `/developers` must be reachable logged out (check `middleware.ts` has no allow-list that would redirect it; do NOT edit middleware.ts — another session has uncommitted edits there; if it blocks, stop and report).
- The root `globals.css` sets `overflow-x: hidden` on html/body, which breaks `position: sticky` in some browsers: the page must scroll correctly with the sticky section bar and side nav working (verify with headless Chrome at 500px and 1280px, light and dark; see memory reference-headless-screenshots). Navy brand accent (`--primary`); desktop `lg:` widening from the start.
- Postman collection: Collection v2.1.0 JSON. Variables: `base_url` (= `V2_BASE_URL`), `standard_key`, `commission_key`, `sms_key`; each request sends `Authorization: {{<type>_key}}` for its key type (no auth header for endpoints with `keyType: null`). Folders mirror registry sections; request names are `METHOD path`; bodies come from `requestExample`; path params like `[reference]` become Postman `:reference` variables with a sample value; the description holds summary, params table and error list. A test script per request asserts the JSON envelope (`success` boolean). Two environment files: `Datagod v2 Sandbox` (keys prefilled with placeholder text such as `dg2_test_your_api_key`) and `Datagod v2 Live` (live placeholders). Keys are placeholders only, never real values.
- Downloads: `GET /developers/postman/collection`, `/developers/postman/sandbox-environment`, `/developers/postman/live-environment` return JSON with `Content-Disposition: attachment; filename=...` and `Cache-Control: public, max-age=300`. Generated from the registry at request time.

## Tasks

### Task 1: Postman generator + routes (TDD)
Create `lib/api-v2/docs/postman.ts` (`buildPostmanCollection(sections, baseUrl)`, `buildPostmanEnvironment(kind)`) and tests: every registry endpoint appears exactly once (drift test iterating `v2DocsRegistry`), correct method and URL (`{{base_url}}` + path), correct auth variable per key type, bodies match `requestExample`, placeholders only, valid v2.1 schema URL and `info` fields, environments contain the four variables. Route handlers under `app/developers/postman/*/route.ts` with a test for headers. Commit `feat(api-v2): postman collection generator and downloads`.

### Task 2: Public page + dashboard button + sitemap
`app/developers/page.tsx` (server component, `metadata` with title, description, OG), a client wrapper if needed. Header with Datagod logo link, links to Dashboard/Developer API and Log in; hero (title, one-line value prop, base URL chip, "Download Postman collection" primary button plus environment buttons, "Get your API key" link to `/dashboard/developer`); then `DocsPage` with `sections={v2DocsRegistry}`, `stickyTop` equal to the header height, and the `top` slot holding the Postman buttons. Reuse one `PostmanButtons` component in the dashboard docs tab. Add `/developers` to `app/sitemap.ts`. Screenshots at 500px and 1280px, light and dark, saved outside the repo (scratchpad) and checked: nothing clipped, side nav sticky, tabs usable, code blocks scroll horizontally. Commit `feat(api-v2): public developers page`.

### Task 3: Verify and ship
Full vitest (known failures only), `tsc`, fresh reviewer, merge origin/main, real `next build`, push `HEAD:main`, watch the deploy, check `/developers` and the three downloads live (browser-like User-Agent for non-API paths), update memory.
