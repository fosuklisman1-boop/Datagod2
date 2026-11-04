# Hubtel as a second payment gateway — per-surface admin switch

Date: 2026-11-04
Status: design, awaiting approval
Hubtel API reference (verbatim): `docs/hubtel-payments/01..06-*.txt`
Related: `2026-10-21-hubtel-refund-gateway-design.md` (Hubtel Refund API for Hubtel-USSD orders — different mechanism, see Refunds)

## Intent

Today every customer payment on Datagod is collected by Paystack. We want Hubtel
as a second collection gateway, and the admin decides **per surface** which
gateway (and which payment style) is used. Reasons: redundancy when Paystack has
trouble, cost/fee choice, and Hubtel's broader MoMo reach. Nothing changes for
customers until an admin flips a switch.

## The 6 surfaces (one admin row each)

| # | Surface key | Covers (existing code entry points) |
|---|---|---|
| 1 | `wallet_topup` | Dashboard wallet funding — `app/api/payments/initialize` (`wallet_topup`) |
| 2 | `storefront` | Shop web checkout: data, airtime, results checker, AFA (`app/api/shop/orders/create`, `app/api/shop/afa/initialize`, `app/api/payments/initialize` with shopId) + commission storefront (`lib/storefront-commission/payment.ts`: airtime, bills, standard bundles) |
| 3 | `dashboard_direct` | Dealer upgrade (`dealer_upgrade`), results-check service, USSD-shop WhatsApp activation |
| 4 | `sms` | SMS bundles, SMS units, SMS activation (`app/api/sms/*`, `lib/sms/activation-service.ts`) |
| 5 | `ussd` | Uzo/main + shop USSD menus (`lib/ussd/handlers/*`, `lib/ussd-shop/handlers/*`) + USSD bot-commission MoMo (`lib/bot-commission/momo.ts`) |
| 6 | `whatsapp` | Main + shop WhatsApp bots (`lib/whatsapp-bot/router.ts`, `shop-router.ts`) incl. bot-commission services |

Out of scope: Hubtel USSD flows (`lib/ussd-hubtel/flows/*` — already paid via
Hubtel's own USSD checkout), wallet-balance payments (no gateway), outbound
withdrawals.

## Per-surface settings (decided)

Each surface row has three settings:

1. **Gateway**: `paystack` | `hubtel`. Default `paystack` for all 6.
2. **Mode**: `checkout` (hosted page/popup) | `direct` (server-side MoMo prompt to a verified number).
   - Paystack: `checkout` = Paystack popup/redirect; `direct` = existing Paystack `/charge` flow.
   - Hubtel: `checkout` = **Online Checkout** (`payproxyapi.hubtel.com/items/initiate`, rendered via `@hubteljs/checkout` modal or redirect); `direct` = **Direct Receive Money** (`rmp.hubtel.com/.../receive/mobilemoney`).
   - `ussd` and `whatsapp` are locked to `direct` (no browser). The UI shows `checkout` disabled for them.
3. **Fee bearer**: `customer` (fee added on top of the price, as Paystack works today) | `merchant` (customer pays exactly the price; fee comes out of our margin). Applies to whichever gateway is active on that row.

This **replaces** the existing `admin_settings` keys `storefront_direct_charge`
and `wallet_direct_charge` (read in `lib/storefront-otp.ts`). Migration: seed the
new per-surface config from those keys' current effective values (including the
"row absent ⇒ inherit OTP gate" rule), so the live behaviour is identical on
day one. The OTP-required gates (`isStorefrontOtpRequired`, `isWalletOtpRequired`)
stay as they are — they are a separate concern.

Hubtel Direct Debit (preapproval, no-PIN) is **not** in v1. Send-To-Bank is not used.

**Hubtel is MoMo/wallet only — no bank cards (decided).** Every Hubtel payment must
be refundable to the payer's MoMo via Send Money. The Online Checkout initiate API
documents **no parameter to restrict payment methods**, so: (a) ask Hubtel to disable
card on the collection account; (b) regardless, the server rejects/flags any Hubtel
payment whose `paymentMethod`/`PaymentType` is not mobile money (treat as
needs-review, never auto-refund to MoMo); (c) if Hubtel cannot disable cards, Hubtel
`checkout` mode stays unavailable and web surfaces use Hubtel `direct` instead.

**Hubtel fees are added on top for the customer (account behaviour, per owner).**
So for Hubtel rows: fee bearer `customer` = send the item price as the amount and let
Hubtel add its charge; fee bearer `merchant` = reduce the requested amount by the
admin-entered Hubtel fee % so the customer's total ≈ item price and we absorb the
fee. Actual charges are always taken from the status-check response
(`charges`, `amountAfterCharges`) and stored; the admin Hubtel fee % is only an
estimate for pricing/preview. To be confirmed in the supervised live test.

