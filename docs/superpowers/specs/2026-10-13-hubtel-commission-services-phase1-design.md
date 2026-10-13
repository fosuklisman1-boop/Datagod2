# Hubtel Commission Services — Phase 1: Foundation (design)

Date: 2026-10-13 · Branch: `worktree-hubtel-commission-services` · Status: **draft for review**
Related: `docs/hubtel-commission-services/api-reference.md`, UI refs in `docs/hubtel-commission-services/ref/`, approved plan `C:\Users\User2\.claude\plans\lets-plan-on-integrating-steady-orbit.md`.

## 1. Goal

Build the shared plumbing every Hubtel Commission Services product will use, so Phases 2–4 (airtime/data provider, utility bills, USSD/WhatsApp) only add product logic. Phase 1 sells nothing to customers. It ships **dark** (disabled by config) and is verified with GHS 0.50-class live test calls from an admin-only test panel.

Success = an admin can enable Hubtel, fire a test airtime/data call, watch it go `pending → fulfilled|failed` via callback **or** status-check fallback, see the Hubtel commission recorded, and see every failed/unknown transaction land in a review queue — with no money-losing edge case (duplicate send, orphaned request, silent stuck state).

## 2. Scope

**In:** Hubtel client (direct or via DO relay), service registry, `hubtel_cs_transactions` ledger + event log, state machine, callback route, status-check cron, 4075 float pause + admin alert, admin page (Settings / Transactions / Review Queue), order-adapter interface, tests.
**Out (later phases):** customer UI, order tables, airtime/data provider wiring, bills, commission wallets, Hubtel Direct Pay, bots, bundle import. Telecel Postpaid Bills and Telecel Broadband are registered in the service registry but disabled (no/partial docs, not in UI refs).

## 3. Key design decisions (and why)

1. **Persist before you call.** Insert the ledger row (`state='created'`, unique `client_reference`) *before* the POST to Hubtel. Prevents orphaned Hubtel calls with no local record (same bug class as the old `fulfillment_logs` orphaning).
2. **Never auto-resend a POST.** Timeout, network error or `0005` (state unknown) → `needs_review`, never a second POST. Hubtel's de-duplication on `ClientReference` is undocumented, so we don't rely on it. Resolution is by status check or admin.
3. **Failures never auto-refund** (user decision). The ledger only reports state; refunds are manual, done from the review queue via the product's order adapter.
4. **Callback authenticated per transaction.** Hubtel has no signature; `CallbackUrl` carries `?ref=<clientReference>&sig=<HMAC-SHA256(ref, HUBTEL_CS_CALLBACK_SECRET)>`. Verified with timing-safe compare. Optional source-IP check (`18.202.122.131`) via `HUBTEL_CS_ENFORCE_CALLBACK_IP`, mirroring the USSD route.
5. **Forward-only, idempotent transitions.** Terminal states (`fulfilled`, `failed`) never change except through an explicit admin resolve. Duplicate/late callbacks are logged and ignored. (Lesson from the reversal-safeguard and completed→pending incidents.)
6. **Status check is a fallback, with a conservative failure rule.** `Paid + isFulfilled=true` → fulfilled. `Unpaid/isFulfilled=false` counts as failed only after the txn is older than 10 min *and* seen twice; `isFulfilled=null` → keep polling; still unresolved after 24 h → `needs_review`.
7. **Transport is a setting, not code.** `mode: relay | direct` in config, because it is unconfirmed whether `cs.hubtel.com` requires the whitelisted IP. In relay mode credentials live only on the droplet.
8. **Config in `admin_settings`** (key `hubtel_cs_config`), never `app_settings` (known collision, see memory).

## 4. Data model (migrations `0113_hubtel_cs_transactions.sql`, `0114_hubtel_cs_events.sql`; additive, service-role only: RLS on, `REVOKE ALL` from anon/authenticated, like 0106)

