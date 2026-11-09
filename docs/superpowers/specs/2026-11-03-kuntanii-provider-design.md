# Kuntanii Provider — Design

**Date:** 2026-11-03
**Provider docs (verbatim, authoritative):** `docs/kuntanii/kuntanii-api-docs-2026-11-03.txt`
**Closest templates:** Bundle Portal (`docs/superpowers/specs/2026-09-14-bundleportal-provider-design.md`) for idempotency + webhook + admin route; Apex Prime for the admin_settings-backed mode selector.

## Intent

Add Kuntanii (`https://kuntanii.com`) as the 11th fulfillment provider, MTN-only, using **every** documented endpoint:

| # | Endpoint | Used for |
|---|----------|----------|
| 1 | `POST /api/integrations/orders` | placing orders (normal or instant) |
| 2 | `GET /api/integrations/pricing[?deliveryMode=instant]` | admin price display, unsupported-size skip |
| 3 | `GET /api/integrations/orders/{externalOrderId}` | status (cron + webhook re-fetch) |
| 4 | `POST /api/integrations/orders/{externalOrderId}/not-received` | admin "report not received" |
| 5 | `GET /api/integrations/orders/{externalOrderId}/not-received?reportReference=` | dispute status |
| 6 | `POST /api/integrations/beneficiaries/verify` | per-order pre-check, whitelist registry (admin tool + checkout preview) |
| 7 | Inbound webhook | trigger for status re-fetch (body never trusted) |

## Decisions (user's)

1. **Full MTN member** — selectable as primary, in the retry sequence, disabled-providers toggle, admin per-order pick (incl. hard pin), and `WHITELIST_REGISTRY`. MTN only: NOT added to any Telecel/AT selector or `NON_MTN_CAPABLE`.
2. **Delivery mode = one admin toggle** (`normal` default / `instant`) on a Kuntanii admin card. If instant is refused, the order fails over to the next provider — **never** silently resent as normal (docs forbid it).
3. **Disputes: admin button only** on processed Kuntanii orders.
4. **One of our orders = one Kuntanii request with one item.** No batching.
5. **Pre-check then skip:** call `beneficiaries/verify` before every send; not eligible → Kuntanii skipped, retry sequence continues.
6. **Pricing:** show Normal + Instant plans in admin; skip sizes not in the active mode's plan list; record `totalAmountGhs` per order as cost.
7. **Credentials in hand:** `KUNTANII_API_KEY`, `KUNTANII_WEBHOOK_SECRET` (user sets in Vercel + `.env.local`; never committed, never in commands).
8. **Rollout: live straight away** (no dark period). Mitigation: full (PII-redacted) logging of the first responses so field-name drift is caught fast.
9. **Whitelist registry in BOTH** the admin phone-verification tool and the checkout live-verification preview. User accepts that every verify call records the number as a Kuntanii "new-number candidate".
10. **Webhook = signal + re-fetch.** Signature scheme is undocumented; the webhook body is never trusted.

## Non-goals

- Telecel / AirtelTigo via Kuntanii (docs: "Route every other network to your other supplier, never to Kuntanii").
- Batching multiple orders into one request; splitting > 1500 GB (we never send that).
- Customer- or dealer-raised disputes; auto-filing disputes from support complaints.
- Automatic refunds on dispute outcomes ("resolved" does not mean refund — docs). Admin decides via existing `/admin/refunds`.

## Anti-goals (would be a failure even if it "works")

- An instant order silently resent as normal.
- A double charge from a retried request (idempotency key must be stable across retries).
- A forged webhook changing an order's status.
- "not received" flipping a completed order to failed or triggering auto-resend/refund.
- Phone numbers in logs (playbook: ids and lengths only).
- Account-level hold (credit / paused / pricing profile) silently failing every order with no admin alert.

## Design

### 1. Types — `lib/mtn-providers/types.ts`
`MTNProviderName` gains `"kuntanii"`. Nothing else.

