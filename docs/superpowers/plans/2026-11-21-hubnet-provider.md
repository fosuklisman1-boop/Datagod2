# Hubnet Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Hubnet as the 12th provider on every surface an existing provider occupies (MTN/AT iShare/BigTime/Telecel data, airtime, status sync, webhook, refund detection, balance, MTN number check), shipped dark.

**Architecture:** One shared Hubnet client (`lib/hubnet/`) with pure, unit-tested helpers (references, status/error mapping, refund matching). A data provider implementing `MTNProvider`, registered in the factory. An airtime fulfiller mirroring `fulfillAirtimeViaHubtel`. One dedicated cron (`/api/cron/sync-mtn-status/hubnet`) that runs data status sync, unknown-attempt watch, airtime re-check and refund sweep. A signal-only webhook that re-fetches by reference.

**Tech Stack:** Next.js 15 App Router, TypeScript, Supabase (service role), Vitest (fake-client pattern), cron-job.org.

**Spec:** `docs/superpowers/specs/2026-11-21-hubnet-provider-design.md` · **Provider docs:** `docs/hubnet/hubnet-api-docs-2026-11-21.txt`

## Global Constraints

- Work on a fresh branch `feat/hubnet-provider` from `origin/main` in a worktree on **B:** (C: is full — see memory `reference-b-drive-worktrees`; vitest needs an uppercase drive path). Copy the two uncommitted docs (spec + api docs) and this plan from the main checkout into the worktree and commit them first.
- Auth header is exactly `token: Bearer <key>` — never `Authorization`.
- Base `https://hubnet.app` (env `HUBNET_BASE_URL` override); path prefix `/live` unless `HUBNET_MODE=test` → `/test`.
- Env vars: `HUBNET_API_KEY`, `HUBNET_MODE`, `HUBNET_BASE_URL`, `HUBNET_WEBHOOK_TOKEN`, `HUBNET_TEST_API_KEY` (probe only). `configured()` = `!!process.env.HUBNET_API_KEY`.
- Reference: `"DG"` (data) / `"DA"` (airtime) + first 22 hex chars of the uuid with dashes removed + (`""` for attempt 1, `R<n>` for n=2..5). Max 26 chars. Never contains product words or `WALLET-`.
- Data `volume` = `String(size_gb * 1000)`; airtime `volume` = `amount.toFixed(2)`; phone = 10-digit local `0XXXXXXXXX`.
- Webhook URL sent per order: `https://www.datagod.store/api/webhooks/mtn/hubnet?t=<HUBNET_WEBHOOK_TOKEN>` (www, never apex). Omit the `webhook` field when the token env is unset.
- Never log the key, the webhook token, or a full phone number (reuse `redactPhone` from `lib/mtn-providers/kuntanii-core.ts`). Raw response logging uses tag `[HUBNET-RAW]`, phones redacted.
- Airtime: `charge.success` ⇒ `processing`, never `completed`. `providerEarnsCommission("hubnet", …)` ⇒ `false`. Never fall back to another airtime provider.
- Refunded **completed** data order ⇒ flag `reversed` via existing `flagReversal`; never auto-resend.
- An ambiguous status answer (404 without a body that says the transaction is missing, 5xx, unparseable) ⇒ "unknown", never "not found".
- No migration. Idempotency comes from guarded writes and markers, not a new table.
- Edit/Write tools only for code edits (no sed) — tell every subagent.
- Ships dark: no default selection anywhere includes `hubnet`.

## Review Focus

1. **Retry after timeout on the same attempt** — Hubnet answers 409; we must adopt the existing transaction, not fail or place R2. (Task 4 test `409 duplicate adopts existing attempt`.)
2. **Status lookup returns 404 for a bad path vs missing ref** — must not trigger a new placement. (Task 2 test `classifyStatusReply treats bare 404 as unknown`; Task 4 test `ambiguous status lookup never places`.)
3. **Webhook with a valid-looking ref we never issued / for another provider's order** — no-op. (Task 7 test `ignores refs not in tracking or airtime_orders`.)
4. **Refund sweep runs twice over the same 200 refunds** — second run changes nothing and sends no second alert. (Task 6 test `second sweep is a no-op`.)
5. **AT order with `isBigTime` vs iShare, and Telecel number sent to MTN endpoint** — correct endpoint, prefix mismatch rejected before any call. (Task 4 tests `endpointFor` routing and `prefix mismatch never calls Hubnet`.)

