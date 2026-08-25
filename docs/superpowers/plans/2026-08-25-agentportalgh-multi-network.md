# AgentPortalGH Multi-Network Support + Non-MTN Provider Routing Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AgentPortalGH submit orders under the correct network `service` (mtn/telecel/airteltigo), make it selectable as a Telecel/AT-iShare provider (never AT-BigTime), and fix 7 order-creation call sites that currently hardcode CodeCraft directly instead of consulting the admin's per-network provider selection.

**Architecture:** A new shared dispatcher, `createNonMTNOrder()` in `lib/non-mtn-fulfillment.ts`, becomes the single place that resolves which provider handles a Telecel/AT-iShare/AT-BigTime order and calls it. All 9 non-MTN order-creation call sites (7 currently broken, 2 already correct) route through it. AgentPortalGH's `buildQueuePayload()` gains a `network` parameter so it stops hardcoding `service: "mtn"`. The AT-BigTime exclusion for AgentPortalGH is enforced independently at three layers: the provider-capability map in the factory, the admin API's POST validator, and the admin UI's per-network provider list.

**Tech Stack:** Next.js 15 App Router API routes, TypeScript, Supabase (service-role client), Vitest.

## Global Constraints

- `checkOrderStatus()` and its helpers in `lib/mtn-providers/agentportalgh-provider.ts` (phone+size+day matching, `hasAmbiguousSibling`, day-scoped date search, `findFinalItemForPhone`, `deriveOrderStatus`) must not be modified. Only `buildQueuePayload()` and the `createOrder()` call site that invokes it change.
- AgentPortalGH must never be offered or routed for AT-BigTime — only Telecel and AT-iShare. This is enforced at three independent layers: `NON_MTN_CAPABLE` in `lib/mtn-providers/factory.ts`, `VALID_PROVIDERS_BY_NETWORK` in `app/api/admin/settings/network-provider/route.ts`, and the per-network `providers` list in `app/admin/settings/mtn/page.tsx`.
- Every non-CodeCraft branch of the new dispatcher must call `saveMTNTracking()` on success so the existing per-provider sync crons (which filter by `provider`, not by network) can resolve the order — this closes a pre-existing gap where non-CodeCraft non-MTN orders were never tracked.
- `lib/at-ishare-service.ts` is not modified. It keeps being called exactly as it is today — only through the new dispatcher instead of directly from 7 scattered call sites.
- Follow existing codebase test convention: `lib/` pure-logic functions get Vitest unit tests; `app/api/**` routes and `app/**/page.tsx` files are not unit-tested in this codebase (confirmed: zero `*.test.ts(x)` files exist under `app/`) — verify those via `npx tsc --noEmit` instead.

---

### Task 1: AgentPortalGH — network-aware order creation

**Files:**
- Modify: `lib/mtn-providers/agentportalgh-provider.ts:36-46` (`buildQueuePayload`), `:141` (call site inside `createOrder`)
- Test: `lib/mtn-providers/agentportalgh-provider.test.ts:20-37` (existing `buildQueuePayload` describe block)