### 2. Provider — `lib/mtn-providers/kuntanii-provider.ts` (new)

**Config:** `KUNTANII_BASE_URL` (default `https://kuntanii.com`), `KUNTANII_API_KEY`, timeout 30s. Every call: `Authorization: Bearer <key>`, `Content-Type: application/json`.

**Identity / idempotency / re-sends (user decision: "re-send only if cancelled"):**
Callers pass our **order** id as `client_ref` and reuse it on every retry and admin re-send (`lib/mtn-fulfillment.ts:1468`, `lib/non-mtn-fulfillment.ts:94`). Kuntanii treats a reused `externalOrderId` as already-seen, so attempt ids are derived: attempt 1 = `<orderId>`, attempt n = `<orderId>-r<n>` (cap n ≤ 5). **Kuntanii itself is the attempt ledger** — no local record needed. Before placing, `createOrder` walks the chain with `GET /orders/{id}`:
- `404` → this id is free → place the order with it (id also sent as `X-Kuntanii-Idempotency-Key`).
- found, `cancelled` → try the next suffix.
- found, `pending` / `processing` → **do not resend**; return `success` with `order_id` = that existing id (tracking resumes on the live attempt).
- found, `processed` (or `not received`) → **do not re-deliver**; return `success` with that existing id, logged loudly (order resolves to completed on sync; admin uses "Report not received" instead).
- lookup error (non-404) → fail `RETRYABLE` (never place blind — could double-deliver).
- cap reached → fail `API_ERROR`.
Fallback `crypto.randomUUID()` only if `client_ref` is absent. The chosen id is stored as `mtn_fulfillment_tracking.mtn_order_id` (via `order_id`, as Bundle Portal does); status lookups use it directly. `orderReference` (`KT-…`/`KTHP-…`) goes to `provider_reference` (§5).
This also closes the timeout edge below: a timed-out attempt that Kuntanii actually accepted is found by the next walk and resumed, not duplicated. Cost: one extra GET (normally a 404) per order.

**createOrder(request):**
1. `network !== "MTN"` → fail `VALIDATION` (defence in depth).
2. Phone format + network-prefix checks (same helpers as Bundle Portal). Phone sent in local `0XXXXXXXXX` format.
3. Read delivery mode (`admin_settings` key `kuntanii_delivery_mode`, `{ mode: "normal" | "instant" }`, default normal).
4. **Size check:** get plans for that mode (cached in-memory 5 min per mode); `size_gb * 1024` must equal some plan's `bundleSizeMb`. Not found → fail `error_type: "UNSUPPORTED_SIZE"`. If the pricing call itself fails → **fail open** (send anyway; Kuntanii validates server-side).
5. **Beneficiary pre-check:** `POST beneficiaries/verify` with the one number. `eligible: false` → fail `error_type: "NOT_ELIGIBLE"`, message = Kuntanii's `reason`. Verify call errors / 503 → fail open (send; Kuntanii will 422 if ineligible).
6. `POST /api/integrations/orders` with `{ externalOrderId, items: [{ phoneNumber, dataGb: size_gb }], deliveryMode? }` — `deliveryMode` sent only when instant (docs: omitting = normal).
7. Response handling (by HTTP status + `code`, never message text):

