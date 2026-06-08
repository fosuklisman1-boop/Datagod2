# Digiwapy Airtime Auto-Fulfillment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the Digiwapy API to automatically send airtime the moment a customer's payment is confirmed, with per-network admin toggles and an admin retry UI for failures.

**Architecture:** A new `lib/digiwapy-provider.ts` module owns all Digiwapy HTTP calls and webhook signature verification. `markAirtimeOrderPaid` in `lib/airtime-service.ts` calls it after marking payment complete. A new admin retry endpoint (`/api/admin/airtime/auto-fulfill`) and a new webhook handler (`/api/webhooks/digiwapy`) complete the loop. Three new `admin_settings` keys control per-network enablement.

**Tech Stack:** Next.js 15 App Router, Supabase service-role client, Node.js `crypto` (built-in) for HMAC-SHA256 webhook verification.

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `lib/digiwapy-provider.ts` | HTTP client, network map, webhook sig verifier, env check, per-network toggle reader |
| Create | `app/api/admin/airtime/auto-fulfill/route.ts` | Admin retry: fetch pending orders → Digiwapy → update status |
| Create | `app/api/webhooks/digiwapy/route.ts` | Receive Digiwapy callbacks → verify sig → update `airtime_orders` |
| Modify | `lib/airtime-service.ts` | Trigger Digiwapy in `markAirtimeOrderPaid` after marking payment complete |
| Modify | `app/api/admin/airtime/settings/route.ts` | Add 3 new per-network keys + `digiwapy_configured` in GET response |
| Modify | `app/admin/airtime/settings/page.tsx` | New "Auto Fulfillment" card: API status indicator + per-network toggles |
| Modify | `app/admin/airtime/page.tsx` | "Auto Fulfill All" header button + per-row "Auto Fulfill" retry button |

---

## Task 1: Create `lib/digiwapy-provider.ts`

**Files:**
- Create: `lib/digiwapy-provider.ts`

- [ ] **Step 1: Create the file with the full implementation**

```typescript
// lib/digiwapy-provider.ts
import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"

const BASE_URL = "https://api.digiwapy.com/v1"

// Confirm Telecel/AT values with Digiwapy dashboard before going live
const NETWORK_MAP: Record<string, string> = {
  MTN: "MTN",
  Telecel: "Telecel",
  AT: "AirtelTigo",
}

function getRequestHeaders(): Record<string, string> {
  const apiKey = process.env.DIGIWAPY_API_KEY
  const partnerCode = process.env.DIGIWAPY_PARTNER_CODE
  if (!apiKey || !partnerCode) {
    throw new Error("DIGIWAPY_API_KEY or DIGIWAPY_PARTNER_CODE not set")
  }
  return {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
    "X-Partner-Code": partnerCode,
  }
}

export interface DigiWapyAirtimeResult {
  success: boolean
  message: string
}

export async function sendAirtimeViaDigiwapy(params: {
  network: string
  recipient: string
  amount: number
  reference: string
}): Promise<DigiWapyAirtimeResult> {
  try {
    const res = await fetch(`${BASE_URL}/airtime/send`, {
      method: "POST",
      headers: getRequestHeaders(),
      body: JSON.stringify({
        network: NETWORK_MAP[params.network] ?? params.network,
        recipient: params.recipient,
        amount: params.amount,
        reference: params.reference,
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      return { success: false, message: data.message ?? data.error ?? `HTTP ${res.status}` }
    }
    return { success: true, message: data.message ?? "Airtime sent" }
  } catch (err: any) {
    return { success: false, message: err.message ?? "Request failed" }
  }
}

/** Verify the X-Webhook-Signature header from a Digiwapy webhook. */
export function verifyDigiWapyWebhookSignature(
  rawBody: string,
  signatureHeader: string
): boolean {
  const secret = process.env.DIGIWAPY_WEBHOOK_SECRET
  if (!secret) return false
  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`
  // Constant-time comparison to avoid timing attacks
  const aBuf = Buffer.from(expected)
  const bBuf = Buffer.from(signatureHeader)
  if (aBuf.length !== bBuf.length) return false
  return crypto.timingSafeEqual(aBuf, bBuf)
}

