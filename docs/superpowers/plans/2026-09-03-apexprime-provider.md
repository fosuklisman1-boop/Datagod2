# Apex Prime Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Apex Prime as an 8th `MTNProviderName` — MTN/Telecel/AT-iShare capable (not AT-BigTime), with an admin-selectable per-network toggle between its two fulfillment mechanisms (GroupShare vs Store), webhook + polling status sync, and its `/verify-number` endpoint wired into the existing multi-provider whitelist system.

**Architecture:** One new provider class (`lib/mtn-providers/apexprime-provider.ts`) implementing the standard `MTNProvider` interface, following `agentportalgh-provider.ts`'s shape exactly. Order creation branches internally between two Apex Prime API call sequences based on a per-network `admin_settings` toggle, read fresh on every call. Status correlation uses a `bundle:`/`store:` prefix embedded in the stored tracking id (mirroring this codebase's existing `FAILED_INIT_` prefix convention) since Store orders never receive a numeric `order_id` from Apex Prime at all.

**Tech Stack:** Next.js 15 App Router API routes, TypeScript, Supabase (service-role client), Vitest.

## Global Constraints

- Apex Prime is excluded from AT-BigTime everywhere — never added to `at_bigtime_provider_selection`'s capable-provider list, never offered on the AT-BigTime admin UI card. Their API never mentions BigTime anywhere (wallet balances, send-bundle, store products).
- The GroupShare/Store fulfillment-path choice is a **per-network** setting (`apexprime_mtn_fulfillment_path`, `apexprime_telecel_fulfillment_path`, `apexprime_ishare_fulfillment_path`), each `{ path: "groupshare" | "store" }`, default `"groupshare"` when unset.
- The Store path's product-to-GB mapping is a **live lookup** against `GET /store-products` at order time — no catalog sync/cache job.
- MTN AFA registration (`/afa-registration`) is explicitly out of scope — do not build it.
- Base URL `https://apexprime.club/api/v1`, auth via `Authorization: Bearer <APEXPRIME_API_KEY>` header.
- Their webhook is confirmed unsigned — authenticate incoming webhooks via a shared secret (`APEXPRIME_WEBHOOK_SECRET`) in a `?token=` query param or `x-webhook-token` header, constant-time compared, fail-open (log INSECURE) if the env var is unset — exactly matching `app/api/webhooks/mtn/datakazina/route.ts`'s existing pattern.

---

### Task 1: Apex Prime provider class

**Files:**
- Create: `lib/mtn-providers/apexprime-provider.ts`
- Test: `lib/mtn-providers/apexprime-provider.test.ts`

**Interfaces:**
- Consumes: `MTNProvider`, `MTNOrderRequest` (`{recipient_phone: string, network: "MTN"|"Telecel"|"AirtelTigo", size_gb: number, traceId?: string, client_ref?: string}`), `MTNOrderResponse` (`{success: boolean, order_id?: number|string, message: string, traceId?: string, error_type?: string}`), `MTNOrderStatusResponse` (`{success: boolean, status?: "pending"|"processing"|"completed"|"failed", message: string, order?: any}`) — all from `./types`, unchanged by this task. `normalizePhoneNumber`, `isValidPhoneFormat`, `validatePhoneNetworkMatch` from `@/lib/mtn-fulfillment`, unchanged. `supabaseAdmin` from `@/lib/supabase`, unchanged.
- Produces: class `ApexPrimeProvider implements MTNProvider` with `name = "apexprime"`; exported pure helpers `mapNetworkToApex`, `normalizeApexStatus`, `findMatchingProduct`, `parseTrackingId`; exported constant `FULFILLMENT_PATH_KEYS: Record<"MTN"|"Telecel"|"AirtelTigo", string>`. Task 2 imports the class for factory wiring. Task 5 imports the class for the whitelist registry entry (calls `.verifyNumber()`). Task 6 imports the class and `FULFILLMENT_PATH_KEYS` for the admin API route.

- [ ] **Step 1: Write the failing tests for the pure helpers**

Create `lib/mtn-providers/apexprime-provider.test.ts`:

```ts
import { mapNetworkToApex, normalizeApexStatus, findMatchingProduct, parseTrackingId } from "@/lib/mtn-providers/apexprime-provider"

describe("mapNetworkToApex", () => {
  it("maps MTN to MTN", () => expect(mapNetworkToApex("MTN")).toBe("MTN"))
  it("maps Telecel to Telecel", () => expect(mapNetworkToApex("Telecel")).toBe("Telecel"))
  it("maps AirtelTigo to Ishare", () => expect(mapNetworkToApex("AirtelTigo")).toBe("Ishare"))
})

describe("normalizeApexStatus", () => {
  it("maps completed variants to completed", () => {
    expect(normalizeApexStatus("completed")).toBe("completed")
    expect(normalizeApexStatus("Success")).toBe("completed")
    expect(normalizeApexStatus("SUCCESSFUL")).toBe("completed")
  })
  it("maps failure variants to failed", () => {
    expect(normalizeApexStatus("failed")).toBe("failed")
    expect(normalizeApexStatus("Rejected")).toBe("failed")
    expect(normalizeApexStatus("cancelled")).toBe("failed")
    expect(normalizeApexStatus("refunded")).toBe("failed")
  })
  it("maps pending variants to pending", () => {
    expect(normalizeApexStatus("pending")).toBe("pending")
    expect(normalizeApexStatus("Waiting")).toBe("pending")
  })
  it("defaults unknown/blank to processing", () => {
    expect(normalizeApexStatus("something-else")).toBe("processing")
    expect(normalizeApexStatus("")).toBe("processing")
  })
})

describe("findMatchingProduct", () => {
  const products = [
    { product_id: 14, type: "data", network: "MTN", gb_amount: 1 },
    { product_id: 15, type: "data", network: "MTN", gb_amount: 5 },
    { product_id: 16, type: "data", network: "Telecel", gb_amount: 5 },
    { product_id: "wassce", type: "digital" },
  ]
  it("matches by exact network and GB amount", () => {
    expect(findMatchingProduct(products, "MTN", 5)).toBe(15)
  })
  it("is case-insensitive on network", () => {
    expect(findMatchingProduct(products, "mtn", 1)).toBe(14)
  })
  it("does not match a different network with the same GB amount", () => {
    expect(findMatchingProduct(products, "Ishare", 5)).toBeUndefined()
  })
  it("ignores non-data products", () => {
    expect(findMatchingProduct(products, "wassce" as any, 1)).toBeUndefined()
  })
  it("returns undefined when no GB amount matches", () => {
    expect(findMatchingProduct(products, "MTN", 100)).toBeUndefined()
  })
})

describe("parseTrackingId", () => {
  it("parses a bundle-prefixed id", () => {
    expect(parseTrackingId("bundle:10839")).toEqual({ kind: "bundle", rawId: "10839" })
  })
  it("parses a store-prefixed id", () => {
    expect(parseTrackingId("store:abc-123-uuid")).toEqual({ kind: "store", rawId: "abc-123-uuid" })
  })
  it("returns null for an unprefixed id", () => {
    expect(parseTrackingId("10839")).toBeNull()
  })
  it("returns null for an unrecognized prefix", () => {
    expect(parseTrackingId("other:10839")).toBeNull()
  })
  it("returns null for an empty raw id after the prefix", () => {
    expect(parseTrackingId("bundle:")).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/mtn-providers/apexprime-provider.test.ts`
