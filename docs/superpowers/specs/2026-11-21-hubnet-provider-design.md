# Hubnet Provider — Design

**Date:** 2026-11-21
**Provider docs (verbatim):** `docs/hubnet/hubnet-api-docs-2026-11-21.txt` (probe results get appended there)
**Closest templates:** Kuntanii (`docs/superpowers/specs/2026-11-03-kuntanii-provider-design.md`) for attempt ledger, outcome-unknown, refund detection, whitelist entry; Bundle Portal for multi-network + BigTime + webhook-first; Digiwapy/Hubtel airtime for the airtime dispatch.

## Intent

Add Hubnet (`https://hubnet.app`) as the 12th fulfillment provider. Owner's brief: **"everything our current providers do"** — a full member on every surface any existing provider occupies, built in **one go** (owner picked approach A over a phased rollout).

## Goals

| Surface | What Hubnet does there | Hubnet endpoint |
|---|---|---|
| MTN data | primary / retry sequence / disabled toggle / admin per-order pick + hard pin | `mtn-new-transaction` |
| AT iShare data | `at_ishare_provider_selection` option | `at-new-transaction` |
| AT BigTime data | `at_bigtime_provider_selection` option (`isBigTime`) | `big-time-new-transaction` |
| Telecel data | `telecel_provider_selection` option | `telecel-new-transaction` |
| Airtime (MTN/Telecel/AT) | 4th value of `airtime_provider_<net>` | `airtime-new-transaction` |
| Status | status sync cron + webhook re-fetch | `check-transaction-status?reference=` |
| Refunds | sweep that detects provider-side refunds (the Kuntanii silent-refund lesson) | `refunds` |
| Balance | `checkBalance()` → existing balance cron/admin display + low-balance alert | `check_balance` |
| MTN number check | `WHITELIST_REGISTRY` entry (admin tool + checkout preview) and customer-verification provider | `mtn-verification?number=` |

## Non-goals

- Hubnet storefront endpoints (`/agent-data`, `/agent`, `/agent/track_order`) — they're Hubnet's own retail shop, not a supplier API.
- Bulk data endpoint — we send one order per request like every other provider.
- Auto-resending a refunded **completed** order (reversal safeguard forbids it).

## Anti-goals (failure even if it "works")

- A double delivery from a retry/re-send (reference must be stable per attempt; outcome-unknown must re-check by reference, never resend blind).
- A forged webhook changing an order's status (webhook body is never trusted).
- A Hubnet-side refund going unnoticed while the order shows completed (the Kuntanii incident).
- Airtime marked completed and later refunded by Hubnet with nobody told.
- Phone numbers or the API key in logs, URLs we log, or commands.
- Hubnet reachable by real orders before the owner switches it on.
- The `token:` header accidentally sent as `Authorization` (Hubnet would answer 401 → every order fails over silently).

## Constraints / facts from the docs

- Auth header is literally `token: Bearer <HUBNET_API_KEY>` — NOT `Authorization`.
- `/live/...` charges the wallet; `/test/...` with a Test key simulates (no charge, no delivery).
- `reference` < 30 chars, is the idempotency key; duplicate → **409**.
- Data `volume` = MB string (`size_gb * 1000`); airtime `volume` = GHS decimal string (`"10.00"`).
- Phone = 10 digits with leading 0.
- HTTP 200 `charge.success` = accepted/processing, not carrier-confirmed.
- Failures: `{ success:false, message }`; 400 (incl. insufficient balance, body may carry `status_code: 402`), 401, 403, 404, 409, 429, 500/503 ("re-check by reference before retrying").
- **Undocumented (must be probed with the Test key before code relies on them):** status response body and its status vocabulary; data-order success body; refunds list item shape (does it carry our `reference`?); webhook payload; whether `/test/` supports status/refunds/verification/balance; whether airtime `amount` in the success body is our wallet charge or face value.

## Approaches considered

- **A. Everything in one branch, dark, one supervised live test of every surface** — chosen by owner. One review cycle and deploy.
- **B. Three phases (data → airtime → number check)**, each dark + live-tested before the next. Smaller reviews and isolated rollback; three deploys. Not chosen.
- A thin "MTN only" member was ruled out by the brief.

Mitigation for A's risk: every surface ships **switched off** independently (see Rollout), so the single deploy changes nothing until the owner flips each switch, and each can be flipped back alone.

## Design

### 0. Probe first (before any code that parses a response)
With a Test key in `.env.local` (`HUBNET_TEST_API_KEY`), a throwaway script under `scripts/` hits every `/test/` endpoint once (data per network, airtime, status by reference, duplicate reference → 409, refunds, balance, verification) and appends redacted real bodies to the docs file. Then the owner does **one** live GHS-1-ish airtime + one smallest MTN bundle to a staff number during the supervised test to confirm `/live/` bodies match. Parsers are written against probed bodies; anything unprobeable is parsed defensively and logged raw (PII-redacted) as `[HUBNET-RAW]` until confirmed, then that logging is removed.

