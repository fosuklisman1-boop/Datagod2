# Design: MTN Registration Gate — Phase 2 (hold, notify, auto-release)

**Date:** 2026-07-07
**Branch:** feat/moolre-withdrawal-integration
**Status:** Approved (brainstorming) — ready for implementation planning
**Related:** Phase 1 spec `2026-07-07-mtn-number-registration-phase1-design.md` (registry + capture + delta export — LIVE in prod)

## Background / problem

MTN only fulfills data to numbers pre-registered in their system. Phase 1 built the registry and the
admin pipeline for handing new numbers to the provider. But an order for a not-yet-registered number
still goes to MTN today and **fails** — the customer paid, sees "pending", and nobody tells them why.

Phase 2 closes the loop: **don't call the provider for an unregistered number.** Hold the order, tell
the customer their number is being activated, and fulfill automatically the moment the number flips
`registered`.

## Decisions (locked during brainstorming)

| Decision | Choice |
|----------|--------|
| Gate location | **Inside `createMTNOrder`** (`lib/mtn-fulfillment.ts`) — the one chokepoint all 9 dispatch paths funnel through. Returns a typed `held` result; callers translate it. Fails safe: a caller that ignores `held` falls into today's failure path (order → `pending`), minus the doomed provider call. |
| Kill-switch | `admin_settings.mtn_registration_gate_enabled` (`{enabled: boolean}`), **default OFF**. Ships dark. **Ops sequencing: enable ONLY after the back-catalog batch is confirmed registered** — today all 66k registry rows are `pending`, so an early enable would hold every MTN order. |
| Channels | **All** — web, shop storefront, wallet checkout, USSD, USSD-shop, bulk, API v1 resellers, admin reprocess. API v1 exposes the raw `held_registration` status string (documented; no API change). |
| Hold marker | New order-status value **`held_registration`** on the existing status column of each of the 5 data tables. Code-only (no CHECK constraints exist on those columns). Deliberately NOT `pending`: `pending` orders appear in the admin manual-fulfill queue and `verify-pending-payments`, which would re-push doomed MTN calls; `held_registration` is invisible to both (they filter on `pending`). |
| Hold notification | **SMS at hold time** (new `SMSTemplates.mtnRegistrationHold`) + on-screen status on web/shop/USSD surfaces. |
| Release | **Push + cron self-heal**: `mark-registered` releases that batch's held orders immediately; an hourly cron sweeps all held orders whose number is now `registered` (catches crashes mid-release and out-of-band registrations). |
| Rejected numbers / refunds | **Out of scope.** Rejected/never-registered numbers stay held and are visible via the admin held-count; manual handling for now. |

## Scope

- Gate + hold + SMS + release machinery + status surfaces + admin toggle + held-count card.
- **MTN data orders only** (the 5 data tables). Airtime/AFA/results untouched. AT/Telecel untouched.

## Architecture

### 1. Gate — `lib/mtn-fulfillment.ts` (`createMTNOrder`)

Before any provider work:

1. Read kill-switch: `isRegistrationGateEnabled()` — new reader mirroring `isAutoFulfillmentEnabled()`
   (line ~150): `admin_settings` key `mtn_registration_gate_enabled`, `.value.enabled === true`,
   absent → `false`.
2. If ON: normalize the beneficiary phone (`normalizeGhanaPhone`) and look up
   `mtn_number_registry.status` for it (service-role client).
   - `registered` → proceed to the provider as today.
   - anything else (`pending`/`submitted`/`rejected`) → return held result.
   - **row missing** (shouldn't happen — the capture trigger enrolls at order INSERT; defensive):
     upsert `{phone, source:'gate', status:'pending'}` `ON CONFLICT DO NOTHING`, then return held.
3. Held result shape: extend `MTNOrderResponse` with optional `held?: boolean`; return
   `{ success: false, held: true, error: "NUMBER_NOT_REGISTERED" }`. No provider call, no tracking row.
4. Gate errors (registry query fails): **fail open** — log and proceed to the provider. The gate is an
   optimization/UX layer; a DB blip must not block fulfillment.

### 2. Hold — new `lib/mtn-hold.ts`

`holdMtnOrder({ table, orderId, phone, statusColumn })`:
- Guarded update: set the order's status column to `'held_registration'` **only if** its current value
  is the caller's in-flight value (e.g. `processing` or `pending` — caller passes what it holds), so a
  concurrent admin action can't be clobbered. (Per-table status column: `orders.status`,
  `api_orders.status`, others `order_status` — same mapping `lib/fulfillment-service.ts` uses.)
