# Phone-number Login (Phase 1) Implementation Plan

Note: migration renumbered 0201 → 0202 → 0203 on 2026-11-27 (clashes with 0201_ai_voice_calls and 0202_ai_voice_calls_nuance_key); already applied to prod.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers sign in on the web with phone number + existing password. An untrusted device also needs a
6-digit SMS code sent to the account's registered number, and the device is then trusted for 30 days.

**Architecture:** All logic lives in `lib/phone-login/` as dependency-injected functions (pure helpers → DB store →
Supabase session helpers → flow orchestrators), unit-tested with fakes. Three thin routes under
`/api/auth/phone-login` handle cookies, IP rate limits and `no-store`. One migration adds the tables, an indexed
normalized-phone lookup RPC, revoke-all triggers and the two settings. The feature ships dark
(`phone_login_enabled=false`).

**Tech Stack:** Next.js 15 App Router, Supabase (`@supabase/supabase-js` admin + anon, `@supabase/ssr` browser
client), Postgres 17, Vitest 4, PGlite for migration self-tests, Upstash rate limiter (`lib/rate-limiter.ts`).

**Spec:** `docs/superpowers/specs/2026-11-27-phone-login-design.md` (approved 2026-11-27). Read it before Task 1.

**Worktree:** `B:/worktrees/dg-phone-login`, branch `feat/phone-login`. Run vitest with the uppercase drive path
(`B:/…`). Code edits use Edit/Write only, **never sed** (tell subagents this too).

## Global Constraints

- Every failure in step 1 returns **the same body, status and timing class**: HTTP 401,
  `{ "error": "Phone number or password is incorrect." }`. That covers unknown number, not eligible, wrong
  password, locked, and shared number. Failures after the password has been accepted (wrong code, expired) may differ.
- No session or refresh token in any response before the code is accepted on an untrusted device.
- The OTP always goes to `normalizeGhanaPhone(users.phone_number)` read server-side, never to request input.
- No phone numbers, codes, passwords, tokens or emails in logs. Log hashes or ids only.
- OTP purpose string: `phone_login`.
- Limits:
  - step 1: per IP 10 / 15 min
  - per phone: 5 failures / 15 min → locked 15 min
  - verify: per IP 10 / 15 min
  - wrong codes per challenge: 5
  - challenge TTL: 10 min
  - resend gap: 60 s
  - sends: 3 / hour / phone (existing core)
- Trusted device: 256-bit random token, SHA-256 stored, 30 days **hard** expiry (not sliding), max 10 active per
  user (oldest revoked).
- Cookies:
  - `dg_device`: httpOnly, Secure, SameSite=Lax, Path=/, Max-Age 2592000
  - `dg_plc`: same flags, Max-Age 600
- Settings (key/value table `admin_settings`, not `app_settings`): `phone_login_enabled` default `false`,
  `phone_login_new_device_code` default `true`.
- SMS copy (exact): `Datagod sign-in code: {code}. Someone is signing in to your account on a new device. If this isn't you, don't share this code and change your password.`
- Session revocation always uses scope `'local'`.
- All new tables: RLS on, no grants to `anon`/`authenticated`. RPCs: `EXECUTE` to `service_role` only.
- Every route response carries `Cache-Control: no-store`.

## Review Focus

1. **The number typed in any format** (`024 123 4567`, `+233241234567`, `233241234567`, `241234567`) should resolve to
   the same account and the **same lockout counter**. Test: Task 2 `phoneKey`; Task 6 "lockout counts across formats".
2. **Double-submit of a correct code** (double tap, two tabs) should create exactly one session; the second attempt
   gets "invalid". Test: Task 4 "consumeChallenge is single-use under concurrency"; Task 6 "second verify after
   success is invalid".
3. **The SMS fails to send** (provider down): no usable challenge is left, no session is created, and the user is told
   to try email login. Test: Task 6 "send failure leaves no live challenge".
