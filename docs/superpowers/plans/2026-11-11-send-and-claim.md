# Send & Claim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers with a verified phone fund their wallet by sending MoMo to Datagod's MTN number with a code; a forwarded SMS credits them automatically, a claim box covers forgotten codes, and admins review, credit and reconcile.

**Architecture:** Pure logic in `lib/momo-claim/` (parser, codes, money, window, intake fraud checks). All money movement in one migration's SECURITY DEFINER functions with lock order session → transaction → wallet and their own lock-first wallet credit. Thin routes: SMS webhook, customer sessions/claim, admin. Ships DARK behind `momo_claim_enabled`.

**Tech Stack:** Next.js 15 App Router, Supabase Postgres (service-role client `supabaseAdmin` from `lib/supabase.ts`), Vitest, PGlite migration tests, Tailwind/shadcn UI.

**Spec:** `docs/superpowers/specs/2026-11-11-send-and-claim-design.md` (source docs: `docs/send-and-claim-*.txt`).

## Global Constraints

- Work in a git worktree off latest `origin/main` (run `git fetch` first). Never force-push main. Run a real placeholder-env `next build` before pushing main.
- Migration number: next free on origin/main at worktree time (0160 as of 2026-11-11). Follow the 0159 pattern: migration file + `.selftest.sql` (self-rolling-back DO block ending in RAISE `SELFTEST_OK`) + a Vitest file that builds the run string in code and asserts no COMMIT / bare `END;`.
- Every new table: RLS on, no policies, `REVOKE ALL ... FROM PUBLIC, anon, authenticated` (0060 grants authenticated CRUD by default), service_role gets only what it needs. Verify with `has_table_privilege`.
- Every new function: SECURITY DEFINER, `SET search_path = ''`, REVOKE EXECUTE from PUBLIC/anon/authenticated, GRANT to service_role, verify with `has_function_privilege`.
- Lock order on every path: session, then momo transaction, then wallet. Lock (FOR UPDATE) before any status/idempotency check.
- Ledger: `public.transactions` (type `credit`, source `momo_claim`, `reference_id = 'MOMO-' || txid`, balance_before/after, status `completed`). Balance: `public.wallets` (balance, total_credited). New functions do NOT call `credit_wallet_safely`.
- Money in code is integer pesewas; in SQL `numeric(12,2)`. Fee rounds UP to the pesewa.
- Values: window 60 min; max 5 open sessions per user; min GHS 10.00 net; max GHS 2,000.00 sent; review threshold GHS 500.00 credited; daily cap GHS 3,000.00 credited; txid regression threshold 1,000,000; claim limits 3 per 30 s per user, 20 failed per 24 h per user, 5 failed per txid (any user) → flag; session create 5 per minute per user.
- Code: 3 letters from `ABCDEFGHJKMNPQRSTUVWXYZ` + 4 digits from `23456789`, via `crypto.randomInt`.
- Admin settings in `admin_settings` (key, value JSONB). Every momo key stores `{"value": <x>}`. Keys: `momo_claim_enabled` (true only if value is JSON `true`), `momo_payment_accounts`, `momo_account_name`, `momo_claim_fee_customer`, `momo_claim_fee_dealer`, `momo_min_claimable`, `momo_max_claimable`, `momo_sms_sender_allowlist` (default `["MobileMoney"]`), `momo_txid_regression_threshold`, `momo_auto_claim_review_threshold`, `momo_auto_claim_daily_cap`.
- Never log raw SMS bodies, payer names or full transaction IDs (last 4 digits only). Webhook auth via header `x-sms-forward-secret` vs env `SMS_FORWARD_SECRET`, constant time; unset secret rejects all.
- Rate limits that protect money are DB-backed (count `momo_claim_attempts`), because `applyRateLimit` fails OPEN when Redis is down.
- Hubtel/opaque-reference rule: codes contain no brand or product word (guaranteed by the alphabet).
- Every new sidebar item gets a NEW tag (`lib/nav-new.ts` + admin link wiring in `components/layout/sidebar.tsx`).
- Use Edit/Write tools for code edits, never sed.

