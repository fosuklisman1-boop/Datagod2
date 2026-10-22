# Developer API v2 — Plan 2: Admin Console, Developer Dashboard and Docs Kit

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins the Flexy-style API-key console and give developers a Flexy-style dashboard page to generate and manage v2 keys, both built on a shared docs/UI kit that plan 7's public `/developers` page will reuse.

**Architecture:** Pure logic (docs registry, code-sample generator, admin stats shaping, key list merge/filter, access summary) lives in `lib/api-v2/` with unit tests. Thin routes read it. UI is split into small components under `components/developer/docs/` (shared kit), `components/admin/api-keys/` (console) and `components/developer/` (dashboard). One SQL migration adds two service-only stats functions so tiles are accurate without row caps. Plan 1's routes and store are consumed, not changed (except one additive field on `GET /api/user/v2-keys`).

**Tech Stack:** Next.js 15 App Router, React client components, existing shadcn kit in `components/ui`, Tailwind, `sonner` toasts, Vitest (node environment: logic is tested; components are verified by build plus headless screenshots), Supabase service role.

**Spec:** `docs/superpowers/specs/2026-10-22-developer-api-v2-design.md` (sections "Admin console" and "Public /developers page: required detail and polish"). Plan 1: `docs/superpowers/plans/2026-10-22-developer-api-v2-foundation.md` (merged to main, commit 2cde93e0, v2 dark).

**Series:** plan 1 foundation (done), **plan 2 this**, 3 data/wallet/orders, 4 airtime+bills, 5 results+AFA, 6 SMS, 7 public page + Postman (reuses this kit), 8 `api.` host rewrite.

## Global Constraints

