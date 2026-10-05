# Hubtel USSD Integration — Design

Date: 2026-10-05
Status: Draft for review

## 1. Goal

Add a Hubtel Programmable Services USSD channel to Datagod. One Hubtel USSD code serves **either** the main Datagod USSD menu **or** the shop USSD menu, selected by an admin toggle. A dedicated admin page configures it. Payment is collected by Hubtel (AddToCart), not by our Paystack/wallet/OTP flow. The existing Uzo endpoints (`/api/ussd`, `/api/ussd-shop`) are unchanged and keep running alongside.

## 2. Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Payment | Hubtel only. Every purchase ends in `AddToCart`; Hubtel collects MoMo. No wallet, Paystack-OTP, or pending-OTP redial on this channel. |
| Hubtel fee | Customer pays it (Hubtel adds its charge on top of our `Price`). Our price/margins/shop profit unchanged. |
| Static IP | DigitalOcean droplet as a **thin outbound relay** for the fulfilment callback and transaction status check. App and all logic stay on Vercel. |
| Services | Data bundles, airtime, results checker, AFA. Admin chooses which are visible. |
| Mode | Admin toggle `main` \| `shop`. Shop mode keeps the "enter shop code" first step. |
| Uzo codes | Kept; Hubtel is an additional channel. |
| Callback status | Fulfilment callback to Hubtel **always** sends `ServiceStatus: "success"` (see §8). |
| Approach | New `lib/ussd-hubtel/` router reusing pure menu/catalog logic; payment-confirmation block extracted and shared with the Paystack webhook. |

## 3. Hubtel protocol summary (reference)

- **Interaction** (`POST` to our Service Interaction URL): request fields `Type` (`Initiation`/`Response`/`Timeout`), `Message`, `ServiceCode`, `Operator`, `ClientState`, `Mobile`, `SessionId`, `Sequence`, `Platform` (`USSD`/`Webstore`/`Hubtel-App`).
- **Reply**: `SessionId`, `Type` (`response`/`release`/`AddToCart`), `Message` (`\n` = newline; **no special characters**, e.g. É), `Label`, `DataType` (`display`/`input`), `FieldType` (`text`/`phone`/`email`/`number`/`decimal`/`textarea`), optional `ClientState`, `Item {ItemName, Qty, Price}` only for `AddToCart`.
- Malformed reply surfaces to the user as `UUE`.
- **Fulfilment** (`POST` to our Service Fulfilment URL after payment): `SessionId`, `OrderId`, `OrderInfo { CustomerMobileNumber, Status, Subtotal, Items[], Payment { AmountPaid, AmountAfterCharges, IsSuccessful, ... } }`.
- **Fulfilment callback** (we → Hubtel): `POST https://gs-callback.hubtel.com:9055/callback` with `{SessionId, OrderId, ServiceStatus, MetaData}`, **within 1 hour**. Endpoint is IP-whitelisted.
- **Transaction Status Check** (mandatory): `GET https://api-txnstatus.hubtel.com/transactions/{Collection_Account_Number}/status?clientReference={SessionId}` with Basic auth, IP-whitelisted; used when no final status within 5 minutes.
- Hubtel source IPs for fulfilment payloads: `52.50.116.54`, `18.202.122.131`, `52.31.15.68`.
- Platforms `Webstore` / `Hubtel-App` also hit the interaction URL. **Decision: v1 serves all three platforms** (see §5.1).

## 4. Architecture

```
Customer ─USSD→ Hubtel ─POST→ Vercel /api/ussd-hubtel/interaction ─→ lib/ussd-hubtel/router
                                              │ (CONFIRM) create pending order, return AddToCart
Hubtel ─(after payment)→ Vercel /api/ussd-hubtel/fulfillment
                                              │ shared post-payment fn → fulfil
                                              └→ queue callback ─→ DO relay (fixed IP) ─→ gs-callback.hubtel.com
Cron: callback retry (≤1h) · status check (no final status after 5 min) via DO relay
```

### 4.1 Vercel endpoints
- `POST /api/ussd-hubtel/interaction` — maps Hubtel request → router → Hubtel reply.
- `POST /api/ussd-hubtel/fulfillment` — payment-confirmed webhook (see §6).
- Both: verify secret in URL/header (if configured) and source IP against the three Hubtel IPs plus an admin-editable allowlist. Return the exact response shapes Hubtel expects; never leak stack traces.