## Review Focus

1. **Redis/Upstash down:** `applyRateLimit` returns allowed. Claim attempts must still be capped. Test: claim route with limiter mocked `degraded: true` still refuses the 4th attempt within 30 s (Task 9).
2. **Same SMS forwarded twice concurrently, plus a manual claim racing the webhook:** exactly one credit. Test: PGlite scenario calling `claim_via_wallet_topup_session` then `claim_momo_via_session` for the same txid → second returns `already_credited`/`not_matched`, wallet credited once (Task 5).
3. **SMS amount with commas / no decimals / trailing period** (`GHS 1,200`, `GHS 50.`): parsed to exact pesewas. Test in parser (Task 1).
4. **Code typed lowercase or with spaces/hyphen in the MoMo reference** (`kxr 4821`, `KXR-4821`): still matched. Test in `scanCodeCandidates` (Task 2).
5. **Feature switched off or setting malformed mid-session:** every customer route refuses and the tab hides; webhook still STORES transactions (so money isn't lost) but does not auto-credit. Tests in Tasks 6 and 7.

---

### Task 1: SMS parser

**Files:**
- Create: `lib/momo-claim/parse-sms.ts`
- Test: `lib/momo-claim/parse-sms.test.ts`

**Interfaces:**
- Produces: `passesPrefilter(text: string): boolean`; `parseMomoSms(text: string): ParsedSms | null` where
  `type ParsedSms = { pattern: "mtn_cash_in" | "mtn_payment" | "telecel" | "airteltigo"; network: "MTN" | "Telecel" | "AirtelTigo"; amountPesewas: number; senderName: string; transactionId: string; balancePesewas: number | null }`.

- [ ] **Step 1: Write failing tests** using the four patterns and fake samples in `docs/send-and-claim-sms-formats.txt`:
  - `parses MTN cash in`: the Cash In sample → `{pattern:"mtn_cash_in", network:"MTN", amountPesewas:20000, senderName:"JOHN DOE", transactionId:"80000000001", balancePesewas:27265}`.
  - `parses MTN payment and labels cross-network`: Payment sample containing `from VODAFONE` → `network:"Telecel"`, `amountPesewas:300`, `transactionId:"80000000002"`; variants with `from AIRTEL`/`from TIGO` → `AirtelTigo`; none → `MTN`.
  - `parses telecel` and `parses airteltigo` from the doc's wording.
  - `amount formats`: `GHS 1,200.00`→120000, `GHS 1,200`→120000, `GHS 50.`→5000, `GHS 0.00`→null.
  - `rejects txid outside 8-15 digits` (7 and 16 digits → null); `rejects sender shorter than 2 chars`.
  - `prefilter`: true only when text contains both `GHS` and `Transaction ID` (case-insensitive).
  - `first matching pattern wins` in the doc's order.
- [ ] **Step 2: Run** `npx vitest run lib/momo-claim/parse-sms.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** with the four regexes verbatim from the source doc; parse amounts by stripping commas and converting to integer pesewas without float error (split on `.`); balance from `Current Balance GHS ([\d,]+\.?\d*)` when present.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(momo-claim): SMS parser for MoMo confirmations`.

### Task 2: Codes, money and window rules

**Files:**
- Create: `lib/momo-claim/codes.ts`, `lib/momo-claim/money.ts`, `lib/momo-claim/window.ts`
- Test: `lib/momo-claim/codes.test.ts`, `money.test.ts`, `window.test.ts`

**Interfaces:**
- Produces:
  - `CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ"`, `CODE_DIGITS = "23456789"`, `generateClaimCode(randomInt?: (max: number) => number): string`, `scanCodeCandidates(text: string): string[]` (unique, uppercase, normalised `ABC1234` form).
  - `computeFee(sentPesewas: number, feePercent: number): { feePesewas: number; netPesewas: number }`; `checkSessionAmount(sentPesewas: number, feePercent: number, minNetPesewas: number, maxSentPesewas: number): "ok" | "below_min" | "above_max" | "invalid"`.
  - `WINDOW_MINUTES = 60`, `MAX_OPEN_SESSIONS = 5`, `type SessionLite = { id: string; status: string; createdAt: string; expiresAt: string }`, `openSessions(sessions: SessionLite[], now: Date): SessionLite[]` (pending and unexpired, newest first), `nextSlotFreeAt(sessions: SessionLite[], now: Date): Date | null` (null when < 5 open).

- [ ] **Step 1: Write failing tests:**
  - `generateClaimCode` matches `/^[A-HJKMNP-Z]{3}[2-9]{4}$/` over 1,000 calls; uses the injected `randomInt`.
  - `scanCodeCandidates("Ref kxr 4821 thanks")` → `["KXR4821"]`; `"KXR-4821"` → `["KXR4821"]`; text with `O`/`0` lookalikes yields no candidate; never returns a code adjacent to longer letter/digit runs (`XKXR48219` → none).
  - `computeFee(10000, 1.5)` → `{feePesewas:150, netPesewas:9850}`; `computeFee(1001, 1.5)` → fee 16 (15.015 rounded up); fee 0% → net = sent.
  - `checkSessionAmount`: net 999 → `below_min` with min 1000; sent 200001 → `above_max` with max 200000; non-integer or ≤ 0 → `invalid`.
  - `openSessions` excludes expired, claimed, cancelled; `nextSlotFreeAt` returns the earliest `expiresAt` when 5 are open, else null.
- [ ] **Step 2: Run** `npx vitest run lib/momo-claim/` → FAIL.
- [ ] **Step 3: Implement** (`generateClaimCode` defaults to `crypto.randomInt`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(momo-claim): codes, fee maths and window rules`.

### Task 3: Intake fraud checks

**Files:**
- Create: `lib/momo-claim/intake-checks.ts`
- Test: `lib/momo-claim/intake-checks.test.ts`

**Interfaces:**
- Consumes: `ParsedSms` (Task 1).
- Produces: `type IntakeState = { newestTxid: string | null; balanceSeenOnOtherTxid: boolean; maxSentPesewas: number; regressionThreshold: number }`; `intakeFlags(sms: ParsedSms, state: IntakeState): IntakeFlag[]` where `IntakeFlag = "txid_regression" | "balance_repeat" | "above_max"`.

- [ ] **Step 1: Write failing tests:** newest `80057000000`, incoming `80000000001` (57M lower) with threshold 1,000,000 → `["txid_regression"]`; lower by 999,999 → `[]`; higher → `[]`; `newestTxid:null` → no regression flag; `balanceSeenOnOtherTxid:true` → includes `balance_repeat`; amount above max → includes `above_max`; compare txids numerically with BigInt (15 digits exceed safe integer range).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(momo-claim): intake fraud checks`.

### Task 4: Migration — tables and settings

**Files:**
- Create: `migrations/0160_momo_send_and_claim.sql` (tables part), `migrations/0160_momo_send_and_claim.selftest.sql`
- Test: `lib/momo-claim/migration.test.ts` (copy the run-string builder and PGlite setup approach from `lib/ussd-hubtel/wallet-migration.test.ts`)

**Interfaces:**
- Produces tables (all `public.`):
  - `momo_transactions(id uuid pk, transaction_id text unique not null check (transaction_id ~ '^[0-9]{8,15}$' or status in ('unparsed','rejected_sender')), network text, pattern text, amount numeric(12,2), sender_name text, sms_sender text, sms_balance numeric(12,2), raw_sms text not null, status text not null check (status in ('pending','claimed','flagged','voided','unparsed','rejected_sender')), flag_reasons text[] not null default '{}', session_id uuid null references wallet_topup_sessions, claimed_by uuid null, claimed_at timestamptz, fee numeric(12,2), net_amount numeric(12,2), credited_by_admin uuid, admin_reason text, unflagged_by uuid, unflagged_at timestamptz, unflag_reason text, attempts_reset_at timestamptz not null default now(), received_at timestamptz not null default now())`. Unparsed/rejected rows use a synthetic `transaction_id` = `'X' || gen_random_uuid()` (hence the check's OR).
  - `wallet_topup_sessions(id uuid pk, user_id uuid not null references auth.users, code text unique not null check (code ~ '^[A-HJKMNP-Z]{3}[2-9]{4}$'), amount numeric(12,2) not null check (amount > 0), fee numeric(12,2) not null, net_amount numeric(12,2) not null, status text not null default 'pending' check (status in ('pending','claimed','expired','cancelled')), created_at timestamptz not null default now(), expires_at timestamptz not null, claimed_transaction_id text, force_expired_by uuid)`; index `(user_id, status, expires_at)`.
  - `momo_claim_attempts(id uuid pk, user_id uuid not null, transaction_id text not null, result text not null check (result in ('credited','under_review','already_credited','not_matched','no_session','rate_limited','daily_limit','feature_off')), created_at timestamptz not null default now())`; indexes `(user_id, created_at)`, `(transaction_id, created_at)`. Early rejections use `transaction_id = 'NOSESSION'`.
  - `momo_reconciliation_runs(id uuid pk, admin_id uuid not null, period_start date, period_end date, statement_txids int, claimed_checked int, missing_txids text[] not null default '{}', created_at timestamptz default now())`.
  - Default `admin_settings` rows (`ON CONFLICT (key) DO NOTHING`), with `momo_claim_enabled` = `{"value": false}`.

- [ ] **Step 1: Write failing test** `migration.test.ts`: in PGlite with the minimal stubs the 0159 test uses (auth.users, public.users, wallets, transactions, admin_settings, roles), apply the migration and assert: all four tables exist with RLS on; `has_table_privilege('authenticated', t, 'SELECT')` and `'anon'` are false for each; `momo_claim_enabled` default is `{"value": false}`; inserting a duplicate `transaction_id` raises unique_violation; a session code `KXO4821` violates the check. Also assert the selftest run string has no `COMMIT` and no bare `END;`.
- [ ] **Step 2: Run** `npx vitest run lib/momo-claim/migration.test.ts` → FAIL.
- [ ] **Step 3: Write the tables part of the migration** (BEGIN … COMMIT, `SET LOCAL lock_timeout`/`statement_timeout` as 0159 does) and the selftest catalog/grants/deny_anon/deny_authenticated scenarios.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(momo-claim): migration 0160 tables (unapplied)`.

### Task 5: Migration — claim and admin functions

**Files:**
- Modify: `migrations/0160_momo_send_and_claim.sql`, `migrations/0160_momo_send_and_claim.selftest.sql`
- Test: `lib/momo-claim/migration.test.ts`

**Interfaces:**
- Produces (all return `text` result; callers are service_role only):
  - `claim_momo_transaction(p_txid text, p_user uuid, p_session_id uuid, p_check_amount boolean, p_mode text)` — internal, called by the two below. Expects the session already locked by the caller. Locks the momo row; status must be `pending`; if `p_check_amount` and amount ≠ session amount → flag `amount_mismatch` (link session) and return `'under_review'` for webhook mode / `'not_matched'` for manual mode; computes fee from `momo_claim_fee_dealer` if `public.users.role = 'dealer'` else `momo_claim_fee_customer` (round up); per-user checks → flag with reasons `first_claim` / `above_review_threshold` / `daily_cap` and return `'under_review'`; otherwise locks the wallet, checks the ledger for `MOMO-<txid>` (return `'already_credited'` if present), updates wallet + inserts ledger, marks momo row `claimed` and session `claimed`, returns `'credited'`.
  - `claim_via_wallet_topup_session(p_code text, p_txid text)` — webhook path; locks the session by code (must be pending, unexpired, created_at ≤ momo received_at), then calls the above with `p_check_amount = true`, mode `webhook`.
  - `claim_momo_via_session(p_user uuid, p_txid text, p_session_id uuid)` — manual path; DB-backed limits first (3 attempts per 30 s, 20 failed per 24 h → `'rate_limited'`/`'daily_limit'`, logged with `NOSESSION`); locks the caller's own pending unexpired session (given id, or the newest open one); none → `'no_session'`; momo row missing, or `received_at` < session `created_at`, or not `pending` → `'not_matched'`; else calls the shared function with amount check on, mode `manual`. Logs every attempt; 5 failed attempts on one real txid since `attempts_reset_at` → momo row flagged `too_many_attempts`.
  - `admin_credit_momo_transaction(p_txid text, p_target_user uuid, p_admin uuid, p_reason text)` — reason 1–200 chars; momo row status in `pending|flagged|unparsed`; locks linked session (if any) first, then momo row, then wallet; skips per-user checks; same ledger reference; records `credited_by_admin`, `admin_reason`, `claimed_by`; returns `'credited'` or `'already_credited'`.
  - `admin_unflag_momo_transaction(p_txid text, p_admin uuid, p_reason text)` — flagged → pending; records who/when/why; sets `attempts_reset_at = now()`.

- [ ] **Step 1: Write failing PGlite tests** (one `it` each): credited under own session (wallet +net, ledger row `MOMO-<txid>`); `already_credited` on second call; payment before session → `not_matched`; wrong amount webhook → row flagged `amount_mismatch`, no credit; manual wrong amount → `not_matched`; no session → `no_session`; first claim of a user → `under_review` with `first_claim`; credited amount 50001 pesewas → `above_review_threshold`; daily cap crossing → `daily_cap`; flagged row cannot be claimed manually; 4th attempt within 30 s → `rate_limited`; 5 failed attempts on one txid → flagged `too_many_attempts`; admin credit of flagged row → credited once, second admin call `already_credited`; admin credit with empty reason → error; webhook then manual on same txid → one credit (Review Focus 2); dealer gets dealer fee; every result value written is in the CHECK list; `has_function_privilege('authenticated', <each>, 'EXECUTE')` false.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement the functions** in the migration; mirror each test as a labelled selftest scenario (rolls back).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(momo-claim): claim and admin credit functions (unapplied)`.
- [ ] **Step 6: Owner gate (do not skip):** follow the prod change protocol — precheck counts, run the selftest against prod (must raise `SELFTEST_OK`), paste the migration SQL to the owner, apply only on their OK, then verify live with `has_function_privilege`, `has_table_privilege` and `pg_get_constraintdef` on `momo_claim_attempts_result_check`. Also read the live `credit_wallet_safely` definition and record (memory) whether it still checks before locking.

### Task 6: Settings loader and feature gate

**Files:**
- Create: `lib/momo-claim/settings.ts`
- Test: `lib/momo-claim/settings.test.ts`

**Interfaces:**
- Produces: `type MomoClaimSettings = { enabled: boolean; accounts: { network: string; number: string }[]; accountName: string; feeCustomerPercent: number; feeDealerPercent: number; minNetPesewas: number; maxSentPesewas: number; senderAllowlist: string[]; regressionThreshold: number; reviewThresholdPesewas: number; dailyCapPesewas: number }`; `loadMomoClaimSettings(client: SupabaseClient): Promise<MomoClaimSettings>`; `isStrictlyPhoneVerified(client: SupabaseClient, userId: string): Promise<boolean>` (reads `public.users.phone_verified`; ignores grace period and phone-gate kill switch; DB error → false).

- [ ] **Step 1: Failing tests** with the fake-client pattern (see `reference-testing` / existing `admin_settings` fakes): `enabled` only when value is `{"value": true}`; `"true"`, `1`, missing, DB error → `false` (Review Focus 5); defaults applied for missing keys (10.00/2,000.00/500/3,000/1,000,000/`["MobileMoney"]`); malformed numbers fall back to defaults; `isStrictlyPhoneVerified` false on error.
- [ ] **Step 2–4:** run → FAIL, implement, run → PASS.
- [ ] **Step 5: Commit** `feat(momo-claim): settings loader and strict phone check`.

### Task 7: SMS webhook

**Files:**
- Create: `app/api/webhooks/sms-forward/route.ts`, `lib/momo-claim/ingest.ts`
- Test: `lib/momo-claim/ingest.test.ts`, `app/api/webhooks/sms-forward/route.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2, 3, 6; RPC `claim_via_wallet_topup_session`.
- Produces: `ingestForwardedSms(client: SupabaseClient, input: { text: string; from: string | null }, settings: MomoClaimSettings, deps?: { notifyAdmins?: (alert: MomoAdminAlert) => Promise<void> }): Promise<IngestOutcome>` where `IngestOutcome = "ignored" | "duplicate" | "rejected_sender" | "unparsed" | "flagged" | "stored_pending" | "credited" | "under_review"`. `MomoAdminAlert` comes from Task 12.

- [ ] **Step 1: Failing route tests:** missing env secret → 401 for every request; wrong header → 401 (constant-time compare via `crypto.timingSafeEqual` on equal-length buffers); secret in query string only → 401; valid header + JSON `{text, from}` → 200; form-encoded `text=...` → 200; body fields `body|message|sms` accepted; response body never echoes the SMS.
- [ ] **Step 2: Failing ingest tests:** `from` not on allowlist → `rejected_sender`, row stored, no parse; prefilter fails → `ignored`, nothing stored; prefilter passes but no pattern → `unparsed` + admin alert; duplicate txid → `duplicate`; intake flag → `flagged` + alert, no RPC call; one live code in text → RPC called once → `credited`/`under_review`; no code → `stored_pending`; two different live codes in one SMS → no auto-credit, `stored_pending`; feature disabled → still stored, RPC never called (Review Focus 5); logger receives no raw text (spy on `console.*`).
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement** (route parses JSON or form; always 200 after auth). **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(momo-claim): SMS forward webhook`.

### Task 8: Customer sessions API

**Files:**
- Create: `app/api/wallet/momo-sessions/route.ts`
- Test: `app/api/wallet/momo-sessions/route.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 6.
- Produces: `GET` → `{ enabled, accounts, accountName, feePercent, minNet, maxSent, sessions: { id, code, amount, fee, netAmount, status, createdAt, expiresAt }[] }` (own sessions from last 24 h); `POST {amount}` → `201 { session }`; `DELETE ?id=` → cancel own pending session. Auth: Bearer token → user (same pattern as `app/api/wallet/balance/route.ts`).

- [ ] **Step 1: Failing tests:** feature off → GET `{enabled:false}` and POST 403; unverified phone → POST 403 `phone_not_verified`; `below_min`/`above_max`/`invalid` → 400 with that code; 6th open session → 409 `too_many_open` with `nextSlotFreeAt`; success stores code from `generateClaimCode`, `expires_at = now + 60 min`, fee from role; unique-code conflict retried up to 5 times; DELETE of another user's session → 404; limiter 5/min via `applyRateLimit`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(momo-claim): customer session API`.

### Task 9: Manual claim API

**Files:**
- Create: `app/api/wallet/momo-claim/route.ts`
- Test: `app/api/wallet/momo-claim/route.test.ts`

**Interfaces:**
- Consumes: RPC `claim_momo_via_session`; Task 6.
- Produces: `POST { transactionId, sessionId? }` → `200 { result: "credited" | "under_review" | "already_credited" | "not_matched" | "no_session" | "rate_limited" | "daily_limit" }` with fixed customer copy per result.

- [ ] **Step 1: Failing tests:** any `amount` in the body is ignored (RPC args never include it); `transactionId` not 8–15 digits → `not_matched` without RPC; feature off → 403; limiter `degraded:true` → still relies on the RPC's DB limits (4th call → `rate_limited`, Review Focus 1); one generic message string for `not_matched`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(momo-claim): manual claim API`.

### Task 10: Wallet page "Send & Claim" tab

**Files:**
- Create: `components/wallet/send-and-claim/send-and-claim-tab.tsx`, `payment-modal.tsx`, `claim-box.tsx`, `how-it-works.tsx`, `lib/momo-claim/view-model.ts`
- Modify: `app/dashboard/wallet/page.tsx` (TABS + render)
- Test: `lib/momo-claim/view-model.test.ts` (`buildSendAndClaimView(sessions, now, modalOpen, hasCredited)` → `{ boxes, generateDisabled, nextSlotFreeAt, guideOpenByDefault }`)

- [ ] **Step 1: Failing view-model tests:** boxes hidden while modal open; one box per open session newest first; generate disabled at 5 with countdown target; guide open until first credited claim.
- [ ] **Step 2–4:** FAIL → implement view-model → PASS.
- [ ] **Step 5: Build the components** per spec 5.1: tab only when `enabled`; unverified prompt linking to phone verification; amount input shows fee and credited amount live (`computeFee`); modal leads with code, MTN number, account name, "type this code in the MoMo reference"; polls GET every 5 s while a session is pending, backing off to 15 s after 2 min; success uses the existing `SuccessModal`; claim box has locked amount, own countdown, transaction-ID field, result copy from Task 9; navy accent, `lg:` two-column, mobile stacked.
- [ ] **Step 6: Verify UI** with headless Chrome at 500px and desktop width (see `reference-headless-screenshots`), light and dark.
- [ ] **Step 7: Commit** `feat(momo-claim): wallet Send & Claim tab`.

### Task 11: Admin APIs

**Files:**
- Create: `app/api/admin/momo-claims/route.ts` (GET list + settings, POST settings, PATCH void/restore/unflag/credit/assign), `app/api/admin/momo-claims/sessions/route.ts` (GET, PATCH force-expire)
- Test: route tests beside each

**Interfaces:**
- Consumes: `verifyAdminAccess`; RPCs `admin_credit_momo_transaction`, `admin_unflag_momo_transaction`; Task 6.
- Produces: GET → `{ transactions (latest 200, filters status/network/q/from/to), counts by status, suspicious: { userId, attempts }[] (≥5 in 24 h), settings }`; PATCH `{ action: "void"|"restore"|"unflag"|"credit"|"assign", transactionId, reason?, targetUserId? }`.

- [ ] **Step 1: Failing tests:** non-admin → 401/403; void only from `pending`/`unparsed` (claimed/flagged → 409); restore only voided → pending; unflag/credit/assign require reason 1–200; `assign` requires `targetUserId` of an existing user; `credit` uses the linked session's user; settings POST validates fees 0–100, min ≥ 0, max ≥ min, account name ≤ 80, allowlist non-empty strings; force-expire is one `UPDATE ... WHERE id = $1 AND status = 'pending'` (0 rows → 409).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(momo-claim): admin APIs`.

### Task 12: Admin alerts

**Files:**
- Modify: `lib/admin-actions/types.ts` (add `"momo_claim"` to `FlowId`), `lib/admin-actions/flows/` (new `momo-claim.ts`), registry wiring
- Test: `lib/admin-actions/flows/momo-claim.test.ts`

**Interfaces:**
- Produces: `type MomoAdminAlert = { kind: "credited" | "flagged" | "unparsed" | "reconciliation_missing"; amountPesewas?: number; txidLast4?: string; reasons?: string[] }`; `notifyMomoAdmins(alert: MomoAdminAlert): Promise<void>` (push + email via the existing notifier; never includes full txid, payer name or raw SMS).

- [ ] **Step 1–4:** failing test that the alert body contains only last-4 txid and no name → implement → PASS.
- [ ] **Step 5: Commit** `feat(momo-claim): admin alerts`.

Note: Task 7 depends on this type; implement Task 12 before Task 7 (execution order below).

### Task 13: Admin page and sidebar

**Files:**
- Create: `app/admin/momo-claims/page.tsx` + components under `app/admin/momo-claims/_components/`
- Modify: `components/layout/sidebar.tsx` (admin link "MoMo Claims" with `<NewTag>` + `markClicked()` as for `/admin/sms`), `lib/nav-new.ts` (`"/admin/momo-claims": { since: "<build date>" }`)

- [ ] **Step 1: Build tabs** Monitoring (stat cards, search/filters, table, Void/Restore/Unflag/Approve & credit/Assign to user with confirm + reason dialogs, raw-SMS dialog, suspicious list, unparsed filter), Payment Sessions (force-expire), Reconciliation (Task 14), Settings.
- [ ] **Step 2: Verify UI** headless at 500px and desktop.
- [ ] **Step 3: Commit** `feat(momo-claim): admin page`.

### Task 14: Statement reconciliation

**Files:**
- Create: `lib/momo-claim/reconcile.ts`, `app/api/admin/momo-claims/reconcile/route.ts`
- Test: `lib/momo-claim/reconcile.test.ts`

**Interfaces:**
- Produces: `extractStatementTxids(csv: string, column: string): string[]`; `findMissingClaims(claimed: { transactionId: string; claimedAt: string }[], statementTxids: Set<string>, period: { start: string; end: string }): string[]`.

- [ ] **Step 1: Failing tests:** claimed IDs inside the period absent from the statement are returned; IDs outside the period ignored; quoted CSV fields and BOM handled.
- [ ] **Step 2–4:** FAIL → implement → PASS. Route: admin only, accepts CSV text + column name + period, stores a `momo_reconciliation_runs` row, alerts on missing IDs. Column name is chosen in the UI from the CSV header (real MTN export not yet seen).
- [ ] **Step 5: Commit** `feat(momo-claim): statement reconciliation`.

### Task 15: Verification and merge

- [ ] **Step 1:** Dispatch a separate security-review agent with the goals from the build guide's Prompt 5 (no-session claim, browser amount, concurrent double credit, lock order, attempt-cap poisoning, EXECUTE grants, window exposure, transaction-ID guessing) plus: forged SMS paths, flagged rows unclaimable, admin credit double-pay. Fix confirmed findings with failing tests first.
- [ ] **Step 2:** `npx tsc --noEmit`, `npm run lint`, `npx vitest run` (expect only the 9 known order-health failures), placeholder-env `next build`.
- [ ] **Step 3:** Check local main for other sessions' commits, merge the branch locally, re-run Step 2 on main, normal push, watch the Vercel deploy.
- [ ] **Step 4: Owner launch gates (feature stays OFF until all pass):** real SMS samples (MTN, Telecel→MTN, AT→MTN, no reference) added to `parse-sms.test.ts` and patterns fixed; `SMS_FORWARD_SECRET` set in Vercel; SmsForwarder rule `PHONE_NUM EQUALS MobileMoney` + contains `GHS`, `received for`, `Transaction ID`; header confirmed arriving; fake SMS from another phone does not arrive; supervised real payment end to end; then set `momo_claim_enabled` to `{"value": true}`.
- [ ] **Step 5:** Update memory (`project-send-and-claim.md`) with commit, migration status and switch state.

## Execution order

1 → 2 → 3 → 4 → 5 (owner gate) → 6 → 12 → 7 → 8 → 9 → 10 → 11 → 14 → 13 → 15.