## New admin page: `/admin/gateway` (decided)

A dedicated **Gateway** admin page (sidebar entry with a NEW tag per `lib/nav-new.ts`).
Payment-related controls move here from `/admin/settings`
(`app/admin/settings/page.tsx`) so all money settings live in one place.

Sections:

1. **Surfaces** — the 6 rows × Gateway / Mode / Fee bearer.
   - *Merged in:* "Storefront direct charge" → Storefront row Mode; "Wallet/upgrade direct charge" → Wallet top-up row Mode (and Dashboard purchases row, which today shares the wallet toggle).
   - *Moved:* "Wallet top-up fee %" (our own markup) → an "extra fee" field on the Wallet top-up row.
2. **Gateway fees & status** — per-gateway fee % table (Paystack % — moved from "Paystack Fee Percentage"; Hubtel % — new), Hubtel credential/config status (present / missing; Hubtel options disabled until present), and the fee preview box (moved, generalised to show either gateway).
3. **Payment verification** — moved as-is: checkout phone-OTP gate, wallet/upgrade payment-lock (wallet OTP), "Reset all phone verifications" + verified-number count.
4. **Payouts** — moved as-is: withdrawal fee %, withdrawal fee minimum, minimum withdrawal amount. No payout-gateway switch in v1 (section exists so one can be added later).

Stays on `/admin/settings`: Turnstile kill switch and all non-payment settings.

Move rules: the underlying settings keys and API routes
(`/api/admin/settings/storefront-otp`, `wallet-otp`, `storefront-direct-charge`,
`wallet-direct-charge`, fee fields in `/api/admin/settings`) keep working during the
transition so nothing breaks mid-deploy; the old Settings-page cards are removed only
once `/admin/gateway` is live. Fee/withdrawal values must not be lost or reset by the
move (the Settings page currently saves fees in one bulk POST — the Gateway page must
not overwrite unrelated keys, and Settings must stop posting the moved keys).

## Behaviour rules (decided)

- **Gateway pinned per payment.** Each payment attempt records `gateway` and `mode` at creation; confirmation, status checks and refunds always use the recorded gateway. Flipping a switch affects only new payments.
- **Hubtel selectable only when configured.** The admin cannot set a row to Hubtel unless Hubtel collection credentials + Collection Account Number are present; the server re-checks at payment time.
- **Auto-fallback to Paystack.** If Hubtel *definitively refuses* to start a payment (4000, 4070, 4101, 4103, or a connection error before the request was sent), the same attempt is re-initiated on Paystack (same mode where possible) and an admin alert fires (existing security/admin alerting). Fallback happens **only before** any customer prompt/page was issued — never after a 0001/accepted response, to avoid double charges.
  - *Builder-check call (mine):* `0005`, `5000`, and any timeout / 5xx **after the request was sent** are **outcome-unknown**, not refusals: no fallback; the attempt is held and resolved by status check (same principle as `HubtelOutcomeUnknownError` in `lib/hubtel-cs`). The customer sees "payment pending — we'll confirm shortly".
- **No unsolicited prompts (Hubtel requirement).** Hubtel `direct` may only target: the dialling number on USSD; a number verified by our phone OTP (`isPhoneOtpVerified`) on web; a number confirmed through the existing bot OTP step on WhatsApp. WhatsApp keeps the standing rule: always ask for the MoMo number, never auto-charge the sender.
- **Callbacks are never trusted alone.** Hubtel callbacks are unsigned (IP hint only: 108.129.40.25 checkout, 18.202.122.131 receive money). On every callback, the server calls the Transaction Status Check (`api-txnstatus.hubtel.com/transactions/{CollectionAccount}/status?clientReference=`) and fulfils only on `status: "Paid"` with amount ≥ expected.
- **Same fulfilment path.** A confirmed Hubtel payment must enter the *same* "claim paid → fulfil" logic the Paystack webhook / `/api/payments/verify` use today (keyed on order_type / metadata.type), with the same idempotent claim, so a payment can never be fulfilled twice whichever channel (callback, status-check sweep, return-URL verify) arrives first.
  - *Builder-check call (mine):* no shared function exists today — the logic is inline in `app/api/webhooks/paystack/route.ts` (~1,600 lines) and partly duplicated in `app/api/payments/verify/route.ts`. Extract it into `lib/` as a gateway-neutral `confirmPayment(attempt, verifiedAmount)` **first, as its own phase**, guarded by characterization tests that pin current Paystack behaviour per order type, with a fresh reviewer, and shipped before any Hubtel code. Paystack behaviour must be byte-for-byte unchanged by that phase.
