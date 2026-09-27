# SPFastIT Telecel Provider — Design Spec

## Context

SPFastIT already has one integration in this codebase (`lib/mtn-providers/spfastit-provider.ts`), scoped to AT-iShare only, using a form-encoded API at `console.spfastit.com`. SPFastIT has now shared documentation for a **separate, newer API** at `spfastit.com/wp-json/custom-api/v1` — JSON body (not form-encoded), a different auth field placement, and support for both `mtn` and `telecel` networks.

Confirmed with the user:
- This is a **separate account/product**, coexisting with the existing AT-iShare integration — not a replacement. The old integration is untouched.
- Scope is **Telecel only** for now (MTN already has 10 providers; no need for an 11th).
- Internal provider name: **`spfastit_telecel`** — distinct from the existing `spfastit` (AT-iShare) to avoid conflating tracking/analytics between two different accounts/APIs with different behavior.

## API Summary (as documented)

Base URL: `https://spfastit.com/wp-json/custom-api/v1`. All requests are `POST` with a JSON body containing `api_key`.

- `POST /balance` → `{status, message, balance, currency, formatted}` — currency balance (₵), not GB-denominated (unlike the existing `spfastit` provider, whose balance is GB of data).
- `POST /place-order` → body `{api_key, phone, size_mb, network, reference, webhook_url}`. `network` is `"mtn"` or `"telecel"`; we always send `"telecel"`. `size_mb` must be in MB. Response: `{status, message, order_id, wallet_balance_before, wallet_balance_after, order_status, size_gb}`.
- `POST /status` → body `{api_key, order_id}` (or `{api_key, reference}` — we'll always have `order_id` from place-order, so we use that form). Response: `{status, order_id, order_status, status_label, reference, amount}`.
- `POST /prices` → not used by this integration (informational only).
- **Webhook**: if `webhook_url` is provided on `place-order`, SPFastIT POSTs `{reference, status, status_label, order_id, phone, message}` on status change. No signature/HMAC is documented.

### MB/GB convention

The doc's Telecel size list (`10000, 15000, 20000, ..., 50000` MB) divides cleanly by 1000 into whole GB values (10, 15, 20, ..., 50), confirming **1000MB = 1GB** for Telecel on this API — independently verified from the doc, not assumed. (The doc's MTN size list uses the standard binary 1024 convention instead, but MTN is out of scope here.)

### Status mapping (order_status → canonical)

The doc gives only two concrete values (`"initiated"` right after order placement, `"completed"` in the status-check example) — no exhaustive list. Following the same conservative pattern used for Bundle Portal/Bisdel where the provider's status vocabulary isn't fully documented:
- `"completed"` → `completed`
- Any value containing `fail`, `cancel`, `reject`, or `block` → `failed`
- Everything else (`initiated`, `processing`, `pending`, unrecognized values) → `processing`

This is the best available synthesis from the doc; flagged for a live re-test if a real order's terminal status ever behaves unexpectedly (same caveat pattern already used for Bundle Portal's AirtelTigo mapping).

## Files

**New:**
- `lib/mtn-providers/spfastit-telecel-provider.ts` — `SPFastITTelecelProvider implements MTNProvider`, `name = "spfastit_telecel"`. Pure helpers exported for tests: `mapSpfastitTelecelStatus(raw)`, `gbToMb(gb)` (× 1000).
- `lib/mtn-providers/spfastit-telecel-provider.test.ts`
- `lib/mtn-providers/spfastit-telecel-webhook-processor.ts` — mirrors `bundleportal-webhook-processor.ts`: `verifyToken(provided, secret)` (timing-safe) + `processWebhook(payload)`. Looks up `mtn_fulfillment_tracking` by `mtn_order_id = String(payload.order_id)` directly (SPFastIT-Telecel echoes back our own numeric `order_id` — no disguised-reference decoding needed, unlike DataKazina). Same order-type branching (bulk/api/ussd/ussd_shop/shop) and terminal-state guard as Bundle Portal's processor.
- `lib/mtn-providers/spfastit-telecel-webhook-processor.test.ts`
- `app/api/webhooks/mtn/spfastit-telecel/route.ts` — thin route: reads `?token=` query param, timing-safe compares against `SPFASTIT_TELECEL_WEBHOOK_SECRET`, then `after(() => processWebhook(payload))` (the `after()` pattern is required — a bare fire-and-forget call was proven unreliable on Vercel, per the AgentPortalGH incident this codebase already hit).
- `app/api/cron/sync-mtn-status/spfastit-telecel/route.ts` — polling fallback, mirrors an existing per-provider status-sync cron (e.g. `sync-mtn-status/apexprime`) exactly, calling `checkOrderStatus` for pending tracking rows.

**Modified:**
- `lib/mtn-providers/types.ts` — `NonMTNProviderName = MTNProviderName | "spfastit" | "spfastit_telecel"`.
- `lib/mtn-providers/factory.ts` — import + `NON_MTN_CAPABLE.telecel_provider_selection` gains `"spfastit_telecel"`; `getProviderByName` switch gains a case (TS's exhaustiveness check enforces this).
- `app/api/admin/settings/network-provider/route.ts` — `VALID_PROVIDERS_BY_NETWORK.telecel` gains `"spfastit_telecel"`.
- `app/admin/settings/mtn/page.tsx` — `NonMTNProvider` type gains `"spfastit_telecel"`; `nonBigTimeProviders` array (used for the Telecel tab) gains `{ value: "spfastit_telecel", label: "SPFastIT (Telecel)", sub: "Telecel-only, separate account" }`.
- `app/admin/order-payment-status/page.tsx` — `getProviderOptionsForNetwork()`'s non-MTN branch gains the same option (manual per-order override dropdown).
- `app/api/admin/fulfillment/mtn-balance/route.ts` — add `spfastit_telecel` balance check alongside the others (currency-denominated, standard threshold).
- `app/api/cron/check-mtn-balance/route.ts` — same addition for the scheduled balance-alert check.
- `vercel.json` — new cron entry for `sync-mtn-status/spfastit-telecel`.

**Not modified:** the existing `spfastit-provider.ts` (AT-iShare), and everything MTN-specific (`VALID_PROVIDERS`, `getMTNProvider`, `mtn_retry_sequence`) — this provider is structurally excluded from MTN the same way the existing `spfastit` is, by simply never appearing in any MTN-only list.

## Environment variables (to be set in Vercel by the user; not read by this session)

- `SPFASTIT_TELECEL_API_KEY` (sensitive)
- `SPFASTIT_TELECEL_WEBHOOK_SECRET` (sensitive) — generated as part of this work, delivered to the user for registering the webhook URL with SPFastIT (same pattern as the DataKazina webhook secret this session).
- `SPFASTIT_TELECEL_BASE_URL` (optional override; defaults to `https://spfastit.com/wp-json/custom-api/v1`)

## Testing

Pure helpers (`mapSpfastitTelecelStatus`, `gbToMb`) and the webhook processor's DB-interaction logic get unit tests using this codebase's established fake-Supabase-client pattern (see `bundleportal-webhook-processor.test.ts`-equivalent style, or `datakazina-provider.test.ts` for the simpler fake-settings pattern). No live API calls in tests.
