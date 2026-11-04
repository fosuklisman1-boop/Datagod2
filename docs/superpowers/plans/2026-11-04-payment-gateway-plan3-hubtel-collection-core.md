# Payment Gateway — Plan 3: Hubtel collection core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything needed to take and confirm a Hubtel payment — relay routes, a client, a payment record, a callback and a 5-minute sweep — ending in Plan 2's shared `handleChargeSuccess` / `handleChargeFailed`. Nothing calls it yet; no surface can choose Hubtel until Plan 4.

**Architecture:** Every Hubtel call goes through the DigitalOcean relay (fixed whitelisted IP). A new `hubtel_payments` table holds one row per Hubtel payment, keyed by an opaque reference. Confirmation never trusts a callback: it calls the status check through the relay, checks the amount, takes an atomic per-reference claim, and only then calls the shared handler.

**Tech Stack:** Next.js 15 route handlers, Supabase (service role), Vitest, the relay (`scripts/hubtel-relay/`, `lib/ussd-hubtel/relay-handler.ts`).

**Spec:** `docs/superpowers/specs/2026-11-04-hubtel-payment-gateway-design.md`. API text: `docs/hubtel-payments/01-online-checkout.txt`, `03-direct-receive-money.txt`.

**Plan 3 of 5.** Base: `feat/payment-gateway` after Plan 2 (`ceeae59d` or later).

## Global Constraints