**Interfaces:**
- Consumes: `MTNOrderRequest.network: "MTN" | "Telecel" | "AirtelTigo"` (already exists, `lib/mtn-providers/types.ts:10`)
- Produces: `buildQueuePayload(msisdn: string, dataGb: number, reference: string, network: "MTN" | "Telecel" | "AirtelTigo"): { service: string; items: Array<{ msisdn: string; data_gb: number; reference: string }> }` — the 4th parameter is new and required. Later tasks do not call this function directly (only `createOrder()` does, unchanged from Task 5's perspective), so no other task depends on this signature.

- [ ] **Step 1: Update the failing tests first**

Replace the entire `describe("buildQueuePayload", ...)` block (current lines 20-37) in `lib/mtn-providers/agentportalgh-provider.test.ts` with:

```ts
describe("buildQueuePayload", () => {
  it("rounds fractional GB to integer", () => {
    const body = buildQueuePayload("0241234567", 1.7, "ref-uuid", "MTN")
    expect(body.items[0].data_gb).toBe(2)
  })
  it("sets service to mtn for the MTN network", () => {
    const body = buildQueuePayload("0241234567", 3, "ref-uuid", "MTN")
    expect(body.service).toBe("mtn")
  })
  it("sets service to telecel for the Telecel network", () => {
    const body = buildQueuePayload("0241234567", 3, "ref-uuid", "Telecel")
    expect(body.service).toBe("telecel")
  })
  it("sets service to airteltigo for the AirtelTigo network", () => {
    const body = buildQueuePayload("0241234567", 3, "ref-uuid", "AirtelTigo")
    expect(body.service).toBe("airteltigo")
  })
  it("passes the reference through unchanged", () => {
    const body = buildQueuePayload("0241234567", 5, "my-uuid-123", "MTN")
    expect(body.items[0].reference).toBe("my-uuid-123")
  })
  it("passes the msisdn through unchanged", () => {
    const body = buildQueuePayload("0241234567", 5, "r", "MTN")
    expect(body.items[0].msisdn).toBe("0241234567")
  })
})
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npx vitest run lib/mtn-providers/agentportalgh-provider.test.ts`
Expected: FAIL — `buildQueuePayload` called with 4 arguments but only accepts 3 (TypeScript error), and the "always sets service to mtn" test name/assertion no longer exists so the new "sets service to telecel"/"sets service to airteltigo" tests fail since `service` is still hardcoded to `"mtn"`.

- [ ] **Step 3: Update `buildQueuePayload` and its call site**

In `lib/mtn-providers/agentportalgh-provider.ts`, replace lines 36-46:

```ts
/** Construct the POST /api/queue/add request body. */
export function buildQueuePayload(
  msisdn: string,
  dataGb: number,
  reference: string
): { service: string; items: Array<{ msisdn: string; data_gb: number; reference: string }> } {
  return {
    service: "mtn",
    items: [{ msisdn, data_gb: Math.round(dataGb), reference }],
  }
}
```

with:

```ts
/** Construct the POST /api/queue/add request body. */
export function buildQueuePayload(
  msisdn: string,
  dataGb: number,
  reference: string,
  network: "MTN" | "Telecel" | "AirtelTigo"
): { service: string; items: Array<{ msisdn: string; data_gb: number; reference: string }> } {
  const service = network === "Telecel" ? "telecel" : network === "AirtelTigo" ? "airteltigo" : "mtn"
  return {
    service,
    items: [{ msisdn, data_gb: Math.round(dataGb), reference }],
  }
}
```

Then update the call site at line 141 from:

```ts
        body: JSON.stringify(buildQueuePayload(phone, request.size_gb, reference)),
```

to:

```ts
        body: JSON.stringify(buildQueuePayload(phone, request.size_gb, reference, request.network)),
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run lib/mtn-providers/agentportalgh-provider.test.ts`
Expected: PASS — all tests in the file green (the `buildQueuePayload`, `mapItemStatus`, and `deriveOrderStatus` describe blocks all pass; the latter two are untouched by this change).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `agentportalgh-provider.ts`.

- [ ] **Step 6: Commit**

```bash
git add lib/mtn-providers/agentportalgh-provider.ts lib/mtn-providers/agentportalgh-provider.test.ts
git commit -m "feat(agentportalgh): submit orders under the correct network service (mtn/telecel/airteltigo)"
```

---

### Task 2: Factory — per-network provider capability (AT-BigTime exclusion)

**Files:**
- Modify: `lib/mtn-providers/factory.ts:134-170`
- Test: Create `lib/mtn-providers/factory.test.ts`

**Interfaces:**
- Consumes: `NON_MTN_NETWORK_KEYS: Record<string, string>` (unchanged, already exists at `factory.ts:115-122`)
- Produces: `NON_MTN_CAPABLE: Record<string, MTNProviderName[]>` (now exported — was a private flat array before). Keys are the same three setting-key strings `NON_MTN_NETWORK_KEYS` already produces: `"telecel_provider_selection"`, `"at_ishare_provider_selection"`, `"at_bigtime_provider_selection"`. Task 5's `createNonMTNOrder()` does not import this directly (it goes through `getProviderNameForNetwork()`, whose external signature is unchanged), so no other task depends on this being exported — it is exported purely so the test in this task can assert on it directly without mocking Supabase.

- [ ] **Step 1: Write the failing test**

Create `lib/mtn-providers/factory.test.ts`:

```ts
import { NON_MTN_CAPABLE } from "./factory"

describe("NON_MTN_CAPABLE", () => {
  it("includes agentportalgh for Telecel", () => {
    expect(NON_MTN_CAPABLE.telecel_provider_selection).toContain("agentportalgh")
  })

  it("includes agentportalgh for AT-iShare", () => {
    expect(NON_MTN_CAPABLE.at_ishare_provider_selection).toContain("agentportalgh")
  })

  it("EXCLUDES agentportalgh for AT-BigTime", () => {
    expect(NON_MTN_CAPABLE.at_bigtime_provider_selection).not.toContain("agentportalgh")
  })

  it("keeps the original 4 providers capable for all three networks", () => {
    for (const key of ["telecel_provider_selection", "at_ishare_provider_selection", "at_bigtime_provider_selection"]) {
      expect(NON_MTN_CAPABLE[key]).toEqual(expect.arrayContaining(["datakazina", "xpress", "eazyghdata", "codecraft"]))
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/mtn-providers/factory.test.ts`
Expected: FAIL — `NON_MTN_CAPABLE` is not exported from `factory.ts` yet (import error / undefined).

- [ ] **Step 3: Implement the per-network capability map**

In `lib/mtn-providers/factory.ts`, replace lines 134-170:

```ts
const NON_MTN_CAPABLE: MTNProviderName[] = ["datakazina", "xpress", "eazyghdata", "codecraft"]

/**
 * Read the admin-selected provider for a non-MTN network (Telecel / AT-iShare / AT-BigTime).
 * Falls back to "codecraft" if the setting is absent or invalid. If the selected
 * (or default) provider is deactivated, falls through NON_MTN_CAPABLE in order to
 * the first active one — same fail-open pattern as getMTNProvider().
 */
export async function getProviderNameForNetwork(normalizedNetwork: string): Promise<MTNProviderName> {
    const settingKey = NON_MTN_NETWORK_KEYS[normalizedNetwork]
    if (!settingKey) return withNonMtnFallback("codecraft")

    try {
        const { data } = await supabase
            .from("admin_settings")
            .select("value")
            .eq("key", settingKey)
            .maybeSingle()

        const name = data?.value?.provider as MTNProviderName | undefined
        return withNonMtnFallback(name && NON_MTN_CAPABLE.includes(name) ? name : "codecraft")
    } catch {
        return withNonMtnFallback("codecraft")
    }
}

async function withNonMtnFallback(name: MTNProviderName): Promise<MTNProviderName> {
    const disabled = await getDisabledProviders()
    if (!disabled.has(name)) return name
    const fallback = NON_MTN_CAPABLE.find(p => !disabled.has(p))
    if (fallback) {
        console.warn(`[MTN-Factory] Non-MTN provider "${name}" is deactivated — falling back to "${fallback}"`)
        return fallback
    }
    console.error(`[MTN-Factory] All non-MTN-capable providers are deactivated — using "${name}" anyway (fail open)`)
    return name
}
```

with:

```ts
export const NON_MTN_CAPABLE: Record<string, MTNProviderName[]> = {
    telecel_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh"],
    at_ishare_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh"],
    at_bigtime_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft"],
}

/**
 * Read the admin-selected provider for a non-MTN network (Telecel / AT-iShare / AT-BigTime).
 * Falls back to "codecraft" if the setting is absent or invalid. If the selected
 * (or default) provider is deactivated, falls through NON_MTN_CAPABLE[settingKey] in
 * order to the first active one — same fail-open pattern as getMTNProvider().
 */
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
        return withNonMtnFallback(name && capable.includes(name) ? name : "codecraft", settingKey)
    } catch {
        return withNonMtnFallback("codecraft", settingKey)
    }
}

async function withNonMtnFallback(name: MTNProviderName, settingKey: string): Promise<MTNProviderName> {
    const capable = NON_MTN_CAPABLE[settingKey] ?? ["codecraft"]
    const disabled = await getDisabledProviders()
    if (!disabled.has(name)) return name
    const fallback = capable.find(p => !disabled.has(p))
    if (fallback) {
        console.warn(`[MTN-Factory] Non-MTN provider "${name}" is deactivated — falling back to "${fallback}"`)
        return fallback
    }
    console.error(`[MTN-Factory] All non-MTN-capable providers for "${settingKey}" are deactivated — using "${name}" anyway (fail open)`)
    return name
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/mtn-providers/factory.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `factory.ts`. In particular, confirm no other file in the repo imports `NON_MTN_CAPABLE` expecting the old flat-array shape (it was private/unexported before this change, so no external consumer can exist).

- [ ] **Step 6: Commit**

```bash
git add lib/mtn-providers/factory.ts lib/mtn-providers/factory.test.ts
git commit -m "feat(mtn-factory): per-network non-MTN provider capability, excluding agentportalgh from AT-BigTime"
```

---

### Task 3: Admin API — per-network provider validation

**Files:**
- Modify: `app/api/admin/settings/network-provider/route.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (this route only validates and writes to `admin_settings` — it does not call the factory).
- Produces: no exported interface consumed by later tasks. This task is independent of Tasks 1, 2, 5-9 and can be done in any order relative to them; it is sequenced here to keep the "enforce AT-BigTime exclusion" theme grouped with Task 2 and Task 4.

- [ ] **Step 1: Modify the route**

In `app/api/admin/settings/network-provider/route.ts`, replace line 11:

```ts
const VALID_PROVIDERS = ["datakazina", "xpress", "eazyghdata", "codecraft"]
```

with:

```ts
const VALID_PROVIDERS_BY_NETWORK: Record<string, string[]> = {
  telecel: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh"],
  at_ishare: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh"],
  at_bigtime: ["datakazina", "xpress", "eazyghdata", "codecraft"],
}
```

Then replace lines 46-48 (inside `POST`):

```ts
  if (!VALID_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: `Invalid provider. Use: ${VALID_PROVIDERS.join(", ")}` }, { status: 400 })
  }
```

with:

```ts
  const validProviders = VALID_PROVIDERS_BY_NETWORK[network] ?? []
  if (!validProviders.includes(provider)) {
    return NextResponse.json({ error: `Invalid provider for ${network}. Use: ${validProviders.join(", ")}` }, { status: 400 })
  }
```

Note: `network` (the raw request field, e.g. `"telecel"` / `"at_ishare"` / `"at_bigtime"`) is already validated against `NETWORK_KEYS` earlier in the same function (lines 42-45) before this point is reached, so it is safe to use directly as the lookup key into `VALID_PROVIDERS_BY_NETWORK` here.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `network-provider/route.ts`.

- [ ] **Step 3: Manual verification**

There is no test file for this route (no `app/**/*.test.ts` files exist in this codebase — routes are verified by reading the diff and by the admin UI's live behavior in Task 4). Re-read the modified file and confirm: `at_bigtime` + `agentportalgh` is rejected with a 400, `telecel` + `agentportalgh` and `at_ishare` + `agentportalgh` are both accepted, and all pre-existing (network, provider) combinations that worked before this change still return 200.

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/settings/network-provider/route.ts
git commit -m "fix(admin-api): reject agentportalgh as an AT-BigTime provider selection"
```

---

### Task 4: Admin UI — per-network provider selector

**Files:**
- Modify: `app/admin/settings/mtn/page.tsx:122`, `:1136-1141`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is a pure UI change against the existing `/api/admin/settings/network-provider` contract, which Task 3 already made agentportalgh-aware for telecel/at_ishare).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Update the `NonMTNProvider` type**

In `app/admin/settings/mtn/page.tsx`, replace line 122:

```ts
  type NonMTNProvider = "datakazina" | "xpress" | "eazyghdata" | "codecraft"
```

with:

```ts
  type NonMTNProvider = "datakazina" | "xpress" | "eazyghdata" | "codecraft" | "agentportalgh"
```

- [ ] **Step 2: Make the provider button grid per-network**

Replace lines 1136-1141:

```ts
              const providers: { value: NonMTNProvider; label: string; sub: string }[] = [
                { value: "codecraft", label: "CodeCraft", sub: "Default AT/Telecel API" },
                { value: "datakazina", label: "DataKazina", sub: "Multi-network" },
                { value: "xpress", label: "Xpress", sub: "Batch-enabled" },
                { value: "eazyghdata", label: "EazyGhData", sub: "Package-based" },
              ]
```

with:

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

Nothing else in this `.map(netKey => ...)` block changes — the rendering below (`providers.map(p => ...)`) already iterates whatever `providers` resolves to.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/admin/settings/mtn/page.tsx`. In particular, confirm `PROVIDER_LABELS[current]` (used at line ~1178) still type-checks — `PROVIDER_LABELS` is `Record<MTNProviderName, string>` (defined at line 883) and already contains an `agentportalgh: "AgentPortalGH"` entry, so no change is needed there.

- [ ] **Step 4: Manual verification**

No test file exists for this page (no `app/**/*.test.tsx` files in this codebase). Re-read the modified block and confirm: the Telecel and AT-iShare cards' `providers` array has 5 entries ending with AgentPortalGH; the AT-BigTime card's `providers` array still has exactly the original 4 entries with no AgentPortalGH tile.

- [ ] **Step 5: Commit**

```bash
git add app/admin/settings/mtn/page.tsx
git commit -m "feat(admin-ui): show AgentPortalGH as a Telecel/AT-iShare provider option, not AT-BigTime"
```

---

### Task 5: Shared non-MTN order dispatcher

**Files:**
- Create: `lib/non-mtn-fulfillment.ts`
- Test: Create `lib/non-mtn-fulfillment.test.ts`

**Interfaces:**
- Consumes: `atishareService.fulfillOrder(request: { phoneNumber: string; sizeGb: number; orderId: string; network?: string; orderType?: "wallet" | "shop" | "api" | "ussd" | "ussd_shop"; isBigTime?: boolean }): Promise<{ success: boolean; reference?: string; message?: string; errorCode?: string; statusCode?: number }>` (`lib/at-ishare-service.ts`, unchanged); `getProviderNameForNetwork(normalizedNetwork: string): Promise<MTNProviderName>`, `getProviderByName(name: MTNProviderName): MTNProvider`, `NETWORK_TO_REQUEST_NETWORK: Record<string, "Telecel" | "AirtelTigo">` (all from `lib/mtn-providers/factory.ts`, Task 2 changed the internals but not these signatures); `saveMTNTracking(orderId: string, mtnOrderId: number | string, request: MTNOrderRequest, response: MTNOrderResponse, orderType: "shop" | "bulk" | "api" | "ussd" | "ussd_shop", provider: string): Promise<string | null>` (`lib/mtn-fulfillment.ts:916`, unchanged).
- Produces: `normalizeNetworkKey(network: string): string` and `createNonMTNOrder(params: { phoneNumber: string; sizeGb: number; orderId: string; network: string; orderType: "wallet" | "shop" | "api" | "ussd" | "ussd_shop" }): Promise<{ success: boolean; message: string; reference?: string; provider: string }>`, both exported from `@/lib/non-mtn-fulfillment`. Tasks 6-9 import `createNonMTNOrder` with exactly this signature.

- [ ] **Step 1: Write the failing test for `normalizeNetworkKey`**

Create `lib/non-mtn-fulfillment.test.ts`:

```ts
import { normalizeNetworkKey } from "./non-mtn-fulfillment"

describe("normalizeNetworkKey", () => {
  it("normalizes AT-iShare variants (spaced, unspaced, lowercase)", () => {
    expect(normalizeNetworkKey("AT - iShare")).toBe("AT - ISHARE")
    expect(normalizeNetworkKey("AT-iShare")).toBe("AT - ISHARE")
    expect(normalizeNetworkKey("at - ishare")).toBe("AT - ISHARE")
    expect(normalizeNetworkKey("AT-ISHARE")).toBe("AT - ISHARE")
  })

  it("normalizes AT-BigTime variants (spaced, unspaced, lowercase)", () => {
    expect(normalizeNetworkKey("AT - BigTime")).toBe("AT - BIGTIME")
    expect(normalizeNetworkKey("AT-BigTime")).toBe("AT - BIGTIME")
    expect(normalizeNetworkKey("at - bigtime")).toBe("AT - BIGTIME")
    expect(normalizeNetworkKey("AT-BIGTIME")).toBe("AT - BIGTIME")
  })

  it("normalizes Telecel variants", () => {
    expect(normalizeNetworkKey("Telecel")).toBe("TELECEL")
    expect(normalizeNetworkKey("telecel")).toBe("TELECEL")
    expect(normalizeNetworkKey("TELECEL")).toBe("TELECEL")
  })

  it("falls back to AIRTELTIGO for a generic AirtelTigo label", () => {
    expect(normalizeNetworkKey("AirtelTigo")).toBe("AIRTELTIGO")
    expect(normalizeNetworkKey("AIRTELTIGO")).toBe("AIRTELTIGO")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/non-mtn-fulfillment.test.ts`
Expected: FAIL — `lib/non-mtn-fulfillment.ts` does not exist yet.

- [ ] **Step 3: Implement `lib/non-mtn-fulfillment.ts`**

```ts
import { atishareService } from "@/lib/at-ishare-service"
import { saveMTNTracking } from "@/lib/mtn-fulfillment"
import { getProviderNameForNetwork, getProviderByName, NETWORK_TO_REQUEST_NETWORK } from "@/lib/mtn-providers/factory"
import type { MTNOrderRequest } from "@/lib/mtn-providers/types"

export interface NonMTNOrderParams {
  phoneNumber: string
  sizeGb: number
  orderId: string
  /** Raw network label as stored on the order, e.g. "AT - iShare", "Telecel", "AT - BigTime". */
  network: string
  orderType: "wallet" | "shop" | "api" | "ussd" | "ussd_shop"
}

export interface NonMTNOrderResult {
  success: boolean
  message: string
  reference?: string
  provider: string
}

/** Canonicalize a raw non-MTN network label to the key format the factory's lookup tables use. */
export function normalizeNetworkKey(network: string): string {
  const upper = network.trim().toUpperCase()
  if (upper.includes("BIGTIME") || upper.includes("BIG TIME")) return "AT - BIGTIME"
  if (upper.includes("ISHARE") || upper.includes("I SHARE")) return "AT - ISHARE"
  if (upper.includes("TELECEL")) return "TELECEL"
  return "AIRTELTIGO"
}

// atishareService (CodeCraft) uses "wallet" for dashboard/bulk orders; saveMTNTracking
// (shared with the MTN path) calls the same concept "bulk". Everything else matches.
function toTrackingOrderType(orderType: NonMTNOrderParams["orderType"]): "shop" | "bulk" | "api" | "ussd" | "ussd_shop" {
  return orderType === "wallet" ? "bulk" : orderType
}

/**
 * Resolve the admin-selected provider for a non-MTN network (Telecel / AT-iShare /
 * AT-BigTime) and place the order with it. CodeCraft keeps going through
 * atishareService (its own polling/logging/notification pipeline, unchanged). Any
 * other provider goes through the generic MTNProvider.createOrder() path and gets a
 * mtn_fulfillment_tracking row saved so the existing per-provider sync crons (which
 * filter by provider, not network) can resolve it.
 */
export async function createNonMTNOrder(params: NonMTNOrderParams): Promise<NonMTNOrderResult> {
  const { phoneNumber, sizeGb, orderId, network, orderType } = params
  const normalizedKey = normalizeNetworkKey(network)
  const providerName = await getProviderNameForNetwork(normalizedKey)

  if (providerName === "codecraft") {
    const isBigTime = normalizedKey === "AT - BIGTIME"
    const apiNetwork = normalizedKey === "TELECEL" ? "TELECEL" : "AT"
    const result = await atishareService.fulfillOrder({
      phoneNumber, sizeGb, orderId, network: apiNetwork, orderType, isBigTime,
    })
    return { success: result.success, message: result.message || "", reference: result.reference, provider: "codecraft" }
  }

  const reqNetwork = NETWORK_TO_REQUEST_NETWORK[normalizedKey] ?? "AirtelTigo"
  const mtnRequest: MTNOrderRequest = {
    recipient_phone: phoneNumber,
    network: reqNetwork,
    size_gb: sizeGb,
    client_ref: orderId,
  }
  const provider = getProviderByName(providerName)
  const result = await provider.createOrder(mtnRequest)

  if (result.order_id) {
    await saveMTNTracking(orderId, result.order_id, mtnRequest, result, toTrackingOrderType(orderType), providerName)
  }

  return {
    success: result.success,
    message: result.message,
    reference: result.order_id?.toString(),
    provider: providerName,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/non-mtn-fulfillment.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `lib/non-mtn-fulfillment.ts`.

- [ ] **Step 6: Commit**

```bash
git add lib/non-mtn-fulfillment.ts lib/non-mtn-fulfillment.test.ts
git commit -m "feat(fulfillment): add createNonMTNOrder — shared, provider-selection-aware dispatcher for Telecel/AT-iShare/AT-BigTime orders"
```

---

### Task 6: Migrate the 2 already-correct call sites onto the shared dispatcher

**Files:**
- Modify: `lib/fulfillment-service.ts:211-291`
- Modify: `lib/ussd/fulfill.ts:105-166`

**Interfaces:**
- Consumes: `createNonMTNOrder(params: NonMTNOrderParams): Promise<NonMTNOrderResult>` from `@/lib/non-mtn-fulfillment` (Task 5).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Migrate `lib/fulfillment-service.ts`**

Replace lines 211-291 (the `if (isNonMTN) { ... }` block):

```ts
    if (isNonMTN) {
      const networkLower = orderData.network?.toLowerCase() || ""
      const isBigTime = networkLower.includes("bigtime")

      if (finalProvider === "codecraft") {
        console.log(`${logPrefix} Processing Codecraft manual fulfillment: ${normalizedNetwork}`)
        const { atishareService } = await import("@/lib/at-ishare-service")
        const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"

        try {
          const codecraftResponse = await atishareService.fulfillOrder({
            phoneNumber: phone,
            sizeGb: volumeGb,
            orderId: orderId,
            network: apiNetwork,
            orderType: orderType === "bulk" ? "wallet" : orderType === "api" ? "api" : "shop",
            isBigTime
          })

          if (!codecraftResponse.success) {
            console.error(`${logPrefix} Codecraft API failed: ${codecraftResponse.message}`)
            await supabase.from(tableName).update({ [statusField]: "pending", updated_at: new Date().toISOString() }).eq("id", orderId)
            if (!skipSms) import("@/lib/sms-service").then(({ notifyAdmins, SMSTemplates }) => {
              notifyAdmins(
                SMSTemplates.fulfillmentFailed(orderId.substring(0, 8), phone, orderData.network || "Codecraft", volumeGb.toString(), codecraftResponse.message || "Failed"),
                "fulfillment_failure", orderId, true
              ).catch(e => console.error(`${logPrefix} Admin SMS Error:`, e))
            })
            import("@/lib/push-service").then(({ notifyAdminsPush }) => {
              notifyAdminsPush({
                title: '⚠️ Fulfillment Failed',
                body: `${orderData.network || "Codecraft"} ${volumeGb}GB to ${phone} — ${codecraftResponse.message || "Failed"} (Order: ${orderId.substring(0, 8)})`,
                data: { url: '/admin/orders' },
              }).catch(() => { })
            }).catch(() => { })
            return { success: false, message: codecraftResponse.message || "Codecraft API Error", orderId }
          }

          return { success: true, message: "Codecraft API processing started", orderId, trackingId: codecraftResponse.reference }
        } catch (err: any) {
          console.error(`${logPrefix} Codecraft Error:`, err)
          await supabase.from(tableName).update({ [statusField]: "pending", updated_at: new Date().toISOString() }).eq("id", orderId)
          return { success: false, message: err.message || "Codecraft Internal error", orderId }
        }
      } else {
        // Non-CodeCraft provider (Xpress, Datakazina, EazyGhData) for non-MTN network
        console.log(`${logPrefix} Processing ${finalProvider} manual fulfillment: ${normalizedNetwork}`)
        const { getProviderByName, NETWORK_TO_REQUEST_NETWORK } = await import("@/lib/mtn-providers/factory")
        const p = getProviderByName(finalProvider as any)
        const reqNetwork = NETWORK_TO_REQUEST_NETWORK[normalizedNetwork] ?? "AirtelTigo"

        try {
          const result = await p.createOrder({ recipient_phone: phone, network: reqNetwork, size_gb: volumeGb, client_ref: orderId })

          if (!result.success) {
            console.error(`${logPrefix} ${finalProvider} API failed: ${result.message}`)
            await supabase.from(tableName).update({ [statusField]: "pending", updated_at: new Date().toISOString() }).eq("id", orderId)
            if (!skipSms) import("@/lib/sms-service").then(({ notifyAdmins, SMSTemplates }) => {
              notifyAdmins(
                SMSTemplates.fulfillmentFailed(orderId.substring(0, 8), phone, orderData.network || finalProvider!, volumeGb.toString(), result.message || "Failed"),
                "fulfillment_failure", orderId, true
              ).catch(e => console.error(`${logPrefix} Admin SMS Error:`, e))
            })
            import("@/lib/push-service").then(({ notifyAdminsPush }) => {
              notifyAdminsPush({
                title: '⚠️ Fulfillment Failed',
                body: `${orderData.network || finalProvider} ${volumeGb}GB to ${phone} — ${result.message || "Failed"} (Order: ${orderId.substring(0, 8)})`,
                data: { url: '/admin/orders' },
              }).catch(() => { })
            }).catch(() => { })
            return { success: false, message: result.message || `${finalProvider} API Error`, orderId }
          }

          return { success: true, message: `${finalProvider} processing started`, orderId, trackingId: result.order_id?.toString() }
        } catch (err: any) {
          console.error(`${logPrefix} ${finalProvider} Error:`, err)
          await supabase.from(tableName).update({ [statusField]: "pending", updated_at: new Date().toISOString() }).eq("id", orderId)
          return { success: false, message: err.message || `${finalProvider} internal error`, orderId }
        }
      }
    }
```

with:

```ts
    if (isNonMTN) {
      console.log(`${logPrefix} Processing ${finalProvider} manual fulfillment: ${normalizedNetwork}`)
      const { createNonMTNOrder } = await import("@/lib/non-mtn-fulfillment")

      try {
        const result = await createNonMTNOrder({
          phoneNumber: phone,
          sizeGb: volumeGb,
          orderId,
          network: orderData.network || normalizedNetwork,
          orderType: orderType === "bulk" ? "wallet" : orderType === "api" ? "api" : "shop",
        })

        if (!result.success) {
          console.error(`${logPrefix} ${result.provider} API failed: ${result.message}`)
          await supabase.from(tableName).update({ [statusField]: "pending", updated_at: new Date().toISOString() }).eq("id", orderId)
          if (!skipSms) import("@/lib/sms-service").then(({ notifyAdmins, SMSTemplates }) => {
            notifyAdmins(
              SMSTemplates.fulfillmentFailed(orderId.substring(0, 8), phone, orderData.network || result.provider, volumeGb.toString(), result.message || "Failed"),
              "fulfillment_failure", orderId, true
            ).catch(e => console.error(`${logPrefix} Admin SMS Error:`, e))
          })
          import("@/lib/push-service").then(({ notifyAdminsPush }) => {
            notifyAdminsPush({
              title: '⚠️ Fulfillment Failed',
              body: `${orderData.network || result.provider} ${volumeGb}GB to ${phone} — ${result.message || "Failed"} (Order: ${orderId.substring(0, 8)})`,
              data: { url: '/admin/orders' },
            }).catch(() => { })
          }).catch(() => { })
          return { success: false, message: result.message || `${result.provider} API Error`, orderId }
        }

        return { success: true, message: `${result.provider} processing started`, orderId, trackingId: result.reference }
      } catch (err: any) {
        console.error(`${logPrefix} ${finalProvider} Error:`, err)
        await supabase.from(tableName).update({ [statusField]: "pending", updated_at: new Date().toISOString() }).eq("id", orderId)
        return { success: false, message: err.message || `${finalProvider} internal error`, orderId }
      }
    }
```

Note: `finalProvider` (computed earlier in the function via `getProviderNameForNetwork`) is now only used for the catch-block message and the initial log line — `createNonMTNOrder` re-resolves the provider internally, which is redundant but harmless (same admin_settings read happens twice on the success path). This is acceptable: it keeps the diff minimal and this is not a hot path.

- [ ] **Step 2: Migrate `lib/ussd/fulfill.ts`**

Replace lines 122-166 (from `const { getProviderNameForNetwork, NETWORK_TO_REQUEST_NETWORK } = ...` through the closing of the `if (providerName === "codecraft") {...} else {...}` block):

```ts
      const { getProviderNameForNetwork, NETWORK_TO_REQUEST_NETWORK } = await import("@/lib/mtn-providers/factory")
      const providerName = await getProviderNameForNetwork(networkUpper)

      if (providerName === "codecraft") {
        const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"
        const { atishareService } = await import("@/lib/at-ishare-service")
        atishareService.fulfillOrder({
          phoneNumber: recipientPhone,
          sizeGb,
          orderId,
          network: apiNetwork,
          orderType: trackingOrderType,
          isBigTime,
        }).then(async (result) => {
          if (result.success) {
            await markUssdOrderStatus(orderId, 'processing', orderTable)
            console.log("[USSD-FULFILL] ✓ Codecraft order placed, awaiting cron confirmation:", orderId)
          } else {
            console.error("[USSD-FULFILL] Codecraft returned failure:", result.message)
            await markUssdOrderStatus(orderId, 'pending', orderTable)
          }
        }).catch(async (err: any) => {
          console.error("[USSD-FULFILL] Codecraft error:", err)
          await markUssdOrderStatus(orderId, 'pending', orderTable)
        })
        return { success: true, message: "Codecraft fulfillment triggered" }
      } else {
        const { getProviderByName } = await import("@/lib/mtn-providers/factory")
        const p = getProviderByName(providerName as any)
        const reqNetwork = NETWORK_TO_REQUEST_NETWORK[networkUpper] ?? "AirtelTigo"
        p.createOrder({ recipient_phone: recipientPhone, network: reqNetwork, size_gb: sizeGb, client_ref: orderId })
          .then(async (result) => {
            if (result.success) {
              await markUssdOrderStatus(orderId, 'processing', orderTable)
              console.log(`[USSD-FULFILL] ✓ ${providerName} order placed:`, orderId)
            } else {
              console.error(`[USSD-FULFILL] ${providerName} returned failure:`, result.message)
              await markUssdOrderStatus(orderId, 'pending', orderTable)
            }
          }).catch(async (err: any) => {
            console.error(`[USSD-FULFILL] ${providerName} error:`, err)
            await markUssdOrderStatus(orderId, 'pending', orderTable)
          })
        return { success: true, message: `${providerName} fulfillment triggered` }
      }
```

with:

```ts
      const { createNonMTNOrder } = await import("@/lib/non-mtn-fulfillment")
      createNonMTNOrder({
        phoneNumber: recipientPhone,
        sizeGb,
        orderId,
        network,
        orderType: trackingOrderType,
      }).then(async (result) => {
        if (result.success) {
          await markUssdOrderStatus(orderId, 'processing', orderTable)
          console.log(`[USSD-FULFILL] ✓ ${result.provider} order placed, awaiting cron confirmation:`, orderId)
        } else {
          console.error(`[USSD-FULFILL] ${result.provider} returned failure:`, result.message)
          await markUssdOrderStatus(orderId, 'pending', orderTable)
        }
      }).catch(async (err: any) => {
        console.error("[USSD-FULFILL] Non-MTN fulfillment error:", err)
        await markUssdOrderStatus(orderId, 'pending', orderTable)
      })
      return { success: true, message: "Non-MTN fulfillment triggered" }
```

`isBigTime` (computed at line 120, just above this block) becomes unused by this block after the edit — leave its declaration in place only if another part of the surrounding function still reads it; if this was its only use, remove the now-dead `const isBigTime = networkLower.includes("bigtime")` line (120) as part of this same edit, since `createNonMTNOrder` derives `isBigTime` internally from the network string itself.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `lib/fulfillment-service.ts` or `lib/ussd/fulfill.ts` — in particular, no "declared but never read" errors for `isBigTime` in `fulfill.ts` if it was removed correctly, and no leftover unused imports (`NETWORK_TO_REQUEST_NETWORK`, `getProviderByName`, `atishareService`) in either file if this was their only use in the file. Grep both files for each of those three names after editing — if a name has zero remaining references, remove its import.

- [ ] **Step 4: Commit**

```bash
git add lib/fulfillment-service.ts lib/ussd/fulfill.ts
git commit -m "refactor(fulfillment): route admin manual-fulfillment and USSD non-MTN orders through createNonMTNOrder"
```

---

### Task 7: Migrate 4 fire-and-forget order-creation call sites

**Files:**
- Modify: `app/api/orders/purchase/route.ts:383-411`
- Modify: `app/api/orders/create-bulk/route.ts:474-515`
- Modify: `app/api/wallet/debit/route.ts:268-292`
- Modify: `app/api/v1/orders/route.ts:257-281`

**Interfaces:**
- Consumes: `createNonMTNOrder(params: NonMTNOrderParams): Promise<NonMTNOrderResult>` from `@/lib/non-mtn-fulfillment` (Task 5).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Migrate `app/api/orders/purchase/route.ts`**

Replace lines 383-411:

```ts
        // Determine API network and endpoint based on order network
        const networkLower = normalizedNetwork.toLowerCase()
        const isBigTime = networkLower.includes("bigtime")
        const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"

        // Non-blocking fulfillment trigger
        console.log(`[FULFILLMENT] Calling atishareService.fulfillOrder with network: ${apiNetwork}, isBigTime: ${isBigTime}`)
        atishareService.fulfillOrder({
          phoneNumber,
          sizeGb,
          orderId: order[0].id,
          network: apiNetwork,
          orderType: "wallet",  // Wallet orders use orders table
          isBigTime,
        }).then(result => {
          console.log(`[FULFILLMENT] Fulfillment response for order ${order[0].id}:`, result)
        }).catch(err => {
          console.error(`[FULFILLMENT] Error triggering fulfillment for order ${order[0].id}:`, err)
          // Non-blocking: don't fail purchase if fulfillment fails
        })
      } catch (fulfillmentError) {
        console.error("[FULFILLMENT] Error in fulfillment trigger block:", fulfillmentError)
        // Non-blocking: continue with purchase even if fulfillment fails
      }
```

with:

```ts
        // Non-blocking fulfillment trigger — createNonMTNOrder resolves the admin's
        // selected provider for this network internally.
        console.log(`[FULFILLMENT] Calling createNonMTNOrder for network: ${normalizedNetwork}`)
        import("@/lib/non-mtn-fulfillment").then(({ createNonMTNOrder }) => createNonMTNOrder({
          phoneNumber,
          sizeGb,
          orderId: order[0].id,
          network: normalizedNetwork,
          orderType: "wallet",  // Wallet orders use orders table
        })).then(result => {
          console.log(`[FULFILLMENT] Fulfillment response for order ${order[0].id}:`, result)
        }).catch(err => {
          console.error(`[FULFILLMENT] Error triggering fulfillment for order ${order[0].id}:`, err)
          // Non-blocking: don't fail purchase if fulfillment fails
        })
      } catch (fulfillmentError) {
        console.error("[FULFILLMENT] Error in fulfillment trigger block:", fulfillmentError)
        // Non-blocking: continue with purchase even if fulfillment fails
      }