4. **A trusted-device cookie from a different account** on a shared family computer should still require the code.
   Test: Task 6 "device trusted for user A is untrusted for user B".
5. **The code expired or was guessed wrong 5 times:** a clear "start again" message, and the user returns to the
   phone + password form (not stuck on the code screen). Test: Task 6 "expired → restart"; Task 8 UI test
   "restart returns to form".

---

## File map

| File | Responsibility |
|---|---|
| `migrations/0203_phone_login.sql` + `.selftest.sql` | Tables, lookup RPC, failure/event RPCs, triggers, settings rows (use the next free number on main if 0203 is taken) |
| `lib/phone-login/migration-0203.test.ts` (+ `migration-0203-run.ts`) | PGlite run of the migration + self-test (copy the 0196 pattern) |
| `lib/phone-login/core.ts` | Pure helpers: phone key, masking, hashing, token generation, eligibility, constants |
| `lib/phone-login/settings.ts` | Memoized read of the two settings + strict read for admin |
| `lib/phone-login/store.ts` | DB access: account lookup, events/lockout, challenges, trusted devices |
| `lib/phone-login/session.ts` | Supabase: verify password, revoke (local), mint session |
| `lib/phone-login/flow.ts` | Orchestrators `startPhoneLogin`, `verifyPhoneLogin`, `resendPhoneLoginCode` + alerts |
| `app/api/auth/phone-login/route.ts` | GET `{enabled}`; POST step 1 |
| `app/api/auth/phone-login/verify/route.ts` | POST step 2 |
| `app/api/auth/phone-login/resend/route.ts` | POST resend |
| `app/api/auth/check-phone/route.ts` | Normalized duplicate check |
| `app/auth/login-form.tsx` + `app/auth/phone-login-panel.tsx` | Email/Phone tabs; phone form + code screen |
| `app/api/admin/phone-login/route.ts` + section in `app/admin/security/page.tsx` | Toggles + 24 h counts |
| `app/api/cron/phone-login-retention/route.ts` | Retention |

---

### Task 1: Migration 0203: schema, RPCs, triggers, settings

**Files:**
- Create: `migrations/0203_phone_login.sql`, `migrations/0203_phone_login.selftest.sql`
- Create: `lib/phone-login/migration-0203-run.ts`, `lib/phone-login/migration-0203.test.ts` (model them on
  `lib/ai-admin-catalog/migration-0196*.ts`, including how they stub `auth.users`)

**Interfaces (produces):**
- `public.ghana_phone_sig(p text) returns text`. IMMUTABLE, same rules as `ghanaSignificant` in
  `lib/phone-format.ts`: strip non-digits, strip a leading `233` or `0`, return 9 digits matching `^[2-9]\d{8}$`, else
  NULL. Expression index `users_phone_sig_idx on public.users (public.ghana_phone_sig(phone_number))`.
- `public.phone_login_find_account(p_sig text) returns table(match_count int, user_id uuid, email text, phone_number text, phone_verified boolean, is_suspended boolean)`.
  SECURITY DEFINER, `search_path = ''`. It returns exactly one row: `match_count` = number of `public.users` rows with
  that sig. The other columns are filled only when `match_count = 1` (email joined from `auth.users`).
- Table `phone_login_events(id bigserial pk, kind text check in ('fail','lockout','login_ok','challenge_sent','challenge_passed','password_changed','code_switch_off'), user_id uuid null, phone_hash text null, ip_hash text null, created_at timestamptz default now())`.
  Indexes `(phone_hash, created_at)`, `(ip_hash, created_at)`, `(kind, created_at)`. This table is the spec's
  `phone_login_failures`, widened so the same rows also feed the admin counts and alerts.
- `public.phone_login_record_failure(p_phone_hash text, p_ip_hash text) returns boolean`. It inserts a `fail` event,
  then returns `true` if that phone_hash now has ≥5 `fail` events in the last 15 min (and inserts one `lockout` event
  the moment it reaches 5).
