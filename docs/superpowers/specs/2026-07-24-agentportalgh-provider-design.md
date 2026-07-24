# AgentPortalGH Provider Integration — Design Spec

**Date:** 2026-07-24  
**Status:** Approved  
**Base URL:** `https://api.agentportalgh.com`  
**Auth:** `X-API-Key: <key>` header on every request

---

## 1. Goals

Add AgentPortalGH as a fully-featured MTN fulfillment provider, on equal footing with Sykes, EazyGhData, CodeCraft, etc. Every endpoint in their API is wired up — not just order creation. The provider slots into the existing factory/selection system; the admin gains a dedicated management panel.

---

## 2. New Files

| File | Purpose |
|---|---|
| `lib/mtn-providers/agentportalgh-provider.ts` | Provider class — all API calls |
| `app/api/webhooks/mtn/agentportalgh/route.ts` | Incoming `order.completed` webhook |
| `app/api/admin/agentportalgh/route.ts` | Admin REST facade (wallet, webhook, orders, whitelist) |
| `app/api/cron/sync-mtn-status/agentportalgh/route.ts` | Polling fallback cron |

## 3. Modified Files

| File | Change |
|---|---|
| `lib/mtn-providers/types.ts` | Add `"agentportalgh"` to `MTNProviderName` union |
| `lib/mtn-providers/factory.ts` | Register provider in `getMTNProvider`, `getProviderByName`, `VALID_PROVIDERS` |
| `app/admin/settings/mtn/page.tsx` | AgentPortalGH management panel (shown when selected) |

## 4. Environment Variables

| Variable | Default | Notes |
|---|---|---|
| `AGENTPORTALGH_API_KEY` | — | Required |
| `AGENTPORTALGH_BASE_URL` | `https://api.agentportalgh.com` | Override for staging |
| `AGENTPORTALGH_WEBHOOK_SECRET` | — | Set after calling PUT /api/webhooks/config |

---

## 5. Provider Class (`agentportalgh-provider.ts`)

Implements the `MTNProvider` interface. All methods use `X-API-Key` auth and a 30s timeout.

### 5.1 `createOrder(request: MTNOrderRequest): Promise<MTNOrderResponse>`

```
POST /api/queue/add
{
  "service": "mtn",          // always "mtn" — provider is MTN-scoped in our factory
  "items": [{
    "msisdn": "<normalized_phone>",
    "data_gb": <whole_number>,
    "reference": "<our_order_uuid>"   // echoed back in webhook items[].reference
  }]
}
```

- Normalises phone to 10-digit Ghana format before sending
- `data_gb` must be a whole integer — round if needed
- On success (`{ added: 1, charged, balance }`): returns `{ success: true, order_id: reference }` using our UUID as the tracking ID (no numeric ID is returned by the API)
- On `added: 0` with `rejected` array: returns `{ success: false, held: true, error_type: "WHITELIST_BLOCKED" }`
- On 402: returns `{ success: false, error_type: "INSUFFICIENT_BALANCE" }`
- On 400 with out-of-range message: returns `{ success: false, error_type: "VALIDATION" }`

### 5.2 `checkOrderStatus(orderId: string): Promise<MTNOrderStatusResponse>`

Since the API is webhook-first, there is no single-order status endpoint. Strategy:

1. `GET /api/queue?status=pending&page_size=100` — if our `reference` appears here, status is `pending`
2. `GET /api/beneficiaries/orders?search=<msisdn>` — if an order contains an item with `reference = orderId` and `status = success/failed`, return that terminal state
3. If not found in either: return `{ success: true, status: "processing" }` (assume still in flight)

Items in `/api/beneficiaries/orders/{id}/items` are fetched when the order is found to get per-item `status` and `failed_reason`.

### 5.3 `checkBalance(): Promise<number | null>`

```
GET /api/wallet
```

Returns `data.balance` (GHS float). Returns `null` on any error.

### 5.4 Additional methods (not part of MTNProvider interface — used by admin routes)

| Method | Endpoint |
|---|---|
| `getIdentity()` | GET /api/me |
| `getWalletSummary(from?, to?)` | GET /api/wallet/summary |
| `getTransactions(page, pageSize)` | GET /api/wallet/transactions |
| `topUp(amount, phone, network)` | POST /api/wallet/topup |
| `getTopups(page, pageSize)` | GET /api/wallet/topups |
| `previewOrder(service, items)` | POST /api/queue/preview |
| `verifyWhitelist(msisdns[])` | POST /api/mtn-whitelist/verify |
| `getServices()` | GET /api/services |
| `getWebhookConfig()` | GET /api/webhooks/config |
| `setWebhookConfig(url, enabled, regenerateSecret?)` | PUT /api/webhooks/config |
| `getWebhookDeliveries(page, pageSize)` | GET /api/webhooks/deliveries |
| `resendWebhookDelivery(id)` | POST /api/webhooks/deliveries/{id}/resend |
| `getOrders(filter?, search?, date?)` | GET /api/beneficiaries/orders |
| `getOrderItems(orderId, status?)` | GET /api/beneficiaries/orders/{orderId}/items |

---

## 6. Webhook Handler (`/api/webhooks/mtn/agentportalgh`)

### Signature verification

Header: `X-Webhook-Signature: sha256=<hex>`  
HMAC-SHA256 of the raw request body keyed with `AGENTPORTALGH_WEBHOOK_SECRET`.

```ts
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex")
timingSafeEqual(Buffer.from(expected), Buffer.from(header))
```

Reject with 401 if missing or invalid. If `AGENTPORTALGH_WEBHOOK_SECRET` is not set, log a warning and accept (to allow initial setup before secret is stored).

### Payload handling

