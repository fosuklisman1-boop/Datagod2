# Bundle Portal Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Bundle Portal as a 10th data-bundle fulfillment provider — full member of `MTNProviderName` (selectable everywhere: primary MTN provider, retry sequence, disabled-providers toggle, all three non-MTN network selectors, whitelist registry), with webhook support, `verify_number` whitelist integration, all three admin-selectable MTN delivery routes, and AT-BigTime coverage.

**Architecture:** A new `BundlePortalProvider` class implements the existing `MTNProvider` interface against Bundle Portal's single-endpoint, action-routed JSON API. A new optional `isBigTime?: boolean` field on the shared `MTNOrderRequest` type lets this one provider distinguish AT-BigTime from AT-iShare (both collapse to the same `network: "AirtelTigo"` value otherwise) without touching any other provider. The three independent MTN catalogues (`mtn`/`mtn_2`/`mtn_3`) are selected via one admin-configurable `admin_settings` row, read once per order — the same pattern Apex Prime already uses for its GroupShare/Store choice. Bundle Portal's own `order_id` (always our order UUID) doubles as the sole idempotency key and the sole status-lookup key, so — unlike every other provider — no provider-returned id needs to be parsed or stored.

**Tech Stack:** Next.js App Router API routes, TypeScript, Vitest, `fetch`, `next/server`'s `after()`, HMAC-SHA256 (`crypto`).

Design doc: `docs/superpowers/specs/2026-09-14-bundleportal-provider-design.md`

**Deliberate scope note carried over from the design doc:** the new `error_type: "RETRYABLE"` value on `createOrder`'s failure responses is diagnostic-only (matches how `error_type` is used everywhere else in this codebase — nothing reads it to gate retry-sequence behavior). It does not by itself stop the shared retry sequence from trying a different provider while Bundle Portal has an order in flight for the same number; that would require a separate change to the shared retry dispatcher affecting all 9 providers, which is out of scope here.

**Airtime integration is explicitly out of scope** — deferred to a separate follow-up design per direct user instruction.

---

### Task 1: Type changes

**Files:**
- Modify: `lib/mtn-providers/types.ts`

- [ ] **Step 1: Add `isBigTime` and widen `MTNProviderName`**

Find:

```ts
export interface MTNOrderRequest {
    recipient_phone: string
    network: "MTN" | "Telecel" | "AirtelTigo"
    size_gb: number
    traceId?: string
    /**
     * Our order UUID, sent to the provider as a client reference. DataKazina
     * echoes it back (disguised) in the webhook `reference` field, letting us
     * recover the order via extractOrderIdFromReference.
     */
    client_ref?: string
}
```

Replace with:

```ts
export interface MTNOrderRequest {
    recipient_phone: string
    network: "MTN" | "Telecel" | "AirtelTigo"
    size_gb: number
    traceId?: string
    /**
     * Our order UUID, sent to the provider as a client reference. DataKazina
     * echoes it back (disguised) in the webhook `reference` field, letting us
     * recover the order via extractOrderIdFromReference.
     */
    client_ref?: string
    /**
     * True only for an AT-BigTime order. This codebase has no separate
     * `network` value for BigTime vs. iShare — both are "AirtelTigo" — so
     * this is the only signal distinguishing them. Every existing provider
     * ignores this field; only Bundle Portal reads it.
     */
    isBigTime?: boolean
}
```

Find:

```ts
export type MTNProviderName = "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft" | "agentportalgh" | "apexprime"
```

Replace with:

```ts
export type MTNProviderName = "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft" | "agentportalgh" | "apexprime" | "bundleportal"
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors (nothing references `"bundleportal"` or `isBigTime` yet, so this is purely additive).

- [ ] **Step 3: Commit**

```bash
git add lib/mtn-providers/types.ts
git commit -m "feat(bundleportal): add isBigTime field and widen MTNProviderName"
```

---

### Task 2: Bundle Portal provider class

**Files:**
- Create: `lib/mtn-providers/bundleportal-provider.ts`
- Test: `lib/mtn-providers/bundleportal-provider.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/mtn-providers/bundleportal-provider.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"

// Mutable so getActiveMtnRoute's tests can reconfigure it per-case without
// vi.resetModules()/vi.doMock() gymnastics — mirrors the vi.hoisted mutable-
// fixture pattern already established in bundleportal-webhook-processor.test.ts.
const fakeSettings = vi.hoisted(() => ({ current: {} as Record<string, any> }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(_table: string) {
      return {
        select() {
          return {
            eq(_col: string, key: string) {
              return {
                maybeSingle: () =>
                  Promise.resolve({
                    data: fakeSettings.current[key] ? { value: fakeSettings.current[key] } : null,
                    error: null,
                  }),
              }
            },
          }
        },
      }
    },
  },
}))

import { mapNetworkToBundlePortal, mapBundlePortalStatus, isRetryableErrorCode, getActiveMtnRoute } from "./bundleportal-provider"

beforeEach(() => {
  fakeSettings.current = { bundleportal_mtn_route: { route: "mtn_2" } }
})

describe("mapNetworkToBundlePortal", () => {
  it("maps MTN using the given route", () => {
    expect(mapNetworkToBundlePortal("MTN", false, "mtn")).toBe("mtn")
    expect(mapNetworkToBundlePortal("MTN", false, "mtn_2")).toBe("mtn_2")
    expect(mapNetworkToBundlePortal("MTN", false, "mtn_3")).toBe("mtn_3")
  })
  it("maps Telecel regardless of route or BigTime flag", () => {
    expect(mapNetworkToBundlePortal("Telecel", false, "mtn")).toBe("telecel")
    expect(mapNetworkToBundlePortal("Telecel", true, "mtn_3")).toBe("telecel")
  })
  it("maps AirtelTigo to bigtime only when isBigTime is true", () => {
    expect(mapNetworkToBundlePortal("AirtelTigo", true, "mtn")).toBe("bigtime")
    expect(mapNetworkToBundlePortal("AirtelTigo", false, "mtn")).toBe("airteltigo")
    expect(mapNetworkToBundlePortal("AirtelTigo", undefined, "mtn")).toBe("airteltigo")
  })
})

describe("mapBundlePortalStatus", () => {
  it("maps in-flight statuses to processing", () => {
    expect(mapBundlePortalStatus("processing")).toBe("processing")
    expect(mapBundlePortalStatus("cached")).toBe("processing")
  })
  it("maps completed and failed directly", () => {
    expect(mapBundlePortalStatus("completed")).toBe("completed")
    expect(mapBundlePortalStatus("failed")).toBe("failed")
  })
  it("is case-insensitive and trims whitespace", () => {
    expect(mapBundlePortalStatus(" COMPLETED ")).toBe("completed")
  })
  it("defaults an unrecognized status to processing rather than guessing failed", () => {
    expect(mapBundlePortalStatus("some_new_status")).toBe("processing")
  })
})

describe("isRetryableErrorCode", () => {
  it("treats documented retry-later codes as retryable", () => {
    expect(isRetryableErrorCode("pending_order")).toBe(true)
    expect(isRetryableErrorCode("network_locked")).toBe(true)
    expect(isRetryableErrorCode("rate_limit")).toBe(true)
    expect(isRetryableErrorCode("read_rate_limited")).toBe(true)
    expect(isRetryableErrorCode("server_error")).toBe(true)
    expect(isRetryableErrorCode("order_capacity_busy")).toBe(true)
    expect(isRetryableErrorCode("balance_changed")).toBe(true)
  })
  it("treats a hard validation/rejection code as not retryable", () => {
    expect(isRetryableErrorCode("unknown_bundle")).toBe(false)
    expect(isRetryableErrorCode("not_allowlisted")).toBe(false)
    expect(isRetryableErrorCode(undefined)).toBe(false)
  })
})

