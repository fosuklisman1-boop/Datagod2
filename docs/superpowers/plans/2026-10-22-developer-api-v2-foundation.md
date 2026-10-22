# Developer API v2 — Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v2 key system and request pipeline (three key types, approval, envelope, numeric errors, grouped rate limits, global switch, allowed roles), proven end to end by two real endpoints (`GET /api/v2/account/role`, `GET /api/v2/wallet/balance`).

**Architecture:** A new `lib/api-v2/` module of small pure units (key format, envelope, limits, access decision, lifecycle) plus a thin Supabase store (client injected so tests use a fake) and a `withV2` route wrapper that authenticates, gates by key type/status/role/global switch, rate-limits, logs and wraps responses in the v2 envelope. v2 keys live in a **new table** (`api_v2_keys`); v1's table, index and routes are not touched except that the existing global-kill also revokes v2 keys.

**Tech Stack:** Next.js 15 App Router route handlers, Supabase (service role, RLS locked), Vitest (`lib/**/*.test.ts`, `app/**/*.test.ts`), existing `applyRateLimit`, `verifyAdminAccess`, `lib/sandbox.ts`.

**Spec:** `docs/superpowers/specs/2026-10-22-developer-api-v2-design.md`

**This is plan 1 of a series.** Each later plan is written when reached, against this plan's Interfaces: (2) admin console UI + overview stats endpoint; (3) data/wallet/orders endpoints; (4) airtime + utility bills; (5) results checker + AFA; (6) SMS (incl. SMS-key eligibility); (7) public `/developers` page, code samples, Postman collection; (8) `api.datagod.store` host rewrite in `middleware.ts`.

## Global Constraints