- Send `SMSTemplates.mtnRegistrationHold(phone)` once — new template in `lib/sms-service.ts`:
  "Your number {phone} is being activated for MTN data. Your order will be delivered automatically
  once activation completes — usually within a day." Best-effort (SMS failure never fails the hold).

**Caller integration** — each `createMTNOrder` dispatch site adds a `held` branch to its existing
failure handling (instead of reverting to `pending`, call `holdMtnOrder`):

| # | Site | Table(s) |
|---|------|----------|
| 1 | `app/api/fulfillment/process-order/route.ts` (`handleMTNAutoFulfillment`, ~line 290) | shop_orders |
| 2 | `lib/fulfillment-service.ts` (`processManualFulfillment`, ~line 272) | shop/bulk/api |
| 3 | `lib/ussd/fulfill.ts` (`fulfillUssdOrder`, ~line 70) | ussd/ussd_shop |
| 4 | `app/api/wallet/debit/route.ts` (~line 335) | shop_orders |
| 5 | `app/api/orders/purchase/route.ts` (~line 435) | orders |
| 6 | `app/api/v1/orders/route.ts` (~line 227) | api_orders |
| 7 | `app/api/orders/create-bulk/route.ts` (~line 399, loop) | orders |
| 8 | `app/api/admin/payment-attempts/route.ts` (~line 601) | shop_orders |

(`retryMTNOrder` in `lib/mtn-fulfillment.ts` operates on existing tracking rows — a held order never
created one, so no change needed there; if the gate holds during a retry-created dispatch, the shared
`held` branch pattern applies wherever it calls `createMTNOrder`.)

Note: `processManualFulfillment` is also the **release** dispatch path. Release only runs for
`registered` numbers, so the gate passes and no hold-loop is possible.

### 3. Release — `lib/mtn-hold.ts`

`releaseHeldMtnOrders(phones?: string[])`:
1. For each of the 5 tables: select orders with status `held_registration` (+ `payment_status =
   'completed'` where the table has one), optionally filtered to the given normalized phones
   (per-table beneficiary column, same mapping as the Phase 1 capture trigger).
2. For each: confirm `mtn_number_registry.status = 'registered'` for the normalized beneficiary
   (the phones arg is a hint, not trusted).
3. Atomic claim: guarded update `held_registration → pending` (`.eq(statusCol,'held_registration')`,
   select back the claimed row) — a row claimed by a concurrent sweep is skipped.
4. Dispatch: `processManualFulfillment(orderId, table)` for shop/bulk/api;
   `fulfillUssdOrder(order, table)` for ussd/ussd_shop. Failures follow the existing convention
   (provider failure → order back to `pending`, admin-visible) — release never re-holds.
5. Returns `{ released, dispatched, failed }` counts for logging/response.

**Trigger points:**
- **Push:** `app/api/admin/mtn-registration/mark-registered/route.ts` — after the batch flip, change
  the registry update's `.select("id")` to `.select("phone")` and call
  `releaseHeldMtnOrders(phones)`. Response gains `ordersReleased`. Best-effort: release failure logs
  + is reported, but does not roll back the registered marking (the cron will catch it).
- **Self-heal cron:** new `app/api/cron/release-held-mtn-orders/route.ts` — `CRON_SECRET`-gated
  (existing cron convention), calls `releaseHeldMtnOrders()` with no filter, hourly (add to
  `vercel.json` crons with the other schedules).

### 4. Status surfaces

| Surface | File | Change |
|---------|------|--------|
| Storefront order status | `app/shop/[slug]/order-status/page.tsx` (`getStatusColor`/`getStatusIcon`, ~lines 151–181) | `held_registration` → amber badge "Activating number" + explainer line |
| Storefront confirmation | `app/shop/[slug]/order-confirmation/[orderId]/page.tsx` (~lines 86/115/178) | same mapping + explainer replaces "being processed" when held |
| USSD status check | `lib/ussd/handlers/status.ts` (~lines 40–47) | `held_registration` → "Your number is being activated for MTN data. Your bundle will be delivered automatically once ready." |
| Dashboard my-orders | `app/dashboard/my-orders/page.tsx` | status badge mapping for `held_registration` |
| API v1 | none | raw `held_registration` passes through GET; documented behavior |

