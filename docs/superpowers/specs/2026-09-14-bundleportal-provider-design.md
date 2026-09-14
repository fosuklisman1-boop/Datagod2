# Bundle Portal Provider — Design

## Goal

Add Bundle Portal as a new, full-member MTN/Telecel/AirtelTigo fulfillment provider — the intended long-term replacement for CodeCraft as the go-to non-MTN provider — with webhook support, `verify_number` whitelist integration, all three independently-catalogued MTN delivery routes (`mtn`/`mtn_2`/`mtn_3`, admin picks one active route at a time), and AT-BigTime coverage (undocumented but confirmed via a direct live order against Bundle Portal's own test tooling, at the user's explicit instruction). Airtime integration is explicitly out of scope — deferred to a separate follow-up design.

## Context

- **Provider docs are authoritative; the `bp_test_` sandbox tool is not the same system.** During this design's investigation, live calls against a `bp_test_*` key produced request/response shapes that directly contradicted the official docs (e.g. `package_size` — the documented field — returned `unknown_bundle` on every network, while an undocumented `size` string field worked; retrying the same `order_id` silently created a second charge instead of returning `duplicate:true`). The `bp_test_` tool exposes actions (`get_scenarios`, `reset_test_balance`, phone-suffix-driven scenario steering) that appear nowhere in the docs, confirming it's a separate, informally-documented harness, not the production code path. This design follows the pasted official docs as ground truth throughout — the one deliberate exception is AT-BigTime (see below).
- **AT-BigTime is undocumented but explicitly requested.** The docs' `place_order` field table lists exactly five `network` values: `mtn`, `mtn_2`, `mtn_3`, `telecel`, `airteltigo` (or `ishare`). `bigtime` never appears in the docs. However, a live order was successfully placed against it via the `bp_test_` tool (`network: "bigtime"`, real catalog from 20GB–500GB, `NON-EXPIRY` validity, order placed and appeared in `get_transactions`). Per direct user instruction, `bigtime` is included as a network value alongside the five documented ones, flagged in code as undocumented-but-confirmed so a future `unknown_bundle`/network-rejection error on this specific value is recognized immediately rather than mistaken for a general outage.
- **This is the first generic-interface provider to support AT-BigTime.** `lib/non-mtn-fulfillment.ts`'s `normalizeNetworkKey()` already distinguishes `"AT - BIGTIME"` from `"AT - ISHARE"`/`"AIRTELTIGO"`, but `lib/mtn-providers/factory.ts`'s `NETWORK_TO_REQUEST_NETWORK` collapses all three into one shared `MTNOrderRequest.network: "AirtelTigo"` value — the reason no generic `MTNProvider`-interface provider (Apex Prime, AgentPortalGH) has ever been able to support BigTime; only CodeCraft can, because it bypasses the shared interface entirely via its own `atishareService.fulfillOrder({ isBigTime })` path. This design adds one new **optional** field, `isBigTime?: boolean`, to `MTNOrderRequest` (`lib/mtn-providers/types.ts`) rather than widening the `network` union itself — every other existing provider (8 of them) simply never reads the new field, so this is a zero-behavior-change addition for all of them. `non-mtn-fulfillment.ts` sets it from the already-computed `normalizedKey`.
- **Idempotency is real and load-bearing.** The docs explicitly guarantee: "Always send your own `order_id`. If a reply is lost and you retry with the same `order_id`, you get the original order back with `\"duplicate\": true` — you are not charged twice." This puts Bundle Portal in the same *safe-retry* class as SPFastIT (`docs/superpowers/specs/2026-09-14-spfastit-provider-design.md`), unlike AgentPortalGH/ApexPrime/DataKazina/Bisdel, which hard-reject a resubmitted reference with no safe way to confirm the original outcome. Because `check_status` looks orders up by this same client-supplied `order_reference` — not by Bundle Portal's own internal `reference` (e.g. `"KT-88213"`) — the natural design is to use our own order UUID as the *entire* tracking identity: no provider-returned id needs to be parsed or stored, unlike every other provider in this codebase (SPFastIT stores `transaction_id`, Apex Prime stores `bundle:<id>`/`store:<id>:<uuid>`). `order_id` must always be sent, even though the docs mark it optional — it's the only thing that makes both retry-safety and status lookup work, so `createOrder` generates a fresh UUID if `request.client_ref` is somehow absent (same fallback Apex Prime already uses for its own `reference` field).
- **Single-endpoint API.** Unlike every existing provider (one base URL + a path per action), Bundle Portal is one endpoint (`POST https://api.bundleportal.com/v1`) with an `action` field in the JSON body routing internally. `apiFetch` needs no `path` parameter — just the JSON body.
- **`lib/mtn-providers/apexprime-provider.ts`'s `FULFILLMENT_PATH_KEYS` pattern (admin_settings-backed selector) is the direct template for the 3-way MTN route choice** — same shape (one `admin_settings` row, read once per order), just 3 options instead of 2, and scoped to MTN only (the docs are explicit the three routes are "separate catalogues" that "can vary" from each other, unlike Telecel/AirtelTigo/BigTime which each get one fixed network value).
- **`lib/mtn-providers/provider-whitelist.ts`'s `WHITELIST_REGISTRY` pattern** is the template for `verify_number` integration: an entry with `configured()`/`check()`/`checkBatch()`, added to the registry array. `verify_number`'s response (`allowed`, `can_order`, `pending_order`) is richer than other providers' pass/fail whitelist checks — only `allowed` feeds the registry's pre-check gate (the "is this number approved yet" question the registry exists to answer); `can_order`/`pending_order` describe a transient in-flight-order state, not a permanent approval gate, and are surfaced in logs rather than folded into `allowed`.
- **`app/api/webhooks/mtn/agentportalgh/route.ts` + `lib/mtn-providers/agentportalgh-webhook-processor.ts`** is the reference webhook implementation: `after()` from `next/server` guarantees post-response processing completes (Vercel can freeze a function immediately after its response is sent, silently dropping bare fire-and-forget work — confirmed live 2026-07-26 on this exact codebase), HMAC-SHA256 signature verification via `crypto.timingSafeEqual`. Bundle Portal's processor is substantially simpler than AgentPortalGH's: the webhook payload's `order_id` field is documented as our own client-supplied reference directly, so lookup is a single `mtn_fulfillment_tracking.mtn_order_id = payload.order_id` query — no phone+size fallback matching, no ambiguous-sibling guard, no items array to iterate (one order per webhook delivery, not a batch).
- **Full member, not structurally excluded.** Unlike SPFastIT (AT-iShare only, kept out of `MTNProviderName` by design), Bundle Portal is capable on MTN, Telecel, AirtelTigo, and BigTime — it goes directly into the base `MTNProviderName` union, selectable everywhere: primary provider, retry sequence, disabled-providers toggle, `WHITELIST_REGISTRY`, and all three non-MTN network selectors.
- **Balance is currency (GHS)**, same convention as every provider except SPFastIT — no special unit handling needed in the balance-monitoring cron, unlike SPFastIT's GB-denominated carve-out.
- **Error/status handling is unusually well-specified.** The docs provide a full HTTP-status × error-code table with explicit retry guidance per code (e.g. `409 pending_order` / `429` / `503` are "retry-later, not permanent"; `403 not_allowlisted` should read as "pending approval," never a generic failure; `500`/`503` retries must reuse the exact same `order_id`). This is the richest error contract of any provider in this codebase and is followed directly rather than inferred.