```

After this edit, check whether `atishareService` is imported at the top of this file and still used elsewhere in it (e.g. for the MTN branch or another block) — if this was its only use, remove the now-unused import.

- [ ] **Step 2: Migrate `app/api/orders/create-bulk/route.ts`**

Replace lines 474-515 (inside the `for (const order of createdOrders)` loop):

```ts
            console.log(`[BULK-FULFILLMENT] Starting async fulfillment for ${createdOrders.length} ${network} orders...`)
            const networkLower = normalizedNetwork.toLowerCase()
            const isBigTime = networkLower.includes("bigtime")
            const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"

            for (const order of createdOrders) {
              try {
                // Check blacklist
                if (order.queue === "blacklisted") {
                  console.log(`[BULK-FULFILLMENT] ⚠️ Order ${order.id} is in blacklist queue - skipping fulfillment`)
                  continue
                }

                const sizeGb = parseFloat(order.size) || 0
                if (sizeGb === 0) continue

                console.log(`[BULK-FULFILLMENT] Triggering ${apiNetwork} fulfillment for order ${order.id}: ${order.phone_number}, ${sizeGb}GB`)

                atishareService.fulfillOrder({
                  phoneNumber: order.phone_number,
                  sizeGb,
                  orderId: order.id,
                  network: apiNetwork,
                  orderType: "wallet", // Bulk creates orders in 'orders' table, same as wallet purchase
                  isBigTime,
                }).then(result => {
                  console.log(`[BULK-FULFILLMENT] Fulfillment result for order ${order.id}:`, result)
                }).catch(err => {
                  console.error(`[BULK-FULFILLMENT] Failed fulfillment for order ${order.id}:`, err)
                })

                // Small delay to prevent rate limits
                await new Promise(resolve => setTimeout(resolve, 300))

              } catch (err) {
                console.error(`[BULK-FULFILLMENT] Error in loop for order ${order.id}:`, err)
              }
            }
