# Developer API v2 — Plan 4: Airtime and Utility Bills (Commission key)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a commission-key developer buy airtime (`POST /airtime/purchase`, order lookup and list) and pay utility bills (`GET /utilities/billers`, `POST /utilities/lookup`, `POST /utilities/pay`, order lookup), with client-supplied idempotent references, full documentation and sandbox parity, by wrapping the existing airtime and bills engines.

**Architecture:** v2 does NOT reimplement pricing, cashback, provider routing or fulfillment: it calls `purchaseAirtime` (lib/airtime-service.ts, channel `"api"`) and `payBill`/`verifyBill` (lib/bills/service.ts, channel `"api"`) exactly as the v1 routes do. What v2 adds is a new atomic idempotency layer in front of them: a claim table `api_v2_idempotency` (unique on user, kind, reference) written BEFORE the engine is called, so a retry, a concurrent duplicate or a timeout-and-resend can never reach the engine twice. Pure decision logic lives in `lib/api-v2/`, routes are thin wrappers over `withV2` (`requiredType: "commission"`).

**Tech Stack:** Next.js 15 route handlers, Supabase (service role), Postgres, Vitest (fake-client pattern), the docs registry from plan 2.

**Spec:** `docs/superpowers/specs/2026-10-22-developer-api-v2-design.md`. Prior plans: 1 foundation, 2 console and docs kit, 3 data/wallet/orders (all live, v2 dark).

**Risk tier (feedback-review-gates):** Tier 1 (money, schema, new table). Mandatory fresh most-capable-model whole-branch reviewer, a database-reviewer pass on the migration, the abuse-case pass, failing tests first, and the prod change protocol.

## Why an idempotency layer (facts found in the code, 2026-10-24)

- `purchaseAirtime` accepts NO client reference. Its only duplicate protection is a check-then-act 30-second look-back on (user, phone, amount) that is not atomic: two concurrent identical requests can both pass it. It debits with the `deduct_wallet` RPC, then inserts the order in a SEPARATE statement, and on insert failure it "refunds" by writing `balance = balanceBefore` (a read-modify-write that can clobber a concurrent debit). These are existing behaviours shared with the dashboard, v1 and bots and are OUT OF SCOPE to change here; v2 must simply never let two requests with the same reference reach the engine, and must report an ambiguous outcome honestly.
- `payBill` is already strong: single-use `verify_token`, atomic `debitOrder` RPC, and an API-channel retry path (`findApiOrderByTokenHash`) that returns the original order. v2 still claims the client reference first for uniform semantics.
- Fulfillment for both engines runs INSIDE the request (airtime awaits `triggerAirtimeFulfillment`; bills dispatch in `payBill`), so v2 needs no `after()` scheduling for this plan.

## Datagod invariants this plan touches (feedback-business-logic-guardrails)

- Prices come from the engine (role fee/cashback quote); the request carries no price field except `expected_pay` (the price the client was shown; mismatch => 409 `price_changed` before any debit, exactly like v1).
- Network prefix validation, admin network/amount gates and airtime provider routing stay inside `purchaseAirtime` (unchanged).
- The account phone gate (`checkPhoneVerified`, fail closed) applies to live purchases and bill payments as on v1.
- API surface switch: v1 bills/bundles return 403 `not_available` when the admin cashback API surface is off (`readApiSurface`). v2 bill endpoints follow the same gate for live keys.
- Refund/failed semantics: failed orders are refunded by the existing admin/refund machinery; v2 only reports status.
- Bulk-style chunking: lists are capped at 30 rows and fetched with at most one `.in()` of 30 ids.

## Global Constraints

