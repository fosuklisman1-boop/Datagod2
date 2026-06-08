# Digiwapy Airtime Auto-Fulfillment Design

**Date:** 2026-06-08
**Branch:** feat/moolre-withdrawal-integration
**Status:** Approved

---

## Overview

Integrate the Digiwapy API to automatically fulfill airtime orders immediately after payment is confirmed. Admin retains full control via per-network toggles in settings and retry buttons in the management page. Failed or skipped orders stay `pending` so the admin can retry at any time.

---

## Architecture

### New Files

| File | Purpose |
|---|---|
| `lib/digiwapy-provider.ts` | HTTP client for Digiwapy API + webhook signature verifier |
| `app/api/admin/airtime/auto-fulfill/route.ts` | Admin retry endpoint (POST, accepts `orderId` or `orderIds[]`) |
| `app/api/webhooks/digiwapy/route.ts` | Webhook receiver — updates order status from Digiwapy callbacks |

### Modified Files

| File | Change |
|---|---|
| `lib/airtime-service.ts` | `markAirtimeOrderPaid` calls Digiwapy after marking paid, if network toggle is on |
| `app/api/admin/airtime/settings/route.ts` | Add 3 per-network keys; expose `digiwapy_configured` in GET response |
| `app/admin/airtime/settings/page.tsx` | New "Auto Fulfillment" card with API status indicator + per-network toggles |
| `app/admin/airtime/page.tsx` | "Auto Fulfill All" bulk button + per-row "Auto Fulfill" retry button in Pending tab |

---

## Payment Flow

```
Customer pays
  → markAirtimeOrderPaid (existing, in lib/airtime-service.ts)
    → check admin_settings: airtime_digiwapy_enabled_{network}
    → if enabled AND DIGIWAPY_API_KEY set:
        POST https://api.digiwapy.com/v1/airtime/send
        → success  → order status: "processing"
        → error    → order status: stays "pending", notes updated
    → if disabled or env var missing:
        → order status: stays "pending" (manual workflow)

Digiwapy webhook → POST /api/webhooks/digiwapy
  → verify X-Webhook-Signature (HMAC-SHA256)
  → expected payload shape: { reference, status, message }
    (confirm field names with Digiwapy dashboard / test webhook before deploy)
  → status=success/completed → order: "completed"
  → status=failed/reversed  → order: "pending"  ← retryable

Admin retry
  → clicks "Auto Fulfill" on a pending row (or "Auto Fulfill All")
  → POST /api/admin/airtime/auto-fulfill { orderId } or { orderIds: [] }
  → same Digiwapy call → "processing" on success, stays "pending" on error
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `DIGIWAPY_API_KEY` | API key, must start with `dw_live_` |
| `DIGIWAPY_PARTNER_CODE` | 6-digit partner code (e.g. `314135`) |
| `DIGIWAPY_WEBHOOK_SECRET` | Secret for HMAC-SHA256 webhook signature verification |

These are never stored in the database.

---

## Admin Settings Keys

Three new keys in the `admin_settings` table:

```
airtime_digiwapy_enabled_mtn      { enabled: boolean }
airtime_digiwapy_enabled_telecel  { enabled: boolean }
airtime_digiwapy_enabled_at       { enabled: boolean }
```

Default: all `false` (opt-in per network).

---

## Network Name Mapping

| Internal | Digiwapy API |
|---|---|
| MTN | `"MTN"` |
| Telecel | `"Telecel"` |
| AT | `"AirtelTigo"` |

Adjust Telecel/AT strings if Digiwapy's actual accepted values differ.

---

## Status Transitions

```
pending    → processing   Digiwapy accepted the send request
pending    → pending      Digiwapy call failed (stays retryable, notes updated)
processing → completed    Webhook: success/completed
processing → pending      Webhook: failed/reversed (stays retryable)
```

No schema changes required — existing `airtime_orders` columns cover all transitions.

---

## UI Changes

### Settings Page (`/admin/airtime/settings`)

New "Auto Fulfillment (Digiwapy)" card appended below existing cards:

- **API Status indicator**: green "Configured" / red "Not set" — derived from `digiwapy_configured` boolean in settings GET response (server checks env var, never exposes the key itself)
- **Per-network toggles**: MTN / Telecel / AT — saved with the existing "Save Changes" button
- Toggles are disabled/greyed when API is not configured

### Management Page (`/admin/airtime`)

Pending tab additions:

1. **"Auto Fulfill All (N)" button** in the header bar, next to "Download All". Only rendered when at least one network has Digiwapy enabled. N = count of pending orders on enabled networks.
2. **Per-row "Auto Fulfill" button** in the Actions column, between "Fail" and nothing. Only rendered for orders whose network has Digiwapy enabled. Shows spinner while in-flight.

Both show `toast.success` / `toast.error` on completion and refresh the orders list.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Digiwapy API error at trigger time | Order stays `pending`; `notes` set to error message; no extra notification |
| Webhook with invalid signature | 401 returned; DB not touched; error logged |
| `DIGIWAPY_API_KEY` env var not set | Auto-trigger silently skips; retry endpoint returns 503; settings page shows "Not configured" |
| Per-network toggle off | Auto-trigger skips that network; "Auto Fulfill" button hidden for that row |
| Webhook `failed`/`reversed` | Order reverts to `pending`; `notes` updated with Digiwapy message |

---

## Out of Scope

- Automatic retries / backoff (admin retries manually)
- Per-order Digiwapy transaction status polling
- Bulk airtime (`POST /airtime/bulk`) — single sends only for now
- Admin notifications on failure (pending list serves as the failure queue)