- **References are opaque** (owner rule): every Hubtel `clientReference` is 32 lowercase hex characters, with no prefix and no surface or product word. One generator, used everywhere.
- **Never trust a callback.** A callback only names a reference. Paid or failed is decided by the status check through the relay (`GET /status?clientReference=`), never by the callback body.
- **Fulfil only on** status check `data.status === "Paid"` and `round(data.amount × 100) >= hubtel_payments.amount_pesewas`. `Unpaid` older than the payment's expiry → failed. `Refunded` → failed and admins alerted. Anything else (404, relay error, unknown status) → leave pending, retry later.
- **Exactly once:** before calling the shared handler, claim the row with a single conditional update (`status = 'pending'` → `'confirming'`). Only the caller whose update affected a row continues. A row stuck in `confirming` longer than 10 minutes may be reclaimed by the sweep.
- **Classification of a Hubtel start response** (used by Plan 4's fallback):
  - `refused` (safe to fall back): HTTP 4xx from Hubtel, response codes `4000`, `4070`, `4101`, `4103`, or the relay unable to reach Hubtel before sending.
  - `accepted`: `0001` (receive money) or `0000` with a `checkoutUrl` (checkout).
  - `unknown` (never fall back; wait for status check): `0005`, `5000`, HTTP 5xx, timeouts or a dropped connection after the request was sent.
- **No cards:** a Paid status check whose `paymentMethod` is not `mobilemoney` (or a wallet type) is not fulfilled; mark `needs_review` and alert admins.
- Hubtel credentials live only on the relay droplet. Vercel holds `HUBTEL_RELAY_URL`, `HUBTEL_RELAY_SECRET`, `HUBTEL_PAYMENTS_CALLBACK_SECRET` (new, at least 32 chars), `HUBTEL_COLLECTION_ACCOUNT` (account number only).
- Callback URL carries `?ref=<reference>&sig=<HMAC>`; reuse `signRef` / `verifySig` from `lib/hubtel-cs/callback.ts`. The callback route answers 200 to everything that isn't a bad signature, so Hubtel stops retrying.
- Prod change protocol for the migration and relay redeploy: dry run, owner OK, apply, verify. Relay redeploy keeps a dated backup on the droplet as on 2026-10-22.
- Edit/Write tools for code. `next build` from PowerShell.

## Review Focus

1. **Callback and sweep arriving together** — exactly one shared-handler call. Task 4.
2. **Hubtel says Paid with less than we asked** — not fulfilled, admins alerted. Task 4.
3. **Status check returns 404 or the relay times out** — stays pending; no failure, no fulfilment. Task 4.
4. **A forged callback** (wrong sig, or a valid sig for another reference) — 401, no status check. Task 5.
5. **A reference that exists only in the callback** (no `hubtel_payments` row) — ignored, logged, 200. Task 5.

---

### Task 1: `hubtel_payments` table + opaque reference

**Files:**
- Create: `migrations/0151_hubtel_payments.sql`, `migrations/0151_hubtel_payments.selftest.sql` (PGlite, see memory reference-pglite-sql-tests), `lib/hubtel-pay/reference.ts`, `lib/hubtel-pay/reference.test.ts`

**Interfaces:**
- Table `hubtel_payments`: `reference text primary key check (reference ~ '^[0-9a-f]{32}$')`, `surface text not null`, `mode text not null check (mode in ('checkout','direct'))`, `amount_pesewas integer not null check (amount_pesewas > 0)`, `msisdn text`, `channel text`, `status text not null default 'pending' check (status in ('pending','confirming','paid','failed','needs_review'))`, `hubtel_transaction_id text`, `charges_pesewas integer`, `payment_method text`, `checkout_url text`, `last_check jsonb`, `claimed_at timestamptz`, `expires_at timestamptz not null`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`. Index on `(status, created_at)`. RLS enabled with no policies; revoke all from `anon`, `authenticated`.
- `newHubtelReference(): string` — 32 lowercase hex from `crypto.randomBytes(16)`.

- [ ] **Step 1:** Tests: 1,000 references are unique, each matches `^[0-9a-f]{32}$`, and none contains any of `wallet|data|bundle|airtime|sms|upgrade|shop|afa|bill|result|topup|dealer` (case-insensitive). Selftest SQL: insert a valid row; a `WALLET-1` reference is rejected; an `anon` select returns nothing.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** PASS (vitest + PGlite selftest). **Step 5:** Commit. The migration is NOT applied here; Task 7 applies it.

### Task 2: Relay routes `/receive` and `/checkout`

**Files:**
- Modify: `lib/ussd-hubtel/relay-handler.ts`, `scripts/hubtel-relay/README.md`
- Test: `lib/ussd-hubtel/relay-handler.payments.test.ts`

**Interfaces:**
- `POST /receive` body `{ reference, msisdn, channel, amount, description, callbackUrl }` → Hubtel `POST https://rmp.hubtel.com/merchantaccount/merchants/{collectionAccount}/receive/mobilemoney` with `CustomerMsisdn`, `Channel`, `Amount`, `PrimaryCallbackURL`, `Description`, `ClientReference`.
- `POST /checkout` body `{ reference, amount, description, callbackUrl, returnUrl, cancellationUrl }` → Hubtel `POST https://payproxyapi.hubtel.com/items/initiate` with `totalAmount`, `description`, `callbackUrl`, `returnUrl`, `cancellationUrl`, `merchantAccountNumber`, `clientReference`.
- Validation (400 on failure, nothing sent): reference `^[0-9a-f]{32}$`; msisdn `^233[0-9]{9}$`; channel one of `mtn-gh`, `vodafone-gh`, `tigo-gh`; amount a number with at most 2 decimals, 0.10 to 10,000; description `^[A-Za-z0-9 .,-]{1,60}$` (Hubtel rejects special characters); every URL `https:` and at most 500 chars, and callbackUrl's host must equal a new `cfg.appHost`.
- Auth uses `cfg.receiveBasicAuth ?? cfg.statusBasicAuth`. Response shape matches the other routes: `{ ok, upstreamStatus, body }`, with `upstreamStatus: 0` meaning the relay couldn't reach Hubtel. Add `sent: boolean` = whether the request left the relay (for the refused/unknown split).

- [ ] **Step 1:** Tests with a fake fetch: exact upstream URL, headers and body; every validation rule rejects without calling fetch; unauthenticated → 401; a fetch that throws before sending → `sent: false`; a timeout after sending → `sent: true`.
- [ ] **Steps 2-5:** RED → implement → GREEN → commit. Deploying the relay happens in Task 7.

### Task 3: Vercel client `lib/hubtel-pay/client.ts`

**Interfaces:**
- `type StartOutcome = { kind: "accepted"; checkoutUrl?: string; hubtelTransactionId?: string } | { kind: "refused"; code: string; message: string } | { kind: "unknown"; code: string; message: string }`
- `receiveMoney(p: { reference; msisdn; channel; amount; description; callbackUrl }): Promise<StartOutcome>`
- `initiateCheckout(p: { reference; amount; description; callbackUrl; returnUrl; cancellationUrl }): Promise<StartOutcome>`
- `classifyStart(relayReply): StartOutcome` — pure, implements the Global Constraints table.
- `checkPaymentStatus(reference): Promise<{ kind: "paid" | "unpaid" | "refunded" | "not_found" | "error"; amountPesewas?; chargesPesewas?; paymentMethod?; transactionId?; raw }>` — wraps `checkTransactionStatus` from `lib/ussd-hubtel/relay.ts`; 404 → `not_found`.
- `hubtelCallbackUrl(reference): string` — `${NEXT_PUBLIC_APP_URL}/api/webhooks/hubtel-payments?ref=…&sig=…`.

- [ ] Tests for every row of the classification table, every status kind (including 404 → `not_found`), and amount conversion (0.8 → 80, 199.99 → 19999). RED → implement → GREEN → commit.

### Task 4: `confirmHubtelPayment(reference)`

**Files:** `lib/hubtel-pay/confirm.ts`, `lib/hubtel-pay/confirm.test.ts`

**Interfaces:**
- `confirmHubtelPayment(reference: string, deps?): Promise<"fulfilled" | "failed" | "pending" | "needs_review" | "ignored">`
- Flow: load row (none → `ignored`); not `pending` (or `confirming` older than 10 min) → `ignored`; status check →
  - `paid`, amount OK, method OK → claim (conditional update to `confirming`); claim lost → `ignored`; won → `handleChargeSuccess({ reference, amount: amountPesewas, id: transactionId, gateway_response: "Hubtel: Paid" })`, then set `paid`, store charges, method, transaction id → `fulfilled`. If the handler throws, leave `confirming` (the sweep retries after 10 min) and alert admins.
  - `paid` but short or card → `needs_review`, `notifyAdmins` → `needs_review`.
  - `unpaid` past `expires_at`, or `refunded` → claim → `handleChargeFailed({ reference, gateway_response })` → `failed`.
  - anything else → store `last_check`, `pending`.
- Everything injectable; tests use fakes.

- [ ] Tests for each branch, plus: two concurrent calls on a Paid row → handler called once; handler throws → row stays `confirming`, admins alerted; amount compared in pesewas with no float error. RED → implement → GREEN → commit.

### Task 5: Callback route `app/api/webhooks/hubtel-payments/route.ts`

- `POST` only. Read `ref`, `sig` from the query; bad or missing signature → 401 and no other work. Valid → `await confirmHubtelPayment(ref)` → 200 `{ received: true }` whatever the outcome. Body is read only for logging (no PII: drop phone numbers). Export only `POST`.
- [ ] Route tests: forged sig → 401 and no status check; valid sig for an unknown reference → 200 and `ignored`; a body saying Success while the status check says Unpaid → nothing fulfilled. RED → implement → GREEN → commit.

### Task 6: Sweep `app/api/cron/hubtel-payments-sweep/route.ts`

- `GET` with `verifyCronAuth`. Picks up to 50 rows: `pending` created more than 5 min ago, or `confirming` claimed more than 10 min ago; calls `confirmHubtelPayment` for each, one at a time; returns counts per outcome. Add the job to `lib/cron-migration/crons.json` as an external (cron-job.org) job every 5 minutes; registering it at cron-job.org is a Task 7 step.
- [ ] Tests: auth required; only eligible rows picked; outcome counts. RED → implement → GREEN → commit.

### Task 7: Verify, review and ship (prod changes need the owner's OK)

- [ ] Full suite (only the known pre-existing failures), placeholder-env build from PowerShell, fresh reviewer on the most capable model over the whole Plan 3 diff.
- [ ] Ask the owner, then: dry-run and apply migration 0151; set `HUBTEL_PAYMENTS_CALLBACK_SECRET` and `HUBTEL_COLLECTION_ACCOUNT` in Vercel; redeploy the relay with a dated backup and smoke-test `/receive` and `/checkout` validation (400s) with no real charge; register the sweep at cron-job.org.
- [ ] Once Hubtel confirms the whitelist: the 1 GHS live test to 0555773910 through `receiveMoney`, confirmed by the sweep. The test row has no `wallet_payments` row behind it, so the shared handler answers "Payment record not found" and nothing is delivered. Record the real responses in `docs/hubtel-payments/`.