---

### Task 1: Probe Hubnet (blocking — needs owner's Test key)

**Files:**
- Create: `scripts/hubnet-probe.ts`
- Modify: `docs/hubnet/hubnet-api-docs-2026-11-21.txt` (append under PROBE RESULTS)

**Interfaces:**
- Produces: recorded real bodies for: data place (mtn/at/big-time/telecel), airtime place, status by ref (existing, missing, malformed path), duplicate ref (409), refunds list, balance, verification (verified/unverified/queued/invalid if obtainable). Later tasks' parsers are written against these.

- [ ] **Step 1:** Confirm `HUBNET_TEST_API_KEY` exists in `.env.local` (presence only: `node -e "require('dotenv').config({path:'.env.local'});console.log(!!process.env.HUBNET_TEST_API_KEY)"`). If false, STOP and ask the owner.
- [ ] **Step 2:** Write `scripts/hubnet-probe.ts`: reads key from env, always `/test/` prefix, refs `DGPROBE<timestamp36>`, one call per endpoint above, prints `{endpoint, httpStatus, body}` with any 10-digit/233 number passed through `redactPhone`. Never prints the key.
- [ ] **Step 3:** Run `npx tsx --env-file=.env.local scripts/hubnet-probe.ts` and append output to the docs file. Note which endpoints `/test/` does not support.
- [ ] **Step 4:** Write a "Probe conclusions" paragraph in the docs file: status vocabulary, how a missing ref looks, whether refund items carry `reference`, where cost appears, verification body. Update the provisional mappings in Task 2 if they differ.
- [ ] **Step 5:** If `/test/` doesn't cover status/refunds/balance/verification, record that; those get confirmed in the supervised live test (Task 11) and their parsers stay defensive with `[HUBNET-RAW]` logging.
- [ ] **Step 6:** Commit `git add scripts/hubnet-probe.ts docs/hubnet && git commit -m "chore(hubnet): probe test endpoints and record real bodies"`

### Task 2: Pure helpers — `lib/hubnet/core.ts`

**Files:**
- Create: `lib/hubnet/core.ts`, `lib/hubnet/core.test.ts`

**Interfaces:**
- Produces:
  - `type HubnetKind = "data" | "airtime"`; `const HUBNET_MAX_ATTEMPTS = 5`
  - `hubnetRef(kind: HubnetKind, uuid: string, attempt: number): string` — throws on attempt < 1 or > 5 or a non-uuid.
  - `parseHubnetRef(ref: string): { kind: HubnetKind; prefix22: string; attempt: number } | null`
  - `type HubnetNet = "mtn" | "at" | "big-time" | "telecel"`; `endpointFor(network: "MTN" | "Telecel" | "AirtelTigo", isBigTime?: boolean): HubnetNet`
  - `toHubnetPhone(raw: string): string | null` (delegates to `toLocalGhanaPhone`)
  - `type HubnetStatus = "processing" | "completed" | "failed"`; `mapHubnetStatus(raw: string | null | undefined): HubnetStatus`; `isHubnetRefunded(body: unknown): boolean`
  - `type StatusLookup = { kind: "found"; status: HubnetStatus; refunded: boolean; raw: unknown; costGhs?: number } | { kind: "missing" } | { kind: "unknown" }`; `classifyStatusReply(httpStatus: number, body: unknown): StatusLookup`
  - `type PlaceClass = "success" | "duplicate" | "insufficient_balance" | "auth" | "rate_limited" | "rejected" | "unknown"`; `classifyPlaceReply(httpStatus: number, body: unknown): PlaceClass`
  - `type HubnetRefundItem = { reference?: string; phone?: string; volume?: string; amount?: number; date?: string }`; `normalizeRefunds(body: unknown): HubnetRefundItem[]`