```

with:

```ts
            console.log(`[BULK-FULFILLMENT] Starting async fulfillment for ${createdOrders.length} ${network} orders...`)
            const { createNonMTNOrder } = await import("@/lib/non-mtn-fulfillment")

            for (const order of createdOrders) {
              try {
                // Check blacklist
                if (order.queue === "blacklisted") {
                  console.log(`[BULK-FULFILLMENT] ⚠️ Order ${order.id} is in blacklist queue - skipping fulfillment`)
                  continue
                }

                const sizeGb = parseFloat(order.size) || 0
                if (sizeGb === 0) continue

                console.log(`[BULK-FULFILLMENT] Triggering fulfillment for order ${order.id}: ${order.phone_number}, ${sizeGb}GB`)

                createNonMTNOrder({
                  phoneNumber: order.phone_number,
                  sizeGb,
                  orderId: order.id,
                  network: normalizedNetwork,
                  orderType: "wallet", // Bulk creates orders in 'orders' table, same as wallet purchase
                }).then(result => {
                  console.log(`[BULK-FULFILLMENT] Fulfillment result for order ${order.id}:`, result)
                }).catch(err => {
                  console.error(`[BULK-FULFILLMENT] Failed fulfillment for order ${order.id}:`, err)
                })

                // Small delay to prevent rate limits
                await new Promise(resolve => setTimeout(resolve, 300))

              } catch (err) {
                console.error(`[BULK-FULFILLMENT] Error in loop for order ${order.id}:`, err)
              }
            }
