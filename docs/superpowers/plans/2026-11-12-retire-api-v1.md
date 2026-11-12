# Retire API v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Schedule an automatic v1 shutdown (410 for everyone except allow-listed users) with four kinds of notice, and harden v2 (Postgres limiter fallback, per-key buckets, outage vs bad-key, MTN bulk cap, stuck-order sweeper) so the big v1 customer can move.

**Architecture:** v1 retirement settings live on the single-row `api_v2_config`. A pure state function in `lib/api-v1/retirement.ts` decides, per request, between normal, notice, blocked and exempt. A wrapper `withV1Retirement` around each of the 13 v1 route handlers enforces that decision, reusing a per-request memoised `authenticateApiKey`. The v2 work stays inside `lib/rate-limiter.ts` (an opt-in Postgres fallback), `lib/api-v2/handler.ts`/`store.ts`, the bulk endpoint, and one new report-only cron.

**Tech Stack:** Next.js 15 App Router route handlers, Supabase (service-role client + SQL migrations with `.selftest.sql`), Upstash Redis via `@upstash/ratelimit`, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-retire-api-v1-design.md`

## Global Constraints

- 410 body, exactly: `{ "success": false, "error": "api_v1_retired", "message": "API v1 was retired on <date>. Please move to API v2: https://www.datagod.store/developers" }`
- Docs link everywhere: `https://www.datagod.store/developers`
- Headers once a sunset is set: `Deprecation: true`, `Sunset: <RFC 7231 HTTP-date of v1_sunset_at>`, `Link: <https://www.datagod.store/developers>; rel="successor-version"`
- Body `notice` field: non-exempt users only. Exempt users get headers only, and their bodies stay byte-identical to today.
- Config read failure ⇒ v1 serves as normal (fail-safe), with `console.warn`. Config cache about 60 s.
- Dates: stored as UTC `timestamptz`, shown in Ghana time (UTC+0, label "GMT").
- The Postgres limiter fallback is **opt-in**. v1, USSD and page limiters are unchanged. Redis healthy ⇒ no Postgres call. Both down ⇒ v2 purchase 503 as today.
- Migrations: next free number at execution time (0162/0163 at time of writing; re-check `migrations/`). Each ships with a `.selftest.sql`. Prod apply follows the prod change protocol: assert no COMMIT in the dry run, get owner OK, apply, verify.
- Logs never contain phone numbers, keys or payloads beyond what `logApiRequest` already stores.
- Use the Edit/Write tools for code changes, never sed or shell rewrites.

## Review Focus

1. **Config table unreachable at the cut-off moment.** The big customer must still be served, so state is `normal` and nothing is blocked. Test owned by Task 2.
2. **Exempt user after the sunset.** Response body byte-identical to a pre-retirement response, headers added. Test owned by Task 3.
3. **A v1 handler returns non-JSON or throws** (500 text, empty body). The wrapper must add headers without trying to parse it, and must not turn a 500 into a crash. Test owned by Task 3.
4. **Boundary at exactly `now == v1_sunset_at`.** That is retired. Unauthenticated requests after the sunset still get the old 401, not 410. Test owned by Task 2 and Task 3.
5. **Redis comes back while the fallback is in use.** No Postgres call once Redis answers again, and Postgres buckets of different keys/users never share a counter. Test owned by Task 6.

---

### Task 1: Migration: retirement columns on `api_v2_config`

**Files:**
- Create: `migrations/0162_api_v1_retirement.sql`, `migrations/0162_api_v1_retirement.selftest.sql`

**Interfaces:**
- Produces: columns `api_v2_config.v1_sunset_at timestamptz null`, `v1_exempt_user_ids uuid[] not null default '{}'`, `v1_notice_sent_at timestamptz null`.