Expected: FAIL — `lib/mtn-providers/apexprime-provider.ts` does not exist yet.

- [ ] **Step 3: Implement `lib/mtn-providers/apexprime-provider.ts`**

```ts
import crypto from "crypto"
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat, validatePhoneNetworkMatch } from "@/lib/mtn-fulfillment"
import { supabaseAdmin as supabase } from "@/lib/supabase"

const BASE_URL = process.env.APEXPRIME_BASE_URL ?? "https://apexprime.club/api/v1"
const TIMEOUT = 30_000

function apiKey(): string {
  return process.env.APEXPRIME_API_KEY ?? ""
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT),
  })
}

/** admin_settings keys for the per-network GroupShare/Store fulfillment-path toggle. */
export const FULFILLMENT_PATH_KEYS: Record<"MTN" | "Telecel" | "AirtelTigo", string> = {
  MTN: "apexprime_mtn_fulfillment_path",
  Telecel: "apexprime_telecel_fulfillment_path",
  AirtelTigo: "apexprime_ishare_fulfillment_path",
}

async function getFulfillmentPath(network: "MTN" | "Telecel" | "AirtelTigo"): Promise<"groupshare" | "store"> {
  try {
    const { data } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", FULFILLMENT_PATH_KEYS[network])
      .maybeSingle()
    return data?.value?.path === "store" ? "store" : "groupshare"
  } catch {
    return "groupshare"
  }
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** Map our internal network name to Apex Prime's own network string. */
export function mapNetworkToApex(network: "MTN" | "Telecel" | "AirtelTigo"): "MTN" | "Telecel" | "Ishare" {
  if (network === "Telecel") return "Telecel"
  if (network === "AirtelTigo") return "Ishare"
  return "MTN"
}

/** Map Apex Prime's status string to our canonical 4-state set. */
export function normalizeApexStatus(raw: string): "pending" | "processing" | "completed" | "failed" {
  const s = (raw ?? "").toLowerCase().trim()
  if (s === "completed" || s === "success" || s === "successful") return "completed"
  if (s.includes("fail") || s.includes("reject") || s.includes("cancel") || s.includes("refund")) return "failed"
  if (s === "pending" || s === "waiting") return "pending"
  return "processing"
}

/**
 * Find the store product_id matching a network + exact GB amount from
 * GET /store-products' data_products list. Data products only — digital
 * products (no network/gb_amount fields) are never matched. No nearest-size
 * guessing: an exact match or nothing.
 */
export function findMatchingProduct(
  products: Array<{ product_id: string | number; type?: string; network?: string; gb_amount?: number }>,
  network: string,
  sizeGb: number
): string | number | undefined {
  const match = products.find(p =>
    p.type === "data" &&
    typeof p.network === "string" && p.network.toLowerCase() === network.toLowerCase() &&
    typeof p.gb_amount === "number" && p.gb_amount === sizeGb
  )
  return match?.product_id
}

/**
 * Parse a stored tracking id of the form "bundle:<id>" or "store:<id>" back
 * into its fulfillment-path kind and raw id. Required because Apex Prime's
 * /status endpoint needs to know which `type` to query, and checkOrderStatus()
 * only ever receives the stored id string — no other context is available.
 */
export function parseTrackingId(id: string): { kind: "bundle" | "store"; rawId: string } | null {
  const idx = id.indexOf(":")
  if (idx === -1) return null
  const kind = id.slice(0, idx)
  const rawId = id.slice(idx + 1)
  if ((kind === "bundle" || kind === "store") && rawId.length > 0) return { kind, rawId }
  return null
}

// ── Provider class ───────────────────────────────────────────────────────────

export class ApexPrimeProvider implements MTNProvider {
  name = "apexprime"

  async createOrder(request: MTNOrderRequest): Promise<MTNOrderResponse> {
    if (!isValidPhoneFormat(request.recipient_phone)) {
      return { success: false, message: `Invalid phone: ${request.recipient_phone}`, error_type: "VALIDATION" }
    }
    if (!validatePhoneNetworkMatch(request.recipient_phone, request.network)) {
      return { success: false, message: `Phone does not match ${request.network}`, error_type: "VALIDATION" }
    }

    const phone = normalizePhoneNumber(request.recipient_phone)
    const reference = request.client_ref ?? crypto.randomUUID()
    const apexNetwork = mapNetworkToApex(request.network)
    const path = await getFulfillmentPath(request.network)

    return path === "store"
      ? this.createViaStore(phone, apexNetwork, request.size_gb, reference)
      : this.createViaGroupShare(phone, apexNetwork, request.size_gb, reference)
  }

  private async createViaGroupShare(phone: string, apexNetwork: string, sizeGb: number, reference: string): Promise<MTNOrderResponse> {
    let res: Response
    try {
      res = await apiFetch("/send-bundle", {
        method: "POST",
        body: JSON.stringify({ network: apexNetwork, recipient: phone, amount: sizeGb, reference }),
      })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error", error_type: "NETWORK_ERROR" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)`, error_type: "API_ERROR" }
    }

    if (!res.ok || json.success !== true) {
      return { success: false, message: json?.message ?? `API error ${res.status}`, error_type: "API_ERROR" }
    }

    return { success: true, order_id: `bundle:${json.order_id}`, message: json.message ?? "Bundle order initiated" }
  }

  private async createViaStore(phone: string, apexNetwork: string, sizeGb: number, reference: string): Promise<MTNOrderResponse> {
    let productsRes: Response
    try {
      productsRes = await apiFetch("/store-products", { method: "GET" })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error", error_type: "NETWORK_ERROR" }
    }

    let productsJson: any
    try { productsJson = await productsRes.json() } catch {
      return { success: false, message: `HTTP ${productsRes.status} (non-JSON response)`, error_type: "API_ERROR" }
    }

    if (!productsRes.ok || productsJson.success !== true) {
      return { success: false, message: productsJson?.message ?? `Store products API error ${productsRes.status}`, error_type: "API_ERROR" }
    }

    const dataProducts: any[] = productsJson.data_products ?? []
    const productId = findMatchingProduct(dataProducts, apexNetwork, sizeGb)
    if (productId === undefined) {
      return { success: false, message: `No matching Apex Prime store product for ${apexNetwork} ${sizeGb}GB`, error_type: "VALIDATION" }
    }

    let res: Response
    try {
      res = await apiFetch("/store-order", {
        method: "POST",
        body: JSON.stringify({ product_id: productId, recipient: phone, reference }),
      })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error", error_type: "NETWORK_ERROR" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)`, error_type: "API_ERROR" }
    }

    if (!res.ok || json.success !== true) {
      return { success: false, message: json?.message ?? `API error ${res.status}`, error_type: "API_ERROR" }
    }

    // Store orders never receive an order_id from Apex Prime — our own
    // reference (already a UUID) is the only stable identifier available,
    // which is also what /status expects for type: "store".
    return { success: true, order_id: `store:${reference}`, message: json.message ?? "Store order placed" }
  }

  async checkOrderStatus(orderId: string | number): Promise<MTNOrderStatusResponse> {
    const id = String(orderId)

    if (id.startsWith("FAILED_INIT_")) {
      return { success: true, status: "failed", message: "Order was never submitted to Apex Prime (local failure)" }
    }

    const parsed = parseTrackingId(id)
    if (!parsed) {
      return { success: false, message: `Unrecognized Apex Prime tracking id format: ${id}` }
    }

    let res: Response
    try {
      res = await apiFetch("/status", {
        method: "POST",
        body: JSON.stringify({ type: parsed.kind, order_id: parsed.rawId }),
      })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)` }
    }

    if (!res.ok || json.success !== true) {
      return { success: false, message: json?.message ?? `API error ${res.status}` }
    }

    return { success: true, status: normalizeApexStatus(json.status), message: json.message ?? "Status retrieved", order: json }
  }

  async checkBalance(): Promise<number | null> {
    try {
      const res = await apiFetch("/wallet", { method: "POST" })
      if (!res.ok) return null
      const json = await res.json()
      const raw = json?.balances?.Main_Wallet?.amount
      return typeof raw === "number" ? raw : null
    } catch {
      return null
    }
  }

  // ── Admin / auxiliary methods ──────────────────────────────────────────────
  // Not part of MTNProvider — used by the admin API route (Task 6).

  async getWalletSummary(): Promise<any> {
    const res = await apiFetch("/wallet", { method: "POST" })
    return res.ok ? res.json() : { error: `HTTP ${res.status}` }
  }

  async getTransactions(): Promise<any> {
    const res = await apiFetch("/transactions", { method: "POST" })
    return res.ok ? res.json() : { error: `HTTP ${res.status}` }
  }

  async verifyNumber(phone: string, network: string = "MTN"): Promise<any> {
    const res = await apiFetch("/verify-number", {
      method: "POST",
      body: JSON.stringify({ phone_number: phone, network }),
    })
    return res.json()
  }
}

export default ApexPrimeProvider
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/mtn-providers/apexprime-provider.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `apexprime-provider.ts`. (`implements MTNProvider` will NOT yet fail even though `"apexprime"` isn't in `MTNProviderName` yet — `MTNProvider.name` is typed as plain `string`, not `MTNProviderName`, confirmed in `lib/mtn-providers/types.ts`.)

- [ ] **Step 6: Commit**

```bash
git add lib/mtn-providers/apexprime-provider.ts lib/mtn-providers/apexprime-provider.test.ts
git commit -m "feat(apexprime): add Apex Prime provider — dual GroupShare/Store fulfillment paths"
```

---

### Task 2: Factory + type wiring

**Files:**
- Modify: `lib/mtn-providers/types.ts`
- Modify: `lib/mtn-providers/factory.ts`
- Test: `lib/mtn-providers/factory.test.ts`

**Interfaces:**
- Consumes: `ApexPrimeProvider` class from `./apexprime-provider` (Task 1).
- Produces: `MTNProviderName` now includes `"apexprime"`. `NON_MTN_CAPABLE.telecel_provider_selection` and `.at_ishare_provider_selection` include `"apexprime"`; `.at_bigtime_provider_selection` does NOT. `getProviderByName("apexprime")` and `getMTNProvider()` (when selected) both return an `ApexPrimeProvider` instance. Later tasks (3, 4, 5, 6, 7, 8) rely on `"apexprime"` being a valid `MTNProviderName` and on `getProviderByName`/`getMTNProvider` handling it.

- [ ] **Step 1: Update `lib/mtn-providers/types.ts`**

Change:
```ts
export type MTNProviderName = "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft" | "agentportalgh"
```
to:
```ts
export type MTNProviderName = "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft" | "agentportalgh" | "apexprime"
```

- [ ] **Step 2: Write the failing test**

Create `lib/mtn-providers/factory.test.ts` if it does not already exist, or add to it if it does (check first — a previous plan may have created this file with `NON_MTN_CAPABLE` tests already; if so, add these as new `it()` blocks inside the existing `describe("NON_MTN_CAPABLE", ...)` block rather than duplicating the describe):

```ts
import { NON_MTN_CAPABLE } from "./factory"

describe("NON_MTN_CAPABLE", () => {
  it("includes apexprime for Telecel", () => {
    expect(NON_MTN_CAPABLE.telecel_provider_selection).toContain("apexprime")
  })

  it("includes apexprime for AT-iShare", () => {
    expect(NON_MTN_CAPABLE.at_ishare_provider_selection).toContain("apexprime")
  })

  it("EXCLUDES apexprime for AT-BigTime", () => {
    expect(NON_MTN_CAPABLE.at_bigtime_provider_selection).not.toContain("apexprime")
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run lib/mtn-providers/factory.test.ts`
Expected: FAIL — `apexprime` not yet present in either capable list.

- [ ] **Step 4: Implement the factory changes**

In `lib/mtn-providers/factory.ts`:

1. Add the import alongside the other provider imports:
```ts
import { ApexPrimeProvider } from "./apexprime-provider"
```

2. In `getSelectedProvider()`, extend the validation check:
```ts
        if (provider === "sykes" || provider === "datakazina" || provider === "xpress" || provider === "eazyghdata" || provider === "bisdel" || provider === "codecraft" || provider === "agentportalgh" || provider === "apexprime") {
            return provider
        }
```

3. Extend `VALID_PROVIDERS`:
```ts
const VALID_PROVIDERS: MTNProviderName[] = ["sykes", "datakazina", "xpress", "eazyghdata", "bisdel", "codecraft", "agentportalgh", "apexprime"]
```

4. In `getMTNProvider()`'s switch, add a case:
```ts
    switch (providerName) {
        case "agentportalgh":
            return new AgentPortalGHProvider()
        case "apexprime":
            return new ApexPrimeProvider()
        case "bisdel":
            return new BisdelProvider()
```
(keep the rest of the switch as-is — only inserting the new case, alphabetical-ish ordering matching the existing style is not required, just insert it near `agentportalgh`)

5. Extend `NON_MTN_CAPABLE`:
```ts
export const NON_MTN_CAPABLE: Record<string, MTNProviderName[]> = {
    telecel_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"],
    at_ishare_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"],
    at_bigtime_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft"],
}
```

6. In `getProviderByName()`'s switch, add a case:
```ts
export function getProviderByName(name: MTNProviderName): MTNProvider {
    switch (name) {
        case "agentportalgh":
            return new AgentPortalGHProvider()
        case "apexprime":
            return new ApexPrimeProvider()
        case "bisdel":
            return new BisdelProvider()
```
(keep the rest unchanged)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/mtn-providers/factory.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors. `getProviderByName()`'s switch has no `default` case and no `return` after the switch, so TypeScript enforces exhaustiveness over `MTNProviderName` there automatically — if the `"apexprime"` case were missing, this would fail to compile with "not all code paths return a value." (`getMTNProvider()`'s switch does have a `default` case, so it does not get this same automatic check — its `"apexprime"` case was added by hand in this step and is not compiler-enforced; double-check it's present.)

- [ ] **Step 7: Commit**

```bash
git add lib/mtn-providers/types.ts lib/mtn-providers/factory.ts lib/mtn-providers/factory.test.ts
git commit -m "feat(mtn-factory): register apexprime as an 8th MTN provider (Telecel/AT-iShare capable, not AT-BigTime)"
```

---

### Task 3: Webhook route

**Files:**
- Create: `app/api/webhooks/mtn/apexprime/route.ts`

**Interfaces:**
- Consumes: `mtn_fulfillment_tracking` table (polymorphic `order_id`/`shop_order_id`/`api_order_id` columns, `provider`, `status`, `mtn_order_id`, `recipient_phone`, `size_gb`, `order_type`, `updated_at`). `isReversal`/`flagReversal` from `@/lib/mtn-reversal`. `normalizeApexStatus` from `@/lib/mtn-providers/apexprime-provider` (Task 1).
- Produces: nothing consumed by later tasks — this is a leaf endpoint. `APEXPRIME_WEBHOOK_SECRET` env var (documented here, must be set in Vercel + registered as part of Apex Prime's `callback_url` for this to be authenticated in production).

- [ ] **Step 1: Implement `app/api/webhooks/mtn/apexprime/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"
import { normalizeApexStatus } from "@/lib/mtn-providers/apexprime-provider"
import { isReversal, flagReversal } from "@/lib/mtn-reversal"
import { sendPushToUser } from "@/lib/push-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

interface ApexPrimeWebhookPayload {
  event: string
  order_id: number | string
  client_code?: string
  client_reference?: string
  network?: string
  recipient?: string
  gb_amount?: number
  channel?: string
  status: string
  message?: string
  timestamp?: string
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return crypto.timingSafeEqual(aBuf, bBuf)
}

/**
 * POST /api/webhooks/mtn/apexprime
 *
 * Apex Prime's webhooks are unsigned — authenticated via a shared secret we
 * embed in the callback_url we register with them (?token=) or an
 * x-webhook-token header, same pattern as Datakazina's webhook route.
 */
export async function POST(request: NextRequest) {
  try {
    const webhookSecret = process.env.APEXPRIME_WEBHOOK_SECRET
    const bodyText = await request.text()

    if (webhookSecret) {
      const providedToken =
        request.nextUrl.searchParams.get("token") ||
        request.headers.get("x-webhook-token") ||
        ""
      if (!timingSafeEqualStr(providedToken, webhookSecret)) {
        console.warn("[Webhook.ApexPrime] Invalid or missing webhook token")
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      }
    } else {
      console.warn("[Webhook.ApexPrime] APEXPRIME_WEBHOOK_SECRET not configured, skipping auth (INSECURE)")
    }

    let payload: ApexPrimeWebhookPayload
    try {
      payload = JSON.parse(bodyText)
    } catch {
      console.warn("[Webhook.ApexPrime] Failed to parse JSON body")
      return NextResponse.json({ success: true, message: "Non-JSON ping received" })
    }

    if (payload.event !== "order_status_update") {
      return NextResponse.json({ success: true, message: "Ignored non-order event" })
    }

    const clientReference = payload.client_reference
    if (!clientReference) {
      console.warn("[Webhook.ApexPrime] Missing client_reference in payload", payload)
    }

    // Primary correlation: client_reference is always our own internal order
    // UUID (the client_ref we sent as `reference`), for both GroupShare and
    // Store orders — Store orders never receive an order_id from Apex Prime
    // at all, so anchoring on order_id would silently fail for every one of
    // them.
    let tracking: any = null
    if (clientReference) {
      const { data } = await supabase
        .from("mtn_fulfillment_tracking")
        .select("id, order_type, order_id, shop_order_id, api_order_id, recipient_phone, size_gb, status, updated_at")
        .eq("provider", "apexprime")
        .or(`order_id.eq.${clientReference},shop_order_id.eq.${clientReference},api_order_id.eq.${clientReference}`)
        .maybeSingle()
      tracking = data
    }

    // Fallback: match by network + gb_amount + recipient among recent
    // pending/processing apexprime rows. Should never fire per their docs —
    // logged loudly if it does, so a real divergence is noticed immediately.
    if (!tracking && payload.network && payload.gb_amount && payload.recipient) {
      console.warn("[Webhook.ApexPrime] client_reference lookup failed, trying fallback match", { clientReference, payload })
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { data } = await supabase
        .from("mtn_fulfillment_tracking")
        .select("id, order_type, order_id, shop_order_id, api_order_id, recipient_phone, size_gb, status, updated_at")
        .eq("provider", "apexprime")
        .eq("recipient_phone", payload.recipient)
        .eq("size_gb", payload.gb_amount)
        .in("status", ["pending", "processing"])
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      tracking = data
    }

    if (!tracking) {
      console.warn("[Webhook.ApexPrime] No matching tracking row found", { clientReference, payload })
      return NextResponse.json({ success: true, message: "Webhook received, no matching order" })
    }

    const newStatus = normalizeApexStatus(payload.status)

    // Reversal safeguard: a webhook reporting failed for an order we already
    // marked completed (within the reversal window) is a provider reversal.
    if (newStatus === "failed" && isReversal({ trackingStatus: tracking.status, completedAt: tracking.updated_at, providerStatus: "failed" })) {
      await flagReversal(supabase, tracking, { status: payload.status, message: payload.message ?? payload.status })
      console.warn("[Webhook.ApexPrime] Reversal flagged (completed→failed)", { trackingId: tracking.id })
      return NextResponse.json({ success: true, message: "Reversal flagged" })
    }

    // No-op for non-terminal statuses (webhook retries/duplicates are safe).
    if (newStatus !== "completed" && newStatus !== "failed") {
      return NextResponse.json({ success: true, message: "Non-terminal status, no action" })
    }

    await supabase
      .from("mtn_fulfillment_tracking")
      .update({
        status: newStatus,
        external_status: payload.status,
        external_message: payload.message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", tracking.id)

    const orderTableStatus = newStatus === "failed" ? "pending" : newStatus
    let userId: string | null = null

    if (tracking.order_type === "bulk" && tracking.order_id) {
      const { data: o } = await supabase
        .from("orders")
        .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
        .eq("id", tracking.order_id)
        .select("user_id")
        .single()
      userId = o?.user_id ?? null
    } else if (tracking.order_type === "api" && (tracking.api_order_id || tracking.order_id)) {
      const { data: o } = await supabase
        .from("api_orders")
        .update({ status: orderTableStatus, updated_at: new Date().toISOString() })
        .eq("id", tracking.api_order_id || tracking.order_id)
        .select("user_id")
        .single()
      userId = o?.user_id ?? null
    } else if (tracking.order_type === "ussd" && tracking.order_id) {
      await supabase
        .from("ussd_orders")
        .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
        .eq("id", tracking.order_id)
    } else if (tracking.order_type === "ussd_shop" && tracking.order_id) {
      await supabase
        .from("ussd_shop_orders")
        .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
        .eq("id", tracking.order_id)
    } else if (tracking.shop_order_id) {
      const { data: shopData } = await supabase
        .from("shop_orders")
        .update({ order_status: orderTableStatus, updated_at: new Date().toISOString() })
        .eq("id", tracking.shop_order_id)
        .select("shop_id")
        .single()
      if (shopData?.shop_id) {
        const { data: shopOwner } = await supabase.from("user_shops").select("user_id").eq("id", shopData.shop_id).single()
        userId = shopOwner?.user_id ?? null
      }
    }

    if (userId && (newStatus === "completed" || newStatus === "failed")) {
      const title = newStatus === "completed" ? "Order Delivered Successfully" : "Order Delivery Failed"
      const body = newStatus === "completed"
        ? `Your ${tracking.size_gb ?? ""}GB data order to ${tracking.recipient_phone ?? "your number"} was delivered.`
        : `Your ${tracking.size_gb ?? ""}GB data order to ${tracking.recipient_phone ?? "your number"} could not be delivered.`
      await supabase.from("notifications").insert({
        user_id: userId,
        title,
        message: body,
        type: newStatus === "completed" ? "order_completed" : "order_failed",
        reference_id: tracking.api_order_id || tracking.order_id || tracking.shop_order_id,
        read: false,
      })
      sendPushToUser(userId, { title, body }).catch(() => {})
    }

    if (newStatus === "failed") {
      const { notifyAdmins, SMSTemplates } = await import("@/lib/sms-service")
      const orderId = tracking.shop_order_id || tracking.order_id || tracking.api_order_id
      notifyAdmins(
        SMSTemplates.fulfillmentFailed(String(orderId).substring(0, 8), tracking.recipient_phone, payload.network ?? "Unknown", String(tracking.size_gb ?? "?"), payload.message ?? "Failed"),
        "fulfillment_failure",
        String(orderId),
        true
      ).catch(() => {})
    }

    return NextResponse.json({ success: true, message: "Webhook processed" })
  } catch (error) {
    console.error("[Webhook.ApexPrime] Processing failed:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ status: "ok", endpoint: "Apex Prime Webhook Handler", timestamp: new Date().toISOString() })
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing this file.

- [ ] **Step 3: Manual verification**

No test file for this route (matches this codebase's convention — zero `app/**/*.test.ts` files). Re-read the file and confirm: the `client_reference` OR-across-3-columns lookup is scoped to `provider = 'apexprime'`; the fallback only fires when the primary lookup returns nothing; non-terminal statuses are a no-op; the reversal check runs before any state is written.

- [ ] **Step 4: Commit**

```bash
git add app/api/webhooks/mtn/apexprime/route.ts
git commit -m "feat(apexprime): webhook route with shared-secret auth and client_reference-first correlation"
```

---

### Task 4: Polling cron

**Files:**
- Create: `app/api/cron/sync-mtn-status/apexprime/route.ts`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: `checkMTNOrderStatus(mtnOrderId, providerName)` from `@/lib/mtn-fulfillment` (unchanged — already dispatches generically via `getProviderByName(providerName).checkOrderStatus()`, which Task 2 made valid for `"apexprime"`). `fetchReversalCandidates`/`isReversal`/`flagReversal` from `@/lib/mtn-reversal`.
- Produces: nothing consumed by later tasks — leaf cron endpoint.

- [ ] **Step 1: Implement `app/api/cron/sync-mtn-status/apexprime/route.ts`**

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
 * GET /api/cron/sync-mtn-status/apexprime
 *
 * Polling fallback for Apex Prime orders whose webhook was missed. Mirrors
 * the Xpress cron's structure (sequential polling, no batch/retry
 * disambiguation needed — Apex Prime gives a stable id per order via the
 * bundle:/store: prefix, with no documented retry-splits-into-new-order
 * behavior like AgentPortalGH's).
 */
export async function GET(request: NextRequest) {
    const { authorized, errorResponse } = verifyCronAuth(request)
    if (!authorized && errorResponse) return errorResponse

    try {
        console.log("[CRON-APEXPRIME] Starting status sync...")

        const { data: pendingOrders, error: fetchError } = await supabase
            .from("mtn_fulfillment_tracking")
            .select("id, mtn_order_id, status, shop_order_id, order_id, api_order_id, order_type, recipient_phone, size_gb")
            .eq("provider", "apexprime")
            .in("status", ["pending", "processing"])
            .order("created_at", { ascending: true })
            .limit(BATCH_SIZE)

        if (fetchError) {
            console.error("[CRON-APEXPRIME] Error fetching orders:", fetchError)
            return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
        }

        if (!pendingOrders || pendingOrders.length === 0) {
            return NextResponse.json({ success: true, message: "No Apex Prime orders to sync" })
        }

        console.log(`[CRON-APEXPRIME] Found ${pendingOrders.length} orders to sync`)

        let synced = 0
        let failed = 0
        const results = []

        for (let i = 0; i < pendingOrders.length; i++) {
            const order = pendingOrders[i]

            try {
                const result = await checkMTNOrderStatus(order.mtn_order_id, "apexprime")

                if (result.success && result.status) {
                    const oldStatus = order.status
                    const newStatus = result.status
                    const statusPriority: Record<string, number> = { pending: 1, processing: 2, completed: 3, failed: 3, reversed: 4, abandoned: 4 }

                    if ((statusPriority[newStatus] ?? 0) < (statusPriority[oldStatus] ?? 0)) {
                        console.log(`[CRON-APEXPRIME] ⛔ Skipping regression ${oldStatus} -> ${newStatus} for ${order.mtn_order_id}`)
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

                        console.log(`[CRON-APEXPRIME] ✅ ${order.mtn_order_id}: ${oldStatus} -> ${newStatus}`)
                        synced++
                    }
                } else {
                    console.warn(`[CRON-APEXPRIME] Failed to get status for ${order.mtn_order_id}:`, result.message)
                    failed++
                }

                results.push({ id: order.id, mtn_order_id: order.mtn_order_id, success: result.success, status: result.status || order.status, message: result.message })

                if (i < pendingOrders.length - 1) await sleep(DELAY_BETWEEN_REQUESTS_MS)
            } catch (err) {
                console.error(`[CRON-APEXPRIME] Error processing ${order.mtn_order_id}:`, err)
                failed++
            }
        }

        let reversed = 0
        const reversalCandidates = await fetchReversalCandidates(supabase, "apexprime", BATCH_SIZE)
        for (const cand of reversalCandidates) {
            const chk = await checkMTNOrderStatus((cand as any).mtn_order_id, "apexprime")
            if (!chk.success || !chk.status) { await sleep(DELAY_BETWEEN_REQUESTS_MS); continue }
            if (isReversal({ trackingStatus: "completed", completedAt: (cand as any).updated_at, providerStatus: chk.status })) {
                await flagReversal(supabase, cand, { status: chk.order?.status ?? "failed", message: chk.message })
                reversed++
            }
            await sleep(DELAY_BETWEEN_REQUESTS_MS)
        }

        return NextResponse.json({ success: true, synced, failed, total: pendingOrders.length, results, reversed })
    } catch (error) {
        console.error("[CRON-APEXPRIME] Critical error:", error)
        return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
}
```

- [ ] **Step 2: Register the cron in `vercel.json`**

Add a new entry to the `crons` array, alongside the existing `sync-mtn-status/*` entries (same `"* * * * *"` schedule as every other per-provider sync cron):

```json
    {
      "path": "/api/cron/sync-mtn-status/apexprime",
      "schedule": "* * * * *"
    },
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing this file. Confirm `vercel.json` is still valid JSON (no trailing comma issues) by running: `node -e "JSON.parse(require('fs').readFileSync('vercel.json', 'utf8')); console.log('valid')"`

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/sync-mtn-status/apexprime/route.ts vercel.json
git commit -m "feat(apexprime): polling status-sync cron"
```

---

### Task 5: Whitelist registry entry

**Files:**
- Modify: `lib/mtn-providers/provider-whitelist.ts`

**Interfaces:**
- Consumes: `ApexPrimeProvider.verifyNumber(phone, network)` from `./apexprime-provider` (Task 1).
- Produces: nothing consumed by later tasks — this entry is picked up automatically by all 3 existing `WHITELIST_REGISTRY` consumers (`lib/mtn-fulfillment.ts`'s order-time gate, the 24h retry cron, the admin bulk-verify tool), none of which need any change.

- [ ] **Step 1: Add the check functions**

In `lib/mtn-providers/provider-whitelist.ts`, add after `checkAgentPortalGHBatch` (before the `// ── Registry ──` comment):

```ts
async function checkApexPrime(msisdn: string): Promise<WhitelistResult> {
  try {
    const { ApexPrimeProvider } = await import("./apexprime-provider")
    const data = await new ApexPrimeProvider().verifyNumber(msisdn, "MTN")
    return { allowed: data?.is_valid === true, provider: "apexprime", reason: data?.message }
  } catch {
    return { allowed: true, provider: "apexprime" }
  }
}

async function checkApexPrimeBatch(
  msisdns: string[]
): Promise<Array<{ msisdn: string; allowed: boolean; reason?: string }>> {
  // No native batch endpoint on Apex Prime's side — verify sequentially.
  // Their docs describe verify-number as instant, so this is acceptable for
  // the bulk-verify tool's expected volumes.
  const results: Array<{ msisdn: string; allowed: boolean; reason?: string }> = []
  const { ApexPrimeProvider } = await import("./apexprime-provider")
  const provider = new ApexPrimeProvider()
  for (const msisdn of msisdns) {
    try {
      const data = await provider.verifyNumber(msisdn, "MTN")
      results.push({ msisdn, allowed: data?.is_valid === true, reason: data?.message })
    } catch {
      results.push({ msisdn, allowed: true })
    }
  }
  return results
}
```

- [ ] **Step 2: Add the registry entry**

In the `WHITELIST_REGISTRY` array, add after the `agentportalgh` entry (before the `// Add future whitelist providers here ↓` comment):

```ts
  {
    name: "apexprime",
    configured: () => !!process.env.APEXPRIME_API_KEY,
    check: checkApexPrime,
    checkBatch: checkApexPrimeBatch,
  },
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `provider-whitelist.ts`.

- [ ] **Step 4: Run existing whitelist tests**

Run: `npx vitest run lib/mtn-providers/provider-whitelist.test.ts`
Expected: PASS — no existing tests reference the registry's exact length/contents in a way this addition would break (confirm by reading the test file's assertions if any fail; if a test asserts the registry has exactly N entries, update that count).

- [ ] **Step 5: Commit**

```bash
git add lib/mtn-providers/provider-whitelist.ts
git commit -m "feat(apexprime): wire verify-number into WHITELIST_REGISTRY"
```

---

### Task 6: Admin API route

**Files:**
- Create: `app/api/admin/apexprime/route.ts`

**Interfaces:**
- Consumes: `ApexPrimeProvider`, `FULFILLMENT_PATH_KEYS` from `@/lib/mtn-providers/apexprime-provider` (Task 1).
- Produces: `GET /api/admin/apexprime?action=balance|transactions|fulfillment-paths` and `POST /api/admin/apexprime` with `{action: "verify", phone, network?}` or `{action: "set-fulfillment-path", network, path}`. Task 8 (admin UI) calls these exact endpoints/shapes.

- [ ] **Step 1: Implement `app/api/admin/apexprime/route.ts`**

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { ApexPrimeProvider, FULFILLMENT_PATH_KEYS } from "@/lib/mtn-providers/apexprime-provider"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const action = request.nextUrl.searchParams.get("action")
  const provider = new ApexPrimeProvider()

  try {
    if (action === "balance") {
      return NextResponse.json(await provider.getWalletSummary())
    }
    if (action === "transactions") {
      return NextResponse.json(await provider.getTransactions())
    }
    if (action === "fulfillment-paths") {
      const networks = ["MTN", "Telecel", "AirtelTigo"] as const
      const paths: Record<string, string> = {}
      for (const network of networks) {
        const { data } = await supabase
          .from("admin_settings")
          .select("value")
          .eq("key", FULFILLMENT_PATH_KEYS[network])
          .maybeSingle()
        paths[network] = data?.value?.path === "store" ? "store" : "groupshare"
      }
      return NextResponse.json({ success: true, paths })
    }
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (error) {
    console.error("[ADMIN-APEXPRIME] GET error:", error)
    return NextResponse.json({ error: "Apex Prime request failed" }, { status: 502 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const body = await request.json()
    const provider = new ApexPrimeProvider()

    if (body.action === "verify") {
      if (typeof body.phone !== "string" || !body.phone) {
        return NextResponse.json({ error: "phone is required" }, { status: 400 })
      }
      const result = await provider.verifyNumber(body.phone, body.network ?? "MTN")
      return NextResponse.json(result)
    }

    if (body.action === "set-fulfillment-path") {
      const network = body.network as "MTN" | "Telecel" | "AirtelTigo"
      const path = body.path
      if (!FULFILLMENT_PATH_KEYS[network]) {
        return NextResponse.json({ error: "Invalid network. Use: MTN, Telecel, AirtelTigo" }, { status: 400 })
      }
      if (path !== "groupshare" && path !== "store") {
        return NextResponse.json({ error: "Invalid path. Use: groupshare, store" }, { status: 400 })
      }
      const { error } = await supabase
        .from("admin_settings")
        .upsert({ key: FULFILLMENT_PATH_KEYS[network], value: { path }, updated_at: new Date().toISOString() }, { onConflict: "key" })
      if (error) {
        console.error("[ADMIN-APEXPRIME] Failed to save fulfillment path:", error)
        return NextResponse.json({ error: "Failed to save setting" }, { status: 500 })
      }
      return NextResponse.json({ success: true, network, path })
    }

    return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 })
  } catch (error) {
    console.error("[ADMIN-APEXPRIME] POST error:", error)
    return NextResponse.json({ error: "Apex Prime request failed" }, { status: 502 })
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing this file.

- [ ] **Step 3: Manual verification**

No test file for this route (matches codebase convention). Re-read the file and confirm: both handlers call `verifyAdminAccess` before doing anything else; `set-fulfillment-path` validates both `network` and `path` before writing; errors from the upstream Apex Prime API are caught and returned as 502, never crash the route.

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/apexprime/route.ts
git commit -m "feat(apexprime): admin API route for balance/transactions/verify/fulfillment-path"
```

---

### Task 7: Admin UI — per-network provider selector

**Files:**
- Modify: `app/admin/settings/mtn/page.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks directly (this is a pure UI change against the `/api/admin/settings/network-provider` contract — already generic, no changes needed there since it validates against `NETWORK_KEYS`/network-scoped provider lists it derives independently; see Note below).
- Produces: nothing consumed by later tasks.

**Note on the admin API validation route:** `app/api/admin/settings/network-provider/route.ts` (from the earlier AgentPortalGH multi-network plan) has its own `VALID_PROVIDERS_BY_NETWORK` map that must also include `"apexprime"` for `telecel`/`at_ishare` (not `at_bigtime`) — this task includes that file too since it's part of the same "can this network's dropdown accept apexprime" concern.

- [ ] **Step 1: Update `NonMTNProvider` type**

Change line 122:
```ts
  type NonMTNProvider = "datakazina" | "xpress" | "eazyghdata" | "codecraft" | "agentportalgh"
```
to:
```ts
  type NonMTNProvider = "datakazina" | "xpress" | "eazyghdata" | "codecraft" | "agentportalgh" | "apexprime"
```

- [ ] **Step 2: Add Apex Prime to the per-network provider list**

Replace lines 1136-1145:
```ts
              const baseProviders: { value: NonMTNProvider; label: string; sub: string }[] = [
                { value: "codecraft", label: "CodeCraft", sub: "Default AT/Telecel API" },
                { value: "datakazina", label: "DataKazina", sub: "Multi-network" },
                { value: "xpress", label: "Xpress", sub: "Batch-enabled" },
                { value: "eazyghdata", label: "EazyGhData", sub: "Package-based" },
              ]
              const providers: { value: NonMTNProvider; label: string; sub: string }[] =
                netKey === "at_bigtime"
                  ? baseProviders
                  : [...baseProviders, { value: "agentportalgh", label: "AgentPortalGH", sub: "Webhook-first" }]
```
with:
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
              const providers: { value: NonMTNProvider; label: string; sub: string }[] =
                netKey === "at_bigtime" ? baseProviders : nonBigTimeProviders
```

- [ ] **Step 3: Update `app/api/admin/settings/network-provider/route.ts`**

Replace:
```ts
const VALID_PROVIDERS_BY_NETWORK: Record<string, string[]> = {
  telecel: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh"],
  at_ishare: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh"],
  at_bigtime: ["datakazina", "xpress", "eazyghdata", "codecraft"],
}
```
with:
```ts
const VALID_PROVIDERS_BY_NETWORK: Record<string, string[]> = {
  telecel: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"],
  at_ishare: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"],
  at_bigtime: ["datakazina", "xpress", "eazyghdata", "codecraft"],
}
```

(If this file's `VALID_PROVIDERS_BY_NETWORK` doesn't match this exact text — e.g. if it's still the pre-multi-network flat `VALID_PROVIDERS` array — read the file first and apply the equivalent change: add `"apexprime"` everywhere `"agentportalgh"` appears, and nowhere `at_bigtime` appears.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing either file.

- [ ] **Step 5: Manual verification**

Re-read both modified sections and confirm: the Telecel and AT-iShare cards' `providers` array now has 6 entries ending with Apex Prime; the AT-BigTime card's array is untouched (still `baseProviders`, 4 entries); the admin API route rejects `apexprime` for `at_bigtime` with a 400.

- [ ] **Step 6: Commit**

```bash
git add app/admin/settings/mtn/page.tsx app/api/admin/settings/network-provider/route.ts
git commit -m "feat(admin-ui): offer Apex Prime as a Telecel/AT-iShare provider option, not AT-BigTime"
```

---

### Task 8: Admin UI — Apex Prime tab

**Files:**
- Modify: `app/admin/settings/mtn/page.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/apexprime?action=balance|transactions|fulfillment-paths`, `POST /api/admin/apexprime` (Task 6).
- Produces: nothing consumed by later tasks — this is the final task.

- [ ] **Step 1: Extend `MTNProviderName` (local type alias) and `mtnProvider` state**

Change line 59:
```ts
  const [mtnProvider, setMtnProvider] = useState<"sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft" | "agentportalgh">("sykes")
```
to:
```ts
  const [mtnProvider, setMtnProvider] = useState<"sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft" | "agentportalgh" | "apexprime">("sykes")
```

Change line 114:
```ts
  type MTNProviderName = "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft" | "agentportalgh"
```
to:
```ts
  type MTNProviderName = "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft" | "agentportalgh" | "apexprime"
```

- [ ] **Step 2: Add the `PROVIDER_LABELS` entry**

In the `PROVIDER_LABELS` object (around line 883-886):
```ts
  const PROVIDER_LABELS: Record<MTNProviderName, string> = {
    sykes: "Sykes", datakazina: "DataKazina", xpress: "Xpress",
    eazyghdata: "EazyGhData", bisdel: "Bisdel", codecraft: "CodeCraft", agentportalgh: "AgentPortalGH",
  }
```
add `apexprime`:
```ts
  const PROVIDER_LABELS: Record<MTNProviderName, string> = {
    sykes: "Sykes", datakazina: "DataKazina", xpress: "Xpress",
    eazyghdata: "EazyGhData", bisdel: "Bisdel", codecraft: "CodeCraft", agentportalgh: "AgentPortalGH",
    apexprime: "Apex Prime",
  }
```

This single change automatically adds an "Apex Prime" top-level provider tab trigger (line ~900's `.map(p => <TabsTrigger value={p}>...)`), an Apex Prime card to the provider-deactivation grid (line ~989), and Apex Prime as an option in the MTN retry-sequence "add provider" list (line ~1110) — all three iterate `Object.keys(PROVIDER_LABELS)` generically and need no further changes.

- [ ] **Step 3: Add local state for the new tab**

Near the other `apg*` state declarations (search for `apgIdentity` or similar to find the right spot — add alongside, not replacing anything), add:

```ts
  const [apexBalance, setApexBalance] = useState<any>(null)
  const [apexBalanceLoading, setApexBalanceLoading] = useState(false)
  const [apexTransactions, setApexTransactions] = useState<any>(null)
  const [apexFulfillmentPaths, setApexFulfillmentPaths] = useState<Record<string, string>>({ MTN: "groupshare", Telecel: "groupshare", AirtelTigo: "groupshare" })
  const [apexSavingPath, setApexSavingPath] = useState<string | null>(null)
  const [apexVerifyPhone, setApexVerifyPhone] = useState("")
  const [apexVerifyResult, setApexVerifyResult] = useState<any>(null)
  const [apexVerifying, setApexVerifying] = useState(false)
```

- [ ] **Step 4: Add data loading, triggered when the Apex Prime tab is active**

Near the existing `useEffect(() => { if (activeTab === "agentportalgh") { ... } }, [activeTab])` block, add a sibling effect:

```ts
  useEffect(() => {
    if (activeTab !== "apexprime") return
    const loadApexData = async () => {
      setApexBalanceLoading(true)
      try {
        const token = await getToken()
        const [balanceRes, txRes, pathsRes] = await Promise.all([
          fetch("/api/admin/apexprime?action=balance", { headers: { Authorization: `Bearer ${token}` } }),
          fetch("/api/admin/apexprime?action=transactions", { headers: { Authorization: `Bearer ${token}` } }),
          fetch("/api/admin/apexprime?action=fulfillment-paths", { headers: { Authorization: `Bearer ${token}` } }),
        ])
        if (balanceRes.ok) setApexBalance(await balanceRes.json())
        if (txRes.ok) setApexTransactions(await txRes.json())
        if (pathsRes.ok) {
          const data = await pathsRes.json()
          if (data.paths) setApexFulfillmentPaths(data.paths)
        }
      } catch (e) {
        console.error("Error loading Apex Prime data:", e)
      } finally {
        setApexBalanceLoading(false)
      }
    }
    loadApexData()
  }, [activeTab])

  const handleSetApexFulfillmentPath = async (network: "MTN" | "Telecel" | "AirtelTigo", path: "groupshare" | "store") => {
    setApexSavingPath(network)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/apexprime", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "set-fulfillment-path", network, path }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Failed") }
      setApexFulfillmentPaths(prev => ({ ...prev, [network]: path }))
      toast.success(`${network} now fulfills via ${path === "store" ? "Store" : "GroupShare"}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update")
    } finally {
      setApexSavingPath(null)
    }
  }

  const handleApexVerify = async () => {
    if (!apexVerifyPhone) return
    setApexVerifying(true)
    setApexVerifyResult(null)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/apexprime", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "verify", phone: apexVerifyPhone, network: "MTN" }),
      })
      const data = await res.json()
      setApexVerifyResult(data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verification failed")
    } finally {
      setApexVerifying(false)
    }
  }
```

(`getToken` — this file already has a helper for retrieving the current session's access token, used by every other `handle*`/`load*` function in this component via `session.access_token` from `supabase.auth.getSession()`; if there is no standalone `getToken` helper and every other handler inlines `const { data: { session } } = await supabase.auth.getSession(); const token = session?.access_token`, use that exact inline form instead for consistency with the rest of the file — check `handleExport`-style functions elsewhere in this file for the precise established pattern before writing this step.)

- [ ] **Step 5: Add the tab content**

Insert immediately after line 1848's `</TabsContent>` (the closing tag of the `agentportalgh` `TabsContent` block) and before line 1849's `</Tabs>` (the closing tag of the outer provider `Tabs`):

```tsx
          <TabsContent value="apexprime" className="space-y-4 mt-6">
            <ActivationCard providerKey="apexprime" label="Apex Prime" />

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Wallet className="h-5 w-5" />Balances</CardTitle>
              </CardHeader>
              <CardContent>
                {apexBalanceLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
                ) : apexBalance?.balances ? (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {Object.entries(apexBalance.balances).map(([key, val]: [string, any]) => (
                      <div key={key} className="p-3 bg-muted/40 rounded-lg">
                        <p className="text-xs text-muted-foreground uppercase tracking-wide">{key}</p>
                        <p className="text-lg font-semibold text-foreground">{val.amount} {val.unit}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No balance data available.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Zap className="h-5 w-5" />Fulfillment Path</CardTitle>
                <CardDescription>Choose how Apex Prime fulfills orders for each network — GroupShare sends against your pre-purchased GB balance; Store buys a fixed-price catalog item per order.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(["MTN", "Telecel", "AirtelTigo"] as const).map(network => (
                  <div key={network} className="flex items-center justify-between p-3 border rounded-lg">
                    <span className="text-sm font-medium">{network === "AirtelTigo" ? "AT - iShare" : network}</span>
                    <div className="flex gap-2">
                      {(["groupshare", "store"] as const).map(path => (
                        <Button
                          key={path}
                          size="sm"
                          variant={apexFulfillmentPaths[network] === path ? "default" : "outline"}
                          disabled={apexSavingPath === network}
                          onClick={() => handleSetApexFulfillmentPath(network, path)}
                        >
                          {path === "groupshare" ? "GroupShare" : "Store"}
                        </Button>
                      ))}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" />Whitelist Checker</CardTitle>
                <CardDescription>Ad-hoc single-number check against Apex Prime's verify-number endpoint (instant). Bulk checks run from /admin/phone-verification.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input placeholder="0241234567" value={apexVerifyPhone} onChange={e => setApexVerifyPhone(e.target.value)} />
                  <Button onClick={handleApexVerify} disabled={apexVerifying || !apexVerifyPhone}>
                    {apexVerifying ? <Loader2 className="h-4 w-4 animate-spin" /> : "Check"}
                  </Button>
                </div>
                {apexVerifyResult && (
                  <Alert className={apexVerifyResult.is_valid ? "border-success/30 bg-success/10" : "border-destructive/30 bg-destructive/10"}>
                    <AlertDescription className="text-xs">
                      {apexVerifyResult.is_valid
                        ? `Allowed${apexVerifyResult.provider_data?.name ? ` — ${apexVerifyResult.provider_data.name}` : ""}`
                        : apexVerifyResult.message ?? "Not valid / not found"}
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><FileText className="h-5 w-5" />Transactions</CardTitle>
              </CardHeader>
              <CardContent>
                {apexTransactions?.transactions?.length ? (
                  <div className="space-y-2">
                    {apexTransactions.transactions.map((t: any, i: number) => (
                      <div key={i} className="flex justify-between text-sm p-2 border-b">
                        <span>{t.description}</span>
                        <span className={t.type === "credit" ? "text-success" : "text-destructive"}>
                          {t.type === "credit" ? "+" : "-"}{t.amount}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No transactions to show.</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/admin/settings/mtn/page.tsx`. If `getToken` (Step 4) doesn't exist as a standalone helper in this file, confirm the substituted inline `supabase.auth.getSession()` form typechecks correctly against this file's existing `supabase` import.

- [ ] **Step 7: Manual verification**

Re-read the full diff and confirm: the new "Apex Prime" tab trigger appears automatically (via `PROVIDER_LABELS`); clicking it renders the 4 cards; the fulfillment-path buttons show the currently-active path highlighted (`variant="default"`); the verify tool round-trips to `/api/admin/apexprime`.

- [ ] **Step 8: Commit**

```bash
git add app/admin/settings/mtn/page.tsx
git commit -m "feat(admin-ui): Apex Prime tab — balances, fulfillment-path toggles, whitelist checker, transactions"
```

---

## Self-Review Notes

**Spec coverage:** §1 (provider class) → Task 1. §2 (dual-path order creation + per-network toggle) → Task 1 (logic) + Task 6 (admin toggle API). §3 (status checking + webhook) → Task 1 (`checkOrderStatus`) + Task 3 (webhook). §4 (polling cron) → Task 4. §5 (verify-number → whitelist registry) → Task 5. §6/§7 (admin UI) → Tasks 6, 7, 8. All spec sections covered.

**Placeholder scan:** No TBD/TODO. One intentional exception, flagged explicitly in Tasks 7 and 8: two steps say "if the file doesn't exactly match what's shown here, read it first and apply the equivalent change" — this is not vagueness about *what* to build, only an acknowledgment that `app/admin/settings/mtn/page.tsx` and `factory.test.ts` may have shifted slightly since this plan was written (both were last touched by an earlier, separate plan) and the implementer must verify against the live file rather than blindly diffing against stale line numbers.

**Type consistency:** `ApexPrimeProvider`'s `createOrder`/`checkOrderStatus`/`checkBalance` signatures match `MTNProvider` exactly (Task 1, verified against `MTNProvider`/`MTNOrderRequest`/`MTNOrderResponse`/`MTNOrderStatusResponse` as currently defined in `lib/mtn-providers/types.ts`). `FULFILLMENT_PATH_KEYS`'s three keys (`MTN`/`Telecel`/`AirtelTigo`) are used identically in Task 1 (`getFulfillmentPath`), Task 6 (admin route GET/POST), and Task 8 (UI's `(["MTN","Telecel","AirtelTigo"] as const)` iteration) — no naming drift. `parseTrackingId`'s `{kind, rawId}` shape is produced in Task 1 and consumed only within Task 1's own `checkOrderStatus` — Task 3's webhook route does NOT need to parse this prefix at all (it correlates via `client_reference` against the tracking table directly, never touching `mtn_order_id`), which is a deliberate asymmetry documented in the spec (§4) and worth re-stating here so it isn't mistaken for an oversight.