/** True when both required env vars are present. */
export function isDigiWapyConfigured(): boolean {
  return !!(process.env.DIGIWAPY_API_KEY && process.env.DIGIWAPY_PARTNER_CODE)
}

/**
 * Check admin_settings to see if Digiwapy auto-fulfillment is enabled for a
 * given network. Returns false immediately when env vars are not set.
 */
export async function isDigiWapyEnabledForNetwork(network: string): Promise<boolean> {
  if (!isDigiWapyConfigured()) return false
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const networkId = network.toLowerCase() // MTN→mtn, Telecel→telecel, AT→at
  const key = `airtime_digiwapy_enabled_${networkId}`
  const { data } = await supabase
    .from("admin_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle()
  return data?.value?.enabled === true
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors in `lib/digiwapy-provider.ts`

- [ ] **Step 3: Commit**

```bash
git add lib/digiwapy-provider.ts
git commit -m "feat(airtime): add Digiwapy provider module"
```

---

## Task 2: Update settings API route

**Files:**
- Modify: `app/api/admin/airtime/settings/route.ts`

- [ ] **Step 1: Add the 3 new keys to `AIRTIME_SETTING_KEYS`**

In `app/api/admin/airtime/settings/route.ts`, find the `AIRTIME_SETTING_KEYS` array and add three entries:

```typescript
const AIRTIME_SETTING_KEYS = [
  "airtime_fee_mtn_customer",
  "airtime_fee_mtn_dealer",
  "airtime_fee_telecel_customer",
  "airtime_fee_telecel_dealer",
  "airtime_fee_at_customer",
  "airtime_fee_at_dealer",
  "airtime_fee_mtn_sub_agent",
  "airtime_fee_telecel_sub_agent",
  "airtime_fee_at_sub_agent",
  "airtime_min_amount",
  "airtime_max_amount",
  "airtime_enabled_mtn",
  "airtime_enabled_telecel",
  "airtime_enabled_at",
  // Digiwapy auto-fulfillment toggles (per network)
  "airtime_digiwapy_enabled_mtn",
  "airtime_digiwapy_enabled_telecel",
  "airtime_digiwapy_enabled_at",
]
```

- [ ] **Step 2: Expose `digiwapy_configured` in the GET response**

In the same file, find the GET handler's return statement and update it to include the flag. The server can safely check the env var here — the key is never sent to the client:

```typescript
return NextResponse.json({
  settings,
  digiwapy_configured: !!(
    process.env.DIGIWAPY_API_KEY && process.env.DIGIWAPY_PARTNER_CODE
  ),
})
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/airtime/settings/route.ts
git commit -m "feat(airtime): add Digiwapy settings keys and configured flag to settings API"
```

---

## Task 3: Hook Digiwapy into `markAirtimeOrderPaid`

**Files:**
- Modify: `lib/airtime-service.ts`

- [ ] **Step 1: Add the import at the top of the file**

After the existing import line, add:

```typescript
import { isDigiWapyEnabledForNetwork, sendAirtimeViaDigiwapy } from "@/lib/digiwapy-provider"
```

- [ ] **Step 2: Add the Digiwapy call after the existing order update**

The existing function updates `payment_status` to `"completed"` and `status` to `"pending"`, then handles merchant commission. Add the Digiwapy call after those two blocks, just before the final `return { success: true }`:

```typescript
  // Attempt Digiwapy auto-fulfillment if enabled for this network
  const digiWapyEnabled = await isDigiWapyEnabledForNetwork(airtimeData.network)
  if (digiWapyEnabled) {
    const result = await sendAirtimeViaDigiwapy({
      network: airtimeData.network,
      recipient: airtimeData.beneficiary_phone,
      amount: airtimeData.airtime_amount,
      reference: airtimeData.reference_code,
    })
    if (result.success) {
      await supabase
        .from("airtime_orders")
        .update({
          status: "processing",
          notes: "Auto-fulfilled via Digiwapy",
          updated_at: new Date().toISOString(),
        })
        .eq("id", airtimeData.id)
      console.log(`[AIRTIME-SVC] ✓ Digiwapy auto-fulfill sent for order ${airtimeData.id}`)
    } else {
      await supabase
        .from("airtime_orders")
        .update({
          notes: `Digiwapy error: ${result.message}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", airtimeData.id)
      console.warn(`[AIRTIME-SVC] Digiwapy auto-fulfill failed for order ${airtimeData.id}: ${result.message}`)
    }
  }

  return { success: true }
