# Bisdel MTN Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add **Bisdel** (`bisdelgh.com/api/xx1`) as a fourth selectable MTN data-bundle fulfillment provider, mirroring the existing EazyGhData catalog-based provider.

**Architecture:** Bisdel implements the existing `MTNProvider` Strategy interface; the factory selects it from `admin_settings.mtn_provider_selection`. Orders map a GB size → a Bisdel `product_id` within a single admin-chosen category (cached catalog in `admin_settings`). Status is poll-only via a per-provider cron (no webhook). Every satellite spot that hardcodes the provider list is updated.

**Tech Stack:** Next.js 15 App Router (route handlers), TypeScript, Supabase (`admin_settings`, `mtn_fulfillment_tracking`), Vitest (unit tests), Vercel cron.

**Spec:** `docs/superpowers/specs/2026-06-20-bisdel-mtn-provider-design.md`

---

## File Structure

**New (4):**
- `lib/mtn-providers/bisdel-provider.ts` — `BisdelProvider` class + exported pure helpers
- `lib/mtn-providers/bisdel-provider.test.ts` — unit tests for the pure helpers
- `app/api/admin/fulfillment/bisdel-products/route.ts` — catalog sync (GET cached / POST sync / PUT set category)
- `app/api/cron/sync-mtn-status/bisdel/route.ts` — poll-only status sync cron

**Modified (10):**
- `lib/mtn-providers/types.ts` — `MTNProviderName` union
- `lib/mtn-providers/factory.ts` — import + validation + 2 switches
- `app/api/admin/settings/mtn-provider/route.ts` — validation array
- `lib/ai-tools.ts` — 2 enums + 1 description
- `app/api/admin/fulfillment/mtn-balance/route.ts` — Bisdel balance + alerts
- `app/admin/settings/mtn/page.tsx` — interface + balance tile + provider button + sync/category UI + unions
- `app/admin/settings/page.tsx` — widen `mtnProvider` union (line 47)
- `app/admin/mtn-logs/page.tsx` — provider badge
- `vercel.json` — register the cron

**Ops (no file):** set `BISDEL_API_KEY`, `BISDEL_API_SECRET`, `BISDEL_BASE_URL` in Vercel + local `.env.local`.

---

### Task 1: Bisdel provider + pure-helper unit tests

**Files:**
- Create: `lib/mtn-providers/bisdel-provider.ts`
- Test: `lib/mtn-providers/bisdel-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/mtn-providers/bisdel-provider.test.ts`:

```typescript
import {
  parseGbFromVolume,
  findProductIdInCatalog,
  normalizeStatus,
  type BisdelProduct,
} from "@/lib/mtn-providers/bisdel-provider"

describe("parseGbFromVolume", () => {
  it("parses GB strings", () => expect(parseGbFromVolume("1GB")).toBe(1))
  it("parses decimal GB with a space", () => expect(parseGbFromVolume("1.5 GB")).toBe(1.5))
  it("converts MB to GB", () => expect(parseGbFromVolume("500MB")).toBeCloseTo(0.488, 2))
  it("accepts a bare numeric string", () => expect(parseGbFromVolume("2")).toBe(2))
  it("accepts a number", () => expect(parseGbFromVolume(3)).toBe(3))
  it("returns null for junk", () => expect(parseGbFromVolume("free")).toBeNull())
  it("returns null for null", () => expect(parseGbFromVolume(null)).toBeNull())
})

describe("normalizeStatus", () => {
  it("maps success synonyms to completed", () => expect(normalizeStatus("Delivered")).toBe("completed"))
  it("maps failure synonyms to failed", () => expect(normalizeStatus("Cancelled")).toBe("failed"))
  it("maps in-progress synonyms to processing", () => expect(normalizeStatus("in progress")).toBe("processing"))
  it("defaults unknown to pending", () => expect(normalizeStatus("whatever")).toBe("pending"))
  it("handles empty", () => expect(normalizeStatus("")).toBe("pending"))
})

describe("findProductIdInCatalog", () => {
  const catalog: BisdelProduct[] = [
    { product_id: 1, data_volume: "1GB", network: "MTN", category: "Daily Bundles" },
    { product_id: 2, data_volume: "1GB", network: "MTN", category: "Monthly Bundles" },
    { product_id: 3, data_volume: "2GB", network: "MTN", category: "Monthly Bundles" },
    { product_id: 9, data_volume: "1GB", network: "AT", category: "Monthly Bundles" },
  ]
  it("matches by GB within the chosen category", () =>
    expect(findProductIdInCatalog(catalog, "Monthly Bundles", 2)).toBe(3))
  it("resolves same-GB collisions via category", () => {
    expect(findProductIdInCatalog(catalog, "Monthly Bundles", 1)).toBe(2)
    expect(findProductIdInCatalog(catalog, "Daily Bundles", 1)).toBe(1)
  })
  it("ignores non-MTN products even inside the category", () =>
    expect(findProductIdInCatalog(catalog, "Monthly Bundles", 1)).toBe(2))
  it("returns null when no category is chosen", () => {
    expect(findProductIdInCatalog(catalog, null, 1)).toBeNull()
    expect(findProductIdInCatalog(catalog, "", 1)).toBeNull()
  })
  it("returns null when no GB match in the category", () =>
    expect(findProductIdInCatalog(catalog, "Daily Bundles", 2)).toBeNull())
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/mtn-providers/bisdel-provider.test.ts`
Expected: FAIL — cannot resolve `@/lib/mtn-providers/bisdel-provider` (module does not exist yet).

- [ ] **Step 3: Create the provider implementation**

Create `lib/mtn-providers/bisdel-provider.ts`:

```typescript
/**
 * Bisdel MTN Provider
 *
 * Implements MTN fulfillment using the Bisdel (XX1) Agent API.
 * API host: https://bisdelgh.com/api/xx1
 *
 * Key differences from Sykes/DataKazina/EazyGhData:
 *  - Orders reference a product_id from a synced catalog (not size_gb), resolved
 *    by GB within a single admin-chosen category (collisions like "1GB Daily" vs
 *    "1GB Monthly" are disambiguated by category).
 *  - Auth via TWO headers: X-API-Key + X-API-Secret.
 *  - Status check keys on the string order_reference (not the numeric order_id),
 *    so we surface order_reference as our order_id and store it as the tracking
 *    mtn_order_id.
 */

import { generateTraceId, log } from "@/lib/mtn-production-config"
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"
import { supabaseAdmin } from "@/lib/supabase"

const BISDEL_API_KEY = process.env.BISDEL_API_KEY!
const BISDEL_API_SECRET = process.env.BISDEL_API_SECRET!
const BISDEL_BASE_URL = process.env.BISDEL_BASE_URL || "https://bisdelgh.com/api/xx1"
const REQUEST_TIMEOUT = 30000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "X-API-Key": BISDEL_API_KEY, "X-API-Secret": BISDEL_API_SECRET, ...(extra ?? {}) }
}

/** Normalize a Bisdel status string into our canonical set. */
export function normalizeStatus(raw: string): "pending" | "processing" | "completed" | "failed" {
  const s = (raw || "").toLowerCase().trim().replace(/[\s-]+/g, "_")
  if (["completed", "complete", "success", "successful", "delivered", "done", "sent"].includes(s)) return "completed"
  if (["failed", "error", "cancelled", "canceled", "rejected", "refunded"].includes(s)) return "failed"
  if (["processing", "in_progress", "queued", "submitted", "accepted", "ongoing"].includes(s)) return "processing"
  return "pending"
}

/** Parse a GB number from a Bisdel data_volume value e.g. "1GB", "1.5 GB", "500MB". */
export function parseGbFromVolume(volume: unknown): number | null {
  if (typeof volume === "number" && volume > 0) return volume
  if (typeof volume !== "string") return null
  const gb = volume.match(/(\d+(?:\.\d+)?)\s*GB/i)
  if (gb) return parseFloat(gb[1])
  const mb = volume.match(/(\d+(?:\.\d+)?)\s*MB/i)
  if (mb) return parseFloat(mb[1]) / 1024
  const bare = parseFloat(volume)
  return isNaN(bare) || bare <= 0 ? null : bare
}

export interface BisdelProduct {
  product_id: number | string
  data_volume?: string | number
  network?: string
  category?: string
  [k: string]: unknown
}

/**
 * Find the Bisdel product_id for a GB size, restricted to MTN + a single category.
 * Pure: takes the cached catalog + chosen category. Returns null on any miss.
 */
export function findProductIdInCatalog(
  packages: BisdelProduct[],
  category: string | null | undefined,
  sizeGb: number,
): number | string | null {
  if (!category) return null
  const target = Math.round(sizeGb)
  const match = packages.find(p => {
    if ((p.network ?? "").toString().toUpperCase() !== "MTN") return false
    if ((p.category ?? "").toString() !== category) return false
    const gb = parseGbFromVolume(p.data_volume)
    return gb !== null && Math.round(gb) === target
  })
  return match ? (match.product_id ?? null) : null
}

/** Load cached catalog + chosen category from admin_settings, then match. */
async function getProductId(sizeGb: number): Promise<{ id: number | string | null; reason?: string }> {
  try {
    const [{ data: pkgRow }, { data: catRow }] = await Promise.all([
      supabaseAdmin.from("admin_settings").select("value").eq("key", "bisdel_packages").maybeSingle(),
      supabaseAdmin.from("admin_settings").select("value").eq("key", "bisdel_category").maybeSingle(),
    ])
    const packages: BisdelProduct[] = pkgRow?.value?.packages ?? []
    const category: string | null = catRow?.value?.category ?? null
    if (!category) return { id: null, reason: "No Bisdel category configured. Choose one in admin settings." }
    if (packages.length === 0) return { id: null, reason: "No Bisdel products cached. Sync products in admin settings." }
    const id = findProductIdInCatalog(packages, category, sizeGb)
    if (!id) {
      const sizes = packages
        .filter(p => (p.category ?? "").toString() === category && (p.network ?? "").toString().toUpperCase() === "MTN")
        .map(p => parseGbFromVolume(p.data_volume))
        .filter(Boolean)
      return { id: null, reason: `No Bisdel "${category}" product for ${sizeGb}GB. Available: ${sizes.join(", ")}GB` }
    }
    return { id }
  } catch (error) {
    console.error("[Bisdel] Error resolving product_id:", error)
    return { id: null, reason: "Error reading Bisdel product catalog" }
  }
}

export class BisdelProvider implements MTNProvider {
  name = "bisdel"

  async createOrder(order: MTNOrderRequest): Promise<MTNOrderResponse> {
    const traceId = order.traceId || generateTraceId()
    const startTime = Date.now()
    try {
      log("info", "Order", "Creating MTN order via Bisdel", { traceId, network: order.network, sizeGb: order.size_gb })

      if (!isValidPhoneFormat(order.recipient_phone)) {
        return { success: false, message: `Invalid phone number format: ${order.recipient_phone}`, traceId, error_type: "VALIDATION" }
      }
      if (!validatePhoneNetworkMatch(order.recipient_phone, order.network)) {
        return { success: false, message: `Phone number does not match ${order.network} network`, traceId, error_type: "VALIDATION" }
      }

      const { id: productId, reason } = await getProductId(order.size_gb)
      if (!productId) {
        return { success: false, message: reason || `No Bisdel product for ${order.size_gb}GB`, traceId, error_type: "VALIDATION" }
      }

      const phone = normalizePhoneNumber(order.recipient_phone)
      const body: Record<string, unknown> = { product_id: productId, phone, quantity: 1 }
      if (order.client_ref) body.external_order_id = order.client_ref

      const maxRetries = 3
      const retryDelays = [2000, 5000, 10000]

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const response = await fetch(`${BISDEL_BASE_URL}/order.php`, {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT),
          })
          const latency = Date.now() - startTime
          const responseText = await response.text()

          if (response.status === 429) {
            if (attempt < maxRetries) { await sleep(retryDelays[attempt]); continue }
            return { success: false, message: "Bisdel rate limited. Please try again.", traceId, error_type: "RATE_LIMIT" }
          }

          let data: any
          try { data = JSON.parse(responseText) } catch {
            return { success: false, message: `Invalid Bisdel response: ${responseText.slice(0, 200)}`, traceId, error_type: "API_ERROR" }
          }

          // Bisdel nests the order under `data`.
          const d = data?.data ?? data
          const ok = response.ok && (data?.success === true || data?.code === 201 || data?.code === 200)

          if (!ok) {
            const errMsg: string = data?.error || d?.message || `Bisdel API returned ${response.status}`
            log("error", "Order", "Bisdel API error", { traceId, status: response.status, data })
            return { success: false, message: errMsg, traceId, error_type: "API_ERROR" }
          }

          // Status lookups key on order_reference, so surface it as our order_id.
          const orderReference = d?.order_reference ?? d?.order_id
          if (!orderReference) {
            return { success: false, message: d?.message || "Order placed but no order_reference returned", traceId, error_type: "API_ERROR" }
          }

          log("info", "Order", "Bisdel MTN order created", { traceId, orderReference, latencyMs: latency })
          return { success: true, order_id: orderReference, message: d?.message || "Order placed successfully", traceId }
        } catch (error) {
          if (attempt < maxRetries) { await sleep(retryDelays[attempt]); continue }
          throw error
        }
      }
      return { success: false, message: "Maximum retries exceeded", traceId, error_type: "API_ERROR" }
    } catch (error) {
      log("error", "Order", "Error creating Bisdel MTN order", { traceId, error: String(error) })
      return { success: false, message: error instanceof Error ? error.message : "Failed to create order", traceId, error_type: "NETWORK_ERROR" }
    }
  }

  async checkOrderStatus(orderReference: string | number): Promise<MTNOrderStatusResponse> {
    const traceId = generateTraceId()
    const maxRetries = 3
    const retryDelays = [2000, 5000, 10000]
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const url = `${BISDEL_BASE_URL}/status.php?order_reference=${encodeURIComponent(String(orderReference))}`
        const response = await fetch(url, { method: "GET", headers: authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
        const responseText = await response.text()

        if (response.status === 429) {
          if (attempt < maxRetries) { await sleep(retryDelays[attempt]); continue }
          return { success: false, message: "Rate limited while checking status (429)" }
        }
        if (response.status === 404) return { success: false, message: `Order ${orderReference} not found` }
        if (!response.ok) return { success: false, message: `API error: ${response.status} - ${responseText.slice(0, 100)}` }

        let data: any
        try { data = JSON.parse(responseText) } catch {
          return { success: false, message: `Invalid JSON: ${responseText.slice(0, 100)}` }
        }
        const d = data?.data ?? data
        const rawStatus = (d?.status ?? "").toString()
        const status = normalizeStatus(rawStatus)
        return { success: true, status, message: d?.message || `Status: ${rawStatus}`, order: d }
      } catch (error) {
        if (attempt < maxRetries) { await sleep(retryDelays[attempt]); continue }
        return { success: false, message: error instanceof Error ? error.message : "Failed to check status" }
      }
    }
    return { success: false, message: "Maximum retries exceeded for status check" }
  }

  async checkBalance(): Promise<number | null> {
    try {
      const response = await fetch(`${BISDEL_BASE_URL}/balance.php`, { method: "GET", headers: authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
      if (!response.ok) { console.warn(`[Bisdel] Balance check failed: ${response.status}`); return null }
      const data = await response.json()
      const d = data?.data ?? data
      const balance = d?.wallet_balance ?? d?.balance ?? d?.amount
      if (typeof balance === "number") return balance
      if (typeof balance === "string") { const p = parseFloat(balance); return isNaN(p) ? null : p }
      return null
    } catch (error) {
      console.error("[Bisdel] Error checking balance:", error)
      return null
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/mtn-providers/bisdel-provider.test.ts`
Expected: PASS — all `parseGbFromVolume`, `normalizeStatus`, `findProductIdInCatalog` cases green.