- [ ] **Step 1: Write failing tests** in `lib/hubnet/core.test.ts`:
  - `hubnetRef("data", <uuid>, 1)` === `"DG"` + first 22 hex, length 24; attempt 3 ends `"R3"`, length 26; airtime starts `"DA"`; deterministic; attempt 6 throws; every output matches `/^D[GA][0-9a-f]{22}(R[2-5])?$/` and is `< 30` chars.
  - `parseHubnetRef` round-trips; returns null for `"UNKNOWN_123"` and `"DGxyz"`.
  - `endpointFor routing`: `("MTN")→"mtn"`, `("AirtelTigo")→"at"`, `("AirtelTigo", true)→"big-time"`, `("Telecel")→"telecel"`.
  - `mapHubnetStatus` (case-insensitive): `success|completed|delivered` ⇒ completed; `failed|refunded|reversed|cancelled` ⇒ failed; `pending|processing|queued|initiated` ⇒ processing; undefined/unknown word ⇒ processing. *(Replace with Task 1's probed vocabulary if it differs.)*
  - `classifyStatusReply treats bare 404 as unknown`: `(404, {success:false, message:"Not Found"})` ⇒ unknown, unless the message matches the probed missing-transaction text ⇒ missing; `(500, …)` ⇒ unknown; `(200, <probed found body>)` ⇒ found.
  - `classifyPlaceReply`: 200 `{event:"charge.success"}` ⇒ success; 409 ⇒ duplicate; 400 with `status_code: 402` or message `/insufficient/i` ⇒ insufficient_balance; 401 ⇒ auth; 429 ⇒ rate_limited; other 400/403 ⇒ rejected; 5xx or non-object ⇒ unknown.
  - `normalizeRefunds` accepts the probed shape and returns `[]` for garbage.
- [ ] **Step 2:** `npx vitest run lib/hubnet/core.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `lib/hubnet/core.ts` (no I/O, no env).
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat(hubnet): pure reference, status and error helpers`.

### Task 3: HTTP client — `lib/hubnet/client.ts`

**Files:**
- Create: `lib/hubnet/client.ts`, `lib/hubnet/client.test.ts`

**Interfaces:**
- Consumes: Task 2 types; `sendOrderRequest`, `OrderRequestResult` from `lib/mtn-providers/outcome.ts`.
- Produces:
  - `interface HubnetClient { placeData(net: HubnetNet, b: { phone: string; volumeMb: number; reference: string }): Promise<OrderRequestResult>; placeAirtime(b: { phone: string; amountGhs: number; reference: string }): Promise<OrderRequestResult>; getStatus(reference: string): Promise<StatusLookup>; listRefunds(): Promise<HubnetRefundItem[] | null>; getBalance(): Promise<number | null>; verifyMtn(number: string): Promise<"verified" | "unverified" | "queued" | "invalid" | null> }`
  - `createHubnetClient(opts?: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv }): HubnetClient`
  - `hubnetWebhookUrl(env?: NodeJS.ProcessEnv): string | undefined`; `isHubnetConfigured(env?: NodeJS.ProcessEnv): boolean`
  - Place calls go through `sendOrderRequest("Hubnet", …)` so throws/unreadable replies become OUTCOME_UNKNOWN exactly like other providers.

- [ ] **Step 1: Failing tests** with a fake `fetch` recording calls:
  - every request has header `token: "Bearer k"` and **no** `authorization` header.
  - `HUBNET_MODE=test` ⇒ URL contains `/test/api/context/business/transaction/`; default ⇒ `/live/`.
  - `placeData("big-time", …)` POSTs to `…/big-time-new-transaction` with body `{phone, volume: "2000", reference, webhook}`; `webhook` absent when `HUBNET_WEBHOOK_TOKEN` unset.
  - `placeAirtime` body has `volume: "10.00"`.
  - `getStatus` URL-encodes the ref into `?reference=`; a fetch throw ⇒ `{kind:"unknown"}`.
  - `getBalance` returns `data.wallet_balance`; error ⇒ null. `verifyMtn` returns `data.status`; non-2xx ⇒ null.
  - a console spy sees no key, no token, no full phone across all calls.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (30s `AbortSignal.timeout`). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(hubnet): authenticated client with live/test modes`.

### Task 4: Data provider + factory registration

**Files:**
- Create: `lib/mtn-providers/hubnet-provider.ts`, `lib/mtn-providers/hubnet-provider.test.ts`
- Modify: `lib/mtn-providers/types.ts:75` (add `"hubnet"` to `MTNProviderName`); `lib/mtn-providers/factory.ts` (L41 validation, L62 `VALID_PROVIDERS`, `getMTNProvider` switch ~L121, `NON_MTN_CAPABLE` telecel / at_ishare / at_bigtime lists ~L157-159, `getProviderByName` switch ~L253); `lib/mtn-providers/provider-display.ts` (label "Hubnet"); tests `factory.test.ts`, `provider-display.test.ts`, `outcome-unknown.providers.test.ts` (add `["hubnet", () => new HubnetProvider(<fake deps>)]`)

**Interfaces:**
- Consumes: `createHubnetClient`, `hubnetRef`, `classifyPlaceReply`, `endpointFor`, `toHubnetPhone`, `validatePhoneNetworkMatch` (`lib/mtn-fulfillment`), `outcomeUnknownResponse`, `notifyAdminsThrottled` (`lib/sms/notify`).
- Produces: `class HubnetProvider implements MTNProvider`, `name = "hubnet"`, ctor `(deps?: { client?: HubnetClient; alert?: (type: string, title: string, msg: string) => Promise<void> })`. `createOrder` returns `order_id` = the ref of the attempt that now exists. **Record here** which tracking field equals the `client_ref` that `createMTNOrder` passes (check `lib/mtn-fulfillment.ts` ~L1468 and `lib/non-mtn-fulfillment.ts` ~L94) — Task 5's watcher recomputes refs from it.

- [ ] **Step 1: Failing tests** (fake client):
  - `endpointFor routing`: MTN / AT / AT + isBigTime / Telecel requests hit the matching `placeData` net.
  - `prefix mismatch never calls Hubnet`: Telecel number on an MTN request ⇒ failure, zero client calls.
  - fresh order: `getStatus(ref1)` missing ⇒ `placeData` with ref1 and volumeMb = size_gb*1000 ⇒ `{success:true, order_id: ref1}`.
  - `existing attempt adopted`: ref1 found processing ⇒ success, no placeData.
  - failed attempt advances: ref1 found failed ⇒ ref2 missing ⇒ places ref2.
  - all 5 failed ⇒ failure message `"Hubnet: all 5 attempts used"`, no placement.
  - `ambiguous status lookup never places`: `getStatus` unknown ⇒ `outcomeUnknownResponse`, zero placeData.
  - `409 duplicate adopts existing attempt`: place ⇒ duplicate ⇒ re-check found ⇒ success with the same ref.
  - place unknown (5xx/throw) ⇒ re-check found ⇒ success; re-check missing or unknown ⇒ `error_type: "OUTCOME_UNKNOWN"`.
  - insufficient_balance ⇒ `error_type: "INSUFFICIENT_BALANCE"` + alert type `"hubnet_low_balance"`; auth ⇒ alert type `"hubnet_auth"`.
  - `checkOrderStatus(ref)` maps found completed/processing/failed to `status`, puts `{ status: <raw>, refunded }` in `order`; missing/unknown ⇒ `{ success: false }`.
  - factory: `getProviderByName("hubnet").name === "hubnet"`; `VALID_PROVIDERS` contains it; `isProviderCapableForNetwork` true for Telecel, AT iShare, AT BigTime; `getProviderDisplay("hubnet").label === "Hubnet"`; default selection and default retry sequence do **not** include hubnet.
- [ ] **Step 2:** `npx vitest run lib/mtn-providers` → new tests FAIL.
- [ ] **Step 3:** Implement provider + registrations.
- [ ] **Step 4:** `npx vitest run lib/mtn-providers lib/mtn-fulfillment.test.ts lib/non-mtn-fulfillment.test.ts` → PASS, no regressions.
- [ ] **Step 5:** Commit `feat(hubnet): data provider on MTN, AT iShare, BigTime, Telecel`.

### Task 5: Dedicated sync cron + unknown-attempt watcher

**Files:**
- Create: `lib/hubnet/sync.ts`, `lib/hubnet/sync.test.ts`, `lib/hubnet/unknown-attempts.ts`, `lib/hubnet/unknown-attempts.test.ts`, `app/api/cron/sync-mtn-status/hubnet/route.ts`
- Modify: `app/api/cron/sync-mtn-status/route.ts:345` (add `"hubnet"` to `PROVIDERS_WITH_DEDICATED_CRON`), `crons.json` (entry `/api/cron/sync-mtn-status/hubnet`, every minute)

**Interfaces:**
- Consumes: `HubnetProvider.checkOrderStatus` (via `checkMTNOrderStatus(ref, "hubnet")`), `fetchReversalCandidates` / `isReversal` / `flagReversal` (`lib/mtn-reversal.ts`), `syncWindowStartIso`, `backgroundCron`, `verifyCronAuth`; template `app/api/cron/sync-mtn-status/kuntanii/route.ts`.
- Produces:
  - `applyHubnetStatusChange(db, row: HubnetSyncRow, newStatus: HubnetStatus, result): Promise<boolean>` — same guarded-write contract as `applyKuntaniiStatusChange` in `lib/mtn-providers/kuntanii-sync.ts` (update `.eq("status", oldStatus)`, mirror to the order table with failed ⇒ `pending`, notify without phone). If that function has no Kuntanii-specific logic, re-export it under a provider-neutral name instead of copying.
  - `checkHubnetUnknownAttempts(db, client, alert, now?: number): Promise<{ checked: number; found: number }>` — rows with `provider = "hubnet"`, `status = "abandoned"`, `mtn_order_id LIKE 'UNKNOWN_%'`, created within 48h; recomputes refs 1..5 from the Task 4 `client_ref` field; any found ⇒ one throttled alert (type `hubnet_unknown_found`, throttle key includes the tracking id) naming ref + status. Never writes the tracking row.
  - Route phases (each wrapped like Kuntanii's `phase()`): `status-sync`, `reversals`, `unknown-attempts`, `airtime-sync` (wired in Task 8), `refund-sweep` (wired in Task 6; runs only when `new Date().getUTCMinutes() % 10 === 0`). Route file exports only `GET`.

- [ ] **Step 1: Failing tests:** guarded write returns false when the status moved meanwhile; failed ⇒ order table `pending`; completed ⇒ notification with no phone in it; watcher finds ref2 for an abandoned row ⇒ exactly one alert and the tracking row untouched; all refs missing ⇒ no alert; row older than 48h ignored.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement libs + route. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(hubnet): dedicated status sync and unknown-attempt watcher`.

### Task 6: Refund sweep

**Files:**
- Create: `lib/hubnet/refund-sweep.ts`, `lib/hubnet/refund-sweep.test.ts`
- Modify: `app/api/cron/sync-mtn-status/hubnet/route.ts` (wire `refund-sweep`)

**Interfaces:**
- Consumes: `client.listRefunds`, `parseHubnetRef`, `flagReversal`, `applyHubnetStatusChange`.
- Produces: `sweepHubnetRefunds(db, client, alert): Promise<{ seen: number; dataFailed: number; dataReversed: number; airtimeFlagged: number; reviewOnly: number }>`:
  - `DG` ref ⇒ tracking row with `mtn_order_id = ref`: pending/processing ⇒ `applyHubnetStatusChange(…, "failed")`; completed and not already reversed ⇒ `flagReversal` + alert `hubnet_refund_reversed`; anything else ⇒ skip.
  - `DA` ref ⇒ airtime order whose notes contain `[hubnetRef:<ref>]`: if notes lack `[hubnetRefunded]` ⇒ append it; if status `processing` ⇒ set `pending` (guarded `.eq("status", "processing")`); alert `airtime_hubnet_refunded`. Completed airtime ⇒ marker + alert only (admin uses `/admin/refunds`).
  - no parseable ref ⇒ count `reviewOnly`, one throttled summary alert, no writes.

- [ ] **Step 1: Failing tests:** each branch above; `second sweep is a no-op` (same items twice ⇒ second run makes 0 writes and 0 alerts); `listRefunds` returns null ⇒ all zeros, no throw.
- [ ] **Step 2:** FAIL. **Step 3:** Implement + wire. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(hubnet): detect provider refunds every 10 minutes`.

### Task 7: Webhook

**Files:**
- Create: `lib/hubnet/webhook.ts`, `lib/hubnet/webhook.test.ts`, `app/api/webhooks/mtn/hubnet/route.ts`

**Interfaces:**
- Consumes: `parseHubnetRef`, `client.getStatus`, `applyHubnetStatusChange`, Task 8's `applyHubnetAirtimeStatus`.
- Produces: `extractHubnetRef(payload: unknown): string | null` (looks at `reference`, `batch_id`, `data.reference`, `data.batch_id`; result must pass `parseHubnetRef`); `tokenOk(given: string | null, env?: NodeJS.ProcessEnv): boolean` (constant-time compare; false when env unset); `processHubnetWebhook(ref: string, deps): Promise<"applied" | "ignored" | "unknown">`.
- Route `POST`: read raw body (cap 64 KB), check `?t=`, log `[HUBNET-RAW]` redacted body + header names, extract ref, `after(() => processHubnetWebhook(ref, …))`, always `200 { received: true }`.

- [ ] **Step 1: Failing tests:** bad/missing token ⇒ ignored, no status lookup; `ignores refs not in tracking or airtime_orders`; body says completed but re-fetch says processing ⇒ processing applied (body never trusted); `DA` ref routes to the airtime applier; oversized body ignored.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(hubnet): signal-only webhook with authenticated re-fetch`.

### Task 8: Airtime

**Files:**
- Create: `lib/airtime-hubnet.ts`, `lib/airtime-hubnet.test.ts`
- Modify: `lib/airtime-provider.ts:3-4,23` (add `"hubnet"` to `AirtimeProvider` and `AIRTIME_PROVIDERS`; `providerEarnsCommission` unchanged so hubnet ⇒ false), `lib/airtime-provider.test.ts`, `lib/airtime-service.ts` ~L100 (dispatch branch for `"hubnet"`), `lib/airtime-service-dispatch.test.ts`, `app/admin/airtime/settings/page.tsx:181` (add `"hubnet"` option labelled "Hubnet"), `app/api/cron/sync-mtn-status/hubnet/route.ts` (wire `airtime-sync`)

**Interfaces:**
- Consumes: `AirtimeOrderMinimal` (`lib/airtime-hubtel.ts`), `hubnetRef("airtime", order.id, n)`, `client.placeAirtime`, `client.getStatus`; Digiwapy sync (`app/api/cron/sync-digiwapy/route.ts`) as the template for completion notification and failed ⇒ `pending`.
- Produces:
  - `interface AirtimeHubnetDeps { client: HubnetClient; markOrder(orderId: string, patch: { status?: string; notes: string }, onlyFromStatuses?: string[]): Promise<number | void>; alert(message: string, kind?: "manual" | "review"): Promise<void> }`
  - `fulfillAirtimeViaHubnet(order: AirtimeOrderMinimal, deps: AirtimeHubnetDeps): Promise<boolean>` — true when Hubnet owns it, false when nothing was sent. Never throws, never falls back. Same attempt ledger as Task 4 (status check before placing).
  - `applyHubnetAirtimeStatus(db, orderId: string, lookup: StatusLookup): Promise<boolean>` — processing ⇒ completed (guarded; notification + push like Digiwapy, no phone in title); processing ⇒ `pending` with note `Hubnet failed` + manual alert on failed.
  - `syncHubnetAirtime(db, client, limit = 50): Promise<{ checked: number; updated: number }>` — re-checks `processing` airtime orders whose notes contain `[hubnetRef:`.

- [ ] **Step 1: Failing tests:** success ⇒ `processing` with `[hubnetRef:DA…]`, never completed; `charge.failed` ⇒ "not sent" note + manual alert, returns false; place unknown ⇒ re-check found ⇒ processing; unknown + missing ⇒ processing + review alert containing "do not resend"; existing attempt adopted, no second placement; `providerEarnsCommission("hubnet", true) === false`; `parseAirtimeProvider({ provider: "hubnet" }) === "hubnet"`; dispatch with provider hubnet calls only the Hubnet fulfiller; sync completes a processing order and is a no-op on a completed one.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npx vitest run lib/airtime` → PASS.
- [ ] **Step 5:** Commit `feat(hubnet): airtime provider (processing until confirmed, no cashback)`.

### Task 9: MTN number check

**Files:**
- Modify: `lib/mtn-providers/provider-whitelist.ts` (add `checkHubnet`, `checkHubnetBatch`, registry entry after kuntanii), `lib/mtn-providers/provider-whitelist.test.ts`

**Interfaces:**
- Consumes: `client.verifyMtn`, `toHubnetPhone`, `isHubnetConfigured`.
- Produces: `WHITELIST_REGISTRY` entry `{ name: "hubnet", configured: () => isHubnetConfigured(), check, checkBatch, checkBatchStrict }`; batch runs at most 5 calls concurrently.

- [ ] **Step 1: Failing tests:** verified ⇒ `{allowed:true}`; unverified ⇒ `{allowed:false, reason:"unverified"}`; invalid or unparseable phone ⇒ `{allowed:false, reason:"invalid_phone_number"}`; queued ⇒ allowed; null (error) ⇒ allowed; strict batch with a null ⇒ throws `WhitelistCheckFailed`; batch output order matches input.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `npx vitest run lib/mtn-providers/provider-whitelist.test.ts lib/mtn-providers/customer-verification.test.ts` → PASS.
- [ ] **Step 5:** Commit `feat(hubnet): MTN number verification in the whitelist registry`.

### Task 10: Admin surfaces, balance, provider pickers

**Files:**
- Modify: `app/admin/settings/mtn/page.tsx` (~L67 and ~L162 unions; `<TabsContent value="hubnet">` with `<ActivationCard providerKey="hubnet" label="Hubnet" />` and a read-only card: balance, mode live/test, last refund-sweep counts); `app/admin/order-payment-status/page.tsx` ~L71 (`{ value: "hubnet", label: "Hubnet" }`); `app/admin/mtn-logs/page.tsx` ~L652 (show the Hubnet ref where Kuntanii shows its id; no Kuntanii-only features); `app/api/cron/check-mtn-balance/route.ts` (add `new HubnetProvider().checkBalance()` to `Promise.all`, `balances`, `lows`); any admin API route backing the Hubnet card (gated with `verifyAdminAccess`).
- Check: `git grep -n '"kuntanii"' -- app components lib` reviewed line by line; every user-facing provider list also gets `"hubnet"` (skip Kuntanii-only delivery-mode and dispute code).

- [ ] **Step 1:** Make the edits; new UI follows `docs/ui-conventions.md` (navy `--primary`, `lg:` widening).
- [ ] **Step 2:** `npx vitest run` → only the 9 known order-health failures.
- [ ] **Step 3:** `npx tsc --noEmit` → clean.
- [ ] **Step 4:** Placeholder-env `next build` → succeeds.
- [ ] **Step 5:** Commit `feat(hubnet): admin tab, balance alert, provider pickers`.

### Task 11: Review, deploy dark, supervised live test

- [ ] **Step 1:** Fresh whole-branch review on **opus** (money + webhook + cron ⇒ mandatory), plus `ecc:security-reviewer` on sonnet for webhook/token/logging. Fix each finding with a failing test first.
- [ ] **Step 2:** Owner adds `HUBNET_API_KEY` (live) and `HUBNET_WEBHOOK_TOKEN` to Vercel Production (sensitive) and `.env.local`. Never in chat or commands.
- [ ] **Step 3:** Confirm via the Vercel API that firewall rule `bypass-webhook-endpoints` covers `/api/webhooks/` and `block-scripting-uas` won't block Hubnet callbacks.
- [ ] **Step 4:** Check local `main` for other sessions' commits, merge `origin/main` into the branch, re-run tests + build, push to `main` with owner OK. Verify deploy READY; smoke: webhook POST with bad token ⇒ 200 no-op; cron without auth ⇒ 401.
- [ ] **Step 5:** Create the cron-job.org job: `MSYS_NO_PATHCONV=1 npx tsx --env-file=../external-cron-migration/.env.local scripts/sync-cronjob-org.ts --only /api/cron/sync-mtn-status/hubnet`.
- [ ] **Step 6:** Supervised live test with owner (staff number they choose): hard-pin smallest MTN bundle → AT iShare → BigTime → Telecel → set one network's airtime provider to hubnet, ≈GHS 1 airtime, set back → phone-verification tool on a known number. Record `/live/` bodies in the docs file; fix any parser drift (failing test first); remove `[HUBNET-RAW]` logging.
- [ ] **Step 7:** Update memory `project-hubnet-provider.md`; draft the WhatsApp channel post (Post now / Hold).