## Design

### 1. Type changes — `lib/mtn-providers/types.ts`

```ts
export interface MTNOrderRequest {
    recipient_phone: string
    network: "MTN" | "Telecel" | "AirtelTigo"
    size_gb: number
    traceId?: string
    client_ref?: string
    /**
     * True only for an AT-BigTime order (network is still "AirtelTigo" — this
     * codebase has no separate network value for BigTime vs. iShare). Every
     * existing provider ignores this field; only Bundle Portal reads it, to
     * pick its own distinct "bigtime" network value over "airteltigo".
     */
    isBigTime?: boolean
}

export type MTNProviderName = "sykes" | "datakazina" | "xpress" | "eazyghdata" | "bisdel" | "codecraft" | "agentportalgh" | "apexprime" | "bundleportal"

export type NonMTNProviderName = MTNProviderName | "spfastit"
```

### 2. `lib/mtn-providers/bundleportal-provider.ts` (new)

Closest templates: Apex Prime (dual/multi-path selector via `admin_settings`, `crypto.randomUUID()` reference fallback) and SPFastIT (safe-retry idempotency handling). Key differences: single-endpoint action-routed API (JSON body, not per-path REST), and status lookup keyed entirely on our own reference (no provider-id parsing at all).

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
 * Portal's own `network` value. bigtime is undocumented (confirmed via a
 * live test order, not the official docs — see design doc context) so it's
 * kept as a distinct literal rather than folded into "airteltigo", making
 * any future rejection of this specific value easy to recognize.
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

/** True for a documented retry-later business rejection (not a hard failure). */
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

  // ── Admin / auxiliary — used by the whitelist registry (Task 6) ───────────

  async verifyNumber(phone: string, network: string): Promise<any> {
    const res = await apiCall({ action: "verify_number", network, recipient: normalizePhoneNumber(phone) })
    if (!res.ok) throw new Error(`Bundle Portal verify_number API error ${res.status}`)
    return res.json()
  }
}