| Response | Result |
|---|---|
| 201, `outcome` accepted, `acceptedCount ≥ 1` | success; capture `totalAmountGhs`, `orderReference`, `deliveryMode` |
| 200 with `idempotent: true` | success (original order; do NOT treat as new) |
| 201 `partially_accepted` | should not happen with one item; `acceptedCount 0` → `NOT_ELIGIBLE` failure, else success |
| 422 `NO_APPROVED_RECIPIENTS` / `NO_ELIGIBLE_RECIPIENTS` | fail `NOT_ELIGIBLE` |
| 422 `VALIDATION_ERROR` while instant | fail `INSTANT_UNAVAILABLE` + admin alert (throttled) |
| 422/400 `VALIDATION_ERROR` otherwise | fail `VALIDATION` |
| 402 `INSUFFICIENT_CREDIT`, `GOVERNING_ACCOUNT_CREDIT_HOLD`; 403 `PAYMENT_VERIFICATION_REQUIRED`, `ACCOUNT_ORDERS_PAUSED`, `PARENT_ORDERS_PAUSED`, `ORDERS_PAUSED`, `PRICING_PROFILE_REQUIRED`, `FORBIDDEN` | fail `ACCOUNT_HOLD` + admin alert (throttled once per code per hour) |
| 401 `UNAUTHORIZED` | fail `ACCOUNT_HOLD` + admin alert (bad/revoked key) |
| 409 `CONFLICT` | fail `API_ERROR`, logged loudly (should never happen — same UUID, same body) |
| 429, 503 (`CREDIT_UNAVAILABLE`, `BENEFICIARY_CHECK_UNAVAILABLE`, `CREDIT_RELAY_UNAVAILABLE`), timeout / network error | retry **once** after ~2s with identical body + key; still failing → fail `RETRYABLE` |
| non-JSON | fail `API_ERROR` |

Timeout edge: a timed-out request may have been accepted. Retrying with the same key returns the original (`idempotent: true`), not a duplicate. If the single retry also times out, the retry dispatcher moves on and keeps no record of the failed attempt (`lib/mtn-fulfillment.ts:545-561`), so a Kuntanii order **might** exist while another provider also delivers. Accepted risk (same class as non-idempotent providers today), made visible: the provider writes one row to `kuntanii_unknown_attempts` (external_order_id, order ref, created_at — in the §5 migration, same RLS/REVOKE rules), and the sync cron GETs those ids for 24h; any that turn out pending/processing/processed raise an admin alert ("possible double delivery: order X"). A later re-send for the same order also finds it via the attempt walk.

Idempotent replay: a `200 idempotent:true` reply whose status is `cancelled` counts as **failure** (should be rare, since the walk skips cancelled ids).

`error_type` is diagnostic only (Bundle Portal design §2 note: the retry dispatcher checks only `success`). All non-success results fall through the retry sequence; hard-pinned orders fail with the message.

**checkOrderStatus(id):** `FAILED_INIT_` prefix → failed (existing convention). Else `GET /orders/{id}`. 404 → `{ success:false }` (do not mark failed — could be propagation lag). Map using `orders[]` (one entry expected; if several, worst-of: any pending/processing → processing; all processed → completed; any cancelled with none processing → failed):

| Kuntanii status | Our status |
|---|---|
| `pending`, `processing` | `processing` |
| `processed` | `completed` |
| `cancelled` | `failed` |
| `not received` | `completed` (dispute tracked separately — never flips to failed) |
| unknown | `processing` + warn log |

Also return `orders[].notReceivedStatus` in `order` so callers can update dispute rows.

**checkBalance():** returns `null` (no endpoint). Balance monitor shows "n/a", never "low".

**Extra methods:** `getPricing(mode)`, `verifyBeneficiaries(phones[])` (batch, used by whitelist + checkout preview), `reportNotReceived(externalOrderId, { phoneNumber, dataGb, reasonCode?, description? })`, `getNotReceivedStatus(externalOrderId, reportReference)`.

**Pure helpers (exported, unit-tested):** `mapKuntaniiStatus`, `aggregateOrdersStatus`, `classifyKuntaniiError(httpStatus, code, mode)`, `isSizeSupported(plans, sizeGb)`, `toLocalGhanaPhone`.

### 3. Factory — `lib/mtn-providers/factory.ts`
`"kuntanii"` added to `VALID_PROVIDERS` and the `getMTNProvider()` / `getProviderByName()` switches. **Not** added to `NON_MTN_CAPABLE`.