`hubtel_cs_transactions`
- `id uuid pk`, `client_reference text unique not null` (≤100 chars, `[A-Za-z0-9_-]`, format `HCS-{serviceKey}-{ulid}`)
- `service_key text not null` (e.g. `airtime_mtn`, `data_at`, `bill_ecg`), `kind text check in (airtime,data,bill)`
- `destination text not null`, `amount numeric(12,2) not null`, `bundle text`, `extra jsonb` (e.g. Ghana Water email/sessionId)
- `state text not null default 'created' check in (created,pending,fulfilled,failed,needs_review)`
- `response_code text`, `response_message text`, `failure_reason text`
- `hubtel_transaction_id text`, `external_transaction_id text`
- `commission numeric(12,6)` (Hubtel returns a string with 4 dp; store as numeric), `charges numeric(12,4)`, `amount_debited numeric(12,2)`
- `order_table text`, `order_id uuid` (nullable; set by the product that owns the order)
- `submitted_at`, `completed_at`, `callback_received_at timestamptz`
- `status_check_attempts int default 0`, `negative_checks int default 0`, `last_status_check_at timestamptz`
- `refund_claimed_at timestamptz`, `refund_claimed_by uuid` (atomic refund claim; see section 10)
- `review_reason text`, `resolved_by uuid`, `resolved_at timestamptz`, `resolution_note text`
- `created_at`, `updated_at`
- Indexes: `(state)` partial on `pending`/`needs_review`/`created`, `(order_table, order_id)`, `(created_at desc)`, plus a partial UNIQUE index on `(order_table, order_id) WHERE order_id IS NOT NULL AND state <> 'failed'` (one active transaction per order).
- RPC `hubtel_cs_stats()` (service_role only, `SET search_path = public`): one row of counts (total, in_flight, needs_review, failed, fulfilled) and `commission_earned`, used by the admin page.

`hubtel_cs_events` (audit trail per txn): `id, created_at, client_reference, direction check in (request,response,callback,status_check), http_status, ok, payload jsonb, error, source_ip`. 30-day retention purge in the status-check cron (same pattern as `hubtel_callback_logs`). Payload logging strips/masks nothing secret because credentials are never in payloads; destination numbers are stored (service-role only).

## 5. State machine (pure, unit-tested)

```
created ──POST ok, code 0001──────────▶ pending ──callback 0000 / status Paid+fulfilled──▶ fulfilled
   │                                      │ ──callback ≠0000 / status Unpaid&unfulfilled (conf.)──▶ failed
   │                                      └─ unresolved > 24h or status-check errors ─────────────▶ needs_review
   ├─POST returns definite error (4010/4101/4103/2000/2001/4000) ─────────▶ failed
   ├─POST returns 4075 ────────────────────────▶ failed + float pause + alert (order flagged for manual retry/refund)
   └─POST timeout / 0005 / unparsable ──────────▶ needs_review (never resent)
```
`created` rows older than 2 min with no response are swept to `needs_review` by the cron (process died mid-call).
Immediate `0000` on POST (not documented for these endpoints) is treated as `fulfilled`.

## 6. Components (all new unless noted)