Explainer copy (shared): **"This number is being activated for MTN data. Your bundle will be
delivered automatically once it's active — usually within a day."**

### 5. Admin

- **Toggle:** new route `app/api/admin/settings/mtn-registration-gate/route.ts` (GET auto-creates
  default `{enabled:false}`, POST updates — copy of the `mtn-auto-fulfillment` settings route) + a
  switch on `app/admin/settings/mtn/page.tsx` beside the auto-fulfillment toggle, labeled
  "Registration gate (hold unregistered numbers)".
- **Held count:** `/admin/mtn-registration` page + its `list` route gain a `held` count (sum of
  `held_registration` rows across the 5 tables) shown as a fourth card, so building holds are visible.

## Safety / failure modes

- **Gate fails open** on registry-read errors (fulfillment never blocked by the gate's own plumbing).
- **Hold is guarded** (status-conditional update) — no clobbering concurrent transitions.
- **Release is idempotent + race-safe** (guarded claim; cron + push can overlap harmlessly).
- **Kill-switch OFF** restores today's behavior instantly; already-held orders still release via
  cron/push (release logic does not check the toggle — draining holds must always work).
- **No DDL** — Phase 2 touches no schema; the only DB write paths are the existing status columns and
  the defensive registry upsert.
- Manual-fulfill queue and `verify-pending-payments` ignore `held_registration` by construction
  (they filter `pending`) — verified in exploration.

## Testing

- **Unit (Vitest, co-located):** pure decision helpers extracted for testability —
  `shouldHoldMtnOrder(gateEnabled, registryStatus)` truth table (registered→pass; pending/submitted/
  rejected/missing→hold; gate off→pass), status-column mapping per table, release claim-filter logic
  (only `registered` phones pass), hold SMS template text.
- **Integration-shaped unit tests** with the repo's fake-client pattern for `holdMtnOrder` (guarded
  update semantics) and `releaseHeldMtnOrders` (claims then dispatches; skips non-registered).
- **Prod verification (transactional, on deploy):** with gate OFF, behavior unchanged (existing suite);
  gate ON smoke — covered by operator test since it needs the full payment loop.
- **Operator end-to-end (after enabling):** place an MTN order for an unregistered test number →
  order shows "Activating number" + SMS arrives → mark the number's batch registered → order
  auto-fulfills within the push path; verify cron releases a manufactured miss.

## Out of scope

- Refund/reject reconciliation for never-registered numbers (manual; future spec).
- Partial-batch rejection handling (Phase 1 caveat stands: mark-registered flips whole batches).
- WhatsApp "delivered" for holds older than 3 days (the existing outbox trigger's window; accepted).
- Changing API v1 response contracts.

## Files (anticipated)

- `lib/mtn-fulfillment.ts` — gate + `isRegistrationGateEnabled()` + `held` result type.
- `lib/mtn-hold.ts` (+ `lib/mtn-hold.test.ts`) — `holdMtnOrder`, `releaseHeldMtnOrders`, shared copy.
- `lib/sms-service.ts` — `SMSTemplates.mtnRegistrationHold`.
- 8 caller sites (table above) — `held` branch.
- `app/api/cron/release-held-mtn-orders/route.ts` + `vercel.json` cron entry.
- `app/api/admin/mtn-registration/mark-registered/route.ts` — push release.
- `app/api/admin/mtn-registration/list/route.ts` + `app/admin/mtn-registration/page.tsx` — held count.
- `app/api/admin/settings/mtn-registration-gate/route.ts` + `app/admin/settings/mtn/page.tsx` — toggle.
- Status surfaces: `app/shop/[slug]/order-status/page.tsx`, `app/shop/[slug]/order-confirmation/[orderId]/page.tsx`, `lib/ussd/handlers/status.ts`, `app/dashboard/my-orders/page.tsx`.