### 4. Whitelist — `lib/mtn-providers/provider-whitelist.ts`
Entry `{ name: "kuntanii", configured: () => !!process.env.KUNTANII_API_KEY, check, checkBatch }`. `check` = verify one number → `allowed: eligible === true`, `reason` = Kuntanii `reason` code. `checkBatch` = one verify call per chunk of numbers (native batch; chunk at 100 — builder may adjust if Kuntanii rejects large batches). **Fail open** on error (registry convention).

Effect: Kuntanii participates in the existing order-time whitelist gate in `lib/mtn-fulfillment.ts` (~L436) and `/admin/phone-verification`. The checkout live-verification preview filters the registry by the admin-selected `customer_verification` providers (`lib/mtn-providers/customer-verification.ts:70-78`, validated in `app/api/admin/settings/customer-verification/route.ts:38-43`) — so Kuntanii joins checkout only once an admin ticks it there. That tick is a go-live step (user chose "both"); the builder confirms `validateProviderSelection` accepts `"kuntanii"`.

**Auto-switch (user decision: allow).** Registry membership means every whitelist-gated MTN order calls Kuntanii verify (each number recorded as a Kuntanii candidate), and if Kuntanii approves a number the active provider doesn't, the order may switch to Kuntanii under `mtn_whitelist_switch_providers` (missing setting = all providers may switch, `lib/mtn-fulfillment.ts:483-493`). Accepted: real orders can reach Kuntanii from day one without the supervised first order. No code change needed beyond registry membership. The per-order pre-check in §2 step 5 is still needed: the global gate passes a number if *any* provider allows it, which says nothing about Kuntanii.

### 5. Database migration (next free number on main, ≥ 0150)

- `ALTER TABLE mtn_fulfillment_tracking ADD COLUMN provider_cost_ghs numeric(12,2) NULL, ADD COLUMN provider_reference text NULL;` — filled by Kuntanii only for now (generic names so other providers can use them later). Builder: find where the tracking row is written after `createOrder` returns and pass these through (likely via new optional fields on `MTNOrderResponse`: `provider_cost_ghs?`, `provider_reference?`).
- New table `kuntanii_not_received_reports`: `id uuid pk`, `tracking_id` → `mtn_fulfillment_tracking`, `external_order_id text`, `order_reference text`, `report_reference text unique`, `phone_number text`, `data_gb numeric`, `reason_code text`, `description text`, `dispute_status text` (`open|escalated|resolved|rejected`, CHECK), `raised_by uuid` (admin user), `created_at`, `updated_at`, `last_checked_at`.
- New table `kuntanii_unknown_attempts`: `id uuid pk`, `external_order_id text unique`, `order_id uuid`, `order_type text`, `created_at`, `resolved_at`, `last_status text` (§2 timeout edge).
- **Security (playbook):** `ENABLE ROW LEVEL SECURITY` on both new tables, no policies; `REVOKE ALL ... FROM anon, authenticated`. Server routes use the service role. Any function created gets `REVOKE EXECUTE FROM PUBLIC, anon, authenticated`.
- Follow the prod change protocol: precheck → self-rolling-back dry run → user OK → apply.

### 6. Admin API — `app/api/admin/kuntanii/route.ts` (new)
Guarded by `verifyAdminAccess`. GET actions: `settings` (delivery mode), `pricing` (both modes, live), `disputes?trackingId=`. POST actions:
- `set-delivery-mode { mode }` — validates enum, upserts `admin_settings.kuntanii_delivery_mode`.
- `report-not-received { trackingId, description?, reasonCode? }` — loads tracking row server-side, requires `provider = kuntanii` and status `completed`; derives `externalOrderId`, phone, size from the row (never from the client); calls endpoint 4; inserts report row. **Claim-gated**: refuses if an `open`/`escalated` report already exists for that tracking row (unique partial index or conditional insert — not a pre-read). Validate `description` ≤ 500 chars, `reasonCode` ≤ 50.
- `refresh-dispute { reportId }` — endpoint 5, updates `dispute_status`.