### 4.2 Mode toggle
- Setting `hubtel_ussd_mode` (`main` | `shop`) in the settings store used by existing USSD toggles (use the keyed `admin_settings` pattern, not `app_settings` singleton row — see the app_settings collision incident).
- Read on every `Initiation`, then **pinned into the session**. Flipping the toggle never changes an in-flight session.

### 4.3 Session
- Redis, key `ussd-hubtel:session:{SessionId}`, TTL 120s (same session module pattern as `lib/ussd/session.ts`).
- `ClientState` echoes the current step name as a fallback if Redis misses.

### 4.4 Reuse boundaries
- Reused unchanged: bundle/catalog fetch + price-tier logic, `getUssdServiceVisibility` (as default only; Hubtel has its own visibility settings), phone-format/prefix validation, whitelist/MTN-registration gates.
- **Not reused: the Uzo "Browse Services" rebrand.** The Uzo menus use network nicknames (Yellow Plans/Tele/Instant Blue/Delay Blue) and avoid "data"/"bundle" wording and package-size units. The Hubtel menus use **real network names** (MTN, Telecel, AT-iShare, AT-BigTime), normal wording, and package sizes with units. Hubtel menu text therefore lives in its own `lib/ussd-hubtel/menus.ts` instead of importing `lib/ussd/menus.ts` or `network-labels.ts`.
- New: Hubtel request/response mapper, router, session wrapper, AddToCart builder, fulfilment webhook, relay client, crons, admin page + APIs.
- **Refactor:** extract the post-payment block currently inline in the Paystack webhook (mark paid → transaction row → shop profit credit → SMS → fulfil) into a shared function consumed by both webhooks. Uzo flows' behaviour must not change (covered by existing tests + new regression tests).

### 4.5 DO relay
- Small authenticated HTTP service on the droplet with a fixed IP (the IP given to Hubtel for whitelisting).
- Two operations: `POST /callback` (forward fulfilment callback) and `GET /status` (forward status check with Basic auth added server-side or passed through).
- Vercel authenticates to the relay with a shared secret (HMAC or bearer) over HTTPS; relay allows only these two upstream hosts.
- Relay holds no business logic and no queue (queue/retry lives in Supabase + Vercel cron).

## 5. Menu flow

- **Main mode:** Initiation → main menu (items filtered by admin visibility: data, airtime, results checker, AFA) → same sub-flows as `lib/ussd` handlers up to `CONFIRM`.
- **Shop mode:** Initiation → "enter shop code" → shop product menu → same sub-flows as `lib/ussd-shop` up to `CONFIRM`.
- Removed on this channel: `PAYMENT_METHOD`, `SUBMIT_OTP`, wallet balance display, pending-OTP redial check.
- `CONFIRM` (customer picks 1) → insert order, return `AddToCart`:
  - `Item.ItemName`: human description (e.g. "MTN 5 Bundle"), no special characters
  - `Item.Qty`: 1, `Item.Price`: our price (customer pays Hubtel charge on top)
- Field typing: `phone` for number entry, `decimal` for airtime amount, `number` for menu picks, `display` for info screens.
- `Type: Timeout` → delete session; any pending order stays pending.

### 5.1 All platforms (USSD, Hubtel-App, Webstore)
- The router is platform-agnostic; the mapper reads `Platform` and sets `Label`, `DataType` and `FieldType` meaningfully on every reply (they are mandatory fields), since App/Webstore render rich UI from them (title, input vs display, keyboard type).
- Menu replies stay numbered-text for all platforms (works everywhere); `FieldType` gives App/Webstore the right input control.
- Shop mode on App/Webstore still uses the "enter shop code" step.
- `AddToCart` is identical across platforms.
- Risk: App/Webstore behaviour cannot be exercised locally. The simulator script sends all three `Platform` values, and the plan must include a manual test pass on each platform in Hubtel's environment before enabling.
- Platform is stored on `hubtel_transactions` for diagnostics.

## 6. Orders and payment lifecycle

**At CONFIRM:** insert order into the same table the Uzo flow uses (`ussd_orders`, `ussd_shop_orders`, `airtime_orders`, `results_checker_orders`, AFA table) with `payment_status='pending'`, a Hubtel channel marker, and a row in new `hubtel_transactions` keyed by `SessionId`.