describe("getActiveMtnRoute", () => {
  it("returns the configured route when valid", async () => {
    expect(await getActiveMtnRoute()).toBe("mtn_2")
  })

  it("defaults to mtn when the setting is missing", async () => {
    fakeSettings.current = {}
    expect(await getActiveMtnRoute()).toBe("mtn")
  })

  it("defaults to mtn when the stored value is invalid", async () => {
    fakeSettings.current = { bundleportal_mtn_route: { route: "not_a_real_route" } }
    expect(await getActiveMtnRoute()).toBe("mtn")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/mtn-providers/bundleportal-provider.test.ts`
Expected: FAIL — `lib/mtn-providers/bundleportal-provider.ts` does not exist yet.

- [ ] **Step 3: Write the provider**

Create `lib/mtn-providers/bundleportal-provider.ts`:

```ts
import crypto from "crypto"
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"
import { supabaseAdmin as supabase } from "@/lib/supabase"

const BASE_URL = process.env.BUNDLEPORTAL_BASE_URL ?? "https://api.bundleportal.com/v1"
const TIMEOUT = 30_000

function apiKey(): string {
  return process.env.BUNDLEPORTAL_API_KEY ?? ""
}

async function apiCall(body: Record<string, unknown>): Promise<Response> {
  return fetch(BASE_URL, {
    method: "POST",
    headers: { "x-api-key": apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  })
}

/** admin_settings key for the admin-selected active MTN route. */
export const MTN_ROUTE_KEY = "bundleportal_mtn_route"

export async function getActiveMtnRoute(): Promise<"mtn" | "mtn_2" | "mtn_3"> {
  try {
    const { data } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", MTN_ROUTE_KEY)
      .maybeSingle()
    const route = data?.value?.route
    return route === "mtn_2" || route === "mtn_3" ? route : "mtn"
  } catch {
    return "mtn"
  }
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Map our internal network + BigTime flag + configured MTN route to Bundle
 * Portal's own `network` value. "bigtime" is undocumented on Bundle Portal's
 * side (confirmed only via a live test order, not their official docs — see
 * design doc context) so it's kept as its own distinct literal rather than
 * folded into "airteltigo", making a future rejection of this specific value
 * easy to recognize.
 */
export function mapNetworkToBundlePortal(
  network: "MTN" | "Telecel" | "AirtelTigo",
  isBigTime: boolean | undefined,
  mtnRoute: "mtn" | "mtn_2" | "mtn_3"
): string {
  if (network === "MTN") return mtnRoute
  if (network === "Telecel") return "telecel"
  return isBigTime ? "bigtime" : "airteltigo"
}

/** Maps Bundle Portal's order status values to this app's canonical status set. */
export function mapBundlePortalStatus(raw: string): "pending" | "processing" | "completed" | "failed" {
  const s = (raw ?? "").toLowerCase().trim()
  if (s === "completed") return "completed"
  if (s === "failed") return "failed"
  // "processing" and "cached" (accepted, queued for manual delivery) are both
  // still in flight — cached is a real paid order, not a rejection.
  return "processing"
}

/** True for a documented retry-later business rejection code (not a hard failure). */
export function isRetryableErrorCode(code: string | undefined): boolean {
  return code === "pending_order" || code === "network_locked" || code === "rate_limit" || code === "read_rate_limited" || code === "server_error" || code === "order_capacity_busy" || code === "balance_changed"
}

// ── Provider class ───────────────────────────────────────────────────────────

export class BundlePortalProvider implements MTNProvider {
  name = "bundleportal"

  async createOrder(request: MTNOrderRequest): Promise<MTNOrderResponse> {
    if (!isValidPhoneFormat(request.recipient_phone)) {
      return { success: false, message: `Invalid phone: ${request.recipient_phone}`, error_type: "VALIDATION" }
    }
    if (!validatePhoneNetworkMatch(request.recipient_phone, request.network)) {
      return { success: false, message: `Phone does not match ${request.network}`, error_type: "VALIDATION" }
    }

    const phone = normalizePhoneNumber(request.recipient_phone)
    // Always sent, even though the docs mark it optional — it's the sole
    // idempotency key AND the sole status-lookup key for this provider.
    const orderId = request.client_ref ?? crypto.randomUUID()
    const mtnRoute = await getActiveMtnRoute()
    const bpNetwork = mapNetworkToBundlePortal(request.network, request.isBigTime, mtnRoute)

    let res: Response
    try {
      res = await apiCall({
        action: "place_order",
        network: bpNetwork,
        recipient: phone,
        package_size: request.size_gb,
        order_id: orderId,
      })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error", error_type: "NETWORK_ERROR" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)`, error_type: "API_ERROR" }
    }

    if (json.success !== true) {
      const errorType = isRetryableErrorCode(json.code) ? "RETRYABLE" : "API_ERROR"
      return { success: false, message: json.message ?? `API error (status ${res.status})`, error_type: errorType }
    }

    // json.data.duplicate === true means this order_id was already submitted —
    // Bundle Portal returns the ORIGINAL order rather than creating a second
    // one or charging again. Treated as an ordinary success.
    return { success: true, order_id: orderId, message: json.data?.duplicate ? "Order already placed (recovered retry)" : (json.message ?? "Order placed successfully") }
  }

  async checkOrderStatus(orderId: string | number): Promise<MTNOrderStatusResponse> {
    const id = String(orderId)
    if (id.startsWith("FAILED_INIT_")) {
      return { success: true, status: "failed", message: "Order was never submitted to Bundle Portal (local failure)" }
    }

    let res: Response
    try {
      res = await apiCall({ action: "check_status", order_reference: id })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)` }
    }

    if (json.success !== true) {
      return { success: false, message: json.message ?? `API error (status ${res.status})` }
    }

    return {
      success: true,
      status: mapBundlePortalStatus(json.data?.status),
      message: json.data?.failure_reason ?? "Status retrieved",
      order: json.data,
    }
  }

  async checkBalance(): Promise<number | null> {
    try {
      const res = await apiCall({ action: "check_balance" })
      if (!res.ok) return null
      const json = await res.json()
      if (json.success !== true) return null
      const bal = json.data?.wallet_balance
      return typeof bal === "number" ? bal : null
    } catch {
      return null
    }
  }

  // ── Admin / auxiliary — used by the whitelist registry (Task 6) and the
  // admin API route (Task 5). Not part of MTNProvider.

  async verifyNumber(phone: string, network: string): Promise<any> {
    const res = await apiCall({ action: "verify_number", network, recipient: normalizePhoneNumber(phone) })
    if (!res.ok) throw new Error(`Bundle Portal verify_number API error ${res.status}`)
    return res.json()
  }

  async setWebhook(webhookUrl: string): Promise<any> {
    const res = await apiCall({ action: "set_webhook", webhook_url: webhookUrl })
    if (!res.ok) throw new Error(`Bundle Portal set_webhook API error ${res.status}`)
    return res.json()
  }
}

export default BundlePortalProvider
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/mtn-providers/bundleportal-provider.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add lib/mtn-providers/bundleportal-provider.ts lib/mtn-providers/bundleportal-provider.test.ts
git commit -m "feat(bundleportal): add BundlePortalProvider class"
```

---

### Task 3: Wire into the provider factory

**Files:**
- Modify: `lib/mtn-providers/factory.ts`

- [ ] **Step 1: Import and widen `VALID_PROVIDERS`**

Find:

```ts
import { ApexPrimeProvider } from "./apexprime-provider"
import { SPFastITProvider } from "./spfastit-provider"
```

Replace with:

```ts
import { ApexPrimeProvider } from "./apexprime-provider"
import { SPFastITProvider } from "./spfastit-provider"
import { BundlePortalProvider } from "./bundleportal-provider"
```

Find:

```ts
        // Validate provider name
        if (provider === "sykes" || provider === "datakazina" || provider === "xpress" || provider === "eazyghdata" || provider === "bisdel" || provider === "codecraft" || provider === "agentportalgh" || provider === "apexprime") {
            return provider
        }
```

Replace with:

```ts
        // Validate provider name
        if (provider === "sykes" || provider === "datakazina" || provider === "xpress" || provider === "eazyghdata" || provider === "bisdel" || provider === "codecraft" || provider === "agentportalgh" || provider === "apexprime" || provider === "bundleportal") {
            return provider
        }
```

Find:

```ts
const VALID_PROVIDERS: MTNProviderName[] = ["sykes", "datakazina", "xpress", "eazyghdata", "bisdel", "codecraft", "agentportalgh", "apexprime"]
```

Replace with:

```ts
const VALID_PROVIDERS: MTNProviderName[] = ["sykes", "datakazina", "xpress", "eazyghdata", "bisdel", "codecraft", "agentportalgh", "apexprime", "bundleportal"]
```

- [ ] **Step 2: Add the `getMTNProvider()` switch case**

Find:

```ts
    switch (providerName) {
        case "agentportalgh":
            return new AgentPortalGHProvider()
        case "apexprime":
            return new ApexPrimeProvider()
```

Replace with:

```ts
    switch (providerName) {
        case "agentportalgh":
            return new AgentPortalGHProvider()
        case "apexprime":
            return new ApexPrimeProvider()
        case "bundleportal":
            return new BundlePortalProvider()
```

- [ ] **Step 3: Add the `getProviderByName()` switch case**

Find:

```ts
export function getProviderByName(name: NonMTNProviderName): MTNProvider {
    switch (name) {
        case "agentportalgh":
            return new AgentPortalGHProvider()
        case "apexprime":
            return new ApexPrimeProvider()
```

Replace with:

```ts
export function getProviderByName(name: NonMTNProviderName): MTNProvider {
    switch (name) {
        case "agentportalgh":
            return new AgentPortalGHProvider()
        case "apexprime":
            return new ApexPrimeProvider()
        case "bundleportal":
            return new BundlePortalProvider()
```

- [ ] **Step 4: Widen `NON_MTN_CAPABLE`**

Find:

```ts
export const NON_MTN_CAPABLE: Record<string, NonMTNProviderName[]> = {
    telecel_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"],
    at_ishare_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "spfastit"],
    at_bigtime_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft"],
}
```

Replace with:

```ts
export const NON_MTN_CAPABLE: Record<string, NonMTNProviderName[]> = {
    telecel_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "bundleportal"],
    at_ishare_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "spfastit", "bundleportal"],
    at_bigtime_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "bundleportal"],
}
```

- [ ] **Step 5: Run the existing factory tests**

Run: `npx vitest run lib/mtn-providers/factory.test.ts`
Expected: PASS (no existing test asserts an exact/exhaustive provider list length — if one does, extend it to include `"bundleportal"` the same way `"apexprime"`/`"spfastit"` are already covered).

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add lib/mtn-providers/factory.ts
git commit -m "feat(bundleportal): wire BundlePortalProvider into the provider factory"
```

---

### Task 4: Wire `isBigTime` into the non-MTN dispatcher

**Files:**
- Modify: `lib/non-mtn-fulfillment.ts`

- [ ] **Step 1: Set `isBigTime` on the built request**

Find:

```ts
  const reqNetwork = NETWORK_TO_REQUEST_NETWORK[normalizedKey] ?? "AirtelTigo"
  const mtnRequest: MTNOrderRequest = {
    recipient_phone: phoneNumber,
    network: reqNetwork,
    size_gb: sizeGb,
    client_ref: orderId,
  }
```

Replace with:

```ts
  const reqNetwork = NETWORK_TO_REQUEST_NETWORK[normalizedKey] ?? "AirtelTigo"
  const mtnRequest: MTNOrderRequest = {
    recipient_phone: phoneNumber,
    network: reqNetwork,
    size_gb: sizeGb,
    client_ref: orderId,
    isBigTime: normalizedKey === "AT - BIGTIME",
  }
```

- [ ] **Step 2: Run the existing non-MTN fulfillment tests**

Run: `npx vitest run lib/non-mtn-fulfillment.test.ts`
Expected: PASS (the new field is additive; every provider except Bundle Portal ignores it).

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add lib/non-mtn-fulfillment.ts
git commit -m "feat(bundleportal): pass isBigTime through the non-MTN dispatcher"
```

---

### Task 5: Admin API route

**Files:**
- Create: `app/api/admin/bundleportal/route.ts`

- [ ] **Step 1: Write the route**

Create `app/api/admin/bundleportal/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { BundlePortalProvider, MTN_ROUTE_KEY } from "@/lib/mtn-providers/bundleportal-provider"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const action = request.nextUrl.searchParams.get("action")

  try {
    const provider = new BundlePortalProvider()
    if (action === "balance") {
      const balance = await provider.checkBalance()
      return NextResponse.json({ success: true, balance, currency: "GHS" })
    }
    if (action === "mtn-route") {
      const { data } = await supabase
        .from("admin_settings")
        .select("value")
        .eq("key", MTN_ROUTE_KEY)
        .maybeSingle()
      const route = data?.value?.route
      return NextResponse.json({ success: true, route: route === "mtn_2" || route === "mtn_3" ? route : "mtn" })
    }
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (error) {
    console.error("[ADMIN-BUNDLEPORTAL] GET error:", error)
    return NextResponse.json({ error: "Bundle Portal request failed" }, { status: 502 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const body = await request.json()
    const provider = new BundlePortalProvider()

    if (body.action === "verify") {
      if (typeof body.phone !== "string" || !body.phone) {
        return NextResponse.json({ error: "phone is required" }, { status: 400 })
      }
      const result = await provider.verifyNumber(body.phone, body.network ?? "mtn")
      return NextResponse.json(result)
    }

    if (body.action === "set-mtn-route") {
      const route = body.route
      if (route !== "mtn" && route !== "mtn_2" && route !== "mtn_3") {
        return NextResponse.json({ error: "Invalid route. Use: mtn, mtn_2, mtn_3" }, { status: 400 })
      }
      const { error } = await supabase
        .from("admin_settings")
        .upsert({ key: MTN_ROUTE_KEY, value: { route }, updated_at: new Date().toISOString() }, { onConflict: "key" })
      if (error) {
        console.error("[ADMIN-BUNDLEPORTAL] Failed to save MTN route:", error)
        return NextResponse.json({ error: "Failed to save setting" }, { status: 500 })
      }
      return NextResponse.json({ success: true, route })
    }

    if (body.action === "register-webhook") {
      if (typeof body.webhookUrl !== "string" || !body.webhookUrl) {
        return NextResponse.json({ error: "webhookUrl is required" }, { status: 400 })
      }
      const result = await provider.setWebhook(body.webhookUrl)
      // The webhook_secret in this response is shown ONLY here, once — this
      // route never stores it. The admin must copy it into
      // BUNDLEPORTAL_WEBHOOK_SECRET in Vercel themselves.
      return NextResponse.json(result)
    }

    return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 })
  } catch (error) {
    console.error("[ADMIN-BUNDLEPORTAL] POST error:", error)
    return NextResponse.json({ error: "Bundle Portal request failed" }, { status: 502 })
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/bundleportal/route.ts
git commit -m "feat(bundleportal): add admin API route for MTN route + webhook registration"
```

---

### Task 6: Whitelist registry integration

**Files:**
- Modify: `lib/mtn-providers/provider-whitelist.ts`

- [ ] **Step 1: Add the check functions**

Find:

```ts
// Apex Prime's own MTN Pre-Check & Approval Note (confirmed with them 2026-09-05):
```

Insert immediately before it:

```ts
async function checkBundlePortal(msisdn: string): Promise<WhitelistResult> {
  try {
    const { BundlePortalProvider } = await import("./bundleportal-provider")
    const data = await new BundlePortalProvider().verifyNumber(msisdn, "mtn")
    return { allowed: data?.data?.allowed === true, provider: "bundleportal", reason: data?.data?.allowlist_message }
  } catch {
    return { allowed: true, provider: "bundleportal" }
  }
}

async function checkBundlePortalBatch(
  msisdns: string[]
): Promise<Array<{ msisdn: string; allowed: boolean; reason?: string }>> {
  // No native batch endpoint on Bundle Portal's side — verify sequentially,
  // matching Apex Prime's approach (checkApexPrimeBatch below).
  const results: Array<{ msisdn: string; allowed: boolean; reason?: string }> = []
  const { BundlePortalProvider } = await import("./bundleportal-provider")
  const provider = new BundlePortalProvider()
  for (const msisdn of msisdns) {
    try {
      const data = await provider.verifyNumber(msisdn, "mtn")
      results.push({ msisdn, allowed: data?.data?.allowed === true, reason: data?.data?.allowlist_message })
    } catch {
      results.push({ msisdn, allowed: true })
    }
  }
  return results
}
```

- [ ] **Step 2: Add the registry entry**

Find:

```ts
  {
    name: "apexprime",
    configured: () => !!process.env.APEXPRIME_API_KEY,
    check: checkApexPrime,
    checkBatch: checkApexPrimeBatch,
  },
  // Add future whitelist providers here ↓
]
```

Replace with:

```ts
  {
    name: "apexprime",
    configured: () => !!process.env.APEXPRIME_API_KEY,
    check: checkApexPrime,
    checkBatch: checkApexPrimeBatch,
  },
  {
    name: "bundleportal",
    configured: () => !!process.env.BUNDLEPORTAL_API_KEY,
    check: checkBundlePortal,
    checkBatch: checkBundlePortalBatch,
  },
  // Add future whitelist providers here ↓
]
```

- [ ] **Step 3: Run the existing whitelist tests (if any) and type-check**

Run: `npx vitest run lib/mtn-providers/provider-whitelist.test.ts 2>/dev/null; npx tsc --noEmit`
Expected: no new errors. (If no test file exists for this module, this step is type-check only — matches the existing convention, since Apex Prime's/AgentPortalGH's own registry entries have no dedicated unit test either.)

- [ ] **Step 4: Commit**

```bash
git add lib/mtn-providers/provider-whitelist.ts
git commit -m "feat(bundleportal): add Bundle Portal to WHITELIST_REGISTRY"
```

---

### Task 7: Webhook processor + route

**Files:**
- Create: `lib/mtn-providers/bundleportal-webhook-processor.ts`
- Create: `lib/mtn-providers/bundleportal-webhook-processor.test.ts`
- Create: `app/api/webhooks/mtn/bundleportal/route.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/mtn-providers/bundleportal-webhook-processor.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import crypto from "crypto"
import { verifySig } from "./bundleportal-webhook-processor"

describe("verifySig", () => {
  const secret = "whsec_test_secret"
  const body = JSON.stringify({ event: "order.completed", order_id: "abc-123" })

  it("accepts a correctly signed body", () => {
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")
    expect(verifySig(body, sig, secret)).toBe(true)
  })

  it("rejects a tampered body", () => {
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")
    expect(verifySig(body + "tampered", sig, secret)).toBe(false)
  })

  it("rejects a missing signature header", () => {
    expect(verifySig(body, null, secret)).toBe(false)
  })

  it("rejects a signature signed with the wrong secret", () => {
    const sig = "sha256=" + crypto.createHmac("sha256", "wrong_secret").update(body).digest("hex")
    expect(verifySig(body, sig, secret)).toBe(false)
  })
})

const fakeDb = vi.hoisted(() => ({
  trackingRows: [] as Array<{
    id: string
    mtn_order_id: string | null
    status: string
    order_type: string
    order_id: string | null
    api_order_id: string | null
    shop_order_id: string | null
  }>,
  updates: [] as Array<{ id: string; payload: Record<string, unknown> }>,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "mtn_fulfillment_tracking") {
        return {
          select: () => ({
            eq: (col: string, val: unknown) => ({
              maybeSingle: () => Promise.resolve({ data: fakeDb.trackingRows.find(r => (r as Record<string, unknown>)[col] === val) ?? null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: (_col: string, id: string) => {
              fakeDb.updates.push({ id, payload })
              const row = fakeDb.trackingRows.find(r => r.id === id)
              if (row) Object.assign(row, payload)
              return Promise.resolve({ data: null, error: null })
            },
          }),
        }
      }
      if (table === "orders" || table === "api_orders" || table === "ussd_orders" || table === "ussd_shop_orders" || table === "shop_orders") {
        return {
          update: () => ({
            eq: () => ({
              select: () => ({ single: () => Promise.resolve({ data: null }) }),
            }),
          }),
        }
      }
      throw new Error(`bundleportal-webhook-processor.test.ts fake supabase client: unexpected table "${table}"`)
    },
  }),
}))

vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn() }))

import { processWebhook } from "./bundleportal-webhook-processor"

function seedTracking(overrides: Partial<(typeof fakeDb.trackingRows)[number]>) {
  const row = {
    id: `row-${fakeDb.trackingRows.length + 1}`,
    mtn_order_id: null,
    status: "processing",
    order_type: "shop",
    order_id: null,
    api_order_id: null,
    shop_order_id: null,
    ...overrides,
  }
  fakeDb.trackingRows.push(row)
  return row
}

describe("processWebhook", () => {
  beforeEach(() => {
    fakeDb.trackingRows = []
    fakeDb.updates = []
  })

  it("looks up the tracking row directly by order_id (our own reference) and marks it completed", async () => {
    const target = seedTracking({ mtn_order_id: "our-ref-1" })

    await processWebhook({ event: "order.completed", order_id: "our-ref-1", status: "completed" })

    expect(fakeDb.updates.some(u => u.id === target.id && u.payload.status === "completed")).toBe(true)
  })

  it("does nothing when no tracking row matches the order_id", async () => {
    await processWebhook({ event: "order.failed", order_id: "unknown-ref", status: "failed" })
    expect(fakeDb.updates).toEqual([])
  })

  it("does nothing when the payload has no order_id at all", async () => {
    await processWebhook({ event: "order.completed", status: "completed" })
    expect(fakeDb.updates).toEqual([])
  })

  it("never regresses a completed order back to processing", async () => {
    const target = seedTracking({ mtn_order_id: "our-ref-2", status: "completed" })

    await processWebhook({ event: "order.cancelled", order_id: "our-ref-2", status: "processing" })

    expect(fakeDb.updates.every(u => u.payload.status !== "processing")).toBe(true)
    expect(target.status).toBe("completed")
  })

  it("never regresses a failed order back to processing (failed is terminal for Bundle Portal)", async () => {
    const target = seedTracking({ mtn_order_id: "our-ref-3", status: "failed" })

    await processWebhook({ event: "order.completed", order_id: "our-ref-3", status: "processing" })

    expect(fakeDb.updates.every(u => u.payload.status !== "processing")).toBe(true)
    expect(target.status).toBe("failed")
  })

  it("maps cancelled and refunded events to failed", async () => {
    const cancelled = seedTracking({ mtn_order_id: "our-ref-4" })
    await processWebhook({ event: "order.cancelled", order_id: "our-ref-4", status: "failed" })
    expect(cancelled.status).toBe("failed")

    const refunded = seedTracking({ mtn_order_id: "our-ref-5" })
    await processWebhook({ event: "order.refunded", order_id: "our-ref-5", status: "failed" })
    expect(refunded.status).toBe("failed")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/mtn-providers/bundleportal-webhook-processor.test.ts`
Expected: FAIL — `lib/mtn-providers/bundleportal-webhook-processor.ts` does not exist yet.

- [ ] **Step 3: Write the processor**

Create `lib/mtn-providers/bundleportal-webhook-processor.ts`:

```ts
import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"
import { mapBundlePortalStatus } from "@/lib/mtn-providers/bundleportal-provider"
import { sendPushToUser } from "@/lib/push-service"

// Webhook processing logic for the Bundle Portal MTN fulfillment provider,
// extracted out of app/api/webhooks/mtn/bundleportal/route.ts so it's unit
// testable — Next.js's typed-routes checker rejects any export from a
// route.ts file other than the HTTP method handlers and a small set of
// config constants.
//
// Much simpler than agentportalgh-webhook-processor.ts: Bundle Portal's
// webhook payload's `order_id` field is documented as our own client-supplied
// reference directly, so lookup is a single direct query — no phone+size
// fallback matching, no ambiguous-sibling guard, no items array to iterate
// (one order per webhook delivery, not a batch).

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export function verifySig(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex")
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header))
  } catch {
    return false
  }
}

/** Bundle Portal's four documented webhook events, mapped to our canonical status set. */
function mapEventStatus(event: string, status: string): "pending" | "processing" | "completed" | "failed" {
  if (event === "order.cancelled" || event === "order.refunded") return "failed"
  return mapBundlePortalStatus(status)
}

export async function processWebhook(payload: any) {
  const ref: string | undefined = payload.order_id
  if (!ref) {
    console.warn("[WEBHOOK-BUNDLEPORTAL] Payload missing order_id, cannot process:", payload.event)
    return
  }

  const newStatus = mapEventStatus(payload.event, payload.status)

  const { data: tracking } = await supabase
    .from("mtn_fulfillment_tracking")
    .select("id, status, order_type, order_id, api_order_id, shop_order_id")
    .eq("mtn_order_id", ref)
    .maybeSingle()

  if (!tracking) {
    console.warn("[WEBHOOK-BUNDLEPORTAL] No tracking row found for order_id:", ref)
    return
  }

  // All four documented webhook events (completed/failed/cancelled/refunded)
  // are genuinely final per the docs' own is_final field, and — unlike
  // AgentPortalGH, which auto-retries a failed item internally up to 3x and
  // can later flip a "failed" webhook to "completed" — Bundle Portal's docs
  // describe "failed" as fully terminal ("Not delivered. Any charge is
  // reversed."), with no documented re-opening case. So both terminal states
  // are guarded here, simpler than AgentPortalGH's priority map.
  if ((tracking.status === "completed" || tracking.status === "failed") && newStatus !== tracking.status) {
    console.warn(`[WEBHOOK-BUNDLEPORTAL] Ignoring ${payload.event} (would move ${ref} from terminal "${tracking.status}" to "${newStatus}")`)
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
      external_message: payload.failure_reason ?? null,
      webhook_received_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", tracking.id)

  // Mirror to the originating order table + in-app notification: same
  // order_type branching (bulk/api/ussd/ussd_shop/shop) as
  // agentportalgh-webhook-processor.ts's processItem — reused verbatim here,
  // this provider has no phone+size fallback to complicate it.
  const orderTableStatus = newStatus === "failed" ? "pending" : newStatus
  let userId: string | null = null
  let phone: string | null = null
  let size: string | null = null
  let network: string | null = null

  if (tracking.order_type === "bulk" && tracking.order_id) {
    const { data: o } = await supabase
      .from("orders")
      .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", tracking.order_id)
      .select("user_id, network, size, phone_number")
      .single()
    if (o) { userId = o.user_id; phone = o.phone_number; size = o.size; network = o.network }
  } else if (tracking.order_type === "api" && (tracking.api_order_id || tracking.order_id)) {
    const apiId = tracking.api_order_id || tracking.order_id
    const { data: o } = await supabase
      .from("api_orders")
      .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", apiId)
      .select("user_id, network, volume_gb, recipient_phone")
      .single()
    if (o) { userId = o.user_id; phone = o.recipient_phone; size = `${o.volume_gb}GB`; network = o.network }
  } else if (tracking.order_type === "ussd" && tracking.order_id) {
    const { data: o } = await supabase
      .from("ussd_orders")
      .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", tracking.order_id)
      .select("network, package_size, recipient_phone")
      .single()
    if (o) { phone = o.recipient_phone; size = o.package_size; network = o.network }
  } else if (tracking.order_type === "ussd_shop" && tracking.order_id) {
    const { data: o } = await supabase
      .from("ussd_shop_orders")
      .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", tracking.order_id)
      .select("network, package_size, recipient_phone")
      .single()
    if (o) { phone = o.recipient_phone; size = o.package_size; network = o.network }
  } else if (tracking.shop_order_id) {
    const { data: o } = await supabase
      .from("shop_orders")
      .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
      .eq("id", tracking.shop_order_id)
      .select("shop_id, network, volume_gb, customer_phone")
      .single()
    if (o) {
      phone = o.customer_phone; size = `${o.volume_gb}GB`; network = o.network
      const { data: shopOwner } = await supabase.from("user_shops").select("user_id").eq("id", o.shop_id).single()
      userId = shopOwner?.user_id ?? null
    }
  }

  if (userId && (newStatus === "completed" || newStatus === "failed")) {
    const title = newStatus === "completed" ? "Order Delivered Successfully" : "Order Delivery Failed"
    const body = newStatus === "completed"
      ? `Your ${size ?? ""} ${network ?? "MTN"} bundle for ${phone ?? "your number"} was delivered.`
      : `Your ${size ?? ""} ${network ?? "MTN"} bundle for ${phone ?? "your number"} could not be delivered.`
    await sendPushToUser(userId, { title, body }).catch(() => null)
  }

  console.log(`[WEBHOOK-BUNDLEPORTAL] ${ref} → ${newStatus}`)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/mtn-providers/bundleportal-webhook-processor.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Write the webhook route**

Create `app/api/webhooks/mtn/bundleportal/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { verifySig, processWebhook } from "@/lib/mtn-providers/bundleportal-webhook-processor"

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const sigHeader = request.headers.get("x-bundleportal-signature")
  const secret = process.env.BUNDLEPORTAL_WEBHOOK_SECRET

  if (!secret) {
    console.error("[WEBHOOK-BUNDLEPORTAL] BUNDLEPORTAL_WEBHOOK_SECRET not set — rejecting all requests")
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 })
  }
  if (!verifySig(rawBody, sigHeader, secret)) {
    console.warn(
      "[WEBHOOK-BUNDLEPORTAL] Signature rejected.",
      `x-bundleportal-signature present: ${sigHeader !== null}`,
      `headers received: ${JSON.stringify([...request.headers.keys()])}`,
      `body preview: ${rawBody.slice(0, 200)}`
    )
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // Respond immediately, but keep the function alive until processing
  // finishes via after() — a bare fire-and-forget call is not guaranteed to
  // complete (confirmed live 2026-07-26 on AgentPortalGH's webhook: Vercel
  // can freeze/terminate the function right after the response is sent,
  // silently dropping the update).
  after(() => processWebhook(payload))
  return NextResponse.json({ received: true })
}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add lib/mtn-providers/bundleportal-webhook-processor.ts lib/mtn-providers/bundleportal-webhook-processor.test.ts app/api/webhooks/mtn/bundleportal/route.ts
git commit -m "feat(bundleportal): add webhook handler with HMAC verification"
```

---

### Task 8: Admin UI — types, labels, selector lists

**Files:**
- Modify: `app/admin/settings/mtn/page.tsx`

- [ ] **Step 1: Widen the local `MTNProviderName` and `NonMTNProvider` types, add state hooks**

Find (around line 126-147):

```ts
  const [apexBalance, setApexBalance] = useState<any>(null)
  const [apexBalanceLoading, setApexBalanceLoading] = useState(false)
  const [apexTransactions, setApexTransactions] = useState<any>(null)
  const [apexFulfillmentPaths, setApexFulfillmentPaths] = useState<Record<string, string>>({})
  const [apexSavingPath, setApexSavingPath] = useState<string | null>(null)
  const [apexVerifyPhone, setApexVerifyPhone] = useState("")
  const [apexVerifyResult, setApexVerifyResult] = useState<any>(null)
  const [apexVerifying, setApexVerifying] = useState(false)

  type MTNProviderName = "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft" | "agentportalgh" | "apexprime"
  const [retrySequenceEnabled, setRetrySequenceEnabled] = useState(false)
  const [retrySequence, setRetrySequence] = useState<MTNProviderName[]>([])
  const [savingRetrySequence, setSavingRetrySequence] = useState(false)

  const [disabledProviders, setDisabledProviders] = useState<MTNProviderName[]>([])
  const [togglingDisabled, setTogglingDisabled] = useState<MTNProviderName | null>(null)

  type NonMTNProvider = "datakazina" | "xpress" | "eazyghdata" | "codecraft" | "agentportalgh" | "apexprime" | "spfastit"
  const [telecelProvider, setTelecelProvider] = useState<NonMTNProvider>("codecraft")
  const [atIshareProvider, setAtIshareProvider] = useState<NonMTNProvider>("codecraft")
  const [atBigtimeProvider, setAtBigtimeProvider] = useState<NonMTNProvider>("codecraft")
  const [savingNetworkProvider, setSavingNetworkProvider] = useState<string | null>(null)
```

Replace with:

```ts
  const [apexBalance, setApexBalance] = useState<any>(null)
  const [apexBalanceLoading, setApexBalanceLoading] = useState(false)
  const [apexTransactions, setApexTransactions] = useState<any>(null)
  const [apexFulfillmentPaths, setApexFulfillmentPaths] = useState<Record<string, string>>({})
  const [apexSavingPath, setApexSavingPath] = useState<string | null>(null)
  const [apexVerifyPhone, setApexVerifyPhone] = useState("")
  const [apexVerifyResult, setApexVerifyResult] = useState<any>(null)
  const [apexVerifying, setApexVerifying] = useState(false)

  const [bpBalance, setBpBalance] = useState<number | null>(null)
  const [bpBalanceLoading, setBpBalanceLoading] = useState(false)
  const [bpMtnRoute, setBpMtnRoute] = useState<"mtn" | "mtn_2" | "mtn_3">("mtn")
  const [bpSavingRoute, setBpSavingRoute] = useState(false)
  const [bpVerifyPhone, setBpVerifyPhone] = useState("")
  const [bpVerifyResult, setBpVerifyResult] = useState<any>(null)
  const [bpVerifying, setBpVerifying] = useState(false)

  type MTNProviderName = "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft" | "agentportalgh" | "apexprime" | "bundleportal"
  const [retrySequenceEnabled, setRetrySequenceEnabled] = useState(false)
  const [retrySequence, setRetrySequence] = useState<MTNProviderName[]>([])
  const [savingRetrySequence, setSavingRetrySequence] = useState(false)

  const [disabledProviders, setDisabledProviders] = useState<MTNProviderName[]>([])
  const [togglingDisabled, setTogglingDisabled] = useState<MTNProviderName | null>(null)

  type NonMTNProvider = "datakazina" | "xpress" | "eazyghdata" | "codecraft" | "agentportalgh" | "apexprime" | "spfastit" | "bundleportal"
  const [telecelProvider, setTelecelProvider] = useState<NonMTNProvider>("codecraft")
  const [atIshareProvider, setAtIshareProvider] = useState<NonMTNProvider>("codecraft")
  const [atBigtimeProvider, setAtBigtimeProvider] = useState<NonMTNProvider>("codecraft")
  const [savingNetworkProvider, setSavingNetworkProvider] = useState<string | null>(null)
```

- [ ] **Step 2: Add `PROVIDER_LABELS` entry**

Find:

```ts
  const PROVIDER_LABELS: Record<MTNProviderName, string> = {
    sykes: "Sykes", datakazina: "DataKazina", xpress: "Xpress",
    eazyghdata: "EazyGhData", bisdel: "Bisdel", codecraft: "CodeCraft", agentportalgh: "AgentPortalGH",
    apexprime: "Apex Prime",
  }
```

Replace with:

```ts
  const PROVIDER_LABELS: Record<MTNProviderName, string> = {
    sykes: "Sykes", datakazina: "DataKazina", xpress: "Xpress",
    eazyghdata: "EazyGhData", bisdel: "Bisdel", codecraft: "CodeCraft", agentportalgh: "AgentPortalGH",
    apexprime: "Apex Prime", bundleportal: "Bundle Portal",
  }
```

- [ ] **Step 3: Add Bundle Portal to the per-network selector lists**

Find (around line 1351-1367):

```ts
              const baseProviders: { value: NonMTNProvider; label: string; sub: string }[] = [
                { value: "codecraft", label: "CodeCraft", sub: "Default AT/Telecel API" },
                { value: "datakazina", label: "DataKazina", sub: "Multi-network" },
                { value: "xpress", label: "Xpress", sub: "Batch-enabled" },
                { value: "eazyghdata", label: "EazyGhData", sub: "Package-based" },
              ]
              const nonBigTimeProviders: { value: NonMTNProvider; label: string; sub: string }[] = [
                ...baseProviders,
                { value: "agentportalgh", label: "AgentPortalGH", sub: "Webhook-first" },
                { value: "apexprime", label: "Apex Prime", sub: "GroupShare/Store" },
              ]
              const ishareProviders: { value: NonMTNProvider; label: string; sub: string }[] = [
                ...nonBigTimeProviders,
                { value: "spfastit", label: "SPFastIT", sub: "AirtelTigo-only" },
              ]
              const providers: { value: NonMTNProvider; label: string; sub: string }[] =
                netKey === "at_bigtime" ? baseProviders : netKey === "at_ishare" ? ishareProviders : nonBigTimeProviders
```

Replace with:

```ts
              const baseProviders: { value: NonMTNProvider; label: string; sub: string }[] = [
                { value: "codecraft", label: "CodeCraft", sub: "Default AT/Telecel API" },
                { value: "datakazina", label: "DataKazina", sub: "Multi-network" },
                { value: "xpress", label: "Xpress", sub: "Batch-enabled" },
                { value: "eazyghdata", label: "EazyGhData", sub: "Package-based" },
                { value: "bundleportal", label: "Bundle Portal", sub: "Webhook-first, all networks" },
              ]
              const nonBigTimeProviders: { value: NonMTNProvider; label: string; sub: string }[] = [
                ...baseProviders,
                { value: "agentportalgh", label: "AgentPortalGH", sub: "Webhook-first" },
                { value: "apexprime", label: "Apex Prime", sub: "GroupShare/Store" },
              ]
              const ishareProviders: { value: NonMTNProvider; label: string; sub: string }[] = [
                ...nonBigTimeProviders,
                { value: "spfastit", label: "SPFastIT", sub: "AirtelTigo-only" },
              ]
              const providers: { value: NonMTNProvider; label: string; sub: string }[] =
                netKey === "at_bigtime" ? baseProviders : netKey === "at_ishare" ? ishareProviders : nonBigTimeProviders
```

Bundle Portal is added once, to `baseProviders` — since every other list is built by spreading `baseProviders` outward, this makes it appear on all three network cards (Telecel, AT-iShare, AT-BigTime) in one change, matching that it's capable everywhere (unlike AgentPortalGH/Apex Prime, excluded from BigTime, or SPFastIT, iShare-only).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add app/admin/settings/mtn/page.tsx
git commit -m "feat(bundleportal): add types, label, and selector-list entries to MTN settings page"
```

---

### Task 9: Admin UI — Bundle Portal tab content

**Files:**
- Modify: `app/admin/settings/mtn/page.tsx`

- [ ] **Step 1: Add the data-loading effect and handlers**

Find (the end of the Apex Prime data-loading effect):

```ts
    loadApexData()
  }, [activeTab])

  const handleSetApexFulfillmentPath = async (network: "MTN" | "Telecel" | "AirtelTigo", path: "groupshare" | "store") => {
```

Replace with:

```ts
    loadApexData()
  }, [activeTab])

  useEffect(() => {
    if (activeTab !== "bundleportal") return
    const loadBundlePortalData = async () => {
      setBpBalanceLoading(true)
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (!session?.access_token) return
        const headers = { Authorization: `Bearer ${session.access_token}` }
        const [balanceRes, routeRes] = await Promise.all([
          fetch("/api/admin/bundleportal?action=balance", { headers }),
          fetch("/api/admin/bundleportal?action=mtn-route", { headers }),
        ])
        if (balanceRes.ok) {
          const data = await balanceRes.json()
          if (data.error) {
            toast.error(`Failed to load Bundle Portal balance: ${data.error}`)
          } else {
            setBpBalance(data.balance)
          }
        } else {
          toast.error("Failed to load Bundle Portal balance")
        }
        if (routeRes.ok) {
          const data = await routeRes.json()
          if (data.error || !data.route) {
            toast.error(data.error ? `Failed to load MTN route: ${data.error}` : "Failed to load MTN route")
          } else {
            setBpMtnRoute(data.route)
          }
        } else {
          toast.error("Failed to load MTN route")
        }
      } catch (e) {
        console.error("Error loading Bundle Portal data:", e)
      } finally {
        setBpBalanceLoading(false)
      }
    }
    loadBundlePortalData()
  }, [activeTab])

  const handleSetBundlePortalMtnRoute = async (route: "mtn" | "mtn_2" | "mtn_3") => {
    setBpSavingRoute(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const res = await fetch("/api/admin/bundleportal", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action: "set-mtn-route", route }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Failed") }
      setBpMtnRoute(route)
      toast.success(`Bundle Portal MTN route set to ${route}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update")
    } finally {
      setBpSavingRoute(false)
    }
  }

  const handleBundlePortalVerify = async () => {
    if (!bpVerifyPhone) return
    setBpVerifying(true)
    setBpVerifyResult(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { toast.error("Authentication required"); return }
      const res = await fetch("/api/admin/bundleportal", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action: "verify", phone: bpVerifyPhone, network: "mtn" }),
      })
      const data = await res.json()
      setBpVerifyResult(data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verification failed")
    } finally {
      setBpVerifying(false)
    }
  }

  const handleSetApexFulfillmentPath = async (network: "MTN" | "Telecel" | "AirtelTigo", path: "groupshare" | "store") => {
```

- [ ] **Step 2: Add the `TabsContent` block**

Find (the end of the Apex Prime `TabsContent`, immediately before `</Tabs>`):

```ts
                ) : (
                  <p className="text-sm text-muted-foreground">No transactions to show.</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
```

Replace with:

```ts
                ) : (
                  <p className="text-sm text-muted-foreground">No transactions to show.</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="bundleportal" className="space-y-4 mt-6">
            <ActivationCard providerKey="bundleportal" label="Bundle Portal" />

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Wallet className="h-5 w-5" />Balance</CardTitle>
              </CardHeader>
              <CardContent>
                {bpBalanceLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
                ) : bpBalance !== null ? (
                  <p className="text-lg font-semibold text-foreground">₵{bpBalance.toFixed(2)}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">No balance data available.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Zap className="h-5 w-5" />MTN Delivery Route</CardTitle>
                <CardDescription>MTN is available on three independent, separately-catalogued delivery routes. Pick one active route — new MTN orders through Bundle Portal use it.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  {(["mtn", "mtn_2", "mtn_3"] as const).map(route => (
                    <Button
                      key={route}
                      size="sm"
                      variant={bpMtnRoute === route ? "default" : "outline"}
                      disabled={bpSavingRoute}
                      onClick={() => handleSetBundlePortalMtnRoute(route)}
                    >
                      {route === "mtn" ? "MTN (default)" : route === "mtn_2" ? "MTN 2" : "MTN 3"}
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" />Whitelist Checker</CardTitle>
                <CardDescription>Ad-hoc single-number check against Bundle Portal's verify_number endpoint. Bulk checks run from /admin/phone-verification.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input placeholder="0241234567" value={bpVerifyPhone} onChange={e => setBpVerifyPhone(e.target.value)} />
                  <Button onClick={handleBundlePortalVerify} disabled={bpVerifying || !bpVerifyPhone}>
                    {bpVerifying ? <Loader2 className="h-4 w-4 animate-spin" /> : "Check"}
                  </Button>
                </div>
                {bpVerifyResult && (
                  <Alert className={bpVerifyResult.data?.allowed ? "border-success/30 bg-success/10" : "border-destructive/30 bg-destructive/10"}>
                    <AlertDescription className="text-xs">
                      {bpVerifyResult.data?.allowed
                        ? `Allowed${bpVerifyResult.data?.can_order === false ? " (but a prior order for this number is still in flight)" : ""}`
                        : bpVerifyResult.data?.allowlist_message ?? bpVerifyResult.message ?? "Not allowed / not found"}
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Manual verification**

Run the dev server (`npm run dev`), sign in as admin, navigate to `/admin/settings/mtn`, click the new "Bundle Portal" tab, and confirm:
- The Activation card, Balance card, MTN Delivery Route card (3 buttons), and Whitelist Checker card all render.
- Balance and MTN route load on tab open (network tab shows the two GET requests).
- Clicking a different MTN route button saves it and persists across a page reload.
- Scroll to the per-network provider cards and confirm Bundle Portal now appears as an option on all three (Telecel, AT-iShare, AT-BigTime).

- [ ] **Step 5: Commit**

```bash
git add app/admin/settings/mtn/page.tsx
git commit -m "feat(bundleportal): add Bundle Portal settings tab (balance, MTN route, whitelist checker)"
```

---

### Task 10: Per-order "Fulfill as..." dropdown

**Files:**
- Modify: `app/admin/order-payment-status/page.tsx`

- [ ] **Step 1: Add Bundle Portal to every branch**

Find:

```ts
// Mirrors lib/mtn-providers/factory.ts's provider-capability rules: MTN accepts all 8
// providers; non-MTN (Telecel/AT-iShare/AT-BigTime) accepts only the non-MTN-capable
// ones, with agentportalgh/apexprime further excluded from AT-BigTime specifically
// (business decision — neither provider's API distinguishes AT-iShare from AT-BigTime,
// so this exclusion is enforced here rather than by the provider itself), and spfastit
// offered only for AT-iShare (it's AirtelTigo-only — not capable for Telecel or MTN,
// per NON_MTN_CAPABLE.at_ishare_provider_selection in factory.ts).
function getProviderOptionsForNetwork(network: string): { value: string; label: string }[] {
  const upper = (network || "").toUpperCase()
  const isMTN = upper === "MTN"
  if (isMTN) {
    return [
      { value: "xpress", label: "Xpress" },
      { value: "codecraft", label: "Codecraft" },
      { value: "sykes", label: "Sykes" },
      { value: "datakazina", label: "Datakazina" },
      { value: "eazyghdata", label: "EazyGhData" },
      { value: "bisdel", label: "Bisdel" },
      { value: "agentportalgh", label: "AgentPortalGH" },
      { value: "apexprime", label: "Apex Prime" },
    ]
  }
  const isBigTime = upper.includes("BIGTIME") || upper.includes("BIG TIME")
  const isIshare = upper.includes("ISHARE")
  return [
    { value: "xpress", label: "Xpress" },
    { value: "codecraft", label: "Codecraft" },
    { value: "datakazina", label: "Datakazina" },
    { value: "eazyghdata", label: "EazyGhData" },
    ...(isBigTime ? [] : [{ value: "agentportalgh", label: "AgentPortalGH" }, { value: "apexprime", label: "Apex Prime" }]),
    ...(isIshare ? [{ value: "spfastit", label: "SPFastIT" }] : []),
  ]
}
```

Replace with:

```ts
// Mirrors lib/mtn-providers/factory.ts's provider-capability rules: MTN accepts all 9
// providers; non-MTN (Telecel/AT-iShare/AT-BigTime) accepts only the non-MTN-capable
// ones, with agentportalgh/apexprime further excluded from AT-BigTime specifically
// (business decision — neither provider's API distinguishes AT-iShare from AT-BigTime,
// so this exclusion is enforced here rather than by the provider itself), spfastit
// offered only for AT-iShare (it's AirtelTigo-only — not capable for Telecel or MTN,
// per NON_MTN_CAPABLE.at_ishare_provider_selection in factory.ts), and bundleportal
// offered on every branch, including AT-BigTime — it's a full member capable on all
// networks (see NON_MTN_CAPABLE.at_bigtime_provider_selection in factory.ts).
function getProviderOptionsForNetwork(network: string): { value: string; label: string }[] {
  const upper = (network || "").toUpperCase()
  const isMTN = upper === "MTN"
  if (isMTN) {
    return [
      { value: "xpress", label: "Xpress" },
      { value: "codecraft", label: "Codecraft" },
      { value: "sykes", label: "Sykes" },
      { value: "datakazina", label: "Datakazina" },
      { value: "eazyghdata", label: "EazyGhData" },
      { value: "bisdel", label: "Bisdel" },
      { value: "agentportalgh", label: "AgentPortalGH" },
      { value: "apexprime", label: "Apex Prime" },
      { value: "bundleportal", label: "Bundle Portal" },
    ]
  }
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
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Manual verification**

In `/admin/order-payment-status`, open the "Fulfill as..." dropdown for an MTN order, a Telecel order, an AT-iShare order, and an AT-BigTime order — confirm Bundle Portal appears in all four.

- [ ] **Step 4: Commit**

```bash
git add app/admin/order-payment-status/page.tsx
git commit -m "feat(bundleportal): add to per-order Fulfill-as dropdown on every network"
```

---

### Task 11: Server-side network-provider validation

**Files:**
- Modify: `app/api/admin/settings/network-provider/route.ts`

- [ ] **Step 1: Widen `VALID_PROVIDERS_BY_NETWORK`**

Find:

```ts
const VALID_PROVIDERS_BY_NETWORK: Record<string, string[]> = {
  telecel: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"],
  at_ishare: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "spfastit"],
  at_bigtime: ["datakazina", "xpress", "eazyghdata", "codecraft"],
}
```

Replace with:

```ts
const VALID_PROVIDERS_BY_NETWORK: Record<string, string[]> = {
  telecel: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "bundleportal"],
  at_ishare: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "spfastit", "bundleportal"],
  at_bigtime: ["datakazina", "xpress", "eazyghdata", "codecraft", "bundleportal"],
}
```

This must stay in sync with `NON_MTN_CAPABLE` in `lib/mtn-providers/factory.ts` (Task 3) — both lists were widened identically there.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/settings/network-provider/route.ts
git commit -m "feat(bundleportal): widen server-side network-provider validation"
```

---

### Task 12: Status-sync cron

**Files:**
- Create: `app/api/cron/sync-mtn-status/bundleportal/route.ts`

- [ ] **Step 1: Write the cron route**

Byte-for-byte copy of `app/api/cron/sync-mtn-status/apexprime/route.ts`, with `"apexprime"`/`APEXPRIME` substituted for `"bundleportal"`/`BUNDLEPORTAL` throughout (provider filter, log prefixes, doc comment). Create `app/api/cron/sync-mtn-status/bundleportal/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { checkMTNOrderStatus } from "@/lib/mtn-fulfillment"
import { verifyCronAuth } from "@/lib/cron-auth"
import { sendPushToUser } from "@/lib/push-service"
import { fetchReversalCandidates, isReversal, flagReversal } from "@/lib/mtn-reversal"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

const BATCH_SIZE = 50
const DELAY_BETWEEN_REQUESTS_MS = 1000

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * GET /api/cron/sync-mtn-status/bundleportal
 *
 * Polling fallback for Bundle Portal orders whose webhook was missed.
 * Webhooks are the primary channel for this provider (guaranteed delivery
 * via after(), documented by Bundle Portal as reliable enough that "most
 * integrations that use webhooks never call check_status at all") — this
 * cron is the same kind of safety net it already is for every other
 * provider, not the primary resolution path.
 */
export async function GET(request: NextRequest) {
    const { authorized, errorResponse } = verifyCronAuth(request)
    if (!authorized && errorResponse) return errorResponse

    try {
        console.log("[CRON-BUNDLEPORTAL] Starting status sync...")

        const { data: pendingOrders, error: fetchError } = await supabase
            .from("mtn_fulfillment_tracking")
            .select("id, mtn_order_id, status, shop_order_id, order_id, api_order_id, order_type, recipient_phone, size_gb")
            .eq("provider", "bundleportal")
            .in("status", ["pending", "processing"])
            .order("created_at", { ascending: true })
            .limit(BATCH_SIZE)

        if (fetchError) {
            console.error("[CRON-BUNDLEPORTAL] Error fetching orders:", fetchError)
            return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
        }

        if (!pendingOrders || pendingOrders.length === 0) {
            return NextResponse.json({ success: true, message: "No Bundle Portal orders to sync" })
        }

        console.log(`[CRON-BUNDLEPORTAL] Found ${pendingOrders.length} orders to sync`)

        let synced = 0
        let failed = 0
        const results = []

        for (let i = 0; i < pendingOrders.length; i++) {
            const order = pendingOrders[i]

            try {
                const result = await checkMTNOrderStatus(order.mtn_order_id, "bundleportal")

                if (result.success && result.status) {
                    const oldStatus = order.status
                    const newStatus = result.status
                    const statusPriority: Record<string, number> = { pending: 1, processing: 2, completed: 3, failed: 3, reversed: 4, abandoned: 4 }

                    if ((statusPriority[newStatus] ?? 0) < (statusPriority[oldStatus] ?? 0)) {
                        console.log(`[CRON-BUNDLEPORTAL] ⛔ Skipping regression ${oldStatus} -> ${newStatus} for ${order.mtn_order_id}`)
                    } else if (newStatus !== oldStatus) {
                        await supabase
                            .from("mtn_fulfillment_tracking")
                            .update({
                                status: newStatus,
                                external_status: result.order?.status || newStatus,
                                external_message: result.message,
                                updated_at: new Date().toISOString(),
                            })
                            .eq("id", order.id)

                        const orderTableStatus = newStatus === "failed" ? "pending" : newStatus
                        let userId: string | null = null

                        if (order.order_type === "bulk" && order.order_id) {
                            const { data } = await supabase
                                .from("orders")
                                .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
                                .eq("id", order.order_id)
                                .select("user_id")
                                .single()
                            userId = data?.user_id ?? null
                        } else if (order.order_type === "api" && (order.api_order_id || order.order_id)) {
                            const { data } = await supabase
                                .from("api_orders")
                                .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
                                .eq("id", order.api_order_id || order.order_id)
                                .select("user_id")
                                .single()
                            userId = data?.user_id ?? null
                        } else if (order.order_type === "ussd" && order.order_id) {
                            await supabase
                                .from("ussd_orders")
                                .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
                                .eq("id", order.order_id)
                        } else if (order.order_type === "ussd_shop" && order.order_id) {
                            await supabase
                                .from("ussd_shop_orders")
                                .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
                                .eq("id", order.order_id)
                        } else if (order.shop_order_id) {
                            const { data: shopData } = await supabase
                                .from("shop_orders")
                                .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
                                .eq("id", order.shop_order_id)
                                .select("shop_id")
                                .single()
                            if (shopData?.shop_id) {
                                const { data: owner } = await supabase.from("user_shops").select("user_id").eq("id", shopData.shop_id).single()
                                userId = owner?.user_id ?? null
                            }
                        }

                        if (userId && (newStatus === "completed" || newStatus === "failed")) {
                            const title = newStatus === "completed" ? "Order Delivered Successfully" : "Order Delivery Failed"
                            const body = newStatus === "completed"
                                ? `Your ${order.size_gb ?? ""}GB data order to ${order.recipient_phone ?? "recipient"} has been delivered successfully.`
                                : `Your ${order.size_gb ?? ""}GB data order to ${order.recipient_phone ?? "recipient"} failed. Please contact support.`
                            await supabase.from("notifications").insert({
                                user_id: userId,
                                title,
                                message: body,
                                type: newStatus === "completed" ? "order_completed" : "order_failed",
                                reference_id: order.api_order_id || order.order_id || order.shop_order_id,
                                read: false,
                            })
                            sendPushToUser(userId, { title, body }).catch(() => {})
                        }

                        console.log(`[CRON-BUNDLEPORTAL] ✅ ${order.mtn_order_id}: ${oldStatus} -> ${newStatus}`)
                        synced++
                    }
                } else {
                    console.warn(`[CRON-BUNDLEPORTAL] Failed to get status for ${order.mtn_order_id}:`, result.message)
                    failed++
                }

                results.push({ id: order.id, mtn_order_id: order.mtn_order_id, success: result.success, status: result.status || order.status, message: result.message })

                if (i < pendingOrders.length - 1) await sleep(DELAY_BETWEEN_REQUESTS_MS)
            } catch (err) {
                console.error(`[CRON-BUNDLEPORTAL] Error processing ${order.mtn_order_id}:`, err)
                failed++
            }
        }

        let reversed = 0
        const reversalCandidates = await fetchReversalCandidates(supabase, "bundleportal", BATCH_SIZE)
        for (const cand of reversalCandidates) {
            const chk = await checkMTNOrderStatus((cand as any).mtn_order_id, "bundleportal")
            if (!chk.success || !chk.status) { await sleep(DELAY_BETWEEN_REQUESTS_MS); continue }
            if (isReversal({ trackingStatus: "completed", completedAt: (cand as any).updated_at, providerStatus: chk.status })) {
                await flagReversal(supabase, cand, { status: chk.order?.status ?? "failed", message: chk.message })
                reversed++
            }
            await sleep(DELAY_BETWEEN_REQUESTS_MS)
        }

        return NextResponse.json({ success: true, synced, failed, total: pendingOrders.length, results, reversed })
    } catch (error) {
        console.error("[CRON-BUNDLEPORTAL] Critical error:", error)
        return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/cron/sync-mtn-status/bundleportal/route.ts
git commit -m "feat(bundleportal): add status-sync cron"
```

---

### Task 13: Register the cron in vercel.json

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add the new cron entry**

Find (lines 40-43):

```json
    {
      "path": "/api/cron/sync-mtn-status/spfastit",
      "schedule": "* * * * *"
    },
```

Replace with:

```json
    {
      "path": "/api/cron/sync-mtn-status/spfastit",
      "schedule": "* * * * *"
    },
    {
      "path": "/api/cron/sync-mtn-status/bundleportal",
      "schedule": "* * * * *"
    },
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('vercel.json', 'utf8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "feat(bundleportal): register status-sync cron in vercel.json"
```

---

### Task 14: Balance monitoring

**Files:**
- Modify: `app/api/cron/check-mtn-balance/route.ts`
- Modify: `app/api/admin/fulfillment/mtn-balance/route.ts`

- [ ] **Step 1: Wire into the cron's balance check**

In `app/api/cron/check-mtn-balance/route.ts`, find:

```ts
import { SPFastITProvider } from "@/lib/mtn-providers/spfastit-provider"
import { sendLowBalanceAlert } from "@/lib/mtn-balance-alert"
```

Replace with:

```ts
import { SPFastITProvider } from "@/lib/mtn-providers/spfastit-provider"
import { BundlePortalProvider } from "@/lib/mtn-providers/bundleportal-provider"
import { sendLowBalanceAlert } from "@/lib/mtn-balance-alert"
```

Find:

```ts
    const [sykes, datakazina, xpress, eazyghdata, bisdel, codecraft, agentportalgh, apexprime, spfastit] = await Promise.all([
      new SykesProvider().checkBalance().catch(() => null),
      new DataKazinaProvider().checkBalance().catch(() => null),
      new XpressProvider().checkBalance().catch(() => null),
      new EazyGhDataProvider().checkBalance().catch(() => null),
      new BisdelProvider().checkBalance().catch(() => null),
      new CodeCraftMTNProvider().checkBalance().catch(() => null),
      new AgentPortalGHProvider().checkBalance().catch(() => null),
      new ApexPrimeProvider().checkBalance().catch(() => null),
      new SPFastITProvider().checkBalance().catch(() => null),
    ])
```

Replace with:

```ts
    const [sykes, datakazina, xpress, eazyghdata, bisdel, codecraft, agentportalgh, apexprime, spfastit, bundleportal] = await Promise.all([
      new SykesProvider().checkBalance().catch(() => null),
      new DataKazinaProvider().checkBalance().catch(() => null),
      new XpressProvider().checkBalance().catch(() => null),
      new EazyGhDataProvider().checkBalance().catch(() => null),
      new BisdelProvider().checkBalance().catch(() => null),
      new CodeCraftMTNProvider().checkBalance().catch(() => null),
      new AgentPortalGHProvider().checkBalance().catch(() => null),
      new ApexPrimeProvider().checkBalance().catch(() => null),
      new SPFastITProvider().checkBalance().catch(() => null),
      new BundlePortalProvider().checkBalance().catch(() => null),
    ])
```

Find:

```ts
    const balances = { sykes, datakazina, xpress, eazyghdata, bisdel, codecraft, agentportalgh, apexprime }
    const lows = {
      sykes: sykes !== null && sykes < threshold,
      datakazina: datakazina !== null && datakazina < threshold,
      xpress: xpress !== null && xpress < threshold,
      eazyghdata: eazyghdata !== null && eazyghdata < threshold,
      bisdel: bisdel !== null && bisdel < threshold,
      codecraft: codecraft !== null && codecraft < threshold,
      agentportalgh: agentportalgh !== null && agentportalgh < threshold,
      apexprime: apexprime !== null && apexprime < threshold,
    }
```

Replace with:

```ts
    const balances = { sykes, datakazina, xpress, eazyghdata, bisdel, codecraft, agentportalgh, apexprime, bundleportal }
    const lows = {
      sykes: sykes !== null && sykes < threshold,
      datakazina: datakazina !== null && datakazina < threshold,
      xpress: xpress !== null && xpress < threshold,
      eazyghdata: eazyghdata !== null && eazyghdata < threshold,
      bisdel: bisdel !== null && bisdel < threshold,
      codecraft: codecraft !== null && codecraft < threshold,
      agentportalgh: agentportalgh !== null && agentportalgh < threshold,
      apexprime: apexprime !== null && apexprime < threshold,
      bundleportal: bundleportal !== null && bundleportal < threshold,
    }
```

(Bundle Portal's balance is currency (GHS), the same convention as every provider here except SPFastIT — it uses the shared `threshold` directly, no separate GB-denominated carve-out needed.)

- [ ] **Step 2: Wire into the admin balance route**

In `app/api/admin/fulfillment/mtn-balance/route.ts`, find:

```ts
import { SPFastITProvider } from "@/lib/mtn-providers/spfastit-provider"
import { sendLowBalanceAlert } from "@/lib/mtn-balance-alert"
```

Replace with:

```ts
import { SPFastITProvider } from "@/lib/mtn-providers/spfastit-provider"
import { BundlePortalProvider } from "@/lib/mtn-providers/bundleportal-provider"
import { sendLowBalanceAlert } from "@/lib/mtn-balance-alert"
```

Find:

```ts
    const sykesProvider = new SykesProvider()
    const datakazinaProvider = new DataKazinaProvider()
    const xpressProvider = new XpressProvider()
    const eazyghDataProvider = new EazyGhDataProvider()
    const bisdelProvider = new BisdelProvider()
    const codeCraftProvider = new CodeCraftMTNProvider()
    const agentPortalGHProvider = new AgentPortalGHProvider()
    const apexPrimeProvider = new ApexPrimeProvider()
    const spfastitProvider = new SPFastITProvider()

    const [sykesBalance, datakazinaBalance, xpressBalance, eazyghDataBalance, bisdelBalance, codeCraftBalance, agentportalghBalance, apexprimeBalance, spfastitBalance] = await Promise.all([
      sykesProvider.checkBalance().catch(() => null),
      datakazinaProvider.checkBalance().catch(() => null),
      xpressProvider.checkBalance().catch(() => null),
      eazyghDataProvider.checkBalance().catch(() => null),
      bisdelProvider.checkBalance().catch(() => null),
      codeCraftProvider.checkBalance().catch(() => null),
      agentPortalGHProvider.checkBalance().catch(() => null),
      apexPrimeProvider.checkBalance().catch(() => null),
      spfastitProvider.checkBalance().catch(() => null),
    ])
```

Replace with:

```ts
    const sykesProvider = new SykesProvider()
    const datakazinaProvider = new DataKazinaProvider()
    const xpressProvider = new XpressProvider()
    const eazyghDataProvider = new EazyGhDataProvider()
    const bisdelProvider = new BisdelProvider()
    const codeCraftProvider = new CodeCraftMTNProvider()
    const agentPortalGHProvider = new AgentPortalGHProvider()
    const apexPrimeProvider = new ApexPrimeProvider()
    const spfastitProvider = new SPFastITProvider()
    const bundlePortalProvider = new BundlePortalProvider()

    const [sykesBalance, datakazinaBalance, xpressBalance, eazyghDataBalance, bisdelBalance, codeCraftBalance, agentportalghBalance, apexprimeBalance, spfastitBalance, bundleportalBalance] = await Promise.all([
      sykesProvider.checkBalance().catch(() => null),
      datakazinaProvider.checkBalance().catch(() => null),
      xpressProvider.checkBalance().catch(() => null),
      eazyghDataProvider.checkBalance().catch(() => null),
      bisdelProvider.checkBalance().catch(() => null),
      codeCraftProvider.checkBalance().catch(() => null),
      agentPortalGHProvider.checkBalance().catch(() => null),
      apexPrimeProvider.checkBalance().catch(() => null),
      spfastitProvider.checkBalance().catch(() => null),
      bundlePortalProvider.checkBalance().catch(() => null),
    ])
```

Find:

```ts
    const apexprimeLow = apexprimeBalance !== null && apexprimeBalance < threshold

    const balanceMap = { sykes: sykesBalance, datakazina: datakazinaBalance, xpress: xpressBalance, eazyghdata: eazyghDataBalance, bisdel: bisdelBalance, codecraft: codeCraftBalance, agentportalgh: agentportalghBalance, apexprime: apexprimeBalance }
    const lowMap = { sykes: sykesLow, datakazina: datakazinaLow, xpress: xpressLow, eazyghdata: eazyghDataLow, bisdel: bisdelLow, codecraft: codeCraftLow, agentportalgh: agentportalghLow, apexprime: apexprimeLow }
```

Replace with:

```ts
    const apexprimeLow = apexprimeBalance !== null && apexprimeBalance < threshold
    const bundleportalLow = bundleportalBalance !== null && bundleportalBalance < threshold

    const balanceMap = { sykes: sykesBalance, datakazina: datakazinaBalance, xpress: xpressBalance, eazyghdata: eazyghDataBalance, bisdel: bisdelBalance, codecraft: codeCraftBalance, agentportalgh: agentportalghBalance, apexprime: apexprimeBalance, bundleportal: bundleportalBalance }
    const lowMap = { sykes: sykesLow, datakazina: datakazinaLow, xpress: xpressLow, eazyghdata: eazyghDataLow, bisdel: bisdelLow, codecraft: codeCraftLow, agentportalgh: agentportalghLow, apexprime: apexprimeLow, bundleportal: bundleportalLow }
```

Find:

```ts
        apexprime: {
          balance: apexprimeBalance,
          currency: "GHS",
          is_low: apexprimeLow,
          is_active: activeProvider.name === "apexprime",
          alert: apexprimeLow && apexprimeBalance !== null ? `Apex Prime balance is below threshold of ₵${threshold}` : null,
        },
      },
```

Replace with:

```ts
        apexprime: {
          balance: apexprimeBalance,
          currency: "GHS",
          is_low: apexprimeLow,
          is_active: activeProvider.name === "apexprime",
          alert: apexprimeLow && apexprimeBalance !== null ? `Apex Prime balance is below threshold of ₵${threshold}` : null,
        },
        bundleportal: {
          balance: bundleportalBalance,
          currency: "GHS",
          is_low: bundleportalLow,
          is_active: activeProvider.name === "bundleportal",
          alert: bundleportalLow && bundleportalBalance !== null ? `Bundle Portal balance is below threshold of ₵${threshold}` : null,
        },
      },
```

Also find:

```ts
    if (sykesLow || datakazinaLow || xpressLow || eazyghDataLow || bisdelLow || codeCraftLow || agentportalghLow || apexprimeLow) {
```

Replace with:

```ts
    if (sykesLow || datakazinaLow || xpressLow || eazyghDataLow || bisdelLow || codeCraftLow || agentportalghLow || apexprimeLow || bundleportalLow) {
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/check-mtn-balance/route.ts app/api/admin/fulfillment/mtn-balance/route.ts
git commit -m "feat(bundleportal): add to balance monitoring (cron + admin route)"
```

---

### Task 15: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Full type-check**

Run: `npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all tests pass, including every new test file from Tasks 2 and 7. Independently confirm the pass count against the file list — do not trust a summary claim without seeing the actual numbers (this codebase has a documented history of a subagent fabricating a "systemic test failure" that a direct re-run disproved; always re-run and read the real output).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean production build — this is what would catch, for example, a route.ts file accidentally exporting something other than an HTTP method handler (the exact reason `bundleportal-webhook-processor.ts`'s logic lives outside `route.ts` in Task 7).

- [ ] **Step 4: Structural exclusion / inclusion sanity check**

By reading the code (not by trying to click things into existence):
- Confirm `"bundleportal"` appears in `PROVIDER_LABELS` and is therefore selectable as Primary MTN Provider, in the Retry Sequence add-list, and in the Disabled Providers toggle grid on `/admin/settings/mtn`.
- Confirm `"bundleportal"` appears in all three per-network selector cards (Telecel, AT-iShare, AT-BigTime) via `baseProviders`.
- Confirm `"bundleportal"` appears in `getProviderOptionsForNetwork`'s output for MTN, Telecel, AT-iShare, and AT-BigTime.
- Confirm `WHITELIST_REGISTRY` includes a `"bundleportal"` entry gated by `BUNDLEPORTAL_API_KEY`.

- [ ] **Step 5: Manual live verification (once `BUNDLEPORTAL_API_KEY` is set in Vercel)**

- Place one real order on each of the three MTN routes (`mtn`, `mtn_2`, `mtn_3` via the settings tab's route selector), one Telecel order, one AirtelTigo order, and one BigTime order, via the admin per-network provider selectors and the "Fulfill as..." dropdown.
- Register the webhook (`POST /api/admin/bundleportal { action: "register-webhook", webhookUrl: "https://<domain>/api/webhooks/mtn/bundleportal" }`), copy the one-time `webhook_secret` from the response into `BUNDLEPORTAL_WEBHOOK_SECRET` in Vercel, and confirm a subsequent order's webhook delivery resolves the tracking row before the 1-minute cron would have.
- Deliberately re-trigger admin fulfillment on the same order (forcing a duplicate `place_order` call with the same `order_id`) and confirm it returns the original order rather than double-charging the wallet.
- Confirm `check_balance` renders correctly on the Bundle Portal settings tab and in `/admin/fulfillment/mtn-balance`.

- [ ] **Step 6: Update memory**

Once live and verified, add a `project-bundleportal-provider.md` memory entry summarizing: full-member 10th MTN/Telecel/AirtelTigo/BigTime provider, 3-way admin-selectable MTN route, BigTime undocumented-but-confirmed, the `isBigTime` field addition to the shared `MTNOrderRequest` type, and that it's the intended long-term CodeCraft replacement (per [[project-non-mtn-provider-routing]] and [[project-mtn-provider-deactivation]] context). Airtime integration remains a separate, not-yet-started follow-up.

---