### 7. Webhook — `app/api/webhooks/mtn/kuntanii/route.ts` + `lib/mtn-providers/kuntanii-webhook-processor.ts` (new)
- Responds 200 fast; work in `after()` (Vercel freeze lesson, 2026-07-26). Body size capped.
- Reads only `data.externalOrderId` (string, length-capped, UUID format check) and `X-Kuntanii-Event`.
- **Never trusts the body's status.** Looks up the tracking row by `mtn_order_id = externalOrderId AND provider = 'kuntanii'`; no row → ignore. Throttle: skip if that row was re-fetched in the last 15s. Otherwise calls `checkOrderStatus` (authenticated GET) and applies the result through the **same update path the status cron uses** (terminal-status guard, order-table mirroring, push notification — extract a shared function rather than copy).
- `order.not_received_*` events → also refresh any open dispute rows for that order via endpoint 5.
- **Signature capture:** for the first deliveries, log header *names* plus values of headers matching `/signature|sig|timestamp/i` (no body, no phones) so the real scheme can be added later as a second layer. `KUNTANII_WEBHOOK_SECRET` is configured now; verification code is a later small change once the scheme is known.
- Recorded exception: the playbook says webhooks fail closed when the secret is missing. Here the body is never trusted, so a forged delivery can only cause an authenticated status lookup of an existing order — the playbook's goal (no forged state changes) is met by design.
- Webhook URL to register in Kuntanii: `https://<prod-domain>/api/webhooks/mtn/kuntanii`.

### 8. Admin UI
- `app/admin/settings/mtn/page.tsx`: local `MTNProviderName` union + `PROVIDER_LABELS` (`kuntanii: "Kuntanii"`) + MTN provider lists only. New Kuntanii card: delivery-mode toggle (Normal/Instant, one line explaining instant must be enabled by Kuntanii); pricing table (plan, GB, Normal GHS, Instant GHS); "Balance: n/a — credit account".
- `app/admin/order-payment-status/page.tsx`: `getProviderOptionsForNetwork` MTN branch gains Kuntanii.
- One existing admin order view that shows provider + tracking (likely order-payment-status): for `provider = kuntanii` and status completed → "Report not received" button (confirm dialog with optional note) and a dispute badge (open/escalated/resolved/rejected) with refresh.
- `provider-display.ts`: display name.
- No new sidebar item planned. If the builder adds one, it needs a NEW tag (`lib/nav-new.ts`).
- Desktop layout: new card widens on `lg:` like sibling cards.

### 9. Status-sync cron — `app/api/cron/sync-mtn-status/kuntanii/route.ts` (new)
Model on the **apexprime / agentportalgh** sync crons (the Bundle Portal one is unscheduled and returns 410 — `app/api/cron/sync-mtn-status/bundleportal/route.ts:21-31`), with a `kuntanii` filter, including reversal detection. Also refreshes open/escalated dispute rows not checked in 30 min (cap ~20 per run). Every minute. Scheduling: add to `lib/cron-migration/crons.json` the same way apexprime/agentportalgh are, and actually register it on cron-job.org (a crons.json entry alone schedules nothing — leaderboard lesson).

### 10. Balance monitoring
`check-mtn-balance` cron + admin balance route: include Kuntanii as `null` → "n/a", excluded from low-balance alerts.

### 11. Admin alerts
Use the existing provider/admin alert path (central notifier `lib/admin-actions/` or whatever already alerts on provider failures — builder picks the existing one). Throttled per code per hour **in the DB** by reusing the existing `notifyAdminsThrottled(type, title, message, actionUrl, throttleMs)` in `lib/sms/notify.ts:82` (throttle key = notification `type`, e.g. `kuntanii_orders_paused`; checks recent `notifications` rows). No new throttle storage. Names the code and Kuntanii's message; never a phone number; never the governing account's balance (docs).

### 12. Logging
Phones redacted everywhere in provider, webhook, cron. First ~20 create/status responses logged in full with phones redacted, to verify undocumented fields (full status body, event names, cancelled/not-received strings).

## Testing

