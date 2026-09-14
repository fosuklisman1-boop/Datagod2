# SPFastIT Provider (AT-iShare only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SPFastIT as a 9th data-bundle provider, capable of AT-iShare only, structurally unable to be selected anywhere MTN-specific (primary provider, retry sequence, disabled-providers list) because those stay typed to the existing, unwidened `MTNProviderName`.

**Architecture:** A new `NonMTNProviderName = MTNProviderName | "spfastit"` type (in `lib/mtn-providers/types.ts`) is used only by the non-MTN dispatch surface (`getProviderByName`, `NON_MTN_CAPABLE`, `getProviderNameForNetwork`, `isProviderCapableForNetwork`, `createNonMTNOrder`). A new `SPFastITProvider` class implements the existing `MTNProvider` interface, using form-urlencoded HTTP (this provider's API, unlike every other one, isn't JSON-bodied) and treating its documented `client_reference` idempotent-recovery behavior as safe to reuse our `client_ref` on retries — unlike the other 4 providers this codebase has had reference-reuse trouble with.

**Tech Stack:** Next.js App Router API routes, TypeScript, Vitest, `fetch`/`URLSearchParams`.

Design doc: `docs/superpowers/specs/2026-09-14-spfastit-provider-design.md`

**Deliberate scope trim from the design doc** (documented here so it's a decision, not a gap): the design doc said SPFastIT's low-balance signal should appear on "both balance surfaces" — this plan wires that into both routes' JSON response (so the admin balance page shows it) but does **not** extend `sendLowBalanceAlert`'s SMS/email dispatch to include SPFastIT, since that function's message-building is currency-only and mixing in a GB-denominated line would need real changes to `lib/mtn-balance-alert.ts` that the original design didn't call for. SPFastIT's low-balance state is visible on the admin page and in cron logs; automated SMS/email paging for it can be a fast follow if wanted.

---

### Task 1: Widen the provider-name type

**Files:**
- Modify: `lib/mtn-providers/types.ts`

- [ ] **Step 1: Add the new type**

In `lib/mtn-providers/types.ts`, find the last line of the file:

```ts
export type MTNProviderName = "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft" | "agentportalgh" | "apexprime"
```

Replace with:

```ts
export type MTNProviderName = "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft" | "agentportalgh" | "apexprime"

/**
 * Every MTNProviderName, plus providers capable of only a non-MTN network.
 * Used exclusively by non-MTN dispatch (createNonMTNOrder, getProviderByName,
 * NON_MTN_CAPABLE, getProviderNameForNetwork, isProviderCapableForNetwork) —
 * NEVER by MTN-only selection (getMTNProvider, getRetrySequence,
 * getDisabledProviders, WHITELIST_REGISTRY), which stay typed to the
 * narrower MTNProviderName so a network-exclusive provider can't be assigned
 * there without a deliberate, explicit type change.
 */
export type NonMTNProviderName = MTNProviderName | "spfastit"
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors (nothing references `NonMTNProviderName` yet, so this is purely additive).

- [ ] **Step 3: Commit**

```bash
git add lib/mtn-providers/types.ts
git commit -m "feat(spfastit): add NonMTNProviderName type for network-exclusive providers"
```

---

### Task 2: SPFastIT provider class

**Files:**
- Create: `lib/mtn-providers/spfastit-provider.ts`
- Test: `lib/mtn-providers/spfastit-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/mtn-providers/spfastit-provider.test.ts`:

```ts
import { mapSpfastitStatus } from "@/lib/mtn-providers/spfastit-provider"

describe("mapSpfastitStatus", () => {
  it("maps in-flight statuses to processing", () => {
    expect(mapSpfastitStatus("queued")).toBe("processing")
    expect(mapSpfastitStatus("processing")).toBe("processing")
    expect(mapSpfastitStatus("pending_retry")).toBe("processing")
  })
  it("maps completed to completed", () => {
    expect(mapSpfastitStatus("completed")).toBe("completed")
  })
  it("maps every documented failure status to failed", () => {
    expect(mapSpfastitStatus("failed")).toBe("failed")
    expect(mapSpfastitStatus("failed_blocked")).toBe("failed")
    expect(mapSpfastitStatus("billed_failure")).toBe("failed")
  })
  it("is case-insensitive and trims whitespace", () => {
    expect(mapSpfastitStatus(" COMPLETED ")).toBe("completed")
  })
  it("defaults an unrecognized status to processing rather than guessing failed", () => {
    expect(mapSpfastitStatus("some_new_status")).toBe("processing")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/mtn-providers/spfastit-provider.test.ts`
Expected: FAIL — cannot find module `@/lib/mtn-providers/spfastit-provider` (doesn't exist yet).

- [ ] **Step 3: Write the provider**

Create `lib/mtn-providers/spfastit-provider.ts`:

```ts
/**
 * SPFastIT Provider — AT-iShare (AirtelTigo) only.
 *
 * Unlike every other provider in this codebase, SPFastIT's API is
 * form-urlencoded (matches its documented `-d "key=value"` curl examples),
 * not JSON, and authenticates via a flat `api_key` POST field rather than a
 * header.
 *
 * Reference-reuse is safe here, unlike AgentPortalGH/ApexPrime/DataKazina/
 * Bisdel: SPFastIT's own docs guarantee that resubmitting the same
 * client_reference with the same phone+bundle returns the EXISTING
 * transaction (duplicate:true) instead of erroring, and only flags a real
 * conflict when the same reference is paired with a different phone/bundle —
 * which can't happen here since client_ref is always a unique order UUID.
 */
import type { MTNProvider, MTNOrderRequest, MTNOrderResponse, MTNOrderStatusResponse } from "./types"
import { normalizePhoneNumber, isValidPhoneFormat } from "@/lib/mtn-fulfillment"

const BASE_URL = process.env.SPFASTIT_BASE_URL ?? "https://console.spfastit.com"
const REQUEST_TIMEOUT = 30_000

function apiKey(): string {
  return process.env.SPFASTIT_API_KEY ?? ""
}

async function apiFetch(path: string, params: Record<string, string>): Promise<Response> {
  const body = new URLSearchParams({ api_key: apiKey(), ...params })
  return fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  })
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** Maps SPFastIT's order_status values to this app's canonical status set. */
export function mapSpfastitStatus(raw: string): "pending" | "processing" | "completed" | "failed" {
  const s = (raw ?? "").toLowerCase().trim()
  if (s === "completed") return "completed"
  if (s === "failed" || s === "failed_blocked" || s === "billed_failure") return "failed"
  // queued, processing, pending_retry, and any unrecognized value — still in flight
  return "processing"
}

// ── Provider class ───────────────────────────────────────────────────────────

export class SPFastITProvider implements MTNProvider {
  name = "spfastit"

  async createOrder(request: MTNOrderRequest): Promise<MTNOrderResponse> {
    if (!isValidPhoneFormat(request.recipient_phone)) {
      return { success: false, message: `Invalid phone: ${request.recipient_phone}`, error_type: "VALIDATION" }
    }
    const phone = normalizePhoneNumber(request.recipient_phone)
    const bundleMb = Math.round(request.size_gb * 1024)
    const clientReference = request.client_ref

    let res: Response
    try {
      res = await apiFetch("/api/send.php", {
        phone,
        bundle_mb: String(bundleMb),
        ...(clientReference ? { client_reference: clientReference } : {}),
      })
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Network error", error_type: "NETWORK_ERROR" }
    }

    let json: any
    try { json = await res.json() } catch {
      return { success: false, message: `HTTP ${res.status} (non-JSON response)`, error_type: "API_ERROR" }
    }

    if (json.status !== "success") {
      // Confirmed shape: { status:"error", message:"This client_reference has already
      // been used for a different phone number or bundle size." } — cannot actually
      // happen given client_reference is always a fresh order UUID, but handled
      // explicitly rather than silently mis-parsed as a generic API_ERROR.
      const isReferenceConflict = typeof json.message === "string" && /already been used for a different/i.test(json.message)
      return {
        success: false,
        message: json.message ?? `API error (status ${res.status})`,
        error_type: isReferenceConflict ? "REFERENCE_CONFLICT" : "API_ERROR",
      }
    }

    // json.duplicate === true means this exact (reference, phone, bundle) was already
    // queued — SPFastIT returns the EXISTING transaction rather than erroring or
    // creating a second one. Treated as an ordinary success: the caller doesn't need
    // to know this was a recovered retry rather than a first attempt.
    return { success: true, order_id: json.transaction_id, message: json.message ?? "Order queued" }
  }

  async checkOrderStatus(transactionId: string | number): Promise<MTNOrderStatusResponse> {
    const id = String(transactionId)
    if (id.startsWith("FAILED_INIT_")) {
      return { success: true, status: "failed", message: "Order was never submitted to SPFastIT (local failure)" }
    }

    let res: Response
    try {
      res = await apiFetch("/api/check_order_status.php", { transaction_id: id })
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
      status: mapSpfastitStatus(json.order_status),
      message: json.response_message ?? json.message ?? "Status retrieved",
      order: json,
    }
  }

  /** Returns available balance in GB (this provider's balance is data volume, not currency). */
  async checkBalance(): Promise<number | null> {
    try {
      const res = await apiFetch("/api/check_balance.php", {})
      if (!res.ok) return null
      const json = await res.json()
      if (json.status !== "success") return null
      const mb = json.available_mb
      return typeof mb === "number" ? mb / 1024 : null
    } catch {
      return null
    }
  }
}

export default SPFastITProvider
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/mtn-providers/spfastit-provider.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add lib/mtn-providers/spfastit-provider.ts lib/mtn-providers/spfastit-provider.test.ts
git commit -m "feat(spfastit): add SPFastITProvider (AT-iShare, form-urlencoded API)"
```

---

### Task 3: Wire into the provider factory

**Files:**
- Modify: `lib/mtn-providers/factory.ts`

No new tests — this task only widens existing, already-covered function signatures and adds one new registry entry; the factory's own functions have no existing test file to extend (confirmed: no `factory.test.ts` exists in this codebase today), consistent with how the 8 existing providers were each registered here without a dedicated factory test.

- [ ] **Step 1: Import the new provider and type**

Find this line near the top of `lib/mtn-providers/factory.ts`:

```ts
import type { MTNProvider, MTNProviderName } from "./types"
```

Replace with:

```ts
import type { MTNProvider, MTNProviderName, NonMTNProviderName } from "./types"
```

Find this block of provider imports:

```ts
import { SykesProvider } from "./sykes-provider"
import { DataKazinaProvider } from "./datakazina-provider"
import { XpressProvider } from "./xpress-provider"
import { EazyGhDataProvider } from "./eazyghdata-provider"
import { BisdelProvider } from "./bisdel-provider"
import { CodeCraftMTNProvider } from "./codecraft-provider"
import { AgentPortalGHProvider } from "./agentportalgh-provider"
import { ApexPrimeProvider } from "./apexprime-provider"
```

Add one line after it:

```ts
import { SykesProvider } from "./sykes-provider"
import { DataKazinaProvider } from "./datakazina-provider"
import { XpressProvider } from "./xpress-provider"
import { EazyGhDataProvider } from "./eazyghdata-provider"
import { BisdelProvider } from "./bisdel-provider"
import { CodeCraftMTNProvider } from "./codecraft-provider"
import { AgentPortalGHProvider } from "./agentportalgh-provider"
import { ApexPrimeProvider } from "./apexprime-provider"
import { SPFastITProvider } from "./spfastit-provider"
```

- [ ] **Step 2: Widen `getProviderByName` and add the case**

Find (at the end of the file):

```ts
/**
 * Get a specific provider by name (for testing or manual override)
 */
export function getProviderByName(name: MTNProviderName): MTNProvider {
    switch (name) {
        case "agentportalgh":
            return new AgentPortalGHProvider()
        case "apexprime":
            return new ApexPrimeProvider()
        case "bisdel":
            return new BisdelProvider()
        case "codecraft":
            return new CodeCraftMTNProvider()
        case "datakazina":
            return new DataKazinaProvider()
        case "xpress":
            return new XpressProvider()
        case "eazyghdata":
            return new EazyGhDataProvider()
        case "sykes":
            return new SykesProvider()
    }
}
```

Replace with:

```ts
/**
 * Get a specific provider by name (for testing or manual override)
 */
export function getProviderByName(name: NonMTNProviderName): MTNProvider {
    switch (name) {
        case "agentportalgh":
            return new AgentPortalGHProvider()
        case "apexprime":
            return new ApexPrimeProvider()
        case "bisdel":
            return new BisdelProvider()
        case "codecraft":
            return new CodeCraftMTNProvider()
        case "datakazina":
            return new DataKazinaProvider()
        case "xpress":
            return new XpressProvider()
        case "eazyghdata":
            return new EazyGhDataProvider()
        case "sykes":
            return new SykesProvider()
        case "spfastit":
            return new SPFastITProvider()
    }
}
```

(`getMTNProvider`'s internal switch, a few lines above this one, stays completely untouched — it's still typed to the narrower `MTNProviderName` and has no `"spfastit"` case, so it remains structurally impossible for it to ever select SPFastIT.)

- [ ] **Step 3: Widen `NON_MTN_CAPABLE` and add SPFastIT to AT-iShare only**

Find:

```ts
export const NON_MTN_CAPABLE: Record<string, MTNProviderName[]> = {
    telecel_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"],
    at_ishare_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"],
    at_bigtime_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft"],
}
```

Replace with:

```ts
export const NON_MTN_CAPABLE: Record<string, NonMTNProviderName[]> = {
    telecel_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"],
    at_ishare_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "spfastit"],
    at_bigtime_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft"],
}
```

- [ ] **Step 4: Widen `isProviderCapableForNetwork`'s parameter type**

Find:

```ts
/** Is `provider` a valid, capability-checked choice for this non-MTN network? */
export function isProviderCapableForNetwork(normalizedNetwork: string, provider: MTNProviderName): boolean {
    const settingKey = NON_MTN_NETWORK_KEYS[normalizedNetwork]
    if (!settingKey) return false
    return (NON_MTN_CAPABLE[settingKey] ?? []).includes(provider)
}
```

Replace with:

```ts
/** Is `provider` a valid, capability-checked choice for this non-MTN network? */
export function isProviderCapableForNetwork(normalizedNetwork: string, provider: NonMTNProviderName): boolean {
    const settingKey = NON_MTN_NETWORK_KEYS[normalizedNetwork]
    if (!settingKey) return false
    return (NON_MTN_CAPABLE[settingKey] ?? []).includes(provider)
}
```

- [ ] **Step 5: Widen `getProviderNameForNetwork`'s return type**

Find:

```ts
export async function getProviderNameForNetwork(normalizedNetwork: string): Promise<MTNProviderName> {
    const settingKey = NON_MTN_NETWORK_KEYS[normalizedNetwork]
    if (!settingKey) return "codecraft"

    const capable = NON_MTN_CAPABLE[settingKey] ?? ["codecraft"]

    try {
        const { data } = await supabase
            .from("admin_settings")
            .select("value")
            .eq("key", settingKey)
            .maybeSingle()

        const name = data?.value?.provider as MTNProviderName | undefined
        return name && capable.includes(name) ? name : "codecraft"
    } catch {
        return "codecraft"
    }
}
```

Replace with:

```ts
export async function getProviderNameForNetwork(normalizedNetwork: string): Promise<NonMTNProviderName> {
    const settingKey = NON_MTN_NETWORK_KEYS[normalizedNetwork]
    if (!settingKey) return "codecraft"

    const capable = NON_MTN_CAPABLE[settingKey] ?? ["codecraft"]

    try {
        const { data } = await supabase
            .from("admin_settings")
            .select("value")
            .eq("key", settingKey)
            .maybeSingle()

        const name = data?.value?.provider as NonMTNProviderName | undefined
        return name && capable.includes(name) ? name : "codecraft"
    } catch {
        return "codecraft"
    }
}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. Widening `getProviderByName`/`isProviderCapableForNetwork`'s parameter type and `getProviderNameForNetwork`'s return type from `MTNProviderName` to the wider `NonMTNProviderName` is safe for every existing caller (every existing call site passes a plain `MTNProviderName` value, which is a valid `NonMTNProviderName` too) — so this step should be a clean no-new-errors pass. If `tsc` does report something here, it means an existing caller passes a bare untyped `string` (not a literal from `MTNProviderName`) — check that specific call site and report back rather than reaching for `as any`.

- [ ] **Step 7: Commit**

```bash
git add lib/mtn-providers/factory.ts
git commit -m "feat(spfastit): register SPFastIT for AT-iShare in the provider factory"
```

---

### Task 4: Widen non-MTN dispatcher types

**Files:**
- Modify: `lib/non-mtn-fulfillment.ts`

- [ ] **Step 1: Update the type import and the two type annotations**

Find this line near the top of `lib/non-mtn-fulfillment.ts`:

```ts
import type { MTNOrderRequest, MTNProviderName } from "@/lib/mtn-providers/types"
```

Replace with:

```ts
import type { MTNOrderRequest, NonMTNProviderName } from "@/lib/mtn-providers/types"
```

Find, inside the `NonMTNOrderParams` interface:

```ts
  /**
   * Optional explicit provider choice (e.g. from an admin's manual-fulfillment
   * dropdown). Used only if it's capability-checked for the resolved network;
   * otherwise falls back to the admin-configured default exactly as before.
   */
  providerOverride?: MTNProviderName
```

Replace with:

```ts
  /**
   * Optional explicit provider choice (e.g. from an admin's manual-fulfillment
   * dropdown). Used only if it's capability-checked for the resolved network;
   * otherwise falls back to the admin-configured default exactly as before.
   */
  providerOverride?: NonMTNProviderName
```

Find, inside `createNonMTNOrder`:

```ts
  let providerName: MTNProviderName
  if (providerOverride && isProviderCapableForNetwork(normalizedKey, providerOverride)) {
```

Replace with:

```ts
  let providerName: NonMTNProviderName
  if (providerOverride && isProviderCapableForNetwork(normalizedKey, providerOverride)) {
```

- [ ] **Step 2: Run the existing test suite for this file**

Run: `npx vitest run lib/non-mtn-fulfillment.test.ts`
Expected: PASS — this file's existing tests exercise `createNonMTNOrder` with mocked providers; a type-only widening should not change any runtime behavior, so all existing tests must still pass unmodified.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add lib/non-mtn-fulfillment.ts
git commit -m "feat(spfastit): widen createNonMTNOrder's provider type to include SPFastIT"
```

---

### Task 5: Admin network-provider route validation

**Files:**
- Modify: `app/api/admin/settings/network-provider/route.ts`

- [ ] **Step 1: Add SPFastIT to the AT-iShare allowlist only**

Find:

```ts
const VALID_PROVIDERS_BY_NETWORK: Record<string, string[]> = {
  telecel: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"],
  at_ishare: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"],
  at_bigtime: ["datakazina", "xpress", "eazyghdata", "codecraft"],
}
```

Replace with:

```ts
const VALID_PROVIDERS_BY_NETWORK: Record<string, string[]> = {
  telecel: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"],
  at_ishare: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "spfastit"],
  at_bigtime: ["datakazina", "xpress", "eazyghdata", "codecraft"],
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors (this file uses bare `string[]`, not `MTNProviderName[]`, so this edit is untyped and can't fail to compile).

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/settings/network-provider/route.ts
git commit -m "feat(spfastit): allow spfastit as a valid AT-iShare provider selection"
```

---

### Task 6: Admin UI — AT-iShare provider selector card

**Files:**
- Modify: `app/admin/settings/mtn/page.tsx`

- [ ] **Step 1: Widen the local `NonMTNProvider` type alias**

Find (around line 143):

```ts
  type NonMTNProvider = "datakazina" | "xpress" | "eazyghdata" | "codecraft" | "agentportalgh" | "apexprime"
  const [telecelProvider, setTelecelProvider] = useState<NonMTNProvider>("codecraft")
  const [atIshareProvider, setAtIshareProvider] = useState<NonMTNProvider>("codecraft")
  const [atBigtimeProvider, setAtBigtimeProvider] = useState<NonMTNProvider>("codecraft")
```

Replace with:

```ts
  type NonMTNProvider = "datakazina" | "xpress" | "eazyghdata" | "codecraft" | "agentportalgh" | "apexprime" | "spfastit"
  const [telecelProvider, setTelecelProvider] = useState<NonMTNProvider>("codecraft")
  const [atIshareProvider, setAtIshareProvider] = useState<NonMTNProvider>("codecraft")
  const [atBigtimeProvider, setAtBigtimeProvider] = useState<NonMTNProvider>("codecraft")
```

(This widens the type used by all three network selectors' state, but SPFastIT is only ever *offered* as an option for AT-iShare — see Step 2. Telecel and AT-BigTime's own state types being technically able to hold `"spfastit"` doesn't matter in practice since nothing will ever set them to it: their option lists never include it, and the save handler validates server-side too via Task 5's `VALID_PROVIDERS_BY_NETWORK`.)

- [ ] **Step 2: Give AT-iShare its own options list**

Find (around line 1339-1356):

```ts
            {/* Per-Network Provider Selectors */}
            {(["telecel", "at_ishare", "at_bigtime"] as const).map(netKey => {
              const networkLabel = netKey === "telecel" ? "Telecel" : netKey === "at_ishare" ? "AT - iShare" : "AT - BigTime"
              const current = netKey === "telecel" ? telecelProvider : netKey === "at_ishare" ? atIshareProvider : atBigtimeProvider
              const setter = netKey === "telecel" ? setTelecelProvider : netKey === "at_ishare" ? setAtIshareProvider : setAtBigtimeProvider
              const isSaving = savingNetworkProvider === netKey
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
              return (
```

Replace with:

```ts
            {/* Per-Network Provider Selectors */}
            {(["telecel", "at_ishare", "at_bigtime"] as const).map(netKey => {
              const networkLabel = netKey === "telecel" ? "Telecel" : netKey === "at_ishare" ? "AT - iShare" : "AT - BigTime"
              const current = netKey === "telecel" ? telecelProvider : netKey === "at_ishare" ? atIshareProvider : atBigtimeProvider
              const setter = netKey === "telecel" ? setTelecelProvider : netKey === "at_ishare" ? setAtIshareProvider : setAtBigtimeProvider
              const isSaving = savingNetworkProvider === netKey
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
              return (
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Manual verification**

Run the dev server (`npm run dev`), sign in as admin, navigate to `/admin/settings/mtn`, scroll to the per-network provider cards, and confirm:
- The AT-iShare card shows 7 options (the existing 6 plus "SPFastIT — AirtelTigo-only").
- The Telecel card still shows exactly 6 options (no SPFastIT).
- The AT-BigTime card still shows exactly 4 options (no SPFastIT).
- Selecting SPFastIT for AT-iShare and reloading the page shows it as the persisted selection (round-trips through Task 5's route correctly).
- Confirm by reading the code (not by trying to click it into existence, since it structurally can't appear there) that neither the "Primary MTN Provider" selector, the "Retry Sequence" add-buttons, nor the "Disabled Providers" toggles anywhere on this page offer SPFastIT as an option — they all render from `PROVIDER_LABELS`/the page's local `MTNProviderName` type (line 135), untouched by this task.

- [ ] **Step 5: Commit**

```bash
git add app/admin/settings/mtn/page.tsx
git commit -m "feat(spfastit): add SPFastIT option to the AT-iShare provider selector"
```

---

### Task 7: Status-sync cron

**Files:**
- Create: `app/api/cron/sync-mtn-status/spfastit/route.ts`

- [ ] **Step 1: Create the route**

Create `app/api/cron/sync-mtn-status/spfastit/route.ts` (copied from `app/api/cron/sync-mtn-status/apexprime/route.ts` with the provider name swapped throughout):

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
 * GET /api/cron/sync-mtn-status/spfastit
 *
 * Polling sync for SPFastIT (AT-iShare) orders. Mirrors the Apex Prime
 * cron's structure (sequential polling, no batch/retry disambiguation
 * needed — SPFastIT gives one stable transaction_id per order, with
 * documented idempotent-recovery on resubmission rather than a new id).
 */
export async function GET(request: NextRequest) {
    const { authorized, errorResponse } = verifyCronAuth(request)
    if (!authorized && errorResponse) return errorResponse

    try {
        console.log("[CRON-SPFASTIT] Starting status sync...")

        const { data: pendingOrders, error: fetchError } = await supabase
            .from("mtn_fulfillment_tracking")
            .select("id, mtn_order_id, status, shop_order_id, order_id, api_order_id, order_type, recipient_phone, size_gb")
            .eq("provider", "spfastit")
            .in("status", ["pending", "processing"])
            .order("created_at", { ascending: true })
            .limit(BATCH_SIZE)

        if (fetchError) {
            console.error("[CRON-SPFASTIT] Error fetching orders:", fetchError)
            return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
        }

        if (!pendingOrders || pendingOrders.length === 0) {
            return NextResponse.json({ success: true, message: "No SPFastIT orders to sync" })
        }

        console.log(`[CRON-SPFASTIT] Found ${pendingOrders.length} orders to sync`)

        let synced = 0
        let failed = 0
        const results = []

        for (let i = 0; i < pendingOrders.length; i++) {
            const order = pendingOrders[i]

            try {
                const result = await checkMTNOrderStatus(order.mtn_order_id, "spfastit")

                if (result.success && result.status) {
                    const oldStatus = order.status
                    const newStatus = result.status
                    const statusPriority: Record<string, number> = { pending: 1, processing: 2, completed: 3, failed: 3, reversed: 4, abandoned: 4 }

                    if ((statusPriority[newStatus] ?? 0) < (statusPriority[oldStatus] ?? 0)) {
                        console.log(`[CRON-SPFASTIT] ⛔ Skipping regression ${oldStatus} -> ${newStatus} for ${order.mtn_order_id}`)
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

                        console.log(`[CRON-SPFASTIT] ✅ ${order.mtn_order_id}: ${oldStatus} -> ${newStatus}`)
                        synced++
                    }
                } else {
                    console.warn(`[CRON-SPFASTIT] Failed to get status for ${order.mtn_order_id}:`, result.message)
                    failed++
                }

                results.push({ id: order.id, mtn_order_id: order.mtn_order_id, success: result.success, status: result.status || order.status, message: result.message })

                if (i < pendingOrders.length - 1) await sleep(DELAY_BETWEEN_REQUESTS_MS)
            } catch (err) {
                console.error(`[CRON-SPFASTIT] Error processing ${order.mtn_order_id}:`, err)
                failed++
            }
        }

        let reversed = 0
        const reversalCandidates = await fetchReversalCandidates(supabase, "spfastit", BATCH_SIZE)
        for (const cand of reversalCandidates) {
            const chk = await checkMTNOrderStatus((cand as any).mtn_order_id, "spfastit")
            if (!chk.success || !chk.status) { await sleep(DELAY_BETWEEN_REQUESTS_MS); continue }
            if (isReversal({ trackingStatus: "completed", completedAt: (cand as any).updated_at, providerStatus: chk.status })) {
                await flagReversal(supabase, cand, { status: chk.order?.status ?? "failed", message: chk.message })
                reversed++
            }
            await sleep(DELAY_BETWEEN_REQUESTS_MS)
        }

        return NextResponse.json({ success: true, synced, failed, total: pendingOrders.length, results, reversed })
    } catch (error) {
        console.error("[CRON-SPFASTIT] Critical error:", error)
        return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors. (`checkMTNOrderStatus(orderId, providerName?: string)` already accepts a bare string for `providerName`, so `"spfastit"` type-checks with no change needed there.)

- [ ] **Step 3: Commit**

```bash
git add app/api/cron/sync-mtn-status/spfastit/route.ts
git commit -m "feat(spfastit): add status-sync cron route"
```

---

### Task 8: Register the new cron in vercel.json

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add the cron entry**

In `vercel.json`, find:

```json
    {
      "path": "/api/cron/sync-mtn-status/apexprime",
      "schedule": "* * * * *"
    },
```

Replace with (adds the new entry directly after it):

```json
    {
      "path": "/api/cron/sync-mtn-status/apexprime",
      "schedule": "* * * * *"
    },
    {
      "path": "/api/cron/sync-mtn-status/spfastit",
      "schedule": "* * * * *"
    },
```

- [ ] **Step 2: Validate the JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('vercel.json', 'utf8')); console.log('valid JSON')"`
Expected: prints `valid JSON` with no error.

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "feat(spfastit): register status-sync cron schedule"
```

---

### Task 9: Balance monitoring

**Files:**
- Modify: `app/api/cron/check-mtn-balance/route.ts`
- Modify: `app/api/admin/fulfillment/mtn-balance/route.ts`

- [ ] **Step 1: Add SPFastIT to the cron's balance check**

In `app/api/cron/check-mtn-balance/route.ts`, find:

```ts
import { AgentPortalGHProvider } from "@/lib/mtn-providers/agentportalgh-provider"
import { ApexPrimeProvider } from "@/lib/mtn-providers/apexprime-provider"
import { sendLowBalanceAlert } from "@/lib/mtn-balance-alert"
```

Replace with:

```ts
import { AgentPortalGHProvider } from "@/lib/mtn-providers/agentportalgh-provider"
import { ApexPrimeProvider } from "@/lib/mtn-providers/apexprime-provider"
import { SPFastITProvider } from "@/lib/mtn-providers/spfastit-provider"
import { sendLowBalanceAlert } from "@/lib/mtn-balance-alert"
```

Find:

```ts
    const [sykes, datakazina, xpress, eazyghdata, bisdel, codecraft, agentportalgh, apexprime] = await Promise.all([
      new SykesProvider().checkBalance().catch(() => null),
      new DataKazinaProvider().checkBalance().catch(() => null),
      new XpressProvider().checkBalance().catch(() => null),
      new EazyGhDataProvider().checkBalance().catch(() => null),
      new BisdelProvider().checkBalance().catch(() => null),
      new CodeCraftMTNProvider().checkBalance().catch(() => null),
      new AgentPortalGHProvider().checkBalance().catch(() => null),
      new ApexPrimeProvider().checkBalance().catch(() => null),
    ])

    const { data: settingData } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "mtn_balance_alert_threshold")
      .maybeSingle()

    const threshold = parseInt(settingData?.value || "500", 10)

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

    const anyLow = Object.values(lows).some(Boolean)

    if (anyLow) {
      await sendLowBalanceAlert(balances, lows, threshold)
    }

    console.log(`[CRON-MTN-BALANCE] threshold=₵${threshold} anyLow=${anyLow}`, balances)
    return NextResponse.json({ success: true, threshold, anyLow, balances })
```

Replace with (SPFastIT is fetched alongside the others but kept OUT of `balances`/`lows`/`sendLowBalanceAlert` — those are currency-denominated (₵) and SPFastIT's number is GB; mixing it in would silently compare unlike units. It gets its own GB threshold and its own line in the response instead):

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

    const { data: settingData } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "mtn_balance_alert_threshold")
      .maybeSingle()

    const threshold = parseInt(settingData?.value || "500", 10)

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

    const anyLow = Object.values(lows).some(Boolean)

    if (anyLow) {
      await sendLowBalanceAlert(balances, lows, threshold)
    }

    // SPFastIT's balance is GB of data remaining, not currency — a separate,
    // GB-denominated threshold, checked and logged independently so it's never
    // compared against the currency threshold above.
    const spfastitThresholdGb = parseFloat(process.env.SPFASTIT_LOW_BALANCE_GB || "5")
    const spfastitLow = spfastit !== null && spfastit < spfastitThresholdGb
    if (spfastitLow) {
      console.warn(`[CRON-MTN-BALANCE] SPFastIT balance low: ${spfastit}GB remaining (threshold ${spfastitThresholdGb}GB)`)
    }

    console.log(`[CRON-MTN-BALANCE] threshold=₵${threshold} anyLow=${anyLow}`, balances)
    return NextResponse.json({
      success: true,
      threshold,
      anyLow,
      balances,
      spfastit: { balance_gb: spfastit, threshold_gb: spfastitThresholdGb, is_low: spfastitLow },
    })
```

- [ ] **Step 2: Add SPFastIT to the admin balance page's route**

In `app/api/admin/fulfillment/mtn-balance/route.ts`, find:

```ts
import { AgentPortalGHProvider } from "@/lib/mtn-providers/agentportalgh-provider"
import { ApexPrimeProvider } from "@/lib/mtn-providers/apexprime-provider"
import { sendLowBalanceAlert } from "@/lib/mtn-balance-alert"
```

Replace with:

```ts
import { AgentPortalGHProvider } from "@/lib/mtn-providers/agentportalgh-provider"
import { ApexPrimeProvider } from "@/lib/mtn-providers/apexprime-provider"
import { SPFastITProvider } from "@/lib/mtn-providers/spfastit-provider"
import { sendLowBalanceAlert } from "@/lib/mtn-balance-alert"
```

Find:

```ts
    // Fetch balances from all providers in parallel
    const sykesProvider = new SykesProvider()
    const datakazinaProvider = new DataKazinaProvider()
    const xpressProvider = new XpressProvider()
    const eazyghDataProvider = new EazyGhDataProvider()
    const bisdelProvider = new BisdelProvider()
    const codeCraftProvider = new CodeCraftMTNProvider()
    const agentPortalGHProvider = new AgentPortalGHProvider()
    const apexPrimeProvider = new ApexPrimeProvider()

    const [sykesBalance, datakazinaBalance, xpressBalance, eazyghDataBalance, bisdelBalance, codeCraftBalance, agentportalghBalance, apexprimeBalance] = await Promise.all([
      sykesProvider.checkBalance().catch(() => null),
      datakazinaProvider.checkBalance().catch(() => null),
      xpressProvider.checkBalance().catch(() => null),
      eazyghDataProvider.checkBalance().catch(() => null),
      bisdelProvider.checkBalance().catch(() => null),
      codeCraftProvider.checkBalance().catch(() => null),
      agentPortalGHProvider.checkBalance().catch(() => null),
      apexPrimeProvider.checkBalance().catch(() => null),
    ])
```

Replace with:

```ts
    // Fetch balances from all providers in parallel
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

Find:

```ts
    if (sykesLow || datakazinaLow || xpressLow || eazyghDataLow || bisdelLow || codeCraftLow || agentportalghLow || apexprimeLow) {
      sendLowBalanceAlert(balanceMap, lowMap, threshold).catch((e) => console.error("[MTN Balance] Alert error:", e))
    }

    return NextResponse.json({
      success: true,
      balances: {
```

Replace with (adds the SPFastIT GB-threshold check right before the existing currency-only alert call, and a `spfastit` field alongside the existing `balances` object in the response — NOT inside it, since `balances`'s shape is `Record<MTNProviderName, ProviderBalance>` with a `currency: "GHS"` field on every entry, and SPFastIT's entry would need `currency: "GB"` instead; keeping it as a sibling field avoids stretching that existing shape's assumption):

```ts
    if (sykesLow || datakazinaLow || xpressLow || eazyghDataLow || bisdelLow || codeCraftLow || agentportalghLow || apexprimeLow) {
      sendLowBalanceAlert(balanceMap, lowMap, threshold).catch((e) => console.error("[MTN Balance] Alert error:", e))
    }

    // SPFastIT's balance is GB of data remaining, not currency — kept out of the
    // balanceMap/lowMap/sendLowBalanceAlert (currency-only) path above and given
    // its own GB-denominated threshold instead.
    const spfastitThresholdGb = parseFloat(process.env.SPFASTIT_LOW_BALANCE_GB || "5")
    const spfastitLow = spfastitBalance !== null && spfastitBalance < spfastitThresholdGb

    return NextResponse.json({
      success: true,
      spfastit: {
        balance_gb: spfastitBalance,
        threshold_gb: spfastitThresholdGb,
        is_low: spfastitLow,
        is_active: false, // SPFastIT can never be the active MTN provider — it's AT-iShare only
        alert: spfastitLow && spfastitBalance !== null ? `SPFastIT balance is below threshold of ${spfastitThresholdGb}GB` : null,
      },
      balances: {
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all tests green, no regressions (these two routes have no existing dedicated test files to break; this confirms nothing else in the suite was inadvertently affected).

- [ ] **Step 5: Commit**

```bash
git add app/api/cron/check-mtn-balance/route.ts app/api/admin/fulfillment/mtn-balance/route.ts
git commit -m "feat(spfastit): add GB-denominated balance monitoring, kept separate from currency thresholds"
```

---

### Task 10: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all test files passing, including the new `spfastit-provider.test.ts` (5 tests).

- [ ] **Step 2: Full type-check**

Run: `npx tsc --noEmit`
Expected: no errors anywhere in the project.

- [ ] **Step 3: Confirm structural exclusion by reading the code, not guessing**

Grep for every place `"spfastit"` now appears (`git grep -n '"spfastit"'` from the repo root) and confirm each hit is one of: `spfastit-provider.ts` itself, `factory.ts`'s `getProviderByName`/`NON_MTN_CAPABLE`, `non-mtn-fulfillment.ts`'s type import, the two admin routes' allowlists (`network-provider`, and nowhere in `mtn-provider`/`mtn-retry-sequence`/`mtn-disabled-providers`), the admin page's AT-iShare-only options list, the new cron route, and the two balance routes. If `"spfastit"` appears anywhere else — especially `app/api/admin/settings/mtn-provider/route.ts`, `app/api/admin/settings/mtn-retry-sequence/route.ts`, or `app/api/admin/settings/mtn-disabled-providers/route.ts` — that's a bug introduced somewhere in this plan's execution and must be fixed before calling this done.

- [ ] **Step 4: Remind the user about the API key**

This plan never writes `SPFASTIT_API_KEY` anywhere. Before this is usable in production, the user needs to set `SPFASTIT_API_KEY` (and optionally `SPFASTIT_BASE_URL` if it differs from `https://console.spfastit.com`, and `SPFASTIT_LOW_BALANCE_GB` if the 5GB default isn't right) in Vercel's environment variables.