- v1 behaviour unchanged: do not edit `lib/api-auth.ts`, `user_api_keys`, its unique index, or any `app/api/v1/**` file.
- Envelope: success `{ success: true, data, meta: { timestamp, version } }`; error `{ success: false, error: { code: <number>, message } }`. `version` is `"2"`.
- Error codes are HTTP statuses: 400, 401, 402, 403, 404, 409, 429, 500, 502, 503.
- Key prefixes (changed from the spec's first draft, see Task 2 note): `dg2_live_` / `dg2_test_` (standard), `dg2_cs_live_` / `dg2_cs_test_` (commission), `dg2_sms_live_` / `dg2_sms_test_` (SMS). Stored hashed with SHA-256 (reuse `hashApiKey`); full key shown once.
- Auth header accepted: `Authorization: <key>`, `Authorization: Bearer <key>`, or `X-API-Key: <key>`.
- A wrong key type for an endpoint returns 403. Pending or revoked keys return 403. v2 disabled returns 503. Role not in the allowed list returns 403.
- Live keys start `pending` (admin must approve); test (sandbox) keys start `active` (my call, no money at risk). One non-revoked key per user per (key type, environment). Revoked is terminal.
- Rate-limit groups: `purchase`, `bulk`, `balance`, `status`; defaults purchase 10, bulk 3, balance 30, status 30 per minute; per-key overrides are integers 1–10000.
- Request logs store no request/response payloads, no key material, no phone numbers.
- Ships dark: `api_v2_config.enabled` defaults false and `allowed_roles` defaults to `{admin}`.
- Tables are service-role only: RLS on, `REVOKE ALL ... FROM authenticated, anon`.
- Edit code with the Edit/Write tools, never `sed`. Run a real `next build` before pushing main. Money/auth/schema work needs a fresh-eyes review before merge. Applying the migration follows the prod change protocol (Task 11).

## Review Focus

- A v1 key (`dg_live_...`) sent to a v2 endpoint gets 401, never authenticates (test in Task 8).
- Auth header oddities: empty value, whitespace-only, `Bearer` with nothing after it, key with surrounding spaces, both headers present, a 10 KB header; none may crash or authenticate (Task 5).
- Two simultaneous "generate" requests for the same user/type/environment must leave exactly one non-revoked key, and the loser gets a clean 409, not a 500 (Task 7).
- Revoked or pending keys, v2 disabled and a disallowed role are denied for test keys too (Task 5).
- Global kill must also revoke v2 keys, and a revoked key can never be approved again (Tasks 6 and 10).
- Redis not configured (`applyRateLimit` returns `degraded: true`, fail open): fine for read-only endpoints here, but later money plans must add a fallback cap (note carried in Task 8).
- Logs must not contain the key, its hash, or request bodies (Task 7).

---

### Task 1: Migration `api_v2_keys`, `api_v2_logs`, `api_v2_config`

**Files:**
- Create: `migrations/0128_api_v2_foundation.sql` (use the next free `01xx` number at execution time; `0127` is the latest now)

**Interfaces:**
- Produces: tables used by Task 7 (names and columns are the contract).

- [ ] **Step 1: Write the migration** with these objects, idempotent (`IF NOT EXISTS`):
  - `public.api_v2_keys`: `id uuid pk default gen_random_uuid()`, `user_id uuid not null references auth.users(id) on delete cascade`, `key_type text not null check (key_type in ('standard','commission','sms'))`, `environment text not null check (environment in ('test','live'))`, `status text not null default 'pending' check (status in ('pending','active','revoked'))`, `name text not null`, `key_hash text not null unique`, `key_prefix text not null`, `rate_limits jsonb` (null = defaults; shape `{purchase?,bulk?,balance?,status?}`), `last_used_at timestamptz`, `approved_at timestamptz`, `approved_by uuid`, `revoked_at timestamptz`, `revoked_by uuid`, `created_at`/`updated_at timestamptz default now()`.
  - Partial unique index `api_v2_keys_one_live_per_type` on `(user_id, key_type, environment) where status in ('pending','active')`. Index on `(status)` and `(user_id)`.
  - `public.api_v2_logs`: `id uuid pk`, `key_id uuid references api_v2_keys(id) on delete set null`, `user_id uuid`, `method text`, `endpoint text`, `status_code int`, `error_code int`, `ip_address text`, `duration_ms int`, `environment text`, `created_at timestamptz default now()`; index `(created_at)` and `(key_id, created_at)`.
  - `public.api_v2_config`: single row, `id boolean primary key default true check (id)`, `enabled boolean not null default false`, `allowed_roles text[] not null default '{admin}'`, `updated_at`, `updated_by uuid`; insert the one row (`on conflict do nothing`). A dedicated table, not `app_settings` (that table already had a singleton-vs-key-value collision).
  - `ENABLE ROW LEVEL SECURITY` and `REVOKE ALL ... FROM authenticated, anon` on all three, mirroring `migrations/20260929_api_sandbox_keys.sql`.
- [ ] **Step 2: Do not apply it.** Applying happens in Task 11.
- [ ] **Step 3: Commit** `git add migrations/0128_api_v2_foundation.sql && git commit -m "feat(api-v2): schema for keys, logs, config"`

---

### Task 2: Key format (`lib/api-v2/keys.ts`)

**Files:**
- Create: `lib/api-v2/keys.ts`
- Test: `lib/api-v2/keys.test.ts`

**Interfaces:**
- Produces: `type KeyType = "standard" | "commission" | "sms"`; `type Environment = "test" | "live"`; `generateV2Key(type: KeyType, env: Environment): { key: string; prefix: string; hash: string }`; `parseV2Key(raw: string): { type: KeyType; env: Environment } | null`; `hashV2Key(key: string): string`.
- Note: the spec's first draft proposed `dg_live_` for standard keys. That prefix is already used by v1 keys, which would make v1 and v2 keys indistinguishable in support and in the admin badge, so v2 uses `dg2_`.

- [ ] **Step 1: Write failing tests** in `keys.test.ts`:
  - `generateV2Key("standard","live").key` starts with `dg2_live_`; commission/live starts `dg2_cs_live_`; sms/test starts `dg2_sms_test_`.
  - `parseV2Key(generateV2Key(t,e).key)` returns `{type:t, env:e}` for all six combinations.
  - `parseV2Key("dg_live_abc")` (a v1 key), `""`, `"dg2_live_"` (no body), `"dg2_cs_live_x y"` (space) all return `null`.
  - `hash` equals `hashV2Key(key)`; two generated keys differ; `prefix` is the first 16 chars of the key.
- [ ] **Step 2: Run** `npx vitest run lib/api-v2/keys.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** with `crypto.randomBytes(32).toString("hex")` for the body and SHA-256 hashing (reuse `hashApiKey` from `lib/api-auth.ts` by import so the algorithm stays single-sourced). `parseV2Key` requires a non-empty `[0-9a-f]+` body.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Commit** `feat(api-v2): key generation and parsing`

---

### Task 3: Envelope and errors (`lib/api-v2/envelope.ts`)

**Files:**
- Create: `lib/api-v2/envelope.ts`
- Test: `lib/api-v2/envelope.test.ts`

**Interfaces:**
- Produces: `API_VERSION = "2"`; `type V2ErrorStatus = 400|401|402|403|404|409|429|500|502|503`; `successBody<T>(data: T, now?: Date): { success: true; data: T; meta: { timestamp: string; version: string } }`; `errorBody(status: V2ErrorStatus, message: string): { success: false; error: { code: number; message: string } }`; `v2Response(status: number, body: object): NextResponse` (JSON, `Cache-Control: no-store`).

- [ ] **Step 1: Write failing tests:** `successBody({a:1}, new Date("2026-10-22T10:00:00Z"))` equals `{success:true, data:{a:1}, meta:{timestamp:"2026-10-22T10:00:00.000Z", version:"2"}}`; `errorBody(403,"Wrong key type")` equals `{success:false, error:{code:403, message:"Wrong key type"}}`; `errorBody(500, ...)` never includes a `stack` or extra field (assert exact keys).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(api-v2): response envelope`

---

### Task 4: Rate-limit groups (`lib/api-v2/limits.ts`)

**Files:**
- Create: `lib/api-v2/limits.ts`
- Test: `lib/api-v2/limits.test.ts`

**Interfaces:**
- Produces: `type LimitGroup = "purchase"|"bulk"|"balance"|"status"`; `DEFAULT_LIMITS: Record<LimitGroup, number>` (10, 3, 30, 30); `resolveLimit(group: LimitGroup, overrides: unknown): number`; `parseLimitOverrides(input: unknown): { ok: true; value: Partial<Record<LimitGroup, number>> } | { ok: false; error: string }`.

- [ ] **Step 1: Write failing tests:** `resolveLimit("purchase", null)` is 10; `resolveLimit("purchase", {purchase: 25})` is 25; a corrupt override (`{purchase: -1}`, `{purchase: "x"}`, `{purchase: 1.5}`) falls back to the default; `parseLimitOverrides({bulk: 0})` fails, `({bulk: 10001})` fails, `({bulk: 5})` ok, `({foo: 5})` fails (unknown group), `({})` ok and empty.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS). **Step 5: Commit** `feat(api-v2): per-group rate limits`