- `public.phone_login_is_locked(p_phone_hash text) returns boolean`: ≥5 `fail` events in the last 15 min.
- Table `phone_login_challenges(id text pk, user_id uuid not null references auth.users on delete cascade, browser_secret_hash text not null, otp_phone text not null, attempts int not null default 0, last_sent_at timestamptz not null, created_at timestamptz default now(), expires_at timestamptz not null, consumed_at timestamptz null)`.
- Table `trusted_devices(id uuid pk default gen_random_uuid(), user_id uuid not null references auth.users on delete cascade, token_hash text not null unique, ua_label text, created_at timestamptz default now(), last_used_at timestamptz, expires_at timestamptz not null, revoked_at timestamptz null)`,
  index `(user_id) where revoked_at is null`.
- Triggers (each sets `revoked_at = now()` on that user's live `trusted_devices`):
  - `auth.users` AFTER UPDATE when `encrypted_password` changes → also inserts a `password_changed` event
  - `auth.users` AFTER UPDATE when `banned_until` becomes non-null
  - `public.users` AFTER UPDATE when `phone_number` changes, or `is_suspended` becomes true
- `admin_settings` rows `phone_login_enabled='false'` and `phone_login_new_device_code='true'`, inserted with
  `on conflict (key) do nothing`.

- [ ] **Step 1: Write the failing test.** Copy the 0196 text checks: one transaction, `lock_timeout`, one COMMIT, the
  run string can't commit, the self-test doesn't insert into or delete from `public.users`. Then add a PGlite test
  `"0203 self-test passes"` that expects the run to raise `SELFTEST_OK 0203`. The self-test asserts:
  - `ghana_phone_sig` gives `'241234567'` for `'0241234567'`, `'+233 24 123 4567'` and `'233241234567'`, and NULL for
    `'12345'` and `'0141234567'`
  - `find_account` returns `match_count=2` and NULL user columns for a duplicated sig, and `1` with data for a unique sig
  - `record_failure` returns false 4 times, then true on the 5th, with exactly one `lockout` row
  - each of the three triggers revokes the user's devices, and the password trigger also writes a `password_changed`
    event
  - RLS is enabled on all three tables, and `has_table_privilege('anon', …, 'select')` and the `authenticated`
    equivalent are false
  - `has_function_privilege('anon', 'public.phone_login_find_account(text)', 'execute')` is false
  - the plan for `select … where public.ghana_phone_sig(phone_number) = '241234567'` uses `users_phone_sig_idx`
    (`enable_seqscan = off`)
- [ ] **Step 2:** Run `npx vitest run B:/worktrees/dg-phone-login/lib/phone-login/migration-0203.test.ts`. Expected:
  FAIL (files missing).
- [ ] **Step 3:** Write the migration and self-test to the interfaces above.
  `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role` on every function.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(phone-login): 0203 schema, lookup RPC, revoke-all triggers`.

---

### Task 2: Pure helpers (`core.ts`)

**Files:** Create `lib/phone-login/core.ts`, `lib/phone-login/core.test.ts`

**Interfaces (produces):**
```ts
export const GENERIC_LOGIN_ERROR = "Phone number or password is incorrect."
export const PHONE_LOGIN_PURPOSE = "phone_login"
export const LIMITS = { ipStep1: { max: 10, windowMs: 900_000 }, ipVerify: { max: 10, windowMs: 900_000 },
  challengeTtlMs: 600_000, maxCodeAttempts: 5, resendGapMs: 60_000, deviceTtlMs: 2_592_000_000, maxDevices: 10 } as const
export function phoneKey(input: string): { sig: string; canonical: string } | null   // via ghanaSignificant / normalizeGhanaPhone
export function sha256Hex(s: string): string
export function phoneHash(sig: string): string        // sha256Hex("phone-login:" + sig)
export function ipHash(ip: string): string            // sha256Hex("phone-login-ip:" + ip)
export function newToken(): string                    // 32 random bytes, base64url
export function maskPhone(canonical: string): string  // "0241234567" -> "024 *** **67"
export type Account = { matchCount: number; userId: string | null; email: string | null; phone: string | null; phoneVerified: boolean; isSuspended: boolean }
export function isEligible(a: Account): a is Account & { userId: string; email: string; phone: string }
export function uaLabel(userAgent: string | null): string  // e.g. "Chrome on Android"; max 40 chars; "Unknown device" fallback
```

- [ ] **Step 1: Failing tests:**
  - `phoneKey` gives the same `{sig:'241234567', canonical:'0241234567'}` for the four formats in Review Focus #1, and
    `null` for `''`, `'abc'` and `'0141234567'`
  - `maskPhone('0241234567') === '024 *** **67'`
  - `newToken()` is 43 chars and two calls differ
  - `phoneHash` is stable and differs from `ipHash` of the same string
  - `isEligible` is false when `matchCount !== 1`, `phoneVerified` is false, `isSuspended` is true, or `email` is null
  - `uaLabel(null) === 'Unknown device'`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `node:crypto` (`createHash`, `randomBytes`).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.

---

### Task 3: Settings (`settings.ts`)

**Files:** Create `lib/phone-login/settings.ts`, `lib/phone-login/settings.test.ts` (copy the memo/strict pattern of
`lib/blocked-numbers/settings.ts`)

**Interfaces (produces):**
```ts
export type PhoneLoginSettings = { enabled: boolean; newDeviceCode: boolean }
export const DEFAULT_PHONE_LOGIN_SETTINGS: PhoneLoginSettings = { enabled: false, newDeviceCode: true }
export async function getPhoneLoginSettings(opts?: { fresh?: boolean; load?: () => Promise<unknown> }): Promise<PhoneLoginSettings> // 30 s memo; on error → defaults
export async function getPhoneLoginSettingsStrict(client?: SupabaseClient): Promise<PhoneLoginSettings> // throws on DB error
export async function setPhoneLoginSettings(client: SupabaseClient, next: PhoneLoginSettings): Promise<void>
```

- [ ] **Step 1: Failing tests:**
  - parses `'true'`/`'false'` strings
  - a missing row gives the defaults
  - a load error gives `enabled:false` (fails closed)
  - `newDeviceCode` defaults to **true** even when only `enabled` is present
  - the strict read throws on error
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5:** Commit.

---

### Task 4: DB store (`store.ts`)

**Files:** Create `lib/phone-login/store.ts`, `lib/phone-login/store.test.ts` (fake-client pattern; unique test
phones)

**Interfaces:**
- Consumes: Task 1 tables/RPCs, Task 2 helpers.
- Produces (each takes `db: SupabaseClient` service-role first):
```ts
findAccount(db, sig): Promise<Account>                                  // rpc phone_login_find_account
isLocked(db, phoneHash): Promise<boolean>
recordFailure(db, phoneHash, ipHash): Promise<{ locked: boolean }>
recordEvent(db, kind, f: { userId?: string; phoneHash?: string; ipHash?: string }): Promise<void>  // never throws
countDistinctPhonesFromIp(db, ipHash, sinceMs): Promise<number>
countEvents(db, kind, sinceMs): Promise<number>
hadPasswordChangeSince(db, userId, sinceMs): Promise<boolean>
createChallenge(db, c: { id: string; userId: string; browserSecretHash: string; otpPhone: string; now: Date }): Promise<void>
getChallenge(db, id): Promise<ChallengeRow | null>
bumpChallengeAttempt(db, id): Promise<number>                           // returns new attempts
consumeChallenge(db, id, now): Promise<boolean>                         // update … set consumed_at where id and consumed_at is null and expires_at > now → true iff 1 row
killChallenge(db, id): Promise<void>                                    // sets expires_at = now
touchChallengeSent(db, id, now): Promise<void>
findTrustedDevice(db, tokenHash, userId, now): Promise<{ id: string } | null>  // user match, not revoked, not expired
trustDevice(db, d: { userId: string; tokenHash: string; uaLabel: string; now: Date }): Promise<void> // revokes oldest beyond 10 active
touchDevice(db, id, now): Promise<void>
export type ChallengeRow = { id: string; userId: string; browserSecretHash: string; otpPhone: string; attempts: number; lastSentAt: Date; expiresAt: Date; consumedAt: Date | null }
```

- [ ] **Step 1: Failing tests:**
  - `consumeChallenge` returns true once, then false (single use; with two concurrent calls on the fake, exactly one
    is true)
  - `consumeChallenge` is false after expiry
  - `findTrustedDevice` is null for another user's token, a revoked device, or an expired device
  - `trustDevice` with 10 active revokes the oldest
  - `recordEvent` swallows DB errors
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5:** Commit.

---

### Task 5: Supabase session helpers (`session.ts`)

**Files:** Create `lib/phone-login/session.ts`, `lib/phone-login/session.test.ts`

**Interfaces (produces):**
```ts
export type Session = { access_token: string; refresh_token: string; expires_at?: number }
export interface SessionDeps { anon: () => SupabaseClient; admin: SupabaseClient }   // anon(): createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
export async function verifyPassword(d: SessionDeps, email: string, password: string): Promise<Session | null>  // signInWithPassword; any error → null
export async function dummyPasswordCheck(d: SessionDeps): Promise<void>  // signInWithPassword with "no-such-user@invalid.datagod" + random password; ignore result (timing match)
export async function revokeSessionLocal(d: SessionDeps, accessToken: string): Promise<void>  // admin.auth.admin.signOut(accessToken, "local"); throws on error
export async function mintSession(d: SessionDeps, email: string): Promise<Session>  // admin.auth.admin.generateLink({type:"magiclink", email}) → anon().auth.verifyOtp({type:"magiclink", token_hash: properties.hashed_token})
```

- [ ] **Step 1: Failing tests:**
  - `revokeSessionLocal` calls `signOut` with exactly `(token, 'local')`
  - `verifyPassword` returns null on an auth error
  - `mintSession` never calls any email-sending method and passes `hashed_token` through
  - `mintSession` throws if `verifyOtp` returns no session
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5:** Commit.

---

### Task 6: Flow orchestrators (`flow.ts`)

**Files:** Create `lib/phone-login/flow.ts`, `lib/phone-login/flow.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5, `issuePhoneOtp` / `checkPhoneOtp` from `lib/phone-otp.ts`, and `raiseSecurityAlert` from
  `lib/security-alerts.ts`.
- Produces:
```ts
export interface FlowDeps { db: SupabaseClient; session: SessionDeps; settings: () => Promise<PhoneLoginSettings>;
  sendCode: (phone: string, code: string) => Promise<unknown>; alert: typeof raiseSecurityAlert; now: () => Date }
export type StartResult =
  | { kind: "fail" }                                                        // route maps to 401 GENERIC_LOGIN_ERROR
  | { kind: "disabled" }                                                    // 404
  | { kind: "session"; session: Session }
  | { kind: "challenge"; challengeId: string; browserSecret: string; maskedPhone: string }
  | { kind: "send_failed" }                                                 // 503 "We couldn't send the code. Please sign in with your email."
export async function startPhoneLogin(d: FlowDeps, i: { phone: string; password: string; ip: string; deviceToken: string | null }): Promise<StartResult>
export type VerifyResult =
  | { kind: "session"; session: Session; deviceToken: string }
  | { kind: "invalid"; attemptsLeft: number }                               // 400 "That code is not right."
  | { kind: "restart" }                                                     // 410 "This code has expired. Please sign in again."
export async function verifyPhoneLogin(d: FlowDeps, i: { challengeId: string; browserSecret: string | null; code: string; ip: string; userAgent: string | null }): Promise<VerifyResult>
export type ResendResult = { kind: "sent" } | { kind: "wait"; seconds: number } | { kind: "restart" } | { kind: "send_failed" }
export async function resendPhoneLoginCode(d: FlowDeps, i: { challengeId: string; browserSecret: string | null }): Promise<ResendResult>
```
- **Step-1 order (pins the spec):**
  1. settings disabled → `disabled`
  2. `phoneKey` null → `dummyPasswordCheck` + `fail`
  3. `isLocked(phoneHash)` → dummy + `fail`
  4. `findAccount`; not `isEligible` → dummy + `recordFailure` + `fail`
  5. `verifyPassword`; null → `recordFailure` + `fail`
  6. trusted device for this user → `touchDevice` + `login_ok` event + `session`
  7. `newDeviceCode` off → `login_ok` event + `session`
  8. else: `revokeSessionLocal` → `createChallenge` (`otpPhone = normalizeGhanaPhone(account.phone)`,
     `browserSecretHash = sha256Hex(browserSecret)`) → `issuePhoneOtp(…, PHONE_LOGIN_PURPOSE)` with `sendCode`. On
     send error or rate-limited → `killChallenge` + `send_failed`. Else a `challenge_sent` event + `challenge`.
- **After every `recordFailure`:** if `countDistinctPhonesFromIp(ip, 15 min) > 20`, raise a `high` alert, category
  `phone_login_stuffing`, `dedupeKey = ipHash`, 60 min. If `countEvents('lockout', 15 min) > 10`, raise a `high`
  alert, category `phone_login_lockouts`, `dedupeKey 'sitewide'`, 60 min. Alerts carry hashes, never numbers.
- **Verify order:**
  1. challenge missing, expired, consumed, or `sha256Hex(browserSecret) !== browserSecretHash` → `restart`
  2. `attempts >= 5` → `restart`
  3. `checkPhoneOtp(otpPhone, code, PHONE_LOGIN_PURPOSE)` not `verified` → `bumpChallengeAttempt`. At 5,
     `killChallenge` + `restart`; else `invalid`.
  4. `consumeChallenge` false → `restart`
  5. `mintSession`, `trustDevice(newToken)`, a `challenge_passed` event. If `hadPasswordChangeSince(user, 24 h)`, an
     `info` alert, category `phone_login_after_reset`.
  6. → `session`
  Note: the code match uses the shared `checkPhoneOtp`, but the attempt cap is the challenge's own `attempts`, as the
  spec requires. The shared `bump_otp_attempts` also runs inside `checkPhoneOtp`, which is acceptable: its cap of 6 is
  above ours of 5.
- **Resend:** the same challenge/browser checks → `restart`. Less than 60 s since `lastSentAt` → `wait`. Else
  `issuePhoneOtp` (its 3/hour cap returns rate-limited → `wait` with 3600 s) + `touchChallengeSent`.

- [ ] **Step 1: Failing tests (fakes for every dep):**
  - **"all step-1 failures are indistinguishable":** unknown number, shared number (`matchCount 2`), unverified,
    suspended, wrong password and locked each return `{kind:'fail'}`, and each calls `verifyPassword` or
    `dummyPasswordCheck` exactly once
  - "lockout counts across formats": 5 failures using the four formats of one number lock it
  - "trusted device returns a session and sends no SMS"
  - "untrusted device revokes with local, sends to the registered number (not the typed one), returns no session"
  - "device trusted for user A is untrusted for user B"
  - "newDeviceCode off returns a session with no SMS"
  - "send failure leaves no live challenge"
  - "wrong browser secret → restart"
  - "5 wrong codes → restart and challenge dead"
  - "expired → restart"
  - "second verify after success is invalid/restart"
  - "success trusts the device and returns its token"
  - "stuffing alert fires at 21 distinct phones from one IP"
  - "lockout alert at 11 lockouts"
  - "after-reset info alert"
  - "resend within 60 s → wait"
  - "no phone, code, password or email in any alert detail or event row" (serialize every fake call and assert none
    of the test values appear)
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5:** Commit.

---

### Task 7: Routes + check-phone normalization

**Files:**
- Create: `app/api/auth/phone-login/route.ts`, `app/api/auth/phone-login/verify/route.ts`,
  `app/api/auth/phone-login/resend/route.ts`, plus a `route.test.ts` next to each
- Modify: `app/api/auth/check-phone/route.ts` and its test (create one if missing)

**Interfaces:**
- Consumes: Task 6 functions.
- Produces:
  - `GET /api/auth/phone-login` → `{ enabled: boolean }`
  - `POST /api/auth/phone-login` `{phone,password}` → 200 `{session}` | 200 `{challenge:{id,maskedPhone}}` | 401
    generic | 404 | 429 | 503
  - `POST …/verify` `{challengeId,code}` → 200 `{session}` | 400 `{error,attemptsLeft}` | 410 `{error}` | 429
  - `POST …/resend` `{challengeId}` → 200 | 429 `{error,seconds}` | 410 | 503

Details:
- IP limits via `applyRateLimit(request, "phone_login", 10, 900_000, undefined, { pgFallback: true })` and
  `"phone_login_verify"`. If `!allowed`, or `degraded` without the fallback → 429 `"Too many attempts. Please try again later."`
- Read cookies from `request.cookies`. On a `challenge` result set `dg_plc`. On a verify `session` set `dg_device` and
  clear `dg_plc`. Use the flags from Global Constraints.
- Validate the body: strings only, phone ≤ 20 chars, password ≤ 200, code `^\d{6}$`, challengeId ≤ 64. A bad body on
  step 1 returns the **generic 401**. A bad code returns 400.
- Wire `sendCode` exactly like `app/api/auth/send-phone-otp/route.ts`, with the new SMS template
  `SMSTemplates.phoneLoginCode(code)` added to `lib/sms-service.ts` using the exact copy.
- check-phone: replace the raw `.eq('phone_number', …)` with a normalized match on `public.ghana_phone_sig(phone_number)`
  using `phoneKey(input).sig`. With `excludeUserId`, "taken" means a match on any other user. Keep the existing
  response shape.

- [ ] **Step 1: Failing route tests:**
  - every response has `Cache-Control: no-store`
  - the generic 401 body is byte-identical across the fail kinds
  - a challenge response has no `access_token` anywhere in the body and sets `dg_plc` httpOnly
  - verify success sets `dg_device` with Max-Age 2592000
  - 429 when the limiter denies
  - check-phone reports `0241234567` as taken when `+233241234567` is stored
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5:** Commit.

---

### Task 8: Login form UI

**Files:**
- Create: `app/auth/phone-login-panel.tsx`, `app/auth/phone-login-panel.test.tsx`
- Modify: `app/auth/login-form.tsx` (add `Email | Phone` tabs; Phone only when `GET /api/auth/phone-login` says
  `enabled`)

**Interfaces:** consumes the Task 7 HTTP contract. On `{session}`, call `supabase.auth.setSession(session)` from
`@/lib/supabase`, then `router.push(redirectTo)`, where `redirectTo` comes from `safeRedirectPath` as login-form
already does.

Behaviour (spec §5):
- Phone form: phone (`inputMode="tel"`, `autoComplete="tel"`) and password with the show/hide eye. "Forgot
  password?" links to `/auth/forgot-password`.
- Code screen:
  - "We sent a code to {maskedPhone}", a 6-digit input (`autoComplete="one-time-code"`, `inputMode="numeric"`)
  - Verify button, Resend with a 60 s countdown
  - "Use a different number" returns to the form
- 410 (or a resend `restart`) → a toast with the message, back to the form, password cleared.
- 503 send failure → the message, with the Email tab focused.
- Navy primary button, plus `lg:` widening per `docs/ui-conventions.md`, matching the existing email form's card.

- [ ] **Step 1: Failing tests (Testing Library):**
  - the tab is hidden when `enabled:false`
  - a challenge response shows the masked phone and the code input
  - "restart returns to form" (410 → form visible, password empty)
  - a session response calls `setSession` and navigates to the safe redirect
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5:** Screenshot the phone tab and code screen at 500 px and 1280 px with local headless Chrome. Check:
  navy accent, no layout break.
- [ ] **Step 6:** Commit.

---

### Task 9: Admin toggles, counts, and retention cron

**Files:**
- Create: `app/api/admin/phone-login/route.ts` + test
- Modify: `app/admin/security/page.tsx` (new "Phone login" card)
- Create: `app/api/cron/phone-login-retention/route.ts` + test (copy the `ai-conversations-retention` auth pattern)

**Interfaces:**
- `GET /api/admin/phone-login` (`verifyAdminAccess`) → `{ settings: PhoneLoginSettings, last24h: { login_ok, challenge_sent, challenge_passed, lockout } }`
  using `countEvents`.
- `POST` `{enabled, newDeviceCode}` → `setPhoneLoginSettings` after `getPhoneLoginSettingsStrict` (never overwrite on a
  read error). If `newDeviceCode` goes from true to false → a `code_switch_off` event + a `high` alert, category
  `phone_login_code_off`, actor = admin id.
- Fire the existing admin-action notifier (`lib/admin-actions/`) on any change.
- Cron deletes:
  - `phone_login_challenges` older than 1 day
  - `trusted_devices` with `revoked_at` or `expires_at` older than 30 days
  - `phone_login_events` older than 30 days

- [ ] **Step 1: Failing tests:**
  - non-admin → 401/403
  - turning the code off raises the alert, and turning it on doesn't
  - a strict-read failure → 500 and no write
  - the cron deletes only rows past each cutoff
- [ ] **Step 2–4:** Fail → implement → pass.
- [ ] **Step 5:** Add the cron to the external-cron config (daily). Task 10 Step 6 syncs it with the existing sync
  script (`MSYS_NO_PATHCONV=1`).
- [ ] **Step 6:** Commit.

---

### Task 10: Review, build, ship dark, live check

- [ ] **Step 1:** `npx vitest run` on the whole suite. Expected: only the 9 known order-health failures.
- [ ] **Step 2:** Run `next build` with placeholder env. Expected: success (catches route-export errors).
- [ ] **Step 3:** Fresh security reviewer (opus, final review) on `git diff origin/main...feat/phone-login`, given the
  spec + this plan + the abuse-case table (spec §7). Fix every confirmed finding with a failing test first.
- [ ] **Step 4:** Prod protocol for 0203:
  1. Precheck that the number is free on main, and run the self-test against prod in a self-rolling-back
     transaction.
  2. Show the owner the dry-run result and get their OK, then apply.
  3. Verify: tables exist, the grants are right, both settings rows are present with `enabled=false`.
- [ ] **Step 5:** Check local main for other sessions' commits, merge, and push. Wait for the Vercel deploy and
  confirm `GET /api/auth/phone-login` → `{enabled:false}` and that the phone tab is hidden.
- [ ] **Step 6:** Sync the retention cron to cron-job.org.
- [ ] **Step 7:** Owner's live check (owner turns the switch on in /admin/security). Use a real phone with a verified
  account:
  1. a new browser asks for the code, and the code works
  2. the same browser later signs in without a code
  3. while signed in on device A, a phone login from device B (at the code step) does **not** log device A out (this
     proves local revocation)
  4. five wrong passwords lock the number for 15 minutes, and email login still works
  5. a password reset makes the next phone login ask for the code again
- [ ] **Step 8:** Write a ready-to-paste WhatsApp channel post with how-to steps (Post now / Hold). Update the
  `project-phone-login` memory with commits, the migration, the cron job id and the status.
