# SMS Provider Control — Design

Date: 2026-10-12 · Status: draft for review

## Goal

Give admins control over which SMS gateway (Moolre or Hubtel) carries each kind of SMS, instead of the single global primary (today: Hubtel primary, Moolre fallback) deciding everything.

## User decisions

1. **A provider selector for every kind of SMS** (admin Settings → SMS "Provider routing"): each category below gets its own Moolre / Hubtel / "Global" dropdown. "Global" = today's behaviour (routing primary, then fallbacks).
2. **Order confirmations follow sender ownership:** own sender ID (billed in credits) → Hubtel; Datagod platform sender → Moolre. These are two separate categories, each with its own selector (defaults Hubtel / Moolre).
3. **Per-send picker** (Moolre / Hubtel / "Category default") on the compose screens of admin broadcast, admin SMS Messages, and customer bulk SMS (tenant-facing picker off until an admin enables it). A per-send choice overrides the category.
4. **Failover:** the chosen provider leads; the other configured provider remains the fallback. The send log records which provider actually carried the message. OTP keeps its breaker (below).
5. Earlier answer kept as the default: all system notifications except OTP lead with Moolre.

## Categories (one selector each)

Every `sendSMS` call has a `type`. `lib/sms/categories.ts` maps type → category; an unmapped type falls into `system`, so a new type is never unrouted.

| Category | Types it covers | Default |
|---|---|---|
| `otp` | `phone_otp`, `otp_required`, `password_reset_link` | Global (existing `SMS_OTP_PROVIDER` env still the fallback value; OTP breaker still wins) |
| `order_confirmation_platform` | `order_confirmed`, `order_confirmation`, `order_payment_confirmed`, `order_update`, `order_delivered`, `order_fulfilled`, `order_cleared` sent from the Datagod sender | Moolre |
| `order_confirmation_own_sender` | a shop's own-sender billed confirmations (`sendBilledConfirmation`) | Hubtel |
| `payments_wallet` | `wallet_topup_success`, `data_purchase_success`, `balance_updated`, `airtime_*`, `order_refund`, withdrawal payout texts | Moolre |
| `admin_action_outcomes` | `withdrawal_*`, `shop_*`, `afa_*`, `results_check_*`, `sender_id_*`, `complaint_*`, `dealer_upgrade`, `user_suspension`, `user_restoration` | Moolre |
| `security_alerts` | `security_alert`, `password_changed`, admin alert texts | Global |
| `system` | every other system type (catch-all) | Moolre |
| `admin_broadcast` | admin broadcast SMS channel | Global |
| `customer_bulk` | tenant / shop / API bulk sends (campaigns, scheduled) | Global |

(Exact type lists are finalised from a code scan in the plan; the table above is the starting map.)

## Settings

One `admin_settings` row, `sms_category_providers` (JSON `{ category: "global" | "moolre" | "hubtel" }`), read through `getRoutingConfig()` (`lib/sms/routing.ts`; same 5-min cache + `invalidateRoutingCache`), validated against the category list and the two providers. Missing keys use the defaults above. Plus `sms_tenant_provider_choice_enabled` (default `false`).

UI: a "Provider routing" card on /admin/sms Settings — one row per category with its dropdown, and for "Global" it shows the provider that currently resolves to.

## Mechanism

**Single-message path (`sendSMS`, `lib/sms-service.ts`).** `SMSPayload` gains optional `provider?: "moolre" | "hubtel"`. Order building:
- `payload.provider` set (per-send or caller-forced): `[payload.provider, ...rest]`.
- Else lead = `routing.categoryProviders[categoryOf(type)]`; `"global"` = old behaviour (`[primary, ...fallbacks]`).
- OTP category: lead = the selector if not Global, else `SMS_OTP_PROVIDER || primary`. When the OTP breaker is open the lead is still forced to the fallback provider, so the selector can never defeat the breaker.

`rest` = the remaining configured providers (fallback preserved). Custom sender-ID narrowing (`narrowProvidersForSender`) still runs afterwards, so an unapproved custom sender is never forced onto a gateway that rejects it. Unconfigured providers are filtered as today.

**Order confirmations.** In `app/api/fulfillment/process-order/route.ts`: the billed path resolves the `order_confirmation_own_sender` category and passes it through `sendBilledConfirmation` → `enqueueSend`; the free path calls `sendSMS` with its normal type, which maps to `order_confirmation_platform`. Setting either to Global restores today's routing.

**Bulk path (`dispatchCampaign`, `lib/sms/campaign-dispatch.ts`).** Gains a `provider?` argument replacing `routing.primary` for that call (Hubtel unconfigured → Moolre, as today). Unplaced rows are retried by the cron drain, so the choice is **persisted** on `sms_send_logs.provider_override` (new nullable column, migration) and read by `dispatch-claimed.ts` and the `send-service` instant dispatch; a retry uses the same provider as the first attempt. Value = per-send pick, else the `customer_bulk` category.

**Broadcast (`app/api/admin/broadcast`).** `init` accepts `smsProvider?: "moolre" | "hubtel" | "global"` ("global" = use the `admin_broadcast` category); validated; stored on `broadcast_logs.sms_provider` (new nullable column); `lib/broadcast-drain.ts` passes it to `sendSMS({ provider })`. The retry route reuses the stored value.

**Customer bulk SMS.** `enqueueSendBatched` options gain `provider`; the dashboard / shop / `/api/v1/sms/send` routes accept and validate it, but only honour it when `sms_tenant_provider_choice_enabled` is true (otherwise the `customer_bulk` category applies). Existing Hubtel solvency / wholesale gates (`resolveHubtelBalance`) and the out-of-funds path are not bypassed.

**UI.** A shared `ProviderSelect` (Moolre / Hubtel / default) on admin broadcast (SMS channel), admin SMS Messages compose, and dashboard SMS compose (hidden unless tenant choice is on).

## Error handling

- Invalid provider/category value → 400 (routes) / ignored with a warning (internal callers).
- Chosen provider unconfigured → skipped in the chain, fallback proceeds; send log records the real provider.
- Settings read failure → fail open to current behaviour (global routing).
- Hubtel "unknown outcome" no-double-send rule unchanged.

## Testing

- Category mapping: every known type maps to its category; unknown → `system`.
- `sendSMS` order: each category's selector changes the lead; Global preserves the old order; `payload.provider` beats the category; sender-ID narrowing still wins; unconfigured filtered.
- OTP: selector leads, but an open breaker still forces the fallback.
- Confirmation routing: own-sender → its category's provider; platform → its category's provider.
- `dispatchCampaign` with explicit `provider`; persisted `provider_override` honoured by `dispatch-claimed` retries.
- Broadcast init validation, drain passes the provider, retry reuses it.
- Tenant routes ignore/reject `provider` when tenant choice is disabled.

## Rollout / risks

- Migration: two nullable columns (`sms_send_logs.provider_override`, `broadcast_logs.sms_provider`) — additive, safe.
- **Behaviour change on deploy:** the system categories flip from Hubtel-first to Moolre-first immediately (defaults above). The Moolre credit balance must cover that volume; monitor it after deploy.
- Own-sender confirmations stay on Hubtel, so their DLR/billing is unchanged.

## Out of scope

mNotify/Brevo in the selectors; per-individual-type routing (categories only); changing the global primary/fallback settings.