---

### Task 5: Access decision and header parsing (`lib/api-v2/access.ts`)

**Files:**
- Create: `lib/api-v2/access.ts`
- Test: `lib/api-v2/access.test.ts`

**Interfaces:**
- Consumes: `KeyType`, `Environment`, `parseV2Key` (Task 2).
- Produces: `extractKey(headers: { get(name: string): string | null }): string | null`; `interface AccessInput { keyStatus: "pending"|"active"|"revoked"; keyType: KeyType; requiredType: KeyType; configEnabled: boolean; allowedRoles: string[]; userRole: string }`; `decideAccess(i: AccessInput): { ok: true } | { ok: false; status: 403 | 503; message: string }`.

- [ ] **Step 1: Write failing tests** for `extractKey`: `Authorization: dg2_live_ab12` returns the key; `Bearer dg2_live_ab12` returns it; `X-API-Key` returns it; surrounding spaces trimmed; empty, whitespace-only, `Bearer ` with nothing, and a value over 512 chars all return `null`; when both headers are present, `Authorization` wins.
- [ ] **Step 2: Write failing tests** for `decideAccess`, one case each: config disabled returns 503 (checked first, even for an active key of the right type); `pending` returns 403; `revoked` returns 403; `keyType !== requiredType` returns 403 with a message naming the required type; role not in `allowedRoles` returns 403; all good returns `{ok:true}`. Environment is not an input (test keys are gated identically).
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement** (pure, no I/O). **Step 5: Run** — PASS.
- [ ] **Step 6: Commit** `feat(api-v2): access decision`

---

### Task 6: Lifecycle rules (`lib/api-v2/lifecycle.ts`)

**Files:**
- Create: `lib/api-v2/lifecycle.ts`
- Test: `lib/api-v2/lifecycle.test.ts`