### 1. Types — `lib/mtn-providers/types.ts`
`MTNProviderName` gains `"hubnet"` (so it is a full MTN member and, via `NonMTNProviderName`, available to non-MTN dispatch).

### 2. Shared client — `lib/hubnet/client.ts` (new)
- Env: `HUBNET_API_KEY`, optional `HUBNET_BASE_URL` (default `https://hubnet.app`), `HUBNET_MODE` = `live` (default) | `test` → path prefix `/live` or `/test`. `HUBNET_WEBHOOK_TOKEN` (see §6).
- One `request()` that sets `token: Bearer …`, JSON, 30s timeout, never logs the key or full phone.
- Typed calls: `placeData(network, {phone, volumeMb, reference, webhook})`, `placeAirtime({phone, amountGhs, reference, webhook})`, `getStatus(reference)`, `listRefunds()`, `getBalance()`, `verifyMtn(number)`.
- Pure helpers in `lib/hubnet/core.ts` (unit-tested, no I/O): reference builder, status mapper, error classifier, phone normaliser, refund matcher.
- Used by both the data provider and the airtime path, so there is one place that knows Hubnet's quirks.

### 3. References (the 30-char limit)
Our order ids are 36-char UUIDs and retries add suffixes, so references are derived, deterministic, opaque:
- `ref = "DG" + <first 22 hex chars of the order UUID, dashes removed> + attemptSuffix` where attempt 1 has no suffix and attempt n is `R<n>` (n ≤ 5). Max length 2+22+2 = 26 < 30.
- Airtime uses the airtime order id with prefix `DA` and the same rule.
- Deterministic ⇒ a retried HTTP call for the same attempt hits Hubnet's 409 instead of buying twice.
- Opaque (no product words, no `WALLET-`) per the Hubtel opaque-reference rule.
- Stored on the tracking row as the external order id (and `provider_reference`), so status sync, webhook and refund sweep all key on it.