- `lib/hubtel-cs/services.ts` — registry mapping `serviceKey` → `{ serviceId, kind, network, hasQuery, queryParam, maxAmount (airtime 100), enabledByDefault }` from the API reference.
- `lib/hubtel-cs/transport.ts` — `direct` (fetch `cs.hubtel.com` with Basic auth from env) and `relay` (fetch `HUBTEL_RELAY_URL/cs/...` with bearer) behind one interface; 10 s timeouts; returns raw status + body.
- `lib/hubtel-cs/client.ts` — `query(serviceKey, destination, extra?)`, `purchase({serviceKey, destination, amount, bundle?, extra?, callbackBase})` (does steps 1–3 of §3: insert row → POST → apply response through state machine), `statusCheck(clientReference)` (reuses relay `/status`, i.e. existing `checkTransactionStatus`-style call; **assumes the existing Collection account is the right one for commission txns — confirm**).
- `lib/hubtel-cs/state-machine.ts` — pure `applyResponse | applyCallback | applyStatusCheck | sweep` → next state + patch. No I/O.
- `lib/hubtel-cs/ledger.ts` — Supabase store (`insert`, `getByRef`, `update` with `WHERE state = <expected>` guards so concurrent callback/cron can't regress state), `listForAdmin`.
- `lib/hubtel-cs/callback.ts` — HMAC sign/verify, payload parse, IP allow-list helper.
- `lib/hubtel-cs/config.ts` — get/set `hubtel_cs_config` `{ enabled, mode, paused, pausedReason, pausedAt, services: Record<serviceKey, boolean> }` with validation (pattern from `lib/ussd-hubtel/config.ts`).
- `lib/hubtel-cs/float.ts` — on 4075: set `paused=true` (reason, timestamp), notify admins through `lib/admin-actions/` notifier; `purchase()` refuses while paused with a typed `HubtelPausedError` (products map it to "temporarily unavailable"). Admin "Resume" clears it. The low-balance threshold alert uses the existing `fetchDisbursementBalance()` (relay `/balance`); the float is shared with Hubtel SMS.
- `lib/hubtel-cs/adapters.ts` — `OrderAdapter { table; markFulfilled(orderId, tx); markFailed(orderId, tx); refundToWallet(orderId, tx, adminId) }` + registry. Phase 1 ships interface, registry and a fake adapter used in tests/test panel; real adapters arrive per product.
- `app/api/hubtel-cs/callback/route.ts` — POST; verify sig (+ optional IP) → load row → `applyCallback` → store commission/IDs → `adapter.markFulfilled|markFailed` if linked → log event. Always 200 after auth to stop Hubtel retries; 401 on bad sig.
- `app/api/cron/hubtel-cs-status-check/route.ts` (+ `vercel.json` every 2 min, `verifyCronAuth`, time budget like the USSD cron) — sweeps `created`, polls `pending` older than 5 min (mandatory per Hubtel), purges old events.
- `app/api/admin/hubtel-cs/{config,transactions,check-status,resolve,test-purchase}/route.ts` — all behind `verifyAdminAccess`; `test-purchase` only works while `config.enabled` and caps amount at GHS 5.
- `app/admin/hubtel-commission/page.tsx` — tabs **Settings | Transactions | Review Queue**, styled like the admin Utility Bills reference (light cards, pill tabs, row-list with status chips, stat cards: total, in flight, commission earned, failed/needs review). Settings: master enable, transport mode, per-service toggles, pause state + Resume, credential/relay readiness checklist (never shows secrets). Review Queue actions: **Check status**, **Mark resolved** (fulfilled/failed + note), and **Refund to wallet** (enabled only when a real adapter is registered for the row's `order_table`). Add to admin nav.
- Relay change: `lib/ussd-hubtel/relay-handler.ts` gains `ALL /cs/<disbursement>/<serviceId>` passthrough — path must match `^/cs/[a-f0-9]{32}$` (the relay env supplies the Disbursement account; this passthrough is an optional fallback, the default transport is `direct`), method POST|GET, query string forwarded only for GET (`destination`, `mobile`), body size-capped, creds from droplet env `HUBTEL_CS_BASIC_AUTH` + `HUBTEL_DISBURSEMENT_ACCOUNT`, same bearer auth and 8 s timeout. `scripts/hubtel-relay/server.ts` env check extended only when CS is used. Droplet must be redeployed (runbook update in `docs/hubtel-ussd-runbook.md`).

## 7. Environment

Vercel: `HUBTEL_CS_CALLBACK_SECRET` (new), `HUBTEL_CS_ENFORCE_CALLBACK_IP` (optional), and for **direct** mode `HUBTEL_CS_BASIC_AUTH` + `HUBTEL_DISBURSEMENT_ACCOUNT`. Droplet (relay mode): same two creds. Existing `HUBTEL_RELAY_URL/SECRET` reused. Before coding, grep the repo for an existing `HUBTEL_DISBURSEMENT_ACCOUNT` usage and reuse its name.

## 8. Testing (Vitest, fake-client pattern per `reference-testing`)

- State machine: every transition incl. forbidden ones (terminal never moves; 0005 never → pending; duplicate callback no-op; 4075 → failed+pause).
- Client: persists-before-call; request shape per service (airtime, data `Extradata.bundle`, ECG, Ghana Water `Email/SessionId`); amount 2-dp and airtime ≤100 guards; no resend on timeout.
- Callback: bad/missing sig 401, good sig processes once, replay idempotent, failed callback with Description stored.
- Status-check: conservative failure rule (needs 10 min + two observations), `isFulfilled=null` keeps polling, 24 h → needs_review, `created` sweep.
- Config validation and pause/resume; relay-handler `/cs` path allow-list and refusal of other hosts/paths.
- Before any push to main: real placeholder-env `next build` (memory: tsc+vitest miss Next route-export rules).
- Live (after deploy, dark): admin test-purchase GHS 0.50 airtime on each network, confirm callback and commission; kill callback URL to force the status-check path.

## 9. Review outcome (2026-10-13) and remaining open items

Answered by the user:
1. **Transport:** `cs.hubtel.com` works **direct from Vercel** -> default `mode = direct`. The relay `/cs` passthrough stays as an optional fallback (small, tested) but is not the default. **Status checks still go through the existing relay**: Hubtel's docs say the status-check endpoint is IP-whitelisted (max 4 IPs) and uses the Collection account.
2. **Credentials:** the docs specify Basic auth + Disbursement Account Number in the URL (commission calls) and the Collection Account Number (status check); they do not say the Basic-auth pair is shared. Design: commission calls use `HUBTEL_CS_BASIC_AUTH` + `HUBTEL_DISBURSEMENT_ACCOUNT` (the keys issued for Commission Services); status check keeps the existing `HUBTEL_STATUS_BASIC_AUTH` + `HUBTEL_COLLECTION_ACCOUNT` on the relay. Admin page shows a readiness checklist for each.
3. **Float balance:** resolved. `float.ts` uses the existing `fetchDisbursementBalance()` (relay `/balance`) for the low-balance threshold alert (config `lowBalanceThreshold`, cron check). The float is shared with Hubtel SMS; the 4075 pause + alert remains the safety net.
4. **Spec approved** -> next is the implementation plan.

Still open (defaults apply, revisit if Hubtel says otherwise):
- Hubtel de-duplication of a repeated `ClientReference`: unknown, so v1 never resends an unknown POST.
- Callback retry policy: unknown, so the callback route answers 200 after authentication and the status-check cron is the backstop.

## 10. Later design decisions (made during the build)

- **Refund claim:** refunds are manual. An atomic claim (`refund_claimed_at` / `refund_claimed_by`, set with a conditional update on `state='failed' AND refund_claimed_at IS NULL`) prevents double refunds. If an order adapter throws, the claim is deliberately kept because the wallet may already have been credited; an admin clears it by SQL only after verifying the wallet. Rows an admin resolved to `failed` need `force` to refund. A refunded or claimed row cannot be marked fulfilled.
- **`HubtelOutcomeUnknownError`:** thrown when the POST may have been sent but the outcome could not be recorded. Callers must never retry; the admin finds the row by reference in Transactions.
- **Per-order unique index:** `hubtel_cs_tx_order_active_uidx` allows one non-failed transaction per `(order_table, order_id)`. A `needs_review` order therefore blocks re-purchase until resolved to `failed` (`HubtelDuplicateOrderError`).
- **Destination normalisation:** airtime and data destinations are normalised to and stored as `233XXXXXXXXX`; admin search accepts 0-prefixed numbers. Bill account numbers pass through untouched and their formats are unverified.
- **Callback auth:** the callback URL carries an HMAC signature in its query string (`HUBTEL_CS_CALLBACK_SECRET`).
- **4075 alert debounce:** the first 4075 after a Resume always alerts; repeats are debounced for 1 hour.