- Unit (TDD, Vitest): `mapKuntaniiStatus` (every documented status + unknown), `aggregateOrdersStatus` (single/multi/mixed), `classifyKuntaniiError` (every documented code × normal/instant), `isSizeSupported` (1024-MB conversion, missing size, empty plans), `toLocalGhanaPhone` (`233…`, `+233…`, `0…`).
- Provider with fake fetch: retry sends identical body + key; 200 `idempotent:true` = success; instant 422 never resends as normal; pre-check ineligible → no order POST; pricing failure → fail open.
- Webhook processor with fake Supabase + fake provider: body status ignored (forged "processed" while real status pending → stays processing); unknown externalOrderId ignored; throttle; terminal guard.
- Admin route: report-not-received refuses non-kuntanii / non-completed / already-open; derives data server-side.
- Migration via PGlite incl. RLS/REVOKE checks.
- `next build` with placeholder env before pushing main.

## Live probe results (done 2026-11-03, read-only — full detail in the docs txt "LIVE PROBE RESULTS")

- Key valid. Normal pricing = `GET /pricing` with **no param**; instant = `?deliveryMode=instant`.
- **Instant is already enabled** on our account (profile "Super dealer Inst").
- 18 whole-GB plans in both modes: 1–10, 12, 15, 20, 25, 30, 40, 50, 100 GB. Every other size (incl. sub-1GB) → `UNSUPPORTED_SIZE` skip.
- Unknown order → `404 {"code":"NOT_FOUND"}` (matches docs). No rate-limit headers exposed.
- Still unknown until the first real order: full status body, extra webhook event names, signature scheme, exact cancelled/not-received strings. `verify` not probed (it records numbers as candidates).

## Go-live (user chose live straight away)

1. Set `KUNTANII_API_KEY`, `KUNTANII_WEBHOOK_SECRET` in Vercel prod.
2. Apply migration per prod protocol.
3. Deploy; register webhook URL in Kuntanii.
4. Watch the first real Kuntanii orders' logs for field names (note: auto-switch can route orders there immediately). Optionally hard-pin one order first. Then add Kuntanii to the retry sequence / primary as desired.
5. Tick Kuntanii in the admin customer-verification provider selection (checkout preview).
6. Memory: `project-kuntanii-provider.md` + MEMORY.md index line.

## Calls made by Claude (please check)

- `not received` → order stays **completed**; dispute tracked separately.
- Pricing + verify pre-checks **fail open** (Kuntanii still enforces server-side).
- 429/503/timeout → **one** retry with the same key, then fall through.
- Account-level holds → fall through + **throttled admin alert**.
- Plans cached **5 min**.
- Generic column names `provider_cost_ghs` / `provider_reference` on the tracking table.
- Cost is written **once**, from the first successful 201 (sum of `orders[].totalAmountGhs`); an idempotent 200 replay never overwrites it.
- Alert throttle = existing `notifyAdminsThrottled` (no new storage).
- Balance monitor cron left unchanged (a permanently-null entry adds nothing); the Kuntanii admin card states "Balance: n/a — credit account".
- Dispute button lives on `/admin/mtn-logs` (the page that already lists tracking rows with provider + per-row actions).
- Webhook re-fetch applies results via the existing `syncMTNOrderStatus(trackingId)` (`lib/mtn-fulfillment.ts:855`), which already has the regression guard and order-table mirroring.
- Re-send attempt ids `<orderId>-r<n>`, capped at 5; Kuntanii's own GET is the attempt ledger.
- A re-send of an already **processed** order returns the existing attempt as success (no re-delivery, and no fall-through to another provider).
- Unknown-outcome timeouts are recorded in `kuntanii_unknown_attempts` and checked by the cron for 24h, raising a possible-double-delivery alert.
- Sync cron modelled on apexprime/agentportalgh, scheduled via crons.json + cron-job.org.
- Webhook works without signature verification (body never trusted) — recorded exception to fail-closed rule.
- Duplicate dispute filing blocked while one is open.