```

- [ ] **Step 3: Migrate `app/api/wallet/debit/route.ts`**

Replace lines 268-292:

```ts
          if (shouldFulfill) {
            try {
              const sizeGb = parseInt(shopOrder.volume_gb?.toString().replace(/[^0-9]/g, "") || "0") || 0
              const networkLower = normalizedNetwork.toLowerCase()
              const isBigTime = networkLower.includes("bigtime")
              const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"

              console.log(`[WALLET-DEBIT] Triggering fulfillment: ${apiNetwork}, ${sizeGb}GB to ${shopOrder.customer_phone}`)

              atishareService.fulfillOrder({
                phoneNumber: shopOrder.customer_phone,
                sizeGb,
                orderId: orderId,
                network: apiNetwork,
                orderType: "shop",
                isBigTime,
              }).then(result => {
                console.log(`[WALLET-DEBIT] ✓ Fulfillment response:`, result)
              }).catch(err => {
                console.error(`[WALLET-DEBIT] ❌ Fulfillment error:`, err)
              })
            } catch (fulfillmentError) {
              console.error("[WALLET-DEBIT] Error in fulfillment trigger:", fulfillmentError)
            }
          }
```

with:

```ts
          if (shouldFulfill) {
            try {
              const sizeGb = parseInt(shopOrder.volume_gb?.toString().replace(/[^0-9]/g, "") || "0") || 0

              console.log(`[WALLET-DEBIT] Triggering fulfillment: ${normalizedNetwork}, ${sizeGb}GB to ${shopOrder.customer_phone}`)

              import("@/lib/non-mtn-fulfillment").then(({ createNonMTNOrder }) => createNonMTNOrder({
                phoneNumber: shopOrder.customer_phone,
                sizeGb,
                orderId: orderId,
                network: normalizedNetwork,
                orderType: "shop",
              })).then(result => {
                console.log(`[WALLET-DEBIT] ✓ Fulfillment response:`, result)
              }).catch(err => {
                console.error(`[WALLET-DEBIT] ❌ Fulfillment error:`, err)
              })
            } catch (fulfillmentError) {
              console.error("[WALLET-DEBIT] Error in fulfillment trigger:", fulfillmentError)
            }
          }
