# SPFastIT Telecel Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, Telecel-scoped SPFastIT integration (`spfastit_telecel`) on top of SPFastIT's newer JSON API (`spfastit.com/wp-json/custom-api/v1`), coexisting with the existing AT-iShare-only `spfastit` provider (`console.spfastit.com`, form-encoded) without touching it.

**Architecture:** A new `MTNProvider` implementation + a thin webhook route backed by a testable processor module (mirroring `bundleportal-webhook-processor.ts`), wired into the existing non-MTN provider-selection machinery (`NonMTNProviderName`, `NON_MTN_CAPABLE`, `getProviderByName`) and every admin surface that lists non-MTN providers.

**Tech Stack:** Next.js route handlers, Supabase (service-role client), Vitest.

## Global Constraints

- Scope is **Telecel only** — this provider must never appear in any MTN-only list (`VALID_PROVIDERS`, `getMTNProvider`, `mtn_retry_sequence`, `PROVIDER_LABELS`).
- The existing `spfastit-provider.ts` (AT-iShare, `console.spfastit.com`) is **not modified**.
- Internal provider name is exactly `spfastit_telecel` everywhere (DB `provider` column, admin dropdown `value`, cron path segment).
- `size_mb = size_gb * 1000` for this API (confirmed from the doc's Telecel size list: 10000/15000/.../50000 MB = 10/15/.../50 GB). Do not use the 1024 convention here.
- Webhook has no documented signature — auth via a `?token=` query param compared timing-safe against `SPFASTIT_TELECEL_WEBHOOK_SECRET`, same pattern as the DataKazina webhook fix.
- Background webhook processing must use `after()` (not a bare fire-and-forget `.then()`), per the AgentPortalGH incident already documented in this codebase (`bundleportal-webhook-processor.ts`'s route comment).

---

### Task 1: Provider class

**Files:**
- Create: `lib/mtn-providers/spfastit-telecel-provider.ts`
- Test: `lib/mtn-providers/spfastit-telecel-provider.test.ts`

**Interfaces:**
- Produces: `SPFastITTelecelProvider` class implementing `MTNProvider` (`name = "spfastit_telecel"`), and exported pure helpers `mapSpfastitTelecelStatus(raw: string): "pending" | "processing" | "completed" | "failed"` and `gbToMb(gb: number): number`.
- Consumes: `MTNProvider`, `MTNOrderRequest`, `MTNOrderResponse`, `MTNOrderStatusResponse` from `./types`; `normalizePhoneNumber`, `isValidPhoneFormat`, `validatePhoneNetworkMatch` from `@/lib/mtn-fulfillment` (same imports `spfastit-provider.ts` already uses).

- [ ] **Step 1: Write the failing tests for the pure helpers**

```typescript
// lib/mtn-providers/spfastit-telecel-provider.test.ts
import { describe, it, expect } from "vitest"
import { mapSpfastitTelecelStatus, gbToMb } from "./spfastit-telecel-provider"

describe("mapSpfastitTelecelStatus", () => {
  it("maps completed", () => {
    expect(mapSpfastitTelecelStatus("completed")).toBe("completed")
    expect(mapSpfastitTelecelStatus("Completed")).toBe("completed")
  })

  it("maps anything containing fail/cancel/reject/block to failed", () => {
    expect(mapSpfastitTelecelStatus("failed")).toBe("failed")
    expect(mapSpfastitTelecelStatus("cancelled")).toBe("failed")
    expect(mapSpfastitTelecelStatus("rejected")).toBe("failed")
    expect(mapSpfastitTelecelStatus("blocked")).toBe("failed")
  })

  it("maps initiated, processing, and unrecognized values to processing", () => {
    expect(mapSpfastitTelecelStatus("initiated")).toBe("processing")
    expect(mapSpfastitTelecelStatus("processing")).toBe("processing")
    expect(mapSpfastitTelecelStatus("something_new")).toBe("processing")
  })
})

describe("gbToMb", () => {
  it("converts GB to MB at the 1000MB=1GB rate confirmed for this API's Telecel sizes", () => {
    expect(gbToMb(10)).toBe(10000)
    expect(gbToMb(50)).toBe(50000)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/mtn-providers/spfastit-telecel-provider.test.ts`
Expected: FAIL — `spfastit-telecel-provider.ts` does not exist yet.

- [ ] **Step 3: Implement the provider**

```typescript
// lib/mtn-providers/spfastit-telecel-provider.ts
/**
 * SPFastIT Telecel Provider — Telecel only.
 *
 * A separate account/API from the existing AT-iShare-only SPFastIT provider
 * (spfastit-provider.ts, console.spfastit.com, form-encoded). This one uses
 * SPFastIT's newer JSON API at spfastit.com/wp-json/custom-api/v1, which
 * also supports MTN — out of scope here; MTN already has 10 providers.
 *
 * size_mb = size_gb * 1000 here (confirmed from the doc's own Telecel size
 * list), unlike the 1024 convention most of this codebase uses elsewhere.
 */
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"

const BASE_URL = process.env.SPFASTIT_TELECEL_BASE_URL ?? "https://spfastit.com/wp-json/custom-api/v1"
const REQUEST_TIMEOUT = 30_000

function apiKey(): string {
  return process.env.SPFASTIT_TELECEL_API_KEY ?? ""
}

async function apiCall(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey(), ...body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  })
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Maps SPFastIT's order_status values to this app's canonical status set.
 * The doc only gives two concrete values ("initiated" right after order
 * placement, "completed" in the status-check example) — no exhaustive list.
 * Anything that reads as a rejection maps to failed; everything else is
 * still in flight. Flag for a live re-test if a real terminal status ever
 * doesn't match this.
 */
export function mapSpfastitTelecelStatus(raw: string): "pending" | "processing" | "completed" | "failed" {
  const s = (raw ?? "").toLowerCase().trim()
  if (s === "completed") return "completed"
  if (/fail|cancel|reject|block/.test(s)) return "failed"
  return "processing"
}

/** GB → MB at this API's confirmed Telecel rate (1000MB = 1GB). */
export function gbToMb(gb: number): number {
  return Math.round(gb * 1000)
}

// ── Provider class ───────────────────────────────────────────────────────────

export class SPFastITTelecelProvider implements MTNProvider {
  name = "spfastit_telecel"

  async createOrder(request: MTNOrderRequest): Promise<MTNOrderResponse> {
    if (!isValidPhoneFormat(request.recipient_phone)) {
      return { success: false, message: `Invalid phone: ${request.recipient_phone}`, error_type: "VALIDATION" }
    }
    if (!validatePhoneNetworkMatch(request.recipient_phone, request.network)) {
      return { success: false, message: `Phone does not match ${request.network}`, error_type: "VALIDATION" }
    }

    const phone = normalizePhoneNumber(request.recipient_phone)
    const webhookSecret = process.env.SPFASTIT_TELECEL_WEBHOOK_SECRET
    const webhookBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://www.datagod.store"
    const webhookUrl = webhookSecret
      ? `${webhookBase}/api/webhooks/mtn/spfastit-telecel?token=${webhookSecret}`
      : undefined

    let res: Response
    try {
      res = await apiCall("/place-order", {
        phone,
        size_mb: gbToMb(request.size_gb),
        network: "telecel",
        ...(request.client_ref ? { reference: request.client_ref } : {}),
        ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
      })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error", error_type: "NETWORK_ERROR" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)`, error_type: "API_ERROR" }
    }

    if (json.status !== "success") {
      return { success: false, message: json.message ?? `API error (status ${res.status})`, error_type: "API_ERROR" }
    }

    return { success: true, order_id: json.order_id, message: json.message ?? "Order placed" }
  }

  async checkOrderStatus(transactionId: string | number): Promise<MTNOrderStatusResponse> {
    const id = String(transactionId)
    if (id.startsWith("FAILED_INIT_")) {
      return { success: true, status: "failed", message: "Order was never submitted to SPFastIT (local failure)" }
    }

    let res: Response
    try {
      res = await apiCall("/status", { order_id: transactionId })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)` }
    }

    if (json.status !== "success") {
      return { success: false, message: json.message ?? `API error (status ${res.status})` }
    }

    return {
      success: true,
      status: mapSpfastitTelecelStatus(json.order_status),
      message: json.status_label ?? json.message ?? "Status retrieved",
      order: json,
    }
  }

  async checkBalance(): Promise<number | null> {
    try {
      const res = await apiCall("/balance", {})
      if (!res.ok) return null
      const json = await res.json()
      if (json.status !== "success") return null
      return typeof json.balance === "number" ? json.balance : null
    } catch {
      return null
    }
  }
}

export default SPFastITTelecelProvider
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/mtn-providers/spfastit-telecel-provider.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/mtn-providers/spfastit-telecel-provider.ts lib/mtn-providers/spfastit-telecel-provider.test.ts
git commit -m "feat(spfastit-telecel): add Telecel-only provider on SPFastIT's newer JSON API"
```

---

### Task 2: Webhook processor + route

**Files:**
- Create: `lib/mtn-providers/spfastit-telecel-webhook-processor.ts`
- Create: `lib/mtn-providers/spfastit-telecel-webhook-processor.test.ts`
- Create: `app/api/webhooks/mtn/spfastit-telecel/route.ts`

**Interfaces:**
- Consumes: `mapSpfastitTelecelStatus` from Task 1 (`./spfastit-telecel-provider`).
- Produces: `verifyToken(provided: string | null, secret: string): boolean` and `processWebhook(payload: any): Promise<void>`, both exported from `spfastit-telecel-webhook-processor.ts` for the route and for tests.

- [ ] **Step 1: Write the failing test for the processor**

```typescript
// lib/mtn-providers/spfastit-telecel-webhook-processor.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const fakeDb = vi.hoisted(() => ({
  tracking: null as any,
  updates: [] as any[],
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return { maybeSingle: () => Promise.resolve({ data: fakeDb.tracking, error: null }) }
            },
          }
        },
        update(patch: any) {
          fakeDb.updates.push({ table, patch })
          return { eq: () => Promise.resolve({ data: null, error: null }) }
        },
      }
    },
  }),
}))

import { verifyToken, processWebhook } from "./spfastit-telecel-webhook-processor"

beforeEach(() => {
  fakeDb.tracking = null
  fakeDb.updates = []
})

describe("verifyToken", () => {
  it("accepts a matching token", () => {
    expect(verifyToken("secret123", "secret123")).toBe(true)
  })
  it("rejects a missing or mismatched token", () => {
    expect(verifyToken(null, "secret123")).toBe(false)
    expect(verifyToken("wrong", "secret123")).toBe(false)
  })
})

describe("processWebhook", () => {
  it("does nothing when no tracking row matches order_id", async () => {
    fakeDb.tracking = null
    await processWebhook({ order_id: 646856, status: "completed" })
    expect(fakeDb.updates).toHaveLength(0)
  })

  it("updates the tracking row when a match is found", async () => {
    fakeDb.tracking = { id: "row-1", status: "processing", order_type: "bulk", order_id: "order-uuid", api_order_id: null, shop_order_id: null }
    await processWebhook({ order_id: 646856, status: "completed", message: "Order updated to status: Completed" })
    expect(fakeDb.updates.some(u => u.table === "mtn_fulfillment_tracking" && u.patch.status === "completed")).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/mtn-providers/spfastit-telecel-webhook-processor.test.ts`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Implement the processor**

Mirror `lib/mtn-providers/bundleportal-webhook-processor.ts`'s structure exactly (read that file for the full order-type branching: bulk/api/ussd/ussd_shop/shop, terminal-state guard, push notification on completed/failed), with these differences:
- No HMAC — `verifyToken(provided: string | null, secret: string): boolean` does a timing-safe string comparison (same helper shape as `app/api/webhooks/mtn/datakazina/route.ts`'s `timingSafeEqualStr`), not a signature check.
- Lookup key: `payload.order_id` (our own numeric id, echoed back directly — no disguised-reference decoding needed).
- Status mapping via `mapSpfastitTelecelStatus(payload.status)` from Task 1, not `mapBundlePortalStatus`.
- `external_message: payload.message ?? null`.
- Log prefix `[WEBHOOK-SPFASTIT-TELECEL]`.

```typescript
// lib/mtn-providers/spfastit-telecel-webhook-processor.ts
import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"
import { mapSpfastitTelecelStatus } from "@/lib/mtn-providers/spfastit-telecel-provider"
import { sendPushToUser } from "@/lib/push-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/** Timing-safe comparison — SPFastIT's webhook has no signature, so auth is a shared token. */
export function verifyToken(provided: string | null, secret: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export async function processWebhook(payload: any) {
  const ref: string | number | undefined = payload.order_id
  if (ref === undefined || ref === null) {
    console.warn("[WEBHOOK-SPFASTIT-TELECEL] Payload missing order_id, cannot process:", payload)
    return
  }

  const newStatus = mapSpfastitTelecelStatus(payload.status)

  const { data: tracking } = await supabase
    .from("mtn_fulfillment_tracking")
    .select("id, status, order_type, order_id, api_order_id, shop_order_id")
    .eq("mtn_order_id", String(ref))
    .maybeSingle()

  if (!tracking) {
    console.warn("[WEBHOOK-SPFASTIT-TELECEL] No tracking row found for order_id:", ref)
    return
  }

  if ((tracking.status === "completed" || tracking.status === "failed") && newStatus !== tracking.status) {
    console.warn(`[WEBHOOK-SPFASTIT-TELECEL] Ignoring status "${payload.status}" (would move ${ref} from terminal "${tracking.status}" to "${newStatus}")`)
    return
  }

  if (newStatus === tracking.status) {
    await supabase.from("mtn_fulfillment_tracking").update({ webhook_received_at: new Date().toISOString() }).eq("id", tracking.id)
    return
  }

  await supabase
    .from("mtn_fulfillment_tracking")
    .update({
      status: newStatus,
      external_status: payload.status,
      external_message: payload.message ?? null,
      webhook_received_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", tracking.id)

  const orderTableStatus = newStatus === "failed" ? "pending" : newStatus
  let userId: string | null = null
  let phone: string | null = null
  let size: string | null = null

  if (tracking.order_type === "bulk" && tracking.order_id) {
    const { data: o } = await supabase
      .from("orders")
      .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", tracking.order_id)
      .select("user_id, phone_number, size")
      .single()
    if (o) { userId = o.user_id; phone = o.phone_number; size = o.size }
  } else if (tracking.order_type === "api" && (tracking.api_order_id || tracking.order_id)) {
    const apiId = tracking.api_order_id || tracking.order_id
    const { data: o } = await supabase
      .from("api_orders")
      .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", apiId)
      .select("user_id, volume_gb, recipient_phone")
      .single()
    if (o) { userId = o.user_id; phone = o.recipient_phone; size = `${o.volume_gb}GB` }
  } else if (tracking.order_type === "ussd" && tracking.order_id) {
    await supabase.from("ussd_orders").update({ order_status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", tracking.order_id)
  } else if (tracking.order_type === "ussd_shop" && tracking.order_id) {
    await supabase.from("ussd_shop_orders").update({ order_status: orderTableStatus, updated_at: new Date().toISOString() }).eq("id", tracking.order_id)
  } else if (tracking.shop_order_id) {
    const { data: o } = await supabase
      .from("shop_orders")
      .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", tracking.shop_order_id)
      .select("shop_id, customer_phone, volume_gb")
      .single()
    if (o) {
      phone = o.customer_phone; size = `${o.volume_gb}GB`
      const { data: shopOwner } = await supabase.from("user_shops").select("user_id").eq("id", o.shop_id).single()
      userId = shopOwner?.user_id ?? null
    }
  }

  if (userId && (newStatus === "completed" || newStatus === "failed")) {
    const title = newStatus === "completed" ? "Order Delivered Successfully" : "Order Delivery Failed"
    const body = newStatus === "completed"
      ? `Your ${size ?? ""} Telecel bundle for ${phone ?? "your number"} was delivered.`
      : `Your ${size ?? ""} Telecel bundle for ${phone ?? "your number"} could not be delivered.`
    await sendPushToUser(userId, { title, body }).catch(() => null)
  }

  console.log(`[WEBHOOK-SPFASTIT-TELECEL] ${ref} → ${newStatus}`)
}
```

```typescript
// app/api/webhooks/mtn/spfastit-telecel/route.ts
import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { verifyToken, processWebhook } from "@/lib/mtn-providers/spfastit-telecel-webhook-processor"

export async function POST(request: NextRequest) {
  const secret = process.env.SPFASTIT_TELECEL_WEBHOOK_SECRET
  const provided = request.nextUrl.searchParams.get("token")

  if (!secret) {
    console.error("[WEBHOOK-SPFASTIT-TELECEL] SPFASTIT_TELECEL_WEBHOOK_SECRET not set — rejecting all requests")
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 })
  }
  if (!verifyToken(provided, secret)) {
    console.warn("[WEBHOOK-SPFASTIT-TELECEL] Invalid or missing token")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let payload: any
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // after() keeps the function alive until processing finishes — a bare
  // fire-and-forget call is not guaranteed to complete on Vercel (confirmed
  // live 2026-07-26 on AgentPortalGH's webhook).
  after(() => processWebhook(payload))
  return NextResponse.json({ received: true })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/mtn-providers/spfastit-telecel-webhook-processor.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add lib/mtn-providers/spfastit-telecel-webhook-processor.ts lib/mtn-providers/spfastit-telecel-webhook-processor.test.ts app/api/webhooks/mtn/spfastit-telecel/route.ts
git commit -m "feat(spfastit-telecel): add webhook processor and route"
```

---

### Task 3: Type and factory wiring

**Files:**
- Modify: `lib/mtn-providers/types.ts`
- Modify: `lib/mtn-providers/factory.ts`
- Modify: `lib/mtn-providers/factory.test.ts` (if it asserts on `NON_MTN_CAPABLE` contents — check first; add a case if so)

**Interfaces:**
- Consumes: `SPFastITTelecelProvider` from Task 1.
- Produces: `NonMTNProviderName` now includes `"spfastit_telecel"`; `getProviderByName("spfastit_telecel")` returns a `SPFastITTelecelProvider` instance; `isProviderCapableForNetwork("TELECEL", "spfastit_telecel")` returns `true`.

- [ ] **Step 1: Widen the type**

In `lib/mtn-providers/types.ts`, change:
```typescript
export type NonMTNProviderName = MTNProviderName | "spfastit"
```
to:
```typescript
export type NonMTNProviderName = MTNProviderName | "spfastit" | "spfastit_telecel"
```

- [ ] **Step 2: Wire the factory**

In `lib/mtn-providers/factory.ts`:
- Add the import: `import { SPFastITTelecelProvider } from "./spfastit-telecel-provider"`
- In `NON_MTN_CAPABLE`, change the `telecel_provider_selection` line from:
```typescript
    telecel_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "bundleportal"],
```
to:
```typescript
    telecel_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "bundleportal", "spfastit_telecel"],
```
- In `getProviderByName`'s switch, add a case:
```typescript
        case "spfastit_telecel":
            return new SPFastITTelecelProvider()
```

- [ ] **Step 3: Run existing factory tests**

Run: `npx vitest run lib/mtn-providers/factory.test.ts`
Expected: PASS — check the output for any test asserting the exact contents of `NON_MTN_CAPABLE.telecel_provider_selection` or `isProviderCapableForNetwork`'s Telecel branch; if one exists and now fails only because it doesn't expect `spfastit_telecel`, update that expectation to include it (this is a legitimate scope change, not a regression).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (this also confirms `getProviderByName`'s switch is exhaustive)

- [ ] **Step 5: Commit**

```bash
git add lib/mtn-providers/types.ts lib/mtn-providers/factory.ts lib/mtn-providers/factory.test.ts
git commit -m "feat(spfastit-telecel): wire into non-MTN provider type system and factory"
```

---

### Task 4: Admin UI and API wiring (batched — same one-line addition, three files)

**Files:**
- Modify: `app/api/admin/settings/network-provider/route.ts`
- Modify: `app/admin/settings/mtn/page.tsx`
- Modify: `app/admin/order-payment-status/page.tsx`

**Interfaces:**
- Consumes: nothing new — these are UI/validation lists referencing the provider name string `"spfastit_telecel"` directly (no import of the class itself).

- [ ] **Step 1: `network-provider` route validation**

In `app/api/admin/settings/network-provider/route.ts`, change:
```typescript
  telecel: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "bundleportal"],
```
to:
```typescript
  telecel: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "bundleportal", "spfastit_telecel"],
```

- [ ] **Step 2: `/admin/settings/mtn` Telecel provider picker**

In `app/admin/settings/mtn/page.tsx`:
- Change the `NonMTNProvider` type alias (around line 154) from:
```typescript
  type NonMTNProvider = "datakazina" | "xpress" | "eazyghdata" | "codecraft" | "agentportalgh" | "apexprime" | "spfastit" | "bundleportal"
```
to:
```typescript
  type NonMTNProvider = "datakazina" | "xpress" | "eazyghdata" | "codecraft" | "agentportalgh" | "apexprime" | "spfastit" | "bundleportal" | "spfastit_telecel"
```
- `nonBigTimeProviders` is reused as the base for BOTH the Telecel tab (directly, as the ternary's else branch) AND the AT-iShare tab (`ishareProviders = [...nonBigTimeProviders, spfastit]`) — adding `spfastit_telecel` into `nonBigTimeProviders` itself would leak it into the AT-iShare picker too, which is out of scope. Instead add a new array and change only the ternary's else branch:
```typescript
              const telecelProviders: { value: NonMTNProvider; label: string; sub: string }[] = [
                ...nonBigTimeProviders,
                { value: "spfastit_telecel", label: "SPFastIT (Telecel)", sub: "Separate account, Telecel-only" },
              ]
              const providers: { value: NonMTNProvider; label: string; sub: string }[] =
                netKey === "at_bigtime" ? baseProviders : netKey === "at_ishare" ? ishareProviders : telecelProviders
```
(this replaces the existing final `providers` ternary line, which currently ends in `: nonBigTimeProviders` — only that trailing branch changes, `at_bigtime`/`at_ishare` stay exactly as they are.)

- [ ] **Step 3: Manual per-order override dropdown**

In `app/admin/order-payment-status/page.tsx`'s `getProviderOptionsForNetwork()`, the non-MTN branch is:
```typescript
  const isBigTime = upper.includes("BIGTIME") || upper.includes("BIG TIME")
  const isIshare = upper.includes("ISHARE")
  return [
    { value: "xpress", label: "Xpress" },
    { value: "codecraft", label: "Codecraft" },
    { value: "datakazina", label: "Datakazina" },
    { value: "eazyghdata", label: "EazyGhData" },
    ...(isBigTime ? [] : [{ value: "agentportalgh", label: "AgentPortalGH" }, { value: "apexprime", label: "Apex Prime" }]),
    ...(isIshare ? [{ value: "spfastit", label: "SPFastIT" }] : []),
    { value: "bundleportal", label: "Bundle Portal" },
  ]
```
`spfastit_telecel` must appear only for plain Telecel — not AT-BigTime (Global Constraints) and not AT-iShare (it's a different account than the AT-iShare-only `spfastit`). Since this branch only ever represents Telecel when both `isBigTime` and `isIshare` are false, add a third conditional spread:
```typescript
    ...(isBigTime || isIshare ? [] : [{ value: "spfastit_telecel", label: "SPFastIT (Telecel)" }]),
```
placed after the `isIshare` line, before `{ value: "bundleportal", ... }`. Also update the function's preceding comment block (the one starting "Mirrors lib/mtn-providers/factory.ts's provider-capability rules") to mention `spfastit_telecel` alongside the existing `spfastit` explanation.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Manual smoke check**

Start the dev server, open `/admin/settings/mtn` → Telecel tab, confirm "SPFastIT (Telecel)" appears as a selectable card. Open `/admin/order-payment-status`, confirm it appears in the manual-override dropdown for a Telecel order but not an AT-BigTime one.

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/settings/network-provider/route.ts app/admin/settings/mtn/page.tsx app/admin/order-payment-status/page.tsx
git commit -m "feat(spfastit-telecel): add to admin provider-selection surfaces"
```

---

### Task 5: Balance monitoring

**Files:**
- Modify: `app/api/admin/fulfillment/mtn-balance/route.ts`
- Modify: `app/api/cron/check-mtn-balance/route.ts`

**Interfaces:**
- Consumes: `SPFastITTelecelProvider` from Task 1.

- [ ] **Step 1: Admin balance route**

In `app/api/admin/fulfillment/mtn-balance/route.ts`:
- Add the import: `import { SPFastITTelecelProvider } from "@/lib/mtn-providers/spfastit-telecel-provider"`
- Instantiate alongside the others: `const spfastitTelecelProvider = new SPFastITTelecelProvider()`
- Add to the `Promise.all` array and its destructured result: `spfastitTelecelBalance`
- Add: `const spfastitTelecelLow = spfastitTelecelBalance !== null && spfastitTelecelBalance < threshold`
- Add a `balances.spfastit_telecel` entry, currency `"GHS"`, `is_active: false` (never MTN-active, same as the `spfastit` entry), alert text `` `SPFastIT (Telecel) balance is below threshold of ₵${threshold}` ``
- Add `spfastitTelecelLow` to the `if (sykesLow || ... || bundleportalLow)` OR-chain that triggers `sendLowBalanceAlert`, and to the `balanceMap`/`lowMap` objects passed into it (unlike the AT-iShare `spfastit`, this one IS currency-denominated, so it belongs in the shared alert path, not the separate GB-denominated branch).

- [ ] **Step 2: Cron balance check**

In `app/api/cron/check-mtn-balance/route.ts`, mirror the same addition: import, instantiate, add to the `Promise.all`, add to `balances`/`lows`, include in `anyLow`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/fulfillment/mtn-balance/route.ts app/api/cron/check-mtn-balance/route.ts
git commit -m "feat(spfastit-telecel): add balance monitoring"
```

---

### Task 6: Status-poll cron (webhook safety net)

**Files:**
- Create: `app/api/cron/sync-mtn-status/spfastit-telecel/route.ts`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: `checkMTNOrderStatus` from `@/lib/mtn-fulfillment` (already accepts an arbitrary `providerName?: string`, dispatches via `getProviderByName`).

- [ ] **Step 1: Create the cron route**

Copy `app/api/cron/sync-mtn-status/apexprime/route.ts` verbatim to `app/api/cron/sync-mtn-status/spfastit-telecel/route.ts`, then apply exactly these textual substitutions throughout the copied file:
- `"apexprime"` → `"spfastit_telecel"` (the `.eq("provider", ...)` filter and both `checkMTNOrderStatus(...)` calls)
- `CRON-APEXPRIME` → `CRON-SPFASTIT-TELECEL` (all log prefixes)
- Update the file's doc comment to describe SPFastIT-Telecel instead of Apex Prime (one sentence — this provider has a stable numeric `order_id` per order, same simplicity as Apex Prime's own comment already notes, so the comment's substance doesn't need to change beyond the name).

Do not change any other logic — the reversal-safeguard loop, batching, and order-type branching all apply identically.

- [ ] **Step 2: Register the cron**

In `vercel.json`, add an entry alongside the existing `sync-mtn-status/apexprime` entry:
```json
    {
      "path": "/api/cron/sync-mtn-status/spfastit-telecel",
      "schedule": "*/15 * * * *"
    },
```
(match whatever schedule the neighboring entries use — read the existing `apexprime` entry's `schedule` value and copy it exactly, rather than guessing a cadence.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/sync-mtn-status/spfastit-telecel/route.ts vercel.json
git commit -m "feat(spfastit-telecel): add status-poll cron as webhook safety net"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all tests pass, including every file touched in Tasks 1-6.

- [ ] **Step 2: Full typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Report the two secrets to the user for Vercel + SPFastIT dashboard registration**

Generate `SPFASTIT_TELECEL_WEBHOOK_SECRET` (e.g. `crypto.randomBytes(32).toString("hex")`) and report it to the user so they can:
1. Add `SPFASTIT_TELECEL_API_KEY`, `SPFASTIT_TELECEL_WEBHOOK_SECRET` to Vercel env vars (production + preview).
2. Nothing to register with SPFastIT directly for the webhook URL — it's supplied per-order in `place-order`'s `webhook_url` field by our own code (Task 1), not configured once on their dashboard.

- [ ] **Step 4: Do not push yet**

Report completion to the user and wait for explicit confirmation before pushing, per this session's established norm.