- Style (user, verbatim: "Much deatails and should be professional", and the dashboard API page "will use this style too"): the Flexy docs look from the user's screenshots: a sticky bar reading "SECTION: <name>" with a **Contents** button on mobile and a sticky side nav on desktop; tabbed **cURL / Node.js / PHP / Python** code samples with a **Copy** button and horizontally scrolling lines (never clipped); info and warning callouts; numbered step lists; "Code sample" headings. Admin console follows the user's admin screenshots: overview tiles, "Top API user (24h)" card, Feature Controls (API access switch + allowed-roles chips + Save), tabs **API Keys / Request Logs**, search, status filter (All/Pending/Active/Revoked), role filter, sort, per-key rows with Revoke, an activity toggle and a limits toggle.
- Brand: navy accent `#1b388b` (the project's `--primary` is navy); light and dark themes via existing tokens; works on mobile (500px) and multi-column from `lg:` upward. Use existing components (`DashboardLayout`, `PageHeaderBanner`, `DashboardHeroBanner`, `Card`, `Tabs`, `Badge`, `Switch`, `Dialog`, `AlertDialog`, `Sheet`).
- Admin routes call `verifyAdminAccess` first. No response, log line or UI element may ever show `key_hash` or a full key (full key only once, in the generate dialog).
- v1 stays untouched: v1 keys appear in the admin console with a "v1" badge and only the controls v1 supports (enable/disable, delete via the existing `/api/admin/api-keys` routes); no v1 file under `app/api/v1/**` or `lib/api-auth.ts` changes.
- Stats honesty: tiles that need data v2 does not record yet (revenue, spent, orders) are returned as `null` by the API and **hidden** by the UI until plan 3 attributes orders to keys. Never show a fake `0`.
- Roles list and error shapes come from plan 1 (`V2_ROLES = user, sub_agent, dealer, admin`; envelope for the public API; plain `{ error }` JSON for dashboard/admin routes).
- Regenerating a live key sends the replacement back to `pending` (plan 1 ruling); the dashboard must say so before the user confirms.
- Edit code with the Edit/Write tools, never `sed`. Run a real `next build` before pushing main. New sidebar entries need the NEW tag (`lib/nav-new.ts`); this plan adds none (it rebuilds two existing pages).
- Applying migration 0129 follows the prod change protocol (precheck, self-rolling-back dry run, user OK, apply, verify).

## Review Focus

- Zero data: no keys, no logs in 24h, one log only: success rate must not be NaN/Infinity, latency must not be NaN, top-user card must disappear rather than show "undefined" (Task 3, Task 5).
- A key with no owner row (deleted user), a key with `rate_limits: null` and one with partial overrides: the limits editor shows defaults for missing groups and saves only valid integers 1–10000 (Task 5, Task 6).
- Race in the UI: clicking Approve then Revoke quickly, or a 409 from the PATCH (key changed since load) must refresh the row and say so, not leave a stale status (Task 6).
- Dashboard: a user whose role is not allowed must see an explanation, not broken buttons; a pending live key must read "Waiting for approval", never "Active"; the generate dialog must not be dismissible without a copy-or-confirm step (Task 7).
- Code samples: keys and URLs with quotes, `$` or backslashes must not break the generated shell/PHP/Python/Node strings (Task 1).
- Long content: very long emails, 100+ keys, 1000 log rows: lists must not overflow the viewport horizontally on 500px width (Tasks 6, 7).

---

### Task 1: Docs registry and code-sample generator (pure)

**Files:**
- Create: `lib/api-v2/docs/registry.ts`
- Create: `lib/api-v2/docs/samples.ts`
- Test: `lib/api-v2/docs/samples.test.ts`, `lib/api-v2/docs/registry.test.ts`

**Interfaces:**
- Produces: `type DocLang = "curl" | "node" | "php" | "python"`; `interface V2Param { name: string; type: string; required: boolean; description: string }`; `interface V2Endpoint { id: string; group: "start" | "data" | "commission" | "results" | "sms" | "sandbox"; method: "GET" | "POST"; path: string; keyType: KeyType | null; rateLimit: string; summary: string; params: V2Param[]; requestExample: object | null; successExample: object; errors: { status: number; message: string }[]; notes: string[] }`; `interface V2DocSection { id: string; label: string; group: V2Endpoint["group"]; intro?: string; endpoints: V2Endpoint[] }`; `V2_BASE_URL = "https://api.datagod.store/v2"`; `v2DocsRegistry: V2DocSection[]` seeded with a "Start" section (overview, authentication, key types, response format, errors and limits, idempotency are plain prose sections represented as sections with `endpoints: []` plus `intro`) and the two live endpoints from plan 1 (`GET /account/role`, `GET /wallet/balance`, both standard key); `buildSamples(ep: V2Endpoint, opts?: { baseUrl?: string; keyPlaceholder?: string }): Record<DocLang, string>`; `shellQuote(s: string): string`.
- Consumes: `KeyType` from `lib/api-v2/keys.ts`; error codes from `lib/api-v2/envelope.ts`.

- [ ] **Step 1: Write failing tests** in `samples.test.ts`: for `GET /account/role` the `curl` sample contains `-H "Authorization: dg2_live_your_api_key"` and the full URL `https://api.datagod.store/v2/account/role` and no `-d`; for a POST endpoint with a `requestExample` the `curl`, `node` (uses `fetch`), `php` (uses `curl_init`) and `python` (uses `requests`) samples each contain the JSON body and the `Content-Type` header; a `keyPlaceholder` containing `"` , `$` and `\` is escaped per language (assert the exact escaped substring for shell single-quote escaping `'\''`, PHP single-quoted string with `\\` and `\'`, Python and JS via `JSON.stringify`); `shellQuote("a'b")` equals `'a'\''b'`.
- [ ] **Step 2: Write failing tests** in `registry.test.ts`: every endpoint has non-empty `summary`, `successExample`, a `rateLimit` string, and unique `id`; every endpoint's `path` starts with `/`; section ids are unique; each endpoint's `keyType` is one of the three or null for the Start section; every `errors[].status` is a valid `V2ErrorStatus`; the registry contains `GET /account/role` and `GET /wallet/balance`.
- [ ] **Step 3: Run** `npx vitest run lib/api-v2/docs` — expect FAIL (modules missing).
- [ ] **Step 4: Implement** both files. Samples use `fetch` for Node (no dependency), cURL extension for PHP, `requests` for Python; JSON bodies pretty-printed with 2 spaces. The Start-section prose must cover everything the spec lists for the Authentication section (header forms, once-only key warning, numbered "Getting your API key" steps ending in admin approval, key types and which groups they unlock, sandbox keys).
- [ ] **Step 5: Run** the tests — expect PASS. **Step 6: Commit** `feat(api-v2): docs registry and code-sample generator`

---

### Task 2: Docs UI kit (shared with plan 7)

**Files:**
- Create: `components/developer/docs/CodeTabs.tsx`, `Callout.tsx`, `SectionBar.tsx`, `ParamTable.tsx`, `StepList.tsx`, `EndpointBlock.tsx`, `DocsPage.tsx`

**Interfaces:**
- Consumes: Task 1 (`V2Endpoint`, `V2DocSection`, `buildSamples`, `v2DocsRegistry`).
- Produces: `<CodeTabs samples={Record<DocLang,string>} />` (tabs cURL/Node.js/PHP/Python, Copy button with check feedback and an accessible label, `overflow-x-auto` code area); `<Callout tone="info"|"warning" title?>`; `<StepList steps={string[]} />` (numbered navy badges); `<ParamTable params={V2Param[]} />`; `<EndpointBlock endpoint={V2Endpoint} />` (method badge, path, key-type + rate-limit chips, summary, ParamTable, Request/Success/Errors blocks, notes with arrow bullets, "Code sample" heading, CodeTabs); `<SectionBar sections={{id,label}[]} activeId />` (sticky "SECTION: <label>" bar with **Contents** button opening a `Sheet` on mobile; a sticky side nav on `lg:` and up; scroll-spy sets `activeId`); `<DocsPage sections={V2DocSection[]} />` composing them (layout A from the spec) and accepting an optional `top` slot and `compact` flag so the dashboard can embed it.
- Style details to match the screenshots: section cards with rounded corners and subtle border, monospace code on a dark panel in both themes, warning callout in amber, step badges in navy.

- [ ] **Step 1: Implement the components** per the signatures. Keep each file under ~150 lines; code areas must never clip (`overflow-x-auto`, `whitespace-pre`), tap targets at least 40px, headings use the existing type scale.
- [ ] **Step 2: Add a throwaway preview route** `app/dev-preview/docs/page.tsx` rendering `<DocsPage sections={v2DocsRegistry} />` (to be deleted in Task 8) so it can be screenshotted without logging in.
- [ ] **Step 3: Verify** `npx tsc --noEmit -p . 2>&1 | grep developer/docs` is empty; start `npm run dev`, take 500px-wide and 1280px-wide screenshots of `/dev-preview/docs` in light and dark using the headless-Chrome method in `reference-headless-screenshots`, and read them: no horizontal page scroll at 500px, Copy works, tabs switch, Contents opens, navy accent present.
- [ ] **Step 4: Commit** (without the preview route) `feat(api-v2): shared docs UI kit`

---

### Task 3: Admin stats functions (migration 0129) and shaping (pure)

**Files:**
- Create: `migrations/0129_api_v2_admin_stats.sql` (next free number at execution time)
- Create: `lib/api-v2/admin-stats.ts`
- Test: `lib/api-v2/admin-stats.test.ts`

**Interfaces:**
- Produces (SQL, `SECURITY DEFINER`, `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, granted to `service_role` only): `api_v2_admin_stats(p_since timestamptz) returns jsonb` with `{ keys: { total, pending, active, revoked }, requests: n, ok: n, failed: n, avg_latency_ms: n|null, top: { user_id, requests } | null }`; `api_v2_key_activity(p_key uuid, p_since timestamptz) returns jsonb` with `{ requests, ok, failed, avg_latency_ms|null, last_used_at|null }`. "ok" = `status_code` 200–399, "failed" = 400+ (401s with no key id are not in `api_v2_logs`).
- Produces (TS): `interface AdminStats { totalKeys; pendingKeys; activeKeys; requests24h; successRate: number | null; failed24h; avgLatencyMs: number | null; top: { userId: string; name: string | null; email: string | null; requests: number } | null; revenue24h: null; revenueLifetime: null }`; `shapeStats(raw: unknown, owner: { name: string | null; email: string | null } | null): AdminStats`; `interface KeyActivity { requests; ok; failed; successRate: number | null; avgLatencyMs: number | null; lastUsedAt: string | null; spent: null; orders: null }`; `shapeKeyActivity(raw: unknown): KeyActivity`; `parseLogQuery(sp: URLSearchParams): { ok: true; value: LogQuery } | { ok: false; error: string }` where `LogQuery = { keyId?; userId?; statusClass?: "success"|"client_error"|"server_error"; since?; until?; endpoint?; limit: number; offset: number }` (limit default 100, max 200, offset ≥ 0, ids must be UUIDs, dates ISO).

- [ ] **Step 1: Write failing tests:** `shapeStats` with `requests:0, ok:0, failed:0` gives `successRate: null` and `avgLatencyMs: null`; with `requests:1000, ok:993, failed:7, avg_latency_ms: 264.6` gives `successRate: 99.3` and `avgLatencyMs: 265` (rounded); malformed raw (null, strings, negative numbers) yields all-zero/null stats and never throws; `top` null stays null; `revenue24h` and `revenueLifetime` are always `null`. `shapeKeyActivity` mirrors that, `spent` and `orders` always `null`. `parseLogQuery`: defaults, `limit=5000` clamps to 200, `offset=-1` fails, `keyId=not-a-uuid` fails, `statusClass=bogus` fails, a bad date fails.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** the pure functions. **Step 4: Run** — PASS.
- [ ] **Step 5: Write the migration** (functions only, idempotent `CREATE OR REPLACE`, no table changes) and review it against `migrations/0128_api_v2_foundation.sql` for naming and the REVOKE pattern.
- [ ] **Step 6: Do not apply it** (Task 8). **Step 7: Commit** `feat(api-v2): admin stats shaping and stats functions`

---

### Task 4: Admin stats, activity and logs routes

**Files:**
- Create: `app/api/admin/api-v2/stats/route.ts`, `app/api/admin/api-v2/keys/[id]/activity/route.ts`, `app/api/admin/api-v2/logs/route.ts`

**Interfaces:**
- Consumes: Task 3 (`shapeStats`, `shapeKeyActivity`, `parseLogQuery`), plan 1 store (`getAdminClient`).
- Produces: `GET /api/admin/api-v2/stats` returns `{ stats: AdminStats }` (24h window; owner name/email for the top user from one `users` lookup); `GET .../keys/[id]/activity` returns `{ activity: KeyActivity }` (404 if the key does not exist); `GET .../logs?…` returns `{ logs: Row[]; total: number }` where `Row = { id; key_id; user_id; method; endpoint; status_code; error_code; ip_address; duration_ms; environment; created_at }` (explicit column list, no payloads exist to leak), newest first, paged, with `key_prefix` and owner email joined via two chunked lookups.

- [ ] **Step 1:** Each handler starts with `verifyAdminAccess` and returns `errorResponse` when not admin; invalid query returns 400 with the parser's error; an RPC error returns 500 with a generic message (log the code only).
- [ ] **Step 2: Verify** `npx tsc --noEmit -p . 2>&1 | grep admin/api-v2` is empty. **Step 3: Commit** `feat(api-v2): admin stats, activity and logs routes`
- Note: no unit tests here by design (thin wiring over Task 3's tested functions); Task 8's live check exercises them.

---

### Task 5: Admin key-list view logic (pure)

**Files:**
- Create: `lib/api-v2/admin-view.ts`
- Test: `lib/api-v2/admin-view.test.ts`

**Interfaces:**
- Produces: `interface ConsoleKey { id: string; source: "v1" | "v2"; ownerName: string; ownerEmail: string; ownerRole: string | null; ownerPhone: string | null; prefix: string; status: "pending" | "active" | "revoked"; keyType: "standard" | "commission" | "sms" | null; environment: "test" | "live"; requests24h: number | null; lastUsedAt: string | null; rateLimits: Partial<Record<LimitGroup, number>> | null; createdAt: string }`; `mergeKeys(v1: V1AdminKey[], v2: V2AdminKey[]): ConsoleKey[]` (v1 `is_active` true -> `active`, false -> `revoked`; v1 has `keyType: null`; missing owner becomes `"Deleted user"` / `""`); `filterKeys(keys: ConsoleKey[], f: { q: string; status: "all" | ConsoleKey["status"]; role: string | "all"; sort: "newest" | "oldest" | "most_used" }): ConsoleKey[]` (search is case-insensitive over name, email, phone and prefix; `most_used` sorts by `requests24h` desc with nulls last); `statusCounts(keys): { all; pending; active; revoked }`; `limitFormValues(rateLimits): Record<LimitGroup, number>` (defaults filled from `DEFAULT_LIMITS`); `validateLimitForm(values: Record<LimitGroup, string>): { ok: true; value: Record<LimitGroup, number> } | { ok: false; errors: Partial<Record<LimitGroup, string>> }` (integers 1–10000).
- Consumes: `LimitGroup`, `DEFAULT_LIMITS`, `parseLimitOverrides` from `lib/api-v2/limits.ts`.

- [ ] **Step 1: Write failing tests:** `mergeKeys` maps statuses and badges both sources, tolerates a missing owner, and never copies a `key_hash` field even if the input has one (assert the output object keys exactly); `filterKeys` search hits email, phone and prefix, role filter, each sort including nulls last; `statusCounts` adds up; `limitFormValues(null)` equals `DEFAULT_LIMITS` and `({status: 7})` keeps 7 with defaults elsewhere; `validateLimitForm` rejects `""`, `"0"`, `"10001"`, `"1.5"`, `"abc"` with a per-group message and accepts `"25"`.
- [ ] **Step 2–4:** FAIL, implement, PASS. **Step 5: Commit** `feat(api-v2): admin console view logic`

---

### Task 6: Admin console UI (`app/admin/api-keys`)

**Files:**
- Modify (rewrite): `app/admin/api-keys/page.tsx`
- Create: `components/admin/api-keys/OverviewTiles.tsx`, `FeatureControls.tsx`, `KeyList.tsx`, `KeyRow.tsx`, `ActivityPanel.tsx`, `LimitsEditor.tsx`, `RequestLogs.tsx`, `use-console-data.ts` (client data hook)

**Interfaces:**
- Consumes: Task 4 routes; plan 1 routes `GET /api/admin/api-v2/keys`, `PATCH /api/admin/api-v2/keys/[id]` (`{action: "approve"|"revoke"|"set_limits"|"reset_limits", limits?}`), `GET/PUT /api/admin/api-v2/config`; existing v1 routes `GET/PATCH/DELETE /api/admin/api-keys`, `POST /api/admin/api-keys/global-kill`; Task 5 logic.
- Behaviour to build (matches the user's screenshots and the spec's Admin console section): header "API Key Management" with Refresh; Overview tiles (Total, Pending, Active, Requests 24h, Success rate 24h, Failed 24h, Avg latency; revenue tiles only when non-null) and a "Top API user (24h)" card (hidden when null); Feature Controls (API access switch, allowed-roles chips for `V2_ROLES`, Save, and the existing Global Kill with a confirm dialog that shows the per-step result message from the response); tabs **API Keys** and **Request Logs**; search + All/Pending/Active/Revoked chips with counts + role select + sort; each `KeyRow` shows owner, masked prefix, status pill, type badge (Standard / Commission · Utilities / SMS / v1), role, "N req/24h", "Never used"/last used, and actions Approve (pending v2 only), Revoke (v2 PATCH; v1 uses the existing enable/disable and delete), an expandable `ActivityPanel` (requests, success, failed, success rate, avg latency; spent/orders only when non-null) and a `LimitsEditor` (purchase, bulk, balance, status with Save and Reset to Default, v2 only). A `409` from a PATCH refreshes the list and toasts "Key changed, refreshed". Request Logs tab: filters (status class, endpoint search, key), paged table (method, endpoint, status, ms, IP, time), no payload column.
- Layout: single column on mobile; from `lg:` tiles in a 4-up grid and the key list in a two-column card grid. No horizontal page scroll at 500px.

- [ ] **Step 1: Implement** the hook (`use-console-data.ts`: loads keys (v1 + v2), stats, config; exposes `refresh`, `approve`, `revoke`, `saveLimits`, `resetLimits`, `saveConfig`; auth header from the Supabase session exactly as the current page does) and the components. Keep each component under ~200 lines; split further if needed.
- [ ] **Step 2: Verify** `npx tsc --noEmit -p . 2>&1 | grep -E "admin/api-keys|components/admin/api-keys"` is empty and the page still builds.
- [ ] **Step 3: Screenshot** with seeded fake data: add a throwaway `app/dev-preview/admin-keys/page.tsx` that renders the components with a hard-coded `ConsoleKey[]`, `AdminStats` and config (no network), capture 500px and 1280px, light and dark, and read them against the user's admin screenshots (tiles, top-user card, feature controls, chips, key rows, expanded activity and limits panels).
- [ ] **Step 4: Commit** (without the preview route) `feat(api-v2): admin API-key console`

---

### Task 7: Developer dashboard page (`/dashboard/developer`)

**Files:**
- Modify: `app/api/user/v2-keys/route.ts` (GET adds `access`)
- Modify: `lib/api-v2/key-issue.ts` (add `accessSummary`); Test: `lib/api-v2/key-issue.test.ts`
- Create: `components/developer/V2KeysCard.tsx`, `components/developer/GenerateKeyDialog.tsx`
- Modify (rewrite): `app/dashboard/developer/page.tsx`

**Interfaces:**
- Produces: `accessSummary(input: { role: string; suspended: boolean; enabled: boolean; allowedRoles: string[] }): { canGenerate: boolean; reason: "ok" | "disabled" | "suspended" | "role_not_allowed" }` (disabled checked first); `GET /api/user/v2-keys` now returns `{ keys, access: { canGenerate, reason } }` using `getConfig` and the caller's `users` row.
- UI: the page keeps the existing hero banner and two tabs, restyled with the docs kit: **Keys** tab and **Documentation** tab (`<DocsPage sections={v2DocsRegistry} compact />`). Keys tab: an explanation callout (test keys are sandbox and active at once; live keys wait for admin approval; regenerating a live key returns it to pending and revokes the old one), then a `V2KeysCard` with one block per key type (Standard, Commission, SMS shown as "Coming soon" and disabled until plan 6) and per environment (Test, Live) showing status pill (**Waiting for approval** / **Active** / **Revoked** / **No key**), masked prefix, last used, and buttons Generate / Regenerate / Revoke (revoke and regenerate behind `AlertDialog` confirmations; the regenerate confirmation for a live key states the pending consequence). `GenerateKeyDialog` shows the full key once with Copy, a warning callout ("shown only once"), and cannot be closed by backdrop click; its close button is enabled only after Copy was pressed or a "I have saved it" box is ticked. When `access.canGenerate` is false the card is replaced by a callout explaining the `reason` in plain words. The legacy v1 card (`DeveloperKeysCard`) stays below under a collapsed "Legacy v1 keys" section with its current behaviour; v1's old docs tab content moves under the same section.
- Layout: single column on mobile; from `lg:` the key blocks sit in a two-column grid and the Documentation tab uses the sticky side nav.

- [ ] **Step 1: Write failing tests** for `accessSummary`: disabled wins over everything, then suspended, then role not allowed, else ok (one case each).
- [ ] **Step 2–4:** FAIL, implement `accessSummary` and the route change, PASS (`npx vitest run lib/api-v2/key-issue.test.ts`).
- [ ] **Step 5: Implement** the components and page. Reuse `Dialog`/`AlertDialog`; fetch with the session bearer token like `DeveloperKeysCard`.
- [ ] **Step 6: Verify** `tsc` clean for the touched paths; screenshot a throwaway `app/dev-preview/dev-dashboard/page.tsx` that renders `V2KeysCard` with injected fake keys for each state (no key, pending live, active live, revoked, access denied) at 500px and 1280px, light and dark.
- [ ] **Step 7: Commit** (without the preview route) `feat(api-v2): developer dashboard page`

---

### Task 8: Apply, verify, review, ship

**Files:** delete the three `app/dev-preview/**` throwaway routes.

- [ ] **Step 1: Delete** `app/dev-preview/` and confirm `git status` shows it removed.
- [ ] **Step 2: Precheck (read-only)** that `api_v2_admin_stats` and `api_v2_key_activity` do not exist; **dry run** migration 0129 inside a self-rolling-back `DO ... RAISE EXCEPTION` block, including a call of both functions on the empty tables returning the zero-shape JSON; show the user and wait for their OK; then **apply** and verify the functions exist, that `anon` cannot execute them (REST `rpc` call with the anon key is denied), and that `service_role` can.
- [ ] **Step 3: Full local verification:** `npx vitest run` (only the known order-health failures and the load-flaky AFA test may fail), real placeholder-env `next build` exit 0 with the new pages listed.
- [ ] **Step 4: Fresh-reviewer gate** on the whole branch (admin and credential UI; mandatory), most capable model; fix confirmed findings in ONE wave with tests, then one scoped re-review.
- [ ] **Step 5: Merge** per the protocol (fetch, check local main for other sessions' commits, merge origin/main, build, push, watch every recent deploy until READY).
- [ ] **Step 6: Live check (supervised, v2 still dark):** log in as admin, open `/admin/api-keys` (tiles render with zeros and `—`, no NaN), open `/dashboard/developer` (access callout shows "not enabled" while v2 is off), then with the user's OK set v2 enabled for `admin`, generate a **test** standard key from the dashboard, call `GET /account/role` and `/wallet/balance` with curl, see the request appear in the console and Request Logs, then switch v2 back off.
- [ ] **Step 7: Update memory** (`project-api-v2-foundation`: plan 2 shipped, what plan 3 picks up, the revenue/spent tiles waiting on order attribution).