```

- [ ] **Step 4: Migrate `app/api/v1/orders/route.ts`**

Replace lines 257-281:

```ts
  // B. AT / Telecel Fulfillment (CodeCraft)
  else {
    const fulfillableNetworks = ["AT - iShare", "AT-iShare", "AT - ishare", "at - ishare", "Telecel", "telecel", "TELECEL", "AT - BigTime", "AT-BigTime", "AT - bigtime", "at - bigtime"]
    const isAutoFulfillable = fulfillableNetworks.some(n => n.toLowerCase() === normalizedNetwork)
    
    if (isAutoFulfillable) {
      (async () => {
        try {
          const isBigTime = normalizedNetwork.includes("bigtime")
          const apiNetwork = normalizedNetwork.includes("telecel") ? "TELECEL" : "AT"
          
          atishareService.fulfillOrder({
            phoneNumber: cleanRecipient,
            sizeGb: volumeGb,
            orderId: orderId,
            network: apiNetwork,
            orderType: "api",
            isBigTime,
          }).catch(err => console.error("[API v1] CodeCraft fulfillment error:", err))
        } catch (err) {
          console.error("[API v1] CodeCraft trigger error:", err)
        }
      })()
    }
  }
```

with:

```ts
  // B. AT / Telecel Fulfillment
  else {
    const fulfillableNetworks = ["AT - iShare", "AT-iShare", "AT - ishare", "at - ishare", "Telecel", "telecel", "TELECEL", "AT - BigTime", "AT-BigTime", "AT - bigtime", "at - bigtime"]
    const isAutoFulfillable = fulfillableNetworks.some(n => n.toLowerCase() === normalizedNetwork)

    if (isAutoFulfillable) {
      (async () => {
        try {
          const { createNonMTNOrder } = await import("@/lib/non-mtn-fulfillment")
          await createNonMTNOrder({
            phoneNumber: cleanRecipient,
            sizeGb: volumeGb,
            orderId: orderId,
            network: normalizedNetwork,
            orderType: "api",
          })
        } catch (err) {
          console.error("[API v1] Non-MTN fulfillment trigger error:", err)
        }
      })()
    }
  }
