# MTN Registration Gate — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the gate is enabled, MTN data orders for numbers not yet `registered` in `mtn_number_registry` are held (status `held_registration`, customer SMS + on-screen notice) instead of failing at the provider, and are auto-fulfilled the moment the number is marked registered (push from mark-registered + hourly self-heal cron).

**Architecture:** The gate lives inside `createMTNOrder` (the chokepoint all 9 dispatch paths funnel through) and returns a typed `held` result; callers translate it via a shared `holdMtnOrder()` helper into the `held_registration` status + one hold SMS. `releaseHeldMtnOrders()` (same lib) confirms registry status, atomically claims `held_registration → pending`, and dispatches through the existing fulfillment functions — called by the mark-registered route (push) and a new cron (self-heal). Kill-switch `admin_settings.mtn_registration_gate_enabled` ships OFF. No DDL anywhere.

**Tech Stack:** Next.js 15 App Router, Supabase (service-role), existing SMS service, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-07-mtn-registration-gate-phase2-design.md`

---

## Verified environment facts (from code extraction — rely on these)

- `MTNOrderResponse` is at `lib/mtn-fulfillment.ts:28-35`; `createMTNOrder` at `:290` opens with `const { getMTNProvider, getProviderByName } = await import(...)` then `try {` at `:293` — the gate slots right after `try {`, before provider selection. Dynamic `await import(...)` is an established pattern in this file (`:291`) and in `fulfillment-service.ts:302` — use it in `lib/mtn-hold.ts` to avoid the `mtn-hold ↔ fulfillment-service` circular import.
- `isAutoFulfillmentEnabled()` at `lib/mtn-fulfillment.ts:150-177` is the reader to mirror; `setAutoFulfillmentEnabled` at `:182`.
- Caller sites and their current failure behavior:
  - **Revert-to-pending sites:** `lib/fulfillment-service.ts:281-284` (in-flight status `processing`; table/status col from `:31-32`), `lib/ussd/fulfill.ts:72-79` (`markUssdOrderStatus(orderId,'pending',orderTable)`), `app/api/fulfillment/process-order/route.ts:292-304` (claimed `processing` at `:270-279`).
  - **Fire-and-forget sites (no revert; order stays `pending` from creation):** `app/api/wallet/debit/route.ts:335-362` (shop_orders), `app/api/orders/purchase/route.ts:435-461` (orders), `app/api/v1/orders/route.ts:227-233` (api_orders), `app/api/orders/create-bulk/route.ts:399-428` (orders, loop), `app/api/admin/payment-attempts/route.ts:601-624` (shop_orders).
- Status columns: `orders`/`api_orders` → `status`; `shop_orders`/`ussd_orders`/`ussd_shop_orders` → `order_status` (matches `fulfillment-service.ts:31-32`).
- **SMS convention: templates never name the network** — they use `networkColor(network)` aliases (see `ussdOrderConfirmed`, `lib/sms-service.ts:180-192`). The hold SMS must use `networkColor("MTN")`, not the string "MTN". `SMSTemplates` object opens at `:71`; `sendSMS(payload: SMSPayload)` at `:767`.
- Cron auth: `verifyCronAuth(request)` from `@/lib/cron-auth` (see `app/api/cron/wa-delivery-notify/route.ts:17-19`); `vercel.json` `crons` array at lines 7-100.
- Settings route to copy: `app/api/admin/settings/mtn-auto-fulfillment/route.ts` (full file captured; 117 lines). Admin page handlers `loadSettings` (`app/admin/settings/mtn/page.tsx:76-106`) + `handleToggle` (`:131-168`); toggle Card at `:338-390`.
- Status surfaces: `app/shop/[slug]/order-status/page.tsx` `getStatusColor`/`getStatusIcon` (`:151-181`); `app/dashboard/my-orders/page.tsx` `getStatusBadgeColor` (`:152-165`, used at `:354`); `app/shop/[slug]/order-confirmation/[orderId]/page.tsx` raw `order.order_status` badge (`:112-117`) + "being processed" copy (`:85-87`); `lib/ussd/handlers/status.ts` mapping (`:40-54`).
- Registry side: `app/api/admin/mtn-registration/list/route.ts` (40 lines, counts loop) and page cards grid (`app/admin/mtn-registration/page.tsx:163-178`); mark-registered route flips registry rows with `.select("id")` (numbers-first, batch-last ordering — keep it).
- Tests co-located; `npm run test:run` currently 272 passing; `npx tsc --noEmit` clean.

## File structure

- **Create** `lib/mtn-hold.ts` (+ `lib/mtn-hold.test.ts`) — pure decision helpers (`decideMtnGate`, `statusColumnFor`, `HOLD_STATUS`) + `holdMtnOrder` + `releaseHeldMtnOrders`.
- **Modify** `lib/mtn-fulfillment.ts` — `held` field, gate readers/writers, gate check in `createMTNOrder`.
- **Modify** `lib/sms-service.ts` — `SMSTemplates.mtnRegistrationHold`.
- **Modify** the 8 caller sites (held branch each).
- **Create** `app/api/cron/release-held-mtn-orders/route.ts`; **modify** `vercel.json`.
- **Modify** `app/api/admin/mtn-registration/mark-registered/route.ts` (push release), `list/route.ts` + `app/admin/mtn-registration/page.tsx` (held count).
- **Create** `app/api/admin/settings/mtn-registration-gate/route.ts`; **modify** `app/admin/settings/mtn/page.tsx` (toggle card).
- **Modify** 4 status surfaces.

---

## Task 1: Pure decision helpers (`lib/mtn-hold.ts`) — TDD

**Files:**
- Create: `lib/mtn-hold.ts`
- Test: `lib/mtn-hold.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/mtn-hold.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decideMtnGate, statusColumnFor, HOLD_STATUS, MTN_ORDER_TABLES } from './mtn-hold'

describe('decideMtnGate', () => {
  it('never holds when the gate is disabled', () => {
    expect(decideMtnGate(false, 'pending').hold).toBe(false)
    expect(decideMtnGate(false, null).hold).toBe(false)
  })
  it('passes registered numbers', () => {
    expect(decideMtnGate(true, 'registered').hold).toBe(false)
  })
  it('holds pending / submitted / rejected', () => {
    expect(decideMtnGate(true, 'pending').hold).toBe(true)
    expect(decideMtnGate(true, 'submitted').hold).toBe(true)
    expect(decideMtnGate(true, 'rejected').hold).toBe(true)
  })
  it('holds when the number is missing from the registry', () => {
    expect(decideMtnGate(true, null).hold).toBe(true)
  })
})

describe('statusColumnFor', () => {
  it('maps every MTN order table to its status column', () => {
    expect(statusColumnFor('orders')).toBe('status')
    expect(statusColumnFor('api_orders')).toBe('status')
    expect(statusColumnFor('shop_orders')).toBe('order_status')
    expect(statusColumnFor('ussd_orders')).toBe('order_status')
    expect(statusColumnFor('ussd_shop_orders')).toBe('order_status')
  })
  it('covers exactly the 5 data tables', () => {
    expect([...MTN_ORDER_TABLES].sort()).toEqual(
      ['api_orders', 'orders', 'shop_orders', 'ussd_orders', 'ussd_shop_orders'].sort()
    )
  })
})

describe('HOLD_STATUS', () => {
  it('is the dedicated held status value', () => {
    expect(HOLD_STATUS).toBe('held_registration')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/mtn-hold.test.ts`
Expected: FAIL — cannot find module `./mtn-hold`.

- [ ] **Step 3: Create the module with the pure parts**

Create `lib/mtn-hold.ts`:

```ts
// MTN registration gate — hold & release machinery (Phase 2).
// MTN only fulfills data to numbers pre-registered in their system
// (mtn_number_registry, Phase 1). When the gate is enabled, orders for
// unregistered numbers are HELD (status 'held_registration') instead of being
// sent to the provider (where they would just fail), and are released
// automatically once the number is marked registered.
//
// 'held_registration' is deliberately NOT 'pending': the admin manual-fulfill
// queue and verify-pending-payments both select 'pending', so a held order is
// invisible to them by construction (no doomed provider pushes).
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export const HOLD_STATUS = "held_registration"

export const MTN_ORDER_TABLES = [
  "orders",
  "shop_orders",
  "api_orders",
  "ussd_orders",
  "ussd_shop_orders",
] as const
export type MtnOrderTable = (typeof MTN_ORDER_TABLES)[number]

/** Status column per table (same mapping as lib/fulfillment-service.ts). */
export function statusColumnFor(table: MtnOrderTable): "status" | "order_status" {
  return table === "orders" || table === "api_orders" ? "status" : "order_status"
}

/**
 * Pure gate decision. Hold iff the gate is enabled AND the registry does not
 * say 'registered' (missing row counts as not registered).
 */
export function decideMtnGate(
  gateEnabled: boolean,
  registryStatus: string | null
): { hold: boolean } {
  if (!gateEnabled) return { hold: false }
  return { hold: registryStatus !== "registered" }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run lib/mtn-hold.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/mtn-hold.ts lib/mtn-hold.test.ts
git commit -m "feat: MTN gate pure decision helpers (decideMtnGate, statusColumnFor)"
```

---

## Task 2: Gate in `createMTNOrder` + settings readers + hold SMS template

**Files:**
- Modify: `lib/mtn-fulfillment.ts` (`MTNOrderResponse` at :28-35, after `isAutoFulfillmentEnabled` :150-177, inside `createMTNOrder` :290-293)
- Modify: `lib/sms-service.ts` (inside `SMSTemplates`, near `orderPaymentConfirmed` :82)

- [ ] **Step 1: Extend `MTNOrderResponse`**

In `lib/mtn-fulfillment.ts`, change:

```ts
export interface MTNOrderResponse {
  success: boolean
  order_id?: number | string
  message: string
  traceId?: string
  error_type?: string
  provider?: string // Which provider was used: "sykes" or "datakazina"
}
```
to:
```ts
export interface MTNOrderResponse {
  success: boolean
  order_id?: number | string
  message: string
  traceId?: string
  error_type?: string
  provider?: string // Which provider was used: "sykes" or "datakazina"
  /** Registration gate: number not yet registered with MTN — order should be
   *  HELD (lib/mtn-hold.ts), not treated as a provider failure. */
  held?: boolean
}
```

- [ ] **Step 2: Add the gate setting readers (mirror `isAutoFulfillmentEnabled`)**

In `lib/mtn-fulfillment.ts`, directly AFTER the `isAutoFulfillmentEnabled` function (ends line ~177), add:

```ts
/**
 * Registration gate kill-switch (Phase 2). Default OFF — enable ONLY after the
 * registry back-catalog has been confirmed registered by the provider,
 * otherwise every MTN order would hold.
 */
export async function isRegistrationGateEnabled(): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", "mtn_registration_gate_enabled")
      .maybeSingle()
    if (error) {
      console.error("[MTN-GATE] Error checking gate setting:", error)
      return false
    }
    return data?.value?.enabled === true
  } catch (error) {
    console.error("[MTN-GATE] Error checking gate setting:", error)
    return false
  }
}

export async function setRegistrationGateEnabled(enabled: boolean): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("admin_settings")
      .upsert(
        {
          key: "mtn_registration_gate_enabled",
          value: { enabled },
          description: "Phase 2 MTN registration gate: hold orders for numbers not yet registered with MTN",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "key" }
      )
    if (error) {
      console.error("[MTN-GATE] Error updating gate setting:", error)
      return false
    }
    return true
  } catch (error) {
    console.error("[MTN-GATE] Error updating gate setting:", error)
    return false
  }
}
```

(Check how `setAutoFulfillmentEnabled` at :182 writes — if it uses a different upsert shape, match it.)

- [ ] **Step 3: Add the gate check inside `createMTNOrder`**

In `createMTNOrder` (:290), insert the gate between `try {` and the provider selection:

```ts
export async function createMTNOrder(order: MTNOrderRequest): Promise<MTNOrderResponse> {
  const { getMTNProvider, getProviderByName } = await import("@/lib/mtn-providers/factory")

  try {
    // Registration gate (Phase 2): MTN only fulfills pre-registered numbers.
    // Fails OPEN on plumbing errors — the gate is a UX layer, never a new
    // point of fulfillment failure.
    try {
      if (await isRegistrationGateEnabled()) {
        const { decideMtnGate } = await import("@/lib/mtn-hold")
        const { normalizeGhanaPhone } = await import("@/lib/phone-format")
        const norm = normalizeGhanaPhone(order.recipient_phone)
        let registryStatus: string | null = null
        if (norm) {
          const { data: reg } = await supabase
            .from("mtn_number_registry")
            .select("status")
            .eq("phone", norm)
            .maybeSingle()
          registryStatus = reg?.status ?? null
          if (!reg) {
            // Defensive: capture trigger should have enrolled it at order INSERT.
            await supabase
              .from("mtn_number_registry")
              .upsert({ phone: norm, source: "gate", status: "pending" }, { onConflict: "phone", ignoreDuplicates: true })
          }
        }
        if (decideMtnGate(true, registryStatus).hold) {
          console.log(`[MTN-GATE] HOLD — ${norm ?? order.recipient_phone} not registered (status=${registryStatus ?? "missing"})`)
          return {
            success: false,
            held: true,
            message: "Number not yet registered with MTN — order held",
            traceId: order.traceId,
            error_type: "NUMBER_NOT_REGISTERED",
          }
        }
      }
    } catch (gateErr) {
      console.error("[MTN-GATE] Gate check failed — failing open:", gateErr)
    }

    // Get the selected provider (either forced in request or from global settings)
    const provider = order.provider
      ? getProviderByName(order.provider as any)
      : await getMTNProvider()
    ...unchanged from here...
```

- [ ] **Step 4: Add the hold SMS template**

In `lib/sms-service.ts`, inside `SMSTemplates` (after `orderPaymentConfirmed`, :82-83), add — note the `networkColor` convention (never name the network in SMS):

```ts
  // Phase 2 registration gate: order held while the number is activated.
  mtnRegistrationHold: (phone: string) =>
    `DTGOD: ${phone} is being activated for ${networkColor("MTN")} data service. Your order will be delivered automatically once activation completes (usually within a day).`,
```

- [ ] **Step 5: Type-check + full suite**

Run: `npx tsc --noEmit` then `npx vitest run lib/mtn-hold.test.ts`
Expected: both clean (gate is dark: setting absent → `false` → zero behavior change).

- [ ] **Step 6: Commit**

```bash
git add lib/mtn-fulfillment.ts lib/sms-service.ts
git commit -m "feat: registration gate inside createMTNOrder (ships dark) + hold SMS template"
```

---

## Task 3: `holdMtnOrder` + `releaseHeldMtnOrders`

**Files:**
- Modify: `lib/mtn-hold.ts`

- [ ] **Step 1: Append the hold + release functions**

Append to `lib/mtn-hold.ts`:

```ts
/** Phone (beneficiary) column per table — same mapping as the Phase 1 capture trigger. */
export function phoneColumnFor(table: MtnOrderTable): string {
  if (table === "orders") return "phone_number"
  if (table === "shop_orders") return "customer_phone"
  return "recipient_phone" // api_orders / ussd_orders / ussd_shop_orders
}

function serviceClient() {
  return createClient(supabaseUrl, serviceRoleKey)
}

/**
 * Mark an order held (guarded: only from an in-flight status) and send the
 * one-time hold SMS. Best-effort SMS — never fails the hold.
 */
export async function holdMtnOrder(params: {
  table: MtnOrderTable
  orderId: string
  phone: string
}): Promise<{ held: boolean }> {
  const { table, orderId, phone } = params
  const supabase = serviceClient()
  const statusCol = statusColumnFor(table)

  const { data, error } = await supabase
    .from(table)
    .update({ [statusCol]: HOLD_STATUS, updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .in(statusCol, ["pending", "processing"]) // never clobber terminal states
    .select("id")

  if (error || !data || data.length === 0) {
    if (error) console.error(`[MTN-HOLD] hold update failed for ${table}/${orderId}:`, error)
    return { held: false }
  }

  console.log(`[MTN-HOLD] HELD ${table}/${orderId} (${phone})`)
  try {
    const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
    await sendSMS({ to: phone, message: SMSTemplates.mtnRegistrationHold(phone) })
  } catch (smsErr) {
    console.warn(`[MTN-HOLD] hold SMS failed for ${orderId} (non-fatal):`, smsErr)
  }
  return { held: true }
}

/**
 * Release held orders whose beneficiary number is now 'registered'.
 * - phones (optional): normalized 0XXXXXXXXX hints from a just-registered
 *   batch; the registry is ALWAYS re-checked (hints are not trusted).
 * - Claims are guarded (held_registration -> pending) so a concurrent sweep
 *   skips rows another worker took.
 * - Dispatch reuses the existing fulfillment paths; a provider failure there
 *   follows the existing convention (order back to 'pending', admin-visible).
 *   Release NEVER re-holds. Deliberately ignores the gate toggle: draining
 *   holds must always work, even after the gate is switched off.
 */
export async function releaseHeldMtnOrders(
  phones?: string[]
): Promise<{ checked: number; released: number; dispatched: number; failed: number }> {
  const supabase = serviceClient()
  const { normalizeGhanaPhone } = await import("@/lib/phone-format")
  const hint = phones?.length
    ? new Set(phones.map(p => normalizeGhanaPhone(p) ?? p))
    : null

  let checked = 0, released = 0, dispatched = 0, failed = 0

  for (const table of MTN_ORDER_TABLES) {
    const statusCol = statusColumnFor(table)
    const phoneCol = phoneColumnFor(table)
    const extraCols = table === "ussd_orders" || table === "ussd_shop_orders"
      ? ", network, package_size" : ""

    const { data: heldRows, error } = await supabase
      .from(table)
      .select(`id, ${phoneCol}${extraCols}`)
      .eq(statusCol, HOLD_STATUS)
    if (error) {
      console.error(`[MTN-RELEASE] select failed for ${table}:`, error)
      continue
    }
    if (!heldRows?.length) continue

    // Normalize + optionally filter by the hint set.
    const candidates = (heldRows as any[])
      .map(r => ({ ...r, _norm: normalizeGhanaPhone(String(r[phoneCol] ?? "")) }))
      .filter(r => r._norm && (!hint || hint.has(r._norm)))
    if (!candidates.length) continue
    checked += candidates.length

    // Re-check the registry (source of truth).
    const uniquePhones = [...new Set(candidates.map(r => r._norm as string))]
    const { data: regRows, error: regErr } = await supabase
      .from("mtn_number_registry")
      .select("phone")
      .in("phone", uniquePhones)
      .eq("status", "registered")
    if (regErr) {
      console.error(`[MTN-RELEASE] registry check failed:`, regErr)
      continue
    }
    const registered = new Set((regRows ?? []).map(r => r.phone))

    for (const row of candidates) {
      if (!registered.has(row._norm)) continue

      // Atomic claim: held_registration -> pending.
      const { data: claimed, error: claimErr } = await supabase
        .from(table)
        .update({ [statusCol]: "pending", updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq(statusCol, HOLD_STATUS)
        .select("id")
      if (claimErr || !claimed || claimed.length === 0) continue
      released++

      try {
        if (table === "ussd_orders" || table === "ussd_shop_orders") {
          const { fulfillUssdOrder } = await import("@/lib/ussd/fulfill")
          const res = await fulfillUssdOrder(
            row.id, row.network ?? "MTN", row[phoneCol], row.package_size ?? "",
            false, table
          )
          res.success ? dispatched++ : failed++
        } else {
          const { processManualFulfillment } = await import("@/lib/fulfillment-service")
          const orderType = table === "orders" ? "bulk" : table === "api_orders" ? "api" : "shop"
          const res = await processManualFulfillment(row.id, orderType)
          res.success ? dispatched++ : failed++
        }
      } catch (dispatchErr) {
        console.error(`[MTN-RELEASE] dispatch threw for ${table}/${row.id}:`, dispatchErr)
        failed++
      }
    }
  }

  if (checked > 0) console.log(`[MTN-RELEASE] checked=${checked} released=${released} dispatched=${dispatched} failed=${failed}`)
  return { checked, released, dispatched, failed }
}
```

- [ ] **Step 2: Verify sendSMS payload shape**

Open `lib/sms-service.ts` and check the `SMSPayload` type used by `sendSMS(payload)` (:767). If the field names differ from `{ to, message }` (e.g. `recipient`/`text`), adjust the `holdMtnOrder` SMS call to the real shape.

- [ ] **Step 3: Type-check + tests**

Run: `npx tsc --noEmit && npx vitest run lib/mtn-hold.test.ts`
Expected: clean / 7 pass.

- [ ] **Step 4: Commit**

```bash
git add lib/mtn-hold.ts
git commit -m "feat: holdMtnOrder + releaseHeldMtnOrders (guarded claims, existing dispatch paths)"
```

---

## Task 4: Wire the `held` branch into all 8 caller sites

**Files (all Modify):** the 8 sites below. Pattern: on a `held` result, call `holdMtnOrder` instead of the failure path; skip tracking (a held order never reached a provider). Use `const { holdMtnOrder } = await import("@/lib/mtn-hold")` at each site (matches the dynamic-import convention; avoids cycles).

- [ ] **Step 1: `app/api/fulfillment/process-order/route.ts` (shop; ~:292)**

Change:
```ts
    if (!mtnResponse.success || !mtnResponse.order_id) {
      console.error("[FULFILLMENT] MTN API failed:", mtnResponse.message)
```
to:
```ts
    if (!mtnResponse.success || !mtnResponse.order_id) {
      if (mtnResponse.held) {
        const { holdMtnOrder } = await import("@/lib/mtn-hold")
        await holdMtnOrder({ table: "shop_orders", orderId: shopOrderId, phone: phoneNumber })
        return NextResponse.json({
          success: true,
          message: "Order held pending MTN number registration",
        })
      }
      console.error("[FULFILLMENT] MTN API failed:", mtnResponse.message)
```
(The order was claimed to `processing` at :270-279; `holdMtnOrder`'s `.in(["pending","processing"])` covers it.)

- [ ] **Step 2: `lib/fulfillment-service.ts` (shop/bulk/api; ~:281)**

Change:
```ts
    if (!mtnResponse.success || !mtnResponse.order_id) {
      console.error(`${logPrefix} MTN API failed: ${mtnResponse.message}`)
```
to:
```ts
    if (!mtnResponse.success || !mtnResponse.order_id) {
      if (mtnResponse.held) {
        console.log(`${logPrefix} Registration gate hold — number not yet registered`)
        const { holdMtnOrder } = await import("@/lib/mtn-hold")
        await holdMtnOrder({ table: tableName as any, orderId, phone })
        return { success: false, message: "Held: number pending MTN registration", orderId }
      }
      console.error(`${logPrefix} MTN API failed: ${mtnResponse.message}`)
```

- [ ] **Step 3: `lib/ussd/fulfill.ts` (ussd/ussd_shop; ~:72)**

Change:
```ts
      if (!mtnResponse.success || !mtnResponse.order_id) {
        console.error("[USSD-FULFILL] MTN API failed:", mtnResponse.message)
```
to:
```ts
      if (!mtnResponse.success || !mtnResponse.order_id) {
        if (mtnResponse.held) {
          const { holdMtnOrder } = await import("@/lib/mtn-hold")
          await holdMtnOrder({ table: orderTable, orderId, phone: normalizedPhone })
          return { success: false, message: "Held: number pending MTN registration" }
        }
        console.error("[USSD-FULFILL] MTN API failed:", mtnResponse.message)
```

- [ ] **Step 4: `app/api/wallet/debit/route.ts` (shop; ~:337, after the `createMTNOrder` call)**

Change:
```ts
                  console.log(`[WALLET-DEBIT] ✓ MTN API response for order ${orderId}:`, mtnResult)

                  // Save tracking record
                  if (mtnResult.order_id) {
```
to:
```ts
                  console.log(`[WALLET-DEBIT] ✓ MTN API response for order ${orderId}:`, mtnResult)

                  if (mtnResult.held) {
                    const { holdMtnOrder } = await import("@/lib/mtn-hold")
                    await holdMtnOrder({ table: "shop_orders", orderId, phone: normalizedPhone })
                    return
                  }

                  // Save tracking record
                  if (mtnResult.order_id) {
```
(`return` exits the fire-and-forget IIFE only. If the IIFE body isn't a plain async function where `return` is valid, use an `else` structure instead — keep semantics: held → hold, nothing else.)

- [ ] **Step 5: `app/api/orders/purchase/route.ts` (bulk; ~:437)** — same shape:

```ts
            console.log(`[FULFILLMENT] ✓ MTN API response for order ${order[0].id}:`, mtnResult)

            if (mtnResult.held) {
              const { holdMtnOrder } = await import("@/lib/mtn-hold")
              await holdMtnOrder({ table: "orders", orderId: String(order[0].id), phone: normalizedPhone })
              return
            }

            // Save tracking record (bulk order type since this is from orders table)
            if (mtnResult.order_id) {
```

- [ ] **Step 6: `app/api/v1/orders/route.ts` (api; ~:227)**

Change:
```ts
          const mtnResult = await createMTNOrder(mtnRequest)
          if (orderId && mtnResult.order_id) {
```
to:
```ts
          const mtnResult = await createMTNOrder(mtnRequest)
          if (orderId && mtnResult.held) {
            const { holdMtnOrder } = await import("@/lib/mtn-hold")
            await holdMtnOrder({ table: "api_orders", orderId: String(orderId), phone: normalizePhoneNumber(cleanRecipient) })
          } else if (orderId && mtnResult.order_id) {
```

- [ ] **Step 7: `app/api/orders/create-bulk/route.ts` (bulk loop; ~:401)**

Change:
```ts
                console.log(`[BULK-FULFILLMENT] ✓ MTN API response for order ${order.id}:`, mtnResult)

                // Save tracking record
                if (mtnResult.order_id) {
```
to:
```ts
                console.log(`[BULK-FULFILLMENT] ✓ MTN API response for order ${order.id}:`, mtnResult)

                if (mtnResult.held) {
                  const { holdMtnOrder } = await import("@/lib/mtn-hold")
                  await holdMtnOrder({ table: "orders", orderId: String(order.id), phone: normalizedPhone })
                  continue
                }

                // Save tracking record
                if (mtnResult.order_id) {
```

- [ ] **Step 8: `app/api/admin/payment-attempts/route.ts` (shop; ~:602)**

Change:
```ts
                const mtnResult = await createMTNOrder(mtnRequest)
                console.log(`[ADMIN-PAYMENT-ATTEMPTS] ✓ MTN API response for order ${attempt.order_id}:`, mtnResult)

                if (mtnResult.order_id) {
```
to:
```ts
                const mtnResult = await createMTNOrder(mtnRequest)
                console.log(`[ADMIN-PAYMENT-ATTEMPTS] ✓ MTN API response for order ${attempt.order_id}:`, mtnResult)

                if (mtnResult.held) {
                  const { holdMtnOrder } = await import("@/lib/mtn-hold")
                  await holdMtnOrder({ table: "shop_orders", orderId: String(attempt.order_id), phone: normalizedPhone })
                } else if (mtnResult.order_id) {
```
(Then ensure the original `if (mtnResult.order_id) {` tracking block and the `if (mtnResult.success)` update stay inside the `else` path — adjust braces accordingly.)

- [ ] **Step 9: Verify**

Run: `npx tsc --noEmit && npm run test:run`
Expected: clean / 279 pass (272 + 7 new). Gate is still dark — no behavior change.

- [ ] **Step 10: Commit**

```bash
git add app/api/fulfillment/process-order/route.ts lib/fulfillment-service.ts lib/ussd/fulfill.ts app/api/wallet/debit/route.ts app/api/orders/purchase/route.ts app/api/v1/orders/route.ts app/api/orders/create-bulk/route.ts app/api/admin/payment-attempts/route.ts
git commit -m "feat: held branch at all 8 MTN dispatch sites"
```

---

## Task 5: Release triggers — mark-registered push + self-heal cron

**Files:**
- Modify: `app/api/admin/mtn-registration/mark-registered/route.ts`
- Create: `app/api/cron/release-held-mtn-orders/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Push release in mark-registered**

In `app/api/admin/mtn-registration/mark-registered/route.ts`:
(a) change the registry update's `.select("id")` to `.select("id, phone")`;
(b) after the batch update block (and before the audit insert), add:

```ts
    // Push release: fulfill any held orders for the just-registered numbers.
    // Best-effort — a failure here is caught by the hourly self-heal cron.
    let ordersReleased = 0
    try {
      const phones = (numRows ?? []).map((r: any) => r.phone).filter(Boolean)
      if (phones.length > 0) {
        const { releaseHeldMtnOrders } = await import("@/lib/mtn-hold")
        const rel = await releaseHeldMtnOrders(phones)
        ordersReleased = rel.released
      }
    } catch (relErr) {
      console.error("[MTN-REG-MARK] release failed (cron will catch):", relErr)
    }
```
(c) change the success response to include it:
```ts
    return NextResponse.json({ ok: true, numbersRegistered: numRows?.length ?? 0, ordersReleased })
```

- [ ] **Step 2: Create the self-heal cron**

Create `app/api/cron/release-held-mtn-orders/route.ts`:

```ts
// Hourly self-heal for the MTN registration gate (Phase 2): releases any
// held_registration order whose beneficiary number is now 'registered' in
// mtn_number_registry. Primary release is the mark-registered push; this
// sweep catches crashes mid-release and out-of-band registrations.
import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { releaseHeldMtnOrders } from "@/lib/mtn-hold"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  try {
    const result = await releaseHeldMtnOrders()
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.error("[CRON][RELEASE-HELD-MTN] error:", error)
    return NextResponse.json({ error: "release sweep failed" }, { status: 500 })
  }
}
```

- [ ] **Step 3: Register the cron**

In `vercel.json`, append to the `crons` array (after the `security-alerts` entry):

```json
    {
      "path": "/api/cron/release-held-mtn-orders",
      "schedule": "7 * * * *"
    }
```
(Hourly at :07 — off the :00 spike, matching no other schedule.)

- [ ] **Step 4: Verify + commit**

Run: `npx tsc --noEmit`
Expected: clean.

```bash
git add app/api/admin/mtn-registration/mark-registered/route.ts app/api/cron/release-held-mtn-orders/route.ts vercel.json
git commit -m "feat: release held MTN orders on mark-registered + hourly self-heal cron"
```

---

## Task 6: Admin toggle (settings route + settings page card)

**Files:**
- Create: `app/api/admin/settings/mtn-registration-gate/route.ts`
- Modify: `app/admin/settings/mtn/page.tsx`

- [ ] **Step 1: Create the settings route**

Copy the SHAPE of `app/api/admin/settings/mtn-auto-fulfillment/route.ts` exactly, with these substitutions: import `{ isRegistrationGateEnabled, setRegistrationGateEnabled }` instead; key `"mtn_registration_gate_enabled"`; default-create description `"Phase 2 MTN registration gate: hold orders for numbers not yet registered with MTN"`; POST success message `` `MTN registration gate is now ${enabled ? "ENABLED" : "DISABLED"}` ``; log prefix `[MTN-GATE]`. GET reads the setting via the same `admin_settings` select (auto-create with `{ enabled: false }` when absent); POST validates `typeof enabled !== "boolean"` → 400 and calls `setRegistrationGateEnabled(enabled)`.

- [ ] **Step 2: Add the toggle card to the settings page**

In `app/admin/settings/mtn/page.tsx`:
(a) add state next to the existing settings state: `const [gateSettings, setGateSettings] = useState<{ enabled: boolean; updated_at?: string } | null>(null)` and `const [gateToggling, setGateToggling] = useState(false)`;
(b) add `loadGateSettings` and `handleGateToggle` functions — copies of `loadSettings` (:76-106) and `handleToggle` (:131-168) with the fetch URL `/api/admin/settings/mtn-registration-gate` and the `gateSettings`/`setGateSettings`/`setGateToggling` state; call `loadGateSettings()` wherever `loadSettings()` is called on mount;
(c) directly AFTER the Auto-Fulfillment Card (ends after :390's enclosing `</Card>`), add a new Card following the same structure (:338-390 as the template), with:
- Title: `Registration Gate` (icon: reuse an already-imported icon, e.g. `Zap`'s neighbors — use whatever the file already imports; do not add imports)
- Description: `Hold MTN orders for numbers not yet registered with MTN. Enable ONLY after the registry back-catalog has been marked registered — otherwise every MTN order will hold.`
- Status line: `{gateSettings?.enabled ? "🟢 ENABLED — unregistered numbers are held" : "⚪ DISABLED — orders flow as before"}`
- Button wired to `handleGateToggle` / `gateToggling`, same variant logic as the existing toggle.

- [ ] **Step 3: Verify + commit**

Run: `npx tsc --noEmit`
Expected: clean.

```bash
git add app/api/admin/settings/mtn-registration-gate/route.ts app/admin/settings/mtn/page.tsx
git commit -m "feat(admin): MTN registration gate toggle (ships OFF)"
```

---

## Task 7: Status surfaces + held count

**Files:**
- Modify: `app/shop/[slug]/order-status/page.tsx` (:151-181)
- Modify: `app/shop/[slug]/order-confirmation/[orderId]/page.tsx` (:85-87, :112-117)
- Modify: `lib/ussd/handlers/status.ts` (:40-54)
- Modify: `app/dashboard/my-orders/page.tsx` (:152-165 + where status text renders, :354 area)
- Modify: `app/api/admin/mtn-registration/list/route.ts`
- Modify: `app/admin/mtn-registration/page.tsx` (:163-178)

Shared copy: **"This number is being activated for MTN data. Your bundle will be delivered automatically once it's active — usually within a day."** Shared label: **"Activating number"**.

- [ ] **Step 1: Storefront order-status page**

In `getStatusColor` add before `default:`:
```tsx
      case "held_registration":
        return "bg-warning/15 text-warning border-warning/30"
```
In `getStatusIcon` add before `default:`:
```tsx
      case "held_registration":
        return <Clock className="w-4 h-4" />
```
Then find where the status TEXT renders on this page (the badge label that prints the raw status) and route it through a new helper added beside the two above:
```tsx
  const getStatusLabel = (status: string) =>
    status?.toLowerCase() === "held_registration" ? "Activating number" : status
```
Use `getStatusLabel(...)` at the render site(s) that currently print the raw status string. Where the page shows order detail (if there is a description/notes area near the badge), append the shared explainer line when `order_status === "held_registration"` — a small `<p className="text-xs text-muted-foreground">` with the copy above.

- [ ] **Step 2: Storefront order-confirmation page**

(a) Status badge (:112-117): change `{order.order_status}` to
```tsx
                  {order.order_status === "held_registration" ? "Activating number" : order.order_status}
```
(b) Header copy (:85-87): change the static paragraph to
```tsx
          <p className="text-muted-foreground">
            {order?.order_status === "held_registration"
              ? "This number is being activated for MTN data. Your bundle will be delivered automatically once it's active — usually within a day."
              : "Your order has been received and is being processed."}
          </p>
```
(If `order` isn't in scope at that point in the JSX — it renders before the details card — verify and, if needed, keep the static copy and add the conditional explainer inside the details card near the status badge instead.)

- [ ] **Step 3: USSD status text**

In `lib/ussd/handlers/status.ts` change:
```ts
  const statusLabel = order.order_status === 'completed'
    ? 'Delivered'
    : order.order_status === 'failed'
    ? 'Failed'
    : order.payment_status === 'pending'
    ? 'Awaiting payment'
    : 'Processing'
```
to:
```ts
  const statusLabel = order.order_status === 'completed'
    ? 'Delivered'
    : order.order_status === 'failed'
    ? 'Failed'
    : order.order_status === 'held_registration'
    ? 'Number activation pending'
    : order.payment_status === 'pending'
    ? 'Awaiting payment'
    : 'Processing'
```

- [ ] **Step 4: Dashboard my-orders**

In `getStatusBadgeColor` (:152-165) add before `default:`:
```tsx
      case "held_registration":
        return "bg-warning/10 text-warning"
```
At the Badge render (~:354, `{...getStatusBadgeColor(order.order_status)}`), route the label the same way as Step 1 (an inline ternary or a tiny `getStatusLabel` helper — match the file's style) so it shows "Activating number" instead of the raw value.

- [ ] **Step 5: Held count in the list route**

In `app/api/admin/mtn-registration/list/route.ts`, after the registry counts loop, add:

```ts
    // Held orders across the 5 data tables (Phase 2 gate).
    const HELD_TABLES: Array<[string, string]> = [
      ["orders", "status"],
      ["shop_orders", "order_status"],
      ["api_orders", "status"],
      ["ussd_orders", "order_status"],
      ["ussd_shop_orders", "order_status"],
    ]
    let heldOrders = 0
    for (const [table, col] of HELD_TABLES) {
      const { count, error } = await supabase
        .from(table)
        .select("*", { count: "exact", head: true })
        .eq(col, "held_registration")
      if (!error) heldOrders += count ?? 0
    }
    counts["held_orders"] = heldOrders
```

- [ ] **Step 6: Held card on the admin page**

In `app/admin/mtn-registration/page.tsx` (:163-178), change the grid to 4 columns and add the card:
```tsx
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {([
            ["pending", "pending"],
            ["submitted", "submitted"],
            ["registered", "registered"],
            ["held_orders", "held orders"],
          ] as const).map(([key, label]) => (
            <Card key={key}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium capitalize text-muted-foreground">
                  {label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {loading ? "—" : (counts[key] ?? 0).toLocaleString()}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
```

- [ ] **Step 7: Verify + commit**

Run: `npx tsc --noEmit && npm run test:run`
Expected: clean / 279 pass.

```bash
git add "app/shop/[slug]/order-status/page.tsx" "app/shop/[slug]/order-confirmation/[orderId]/page.tsx" lib/ussd/handlers/status.ts app/dashboard/my-orders/page.tsx app/api/admin/mtn-registration/list/route.ts app/admin/mtn-registration/page.tsx
git commit -m "feat: held_registration status surfaces + held-orders count"
```

---

## Task 8: Full verification + memory update

- [ ] **Step 1: Full suite + types**

Run: `npm run test:run && npx tsc --noEmit`
Expected: 279 pass / clean.

- [ ] **Step 2: Dark-ship assertion**

The gate setting does not exist in `admin_settings` yet → `isRegistrationGateEnabled()` returns `false` → `createMTNOrder` behaves exactly as before. Confirm no test regressions (Step 1 covers this) and grep that nothing enables the gate by default:
`grep -rn "mtn_registration_gate_enabled" --include="*.ts" --include="*.tsx" | grep -v "enabled: false"` — the only writes should be the settings route/`setRegistrationGateEnabled`.

- [ ] **Step 3: Operator end-to-end (after deploy; gate still OFF)**

1. Visit `/admin/settings/mtn` → see the new Registration Gate card, DISABLED.
2. `/admin/mtn-registration` → held orders card shows 0.
3. When ready (back-catalog registered): enable the gate; place an MTN order for an unregistered test number → order shows "Activating number"; SMS arrives; number appears pending in registry; export + mark registered → order auto-fulfills (`ordersReleased` ≥ 1 in the response); cron endpoint returns `{ok:true,...}` when hit with the CRON_SECRET.

- [ ] **Step 4: Update project memory**

Update `project-mtn-number-registration.md`: Phase 2 now BUILT (gate dark, toggle location, held status value, release paths, cron), and update the `MEMORY.md` pointer line.

---

## Self-review notes (author)

- **Spec coverage:** gate in `createMTNOrder` + fail-open (Task 2) ↔ spec §1; `holdMtnOrder` + guarded update + SMS (Task 3) ↔ §2; 8 caller sites (Task 4) ↔ §2 table; `releaseHeldMtnOrders` + push + cron (Tasks 3, 5) ↔ §3; four status surfaces + held count (Task 7) ↔ §4-5; toggle route + card (Task 6) ↔ §5; kill-switch default OFF + release-ignores-toggle encoded in Tasks 2/3; testing ↔ Task 1 truth table + Task 8.
- **Type consistency:** `held?: boolean` on `MTNOrderResponse` (Task 2) is what Tasks 4's branches test; `MtnOrderTable`/`statusColumnFor`/`phoneColumnFor`/`HOLD_STATUS` names consistent across Tasks 1/3/4/5/7; `releaseHeldMtnOrders` return `{checked,released,dispatched,failed}` matches cron + mark-registered usage.
- **Honest flexibility points (bounded, verified by tsc):** exact `SMSPayload` field names (Task 3 Step 2 verifies), the `order` scope check in the confirmation-page header copy (Task 2 of Task 7 notes the fallback), settings-page icon choice (reuse existing imports only), and the raw-status render sites on order-status/my-orders pages (helper given; implementer locates the render line). Everything else is verbatim.