- [ ] **Step 5: Commit**

```bash
git add lib/mtn-providers/bisdel-provider.ts lib/mtn-providers/bisdel-provider.test.ts
git commit -m "feat(mtn): add Bisdel provider + pure-helper unit tests"
```

---

### Task 2: Register Bisdel in the type union and factory

**Files:**
- Modify: `lib/mtn-providers/types.ts`
- Modify: `lib/mtn-providers/factory.ts`

- [ ] **Step 1: Add `"bisdel"` to the provider-name union**

In `lib/mtn-providers/types.ts`, change the last line:

```typescript
export type MTNProviderName = "sykes" | "datakazina" | "xpress" | "eazyghdata"
```

to:

```typescript
export type MTNProviderName = "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel"
```

- [ ] **Step 2: Import the provider in the factory**

In `lib/mtn-providers/factory.ts`, after the `EazyGhDataProvider` import add:

```typescript
import { BisdelProvider } from "./bisdel-provider"
```

- [ ] **Step 3: Accept `"bisdel"` in `getSelectedProvider` validation**

In `lib/mtn-providers/factory.ts`, change:

```typescript
        if (provider === "sykes" || provider === "datakazina" || provider === "xpress" || provider === "eazyghdata") {
            return provider
        }
```

to:

```typescript
        if (provider === "sykes" || provider === "datakazina" || provider === "xpress" || provider === "eazyghdata" || provider === "bisdel") {
            return provider
        }
```