```

Note: `.catch()` becomes a `try`/`await`/`catch` here because `createNonMTNOrder` is imported dynamically inside the same IIFE — this preserves the original "never throws out of this block" behavior with one fewer `.then()` chain link. The result is otherwise still fire-and-forget from the caller's perspective (the outer `(async () => {...})()` is not awaited).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing any of the 4 modified files. For each file, grep for `atishareService` — if this edit removed its only remaining use in that file, remove the now-unused top-level import (`import { atishareService } from "@/lib/at-ishare-service"` or equivalent).

- [ ] **Step 6: Commit**

```bash
git add app/api/orders/purchase/route.ts app/api/orders/create-bulk/route.ts app/api/wallet/debit/route.ts app/api/v1/orders/route.ts
git commit -m "fix(fulfillment): route dashboard/bulk/shop/api-v1 order creation through provider selection instead of hardcoding CodeCraft"
```

---

### Task 8: Migrate the fulfillment-trigger and retry routes

**Files:**
- Modify: `app/api/orders/fulfillment/route.ts:111-159` (POST handler), `:325-333` (`handleRetryFulfillment`)

**Interfaces:**
- Consumes: `createNonMTNOrder(params: NonMTNOrderParams): Promise<NonMTNOrderResult>` from `@/lib/non-mtn-fulfillment` (Task 5).
- Produces: nothing consumed by later tasks.

**IMPORTANT — read before starting:** unlike every other call site in this plan, this file's network-membership checks do not exclude MTN before reaching the CodeCraft-hardcoded call. `handleTriggerFulfillment`'s `supportedNetworks` (line 112) includes `"MTN"`, and its `networkMap` (line 1122) has an explicit `"MTN": "MTN"` entry — meaning this admin endpoint can currently be used to manually trigger an MTN order through CodeCraft's REST API directly, as a fallback path unrelated to the MTN provider factory. Likewise `handleRetryFulfillment`'s dispatch line (`networkLower.includes("mtn") ? "MTN" : ...`) shows it too can be reached for MTN orders. `createNonMTNOrder` has no MTN handling — `normalizeNetworkKey("MTN")` falls through to `"AIRTELTIGO"`, which would silently misroute an MTN trigger/retry to whatever provider is configured for Telecel. Both steps below therefore keep the MTN branch exactly as it was (byte-identical `atishareService.fulfillOrder` call) and route only the non-MTN branch through `createNonMTNOrder`.

- [ ] **Step 1: Migrate the POST handler**

Replace lines 139-159:

```ts
    // Extract size in GB
    const sizeGb = parseInt(order.size.toString().replace(/[^0-9]/g, "")) || 0

    // Normalize network name for API
    const networkMap: Record<string, string> = {
      "MTN": "MTN",
      "TELECEL": "TELECEL",
      "AT": "AT",
      "AT-iShare": "AT",
      "AT - iShare": "AT",
      "AT - ishare": "AT",
      "at - ishare": "AT",
    }
    // Normalize to uppercase before lookup
    const normalizedNetwork = order.network?.trim().toUpperCase() || "AT"
    const apiNetwork = networkMap[normalizedNetwork] || order.network || "AT"

    // Trigger fulfillment
    const result = await atishareService.fulfillOrder({
      phoneNumber: order.phone_number,
      sizeGb,
      orderId,
      network: apiNetwork,
    })
```

with:

```ts
    // Extract size in GB
    const sizeGb = parseInt(order.size.toString().replace(/[^0-9]/g, "")) || 0

    // Normalize network name for API
    const normalizedNetwork = order.network?.trim().toUpperCase() || "AT"

    // Trigger fulfillment. MTN keeps going through CodeCraft's REST API directly — an
    // existing admin fallback path unrelated to the MTN provider factory, unchanged
    // here. Only the non-MTN branch is resolved through the admin's per-network
    // provider selection.
    let result: { success: boolean; message?: string; reference?: string }
    if (normalizedNetwork === "MTN") {
      result = await atishareService.fulfillOrder({
        phoneNumber: order.phone_number,
        sizeGb,
        orderId,
        network: "MTN",
      })
    } else {
      const { createNonMTNOrder } = await import("@/lib/non-mtn-fulfillment")
      result = await createNonMTNOrder({
        phoneNumber: order.phone_number,
        sizeGb,
        orderId,
        network: order.network || "AT",
        orderType: "wallet",
      })
    }
```

Note: the original code called `atishareService.fulfillOrder` without an `orderType` field (it defaults to `"wallet"` inside `lib/at-ishare-service.ts:47`), and this route's `order` comes from the `orders` table (confirmed by the `.from("orders")` query earlier in the same handler) — so `orderType: "wallet"` here is the correct explicit equivalent of the old implicit default, not a behavior change.

- [ ] **Step 2: Migrate `handleRetryFulfillment`**

Replace lines 323-333:

```ts
    console.log(`[FULFILLMENT] Retrying with: phone=${order.phone_number}, size=${sizeGb}GB, network=${order.network}, isBigTime=${isBigTime}`)

    const result = await atishareService.fulfillOrder({
      phoneNumber: order.phone_number,
      sizeGb,
      orderId,
      network: networkLower.includes("mtn") ? "MTN" : 
               networkLower.includes("telecel") ? "TELECEL" : "AT",
      orderType,
      isBigTime,
    })
```

with:

```ts
    console.log(`[FULFILLMENT] Retrying with: phone=${order.phone_number}, size=${sizeGb}GB, network=${order.network}, isBigTime=${isBigTime}`)

    // MTN keeps going through CodeCraft's REST API directly — same pre-existing
    // fallback path as handleTriggerFulfillment above, unchanged here.
    let result: { success: boolean; message?: string; reference?: string }
    if (networkLower.includes("mtn")) {
      result = await atishareService.fulfillOrder({
        phoneNumber: order.phone_number,
        sizeGb,
        orderId,
        network: "MTN",
        orderType,
        isBigTime,
      })
    } else {
      const { createNonMTNOrder } = await import("@/lib/non-mtn-fulfillment")
      result = await createNonMTNOrder({
        phoneNumber: order.phone_number,
        sizeGb,
        orderId,
        network: order.network,
        orderType,
      })
    }