export default BundlePortalProvider
```

Notes:
- `error_type: "RETRYABLE"` is a new value (existing providers use `"VALIDATION" | "NETWORK_ERROR" | "API_ERROR"` inconsistently as free-form strings — `MTNOrderResponse.error_type` is already untyped `string`, so this needs no type change). **Confirmed this is diagnostic-only, matching every existing provider**: `error_type` is set throughout `lib/mtn-fulfillment.ts`/every provider file but never read anywhere to gate retry-sequence behavior — the shared retry dispatcher just checks `result.success`. So `"RETRYABLE"` distinguishes a `409 pending_order`/`429`/`503`-class rejection from a hard failure in logs only; it does not by itself stop the retry sequence from trying the next provider for a number Bundle Portal has one in flight for. If that cross-cutting behavior is wanted later, it requires a separate change to the shared retry dispatcher (out of scope here — would affect all 9 providers' retry semantics, not just this one).
- `check_balance`'s response is currency (GHS) — no GB/unit conversion, unlike SPFastIT.

### 3. `lib/mtn-providers/factory.ts`

```ts
// getSelectedProvider()'s validation list, VALID_PROVIDERS, getMTNProvider()'s
// switch, and getProviderByName()'s switch each gain a "bundleportal" case,
// following the exact shape of the existing "apexprime" entries.

const VALID_PROVIDERS: MTNProviderName[] = ["sykes", "datakazina", "xpress", "eazyghdata", "bisdel", "codecraft", "agentportalgh", "apexprime", "bundleportal"]

export const NON_MTN_CAPABLE: Record<string, NonMTNProviderName[]> = {
  telecel_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "bundleportal"],
  at_ishare_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "agentportalgh", "apexprime", "spfastit", "bundleportal"],
  at_bigtime_provider_selection: ["datakazina", "xpress", "eazyghdata", "codecraft", "bundleportal"],
}
```

`isProviderCapableForNetwork`/`getProviderNameForNetwork`/`getRetrySequence`/`getDisabledProviders` bodies are unchanged — they already operate generically over these lists/unions.

### 4. `lib/non-mtn-fulfillment.ts`

`createNonMTNOrder`'s `mtnRequest` construction gains the new field:

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

No other logic changes — `isBigTime` is `false` for every non-BigTime network, and every provider except Bundle Portal ignores the field entirely.

### 5. MTN route admin API — `app/api/admin/bundleportal/route.ts` (new)

Mirrors `app/api/admin/apexprime/route.ts`'s shape (GET for reads, POST for admin actions), scoped to this provider's own settings:

- `GET ?action=mtn-route` → current `bundleportal_mtn_route` setting.
- `GET ?action=balance` → `checkBalance()`.
- `POST { action: "set-mtn-route", route }` → validates `route` is `"mtn" | "mtn_2" | "mtn_3"`, upserts `admin_settings` row `bundleportal_mtn_route`.
- `POST { action: "register-webhook", webhookUrl }` → calls `set_webhook`, returns the one-time `webhook_secret` in the response (never stored anywhere by this route — the admin copies it into `BUNDLEPORTAL_WEBHOOK_SECRET` themselves, matching the "shown once" constraint in the docs).

### 6. Whitelist integration — `lib/mtn-providers/provider-whitelist.ts`

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

async function checkBundlePortalBatch(msisdns: string[]): Promise<Array<{ msisdn: string; allowed: boolean; reason?: string }>> {
  // No native batch endpoint — verify sequentially, matching Apex Prime's approach.
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

Added to `WHITELIST_REGISTRY`:

```ts
{
  name: "bundleportal",
  configured: () => !!process.env.BUNDLEPORTAL_API_KEY,
  check: checkBundlePortal,
  checkBatch: checkBundlePortalBatch,
},
```

### 7. Webhook — `app/api/webhooks/mtn/bundleportal/route.ts` + `lib/mtn-providers/bundleportal-webhook-processor.ts` (new)

Route mirrors `agentportalgh`'s exactly (`after()`-guarded processing, HMAC verification, same response shape), header name changed to Bundle Portal's documented `X-BundlePortal-Signature`.

Processor is substantially simpler than AgentPortalGH's, since `payload.order_id` IS our own reference directly:

```ts
export async function processWebhook(payload: any) {
  const newStatus = mapBundlePortalStatus(payload.status)
  const ref = payload.order_id
  if (!ref) {
    console.warn("[WEBHOOK-BUNDLEPORTAL] Payload missing order_id, cannot process:", payload.event)
    return
  }

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
  if ((tracking.status === "completed" || tracking.status === "failed") && newStatus !== tracking.status) return
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
  // order_type branching (bulk/api/ussd/ussd_shop/shop) and
  // sendPushToUser-on-terminal-status call as
  // agentportalgh-webhook-processor.ts's processItem (lines 190-251) —
  // reused verbatim, this provider has no phone+size fallback to complicate it.
}
```

`verifySig` is copied from `agentportalgh-webhook-processor.ts` unchanged (identical `sha256=<hex>` HMAC-SHA256 scheme).

### 8. Admin UI — `app/admin/settings/mtn/page.tsx`

- The local `MTNProviderName` type (line ~135) and local `NonMTNProvider` type (line ~143) — confirmed still present as independent literal unions, not imports from `@/lib/mtn-providers/types` — each gain `"bundleportal"` as a new member, matching how `"apexprime"`/`"spfastit"` were already added to them.
- `PROVIDER_LABELS` gains `bundleportal: "Bundle Portal"`.
- All three per-network selector lists (`baseProviders`, `nonBigTimeProviders`, `ishareProviders`) gain a Bundle Portal entry — unlike SPFastIT (iShare-only, one list) or Apex Prime/AgentPortalGH (excluded from `baseProviders`/BigTime), Bundle Portal is added to all three since it's capable everywhere.
- New settings card (placed in Bundle Portal's own provider tab, following Apex Prime's fulfillment-path card as the closest layout template): a 3-option radio/select for the active MTN route (`mtn` / `mtn_2` / `mtn_3`), calling the new `app/api/admin/bundleportal/route.ts` `set-mtn-route` action.

### 9. Admin UI — `app/admin/order-payment-status/page.tsx`

`getProviderOptionsForNetwork` gains Bundle Portal on every branch (MTN and non-MTN, including BigTime — unlike `apexprime`/`agentportalgh` which are explicitly excluded from the BigTime branch today):

```ts
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