```

The full updated `lib/airtime-service.ts` should look like this:

```typescript
import { createClient } from "@supabase/supabase-js"
import { isDigiWapyEnabledForNetwork, sendAirtimeViaDigiwapy } from "@/lib/digiwapy-provider"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * Marks a paid airtime order ready for fulfillment and credits shop profit.
 *
 * Shared by the storefront webhook branch (resolved via wallet_payments) and the
 * USSD direct-charge webhook branch (resolved by id === reference). After marking
 * payment complete, attempts Digiwapy auto-fulfillment if enabled for the order's
 * network. On Digiwapy failure the order stays pending for admin retry.
 *
 * Idempotent: a duplicate webhook (payment already completed) is a no-op, and the
 * shop_profits insert tolerates the unique-violation (23505) from a re-credit.
 */
export async function markAirtimeOrderPaid(
  orderId: string,
  transactionId?: string | number | null
): Promise<{ success: boolean; alreadyProcessed?: boolean }> {
  const { data: airtimeData } = await supabase
    .from("airtime_orders")
    .select("*")
    .eq("id", orderId)
    .single()

  if (!airtimeData) return { success: false }

  if (airtimeData.payment_status === "completed") {
    return { success: true, alreadyProcessed: true }
  }

  await supabase
    .from("airtime_orders")
    .update({
      payment_status: "completed",
      status: "pending",
      transaction_id: transactionId ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", airtimeData.id)

  if (airtimeData.merchant_commission > 0 && airtimeData.shop_id) {
    const { error: profitErr } = await supabase.from("shop_profits").insert([{
      shop_id: airtimeData.shop_id,
      airtime_order_id: airtimeData.id,
      profit_amount: airtimeData.merchant_commission,
      status: "credited",
      created_at: new Date().toISOString(),
    }])
    if (profitErr && profitErr.code !== "23505") {
      console.error("[AIRTIME-SVC] Failed to insert airtime profit record:", profitErr)
    } else if (!profitErr) {
      console.log(`[AIRTIME-SVC] ✓ Airtime profit recorded: GHS ${airtimeData.merchant_commission} (balance synced by DB trigger)`)
    }
  }

  // Attempt Digiwapy auto-fulfillment if enabled for this network
  const digiWapyEnabled = await isDigiWapyEnabledForNetwork(airtimeData.network)
  if (digiWapyEnabled) {
    const result = await sendAirtimeViaDigiwapy({
      network: airtimeData.network,
      recipient: airtimeData.beneficiary_phone,
      amount: airtimeData.airtime_amount,
      reference: airtimeData.reference_code,
    })
    if (result.success) {
      await supabase
        .from("airtime_orders")
        .update({
          status: "processing",
          notes: "Auto-fulfilled via Digiwapy",
          updated_at: new Date().toISOString(),
        })
        .eq("id", airtimeData.id)
      console.log(`[AIRTIME-SVC] ✓ Digiwapy auto-fulfill sent for order ${airtimeData.id}`)
    } else {
      await supabase
        .from("airtime_orders")
        .update({
          notes: `Digiwapy error: ${result.message}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", airtimeData.id)
      console.warn(`[AIRTIME-SVC] Digiwapy auto-fulfill failed for order ${airtimeData.id}: ${result.message}`)
    }
  }

  return { success: true }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add lib/airtime-service.ts
git commit -m "feat(airtime): trigger Digiwapy auto-fulfillment in markAirtimeOrderPaid"
```

---

## Task 4: Create admin retry endpoint

**Files:**
- Create: `app/api/admin/airtime/auto-fulfill/route.ts`

- [ ] **Step 1: Create the file**

```typescript
// app/api/admin/airtime/auto-fulfill/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { sendAirtimeViaDigiwapy, isDigiWapyConfigured } from "@/lib/digiwapy-provider"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  if (!isDigiWapyConfigured()) {
    return NextResponse.json(
      { error: "Digiwapy not configured. Set DIGIWAPY_API_KEY and DIGIWAPY_PARTNER_CODE." },
      { status: 503 }
    )
  }

  try {
    const body = await request.json()
    const ids: string[] = body.orderIds ?? (body.orderId ? [body.orderId] : [])
    if (ids.length === 0) {
      return NextResponse.json({ error: "Provide orderId or orderIds" }, { status: 400 })
    }

    const { data: orders, error } = await supabase
      .from("airtime_orders")
      .select("id, reference_code, network, beneficiary_phone, airtime_amount, status")
      .in("id", ids)
      .eq("status", "pending")

    if (error) throw error
    if (!orders || orders.length === 0) {
      return NextResponse.json(
        { error: "No pending orders found for the given IDs" },
        { status: 404 }
      )
    }

    const results = await Promise.allSettled(
      orders.map(async (order) => {
        const result = await sendAirtimeViaDigiwapy({
          network: order.network,
          recipient: order.beneficiary_phone,
          amount: order.airtime_amount,
          reference: order.reference_code,
        })
        await supabase
          .from("airtime_orders")
          .update({
            status: result.success ? "processing" : "pending",
            notes: result.success
              ? "Admin retry via Digiwapy"
              : `Digiwapy error: ${result.message}`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", order.id)
        return { orderId: order.id, reference: order.reference_code, ...result }
      })
    )

    const succeeded = results.filter(
      (r) => r.status === "fulfilled" && (r as PromiseFulfilledResult<any>).value?.success
    ).length

    return NextResponse.json({
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      results: results.map((r) =>
        r.status === "fulfilled"
          ? (r as PromiseFulfilledResult<any>).value
          : { success: false, message: String((r as PromiseRejectedResult).reason) }
      ),
    })
  } catch (err: any) {
    console.error("[AUTO-FULFILL]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/airtime/auto-fulfill/route.ts
git commit -m "feat(airtime): add Digiwapy admin retry endpoint"
```

---

## Task 5: Create Digiwapy webhook handler

**Files:**
- Create: `app/api/webhooks/digiwapy/route.ts`

- [ ] **Step 1: Create the file**

```typescript
// app/api/webhooks/digiwapy/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyDigiWapyWebhookSignature } from "@/lib/digiwapy-provider"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Map Digiwapy terminal statuses to our airtime_orders statuses.
// failed/reversed → "pending" so admin can retry.
const STATUS_MAP: Record<string, string> = {
  success: "completed",
  completed: "completed",
  failed: "pending",
  reversed: "pending",
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const signature = request.headers.get("x-webhook-signature") ?? ""

  if (!verifyDigiWapyWebhookSignature(rawBody, signature)) {
    console.warn("[DIGIWAPY-WEBHOOK] Invalid or missing signature")
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // Payload shape assumed: { reference, status, message }
  // Confirm field names with Digiwapy dashboard before go-live.
  const { reference, status, message } = payload

  if (!reference || !status) {
    // Unknown payload shape — ack and move on
    return NextResponse.json({ received: true })
  }

  const newStatus = STATUS_MAP[String(status).toLowerCase()] ?? "processing"

  const { error } = await supabase
    .from("airtime_orders")
    .update({
      status: newStatus,
      notes: message ?? `Digiwapy webhook: ${status}`,
      updated_at: new Date().toISOString(),
    })
    .eq("reference_code", reference)

  if (error) {
    console.error("[DIGIWAPY-WEBHOOK] DB update error:", error)
    // Still return 200 so Digiwapy doesn't retry indefinitely
  }

  return NextResponse.json({ received: true })
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add app/api/webhooks/digiwapy/route.ts
git commit -m "feat(airtime): add Digiwapy webhook handler"
```

---

## Task 6: Update the airtime settings page

**Files:**
- Modify: `app/admin/airtime/settings/page.tsx`

- [ ] **Step 1: Add `digiwapyConfigured` state**

After the existing state declarations (around line 17), add:

```typescript
const [digiwapyConfigured, setDigiwapyConfigured] = useState(false)
```

- [ ] **Step 2: Read `digiwapy_configured` from the settings response**

In `loadSettings`, update the `if (res.ok)` branch:

```typescript
if (res.ok) {
  setSettings(data.settings || {})
  setDigiwapyConfigured(data.digiwapy_configured === true)
}
```

- [ ] **Step 3: Add the Auto Fulfillment card to the JSX**

The current layout has a `<div className="grid grid-cols-1 md:grid-cols-2 gap-6">` containing two cards (Global Limits, Service Availability), followed by the Network Fee table. Add the new card inside that grid, **after** the Service Availability card. Use `md:col-span-2` so it spans the full width:

```tsx
{/* Auto Fulfillment (Digiwapy) */}
<div className="bg-card p-6 rounded-2xl shadow-sm border border-border space-y-4 md:col-span-2">
  <div className="flex items-center justify-between border-b pb-3">
    <div>
      <h2 className="text-lg font-bold text-foreground">Auto Fulfillment (Digiwapy)</h2>
      <p className="text-xs text-muted-foreground mt-0.5">
        Automatically send airtime via Digiwapy API immediately after payment.
      </p>
    </div>
    <span className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full ${
      digiwapyConfigured
        ? "bg-green-100 text-green-700"
        : "bg-red-100 text-red-700"
    }`}>
      <span className={`w-2 h-2 rounded-full ${digiwapyConfigured ? "bg-green-500" : "bg-red-400"}`} />
      {digiwapyConfigured ? "API Configured" : "API Not Set"}
    </span>
  </div>

  {!digiwapyConfigured && (
    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
      Set <code className="font-mono bg-amber-100 px-1 rounded">DIGIWAPY_API_KEY</code> and{" "}
      <code className="font-mono bg-amber-100 px-1 rounded">DIGIWAPY_PARTNER_CODE</code>{" "}
      environment variables to enable auto-fulfillment.
    </p>
  )}

  <div className="space-y-3">
    {NETWORKS.map(net => {
      const key = `airtime_digiwapy_enabled_${net.id}`
      const isEnabled = settings[key]?.enabled === true
      return (
        <div key={net.id} className="flex items-center justify-between p-3 bg-muted/40 rounded-xl">
          <div>
            <span className="font-semibold text-foreground">{net.name}</span>
            <span className="ml-2 text-xs text-muted-foreground">auto-fulfill on payment</span>
          </div>
          <button
            onClick={() => {
              if (!digiwapyConfigured) return
              handleUpdateSetting(key, { enabled: !isEnabled })
            }}
            disabled={!digiwapyConfigured}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              isEnabled && digiwapyConfigured ? "bg-indigo-600" : "bg-gray-300"
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-card transition-transform ${
              isEnabled && digiwapyConfigured ? "translate-x-6" : "translate-x-1"
            }`} />
          </button>
        </div>
      )
    })}
  </div>
</div>
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add app/admin/airtime/settings/page.tsx
git commit -m "feat(airtime): add Digiwapy auto-fulfillment card to settings page"
```

---

## Task 7: Update the admin airtime management page

**Files:**
- Modify: `app/admin/airtime/page.tsx`

- [ ] **Step 1: Add `Zap` to the lucide-react import**

Find the existing import line (line 10) and add `Zap`:

```typescript
import { Download, CheckCircle, Clock, AlertCircle, Check, Loader2, Search, RefreshCw, Copy, ExternalLink, FileText, Zap } from "lucide-react"
```

- [ ] **Step 2: Add state variables**

After the existing state declarations (around line 88), add:

```typescript
const [digiWapyNetworks, setDigiWapyNetworks] = useState<Set<string>>(new Set())
const [autoFulfillingId, setAutoFulfillingId] = useState<string | null>(null)
const [autoFulfillingAll, setAutoFulfillingAll] = useState(false)
```

- [ ] **Step 3: Add `loadDigiWapyNetworks` callback**

After the `loadBatches` callback definition, add:

```typescript
const loadDigiWapyNetworks = useCallback(async (tok?: string) => {
  const t = tok || token
  if (!t) return
  try {
    const res = await fetch("/api/admin/airtime/settings", {
      headers: { Authorization: `Bearer ${t}` },
    })
    const data = await res.json()
    if (res.ok) {
      const enabled = new Set<string>()
      if (data.settings?.airtime_digiwapy_enabled_mtn?.enabled) enabled.add("MTN")
      if (data.settings?.airtime_digiwapy_enabled_telecel?.enabled) enabled.add("Telecel")
      if (data.settings?.airtime_digiwapy_enabled_at?.enabled) enabled.add("AT")
      setDigiWapyNetworks(enabled)
    }
  } catch (err) {
    console.error("[ADMIN-AIRTIME] Failed to load Digiwapy networks:", err)
  }
}, [token])
```

- [ ] **Step 4: Call `loadDigiWapyNetworks` on mount**

In the first `useEffect` (the one that calls `getToken().then(...)`), add the call:

```typescript
useEffect(() => {
  getToken().then(t => {
    if (t) {
      loadOrders(t)
      loadBatches(t)
      loadDigiWapyNetworks(t)
    }
  })
}, [getToken])
```

- [ ] **Step 5: Add `handleAutoFulfill` and `handleAutoFulfillAll` functions**

Add these after the `handleAction` function:

```typescript
const handleAutoFulfill = async (orderId: string) => {
  const t = token || await getToken()
  if (!t) return
  setAutoFulfillingId(orderId)
  try {
    const res = await fetch("/api/admin/airtime/auto-fulfill", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({ orderId }),
    })
    const data = await res.json()
    if (res.ok && data.succeeded > 0) {
      toast.success("Airtime sent via Digiwapy")
    } else {
      toast.error(data.results?.[0]?.message || data.error || "Auto-fulfill failed")
    }
    loadOrders()
  } catch {
    toast.error("Auto-fulfill request failed")
  } finally {
    setAutoFulfillingId(null)
  }
}

const handleAutoFulfillAll = async () => {
  const eligibleOrders = orders.filter(
    o => o.status === "pending" && digiWapyNetworks.has(o.network)
  )
  if (eligibleOrders.length === 0) return
  const t = token || await getToken()
  if (!t) return
  setAutoFulfillingAll(true)
  try {
    const res = await fetch("/api/admin/airtime/auto-fulfill", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({ orderIds: eligibleOrders.map(o => o.id) }),
    })
    const data = await res.json()
    if (res.ok) {
      toast.success(`${data.succeeded}/${data.total} orders sent via Digiwapy`)
    } else {
      toast.error(data.error || "Auto-fulfill failed")
    }
    loadOrders()
  } catch {
    toast.error("Auto-fulfill request failed")
  } finally {
    setAutoFulfillingAll(false)
  }
}
```

- [ ] **Step 6: Add the "Auto Fulfill All" button in the Pending tab header**

In the `TabsContent value="pending"` section, find the `<div className="flex justify-between items-center gap-4">` that wraps the filter form and the Download button. Add the Auto Fulfill All button between them:

```tsx
{digiWapyNetworks.size > 0 && (() => {
  const eligibleCount = orders.filter(
    o => o.status === "pending" && digiWapyNetworks.has(o.network)
  ).length
  return (
    <Button
      onClick={handleAutoFulfillAll}
      disabled={autoFulfillingAll || eligibleCount === 0}
      className="bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white font-semibold h-[58px] px-6 whitespace-nowrap"
    >
      {autoFulfillingAll ? (
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
      ) : (
        <Zap className="w-5 h-5 mr-2" />
      )}
      Auto Fulfill All ({eligibleCount})
    </Button>
  )
})()}
```

- [ ] **Step 7: Add per-row "Auto Fulfill" button in the Pending tab table**

In the Pending tab's orders table, find the Actions `<td>` (the last column in each row). It currently contains:

```tsx
<div className="flex gap-2">
  <Button ... Complete </Button>
  <Button ... Fail </Button>
</div>
```

Update it to:

```tsx
<td className="px-4 py-3">
  <div className="flex gap-2 flex-wrap">
    <Button
      size="sm"
      variant="outline"
      className="h-7 text-[10px] bg-green-50 text-green-700 hover:bg-green-100 border-border"
      onClick={() => { setActionModal({ order: o, action: "completed" }); setNotes(""); setActionMsg("") }}
    >
      Complete
    </Button>
    <Button
      size="sm"
      variant="outline"
      className="h-7 text-[10px] bg-red-50 text-red-700 hover:bg-red-100 border-border"
      onClick={() => { setActionModal({ order: o, action: "failed" }); setNotes(""); setActionMsg("") }}
    >
      Fail
    </Button>
    {digiWapyNetworks.has(o.network) && (
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-[10px] bg-violet-50 text-violet-700 hover:bg-violet-100 border-border"
        onClick={() => handleAutoFulfill(o.id)}
        disabled={autoFulfillingId === o.id}
      >
        {autoFulfillingId === o.id ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <Zap className="w-3 h-3 mr-1" />
        )}
        {autoFulfillingId === o.id ? "" : "Auto Fulfill"}
      </Button>
    )}
  </div>
</td>
```

- [ ] **Step 8: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add app/admin/airtime/page.tsx
git commit -m "feat(airtime): add Auto Fulfill buttons to admin airtime management page"
```

---

## Task 8: Add environment variables

**Files:**
- Modify: `.env.local`

- [ ] **Step 1: Add the three Digiwapy variables**

Open `.env.local` and append:

```
# Digiwapy airtime auto-fulfillment
DIGIWAPY_API_KEY=dw_live_your_key_here
DIGIWAPY_PARTNER_CODE=314135
DIGIWAPY_WEBHOOK_SECRET=your_webhook_secret_here
```

Replace the placeholder values with the real credentials from the Digiwapy dashboard.

- [ ] **Step 2: Restart the dev server**

Stop the current dev server (Ctrl+C) and restart:

```bash
npm run dev
```

---

## Task 9: Manual verification

- [ ] **Step 1: Verify settings page**

1. Navigate to `/admin/airtime/settings`
2. Confirm the "Auto Fulfillment (Digiwapy)" card appears at the bottom
3. With real `DIGIWAPY_API_KEY` set: badge shows "API Configured" in green; toggles are active
4. Without the env var: badge shows "API Not Set" in red; toggles are disabled/greyed

- [ ] **Step 2: Enable MTN toggle and save**

1. Toggle MTN to ON in the Auto Fulfillment card
2. Click "Save Changes"
3. Reload page — toggle should still be ON

- [ ] **Step 3: Verify management page buttons**

1. Navigate to `/admin/airtime`
2. Pending tab: confirm "Auto Fulfill All (N)" button appears next to "Download All" for orders on enabled networks
3. Per-row: confirm "Auto Fulfill" button (with lightning icon) appears in the Actions column for MTN pending orders
4. For Telecel/AT orders (if toggle is OFF): "Auto Fulfill" button should NOT appear

- [ ] **Step 4: Test single-order retry**

1. Find a pending MTN airtime order
2. Click "Auto Fulfill" — button should show a spinner
3. On success: toast shows "Airtime sent via Digiwapy", order status changes to "processing"
4. On API error (e.g. wrong key): toast shows the error message, order stays "pending"

- [ ] **Step 5: Verify webhook endpoint**

Test with curl (replace values):

```bash
# Generate a test signature
node -e "
const crypto = require('crypto');
const secret = 'your_webhook_secret_here';
const body = JSON.stringify({reference:'TEST-REF-001', status:'success', message:'Airtime sent'});
const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
console.log('Body:', body);
console.log('Signature:', sig);
"
```

Then POST it:

```bash
curl -X POST http://localhost:3000/api/webhooks/digiwapy \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: sha256=<sig_from_above>" \
  -d '{"reference":"TEST-REF-001","status":"success","message":"Airtime sent"}'
```

Expected response: `{"received":true}`
Expected DB: `airtime_orders` row with `reference_code = 'TEST-REF-001'` updated to `status = 'completed'`

- [ ] **Step 6: Test invalid webhook signature**

```bash
curl -X POST http://localhost:3000/api/webhooks/digiwapy \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: sha256=invalidsignature" \
  -d '{"reference":"TEST-REF-001","status":"success"}'
```

Expected response: `{"error":"Invalid signature"}` with HTTP 401

---

## Environment Variable Reference

| Variable | Example value | Where to find |
|---|---|---|
| `DIGIWAPY_API_KEY` | `dw_live_abc123...` | Digiwapy dashboard → API Keys |
| `DIGIWAPY_PARTNER_CODE` | `314135` | Digiwapy dashboard → Partner info |
| `DIGIWAPY_WEBHOOK_SECRET` | `whsec_abc...` | Digiwapy dashboard → Webhooks |

Register the webhook URL in the Digiwapy dashboard:
```
https://yourdomain.com/api/webhooks/digiwapy
```