- [ ] **Step 4: Add `bisdel` to both factory switches**

In `getMTNProvider()`'s switch, add a case before `case "sykes":`:

```typescript
        case "bisdel":
            return new BisdelProvider()
```

In `getProviderByName()`'s switch, add a case (before or after `case "eazyghdata":`):

```typescript
        case "bisdel":
            return new BisdelProvider()
```

- [ ] **Step 5: Verify the project still type-checks**

Run: `npx tsc --noEmit`
Expected: PASS — no errors in `factory.ts` / `types.ts`. (Other pre-existing warnings, if any, are unrelated.)

- [ ] **Step 6: Commit**

```bash
git add lib/mtn-providers/types.ts lib/mtn-providers/factory.ts
git commit -m "feat(mtn): register Bisdel provider in factory + provider-name union"
```

---

### Task 3: Allow Bisdel in provider-selection route + AI tools

**Files:**
- Modify: `app/api/admin/settings/mtn-provider/route.ts`
- Modify: `lib/ai-tools.ts`

- [ ] **Step 1: Extend the provider-selection validation**

In `app/api/admin/settings/mtn-provider/route.ts`, change:

```typescript
        if (!["sykes", "datakazina", "xpress", "eazyghdata"].includes(provider)) {
            return NextResponse.json(
                { error: "Invalid provider. Must be 'sykes', 'datakazina', 'xpress', or 'eazyghdata'" },
                { status: 400 }
            )
        }
```

to:

```typescript
        if (!["sykes", "datakazina", "xpress", "eazyghdata", "bisdel"].includes(provider)) {
            return NextResponse.json(
                { error: "Invalid provider. Must be 'sykes', 'datakazina', 'xpress', 'eazyghdata', or 'bisdel'" },
                { status: 400 }
            )
        }
```

- [ ] **Step 2: Add `bisdel` to the two AI-tool enums + the logs description**

In `lib/ai-tools.ts`:

`set_mtn_provider` enum — change:
```typescript
      provider: { type: "string", enum: ["sykes", "datakazina", "xpress", "eazyghdata"], description: "Provider to switch to. Omit to just read current setting." },
```
to:
```typescript
      provider: { type: "string", enum: ["sykes", "datakazina", "xpress", "eazyghdata", "bisdel"], description: "Provider to switch to. Omit to just read current setting." },
```

`sync_fulfillment_status` enum — change:
```typescript
      provider: { type: "string", enum: ["sykes", "datakazina", "xpress", "eazyghdata"], description: "Provider to sync from" },
```
to:
```typescript
      provider: { type: "string", enum: ["sykes", "datakazina", "xpress", "eazyghdata", "bisdel"], description: "Provider to sync from" },
```

`get_mtn_logs` description — change:
```typescript
  description: "Admin only: view MTN-specific fulfillment tracking logs from the MTN provider (Sykes, DataKazina, Xpress, or EazyGhData).",
```
to:
```typescript
  description: "Admin only: view MTN-specific fulfillment tracking logs from the MTN provider (Sykes, DataKazina, Xpress, EazyGhData, or Bisdel).",
```

> Note: the `set_mtn_provider` executor (`executeToolCall`, case `"set_mtn_provider"`) just forwards to `/api/admin/settings/mtn-provider`, so no handler change is needed — Step 1 is the actual gate.

- [ ] **Step 3: Verify type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/settings/mtn-provider/route.ts lib/ai-tools.ts
git commit -m "feat(mtn): allow Bisdel in provider-selection route + AI tool enums"
```

---

### Task 4: Bisdel product catalog sync route

**Files:**
- Create: `app/api/admin/fulfillment/bisdel-products/route.ts`

- [ ] **Step 1: Create the route (GET cached / POST sync / PUT set category)**

```typescript
/**
 * Admin API — Bisdel Product Catalog
 *
 * GET  — cached products + distinct categories + currently selected category
 * POST — fetch live products from Bisdel /products.php and cache them
 * PUT  — set the single category Bisdel orders are matched within
 */

import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"

const BISDEL_API_KEY = process.env.BISDEL_API_KEY!
const BISDEL_API_SECRET = process.env.BISDEL_API_SECRET!
const BISDEL_BASE_URL = process.env.BISDEL_BASE_URL || "https://bisdelgh.com/api/xx1"