Event: `order.completed` (version 2). For each item in `payload.items`:

1. Locate tracking row in `mtn_fulfillment_tracking` where `mtn_order_id = item.reference` (our order UUID was sent as reference)
2. Map item status: `"success"` → `"completed"`, `"failed"` → `"failed"`
3. Update tracking row status + `external_message` (from `failed_reason`)
4. Mirror to the originating order table (same logic as `syncMTNOrderStatus`)
5. On `"failed"` with `refunded_at` set: log that AgentPortal auto-refunded — no wallet action needed on our side

Respond `200 OK` immediately after parsing; do all DB writes asynchronously (return before awaiting) to stay within their 15s timeout.

### Truncation fallback

If `payload.items_truncated = true`, fetch the full item list via `GET /api/beneficiaries/orders/{order_id}/items` and process that instead.

---

## 7. Admin API Route (`/api/admin/agentportalgh`)

Single route file, dispatched by `action` query param. All endpoints require admin auth (`verifyAdminAccess`).

| `?action=` | Method | Proxies to |
|---|---|---|
| `identity` | GET | `getIdentity()` |
| `balance` | GET | `checkBalance()` |
| `summary` | GET | `getWalletSummary(from, to)` |
| `transactions` | GET | `getTransactions(page, pageSize)` |
| `topups` | GET | `getTopups(page, pageSize)` |
| `topup` | POST | `topUp(amount, phone, network)` |
| `preview` | POST | `previewOrder(service, items)` |
| `whitelist` | POST | `verifyWhitelist(msisdns)` |
| `services` | GET | `getServices()` |
| `webhook-config` | GET | `getWebhookConfig()` |
| `webhook-config` | PUT | `setWebhookConfig(url, enabled, regenerate)` |
| `webhook-deliveries` | GET | `getWebhookDeliveries(page, pageSize)` |
| `webhook-resend` | POST | `resendWebhookDelivery(id)` |
| `orders` | GET | `getOrders(filter, search, date)` |
| `order-items` | GET | `getOrderItems(orderId, status)` |

---

## 8. Polling Fallback Cron (`sync-mtn-status/agentportalgh`)

Runs on schedule (same cadence as other sub-crons). Batch size: 50 per run.

1. Fetch up to 50 `mtn_fulfillment_tracking` rows with `provider = "agentportalgh"` and `status IN ('pending', 'processing')` from the last 30 days, ordered newest-first
2. Call `checkOrderStatus(mtn_order_id)` for each
3. On terminal status: update tracking + mirror to order table
4. Skip rows already resolved by webhook (status no longer pending/processing)

---

## 9. Admin UI Panel

Shown in `/admin/settings/mtn` when AgentPortalGH is selected (same pattern as EazyGhData package sync panel). Cards:

### Always visible (when provider = agentportalgh)
- **Identity card** — name, email, role badge; "Verify Connection" button calls GET /api/me
- **Wallet card** — live GHS balance, last-refreshed timestamp, Refresh button
- **Summary card** — date range picker (from/to), then: orders placed, success count, failure count, total GB, total charged (GHS)
- **Services card** — table of supported networks and their GB limits from GET /api/services

### Wallet management
- **Top-up form** — amount (GHS), phone number, network selector (MTN/Telecel/AirtelTigo), "Top Up via MoMo" button; shows success/pending message
- **Transaction history** — paginated table: type (debit/credit), amount, reason, date
- **Top-up history** — paginated table: amount, phone, network, status (pending/success/failed), date

### Webhook management
- **Webhook config card** — URL input, enabled toggle, "Save" button, "Rotate Secret" button (sets regenerate_secret: true); shows current secret (masked) with copy button
- **Delivery log** — last 50 deliveries: order_id, status, timestamp, "Resend" button per row

### Tools
- **Whitelist checker** — textarea for up to 1000 numbers (one per line), "Check" button, results table: msisdn, allowed (yes/no badge)
- **Order history** — paginated table: group_name, status, uploaded/success/failure counts, date; clicking a row fetches and expands items

---

## 10. Factory & Type Changes

`MTNProviderName` union: add `"agentportalgh"`

`factory.ts` changes:
- Add to `getSelectedProvider` validation list
- Add `case "agentportalgh": return new AgentPortalGHProvider()` in both `getMTNProvider` and `getProviderByName`
- Add to `VALID_PROVIDERS` array (for fallback validation)
- AgentPortalGH is MTN-only in the factory (`NON_MTN_CAPABLE` — not added, since it's primary-MTN in our system)

---

## 11. Order Flow Summary

```
createOrder()
  → POST /api/queue/add  { reference: our_uuid }
  → tracking row: mtn_order_id = our_uuid, provider = "agentportalgh"

AgentPortal processes batch
  → POST /api/webhooks/mtn/agentportalgh
  → verify HMAC-SHA256
  → for each item: find tracking by reference, mark completed/failed
  → mirror to order table

Fallback cron (if webhook missed)
  → poll /api/queue + /api/beneficiaries/orders
  → resolve any still-pending rows
```

---

## 12. Error Mapping

| AgentPortal response | Our error_type |
|---|---|
| 401 | `API_ERROR` |
| 402 insufficient balance | `INSUFFICIENT_BALANCE` |
| 400 out-of-range GB | `VALIDATION` |
| 400 whitelist rejected (added:0) | `WHITELIST_BLOCKED` (held: true) |
| 503 topup not configured | `API_ERROR` |
| Network/timeout | `NETWORK_ERROR` |

---

## 13. Out of Scope

- Excel file upload (`POST /api/queue/add-file`) — no use case in current system
- Batch ordering (multiple items per `createOrder` call) — future optimisation
- AgentPortal wallet top-up as a customer-facing feature — admin-only
