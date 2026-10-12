# SMS Provider Control — Design

Date: 2026-10-12 · Status: draft for review

## Goal

Give admins control over which SMS gateway (Moolre or Hubtel) carries which kind of message, instead of the single global primary (today: Hubtel primary, Moolre fallback) deciding everything.

## User decisions

1. **System notifications (non-OTP) lead with Moolre**, regardless of the global primary. Covers order confirmations sent from the platform sender, the admin-action messages (withdrawal/shop/AFA/results-check/sender-ID/complaint outcomes), payout/complaint texts, etc. **OTP is untouched** (`SMS_OTP_PROVIDER` + breaker logic).
2. **Order confirmations follow sender ownership, behind a toggle:** if the shop has its own sender ID for confirmations (billed in credits, `sendBilledConfirmation` path) → **Hubtel**; if the confirmation comes from Datagod's platform sender (free path) → **Moolre**.
3. **Per-send provider picker** (Moolre / Hubtel only) on the compose screens of: admin broadcast (`/admin/broadcast`), admin SMS platform (`/admin/sms` Messages), and customer-facing bulk SMS (dashboard `/dashboard/sms` + shop send + `/api/v1/sms/send`).
4. **If the chosen provider fails, fall back** to the other configured provider (existing behaviour); the result records which provider actually carried each message.

## Settings (admin_settings, admin-editable on /admin/sms Settings)

| Key | Default | Meaning |
|---|---|---|
| `sms_system_provider` | `"moolre"` | Lead provider for non-OTP system notifications. `"global"` = old behaviour (use routing primary). |
| `sms_confirmation_by_sender_enabled` | `true` | Toggle. ON: own-sender billed confirmations → Hubtel, platform-sender confirmations → Moolre. OFF: confirmations follow `sms_system_provider` / global routing as before. |
| `sms_default_send_provider` | `"global"` | Pre-selected value of the compose picker (`global` = routing primary). |

`getRoutingConfig()` (`lib/sms/routing.ts`) is extended to read/cache these (same 5-min TTL + `invalidateRoutingCache`), validated against `moolre|hubtel`.

## Mechanism

**Single-message path (`sendSMS`, `lib/sms-service.ts`).** `SMSPayload` gains optional `provider?: "moolre" | "hubtel"`. Order building becomes:
- OTP (`type === "phone_otp"`): unchanged.
- `payload.provider` set: `[payload.provider, ...rest]`.
- Else if no custom `senderId` and type is a system type: `[routing.systemProvider, ...rest]` (unless `"global"`).
- Else: unchanged (`[primary, ...fallbacks]`).
`rest` = remaining configured providers (fallback preserved). Sender-ID narrowing (`narrowProvidersForSender`) still runs after, so an unapproved custom sender can never be forced onto a gateway that rejects it. Unconfigured providers are filtered as today.

**Order confirmations.** In `app/api/fulfillment/process-order/route.ts`: the billed path passes `provider: "hubtel"` through `sendBilledConfirmation` → `enqueueSend` (when the toggle is ON); the free path passes `provider: "moolre"` to `sendSMS`. Toggle OFF → neither passes a provider.

**Bulk path (`dispatchCampaign`, `lib/sms/campaign-dispatch.ts`).** Gains a `provider?` argument replacing `routing.primary` for that call (Hubtel unconfigured → Moolre, as today). Since unplaced rows are retried by the cron drain, the choice is **persisted** on `sms_send_logs.provider_override` (new nullable column, migration) and read by `dispatch-claimed.ts` and the `send-service` instant dispatch so a retry uses the same provider the admin picked.

**Broadcast (`app/api/admin/broadcast`).** `init` accepts `smsProvider?: "moolre"|"hubtel"|"global"`, validated; stored on `broadcast_logs.sms_provider` (new nullable column); `lib/broadcast-drain.ts` passes it to `sendSMS({ provider })`. Retry route reuses the stored value.

**Customer bulk SMS.** `enqueueSendBatched` options gain `provider`; the API/dashboard/shop routes accept and validate it. Tenants choosing Hubtel remain subject to the existing Hubtel solvency/wholesale gates (`resolveHubtelBalance`); if Hubtel is out of funds the existing out-of-funds path applies (rows stay pending / fall back per current logic) — the picker does not bypass any gate. Admin can disable the tenant-facing picker (`sms_tenant_provider_choice_enabled`, default `false` so tenants see no new control until an admin turns it on).

**UI.** A small `ProviderSelect` component (Moolre / Hubtel / "System default") used on the admin broadcast SMS channel, the admin SMS Messages compose, and the dashboard SMS compose (hidden unless the tenant-choice setting is on). Settings screen gets the three toggles above.

## Error handling

- Invalid provider value → 400 (routes) / ignored with a warning (internal callers).
- Chosen provider unconfigured → silently skipped in the chain, fallback proceeds; send log records the real provider.
- Settings read failure → fail open to current behaviour (global routing).
- No change to OTP, the breaker, or Hubtel "unknown outcome" no-double-send rule.

## Testing

- `sendSMS` order unit tests: OTP unchanged; `payload.provider` leads; system type leads with `systemProvider`; `"global"` preserves old order; sender-ID narrowing still wins; unconfigured filtered.
- `dispatchCampaign` with explicit `provider`; persisted `provider_override` honoured by `dispatch-claimed` retry.
- Confirmation routing: toggle ON → billed=hubtel, free=moolre; toggle OFF → no provider passed.
- Broadcast init validation + drain passes provider; retry reuses it.
- Tenant routes reject `provider` when tenant choice is disabled.
- Wiring grep tests that OTP call sites never pass `provider`.

## Rollout / risks

- Migration: two nullable columns (`sms_send_logs.provider_override`, `broadcast_logs.sms_provider`) — additive, safe.
- **Behaviour change on deploy:** system notifications flip from Hubtel-first to Moolre-first immediately (default `sms_system_provider = moolre`). Moolre credit balance must cover that volume; monitor Moolre balance after deploy.
- Hubtel DLR/billing for own-sender confirmations is unchanged (they stay on Hubtel).

## Out of scope

OTP routing, mNotify/Brevo in the picker, per-message-type routing UI beyond the three settings, changing the global primary/fallback settings.