export async function GET(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse

    const [{ data: pkgRow, error }, { data: catRow }] = await Promise.all([
      supabase.from("admin_settings").select("value").eq("key", "bisdel_packages").maybeSingle(),
      supabase.from("admin_settings").select("value").eq("key", "bisdel_category").maybeSingle(),
    ])
    if (error) {
      console.error("[Bisdel-Products] DB error:", error)
      return NextResponse.json({ error: "Failed to fetch cached products" }, { status: 500 })
    }
    const packages = pkgRow?.value?.packages ?? []
    const categories = [...new Set(packages.map((p: any) => p?.category).filter(Boolean))]
    return NextResponse.json({
      success: true,
      packages,
      categories,
      selected_category: catRow?.value?.category ?? null,
      synced_at: pkgRow?.value?.synced_at ?? null,
      count: pkgRow?.value?.count ?? 0,
    })
  } catch (error) {
    console.error("[Bisdel-Products] GET error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse

    if (!BISDEL_API_KEY || !BISDEL_API_SECRET) {
      return NextResponse.json({ error: "BISDEL_API_KEY / BISDEL_API_SECRET not configured" }, { status: 500 })
    }

    const response = await fetch(`${BISDEL_BASE_URL}/products.php`, {
      method: "GET",
      headers: { "X-API-Key": BISDEL_API_KEY, "X-API-Secret": BISDEL_API_SECRET },
      signal: AbortSignal.timeout(30000),
    })

    if (!response.ok) {
      const text = await response.text()
      console.error("[Bisdel-Products] API error:", response.status, text.slice(0, 200))
      return NextResponse.json(
        { error: `Bisdel API returned ${response.status}`, details: text.slice(0, 200) },
        { status: 502 }
      )
    }

    const json = await response.json()
    // Bisdel shape: { success, data: { products: [...] } }
    const packageList = json?.data?.products ?? json?.products ?? (Array.isArray(json) ? json : [])

    const value = { packages: packageList, synced_at: new Date().toISOString(), count: packageList.length }
    const { error: upsertError } = await supabase
      .from("admin_settings")
      .upsert({ key: "bisdel_packages", value }, { onConflict: "key" })

    if (upsertError) {
      console.error("[Bisdel-Products] Upsert error:", upsertError)
      return NextResponse.json({ error: "Failed to save products" }, { status: 500 })
    }

    const categories = [...new Set(packageList.map((p: any) => p?.category).filter(Boolean))]
    console.log(`[Bisdel-Products] Synced ${packageList.length} products`)
    return NextResponse.json({ success: true, count: packageList.length, categories, synced_at: value.synced_at })
  } catch (error) {
    console.error("[Bisdel-Products] POST error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse

    const { category } = await request.json()
    if (!category || typeof category !== "string") {
      return NextResponse.json({ error: "category (string) is required" }, { status: 400 })
    }

    const { error } = await supabase
      .from("admin_settings")
      .upsert({ key: "bisdel_category", value: { category }, updated_at: new Date().toISOString() }, { onConflict: "key" })

    if (error) {
      console.error("[Bisdel-Products] Category upsert error:", error)
      return NextResponse.json({ error: "Failed to save category" }, { status: 500 })
    }
    return NextResponse.json({ success: true, category, message: `Bisdel category set to ${category}` })
  } catch (error) {
    console.error("[Bisdel-Products] PUT error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Verify type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/fulfillment/bisdel-products/route.ts
git commit -m "feat(mtn): Bisdel product catalog sync + category route"
```

---

### Task 5: Add Bisdel to the MTN balance aggregator

**Files:**
- Modify: `app/api/admin/fulfillment/mtn-balance/route.ts`

- [ ] **Step 1: Import the provider**

After the `EazyGhDataProvider` import add:

```typescript
import { BisdelProvider } from "@/lib/mtn-providers/bisdel-provider"
```

- [ ] **Step 2: Fetch the Bisdel balance**

Change:

```typescript
    const sykesProvider = new SykesProvider()
    const datakazinaProvider = new DataKazinaProvider()
    const xpressProvider = new XpressProvider()
    const eazyghDataProvider = new EazyGhDataProvider()

    const [sykesBalance, datakazinaBalance, xpressBalance, eazyghDataBalance] = await Promise.all([
      sykesProvider.checkBalance().catch(() => null),
      datakazinaProvider.checkBalance().catch(() => null),
      xpressProvider.checkBalance().catch(() => null),
      eazyghDataProvider.checkBalance().catch(() => null),
    ])
```

to:

```typescript
    const sykesProvider = new SykesProvider()
    const datakazinaProvider = new DataKazinaProvider()
    const xpressProvider = new XpressProvider()
    const eazyghDataProvider = new EazyGhDataProvider()
    const bisdelProvider = new BisdelProvider()

    const [sykesBalance, datakazinaBalance, xpressBalance, eazyghDataBalance, bisdelBalance] = await Promise.all([
      sykesProvider.checkBalance().catch(() => null),
      datakazinaProvider.checkBalance().catch(() => null),
      xpressProvider.checkBalance().catch(() => null),
      eazyghDataProvider.checkBalance().catch(() => null),
      bisdelProvider.checkBalance().catch(() => null),
    ])
```

- [ ] **Step 3: Compute the low flag and include in the alert trigger**

Change:

```typescript
    const eazyghDataLow = eazyghDataBalance !== null && eazyghDataBalance < threshold

    // Send SMS alert if any balance is low
    if (sykesLow || datakazinaLow || xpressLow || eazyghDataLow) {
      await sendLowBalanceAlert(sykesBalance, datakazinaBalance, xpressBalance, eazyghDataBalance, threshold, sykesLow, datakazinaLow, xpressLow, eazyghDataLow)
    }
```

to:

```typescript
    const eazyghDataLow = eazyghDataBalance !== null && eazyghDataBalance < threshold
    const bisdelLow = bisdelBalance !== null && bisdelBalance < threshold

    // Send SMS alert if any balance is low
    if (sykesLow || datakazinaLow || xpressLow || eazyghDataLow || bisdelLow) {
      await sendLowBalanceAlert(sykesBalance, datakazinaBalance, xpressBalance, eazyghDataBalance, bisdelBalance, threshold, sykesLow, datakazinaLow, xpressLow, eazyghDataLow, bisdelLow)
    }
```

- [ ] **Step 4: Add the `bisdel` block to the response**

In the `balances` object, after the `eazyghdata` block add:

```typescript
        bisdel: {
          balance: bisdelBalance,
          currency: "GHS",
          is_low: bisdelLow,
          is_active: activeProvider.name === "bisdel",
          alert: bisdelLow && bisdelBalance !== null ? `Bisdel balance is below threshold of ₵${threshold}` : null,
        },
```

- [ ] **Step 5: Update `sendLowBalanceAlert` signature + body**

Change the function signature:

```typescript
async function sendLowBalanceAlert(
  sykesBalance: number | null,
  datakazinaBalance: number | null,
  xpressBalance: number | null,
  eazyghDataBalance: number | null,
  threshold: number,
  sykesLow: boolean,
  datakazinaLow: boolean,
  xpressLow: boolean,
  eazyghDataLow: boolean
) {
```

to:

```typescript
async function sendLowBalanceAlert(
  sykesBalance: number | null,
  datakazinaBalance: number | null,
  xpressBalance: number | null,
  eazyghDataBalance: number | null,
  bisdelBalance: number | null,
  threshold: number,
  sykesLow: boolean,
  datakazinaLow: boolean,
  xpressLow: boolean,
  eazyghDataLow: boolean,
  bisdelLow: boolean
) {
```

In the SMS body, after the EazyGhData line:

```typescript
    if (eazyghDataLow && eazyghDataBalance !== null) {
      message += `EazyGhData: ₵${eazyghDataBalance.toFixed(2)} (LOW)\n`
    }
```

add:

```typescript
    if (bisdelLow && bisdelBalance !== null) {
      message += `Bisdel: ₵${bisdelBalance.toFixed(2)} (LOW)\n`
    }
```

In the email body, after the EazyGhData paragraph:

```typescript
      if (eazyghDataLow && eazyghDataBalance !== null) {
        emailMessage += `<p style="margin: 10px 0;"><strong>EazyGhData Provider:</strong> ₵${eazyghDataBalance.toFixed(2)} <span style="color: #dc2626; font-weight: bold;">(LOW)</span></p>`
      }
```

add:

```typescript
      if (bisdelLow && bisdelBalance !== null) {
        emailMessage += `<p style="margin: 10px 0;"><strong>Bisdel Provider:</strong> ₵${bisdelBalance.toFixed(2)} <span style="color: #dc2626; font-weight: bold;">(LOW)</span></p>`
      }
```

- [ ] **Step 6: Verify type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/api/admin/fulfillment/mtn-balance/route.ts
git commit -m "feat(mtn): include Bisdel in balance aggregator + low-balance alerts"
```

---

### Task 6: Admin MTN settings page — Bisdel balance tile, provider button, sync + category UI

**Files:**
- Modify: `app/admin/settings/mtn/page.tsx`

- [ ] **Step 1: Add `bisdel` to the balance interface + widen unions + add state**

Change the `MTNBalance` interface's `balances` to include `bisdel`:

```typescript
  balances: {
    sykes: ProviderBalance
    datakazina: ProviderBalance
    xpress: ProviderBalance
    eazyghdata: ProviderBalance
    bisdel: ProviderBalance
  }
```

Change the provider state union:

```typescript
  const [mtnProvider, setMtnProvider] = useState<"sykes" | "datakazina" | "xpress" | "eazyghdata">("sykes")
```
to:
```typescript
  const [mtnProvider, setMtnProvider] = useState<"sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel">("sykes")
```

After the `savingProvider` state, add Bisdel catalog state:

```typescript
  const [bisdelCategories, setBisdelCategories] = useState<string[]>([])
  const [bisdelCategory, setBisdelCategory] = useState<string>("")
  const [syncingBisdel, setSyncingBisdel] = useState(false)
  const [savingBisdelCategory, setSavingBisdelCategory] = useState(false)
```

- [ ] **Step 2: Load Bisdel catalog when Bisdel is active**

After the `loadProvider` function, add:

```typescript
  const loadBisdelCatalog = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      const response = await fetch("/api/admin/fulfillment/bisdel-products", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setBisdelCategories(data.categories || [])
        setBisdelCategory(data.selected_category || "")
      }
    } catch (error) {
      console.error("Error loading Bisdel catalog:", error)
    }
  }
```

In the mount `useEffect`, after `loadProvider()` add:

```typescript
    loadBisdelCatalog()
```

- [ ] **Step 3: Add the sync + category handlers**

After `handleSyncEazyGhDataPackages`, add:

```typescript
  const handleSyncBisdelProducts = async () => {
    setSyncingBisdel(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const response = await fetch("/api/admin/fulfillment/bisdel-products", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (response.ok) {
        const data = await response.json()
        setBisdelCategories(data.categories || [])
        toast.success(`Synced ${data.count} Bisdel products`)
      } else {
        const err = await response.json()
        toast.error(err.error || "Failed to sync products")
      }
    } catch (error) {
      console.error("Error syncing Bisdel products:", error)
      toast.error("Error syncing Bisdel products")
    } finally {
      setSyncingBisdel(false)
    }
  }

  const handleSelectBisdelCategory = async (category: string) => {
    setSavingBisdelCategory(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const response = await fetch("/api/admin/fulfillment/bisdel-products", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ category }),
      })
      if (response.ok) {
        setBisdelCategory(category)
        toast.success(`Bisdel category set to ${category}`)
      } else {
        toast.error("Failed to set category")
      }
    } catch (error) {
      console.error("Error setting Bisdel category:", error)
      toast.error("Error setting Bisdel category")
    } finally {
      setSavingBisdelCategory(false)
    }
  }
```

Change the `handleMTNProviderChange` parameter type:

```typescript
  const handleMTNProviderChange = async (provider: "sykes" | "datakazina" | "xpress" | "eazyghdata") => {
```
to:
```typescript
  const handleMTNProviderChange = async (provider: "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel") => {
```

- [ ] **Step 4: Add the Bisdel balance tile**

In the balance grid container, change `grid-cols-2 md:grid-cols-4` to `grid-cols-2 md:grid-cols-5` (the `<div className="grid grid-cols-2 md:grid-cols-4 gap-4">` that wraps the balance tiles). After the EazyGhData balance tile (the `{/* EazyGhData Balance */}` block), add:

```tsx
                  {/* Bisdel Balance */}
                  <div className={`p-4 rounded-lg border-2 transition-all ${balance.balances.bisdel?.is_active
                    ? 'bg-indigo-50 border-border shadow-md'
                    : 'bg-muted/40 border-border'
                    }`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-foreground">Bisdel</span>
                      {balance.balances.bisdel?.is_active && (
                        <Badge className="bg-indigo-600">Active</Badge>
                      )}
                    </div>
                    {balance.balances.bisdel?.balance !== null && balance.balances.bisdel?.balance !== undefined ? (
                      <>
                        <div className="flex items-baseline gap-2">
                          <span className={`text-3xl font-bold ${balance.balances.bisdel.is_low ? 'text-orange-600' : 'text-emerald-900'
                            }`}>
                            ₵{balance.balances.bisdel.balance.toFixed(2)}
                          </span>
                          <span className="text-sm text-muted-foreground">GHS</span>
                        </div>
                        {balance.balances.bisdel.is_low && (
                          <p className="text-xs text-orange-600 mt-2">⚠️ Low balance</p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">Unable to fetch</p>
                    )}
                  </div>
```

In the low-balance `Alert` condition, change:

```tsx
                {(balance.balances.sykes.is_low || balance.balances.datakazina.is_low || balance.balances.xpress?.is_low || balance.balances.eazyghdata?.is_low) && (
```
to:
```tsx
                {(balance.balances.sykes.is_low || balance.balances.datakazina.is_low || balance.balances.xpress?.is_low || balance.balances.eazyghdata?.is_low || balance.balances.bisdel?.is_low) && (
```

And inside that alert, after the eazyghdata alert line add:

```tsx
                      {balance.balances.bisdel?.alert && <p>• {balance.balances.bisdel.alert}</p>}
```

- [ ] **Step 5: Add the Bisdel provider-selection button**

In the provider selection grid, change `grid-cols-2 md:grid-cols-4` to `grid-cols-2 md:grid-cols-5` (the `<div className="grid grid-cols-2 md:grid-cols-4 gap-4">` wrapping the provider buttons). After the EazyGhData option button, add:

```tsx
                {/* Bisdel Option */}
                <button
                  onClick={() => handleMTNProviderChange("bisdel")}
                  disabled={savingProvider || mtnProvider === "bisdel"}
                  className={`p-4 rounded-lg border-2 transition-all text-left ${mtnProvider === "bisdel"
                      ? "bg-indigo-50 border-indigo-500 shadow-md"
                      : "bg-card border-border hover:border-border"
                    } ${savingProvider ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-foreground">Bisdel</span>
                    {mtnProvider === "bisdel" && (
                      <Badge className="bg-indigo-600">Active</Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">Category-based provider</p>
                </button>
```

- [ ] **Step 6: Add the Bisdel sync + category panel**

After the EazyGhData package-sync block (`{mtnProvider === "eazyghdata" && ( ... )}`), add:

```tsx
              {/* Bisdel Product Sync + Category */}
              {mtnProvider === "bisdel" && (
                <div className="p-4 bg-indigo-50 rounded-lg border border-indigo-200 space-y-3">
                  <p className="text-sm font-medium text-indigo-900">Bisdel Products &amp; Category</p>
                  <p className="text-xs text-indigo-700">
                    Bisdel matches each order by GB within a single category. Sync products, then choose the
                    category orders are fulfilled from. Orders fail until a category is selected.
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      onClick={handleSyncBisdelProducts}
                      disabled={syncingBisdel}
                      variant="outline"
                      size="sm"
                      className="border-indigo-400 text-indigo-800 hover:bg-indigo-100"
                    >
                      {syncingBisdel ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Syncing...
                        </>
                      ) : (
                        "Sync Bisdel Products"
                      )}
                    </Button>

                    <select
                      value={bisdelCategory}
                      onChange={(e) => handleSelectBisdelCategory(e.target.value)}
                      disabled={savingBisdelCategory || bisdelCategories.length === 0}
                      className="px-3 py-2 text-sm rounded-md border border-indigo-300 bg-white text-indigo-900 disabled:opacity-50"
                    >
                      <option value="" disabled>
                        {bisdelCategories.length === 0 ? "Sync products first" : "Select a category"}
                      </option>
                      {bisdelCategories.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    {bisdelCategory && (
                      <span className="text-xs text-indigo-700">Active: <strong>{bisdelCategory}</strong></span>
                    )}
                  </div>
                </div>
              )}
```

- [ ] **Step 7: Verify type-check + lint of this file**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/admin/settings/mtn/page.tsx
git commit -m "feat(mtn): Bisdel balance tile, provider switch, product sync + category UI"
```

---

### Task 7: Bisdel status-sync cron + registration

**Files:**
- Create: `app/api/cron/sync-mtn-status/bisdel/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Create the cron by cloning the EazyGhData cron**

Copy the entire contents of `app/api/cron/sync-mtn-status/eazyghdata/route.ts` into the new file `app/api/cron/sync-mtn-status/bisdel/route.ts`, then apply these exact replacements:

1. The tracking filter — change:
   ```typescript
            .eq("provider", "eazyghdata")
   ```
   to:
   ```typescript
            .eq("provider", "bisdel")
   ```
2. The status check call — change:
   ```typescript
                const result = await checkMTNOrderStatus(order.mtn_order_id, "eazyghdata")
   ```
   to:
   ```typescript
                const result = await checkMTNOrderStatus(order.mtn_order_id, "bisdel")
   ```
3. Replace every log-prefix string `[CRON-EAZYGHDATA]` with `[CRON-BISDEL]` (multiple occurrences).
4. In the route doc-comment header, change `sync-mtn-status/eazyghdata` to `sync-mtn-status/bisdel` and the EazyGhData endpoint description to "Bisdel /status.php?order_reference=...".
5. In the empty-result response, change `"No EazyGhData orders to sync"` to `"No Bisdel orders to sync"`.

Leave everything else (batch size, delays, regression guard, all 5 order-table mirrors, notifications) unchanged — it is provider-agnostic.

- [ ] **Step 2: Register the cron in `vercel.json`**

After the `eazyghdata` cron entry, add:

```json
    {
      "path": "/api/cron/sync-mtn-status/bisdel",
      "schedule": "* * * * *"
    },
```

(Place it as a sibling of the other `sync-mtn-status/*` entries; ensure the trailing comma keeps the JSON array valid.)

- [ ] **Step 3: Verify JSON + type-check**

Run: `node -e "require('./vercel.json'); console.log('vercel.json OK')"`
Expected: prints `vercel.json OK` (valid JSON).

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/sync-mtn-status/bisdel/route.ts vercel.json
git commit -m "feat(mtn): Bisdel status-sync cron + vercel registration"
```

---

### Task 8: Remaining provider-list spots (logs badge + second settings union)

**Files:**
- Modify: `app/admin/mtn-logs/page.tsx`
- Modify: `app/admin/settings/page.tsx`

- [ ] **Step 1: Add a Bisdel provider badge to the logs page**

In `app/admin/mtn-logs/page.tsx`, find the provider-badge chain:

```tsx
                              ) : log.provider === "eazyghdata" ? (
                                <Badge className="bg-cyan-100 text-cyan-800 border-border">EazyGhData</Badge>
```

Immediately after that branch (before the final `:` fallback), add:

```tsx
                              ) : log.provider === "bisdel" ? (
                                <Badge className="bg-indigo-100 text-indigo-800 border-border">Bisdel</Badge>
```

- [ ] **Step 2: Widen the provider union on the general settings page**

In `app/admin/settings/page.tsx`, change:

```typescript
  const [mtnProvider, setMtnProvider] = useState<"sykes" | "datakazina" | "xpress" | "eazyghdata">("sykes")
```
to:
```typescript
  const [mtnProvider, setMtnProvider] = useState<"sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel">("sykes")
```

> This page only *loads* the active provider (it has no switcher UI); widening the type keeps it correct when the value is `"bisdel"`.

- [ ] **Step 3: Verify type-check**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/admin/mtn-logs/page.tsx app/admin/settings/page.tsx
git commit -m "feat(mtn): Bisdel logs badge + widen settings provider union"
```

---

### Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit test suite**

Run: `npm run test:run`
Expected: PASS — all suites green, including `lib/mtn-providers/bisdel-provider.test.ts`.

- [ ] **Step 2: Full type-check**

Run: `npx tsc --noEmit`
Expected: PASS — no new errors.

- [ ] **Step 3: Production build (catches App Router/route issues)**

Run: `npm run build`
Expected: build succeeds; the new routes `app/api/admin/fulfillment/bisdel-products` and `app/api/cron/sync-mtn-status/bisdel` appear in the route list.

- [ ] **Step 4: Ops — set environment variables**

Set in Vercel (Production + Preview) and local `.env.local`:
```
BISDEL_API_KEY=<key>
BISDEL_API_SECRET=<secret>
BISDEL_BASE_URL=https://bisdelgh.com/api/xx1
```

- [ ] **Step 5: Manual smoke test (admin)**

1. Open `/admin/settings/mtn`.
2. Select **Bisdel** as the provider.
3. Click **Sync Bisdel Products** — toast shows a non-zero count; the category dropdown populates.
4. Pick the intended category — toast confirms.
5. Click **Refresh Balances** — the Bisdel tile shows a ₵ value.
6. Place a small live MTN order (or use an existing pending one and manual-fulfill).
7. In `mtn_fulfillment_tracking`, confirm a row with `provider = "bisdel"` and `mtn_order_id` = the `XX1-...` order reference.
8. Within ~1–2 minutes the `sync-mtn-status/bisdel` cron flips it to `completed` and the originating order + notification update.

- [ ] **Step 6: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore(mtn): Bisdel provider verification fixups"
```

---

## Self-Review Notes

- **Spec coverage:** All 4 components (provider, category mapping, product-sync route, sync cron) → Tasks 1, 4, 7. All 13 integration-checklist items → Tasks 2, 3, 5, 6, 7, 8. Env vars → Task 9 Step 4. Testing → Task 1 (unit) + Task 9 (smoke).
- **Type consistency:** `findProductIdInCatalog(packages, category, sizeGb)`, `parseGbFromVolume(volume)`, `normalizeStatus(raw)`, `BisdelProduct`, `BisdelProvider` (`name = "bisdel"`) are used identically across the provider, its test, and the catalog route. `bisdel_packages` / `bisdel_category` admin_settings keys are consistent across provider, route, and UI. The `sendLowBalanceAlert` signature is updated everywhere it is called.
- **No placeholders:** every code step contains the full snippet or an exact old→new replacement; the cron clone lists each exact string substitution.
