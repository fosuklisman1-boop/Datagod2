# AgentPortalGH Multi-Network Support + Non-MTN Provider Routing Fix — Design

## Goal

1. AgentPortalGH currently only ever submits orders with `service: "mtn"`. It actually supports Telecel and AirtelTigo (which covers both AT-iShare and AT-BigTime from its API's perspective) — but per business decision, AgentPortalGH should only be offered as a Telecel/AT-iShare provider, **not** AT-BigTime.
2. Separately, 7 order-creation call sites hardcode CodeCraft directly for all non-MTN networks (Telecel/AT-iShare/AT-BigTime), completely bypassing the admin's per-network provider selection. Only 2 call sites (`lib/fulfillment-service.ts`, `lib/ussd/fulfill.ts`) actually consult the selection. Fix all 7 so the admin's choice is honored everywhere, and add AgentPortalGH as a valid choice for Telecel/AT-iShare.

## Context

- `lib/mtn-providers/agentportalgh-provider.ts` implements the `MTNProvider` interface. `createOrder()`/`buildQueuePayload()` hardcode `service: "mtn"`. `checkOrderStatus()` and its helpers (`hasAmbiguousSibling`, day-scoped date search, `findFinalItemForPhone`, `fetchAllOrderItems`, `deriveOrderStatus`) are a hardened phone+size+day matching scheme built across multiple past incidents — they never reference `network`/`service`, so they already work regardless of which network an order was submitted under. **This file's status-checking logic must not change.**
- AgentPortalGH's official order-placement API (`POST /api/queue/add`) takes a `service` field: `"mtn"` (1–200GB), `"telecel"` (10–200GB), `"airteltigo"` (1–200GB — covers both AT-iShare and AT-BigTime from the provider's own perspective). Items: `{msisdn, data_gb (whole numbers), reference}`. Response: `{added, charged, balance, rejected: [{msisdn, reason}]}`. 402 = insufficient balance, 400 = validation error.
- `lib/mtn-providers/codecraft-provider.ts:56-70` is the existing precedent for network-aware order creation inside a proper `MTNProvider` class: maps `order.network` (`"MTN" | "Telecel" | "AirtelTigo"`, per `lib/mtn-providers/types.ts:10`) to CodeCraft's own network field via a ternary.
- `lib/mtn-providers/factory.ts` resolves the provider for a non-MTN network via `getProviderNameForNetwork(normalizedNetwork)`, which maps the raw network string to one of three `admin_settings` keys (`NON_MTN_NETWORK_KEYS`: `telecel_provider_selection`, `at_ishare_provider_selection`, `at_bigtime_provider_selection` — Telecel and AirtelTigo both map to `telecel_provider_selection`), then validates the stored choice against a flat `NON_MTN_CAPABLE: MTNProviderName[] = ["datakazina", "xpress", "eazyghdata", "codecraft"]` list, falling back to `"codecraft"`. `withNonMtnFallback()` re-checks disabled providers and falls through the same flat list.
- `app/api/admin/settings/network-provider/route.ts` has a parallel flat `VALID_PROVIDERS` array used to validate the admin's POST when setting a network's provider.
- `app/admin/settings/mtn/page.tsx` renders one shared 4-item `providers` array identically for all three network cards (Telecel / AT-iShare / AT-BigTime) inside a single `.map(netKey => ...)` loop. `NonMTNProvider` type is `"datakazina" | "xpress" | "eazyghdata" | "codecraft"`.
- 7 call sites hardcode CodeCraft directly by calling `atishareService.fulfillOrder()` (`lib/at-ishare-service.ts`, the old non-`MTNProvider`-interface CodeCraft-only REST client) without ever consulting `getProviderNameForNetwork()`:
  - `app/api/orders/purchase/route.ts:340-411`
  - `app/api/orders/create-bulk/route.ts:451-516`
  - `app/api/wallet/debit/route.ts:258-292`
  - `app/api/v1/orders/route.ts:257-281`
  - `app/api/orders/fulfillment/route.ts:111-159` (POST handler) and `:288-333` (`handleRetryFulfillment`)
  - `app/api/fulfillment/process-order/route.ts:148-213`
  - `app/api/admin/payment-attempts/route.ts:540-582`
- 2 call sites already do it correctly, via the same dispatch shape:
  ```ts
  const providerName = await getProviderNameForNetwork(normalizedKey)
  if (providerName === "codecraft") {
    atishareService.fulfillOrder({ phoneNumber, sizeGb, orderId, network: apiNetwork, orderType, isBigTime })
  } else {
    const p = getProviderByName(providerName)
    const reqNetwork = NETWORK_TO_REQUEST_NETWORK[normalizedKey] ?? "AirtelTigo"
    p.createOrder({ recipient_phone: phoneNumber, network: reqNetwork, size_gb: sizeGb, client_ref: orderId })
  }
  ```
  — `lib/fulfillment-service.ts:185-291` (admin manual/retry fulfillment) and `lib/ussd/fulfill.ts:105-166` (USSD channel).
