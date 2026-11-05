# Hubtel Send Money Refunds Implementation Plan (Plan 5 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can refund a Hubtel-paid order from `/admin/refunds`, paying the customer's MoMo number from the Hubtel disbursement account.

**Architecture:** A new `hubtel_send` gateway in `lib/refunds/gateways/`, reached through two new fixed relay routes. Hubtel's status check decides the outcome, never a callback body. It reuses the existing refund claim, clawback and reconcile flow, and ships dark behind its own switch.

**Tech Stack:** Next.js 15, Supabase, Vitest, the DigitalOcean relay (`scripts/hubtel-relay/`).

**Spec:** `docs/superpowers/specs/2026-11-04-hubtel-payment-gateway-design.md` (Refunds, Constraints). API text: `docs/hubtel-payments/04-direct-send-money.txt`.

## Global Constraints

- Money out: `failed` means money definitely did not move. Anything else is `unknown` or `pending`, and is never retried with a new reference.
- `ClientReference` is the refund id's UUID with the dashes removed: 32 lowercase hex, opaque (owner rule), and the same on any repeat, so Hubtel's duplicate rule (HT-S0001) blocks a second send.
- `Description` is exactly `Refund`. No surface or product word.
- Only a `hubtel_payments` row with status `paid` makes an order refundable here. `pending`, `confirming` and `needs_review` stay refused.
- The refund amount is capped at what we requested (`handler_amount_pesewas ?? amount_pesewas`), never the gross Hubtel reports, which includes Hubtel's fee.
- Relay routes expose fixed Hubtel paths only, with strict validation, `redirect: "error"` and a `sent` flag.
- PII-free logs: no msisdn. Secrets never in commands or settings.
- Nothing can send until `HUBTEL_SEND_REFUNDS_ENABLED === "true"`; the gateway's `supports()` refuses before that.
- Prod steps follow the prod change protocol, with the owner's OK.

## Review Focus

1. A timeout after the send is `unknown`: the admin can't retry into a second payment.
2. 2001 is ambiguous in Hubtel's docs (processor error, invalid number or duplicate reference), so it is `unknown`, not `failed`.
3. Status check "no match" right after sending is not failure: it stays `pending` until the reconcile window passes, then needs a human.
4. An order paid by two attempts, or an attempt that turned `needs_review`, can't be refunded automatically.
5. A checkout-paid order has no stored MoMo number: the destination is what the admin confirms in the dialog, and a card payment is refused.

---

### Task 1: Relay routes

**Files:** Modify `lib/ussd-hubtel/relay-handler.ts`, `scripts/hubtel-relay/server.ts`, `scripts/hubtel-relay/README.md`. Test `lib/ussd-hubtel/relay-handler.send.test.ts`.

**Interfaces:**
- `POST /send` body `{ reference, msisdn, channel, amount, callbackUrl }` -> `POST https://smp.hubtel.com/api/merchants/{HUBTEL_DISBURSEMENT_ACCOUNT}/send/mobilemoney` with `RecipientName` = msisdn, `RecipientMsisdn`, `Channel`, `Amount`, `PrimaryCallbackURL`, `Description: "Refund"`, `ClientReference`. Reply `{ ok, upstreamStatus, body, sent }`.
- `GET /send-status?clientReference=` -> `GET https://smrsc.hubtel.com/api/merchants/{HUBTEL_DISBURSEMENT_ACCOUNT}/transactions/status?clientReference=`.
- Auth `cfg.sendBasicAuth ?? cfg.statusBasicAuth` (`HUBTEL_SEND_BASIC_AUTH` optional).
- Validation as `/receive`: same reference, msisdn, channel, amount and callback host rules. Without a disbursement account: 501.

- [ ] Tests with a fake fetch: exact URL, headers, body; every validation rule rejects without calling fetch; unauthenticated 401; throw before sending gives `sent: false`; timeout after sending gives `sent: true`.
- [ ] RED, implement, GREEN, commit.

### Task 2: Client and outcome classification

**Files:** Create `lib/refunds/hubtel-send-client.ts` + test.