- [ ] **Step 1:** Write the migration. It adds the three columns (idempotent `add column if not exists`), keeps the existing RLS (service-role only) and grants unchanged, and ends with `notify pgrst, 'reload schema'`.
- [ ] **Step 2:** Write the selftest following `migrations/0161_*.selftest.sql`. It asserts the columns exist with the stated types and defaults, the existing row has `v1_sunset_at is null` and `v1_exempt_user_ids = '{}'`, and anon can't read the table.
- [ ] **Step 3:** Run the selftest locally with PGlite (see the project's PGlite SQL test setup). Expected: all asserts pass.
- [ ] **Step 4:** Commit: `feat(api-v1): retirement columns on api_v2_config (migration 0162)`.

### Task 2: Retirement state + config loader

**Files:**
- Create: `lib/api-v1/retirement.ts`, `lib/api-v1/retirement.test.ts`

**Interfaces:**
- Produces:
  - `type V1RetirementConfig = { sunsetAt: Date | null; exemptUserIds: string[] }`
  - `type V1RetirementMode = "normal" | "notice" | "blocked" | "exempt"`
  - `v1RetirementState(cfg: V1RetirementConfig | null, userId: string, now: Date): { mode: V1RetirementMode; sunsetAt: Date | null }`
  - `retirementHeaders(sunsetAt: Date): Record<string, string>`
  - `retiredBody(sunsetAt: Date): { success: false; error: "api_v1_retired"; message: string }`
  - `noticeText(sunsetAt: Date): string` (the "will be retired on <date>" sentence)
  - `formatGhanaDate(d: Date): string`, e.g. `"26 Nov 2026, 00:00 GMT"`
  - `getV1RetirementConfig(): Promise<V1RetirementConfig | null>`: service-role read of `api_v2_config`, 60 s module cache, `null` on any error (with `console.warn`)
  - `clearV1RetirementCache(): void`: used by the Task 5 PUT route and by tests

- [ ] **Step 1: Write failing tests.**
  - `cfg null ⇒ mode "normal"` (config unreadable, Review Focus 1)
  - `sunsetAt null ⇒ "normal"`
  - `now < sunsetAt` and user NOT exempt ⇒ `"notice"`
  - user in `exemptUserIds` ⇒ `"exempt"` whenever a sunset is set, before **and** after it (exempt users never get the body `notice` field, per Global Constraints)
  - `now == sunsetAt` and not exempt ⇒ `"blocked"` (Review Focus 4)
  - `retiredBody(new Date("2026-11-26T00:00:00Z")).message === "API v1 was retired on 26 Nov 2026, 00:00 GMT. Please move to API v2: https://www.datagod.store/developers"`
  - `retirementHeaders(d)` gives exactly the three Global Constraints headers, with `Sunset === d.toUTCString()`
  - `getV1RetirementConfig` with a client stub that throws ⇒ `null`. Two calls within 60 s ⇒ one DB read.
- [ ] **Step 2:** Run `npx vitest run lib/api-v1/retirement.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement. `getV1RetirementConfig` accepts an injectable client getter for tests, the same way `lib/api-v2/store.ts` does.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(api-v1): retirement state + cached config loader`.

### Task 3: `withV1Retirement` wrapper on all 13 v1 routes

**Files:**
- Modify: `lib/api-auth.ts` (memoise `authenticateApiKey` per request)
- Create: `lib/api-v1/with-retirement.ts`, `lib/api-v1/with-retirement.test.ts`, `lib/api-v1/routes-gated.test.ts`
- Modify: every `app/api/v1/**/route.ts` (13 files) so each exported method handler is wrapped

**Interfaces:**
- Consumes: Task 2 (`v1RetirementState`, `retirementHeaders`, `retiredBody`, `noticeText`, `getV1RetirementConfig`), `authenticateApiKey`, `logApiRequest`
- Produces: `withV1Retirement(endpoint: string, handler: (req: NextRequest, ctx: any) => Promise<Response>): (req: NextRequest, ctx: any) => Promise<Response>`

Behaviour:
1. `authenticateApiKey(req)` returns null ⇒ call the handler unchanged (it returns its own 401).
2. Otherwise compute the state. `blocked` ⇒ return 410 `retiredBody` plus headers, `logApiRequest` with status 410, and the handler is never called.
3. `notice` ⇒ run the handler, add the headers, and if the response is `application/json` and a plain object, add a top-level `notice`. `exempt` ⇒ headers only, body untouched. `normal` ⇒ response returned as-is.
4. Response not JSON, or JSON that is an array or invalid ⇒ headers only (Review Focus 3).

`authenticateApiKey` memoisation: a module-level `WeakMap<Request, Promise<ApiUser | null>>`, so the wrapper and the handler share one DB lookup.

- [ ] **Step 1: Write failing tests** (`with-retirement.test.ts`, with mocked auth and config):
  - blocked ⇒ status 410, body equals `retiredBody`, handler not called, log called with 410
  - exempt after sunset ⇒ body `JSON.stringify` equal to the handler's original, `Sunset` header present (Review Focus 2)
  - notice ⇒ body has `notice === noticeText(sunsetAt)` plus the original fields
  - unauthenticated after sunset ⇒ the handler's own 401 passes through unchanged (Review Focus 4)
  - handler returns `new Response("boom", { status: 500 })` during notice ⇒ status 500, body `"boom"`, headers present (Review Focus 3)
  - config null ⇒ response identical to the handler's, no headers
- [ ] **Step 2:** Write `routes-gated.test.ts`. It globs `app/api/v1/**/route.ts` and asserts each file imports `withV1Retirement` and that every `export const|function (GET|POST|PUT|PATCH|DELETE)` is produced by `withV1Retirement(`. Expected count is 13 files.
- [ ] **Step 3:** Run `npx vitest run lib/api-v1/with-retirement.test.ts lib/api-v1/routes-gated.test.ts`. Expected: FAIL.
- [ ] **Step 4:** Implement the wrapper and the memoisation. Convert each route's `export async function GET(request)` to `export const GET = withV1Retirement("GET /api/v1/<path>", async (request, ctx) => { ...unchanged body... })`. Route bodies are otherwise untouched.
- [ ] **Step 5:** Run the two test files, then `npx vitest run app/api/v1 lib/api-v1`. Expected: PASS, and existing v1 tests still pass.
- [ ] **Step 6:** Commit: `feat(api-v1): 410 retirement gate + deprecation headers on all v1 routes`.

### Task 4: Block new v1 keys + expose retirement to the user

**Files:**
- Modify: `app/api/user/keys/route.ts` (GET and POST)
- Test: `app/api/user/keys/route.test.ts` (create if absent)

**Interfaces:**
- Consumes: `getV1RetirementConfig`, `formatGhanaDate`
- Produces: GET response gains `retirement: { sunset_at: string | null; exempt: boolean }`. POST while `sunset_at` is set ⇒ `410 { error: "API v1 key creation has ended. v1 will be retired on <date>. Create a v2 key on the Developer page: https://www.datagod.store/developers" }` (exempt users included).

- [ ] **Step 1: Failing tests.** POST with a sunset set ⇒ 410 and no insert or update called. POST with config null ⇒ creates as today. GET includes `retirement` with the right `exempt` flag.
- [ ] **Step 2:** Run `npx vitest run app/api/user/keys`. Expected: FAIL.
- [ ] **Step 3:** Implement. The check runs after auth and before the deactivate-old-keys update, so a refused POST never revokes the user's existing key.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(api-v1): stop v1 key creation once a sunset is scheduled`.

### Task 5: Admin API: retirement settings, stragglers, notify

**Files:**
- Create: `app/api/admin/api-v1/retirement/route.ts` (GET, PUT), `app/api/admin/api-v1/retirement/notify/route.ts` (POST)
- Create: `lib/api-v1/retirement-admin.ts` (pure validation + message builders), `lib/api-v1/retirement-admin.test.ts`

**Interfaces:**
- Consumes: `verifyAdminAccess`, `sendSMS` (`lib/sms-service.ts`), `sendEmail` (`lib/email-service.ts`), `formatGhanaDate`
- Produces:
  - GET ⇒ `{ sunset_at, exempt_users: {id,email,phone,first_name}[], notice_sent_at, stragglers: {user_id,email,last_call,calls_7d,orders_7d,exempt}[] }`. Stragglers come from `user_api_logs` plus `api_orders` (where `api_v2_key_id is null`) over the last 7 days, grouped by user. Use explicit columns only, never `key_hash`.
  - PUT body `{ sunset_at: string | null, exempt_user_ids: string[] }` ⇒ validated by `parseRetirementUpdate(body, now): {ok:true, value} | {ok:false, error}` (ISO date or null, each id a UUID that exists in `users`, max 50 ids). It calls `clearV1RetirementCache()` (Task 2) in this instance.
  - POST notify `{ confirm_resend?: boolean }` ⇒ 409 `{ error: "already_sent", sent_at }` if `v1_notice_sent_at` is set and not `confirm_resend`. Otherwise it sends to every user with an active `user_api_keys` row: non-exempt get `buildNoticeMessage(sunsetAt)`, exempt get `buildExemptMessage(sunsetAt)`. Each goes by SMS when a phone is on file and by email when an email is on file. It sets `v1_notice_sent_at = now()` and returns `{ sms_sent, email_sent, failed }`. Sending happens in batches of 10 with per-recipient try/catch, and a failure never aborts the run.
- `buildNoticeMessage` text: `"Datagod API notice: API v1 will be retired on <date>. After that, v1 requests will be refused. Please move to API v2: https://www.datagod.store/developers"`. `buildExemptMessage`: `"Datagod API notice: API v1 retires for most users on <date>. Your v1 access will keep working for now while you move to API v2: https://www.datagod.store/developers. We'll contact you before it ends."`

- [ ] **Step 1: Failing tests** for `parseRetirementUpdate` (null ok; invalid date ⇒ error; non-UUID ⇒ error; 51 ids ⇒ error) and both message builders (exact strings with a fixed date).
- [ ] **Step 2:** Run `npx vitest run lib/api-v1/retirement-admin.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the lib, then the routes. Non-admin ⇒ the existing 403 pattern from `app/api/admin/api-v2/config/route.ts`.
- [ ] **Step 4:** Run again plus `npx tsc --noEmit -p .` filtered to the new files. Expected: PASS, with no new type errors.
- [ ] **Step 5:** Commit: `feat(admin): v1 retirement settings, straggler list and notify action`.

### Task 6: Postgres fallback for the rate limiter (opt-in)

**Files:**
- Create: `migrations/0163_rate_limit_fallback.sql` + `.selftest.sql`
- Create: `lib/rate-limit-fallback.ts`, `lib/rate-limit-fallback.test.ts`
- Modify: `lib/rate-limiter.ts` (`applyRateLimit` gains an options parameter), `lib/rate-limiter.test.ts` (create if absent)

**Interfaces:**
- Produces:
  - Table `rate_limit_fallback(bucket text, window_start timestamptz, hits int not null, primary key (bucket, window_start))`, RLS on, no anon or authenticated access.
  - RPC `rate_limit_fallback_hit(p_bucket text, p_max int, p_window_seconds int) returns table(allowed boolean, remaining int, reset_at timestamptz)`, `security definer`, executable by service_role only. It does a fixed-window `insert ... on conflict do update set hits = hits + 1 returning hits` in one statement. On roughly 1% of calls (`random() < 0.01`) it deletes rows with `window_start < now() - interval '1 hour'`.
  - `pgFallbackLimit(bucket: string, max: number, windowMs: number): Promise<{ allowed: boolean; remaining: number; resetAt: number } | null>`, which returns null on any error.
  - `applyRateLimit(request, endpointName, maxRequests, windowMs, userId?, opts?: { pgFallback?: boolean })`. When Redis is missing or throws and `opts.pgFallback`, it calls `pgFallbackLimit` with the **same key string** used for Redis (`${endpointName}:${identifier}`). A non-null result ⇒ `{ ...result, degraded: false, fallback: true }`; null ⇒ `degraded: true` as today. Without `opts.pgFallback`, behaviour is identical to today.

- [ ] **Step 1: Failing tests.**
  - Redis throws with `pgFallback` and the stub allows ⇒ `{allowed:true, degraded:false, fallback:true}`
  - stub returns null ⇒ `degraded:true`
  - Redis healthy ⇒ stub never called (Review Focus 5)
  - no `opts` and Redis throws ⇒ stub never called, `degraded:true`
  - the bucket strings for `user:a` and `user:b` differ (Review Focus 5)
  - Selftest: 3 hits with `p_max=2` ⇒ allowed, allowed, denied; a different bucket starts at 1; anon `execute` denied.
- [ ] **Step 2:** Run `npx vitest run lib/rate-limiter.test.ts lib/rate-limit-fallback.test.ts` and the PGlite selftest. Expected: FAIL.
- [ ] **Step 3:** Implement. `pgFallbackLimit` uses the service-role client and is injected into `applyRateLimit` through a module-level setter for tests.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(rate-limit): opt-in Postgres fallback when Redis is unavailable (migration 0163)`.

### Task 7: v2 handler: fallback, per-key bucket for non-active keys, outage vs bad key

**Files:**
- Modify: `lib/api-v2/store.ts` (`findKeyByHash`), `lib/api-v2/handler.ts`, `lib/api-v2/handler.test.ts`, `lib/api-v2/store.test.ts`

**Interfaces:**
- Consumes: Task 6 `applyRateLimit(..., opts)`
- Produces:
  - `findKeyByHash(client, hash): Promise<V2KeyRow | null | "error">`. A DB error or exception ⇒ `"error"`; no row ⇒ `null`.
  - `V2Deps.store.findKeyByHash` has the same return type. `V2Deps.rateLimit` gains the optional 6th param `opts?: { pgFallback?: boolean }`.
  - Handler: `"error"` ⇒ `fail(503, MSG_UNAVAILABLE)`, never 401. The rate-limit identifier is `row.user_id` when `row.status === "active"`, else `` `key-${row.id}` ``. Routes with `failClosedWhenLimiterDegraded` pass `{ pgFallback: true }`, and the existing degraded ⇒ 503 line stays for the both-down case.

- [ ] **Step 1: Failing tests.**
  - store error ⇒ 503 envelope with `MSG_UNAVAILABLE`
  - unknown key ⇒ 401 as today
  - revoked key ⇒ `rateLimit` called with userId `key-<id>`; active key ⇒ with `row.user_id`
  - purchase route ⇒ `rateLimit` called with `{pgFallback:true}`; read route ⇒ without it
  - rateLimit returns `{allowed:true, degraded:false, fallback:true}` on a purchase ⇒ the handler runs
  - rateLimit returns `degraded:true` on a purchase ⇒ 503
- [ ] **Step 2:** Run `npx vitest run lib/api-v2/handler.test.ts lib/api-v2/store.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Update every other `findKeyByHash` caller (grep for it) to treat `"error"` as a non-match where it isn't the request path.
- [ ] **Step 4:** Run `npx vitest run lib/api-v2 app/api/v2`. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(api-v2): Postgres limiter fallback for purchases, per-key bucket for inactive keys, 503 on key-store outage`.

### Task 8: MTN bulk cap

**Files:**
- Modify: `lib/api-v2/endpoints/data.ts` (live and sandbox bulk paths), `lib/api-v2/endpoints/data.test.ts`, `lib/api-v2/docs/registry.ts` (bulk docs text)

**Interfaces:**
- Produces: `export const MAX_NEW_MTN_PER_BULK = 20`. After replay/conflict classification (step 2 of `liveBulk`), if more than 20 **new** items have `network === "MTN"`, the whole batch is rejected with `400 "A bulk call can include at most 20 new MTN orders; split the batch"` before any validation, charge or whitelist call. Replayed items don't count.

- [ ] **Step 1: Failing tests.**
  - 21 new MTN items ⇒ 400 with that message, and no RPC or whitelist call
  - 20 new MTN + 30 Telecel ⇒ proceeds
  - 25 MTN where 10 are replays ⇒ proceeds
  - sandbox applies the same cap
- [ ] **Step 2:** Run `npx vitest run lib/api-v2/endpoints/data.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, and add one line to the bulk docs in `registry.ts`. Run `npx vitest run lib/api-v2/docs` for the drift test.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(api-v2): cap new MTN items per bulk call at 20`.

### Task 9: Stuck v2 orders/claims: report-only cron + admin list

**Files:**
- Create: `lib/api-v2/stuck.ts`, `lib/api-v2/stuck.test.ts`, `app/api/cron/api-v2-stuck/route.ts`, `app/api/admin/api-v2/stuck/route.ts`
- Modify: the cron registry consumed by `scripts/sync-cronjob-org.ts` (add `/api/cron/api-v2-stuck`, every 10 min)

**Interfaces:**
- Produces:
  - `findStuckV2(client, now: Date): Promise<{ claims: StuckClaim[]; orders: StuckOrder[] }>`. Claims are `api_v2_idempotency` rows with `status <> 'done'` and `created_at < now - 10 min` (fields: id, user_id, kind, reference, status, created_at). Orders are `api_orders` rows with `api_v2_key_id is not null`, `status in ('pending','processing')` and `created_at < now - 10 min` (fields: id, user_id, network, api_reference, status, created_at). Each list is capped at 200.
  - The cron (`backgroundCron("api-v2-stuck", …)`) calls `findStuckV2`. When either list is non-empty and differs from the last alert (dedupe on the sorted id set via an `app_settings` key `api_v2_stuck_last_ids`), it sends one admin alert through the existing admin notifier with counts and the oldest age. **It never changes rows.**
  - Admin GET `/api/admin/api-v2/stuck` ⇒ the `findStuckV2` result for a "Stuck v2" panel (rendered in Task 10).

- [ ] **Step 1: Failing tests** for `findStuckV2` with a fake client: 9-minute-old ⇒ excluded, 11-minute-old ⇒ included, `done` ⇒ excluded, v1 order (`api_v2_key_id null`) ⇒ excluded. Also the dedupe helper `shouldAlert(prevIds: string[], ids: string[]): boolean` (same set ⇒ false, empty ⇒ false).
- [ ] **Step 2:** Run `npx vitest run lib/api-v2/stuck.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the lib, cron route and admin route, and add the registry entry.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(api-v2): report-only stuck order/claim sweeper + admin endpoint`.

### Task 10: UI: admin retirement card, stuck panel, developer banner

**Files:**
- Create: `components/admin/api-keys/V1RetirementCard.tsx`, `components/admin/api-keys/StuckV2Panel.tsx`, `components/developer/V1RetirementBanner.tsx`
- Modify: `components/admin/api-keys/ConsoleView.tsx` (mount both admin pieces near `V1Controls`), `app/dashboard/developer/page.tsx` and `components/developer/LegacyV1Section.tsx` (banner, date, hide the "create v1 key" control when `retirement.sunset_at` is set)

**Interfaces:**
- Consumes: Task 5 admin API, Task 9 stuck API, Task 4 `retirement` field on `/api/user/keys`.

Admin card:
- date-time picker shown in GMT
- an "earlier than 14 days" confirm, using the existing `ConfirmAction`
- exempt-user search and add/remove
- a straggler table
- a "Notify v1 users" button, with a resend confirm on 409
- a "Clear date (undo)" button

Developer banner (only for users with an active v1 key and a sunset set):
- Non-exempt: "API v1 will be retired on <date>. After that your v1 requests will be refused. Create a v2 key below and follow the v2 docs." with a link to `/developers`.
- Exempt: "API v1 retires on <date>. Your access continues for now; please plan your move to v2."

Layout rules from project feedback:
- navy `--primary` accents
- the `lg:` multi-column layout on desktop
- check by screenshot at 500 px and desktop width

- [ ] **Step 1:** Build the components using `admin-fetch.ts` and the console's `ui.tsx` primitives.
- [ ] **Step 2:** Run `npx tsc --noEmit -p .`. Expected: no new errors (the baseline is 21 pre-existing errors in two unrelated test files).
- [ ] **Step 3:** Take headless screenshots of `/admin/api-keys` and `/dashboard/developer` at 500 px and 1280 px (see the headless screenshot reference), with a mocked sunset. Expected: the banner and card render, with no horizontal scroll.
- [ ] **Step 4:** Commit: `feat(ui): v1 retirement admin card, stuck v2 panel, developer banner`.

### Task 11: Ship + live verification (no product code)

- [ ] **Step 1:** Run the full `npx vitest run`. Expected: only the known pre-existing failures (9 order-health, `pricing/migration` 0142 drift, `standard-bundles/runtime` cashback).
- [ ] **Step 2:** Do a real build with placeholder env (`NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder SUPABASE_SERVICE_ROLE_KEY=placeholder npm run build`). Expected: "Generating static pages (N/N)", exit 0.
- [ ] **Step 3:** Get a fresh reviewer on the whole branch (money, auth and gate changes). Fix verified findings with failing tests first.
- [ ] **Step 4:** Apply migrations 0162 and 0163 to prod via the protocol (assert no COMMIT in the dry run, owner OK, apply, verify columns, RPC grants, anon denied).
- [ ] **Step 5:** Merge to main after `git fetch` and checking local main for other sessions' commits. Push, and watch the deployment until READY.
- [ ] **Step 6:** Live checks with `v1_sunset_at` still null:
  - a v1 key call is unchanged (no `Sunset` header)
  - v2 purchase without a key ⇒ 401
  - v2 call with a garbage `dg2_` key ⇒ 401, not 503
  - the cron route answers 401 without the secret
  - the admin card loads
- [ ] **Step 7:** Hand the owner the rollout runbook (spec "Rollout" steps 3–6). The owner, or the assistant with the owner's OK, then sets the exempt user and a date 14 days out, sends the notice, and the assistant writes the WhatsApp channel post.