### 4. Data provider — `lib/mtn-providers/hubnet-provider.ts` (new)
Implements `MTNProvider`. Registered in `factory.ts` (`VALID_PROVIDERS`, provider switch, and added to `telecel_provider_selection`, `at_ishare_provider_selection`, `at_bigtime_provider_selection` option lists and `NON_MTN_CAPABLE`).
- **Endpoint by network:** MTN → `mtn-new-transaction`; AirtelTigo + `isBigTime` → `big-time-new-transaction`; AirtelTigo otherwise → `at-new-transaction`; Telecel → `telecel-new-transaction`. Phone↔network prefix check via existing `validatePhoneNetworkMatch` before sending.
- **Attempt ledger (Kuntanii pattern, Hubnet is the ledger):** before placing attempt n, `getStatus(ref_n)`: not found → place it; found pending/processing/completed → adopt it (return success with that ref, place nothing); found failed/refunded → move to attempt n+1. Cap 5 → plain failure.
- **Response classification** (`core.classifyError`):
  - 200 success → `success:true, order_id: ref`.
  - 409 duplicate → `getStatus(ref)` and adopt/advance as above.
  - 400 with insufficient-balance (`status_code 402` or message match) → failure with `error_type: "INSUFFICIENT_BALANCE"` so the retry sequence moves on + throttled admin alert ("Hubnet wallet low").
  - 400 other / 403 → definitive failure, next provider.
  - 401 → failure + throttled admin alert ("Hubnet key rejected").
  - 429 → failure, next provider (no blind retry).
  - 5xx / timeout / unreadable body → **re-check by reference once**: found → adopt; not found → still `OUTCOME_UNKNOWN` (existing `outcome.ts` hold), because Hubnet may create it late.
  - **Resolving held orders (builder-check correction):** generic code stores unknown outcomes as `mtn_order_id = UNKNOWN_<ts>`, status `abandoned` (`lib/mtn-fulfillment.ts:1040-1046, 1531-1537`) and every poller skips them, so the ref is NOT on the row. Kuntanii needed a `kuntanii_unknown_attempts` table. Hubnet doesn't: refs are derived from the order id, so the Hubnet cron (§5) scans recent (≤48h) `abandoned` `UNKNOWN_` rows with provider `hubnet`, recomputes `ref_1..ref_5` from the row's `order_id`/`shop_order_id`/`api_order_id`, and on a found attempt raises an admin alert with the ref + status ("Hubnet did create this order"). It does **not** auto-rewrite the abandoned row (that row's order may already have been handled by an admin); admin acts. *(Builder call.)*
  - **"Not found" must be unambiguous before the ledger ships:** 404 is shared by "bad path" and "missing transaction". The probe must pin the not-found shape; if a missing ref and a bad path look the same, treat 404 as not-found only when the response body says so, otherwise treat as unknown (never place a new attempt on an ambiguous answer).
- **checkOrderStatus(ref)** → `getStatus` → mapped to `pending|processing|completed|failed`. A status meaning "refunded" maps to `failed` for non-completed rows; for completed rows the generic reversal safeguard already flags `reversed`, never auto-resends.
- **checkBalance()** → `wallet_balance`.
- **Cost:** record the provider charge on tracking `provider_cost_ghs` if the probed success/status body carries it; otherwise null (builder: don't invent).

### 5. Status sync
**Decided (builder-check correction):** Hubnet gets its **own** sync, like Kuntanii — `lib/hubnet/sync.ts` + `app/api/cron/sync-mtn-status/hubnet/route.ts`, and `"hubnet"` added to `PROVIDERS_WITH_DEDICATED_CRON` (`sync-mtn-status/route.ts:345`) so the generic loop skips it. Reason: the generic tracking update is unconditional (`lib/mtn-fulfillment.ts:~975`); patching it would touch every provider. Hubnet's sync writes only from non-terminal statuses. The same cron runs: data status re-checks, the unknown-attempt watcher (§4), the airtime re-check (§8) and the refund sweep (§7) — one cron-job.org job, every minute, with the refund sweep gated to every 10th minute. Added to `crons.json` and synced via the cron-job.org script (`MSYS_NO_PATHCONV=1`).

### 6. Webhook — `app/api/webhooks/mtn/hubnet/route.ts` (new)
- We pass `webhook` per order: `https://www.datagod.store/api/webhooks/mtn/hubnet?t=<HUBNET_WEBHOOK_TOKEN>` (must be **www** — apex 307s and drops the body). The token is a junk filter, not proof: wrong/missing token → 200 no-op.
- Body is never trusted: extract a reference, ignore anything that isn't a ref we issued (`DG…`/`DA…` and present in tracking/airtime), then `getStatus(ref)` with our key and apply that.
- Always 200 fast. Firewall: the `/api/webhooks/` bypass lives in the Vercel firewall rule `bypass-webhook-endpoints` (v17, not in repo code) — confirm via the Vercel API before go-live, and confirm `block-scripting-uas` doesn't catch Hubnet's callback UA.
- Airtime refs (`DA…`) route to the airtime status updater (§8).

### 7. Refund sweep — `lib/hubnet/refund-sweep.ts` + cron `/api/cron/hubnet-refund-sweep` (cron-job.org, every 10 min)
- `listRefunds()` (200 most recent); match each to our ref (`DG…`/`DA…`); idempotent (a handled set keyed by ref so re-sweeps do nothing).
- Data order, tracking not completed → mark the attempt failed (normal failover/refund flow continues).
- Data order, completed → flag `reversed` per reversal safeguard + admin alert; **never** auto-resend.
- Airtime order → see §8.
- If refund items don't carry our reference (probe!), fall back to matching by phone-last-4 + volume + date window, and flag such matches for admin review instead of acting automatically.

### 8. Airtime — `lib/airtime-provider.ts`, `lib/airtime-service.ts`, `lib/airtime-hubnet.ts` (new)
- `AirtimeProvider` gains `"hubnet"`; admin airtime-provider selector shows it.
- `fulfillAirtimeViaHubnet(order, deps)` mirrors the Hubtel function's shape (injected `markOrder` with guarded status writes, `alert`), so it's unit-testable with fakes.
- Flow (**owner decision: processing until confirmed**, same as Digiwapy/Hubtel — `lib/airtime-service.ts:59`, `lib/airtime-hubtel.ts:81`): guard order is still payable/pending → place with `DA` ref → 200 `charge.success` → mark `processing` with note `[hubnetRef:…]` → completed only when Hubnet's status check or webhook re-fetch confirms delivery → 400 `charge.failed` → hand to manual (alert), **never** to another airtime provider automatically (matches the Hubtel rule "nothing was sent: hand to a human") → 5xx/timeout → re-check by ref; found → `processing`; not found → `processing` + alert, resolved by sync.
- The Hubnet cron (§5) re-checks `processing` Hubnet airtime orders by ref (required, not optional). A Hubnet failed/refunded status on a processing airtime order → manual hand-off + admin alert (customer refund via existing airtime refund path, admin decides). Stale `processing` handling follows the existing `expire-stale-airtime` cron.
- Refund sweep hit on a completed airtime order → admin alert + flag on the order (notes/marker) for `/admin/refunds`; no automatic customer refund (admin decides, like Kuntanii disputes).
- **Owner decision: no cashback for now.** `providerEarnsCommission` returns `false` for `"hubnet"` (signature `(provider, digiwapyConfigured)` at `lib/airtime-provider.ts:23` unchanged); `"hubnet"` added to `AIRTIME_PROVIDERS` so `parseAirtimeProvider` accepts it. Cashback quoting therefore treats Hubnet like manual. Revisit once real Hubnet airtime charges are seen.

### 9. MTN number check — `lib/mtn-providers/provider-whitelist.ts`, `customer-verification.ts`
- `WHITELIST_REGISTRY` entry `hubnet`: `verifyMtn(number)` → `verified` ⇒ allowed; `unverified` ⇒ not allowed; `invalid` ⇒ not allowed (`invalid_phone_number`, same as Kuntanii); `queued` / HTTP error / timeout ⇒ allowed (fail open, matches every other entry).
- Customer-verification provider with `checkBatch` = per-number calls, concurrency cap 5.
- Strict mode (`WhitelistCheckFailed`) behaves like the bundleportal entry.

### 10. Admin
- Provider pickers are **not** all automatic (builder-check correction). Manual edits needed: `provider-display.ts` label "Hubnet"; `app/admin/settings/mtn/page.tsx` two hardcoded provider unions (~L67, ~L162) + a Hubnet tab; `app/admin/order-payment-status/page.tsx:~71` dropdown; per-provider branches in `app/admin/mtn-logs/page.tsx`; airtime provider selector. Builder greps origin/main for `"kuntanii"` to find every list and adds `"hubnet"` beside it.
- Small Hubnet card on `/admin/settings/mtn` (Kuntanii-card style): balance, mode (live/test, read-only from env), last refund sweep time + count. No new settings beyond what existing selectors already provide.

### 11. Database
Expected: **no migration** — tracking already has `provider_cost_ghs`/`provider_reference` (0150), provider names are free text, airtime provider is an `admin_settings` JSON value. Builder must confirm there's no CHECK constraint / enum on provider names in tracking, `admin_settings` validation, or airtime notes. If the refund sweep needs a handled-set table, add `hubnet_refund_events` (ref PK, kind, handled_at; RLS on, REVOKE from anon/authenticated) as `0189_hubnet_provider.sql` + selftest, applied by the prod-change protocol.

### 12. Security
- Key only in env (Vercel prod sensitive + `.env.local`), never in commands, never logged. Owner pastes it into the env file themselves.
- Logs: refs, lengths, HTTP status; never full phone (reuse Kuntanii redaction helpers).
- Abuse cases: forged webhook (re-fetch defeats it); replayed webhook (idempotent status write); someone hitting the refund cron (cron auth); a ref collision (22 hex = 88 bits, negligible; plus Hubnet 409 would surface it, never double-buy).

## Rollout (all dark)

Ships with Hubnet in **no** selection: not in MTN primary/retry sequence, not selected for Telecel/AT, no `airtime_provider_<net>` set to hubnet, not ticked in customer-verification, refund-sweep cron created but harmless with no Hubnet rows. Then a supervised live test, owner present, one surface at a time:
1. Admin hard-pins one smallest MTN bundle to a staff number → watch tracking, webhook, status sync.
2. Same for AT iShare, BigTime, Telecel.
3. Set one network's airtime provider to hubnet → one small airtime → set back.
4. Phone-verification tool against a known verified/unverified number.
5. Confirm refunds list shape (ask Hubnet for a test refund if possible).
Then owner decides which switches stay on. Remove `[HUBNET-RAW]` logging once bodies are confirmed.

## Left to the builder

- Exact file split inside `lib/hubnet/`, test layout (Vitest fake-client pattern, unique test phones).
- Whether status sync reuses the generic path or gets its own cron (§5).
- Admin card layout (follow ui-conventions, lg: widening).
- Parsing details once probe bodies exist.

## Owner decisions (2026-11-21)

1. Approach A — everything in one go, all dark.
2. Airtime stays `processing` until Hubnet confirms (not completed on 200).
3. No airtime cashback on Hubnet for now.
4. Probe `/test/` first; if it doesn't cover status/refunds/balance/verification, a small supervised **live** test is OK (≈GHS 1 airtime + smallest bundle per network, staff number the owner picks).

## Builder calls (made in design, owner can override)

- Derived refs instead of an unknown-attempts table; watcher alerts, never auto-rewrites (§4).
- Own Hubnet sync cron + `PROVIDERS_WITH_DEDICATED_CRON`, not patching the generic unconditional update (§5).
- Ambiguous 404 on status ⇒ unknown, never "place a new attempt" (§4).
- Refund matches without our reference ⇒ admin review only (§7).
- Webhook junk-filter token in the URL (§6); `queued` verification ⇒ fail open (§9).

## Still needed before §0

- Hubnet **Test key** (owner adds `HUBNET_TEST_API_KEY` to `.env.local` themselves) and later the live `HUBNET_API_KEY`.