- v1 untouched: no edits to `app/api/v1/**`, `lib/api-auth.ts`, `lib/airtime-service.ts`, `lib/bills/*.ts` (the engines), or existing migrations. v2 may import their exported functions and may import pure helpers from `lib/api-v1/bills.ts` (sandbox verify/token helpers) read-only.
- Envelope and key rules from plan 1. Endpoints require `requiredType: "commission"`; a standard key gets 403 (wrong type) and a commission key on a data endpoint gets 403.
- Idempotency (client `reference`, REQUIRED, 3-100 chars, same rules as data orders via `parseReference`): same reference + same request => HTTP 200 `{ order, replayed: true }`, no second engine call; same reference + different request => 409 `REFERENCE_REUSED`; same reference while the first request is still running => 409 `REQUEST_IN_PROGRESS`; same reference after an AMBIGUOUS engine outcome => 409 `OUTCOME_UNKNOWN` (never retried automatically; surfaced for admin reconciliation). The claim row is written before the engine call and finalised after it.
- Claim finalisation rules: engine success => `done` with the allow-listed order JSON; an engine error with a known NO-CHARGE code (validation, gates, `INSUFFICIENT_BALANCE`, `PRICE_CHANGED`, `NETWORK_MISMATCH`, `NETWORK_DISABLED`, `INVALID_AMOUNT`, `DUPLICATE_REQUEST` raised BEFORE debit) => claim DELETED so the client may retry the same reference after fixing the cause; any other/unknown error (`PAYMENT_FAILED`, `ORDER_CREATE_FAILED`, unexpected exceptions, a thrown error after the engine returned) => claim set to `unknown` and kept. The classification is a pure tested function; unknown codes default to AMBIGUOUS (fail safe).
- The request hash is `sha256` over a canonical JSON of the normalised request (network canonical, recipient LOCAL form, amount in integer pesewas, `expected_pay` excluded because it is advisory; bills: `verify_token` hash + amount in pesewas). Only the hash is stored, never the body.
- Order objects are allow-lists. Airtime: `{ reference, network, recipient, airtime_amount, fee_amount, total_paid, cashback, status, created_at }`. Bill: `{ reference, biller, account, customer_name, face_amount, paid_amount, cashback, status, created_at }` where `reference` is the CLIENT reference (not the engine's internal `reference_code`; return the engine code separately as `provider_reference`? NO: never expose it). Status mapping airtime/bills DB -> API: pending -> `pending`, processing -> `processing`, completed -> `completed`, failed -> `failed`, refunded -> `refunded`, anything else -> `processing`.
- Rate limits: airtime/pay/lookup use group `purchase` (default 10/min) with `failClosedWhenLimiterDegraded: true`; billers/order lookups/lists use `status`. No new limit group is added in this plan.
- Sandbox (`test` keys): same parsing, replay semantics (claims are NOT used; `getSandboxOrder` keyed by the client reference), then `placeSandboxOrder` with `apiV2KeyId` and action `airtime` / `utility_bill`; never calls the engines or touches wallets/provider. Bills sandbox reuses the v1 sandbox verify/token helpers (read-only import from `lib/api-v1/bills.ts`).
- Logs: no recipient numbers, account/meter numbers, verify tokens or bodies. Fixed generic error messages; machine codes prefixed in `message` (e.g. `REFERENCE_REUSED: ...`).
- Edit with Edit/Write tools, never `sed`. Real `next build` before pushing main. Every migration: precheck, dry run built by CODE that asserts the run string contains no `COMMIT`/`END;` and ends in a RAISE (lesson from the 0130 incident: never trust a regex-stripped dry run), user OK, apply, verify. Unique test phone numbers per file.

## Review Focus

- Two identical concurrent airtime requests with the same reference: exactly one engine call (claim unique violation for the loser => replay/IN_PROGRESS), never two debits.
- Two DIFFERENT references with the same recipient and amount inside 30 s: the engine's own `DUPLICATE_REQUEST` fires for the second; it must map to 409 with NO claim left behind for the loser (no charge) and the first order untouched.
- Engine throws after debiting (`ORDER_CREATE_FAILED` after `deduct_wallet`, or any exception after the debit): claim becomes `unknown`, response is a generic 500/409 `OUTCOME_UNKNOWN`, a retry with the same reference NEVER re-calls the engine.
- Engine throws a no-charge code (`INSUFFICIENT_BALANCE` etc.): claim deleted, same reference usable again after a top-up; verify that a concurrent retry cannot slip between the engine throw and the delete and charge twice (the delete happens before the response; a retry racing earlier sees `in_progress`).
- Claim stuck `in_progress` (function killed mid-call): retries get 409 `REQUEST_IN_PROGRESS` while fresh and 409 `OUTCOME_UNKNOWN` once older than 10 minutes; never a second engine call.
- Reference belonging to ANOTHER user never collides or leaks (unique per user; lookups filtered by user).
- Price tampering: no price/fee/total fields accepted (rejected like data orders); `expected_pay` only advisory.
- Airtime amount edge cases: `"5"`, `5.5`, `0`, negative, NaN, `1e3`, 3 decimals, above the engine max, below the min; network spellings (`MTN`, `Telecel`, `AT`, `AirtelTigo`, lowercase); recipient forms as in plan 3; a Telecel number sent as MTN (engine NETWORK_MISMATCH).
- Bills: unknown biller, disabled biller (503), amount outside the admin min/max, verify token reuse across references (same token + same amount + a NEW reference must not create a second order: engine returns the original order => must be reported as REFERENCE_REUSED or replay of the original claim, never a second debit), token from another user, expired token, sandbox token on a live key and vice versa, ECG meter list vs add-meter flow, Ghana Water email/phone requirements.
- Surface switch off: live bill endpoints return the v1-style not-available behaviour (403) without leaking config.
- Order lookup/list: owner-scoped through the claim table; a foreign or missing reference gives the identical 404; list capped at 30 newest.

---

### Task 1: Migration `0132` — `api_v2_idempotency`

**Files:**
- Create: `migrations/0132_api_v2_idempotency.sql` (next free number at execution time) and `migrations/0132_api_v2_idempotency.selftest.sql` (NOT a migration)

**Interfaces:**
- Produces (SQL): table `public.api_v2_idempotency(id uuid pk default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, api_v2_key_id uuid not null references api_v2_keys(id) on delete no action, kind text not null check (kind in ('airtime','bill')), reference text not null check (char_length(reference) between 3 and 100), request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'), status text not null default 'in_progress' check (status in ('in_progress','done','unknown')), order_ref text, response jsonb, created_at timestamptz not null default now(), completed_at timestamptz, unique (user_id, kind, reference))`; indexes on `(user_id, kind, created_at desc)` and `(status, created_at)` where `status <> 'done'`; RLS enabled, `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, no policies; a CHECK that `done` rows have `order_ref` and `response` non-null.
- Idempotent (`IF NOT EXISTS` / guarded constraints), one transaction with `BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s'; ... COMMIT;`, header in the 0128/0130 style. The selftest is a ready-to-run DO block that, inside an always-raising block, inserts a claim for an existing admin user and a throwaway v2 key row, asserts the unique constraint rejects a duplicate (user, kind, reference), the same reference with another `kind` is allowed, the status CHECK and the done-needs-order CHECK reject bad rows, and `anon`/`authenticated` hold no privileges; it ends with `RAISE EXCEPTION 'SELFTEST_OK ...'`.

- [ ] **Step 1: Precheck (read-only on prod):** confirm the next free migration number, that `api_v2_keys` exists, and that no table named `api_v2_idempotency` exists.
- [ ] **Step 2: Write both files.** Do not apply (Task 8).
- [ ] **Step 3: Commit** `feat(api-v2): idempotency claim table for commission endpoints`

---

### Task 2: Commission rules (pure) — `lib/api-v2/commission.ts`

**Files:**
- Create: `lib/api-v2/commission.ts`; Test: `lib/api-v2/commission.test.ts`

**Interfaces:**
- Consumes: `parseReference`, `normalizeRecipient`, `mapOrderStatus`-style conventions from `lib/api-v2/data-orders.ts`.
- Produces: `type AirtimeNetwork = "MTN" | "Telecel" | "AT"`; `parseAirtimeNetwork(v: unknown): { ok: true; network: AirtimeNetwork; engineNetwork: "MTN" | "AT" | "Telecel" } | { ok: false; error: string }` (accepts `MTN`, `Telecel`, `AT`, `AirtelTigo` case-insensitively; engine receives `AT` for AT/AirtelTigo); `parseAmountPesewas(v: unknown, opts?: { max?: number }): { ok: true; pesewas: number; amount: number } | { ok: false; error: string }` (number or numeric string, at most 2 decimals, > 0, finite, `max` default 1000 for airtime, no exponent forms); `interface AirtimeInput { network; engineNetwork; recipient: { msisdn; local }; amount: number; pesewas: number; reference: string; expectedPay?: number }`; `parseAirtimeBody(body: unknown): { ok: true; value: AirtimeInput } | { ok: false; error: string }` (fields `network`, `recipient`, `amount`, `reference`, optional `expected_pay`; rejects the forbidden price-like/ownership fields case-insensitively as in data orders plus `fee`, `fee_amount`, `total_paid`, `cashback`, `pay_separately`); `interface BillPayInput { verifyToken: string; amount: number; pesewas: number; reference: string; expectedPay?: number }`; `parseBillPayBody(body: unknown)` (fields `verify_token` string 10-4000 chars, `amount`, `reference`, optional `expected_pay`); `parseBillLookupBody(body: unknown): { ok: true; biller: BillerKey; inputs: ... } | { ok: false; error }` reusing the v1 shape (`biller`, `account`, `phone`, `email`, `broadband_account`, `add_meter`, `consent`) via `lib/api-v1/bills.ts` `parseVerifyBody` ONLY if it is a pure function there, else re-implement; `requestHash(kind: "airtime" | "bill", canonical: object): string` (sha256 hex of a stable key-sorted JSON); `airtimeHash(i: AirtimeInput): string`, `billHash(i: BillPayInput): string` (verify token hashed first, `expectedPay` excluded); `mapCommissionStatus(db: unknown): "pending"|"processing"|"completed"|"failed"|"refunded"`; `mapAirtimeOrder(row, clientReference: string)` and `mapBillOrder(row, clientReference: string)` (allow-lists above; money rounded to 2dp; `cashback` 0 when absent; `recipient` LOCAL form); `type EngineErrorClass = "no_charge" | "ambiguous"`; `classifyEngineError(code: unknown): EngineErrorClass` (`no_charge` for NETWORK_DISABLED, NETWORK_MISMATCH, INVALID_AMOUNT, AMOUNT_TOO_LOW/HIGH-style gate codes read from lib/airtime-service gates, DUPLICATE_REQUEST, PRICE_CHANGED, INSUFFICIENT_BALANCE; everything else including undefined `ambiguous`); `airtimeErrorResponse(e)`/`billErrorResponse(r)` mapping engine errors/results to `{ status, message }` using the SAME status table as v1 (`NETWORK_DISABLED` 503, `NETWORK_MISMATCH` 400, `INVALID_AMOUNT` 400, `DUPLICATE_REQUEST` 409, `PRICE_CHANGED` 409 with the quote fields, `INSUFFICIENT_BALANCE` 402 with `required`, `PAYMENT_FAILED`/`ORDER_CREATE_FAILED` 500) and fixed messages.

- [ ] **Step 1: Write failing tests** for every edge in Review Focus that is pure: network spellings and the AT mapping; amount forms (`"5"`, `5.5`, `5.55`, `5.555`, `0`, `-1`, `NaN`, `"1e3"`, `"5 "`, `1000.01`, huge) ; recipient reuse of normalizeRecipient; forbidden-field rejection incl. case variants and `fee_amount`; reference rules; `airtimeHash` is stable across key order and equal for `"0244000001"`/`"233244000001"`/`"+233244000001"` and differs for different amount/network/recipient; `billHash` ignores `expected_pay`; status mapping incl. unknown; both order mappers return exactly their allow-list keys even if the row carries internal columns (`id`, `user_id`, `notes`, `hubtel_client_reference`, `failure_reason`, provider fields); `classifyEngineError` returns `no_charge` for each listed code and `ambiguous` for `PAYMENT_FAILED`, `ORDER_CREATE_FAILED`, `undefined`, `""`, a number and an unlisted string.
- [ ] **Step 2: Run** `npx vitest run lib/api-v2/commission.test.ts` — FAIL. **Step 3: Implement. Step 4: Run** — PASS. **Step 5: Commit** `feat(api-v2): commission request rules`

---

### Task 3: Idempotency store — `lib/api-v2/idempotency.ts`

**Files:**
- Create: `lib/api-v2/idempotency.ts`; Test: `lib/api-v2/idempotency.test.ts` (fake client)

**Interfaces:**
- Consumes: `SupabaseLike` from `lib/api-v2/store.ts`.
- Produces: `type ClaimKind = "airtime" | "bill"`; `type ClaimOutcome = { kind: "claimed"; claimId: string } | { kind: "replay"; orderRef: string; response: unknown } | { kind: "conflict" } | { kind: "in_progress" } | { kind: "unknown" } | { kind: "error" }`; `claimRequest(client, p: { userId; apiV2KeyId; kind; reference; requestHash }, now?: () => number): Promise<ClaimOutcome>` (INSERT; on `23505` read the existing row filtered by user, kind and reference: different hash => `conflict`; `done` with same hash => `replay`; `done` with a different hash => `conflict`; `in_progress` younger than 10 minutes => `in_progress`, older => `unknown`; `unknown` => `unknown`; any read/other error => `error`; never throws); `completeClaim(client, claimId, orderRef, response): Promise<boolean>` (guarded `UPDATE ... WHERE id = $1 AND status = 'in_progress'`); `releaseClaim(client, claimId): Promise<boolean>` (DELETE guarded by `status = 'in_progress'`); `markClaimUnknown(client, claimId): Promise<boolean>`; `getClaimByReference(client, userId, kind, reference): Promise<{ orderRef: string | null; status: string; response: unknown } | null>`; `listClaims(client, userId, kind, limit = 30): Promise<{ reference: string; orderRef: string | null; status: string }[]>` (newest first, hard cap 30).

- [ ] **Step 1: Write failing tests** with a fake that models the unique constraint: first claim ok; duplicate same hash while `in_progress` => `in_progress`; after `completeClaim` => `replay` with the stored response; duplicate different hash => `conflict`; stale `in_progress` (clock advanced 11 minutes) => `unknown`; `releaseClaim` removes only an `in_progress` row (a `done` row survives a release attempt); `completeClaim` after a release returns false; every function swallows a transport error and returns the failure value; every query filters by `user_id` (assert the filters); `getClaimByReference` for another user's reference returns null; `listClaims` caps at 30 even when asked for 500.
- [ ] **Step 2–4:** FAIL, implement, PASS. **Step 5: Commit** `feat(api-v2): idempotency claim store`

---

### Task 4: Airtime endpoints

**Files:**
- Create: `lib/api-v2/endpoints/airtime.ts`, `lib/api-v2/endpoints/airtime.test.ts`, `lib/api-v2/endpoints/airtime-deps.ts`
- Create routes: `app/api/v2/airtime/purchase/route.ts`, `app/api/v2/airtime/orders/route.ts`, `app/api/v2/airtime/orders/[reference]/route.ts`

**Interfaces:**
- Consumes: Tasks 2-3, `V2Context`, `withV2`, `purchaseAirtime` (lib/airtime-service.ts), `checkPhoneVerified`, `placeSandboxOrder`/`getSandboxOrder`/`getSandboxOrdersByReferences` (lib/sandbox.ts), `getAdminClient`.
- Produces: `AirtimeDeps = { claim; complete; release; markUnknown; getClaim; listClaims; engine: (p: { userId; network; beneficiaryPhone; airtimeAmount; expectedPay? }) => Promise<PurchaseAirtimeResult>; getOrderByCode(userId, code): Promise<AirtimeOrderRow | null>; getOrdersByCodes(userId, codes: string[]): Promise<AirtimeOrderRow[]>; phoneGate(userId): Promise<boolean>; sandbox: {...}; now(): number }` and handlers `purchaseAirtimeHandler`, `airtimeOrderHandler`, `airtimeListHandler`.
- Contracts: `POST /airtime/purchase` (commission key, group `purchase`, fail closed) body `{ network, recipient, amount, reference, expected_pay? }` returns 201 `{ order, new_balance }` for a new order, 200 `{ order, replayed: true }`, 400 invalid, 402 insufficient (with `required`), 403 phone gate, 409 `REFERENCE_REUSED` / `REQUEST_IN_PROGRESS` / `OUTCOME_UNKNOWN` / `price_changed` (with `quote`), 503 network disabled or limiter degraded. Order of operations (live): parse -> `claimRequest` (replay/conflict/in-progress/unknown decided here, BEFORE the phone gate so replays still answer) -> phone gate (a block releases the claim and returns 403) -> `engine(...)` -> on success `completeClaim` with the mapped order and return 201 -> on engine error classify: `no_charge` releases the claim and maps the error, `ambiguous` marks the claim `unknown` and returns a generic 500 whose message tells the client the outcome is unknown and to NOT resend with a new reference (reconcile via `GET /airtime/orders/{reference}` or support). If `completeClaim` fails after a successful engine call, return 201 anyway (the money moved) and log a PII-free line; the claim stays `in_progress` and later reads as `unknown`. `GET /airtime/orders/{reference}` (group `status`): claim -> order via `getOrderByCode`; 404 identical for missing/foreign/in-progress-without-order; `GET /airtime/orders` returns up to 30 newest via `listClaims` + one `getOrdersByCodes`. Sandbox (test key): same parsing, `getSandboxOrder(user, reference)` replay (same content => 200 replayed, different => 409), else `placeSandboxOrder({ action: "airtime", apiV2KeyId, price: amount })`; the sandbox lookup/list use the sandbox store.

- [ ] **Step 1: Write failing tests** (money first) with fake deps: a new purchase calls `claim` once then `engine` once with the SERVER-normalised network/recipient/amount, then `complete`, never `release`; replay returns 200 with NO `engine` and NO phone gate call; conflict returns 409 with no engine call; in_progress and unknown return 409 with no engine call; phone gate false => 403, `release` called, `engine` never; engine throws `INSUFFICIENT_BALANCE` => 402, claim released; throws `DUPLICATE_REQUEST` => 409, claim released; throws `PRICE_CHANGED` => 409 with the quote fields and claim released; throws `PAYMENT_FAILED`/`ORDER_CREATE_FAILED`/an unknown error/a non-Error => claim marked unknown, generic 500, `release` NOT called; `complete` returning false after engine success still returns 201; body price/fee fields rejected before any dependency call; `expected_pay` mismatch is the engine's job (assert it is passed through); order lookup/list owner-scoped and identical 404; list capped at 30; sandbox path never calls claim/engine/phoneGate and replays correctly; every order object has exactly the allow-listed keys.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** handlers, `airtime-deps.ts` (real wiring: `purchaseAirtime` with `channel: "api"`, `checkPhoneVerified(admin, userId)` fail closed), and the three thin routes (`requiredType: "commission"`, `failClosedWhenLimiterDegraded` on purchase, `dynamic = "force-dynamic"`, `maxDuration = 60`).
- [ ] **Step 4: Run** tests + `npx tsc --noEmit -p . 2>&1 | grep -E "api-v2|api/v2"` (empty). **Step 5: Commit** `feat(api-v2): airtime purchase, lookup and list endpoints`

---

### Task 5: Utility bills endpoints

**Files:**
- Create: `lib/api-v2/endpoints/bills.ts`, `lib/api-v2/endpoints/bills.test.ts`, `lib/api-v2/endpoints/bills-deps.ts`
- Create routes: `app/api/v2/utilities/billers/route.ts`, `app/api/v2/utilities/lookup/route.ts`, `app/api/v2/utilities/pay/route.ts`, `app/api/v2/utilities/orders/[reference]/route.ts`

**Interfaces:**
- Consumes: Tasks 2-3; `getBillsRuntime()` (lib/bills/runtime.ts) for `{ deps, db }`; `verifyBill`, `payBill`, `BILLERS`, `normaliseInputs` (lib/bills); `readApiSurface`/`NOT_AVAILABLE_BODY` (lib/api-v1/surface.ts, read-only import); sandbox helpers (`sandboxVerify`, `parseSandboxToken`, `sandboxBillReference` from lib/api-v1/bills.ts, read-only); `checkPhoneVerified`.
- Contracts: `GET /utilities/billers` (group `status`) lists every biller with `{ key, label, enabled, min_amount, max_amount, inputs: [...] }` from `getBillsConfig` (enabled false when the admin disabled it or bills are globally off), never fails the whole list on one biller; `POST /utilities/lookup` (group `purchase`, body per `parseBillLookupBody`) calls `verifyBill` for live keys (surface gate first: `readApiSurface` closed => 403 `not_available`; phone gate NOT required for lookup) and returns `{ customer_name, amount_due, suggested_amount, verify_token }` or the ECG `meters` list exactly as v1's `verifyResponse` shapes it (reuse that pure function), 502 when the provider is unreachable, 503 when the biller/bills are disabled; `POST /utilities/pay` (group `purchase`, fail closed) body `{ verify_token, amount, reference, expected_pay? }`: parse -> claim (replay/conflict/in-progress/unknown BEFORE the gates so replays answer) -> surface gate (closed => release claim, 403) -> phone gate (blocked => release claim, 403) -> `payBill(deps, userId, token, amount, expectedPay, { channel: "api" })`: `ok` => complete the claim with the mapped bill order and return 201 (or 200 `replayed: true` if the engine returned a prior order for the same token whose claim reference differs: then do NOT create a second claim; return 409 `REFERENCE_REUSED: this verification already paid another reference` and release this claim), `!ok` with 4xx statuses => release the claim and map status/message (409 with `quote` => `price_changed`), 5xx or thrown => mark `unknown` and return the generic outcome-unknown 500; `GET /utilities/orders/{reference}` via the claim -> bill order by `reference_code`, owner-scoped, identical 404. Sandbox: `sandboxVerify` for lookup; pay uses `parseSandboxToken`, `sandboxBillReference(token)` as the sandbox order reference BUT is also keyed by the client `reference` for replay (store the client reference in `request`, look up by client reference first via `getSandboxOrder`), `placeSandboxOrder({ action: "utility_bill", apiV2KeyId })`.

- [ ] **Step 1: Write failing tests** with fake deps: billers list shows enabled/min/max and a disabled biller as `enabled: false`; lookup passes the normalised inputs to `verifyBill`, never echoes the token into logs, surface closed => 403 with no provider call; pay happy path claims, runs the gates in order, calls `payBill` once with `channel "api"`, completes the claim; replay returns 200 with no gate/engine calls; same reference + different amount => 409; same token + NEW reference after a completed order => 409 REFERENCE_REUSED, no new claim left behind, no second debit; engine 4xx (`Price updated`, insufficient, invalid amount, expired token) releases the claim and maps status; engine 5xx/throw marks unknown; surface/phone gate block releases the claim; order lookup identical 404; every order has exactly the bill allow-list keys; sandbox lookup/pay/replay never touch the engine or claims; a sandbox token on a live key and a live token on a test key are rejected with 400.
- [ ] **Step 2–4:** FAIL, implement handlers + `bills-deps.ts` + four thin routes (`requiredType: "commission"`; pay and lookup group `purchase`, pay fail closed; `maxDuration = 60`), PASS, tsc clean. **Step 5: Commit** `feat(api-v2): utility bill lookup, payment and order endpoints`

---

### Task 6: Documentation

**Files:**
- Modify: `lib/api-v2/docs/registry.ts`, `lib/api-v2/docs/registry.test.ts`

**Interfaces:**
- Consumes: Tasks 4-5 contracts. Produces: a "Commission" section group with seven endpoints (`airtime/purchase`, `airtime/orders`, `airtime/orders/{reference}`, `utilities/billers`, `utilities/lookup`, `utilities/pay`, `utilities/orders/{reference}`) and prose "Idempotency and references (airtime and bills)" explaining the claim semantics (REFERENCE_REUSED, REQUEST_IN_PROGRESS, OUTCOME_UNKNOWN and what to do), "Airtime pricing" (the order returns the real `total_paid`, `fee_amount` and `cashback` for the key owner's role; there is no fixed face-value guarantee), and "Bill payment flow" (lookup then pay, verify_token is single-use, the price-changed 409). The key-types prose and the Authentication section must now say that commission keys unlock these endpoints.

- [ ] **Step 1: Write failing tests:** every new endpoint documents params, a request example, a success example whose keys equal the mapper allow-lists (import `mapAirtimeOrder`/`mapBillOrder` key sets), the REAL error set (400, 402, 403 variants via the exported constants, 404, 409 codes, 429, 503), the correct rate-limit string and key type `commission`; every documented machine code (`REFERENCE_REUSED`, `REQUEST_IN_PROGRESS`, `OUTCOME_UNKNOWN`, `PHONE_NOT_VERIFIED`, `price_changed`) appears and exists in the handler constants; the docs state sandbox behaviour; the status list equals `mapCommissionStatus`'s outputs.
- [ ] **Step 2–4:** FAIL, write the entries with realistic Ghana examples, PASS. **Step 5: Commit** `docs(api-v2): document airtime and utility bills`

---

### Task 7: Apply, verify, review, ship

**Files:** none new.

- [ ] **Step 1: Migration 0132 protocol:** read-only precheck; build the dry-run string IN CODE with hard assertions (no `COMMIT`, no bare `END;`, an explicit `BEGIN`, ends in a `SELFTEST_OK` raise) and run it only after the assertions pass; confirm afterwards nothing persisted; show the user the result and WAIT for their explicit OK; apply; verify the table, unique constraint, RLS on, no grants to `anon`/`authenticated`, and an anon REST read is denied.
- [ ] **Step 2: Local verification in the clean worktree** (`../Datagod2-verify`, never the main checkout): full `npx vitest run` (only the nine known order-health failures and the load-flaky AFA test may fail) and a real placeholder-env `next build` exit 0 listing the seven new routes.
- [ ] **Step 3: Reviews (Tier 1):** database-reviewer pass on 0132, then a fresh most-capable-model whole-branch reviewer briefed with this plan's Review Focus, the diff and the ledger; ask it specifically what the change removed or loosened and to walk the free / twice / someone else's / cheaper / no-auth / at-scale cases for all seven endpoints, including the engine's non-atomic internals; fix confirmed findings in ONE wave with failing tests first, then one scoped re-review.
- [ ] **Step 4: Merge** per the protocol (fetch; if `origin/main` moved merge it in the worktree and rebuild; push; watch every recent deployment until READY); unauthenticated live probes of all seven routes (401 envelope) and v1 unchanged.
- [ ] **Step 5: Supervised live check (v2 dark until you enable it):** with the user logged in as admin, enable v2 for `admin`, generate a TEST commission key, then with curl: sandbox airtime (new 201, same again 200 replayed, same reference different amount 409), lookup/pay a sandbox bill and replay it, order lookup and list; confirm the sandbox balance moves and the REAL wallet and `airtime_orders` do not. Only with the user's explicit OK and an approved live commission key: ONE real minimum airtime purchase to a number they name, checking wallet debit, the `airtime_orders` row, fulfillment, final status and the idempotency row, then resend the same reference and confirm a 200 replay with no second debit. Then switch v2 back off.
- [ ] **Step 6: Update memory** (`project-api-v2-foundation`: plan 4 shipped, claim-table design, what plan 5 picks up).

## Out of scope (recorded for later)

Admin stats attribution for airtime and bills revenue (a follow-up migration extending the stats functions through the claim table); a reconciler for `in_progress`/`unknown` claims (belongs with the stuck-order sweeper in plan 3b); fixing the engine's non-atomic order insert/refund path (shared with the dashboard, v1 and bots); webhooks; a dedicated rate-limit group for lookups.