**`hubtel_transactions`** (new): `session_id` (unique), `hubtel_order_id`, `order_table`, `order_id`, `expected_amount`, `amount_paid`, `amount_after_charges`, `payment_status`, `fulfilled_at`, `callback_status` (`pending`/`sent`/`failed`), `callback_attempts`, `callback_last_error`, `status_check_attempts`, timestamps. RLS: service-role only (do not repeat the bare `USING(true)` mistake — see RLS grant model).

**Fulfilment webhook order of operations:**
1. Verify IP/secret.
2. Look up `hubtel_transactions` by `SessionId`; if already processed → 200, no-op (idempotent).
3. Verify `Payment.IsSuccessful` and amount match (`AmountAfterCharges` vs `expected_amount`). Mismatch → mark `needs_review`, do **not** auto-fulfil, surface in admin page. **The `success` callback is still sent** (decision: hold for review, send callback), so Hubtel is not left waiting inside its 1-hour window; the order is resolved manually.
4. Record the payment, then run the shared post-payment function.
5. Queue the callback for the relay (immediate attempt + cron retry).

## 7. Crons

- **Callback retry:** every minute (or per existing cron cadence), picks `callback_status='pending'` rows older than a few seconds and under 1h; sends via relay; marks `sent`/`failed`. Rows still failing at ~50 min get a visible alert on the admin page.
- **Status check:** for pending `hubtel_transactions` with no fulfilment webhook after 5 minutes, call Hubtel status check via relay with `clientReference=SessionId`. `Paid` → run the same shared post-payment function (webhook-equivalent, idempotent). `Unpaid` past a configured window → mark order failed (never fulfilled, no callback needed).

## 8. Callback status policy and its consequence

The callback **always** sends `ServiceStatus: "success"`, including when provider fulfilment fails. Consistent with existing behaviour: a paid order whose provider call fails goes to `processing` for admin manual delivery rather than `failed`. Consequences, accepted:
- Hubtel will never see a delivery failure, so refunds cannot be triggered from Hubtel's side; any refund goes through our own `/admin/refunds` flow.
- Fulfilment failures must be loudly visible in our admin (the existing manual-fulfilment queue + a Hubtel page filter for orders that are paid but not completed).

## 9. Admin page `/admin/ussd-hubtel`

Mirrors the style of the current USSD admin settings:
- Mode toggle (main / shop)
- Per-service visibility (data, airtime, results checker, AFA) — hubtel-specific, independent of the Uzo visibility settings
- Hubtel service code label, collection account number, status-check credentials, callback secret
- DO relay URL + secret
- Status panel: last interaction time, recent Hubtel orders, `needs_review`, callback failed/pending, paid-not-fulfilled
- Manual callback retry and manual status-check buttons
- Admin API routes under `app/api/admin/ussd-hubtel/*` guarded by `verifyAdminAccess`

## 10. Security

- Source-IP allowlist + shared secret on both Hubtel-facing endpoints.
- Relay authenticated; HTTPS; host-allowlisted upstreams.
- Credentials (Hubtel Basic auth, relay secret) in env vars, never in client code or DB-exposed rows.
- Idempotency keyed by `SessionId`/`OrderId` prevents double fulfilment.
- Amount-match check prevents under-payment fulfilment.

## 11. Testing

- Vitest: request/response mapper, router steps for both modes, AddToCart builder (no special characters), amount-match + idempotency in webhook, callback retry/status-check logic with fake clients.
- Regression: extracted post-payment function keeps Paystack webhook behaviour for all order types.
- Simulator script replaying Hubtel's documented sample payloads against the two endpoints.

## 12. Out of scope (v1)

- Wallet / Paystack payment on the Hubtel channel
- Custom App/Webstore-specific layouts beyond correct `Label`/`DataType`/`FieldType`
- Replacing the Uzo codes
- A durable queue on the droplet

## 13. Open questions (need answers before the plan)

1. ~~Platforms~~ — resolved: serve all three (§5.1).
2. ~~Amount mismatch~~ — resolved: hold fulfilment, still send callback (§6).
3. **Payer number:** Hubtel prompts the dialing number for payment. Is that acceptable for all flows (recipient number may differ from payer — same as today's WhatsApp "ask MoMo number" rule)?
4. **Extraction scope:** confirm the Paystack webhook post-payment block can be extracted without changing Uzo behaviour (to be verified when planning; may force a smaller shared helper).
5. **Collection Account Number and Hubtel merchant onboarding** (service creation, code request, whitelisting) are manual steps on your side; the plan will list them.