```

`networkLower` and `isBigTime` both stay in use (in the preserved MTN branch), so neither declaration becomes dead code from this edit.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing `app/api/orders/fulfillment/route.ts`. `atishareService` stays imported and used (the preserved MTN branches in both functions still call it) — do not remove its import.

- [ ] **Step 4: Commit**

```bash
git add app/api/orders/fulfillment/route.ts
git commit -m "fix(fulfillment): route manual fulfillment-trigger and retry through provider selection instead of hardcoding CodeCraft"
```

---

### Task 9: Migrate the remaining shop-order call sites

**Files:**
- Modify: `app/api/fulfillment/process-order/route.ts:186-205`
- Modify: `app/api/admin/payment-attempts/route.ts:565-581`

**Interfaces:**
- Consumes: `createNonMTNOrder(params: NonMTNOrderParams): Promise<NonMTNOrderResult>` from `@/lib/non-mtn-fulfillment` (Task 5).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Migrate `app/api/fulfillment/process-order/route.ts`**

Replace lines 186-205:

```ts
          // Import dynamically to avoid top-level issues
          const { atishareService } = await import("@/lib/at-ishare-service")
          
          const sizeGbStr = verifiedVolumeGb.toString().replace(/[^0-9]/g, "")
          const sizeGb = parseInt(sizeGbStr) || 0
          const networkLower = verifiedNetwork.toLowerCase()
          const isBigTime = networkLower.includes("bigtime")
          const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"
          
          // Trigger Codecraft fulfillment asynchronously
          atishareService.fulfillOrder({
            phoneNumber: verifiedPhonePrefix,
            sizeGb,
            orderId: shop_order_id,
            network: apiNetwork,
            orderType: "shop",
            isBigTime,
          }).catch(err => {
            console.error("[FULFILLMENT] Codecraft async error:", err)
          })

          return NextResponse.json({
            success: true,
            message: "CodeCraft auto-fulfillment triggered successfully",
            fulfillment_method: "auto_codecraft",
          })
```

with:

```ts
          // Import dynamically to avoid top-level issues
          const { createNonMTNOrder } = await import("@/lib/non-mtn-fulfillment")

          const sizeGbStr = verifiedVolumeGb.toString().replace(/[^0-9]/g, "")
          const sizeGb = parseInt(sizeGbStr) || 0

          // Trigger fulfillment asynchronously — createNonMTNOrder resolves the
          // admin's selected provider for this network internally.
          createNonMTNOrder({
            phoneNumber: verifiedPhonePrefix,
            sizeGb,
            orderId: shop_order_id,
            network: verifiedNetwork,
            orderType: "shop",
          }).catch(err => {
            console.error("[FULFILLMENT] Non-MTN async error:", err)
          })

          return NextResponse.json({
            success: true,
            message: "Auto-fulfillment triggered successfully",
            fulfillment_method: "auto_codecraft",
          })
```

Leave the `fulfillment_method: "auto_codecraft"` value as-is — it is a stored/logged label consumed elsewhere for provider-agnostic "this was auto-fulfilled via the non-MTN path" bookkeeping (confirmed by its other use at the manual-fulfillment branch a few lines below, which uses `fulfillment_method: "manual"` as the only other value), not a claim that CodeCraft specifically was used.

- [ ] **Step 2: Migrate `app/api/admin/payment-attempts/route.ts`**

Replace lines 565-581:

```ts
          if (sizeGb > 0) {
            const isBigTime = networkLower.includes("bigtime")
            const apiNetwork = networkLower.includes("telecel") ? "TELECEL" : "AT"

            atishareService.fulfillOrder({
              phoneNumber: shopOrderData.customer_phone,
              sizeGb,
              orderId: attempt.order_id,
              network: apiNetwork,
              orderType: "shop",
              isBigTime,
            }).then(result => {
              console.log(`[ADMIN-PAYMENT-ATTEMPTS] ✓ Fulfillment triggered for order ${attempt.order_id}:`, result)
            }).catch(err => {
              console.error(`[ADMIN-PAYMENT-ATTEMPTS] ❌ Fulfillment error for order ${attempt.order_id}:`, err)
            })
          }
```

with:

```ts
          if (sizeGb > 0) {
            import("@/lib/non-mtn-fulfillment").then(({ createNonMTNOrder }) => createNonMTNOrder({
              phoneNumber: shopOrderData.customer_phone,
              sizeGb,
              orderId: attempt.order_id,
              network: shopOrderData.network,
              orderType: "shop",
            })).then(result => {
              console.log(`[ADMIN-PAYMENT-ATTEMPTS] ✓ Fulfillment triggered for order ${attempt.order_id}:`, result)
            }).catch(err => {
              console.error(`[ADMIN-PAYMENT-ATTEMPTS] ❌ Fulfillment error for order ${attempt.order_id}:`, err)
            })
          }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors referencing either file. Grep both for `atishareService` and `isBigTime`/`apiNetwork`/`networkLower` — remove any import or local variable that has no remaining reads after this edit (check `networkLower` carefully in `payment-attempts/route.ts`: it is also used a few lines above at `const isMTNNetwork = networkLower === "mtn"`, so it must stay — only remove variables truly unused after the edit).

- [ ] **Step 4: Commit**

```bash
git add app/api/fulfillment/process-order/route.ts app/api/admin/payment-attempts/route.ts
git commit -m "fix(fulfillment): route shop-order auto-fulfillment and payment-attempt retries through provider selection instead of hardcoding CodeCraft"
```

---

## Self-Review Notes

**Spec coverage:** §1 (AgentPortalGH network-aware creation) → Task 1. §2 (factory per-network capability) → Task 2. §3 (admin API validation) → Task 3. §4 (admin UI) → Task 4. §5 (shared dispatcher + tracking-gap fix) → Task 5. §6 (migrate all 9 call sites) → Tasks 6-9. All spec sections are covered.

**Placeholder scan:** No TBD/TODO markers. Every step shows exact before/after code, not a description of what to do.

**Hazard check (added during self-review):** verified for all 9 call sites that the block being migrated to `createNonMTNOrder` is unreachable for MTN-network orders — `createNonMTNOrder`/`normalizeNetworkKey` has no MTN handling and would misroute an MTN order to the Telecel provider if one ever reached it. Confirmed mutually-exclusive gating (a separate `isMTN`/`isMTNNetwork` check before/around the edited block) in `lib/fulfillment-service.ts` (line 94 `isMTN` vs. line 97 `isNonMTN`, disjoint by construction), `lib/ussd/fulfill.ts` (line 57 `isMTN` vs. line 107 `isNonMTN`, disjoint), and all of `app/api/orders/purchase/route.ts`, `app/api/orders/create-bulk/route.ts` (line 361 `isMTNNetwork`, separate block), `app/api/wallet/debit/route.ts`, `app/api/v1/orders/route.ts` (explicit `if (normalizedNetwork === "mtn") {...} else {...}`), `app/api/fulfillment/process-order/route.ts`, and `app/api/admin/payment-attempts/route.ts`. The one exception is `app/api/orders/fulfillment/route.ts` (Task 8), whose `supportedNetworks`/`networkMap` checks do **not** exclude MTN — Task 8's steps were written to explicitly preserve the original MTN branch (byte-identical `atishareService.fulfillOrder` call) and route only the non-MTN branch through `createNonMTNOrder`, rather than assuming the same disjoint-gating pattern held there too.

**Type consistency:** `createNonMTNOrder`'s parameter shape (`phoneNumber`, `sizeGb`, `orderId`, `network`, `orderType`) and return shape (`success`, `message`, `reference`, `provider`) as defined in Task 5 are used identically — same field names — across Tasks 6, 7, 8, and 9. `NonMTNOrderParams.orderType` (`"wallet" | "shop" | "api" | "ussd" | "ussd_shop"`) matches every call site's existing `orderType` vocabulary from before this migration (no call site needs to change what value it passes, only which function it calls). `NON_MTN_CAPABLE`'s three keys (Task 2) match `NON_MTN_NETWORK_KEYS`'s three setting-key output values exactly, and match `VALID_PROVIDERS_BY_NETWORK`'s three keys in Task 3 (`telecel`/`at_ishare`/`at_bigtime` there vs. `telecel_provider_selection`/`at_ishare_provider_selection`/`at_bigtime_provider_selection` in Task 2 — these are deliberately different strings at different layers, matching the pre-existing `NETWORK_KEYS` vs. `NON_MTN_NETWORK_KEYS` naming split already in the codebase before this plan).