### 10. `app/api/admin/settings/network-provider/route.ts`

`VALID_PROVIDERS_BY_NETWORK` gains `"bundleportal"` on all three arrays (`telecel`, `at_ishare`, `at_bigtime`), matching `NON_MTN_CAPABLE` in factory.ts exactly (these two lists are documented as needing to stay in sync — see SPFastIT design doc §Context).

### 11. Status-sync cron — `app/api/cron/sync-mtn-status/bundleportal/route.ts` (new)

Byte-for-byte copy of `app/api/cron/sync-mtn-status/apexprime/route.ts` with `"apexprime"` → `"bundleportal"` (provider filter, log prefixes, doc comment), including the reversal-detection block for consistency with every other provider's cron. Given webhooks are the primary channel for this provider (`after()`-guaranteed delivery, documented as reliable enough that "most integrations that use webhooks never call check_status at all"), this cron acts as the same kind of fallback safety net it already is for every other provider — not the primary resolution path.

### 12. `vercel.json`

New entry alongside the other 8 provider sync crons:
```json
{ "path": "/api/cron/sync-mtn-status/bundleportal", "schedule": "* * * * *" }
```

### 13. Balance monitoring

- `app/api/cron/check-mtn-balance/route.ts` and `app/api/admin/fulfillment/mtn-balance/route.ts`: add `new BundlePortalProvider().checkBalance()` to the existing `Promise.all([...])`, add `bundleportal` to the destructured results, `balances`, and `lows` objects. No separate unit-denominated threshold needed (currency, same as the shared `threshold`) — unlike SPFastIT's GB carve-out.

### 14. Credential handling

- `BUNDLEPORTAL_API_KEY` — set directly in Vercel by the user, never committed.
- `BUNDLEPORTAL_WEBHOOK_SECRET` — obtained via the new admin route's `register-webhook` action (one-time, shown once by Bundle Portal), then set in Vercel by the user the same way.
- `BUNDLEPORTAL_BASE_URL` — optional override, defaults to `https://api.bundleportal.com/v1`.

## Testing

- Unit tests for the pure helpers: `mapNetworkToBundlePortal` (all 4 network inputs × BigTime flag × all 3 MTN routes), `mapBundlePortalStatus` (all 4 documented statuses + unknown fallback), `isRetryableErrorCode` (each documented retryable code + a non-retryable one), `getActiveMtnRoute` (valid/invalid/missing setting).
- `verifySig` (webhook signature) tested directly with a known secret + body + expected HMAC, plus a tampered-body rejection case — matches the existing `agentportalgh-webhook-processor.test.ts` convention if one exists, otherwise a new test file following the same shape.
- `processWebhook`'s terminal-status guard (completed never regresses) tested against a fake Supabase client, mirroring the whitelist pre-check tests in `mtn-fulfillment.test.ts`.
- No test for `createOrder`/`checkOrderStatus`/`checkBalance`'s HTTP round trip itself (matches every existing provider convention).
- Manual verification once `BUNDLEPORTAL_API_KEY` is live: place one real order on each of the three MTN routes, one Telecel order, one AirtelTigo order, and one BigTime order via the admin per-network provider selectors; confirm the webhook fires and resolves the tracking row before the 1-minute cron would have; confirm a deliberately-duplicated `order_id` (e.g. by re-triggering admin fulfillment on the same order) returns the original order rather than double-charging.