**Interfaces:**
- Produces: `initialStatus(env: Environment): "pending" | "active"`; `type KeyAction = "approve" | "revoke"`; `applyAction(from: KeyStatus, action: KeyAction): { ok: true; to: KeyStatus } | { ok: false; error: string }`; `V2_ROLES: readonly string[]` (the role values the platform uses, confirmed in Task 11 step 1); `parseConfigUpdate(input: unknown): { ok: true; value: { enabled?: boolean; allowed_roles?: string[] } } | { ok: false; error: string }`.

- [ ] **Step 1: Write failing tests:** `initialStatus("live")` is `pending`, `("test")` is `active`; `applyAction("pending","approve")` gives `active`; `("active","revoke")` and `("pending","revoke")` give `revoked`; `("revoked","approve")` fails; `("revoked","revoke")` fails; `("active","approve")` fails. `parseConfigUpdate({enabled:true})` ok; `({allowed_roles:["dealer","nope"]})` fails (unknown role); `({allowed_roles:[]})` ok (empty means nobody); `({enabled:"yes"})` fails; `({})` fails (nothing to update).
- [ ] **Step 2–4:** FAIL, implement, PASS. **Step 5: Commit** `feat(api-v2): key lifecycle and config validation`

---

### Task 7: Store (`lib/api-v2/store.ts`)

