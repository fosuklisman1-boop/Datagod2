# SPFastIT Provider (AT-iShare only) — Design

## Goal

Add SPFastIT as a 9th data-bundle fulfillment provider, capable of AT-iShare (AirtelTigo) only — never selectable as an MTN provider (primary, retry sequence, or disabled-providers list), enforced by the type system rather than by convention, since this codebase has already shipped a provider-visible-in-the-wrong-dropdown bug once (Apex Prime's `PROVIDER_LABELS`).

## Context

- `lib/mtn-providers/types.ts` currently exports `MTNProviderName` as a flat union of the 8 existing providers, used identically by both MTN-only selection (`getMTNProvider`, `getRetrySequence`, `getDisabledProviders`, `WHITELIST_REGISTRY`) and non-MTN dispatch (`createNonMTNOrder`, `getProviderByName`, `NON_MTN_CAPABLE`). There's no existing mechanism to register a provider capable of only a non-MTN network.
- `lib/mtn-providers/factory.ts`: `NON_MTN_CAPABLE: Record<string, MTNProviderName[]>` already separates per-network capability from the flat provider list (`at_ishare_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"]`) — the natural extension point for a new AT-iShare-only entry, but its value type needs widening to accept a provider outside `MTNProviderName`.
- `lib/non-mtn-fulfillment.ts`'s `createNonMTNOrder()` is the shared non-MTN dispatcher: resolves a provider name via `getProviderNameForNetwork()`/`isProviderCapableForNetwork()`, then (for every provider except CodeCraft, which keeps its own dedicated `atishareService` pipeline) calls the generic `getProviderByName(providerName).createOrder(mtnRequest)` and saves a `mtn_fulfillment_tracking` row — this is the path SPFastIT joins; no dedicated pipeline needed.
- `app/admin/settings/mtn/page.tsx` (~line 143) currently declares a local `NonMTNProvider` type alias (a 6-member subset of `MTNProviderName`) used only by the per-network provider-selector cards (~line 1339-1404). The AT-iShare and Telecel cards currently share one options list (`nonBigTimeProviders`); AT-BigTime uses a narrower `baseProviders` list.
- `app/api/admin/settings/network-provider/route.ts`: `VALID_PROVIDERS_BY_NETWORK` is a second, independent copy of the same per-network capability data (server-side validation for the network-provider POST endpoint) — must stay in sync with `NON_MTN_CAPABLE`.
- `app/api/cron/sync-mtn-status/apexprime/route.ts` is the template for a new provider's status-sync cron: ~90% boilerplate (fetch pending/processing tracking rows for this provider, call `checkMTNOrderStatus(mtn_order_id, providerName)`, reconcile order-table status, notify the customer) with only the provider-name string and a top comment differing between providers. `lib/mtn-fulfillment.ts`'s `checkMTNOrderStatus(mtnOrderId, providerName?)` already dispatches via `getProviderByName(providerName as any)` — the `as any` means no type change is needed there.
- `app/api/cron/check-mtn-balance/route.ts` and `app/api/admin/fulfillment/mtn-balance/route.ts` both directly instantiate every provider class and check balances in parallel — today's live incident (Sykes silently at a negative wallet balance, discovered only by reading raw provider error messages) is exactly the failure mode this integration point exists to catch early; SPFastIT should be included here even though it's not MTN-capable.
- `vercel.json`'s `crons` array has one entry per provider's sync route, `schedule: "* * * * *"` (every minute) for every provider except the whitelist-retry/balance-check crons which run less often — new entry follows the same minute-by-minute pattern.
- SPFastIT's API (docs provided by the user) is form-urlencoded (`-d "key=value"` curl style, not JSON) — the one provider in this codebase that isn't JSON-bodied. Confirmed via the docs: `POST /api/send.php` (create), `POST /api/check_order_status.php` (status), `POST /api/check_balance.php` (balance), all authenticated via a flat `api_key` POST field (not a header).
- **Reference-reuse safety** (directly informed by this week's incidents with AgentPortalGH/ApexPrime/DataKazina/Bisdel all silently rejecting a resubmitted `client_ref` with no safe way to verify what happened to the original attempt): SPFastIT's `client_reference` field is explicitly documented as idempotent-safe — reusing the same reference with the same phone+bundle returns the *existing* transaction (`"duplicate": true`) rather than erroring, and only produces a "Reference Conflict" when the same reference is paired with a *different* phone/bundle (which cannot happen here, since our reference is always a unique order UUID). This lets SPFastIT reuse `client_ref` freely on retries without the double-fulfillment risk the other 4 providers carry.

## Design

### 1. Type widening — `lib/mtn-providers/types.ts`

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

### 2. `lib/mtn-providers/spfastit-provider.ts` (new)

Follows the existing per-provider file shape (`BisdelProvider`/`ApexPrimeProvider` as the closest templates: retry-on-429 loop, `authHeaders()` helper, exported pure mapping functions for testability). Key differences from existing providers: form-urlencoded POST bodies (`URLSearchParams`, not `JSON.stringify`), and the reference-reuse-aware `createOrder`.

```ts
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
  // queued, processing, pending_retry — all still in flight
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

  async checkBalance(): Promise<number | null> {
    try {
      const res = await apiFetch("/api/check_balance.php", {})
      if (!res.ok) return null
      const json = await res.json()
      if (json.status !== "success") return null
      const mb = json.available_mb
      return typeof mb === "number" ? mb / 1024 : null // GB, matching every other provider's checkBalance() unit
    } catch {
      return null
    }
  }
}

export default SPFastITProvider
```

Notes:
- **Correction (caught in Task 2's code review, applied to the implementation):** the claim originally here — that `validatePhoneNetworkMatch` could be skipped because CodeCraft/DataKazina's non-MTN dispatch path doesn't validate it — was factually wrong. All 8 existing providers, including `datakazina-provider.ts` and `codecraft-provider.ts`, call `validatePhoneNetworkMatch(recipient_phone, network)` unconditionally in `createOrder`, and `non-mtn-fulfillment.ts` populates a real `network` value on the request it passes to them. SPFastIT's implementation was corrected to include this same check, matching every other provider.
- `checkBalance()` divides by 1024 to normalize MB → GB, matching the unit every other provider's `checkBalance()` returns (confirmed by reading `sykes-provider.ts`/`bisdel-provider.ts`'s balance parsing — both return a raw currency/GB-scale number, and the balance-check cron's low-balance threshold comparison assumes a consistent unit across providers). *(Self-review note: SPFastIT's balance is in data volume (GB), not currency, unlike every other provider's wallet balance in cedis — flagged explicitly in Task section below so the plan doesn't silently conflate the two.)*

### 3. `lib/mtn-providers/factory.ts`

```ts
// Existing MTN-only functions (getMTNProvider, getSelectedProvider, getRetrySequence,
// getDisabledProviders) — UNCHANGED, still typed to MTNProviderName.

export function getProviderByName(name: NonMTNProviderName): MTNProvider {
  switch (name) {
    // ...existing 8 cases unchanged...
    case "spfastit":
      return new SPFastITProvider()
  }
}

export const NON_MTN_CAPABLE: Record<string, NonMTNProviderName[]> = {
  telecel_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime"],
  at_ishare_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "spfastit"],
  at_bigtime_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft"],
}

export async function getProviderNameForNetwork(normalizedNetwork: string): Promise<NonMTNProviderName> { /* body unchanged — return type widens naturally via NON_MTN_CAPABLE */ }

export function isProviderCapableForNetwork(normalizedNetwork: string, provider: NonMTNProviderName): boolean { /* unchanged body */ }
```

### 4. `lib/non-mtn-fulfillment.ts`

`NonMTNOrderParams.providerOverride?: MTNProviderName` → `NonMTNProviderName`. The local `let providerName: MTNProviderName` → `NonMTNProviderName`. No other logic changes — the existing capability check (`isProviderCapableForNetwork`) already correctly rejects an admin override that isn't valid for the resolved network, which is exactly what keeps an explicit "spfastit for Telecel" mistake from ever reaching the provider.

### 5. Admin settings routes & UI

- `app/api/admin/settings/network-provider/route.ts`: `VALID_PROVIDERS_BY_NETWORK.at_ishare` gains `"spfastit"`; `telecel` and `at_bigtime` arrays unchanged.
- `app/admin/settings/mtn/page.tsx`: replace the local `NonMTNProvider` type alias with an import of the new `NonMTNProviderName` from `@/lib/mtn-providers/types` (removes a duplicate/drift-prone local type). The per-network card loop gains a 4th, AT-iShare-specific options list:
  ```ts
  const ishareProviders: { value: NonMTNProviderName; label: string; sub: string }[] = [
    ...nonBigTimeProviders,
    { value: "spfastit", label: "SPFastIT", sub: "AirtelTigo-only" },
  ]
  const providers = netKey === "at_bigtime" ? baseProviders : netKey === "at_ishare" ? ishareProviders : nonBigTimeProviders
  ```
  Telecel keeps exactly the current 6-option `nonBigTimeProviders` list unchanged; only the AT-iShare card gains the 7th option.

### 6. Status-sync cron — `app/api/cron/sync-mtn-status/spfastit/route.ts` (new)

Byte-for-byte copy of `app/api/cron/sync-mtn-status/apexprime/route.ts` with `"apexprime"` → `"spfastit"` (provider filter, log prefixes, function doc comment) and the reversal-detection block (`fetchReversalCandidates`/`isReversal`/`flagReversal`) — included for consistency with every other provider's cron even though a reversal (provider flips a *completed* order to failed after the fact) is a lower-probability event for a brand-new provider; keeping the same shape avoids this being the one cron an admin has to remember behaves differently.

### 7. `vercel.json`

New entry alongside the other 7 provider sync crons:
```json
{ "path": "/api/cron/sync-mtn-status/spfastit", "schedule": "* * * * *" }
```

### 8. Balance monitoring

- `app/api/cron/check-mtn-balance/route.ts`: add `new SPFastITProvider().checkBalance()` to the existing `Promise.all([...])`, add `spfastit` to the destructured results.
- `app/api/admin/fulfillment/mtn-balance/route.ts`: same pattern (mirrors the cron's structure with its own separate `Promise.all`).
- **Units decision**: SPFastIT's balance is data volume (GB of bundle remaining), not currency — every other provider's balance is money (cedis), compared against the shared currency-denominated `config.balanceAlertThreshold`. Reusing that same numeric threshold for SPFastIT's GB balance would silently compare unlike units (e.g. a real "5 GB left" reading being judged against a "₵500" threshold). SPFastIT gets its own separate, GB-denominated threshold instead: a `SPFASTIT_LOW_BALANCE_GB` env var (default `5`), checked independently of `balanceAlertThreshold`/`sykesLow`/etc. Both balance surfaces label it explicitly as "SPFastIT: X GB remaining" (never "₵X") so the unit is never ambiguous to whoever reads the alert or the admin balance page.

### 9. Credential handling

`SPFASTIT_API_KEY` — set directly in Vercel's environment variables by the user (not by me, not committed anywhere, not echoed in any file this plan creates). `SPFASTIT_BASE_URL` optional override, defaulting to `https://console.spfastit.com`, matching the `AGENTPORTALGH_BASE_URL`/`CODECRAFT_API_URL` precedent.

## Testing

- Unit tests for `mapSpfastitStatus` (all 7 documented status values + an unknown-string fallback) — matches the existing `mapItemStatus`/`normalizeStatus` test convention in sibling provider test files.
- No test for the `createOrder`/`checkOrderStatus`/`checkBalance` HTTP methods themselves (matches every existing provider — none of them fetch-mock the full HTTP round trip; only pure helpers get unit tests in this codebase).
- Manual verification: place one real AT-iShare order end-to-end via the admin settings AT-iShare provider card (select SPFastIT, confirm an order dispatches and the status-sync cron eventually reconciles it), and confirm `getProviderByName("spfastit")` is unreachable from any MTN-only admin flow (primary provider dropdown, retry-sequence add button, disabled-providers toggle) by inspection — these render from `PROVIDER_LABELS: Record<MTNProviderName, string>`, which the plan does not touch, so `"spfastit"` cannot type-check into any of them.