- **5-minute sweep.** A cron sweeps Hubtel attempts still pending after 5 minutes and resolves them via status check (Hubtel marks this mandatory). Reuse the `verify-pending-payments` cron pattern.
- **Refunds** for Hubtel-paid orders go back via **Hubtel Direct Send Money** (`smp.hubtel.com/api/merchants/{Disbursement}/send/mobilemoney`) to the payer's MoMo number, from the Hubtel disbursement account, integrated as a new gateway in `/admin/refunds` (`lib/refunds/gateways/`), with Send-Money status check (`smrsc.hubtel.com`) in the reconcile cron.
  - The existing Hubtel Refund API gateway (live on main 7db74ce4, for Hubtel-USSD orders) is a different mechanism and stays as-is; the new Send Money gateway sits alongside it. Each payment stores the payer MoMo number + channel so the refund target is known.

## Constraints

- **IP whitelisting.** All Hubtel receive/status/send endpoints accept only whitelisted IPs (max 4 per service). Vercel has no fixed egress, so every Hubtel server call goes through the existing relay (`HUBTEL_RELAY_URL` / `HUBTEL_RELAY_SECRET`, already used by `lib/hubtel-cs`). Online Checkout initiate is *not* documented as IP-restricted but should also go via the relay for consistency.
  - The relay is ours: source in `scripts/hubtel-relay/`, deployed on the DigitalOcean droplet (last redeployed 2026-10-22 for the refund gateway). This work includes adding relay routes (checkout initiate, receive money, collection status check, send money, send-money status check) and redeploying it. Relay routes only expose fixed Hubtel paths — never a generic proxy.
  - *Builder-check call (mine):* new collection credentials live on the **relay** (as the refund/CS Basic auth do), not in Vercel env; Vercel only holds the relay secret and callback secrets.
- **Credentials (env, never in settings/DB):** Hubtel collection Basic auth (API ID:Key with `mobilemoney-receive-direct` scope), Collection Account Number; the disbursement account + auth already exist for commission services (`HUBTEL_DISBURSEMENT_ACCOUNT`, `HUBTEL_CS_BASIC_AUTH`) — confirm whether Send Money can reuse them.
- **clientReference**: unique, ≤32 chars for Online Checkout (≤36 for the others) — use one generator that satisfies 32.
- **Amounts**: 2 decimal places max. Descriptions: no special characters (`&*!%@` cause 2001).
- **Channels** for direct: `mtn-gh`, `vodafone-gh`, `tigo-gh` — derive from the number's network prefix (existing prefix map).
- Money-path change: fresh reviewer mandatory; TDD with logic in `lib/`; ships **dark** (all rows Paystack) and goes live per surface only after a supervised real payment.

## Hubtel account readiness (as of 2026-11-04, per owner)

| Item | State |
|---|---|
| Collection Account Number | ✅ known |
| API keys | ⚠️ owner believes the existing keys are shared — **unverified** that they carry the `mobilemoney-receive-direct` scope (missing scope → 4101) |
| Fees configured on collections | ❓ ask Hubtel (missing → 4070) |
| Card disabled on Online Checkout | ❓ ask Hubtel |
| Relay IP whitelisted for Receive Money, collection Status Check, Send Money | ❓ ask Hubtel (Status Check on the collection account was already needed for CS; confirm the others) |

Build ships dark regardless. Before enabling any row: a readiness check (one
1 GHS Direct Receive Money + status check through the relay) must pass; its error
code tells us which item above is missing.

## Goals / non-goals / anti-goals

- Goal: admin can move any of the 6 surfaces between Paystack and Hubtel, and between checkout/direct, with no deploy.
- Goal: zero behaviour change on deploy.
- Non-goal: Direct Debit preapproval, card-specific UX, Send-To-Bank, Hubtel-based withdrawals.
- Anti-goal: any path where a Hubtel callback alone (without status check) credits a wallet or fulfils an order.
- Anti-goal: a double charge caused by fallback, or a double fulfilment caused by callback + sweep racing.
- Anti-goal: an AT customer stuck with no way to pay.

## Left to the builder

- Storage shape of the per-surface config (one `admin_settings` JSON row vs. rows per surface), caching (follow the 30s cache + fail-to-last-known pattern in `lib/storefront-otp.ts`).
- Whether Hubtel checkout uses the JS SDK modal or a plain redirect to `checkoutUrl` (modal preferred for parity with Paystack popup).
- Exact schema additions (`gateway`, `mode`, `gateway_reference`, fee fields) on the existing attempt/payment tables.
- How fee bearer is shown in the UI breakdown and how `netCreditAmount` (`lib/payment-amounts.ts`) generalises across gateways.
- Gateway page layout and desktop widening (follow the customer-rebuild lg: multi-column convention for admin where it already applies).