**Files:**
- Create: `lib/api-v2/store.ts`
- Test: `lib/api-v2/store.test.ts` (fake client, the repo's existing pattern; see `reference-testing`)

**Interfaces:**
- Consumes: Tasks 2, 4, 6 types; table names from Task 1.
- Produces (all take `client: SupabaseLike` as first parameter so tests inject a fake; a `getAdminClient()` factory builds the real service-role client):
  - `findKeyByHash(client, hash): Promise<V2KeyRow | null>` (returns the row incl. `rate_limits`)
  - `getUserForKey(client, userId): Promise<{ id: string; role: string; first_name: string | null; email: string | null } | null>`
  - `getConfig(client): Promise<{ enabled: boolean; allowed_roles: string[] }>` (on any read failure return `{enabled:false, allowed_roles:[]}`: fail closed)
  - `createKey(client, p: { userId; type; env; name }): Promise<{ ok: true; key: string; row: V2KeyRow } | { ok: false; status: 409 | 500 }>`: revokes the user's existing pending/active key for that (type, env), inserts the new key with `initialStatus(env)`; a unique-violation (`23505`) from a concurrent request yields `{ok:false,status:409}`.
  - `touchLastUsed(client, keyId): Promise<void>` (never throws)
  - `logRequest(client, p: { keyId; userId; method; endpoint; statusCode; errorCode?; ip; durationMs; environment }): Promise<void>` (never throws; no payload, key or phone fields exist on its parameter type)
  - `revokeAllV2Keys(client): Promise<number>`

- [ ] **Step 1: Write failing tests** with a hand-rolled fake: `getConfig` returns `{enabled:false, allowed_roles:[]}` when the fake errors; `createKey` revokes the prior active key before insert (assert the fake saw an update setting `status:"revoked"` for that user/type/env first); `createKey` returns `{ok:false,status:409}` when the fake insert errors with code `23505`; the stored row has `key_hash` equal to `hashV2Key(key)` and the returned `row` has no `key_hash` field; `logRequest`'s row contains none of `key`, `key_hash`, `body`, `payload`, `phone` (assert the exact column set); `touchLastUsed` swallows a fake error.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(api-v2): store`

---

### Task 8: Route wrapper (`lib/api-v2/handler.ts`) and the two endpoints

**Files:**
- Create: `lib/api-v2/handler.ts`
- Create: `lib/api-v2/endpoints/account.ts` (pure mappers)
- Create: `app/api/v2/account/role/route.ts`
- Create: `app/api/v2/wallet/balance/route.ts`
- Test: `lib/api-v2/handler.test.ts`, `lib/api-v2/endpoints/account.test.ts`

**Interfaces:**
- Consumes: Tasks 2–7.
- Produces: `interface V2Context { keyId: string; userId: string; role: string; keyType: KeyType; environment: Environment; firstName: string | null }`; `withV2(opts: { requiredType: KeyType; group: LimitGroup; endpoint: string }, handler: (req: NextRequest, ctx: V2Context) => Promise<{ status: number; data?: unknown; error?: { status: V2ErrorStatus; message: string } }>): (req: NextRequest) => Promise<NextResponse>`. Core logic is `runV2(deps, opts, handler, input)` taking injected `{ store, rateLimit, now }` so the test needs no network.
- Order inside the wrapper: extract key (none → 401) → `parseV2Key` (null → 401, so a v1 key never reaches the DB) → `findKeyByHash` (none → 401) → load user and config → `decideAccess` (403/503) → `applyRateLimit(request, \`v2_${keyType}_${group}\`, resolveLimit(group, row.rate_limits), 60000, userId)` (denied → 429) → handler → log (fire and forget, `touchLastUsed` too) → envelope. A thrown handler error returns 500 with a generic message; nothing from the exception reaches the body.
- Note for later plans: when `applyRateLimit` reports `degraded: true` the wrapper currently lets the request through; purchase endpoints in plans 3–6 must add their own fallback cap.

- [ ] **Step 1: Write failing tests** on `runV2` with fakes: no header gives 401 envelope; a v1-style key `dg_live_abc...` gives 401 and the fake store's `findKeyByHash` is never called; unknown hash gives 401; pending key gives 403; standard key on a `commission` endpoint gives 403; config disabled gives 503; role not allowed gives 403; rate limiter denying gives 429 with `error.code` 429; handler throwing gives 500 whose JSON contains no part of the thrown message; a happy path returns `{success:true,data,meta}` and calls `logRequest` once with the key id and no payload fields; a test-environment key passes `environment:"test"` to the handler.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** `runV2` then `withV2`. **Step 4: Run** — PASS.
- [ ] **Step 5: Write failing tests** for the pure mappers in `endpoints/account.ts`: `mapRole({role:"dealer"}, ctx)` returns `{ role: "dealer", key_type: "standard", environment: "live" }`; `mapBalance({balance: 12.345, total_credited: 20, total_spent: 7.655})` returns `{ balance: 12.35, total_credited: 20, total_spent: 7.66, currency: "GHS" }` (2dp rounding); `mapBalance(null)` returns `null` (the route turns that into a 500).
- [ ] **Step 6: Implement** the mappers and both routes. `account/role` needs nothing beyond the wrapper's context. `wallet/balance`: test environment reads `getSandboxBalance(ctx.userId)` and returns `{ balance, currency: "GHS", sandbox: true }`; live reads `wallets` (`balance, total_credited, total_spent`) exactly as `app/api/v1/balance/route.ts` does. Both use `requiredType: "standard"`; role uses group `status`, balance uses group `balance`. Set `export const dynamic = "force-dynamic"`.
- [ ] **Step 7: Run** `npx vitest run lib/api-v2` — all PASS.
- [ ] **Step 8: Commit** `feat(api-v2): request wrapper, account/role and wallet/balance`

---

### Task 9: Developer key routes (`app/api/user/v2-keys/route.ts`)

**Files:**
- Create: `app/api/user/v2-keys/route.ts`
- Create: `lib/api-v2/key-issue.ts`
- Test: `lib/api-v2/key-issue.test.ts`

**Interfaces:**
- Consumes: `createKey`, `getConfig`, `KeyType`, `Environment` (Tasks 2, 7).
- Produces: `canIssue(input: { type: KeyType; role: string; allowedRoles: string[] }): { ok: true } | { ok: false; status: 400 | 403; message: string }` — `sms` returns 400 "SMS keys are not available yet" until plan 6 replaces this branch.
- Behaviour (mirrors `app/api/user/keys/route.ts`: session bearer token via `supabase.auth.getUser`, same two rate limits): `GET` lists the caller's non-revoked v2 keys (`id, key_type, environment, status, key_prefix, last_used_at, created_at`); `POST { key_type, environment }` validates both, checks `canIssue` against `getConfig().allowed_roles` and the caller's role, calls `createKey`, returns the full key once with status 201 (`409` from `createKey` passes through); `DELETE ?id=` revokes only the caller's own key (filter on `user_id`).

- [ ] **Step 1: Write failing tests** for `canIssue`: role in allowed list and `standard` ok; role not in list gives 403; `sms` gives 400; unknown type gives 400.
- [ ] **Step 2–4:** FAIL, implement `canIssue` then the route, PASS.
- [ ] **Step 5: Commit** `feat(api-v2): developer key issue routes`

---

### Task 10: Admin routes and global kill

**Files:**
- Create: `app/api/admin/api-v2/keys/route.ts` (GET list)
- Create: `app/api/admin/api-v2/keys/[id]/route.ts` (PATCH)
- Create: `app/api/admin/api-v2/config/route.ts` (GET, PUT)
- Create: `lib/api-v2/admin-actions.ts`
- Modify: `app/api/admin/api-keys/global-kill/route.ts` (also call `revokeAllV2Keys`)
- Test: `lib/api-v2/admin-actions.test.ts`

**Interfaces:**
- Consumes: `applyAction`, `parseConfigUpdate`, `parseLimitOverrides`, `DEFAULT_LIMITS` (Tasks 4, 6).
- Produces: `planKeyPatch(current: { status: KeyStatus }, body: unknown, now: Date): { ok: true; update: Record<string, unknown> } | { ok: false; status: 400 | 409; error: string }` handling `{ action: "approve" | "revoke" }`, `{ action: "set_limits", limits }` (via `parseLimitOverrides`), `{ action: "reset_limits" }` (sets `rate_limits` null). `approve` stamps `approved_at`; `revoke` stamps `revoked_at`; the route adds `approved_by`/`revoked_by` from `verifyAdminAccess().userId`. `set_limits`/`reset_limits` on a revoked key return 409.
- All admin routes start with `verifyAdminAccess` and return its `errorResponse` when not admin. GET list returns keys with owner (`first_name, last_name, email, role`) enriched by one `users` lookup, never including `key_hash`, filterable by `status` and `type` query params.

- [ ] **Step 1: Write failing tests** for `planKeyPatch`: approve on pending gives update `{status:"active", approved_at: <iso>}`; approve on revoked gives 409; `set_limits {limits:{purchase:20}}` on active gives `rate_limits:{purchase:20}`; `set_limits` with `{purchase:0}` gives 400; `set_limits` on revoked gives 409; `reset_limits` gives `rate_limits:null`; unknown action gives 400; non-object body gives 400. `now` is passed in so the timestamps are asserted exactly.
- [ ] **Step 2–4:** FAIL, implement `planKeyPatch`, then the three route files, PASS.
- [ ] **Step 5: Edit** `global-kill/route.ts` so after the v1 update succeeds it calls `revokeAllV2Keys(supabase)` and the success message mentions both; a failure of the v2 revoke returns 500 so an admin never believes the kill fully worked when it did not.
- [ ] **Step 6: Commit** `feat(api-v2): admin key approval, limits, config and global kill`

---

### Task 11: Apply, verify, review, build

**Files:** none new.

- [ ] **Step 1: Precheck (read-only, per the prod change protocol).** Via the Supabase Management API SQL fallback (`reference-supabase-access`): `SELECT DISTINCT role FROM users;` and confirm `V2_ROLES` in `lib/api-v2/lifecycle.ts` matches (fix the constant and its test if not); `SELECT to_regclass('public.api_v2_keys')` is null; check whether `users` has an account-suspension column (`information_schema.columns`); if one exists, add it to `AccessInput`/`decideAccess` with its own test and a 403, and select it in `getUserForKey`.
- [ ] **Step 2: Dry run** the migration inside a transaction that ends in `RAISE EXCEPTION` (self-rolling-back) and confirm it parses and every object is created. Show the user the result and wait for their OK.
- [ ] **Step 3: Apply** `migrations/0128_api_v2_foundation.sql`, then verify: three tables exist, `api_v2_config` has exactly one row with `enabled=false, allowed_roles={admin}`, and an `anon`-key REST read of `api_v2_keys` is denied (see `reference-supabase-access` for the anon reproduction).
- [ ] **Step 4: Full tests and build:** `npx vitest run` (expect only the 9 already-known order-health failures, nothing new) and a real placeholder-env `next build` (see `feedback-run-next-build-before-pushing-main`).
- [ ] **Step 5: Live check** (after deploy, with the user's OK): via the admin config route set `enabled=true, allowed_roles={admin}`; as the owner generate a **test** standard key; with curl confirm `GET .../api/v2/account/role` and `/wallet/balance` return the envelope, a v1 `dg_live_` key returns 401, and after the global kill the key returns 403. Then set `enabled` back to false and confirm 503.
- [ ] **Step 6: Fresh-reviewer gate.** Dispatch a fresh reviewer on the whole branch (this touches auth, keys and schema, so it is mandatory); fix confirmed findings with failing tests first.
- [ ] **Step 7: Update memory** (`project-api-v2-foundation`, and the MEMORY.md index line) with what shipped and what plan 2 picks up.
