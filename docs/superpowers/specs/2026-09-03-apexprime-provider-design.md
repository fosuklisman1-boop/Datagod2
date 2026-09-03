# Apex Prime Provider — Design

## Goal

Add Apex Prime as a new MTN/Telecel/AT-iShare fulfillment provider (8th `MTNProviderName`), with two distinguishing capabilities no existing provider has: (1) a per-network admin toggle between two different underlying fulfillment mechanisms — "GroupShare" (arbitrary-GB send against a pre-purchased balance) and "Store" (fixed-catalog purchase) — and (2) an instant, synchronous phone-number verification endpoint, wired into the existing multi-provider whitelist system.

## Context

- Full API docs pasted by the user (verbatim, this conversation) for `https://apexprime.club/api/v1`: `/wallet` (balance check), `/transactions`, `/send-bundle`, `/store-products`, `/store-order`, `/afa-registration` (out of scope — not requested), `/status`, `/verify-number`, plus a webhook event `order_status_update`.
- Auth: `Authorization: Bearer <api_key>` header (or `api_key` in the body — header preferred, matching existing provider conventions in this codebase).
- `lib/mtn-providers/agentportalgh-provider.ts` is the closest existing template: webhook-first provider with a polling-cron fallback, admin-facing auxiliary methods beyond the bare `MTNProvider` interface, and its own admin UI tab.
- `lib/mtn-providers/factory.ts`: `MTNProviderName` union, `VALID_PROVIDERS` array, `NON_MTN_CAPABLE` per-network-key capability map (as of the 2026-09-01 fix, this map is the *only* thing that governs non-MTN provider eligibility — no disabled-provider fallback walks it anymore), `getProviderByName()` switch.
- `lib/mtn-providers/provider-whitelist.ts`: `WHITELIST_REGISTRY` — an array of `{name, configured(), check(phone)}` entries. All 3 consumers (`lib/mtn-fulfillment.ts`'s order-time gate, `app/api/cron/mtn-whitelist-retry/route.ts`'s 24h retry, `app/api/admin/mtn-whitelist/batch-verify/route.ts`'s admin bulk tool) iterate this array generically — adding a provider needs exactly one registry entry, no consumer changes.
- `mtn_fulfillment_tracking` table: polymorphic `order_id`/`shop_order_id`/`api_order_id` columns (by `order_type`), plus `mtn_order_id` (the provider's external order id, stored as text), `provider`, `status`, `api_request_payload`/`api_response_payload` (jsonb). This is the single source every per-provider sync cron and the admin fulfillment-logs UI reads from.
- Existing unsigned-webhook precedent: Datakazina's webhook route authenticates via a shared secret in the URL (`?token=<DATAKAZINA_WEBHOOK_SECRET>` or an `x-webhook-token` header), constant-time compared, since Datakazina never had a signing scheme.
- Resolved via Q&A this session:
  - Apex Prime is excluded from AT-BigTime (their API never mentions BigTime anywhere — wallet balances, send-bundle, store products all only cover MTN/Telecel/Ishare).
  - The GroupShare/Store choice is a **per-network** toggle (not one global switch).
  - The Store path's product-to-GB mapping is resolved via a **live lookup** against `/store-products` at order time — no catalog sync/cache.
  - The verify-number endpoint joins `WHITELIST_REGISTRY` as a new entry — no bespoke UI/flow beyond what that registry already provides for free.
  - Apex Prime's webhook is genuinely unsigned (confirmed) — authenticated via a shared-secret query param, same as Datakazina.

## Design

### 1. Provider class — `lib/mtn-providers/apexprime-provider.ts`

Implements `MTNProvider` (`createOrder`/`checkOrderStatus`/`checkBalance`), plus admin-facing auxiliary methods (`getWalletSummary()`, `getTransactions()`) in the same style as `agentportalgh-provider.ts`'s auxiliary methods.

`name = "apexprime"`.

**`checkBalance()`** returns `balances.Main_Wallet.amount` (a GHS number) from `POST /wallet` — matching every other provider's single-GHS-number contract. `getWalletSummary()` (admin-only, not part of `MTNProvider`) returns the full `{MTN, Telecel, Ishare, AFA, Main_Wallet}` breakdown for display on the admin tab.

### 2. Order creation — the GroupShare/Store dual path

Three new `admin_settings` keys, one per eligible network:
- `apexprime_mtn_fulfillment_path`
- `apexprime_telecel_fulfillment_path`
- `apexprime_ishare_fulfillment_path`

Each holds `{ path: "groupshare" | "store" }`, defaulting to `"groupshare"` when unset. `createOrder(request: MTNOrderRequest)` maps `request.network` (`"MTN" | "Telecel" | "AirtelTigo"`) to the corresponding setting key, reads it fresh on every call (not cached, not resolved at provider-selection time) — so the same toggle applies uniformly whether Apex Prime is invoked as the MTN primary provider, an `mtn_retry_sequence` entry, or the non-MTN per-network selection (`telecel_provider_selection` / `at_ishare_provider_selection`).

Network name mapping for both paths: `"MTN"→"MTN"`, `"Telecel"→"Telecel"`, `"AirtelTigo"→"Ishare"`.

**GroupShare path** — `POST /send-bundle`:
```json
{ "network": "MTN", "recipient": "<normalized phone>", "amount": <size_gb>, "reference": "<client_ref>" }
```
Response: `{ success, order_id, client_code, network, recipient, gb_amount, status }`. On `success: true`, the tracking id stored is `` `bundle:${order_id}` `` (see §3 for why). On `success: false`, returns `{ success: false, message: json.message ?? "Apex Prime API error", error_type: "API_ERROR" }`.

**Store path**:
1. `GET /store-products` (or `POST`, per docs both are accepted — use `GET`). Find the first entry in `data_products` where `network === <mapped network>` (case-insensitive) and `gb_amount === size_gb` (exact match only — no nearest-size guessing). If none found: `{ success: false, message: "No matching Apex Prime store product for {network} {size_gb}GB", error_type: "VALIDATION" }`.
2. `POST /store-order`:
```json
{ "product_id": <matched product_id>, "recipient": "<normalized phone>", "reference": "<client_ref>" }
```
Response on success: `{ success, product_id, details, price_deducted, balance_after }` — note this response shape has **no `order_id` field** (unlike send-bundle and the docs' generic examples). Store orders must be tracked by a different key: use the `reference` (`client_ref`) we sent, since it's guaranteed unique (a UUID) and was accepted as an echoable field per `/store-order`'s parameter table. Tracking id stored is `` `store:${client_ref}` ``. On `success: false`, same error shape as GroupShare.

Both branches validate `isValidPhoneFormat`/`validatePhoneNetworkMatch` and normalize the phone first, matching every other provider.

### 3. Status checking — the `bundle:`/`store:` prefix

`checkOrderStatus(orderId: string | number)` only receives the id we stored (per the `MTNProvider` interface — no side-channel context). Since Apex Prime's `POST /status` requires `{ type: "bundle" | "store", order_id }` and we need to know which type without an extra DB lookup, the prefix embedded at creation time (§2) is parsed here:

```ts
const [kind, rawId] = String(orderId).split(":")
// kind === "bundle" -> type: "bundle", rawId is Apex Prime's numeric order_id
// kind === "store"  -> type: "store",  rawId is our own client_ref (the reference we sent)
```

This mirrors the codebase's existing convention of encoding metadata into the stored id string (the `FAILED_INIT_<timestamp>` prefix already used everywhere for "never actually submitted" rows) rather than adding a new tracking-table column for one provider's quirk.

Their `status` values (`pending`, `completed`, `failed`, and whatever else `/status` returns — docs only confirm `pending`/`completed`) map onto our 4-state enum via a `normalizeStatus()` helper: `completed`→`completed`; anything containing `fail`/`reject`/`cancel`/`refund`→`failed`; everything else (including unrecognized values, matching the Sykes/Bisdel convention already documented in this codebase's memory — unknown defaults to `processing`, never `pending`)→`processing`.

### 4. Webhook — `app/api/webhooks/mtn/apexprime/route.ts`

Since Apex Prime's webhook is confirmed unsigned, authentication is a shared secret embedded in the callback URL we register with them: `https://<ourdomain>/api/webhooks/mtn/apexprime?token=<APEXPRIME_WEBHOOK_SECRET>`. The route also accepts the same token via an `x-webhook-token` header as a fallback (matching the Datakazina pattern exactly), constant-time compared. If `APEXPRIME_WEBHOOK_SECRET` is unset, log INSECURE and process anyway (same fail-open posture as Datakazina's route) rather than silently dropping all webhooks in an incomplete-setup state.

Payload shape (confirmed from docs):
```json
{
  "event": "order_status_update", "order_id": 10839, "client_code": "420",
  "client_reference": "YOUR-CUSTOM-REF-998", "network": "MTN", "recipient": "...",
  "gb_amount": 1.0, "channel": "api", "status": "completed", "message": "...",
  "timestamp": "..."
}
```

Correlation order:
1. **Primary**: `client_reference` is exactly the `reference` we sent at creation time, which is always our own internal order UUID (`client_ref` in `MTNOrderRequest`), for both GroupShare and Store orders. Query `mtn_fulfillment_tracking` directly: `WHERE provider = 'apexprime' AND (order_id = client_reference OR shop_order_id = client_reference OR api_order_id = client_reference)` — a single OR across the three polymorphic id columns. This works uniformly for both fulfillment paths and never needs to parse the `bundle:`/`store:` prefix or rely on the webhook's numeric `order_id` field, which is why it's the primary path — Store orders never receive an `order_id` at all (§2), so any correlation strategy anchored on `order_id` would silently fail for every Store-path order.
2. **Fallback**: if `client_reference` is missing or doesn't resolve to a known tracking row (defensive — their docs say it's always present, but this codebase's history with AgentPortalGH's "confirmed" reference field turning out to be null in production is the reason this fallback exists at all), look up by `network` + `gb_amount` + `recipient` phone among recent (last 24h) `pending`/`processing` tracking rows for `provider = 'apexprime'`, most-recent-first. Log loudly when this fallback path fires (it should never need to, per docs) so a real divergence gets noticed immediately rather than silently accumulating.

Same terminal-status semantics as every other webhook route: only `completed`/`failed` update the order table; everything else is a no-op (webhook retries or duplicate deliveries are safe).

### 5. Polling cron — `app/api/cron/sync-mtn-status/apexprime/route.ts`

Mirrors the simpler existing per-provider crons (Xpress/Bisdel style, not AgentPortalGH's hardened batch-disambiguation logic — Apex Prime gives us a stable numeric `order_id` per docs with no documented retry/batch-splitting behavior, so there's no known reason to need phone+day disambiguation). Queries `mtn_fulfillment_tracking` where `provider = 'apexprime'` and `status IN ('pending','processing')`, calls `checkOrderStatus()` per row (which internally dispatches to the right `/status` `type` via the prefix), updates on a terminal result. Runs on the same schedule cadence as the other per-provider crons (5 min, matching AgentPortalGH's).

### 6. Verify-number → `WHITELIST_REGISTRY`

New entry in `lib/mtn-providers/provider-whitelist.ts`:
```ts
{
  name: "apexprime",
  configured: () => !!process.env.APEXPRIME_API_KEY,
  check: async (phone) => {
    const res = await apexApiFetch("/verify-number", { method: "POST", body: JSON.stringify({ phone_number: phone, network: "MTN" }) })
    const json = await res.json()
    return { allowed: json?.is_valid === true, provider: "apexprime" }
  }
}
```
This single entry wires into all 3 existing consumers automatically: the order-time pre-fulfillment gate in `lib/mtn-fulfillment.ts`, the 24h retry cron, and the admin bulk-verify tool on `/admin/phone-verification` (where it becomes a selectable checkbox alongside Xpress/CodeCraft/AgentPortalGH — no changes needed to that page).

Note: `/verify-number` takes a `network` param; the whitelist registry's `check(phone)` signature doesn't carry network context today (the existing Xpress/CodeCraft/AgentPortalGH entries don't need it since their whitelist endpoints are MTN-specific). Since Apex Prime's own verify endpoint is also being wired in specifically for the MTN whitelist-gate use case (the only thing `WHITELIST_REGISTRY` is used for today), pass `"MTN"` as a constant — matching the registry's existing MTN-only scope. This is not a new limitation Apex Prime introduces; it's consistent with what every other registry entry already assumes.

### 7. Admin UI

New tab on `/admin/settings/mtn` (mirroring AgentPortalGH's tab structure, nested sub-tabs):
- **Overview**: identity check (API key configured?), the 4-way balance display (`getWalletSummary()`), "Set as Primary Provider" button.
- **Fulfillment Path**: three toggle cards (MTN / Telecel / AT-iShare), each a two-option switch (GroupShare / Store) backed by the three `admin_settings` keys from §2.
- **Whitelist**: single-phone-number checker card, calling `/verify-number` directly (ad-hoc admin tool — separate from, and in addition to, the automatic bulk-tool integration from §6).
- **Transactions**: `getTransactions()` list, read-only.

Existing per-network provider-selector cards (Telecel / AT-iShare, not AT-BigTime — per the AT-BigTime-exclusion pattern already built for AgentPortalGH) gain "Apex Prime" as a selectable option. `NonMTNProvider` type and the per-network `providers` arrays in `app/admin/settings/mtn/page.tsx` extend accordingly. `PROVIDER_LABELS` gains an `apexprime: "Apex Prime"` entry. MTN-side: retry-sequence builder and the primary-provider selector both gain it as an option; the provider-deactivation toggle grid gains an 8th card.

## Out of scope

- MTN AFA registration (`/afa-registration`) — supported by their API but not requested.
- `/transactions` beyond a read-only admin display — no reconciliation logic against it.
- Catalog sync/caching for the Store path — explicitly decided against (live lookup instead).
- Making Apex Prime's non-MTN capability extend to AT-BigTime — explicitly excluded.
- Any change to how `WHITELIST_REGISTRY` consumers work — Apex Prime plugs into the existing generic iteration, no consumer-side changes.