- **Discovered gap**: in both of the "correct" call sites above, the `else` (non-CodeCraft) branch never calls `saveMTNTracking()`. For MTN-network orders, `lib/mtn-fulfillment.ts:createMTNOrder()` always saves a `mtn_fulfillment_tracking` row, which is what lets the per-provider sync crons (e.g. `app/api/cron/sync-mtn-status/agentportalgh/route.ts`, which queries `mtn_fulfillment_tracking` filtered only by `provider = "agentportalgh"` — no network filter) find and resolve the order. For non-MTN orders routed to a non-CodeCraft provider, no tracking row is ever written, so the order is marked "processing" and never checked again. This is a pre-existing dormant bug (already true today for Xpress/DataKazina/EazyGhData whenever selected for Telecel/AT-iShare/AT-BigTime) that becomes load-bearing for AgentPortalGH, since its entire status-matching design depends on tracking rows existing. `saveMTNTracking(orderId, mtnOrderId, request, response, orderType, provider)` (`lib/mtn-fulfillment.ts:916`) is already fully network-agnostic — it just stores whatever `request.network` and `provider` are given.
- `createMTNOrder()` (`lib/mtn-fulfillment.ts:340`) is MTN-network-specific (registration gate, whitelist pre-check, admin-configured retry sequence) and is not a template to extend for non-MTN — those concerns don't apply to Telecel/AT-iShare/AT-BigTime.

## Design

### 1. AgentPortalGH: network-aware order creation only

In `lib/mtn-providers/agentportalgh-provider.ts`, change `buildQueuePayload()` to accept the network and map it to `service`, mirroring CodeCraft's exact pattern:

```ts
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

`createOrder()` passes `request.network` through at its existing call site:
```ts
body: JSON.stringify(buildQueuePayload(phone, request.size_gb, reference, request.network)),
```

No other change to this file. `checkOrderStatus()` and every helper it calls are untouched.

### 2. Factory: per-network provider capability (AT-BigTime exclusion)

In `lib/mtn-providers/factory.ts`, replace the flat `NON_MTN_CAPABLE` with a map keyed by the same setting keys `NON_MTN_NETWORK_KEYS` already produces:

```ts
const NON_MTN_CAPABLE: Record<string, MTNProviderName[]> = {
    telecel_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh"],
    at_ishare_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh"],
    at_bigtime_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft"],
}
```

`getProviderNameForNetwork()` and `withNonMtnFallback()` change to look up the capability list by `settingKey` instead of a shared flat array:

```ts
export async function getProviderNameForNetwork(normalizedNetwork: string): Promise<MTNProviderName> {
    const settingKey = NON_MTN_NETWORK_KEYS[normalizedNetwork]
    if (!settingKey) return "codecraft"

    try {
        const { data } = await supabase
            .from("admin_settings")
            .select("value")
            .eq("key", settingKey)
            .maybeSingle()

        const capable = NON_MTN_CAPABLE[settingKey] ?? []
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

(The `!settingKey` branch is unreachable in practice — every caller normalizes to one of the six keys in `NON_MTN_NETWORK_KEYS` — this just preserves the existing fail-safe default of `"codecraft"` without a fabricated setting key.)

### 3. Admin API validation (`app/api/admin/settings/network-provider/route.ts`)

Apply the same per-network split to the POST validator:

```ts
const VALID_PROVIDERS_BY_NETWORK: Record<string, string[]> = {
  telecel: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh"],
  at_ishare: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh"],
  at_bigtime: ["datakazina", "xpress", "eazyghdata", "codecraft"],
}
```

The POST handler looks up the list for the request's `network` value (already validated against `NETWORK_KEYS`) and rejects `provider` values not in that network's list — so a direct API call cannot set `agentportalgh` on `at_bigtime` even bypassing the UI.

### 4. Admin UI (`app/admin/settings/mtn/page.tsx`)

- `NonMTNProvider` type gains `"agentportalgh"`.
- The per-network provider button grid changes from one shared `providers` array to a per-`netKey` list:
  ```ts
  const providersByNetwork: Record<typeof netKey, { value: NonMTNProvider; label: string; sub: string }[]> = {
    telecel: [...baseFour, { value: "agentportalgh", label: "AgentPortalGH", sub: "Webhook-first" }],
    at_ishare: [...baseFour, { value: "agentportalgh", label: "AgentPortalGH", sub: "Webhook-first" }],
    at_bigtime: baseFour,
  }
  ```
  where `baseFour` is the existing codecraft/datakazina/xpress/eazyghdata array, unchanged. Each network card renders `providersByNetwork[netKey]` instead of the shared array.

### 5. New shared dispatcher: `lib/non-mtn-fulfillment.ts`

A single function replaces the duplicated CodeCraft/generic-provider branch that currently exists independently in 2 places (and needs to exist in 7 more):

```ts
import { atishareService } from "@/lib/at-ishare-service"
import { saveMTNTracking } from "@/lib/mtn-fulfillment"
import { getProviderNameForNetwork, getProviderByName, NETWORK_TO_REQUEST_NETWORK } from "@/lib/mtn-providers/factory"
import type { MTNOrderRequest } from "@/lib/mtn-providers/types"

interface NonMTNOrderParams {
  phoneNumber: string
  sizeGb: number
  orderId: string
  network: string // raw label, e.g. "AT - iShare", "Telecel", "AT - BigTime", "AirtelTigo"
  orderType: "wallet" | "shop" | "api" | "ussd" | "ussd_shop"
}

interface NonMTNOrderResult {
  success: boolean
  message: string
  reference?: string
  provider: string
}

function normalizeNetworkKey(network: string): string {
  const upper = network.trim().toUpperCase()
  if (upper.includes("BIGTIME") || upper.includes("BIG TIME")) return "AT - BIGTIME"
  if (upper.includes("ISHARE") || upper.includes("I SHARE")) return "AT - ISHARE"
  if (upper.includes("TELECEL")) return "TELECEL"
  return "AIRTELTIGO"
}

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
    await saveMTNTracking(orderId, result.order_id, mtnRequest, result, orderType, providerName)
  }

  return {
    success: result.success,
    message: result.message,
    reference: result.order_id?.toString(),
    provider: providerName,
  }
}
```

This is the fix for the tracking gap in §Context: every non-CodeCraft path now saves a tracking row, so the existing per-provider sync crons (already network-agnostic — they filter by `provider`, not by network) pick these orders up exactly like they do for MTN.

`orderType` values match what `saveMTNTracking` already accepts (`"shop" | "bulk" | "api" | "ussd" | "ussd_shop"`); call sites that currently pass `"wallet"` to `atishareService.fulfillOrder` map that to `"bulk"` when calling `saveMTNTracking` (the codecraft branch keeps using `"wallet"` for `atishareService`, unaffected).

### 6. Migrate all 9 call sites

**7 broken sites** — replace the inline `atishareService.fulfillOrder({...})` call with `createNonMTNOrder({...})`, preserving each site's existing control flow (fire-and-forget `.then()/.catch()` vs. `await`ed-and-branched):

- `app/api/orders/purchase/route.ts:390-402` (fire-and-forget)
- `app/api/orders/create-bulk/route.ts:492-503` (fire-and-forget, inside a loop)
- `app/api/wallet/debit/route.ts:277-288` (fire-and-forget)
- `app/api/v1/orders/route.ts:268-275` (fire-and-forget)
- `app/api/orders/fulfillment/route.ts:154-159` (awaited, branches on `result.success` for the HTTP response) and `:325-333` (same, in `handleRetryFulfillment`)
- `app/api/fulfillment/process-order/route.ts:196-205` (fire-and-forget). The surrounding `isCodecraft` network-membership check (`fulfillableNetworks.includes(normalizedNetwork)`) and the atomic `shop_orders` lock stay exactly as-is — they gate whether to attempt auto-fulfillment at all vs. queue for manual, which is unrelated to which provider ultimately handles it. Only the dynamic `import("@/lib/at-ishare-service")` + `atishareService.fulfillOrder(...)` call inside that gated block is replaced with `createNonMTNOrder({...})`.
- `app/api/admin/payment-attempts/route.ts:569-580` (fire-and-forget)

**2 already-correct sites** — replace their inline `if (providerName === "codecraft") {...} else {...}` block with a single `createNonMTNOrder({...})` call, both to close the tracking gap and to remove the now-duplicated logic:

- `lib/fulfillment-service.ts:211-291`
- `lib/ussd/fulfill.ts:105-166`

None of these 9 call sites need to change how they compute `phoneNumber`/`sizeGb`/`orderId`/`orderType` — only the dispatch call itself changes.

## Out of scope

- `checkOrderStatus()` and its helpers in `agentportalgh-provider.ts` — confirmed network-agnostic, not touched.
- Extending `createMTNOrder()`'s MTN-only features (registration gate, whitelist, retry sequence) to non-MTN networks — not requested, not applicable.
- Backfilling tracking rows for non-CodeCraft non-MTN orders already stuck in "processing" from before this fix — none are known to exist today (the gap was dormant), and this is a forward-looking correctness fix, not an incident remediation.
- Any change to `lib/at-ishare-service.ts` itself (the CodeCraft REST client) — it keeps working exactly as today; `createNonMTNOrder()` simply calls it as one branch.