**Interfaces:**
- `sendRefundReference(refundId: string): string` -> UUID without dashes; throws on anything else.
- `classifySend(reply): GatewayOutcome`:
  - 0001 -> `pending`, 0000 -> `completed`.
  - 4075 (insufficient balance), 3050 (not registered for MoMo), 4000 (validation) -> `failed`, as does relay `sent: false` and HTTP 401/403/404/405 with no Hubtel acceptance. These mean nothing was sent.
  - 2001, 5000, any 5xx, a timeout, an unreadable body, any other code -> `unknown`.
- `classifySendStatus(reply): GatewayOutcome`: `transactionStatus` "success" -> `completed`; a clearly failed status -> `failed`; no match or anything else -> `pending`. The docs show only `success`, so failed values are recorded in Task 6's live test and the mapping is an allowlist until then.

- [ ] A test per row above, with the doc's sample replies. RED, implement, GREEN, commit.

### Task 3: Gateway and eligibility

**Files:** Create `lib/refunds/gateways/hubtel-send.ts` + test. Modify `lib/refunds/gateways/index.ts`, `lib/refunds/eligibility.ts`, `lib/refunds/orders.ts`, `lib/refunds/types.ts`.

**Interfaces:**
- `hubtelSendGateway: RefundGateway`, id `hubtel_send`, label `Hubtel (MoMo payout to payer)`, placed before `manual`. `supports`: switch on, `order.payment.hubtelCollection`, the attempt status is `paid`, a valid payer number, `paymentMethod` isn't a card.
- `orders.ts` carries the attempt's status, stored msisdn and channel, and requested amount onto `payment`; the payer number comes from the attempt's msisdn when it has one.
- `eligibility.ts` keeps refusing `hubtelCollection` unless the attempt is `paid`. Then allowed gateways are `hubtel_send`, `wallet` (only where wallet already applies) and `manual`. Paystack reversal and the Paystack and Moolre payouts stay refused, so one payment is refunded from one pot.
- `order_refunds.gateway` is plain text with no CHECK in its create migration. Confirm the claim RPCs (`20261005`, `0120`, `0123`, `20261007`) don't list gateway ids; if one does, add an idempotent migration with a selftest.

- [ ] Tests: each refusal above; a Hubtel-paid order offers exactly those gateways; amount cap; Paystack-paid orders are offered exactly what they are today; two clicks give one send (existing claim). RED, implement, GREEN, commit.

### Task 4: Callback and reconcile

**Files:** Create `app/api/webhooks/hubtel-send/route.ts` + test. Modify `lib/refunds/reconcile-paystack.ts` and its cron route.

**Interfaces:**
- Callback URL carries `ref` and an HMAC `sig` (key `HUBTEL_PAYMENTS_CALLBACK_SECRET` with a distinct prefix). The route only triggers a status check; the body decides nothing. Bad signature 401.
- Reconcile treats `hubtel_send` rows as lookupable by refund id, after 5 minutes (Hubtel's rule). `pending` older than 24 h alerts admins instead of changing state.

- [ ] Tests: forged signature refused; a callback body saying success with a status check saying otherwise doesn't complete; reconcile moves pending to completed and failed; refund and clawback run once whichever arrives first. RED, implement, GREEN, commit.

### Task 5: Verify and ship dark

- [ ] Full suite (known failures only), placeholder-env build from PowerShell, a fresh reviewer on the most capable model available. Opus's weekly limit resets Nov 10, 10am Reykjavik time; this code should get Opus before the switch goes on.
- [ ] With the owner's OK: migration if any (dry run first), push, redeploy the relay with a dated backup, no-charge smoke checks.

### Task 6: Supervised live test (owner present)

- [ ] Hubtel confirms the key may send, and the disbursement account is funded. A 2026-11-05 probe got a valid answer from `smrsc`, but a bare 500 from `smp` on an empty body, so send permission is unproven.
- [ ] Turn the switch on. Refund one real small Hubtel-paid order to the owner's own number.
- [ ] Record replies in `docs/hubtel-payments/`: callback casing, status values, fee, who bears it. Fix the allowlist from Task 2 with what's learned.
- [ ] Only then treat refunds as live for other admins.
