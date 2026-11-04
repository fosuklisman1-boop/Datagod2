# Payment Gateway — Plan 4: Wire the 6 surfaces

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every payment start asks the surface's config which gateway to use; Hubtel works on all 6 surfaces with fallback to Paystack on a definite refusal. Ships dark: every surface stays on Paystack, and Hubtel can't be selected until `HUBTEL_COLLECTIONS_ENABLED=true`.

**Architecture:** Two wrappers with the same contract as Paystack's start functions: `startMomoCharge(surface, params)` mirrors `chargeMobileMoney`, `startHostedPayment(surface, params)` mirrors `initializePayment`. Call sites change one line. On `paystack` the wrappers call the existing function unchanged. On `hubtel` they insert a `hubtel_payments` row, then call the relay, and map the outcome back to the Paystack-shaped result callers already handle.

**Tech Stack:** Next.js 15, Supabase, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-hubtel-payment-gateway-design.md`. **Must read:** `docs/superpowers/plans/2026-11-04-payment-gateway-plan4-carry-list.md`; every item is handled by a task below.

**Plan 4 of 5.** Base: `feat/payment-gateway` after Plan 3.

## Global Constraints

- **Zero change while on Paystack.** With every surface on `paystack`, each call site behaves as today (same params, result, errors). `initialize` tests and existing suites pass unchanged except for mock wiring.
- **Row before request.** The `hubtel_payments` row is inserted before Hubtel is called. If the insert fails, nothing is sent and the wrapper falls back to Paystack with an alert.
- **Fallback only on `refused`** (and on nothing-sent start errors: `HubtelPayInputError`, not-configured). On `unknown`, never fall back: the row stays `pending` and the caller is told the prompt is on its way. `not_found` never means fall back. A fallback closes the Hubtel row as `failed` and uses a brand-new attempt on Paystack with the caller's original reference; a Hubtel reference is never reused.
- **Opaque references:** Hubtel only ever sees `newHubtelReference()`. The caller's reference (order id, `WALLET-…`) goes in `internal_reference`; Paystack metadata goes in `metadata`.
- **Description sent to Hubtel is neutral:** `"Payment"` only, no surface or product name.
- **Amounts:** rounded with `Math.round(x * 100) / 100` before the relay. Minimum 0.10; below it, Paystack is used.
- **No unsolicited prompts (Hubtel's rule; replaces the spec's "existing bot OTP step", which is Paystack's own OTP and verifies nothing):**
  - USSD: `phone` must equal the dialling number.
  - Web `direct` on Hubtel: `isPhoneOtpVerified(phone)` is required even when the surface's OTP gate is off; a logged-in user's own verified number also counts.
  - WhatsApp: the typed MoMo number must equal the sender's number or pass `isPhoneOtpVerified`. Otherwise that payment uses Paystack. The standing rule still applies: always ask for the number, never auto-charge the sender.
- **Fees:** on Hubtel rows `wallet_payments.fee` is 0 and Hubtel adds its own charge on top. `feeBearer: "merchant"` requests less from Hubtel and tells the handler the full price (Task 1). On Paystack rows with `feeBearer: "merchant"`, `paystackFee` is 0.
- **Paystack-only verifiers never touch Hubtel rows.** Hubtel `wallet_payments` rows have `payment_method = 'hubtel'`.
- **Caller rules for Tasks 4-7** (from Task 1's review; callers mint a new reference or order per attempt, so the unique index alone doesn't give one attempt per order):
  - **R1:** check the order is still open before any start. `botFlowChargeOrder` already does.
  - **R2:** web paths with an `orderId` look up a live payment row by `order_id` and replay it instead of minting a new reference (copy the replay block in `lib/bot-commission/momo.ts`, 15-minute window).
  - **R3:** a retry after failure mints a new order, never the same reference. `handleChargeSuccess` answers 200 "already processed" for a `failed` USSD order, so confirm must treat that as needs_review (Task 3).
- **Gateway resolved before the amount.** USSD and bot amounts already include Paystack's fee (`bundles.ts`: `chargeAmount = price + fee`, stored as the order amount). Use `resolveSurfaceGateway(surface, { verifiedPayer })` from `start.ts` BEFORE writing the order row: on Hubtel the order amount has no Paystack fee. If that charge later falls back to Paystack, it charges the order's amount and we absorb the fee on that one payment.
- **Timeouts:** every wired route that awaits a start sets `export const maxDuration = 60`. Bots await the charge inside the live USSD reply (`kit.ts`), so Task 6 defers it with `after()` or gives it a relay budget under Uzo's reply limit.
- Money path: fresh reviewer for each task; failing tests first; Edit/Write only; `next build` from PowerShell; don't run a commit chained after a command that can fail.

## Review Focus

1. **Hubtel refuses mid-USSD session** — the customer still gets a Paystack prompt, exactly one prompt in total. Task 1.
2. **Hubtel times out (`unknown`)** — no Paystack prompt; the sweep settles it. Task 1.
3. **A web client tampers with `gateway` or `mode` in the request body** — ignored; only server config decides. Task 4.
4. **Admin flips a surface mid-payment** — an in-flight Hubtel payment is still confirmed by Hubtel; a Paystack one by Paystack. Tasks 3-4.
5. **A Paystack verifier cron meets a Hubtel row** — doesn't mark it failed or abandoned. Task 3.

---

### Task 1: `startMomoCharge`

**Files:** Create `lib/payment-gateway/start.ts`, `lib/payment-gateway/start.test.ts`. Modify `migrations/0151_hubtel_payments.sql` + selftest (unapplied): add `handler_amount_pesewas integer`, `refused_at timestamptz`, and a partial unique index on `internal_reference` where `internal_reference IS NOT NULL AND status IN ('pending','confirming')`. Modify `lib/hubtel-pay/confirm.ts`: pass `handler_amount_pesewas ?? amount_pesewas` to the handler. Modify `lib/hubtel-pay/sweep.ts`: rows with `refused_at` set are never re-checked (nothing reached Hubtel).

**One open attempt per order:** the unique index stops two open rows sharing an `internal_reference`, because an expired first attempt would otherwise run `handleChargeFailed` on an order a retry has paid. On a unique-violation insert, an attempt is already open: don't send a second prompt and don't fall back; return `pay_offline` (direct) or the stored `checkout_url` (hosted). Also in `confirm.ts`: before calling `handleChargeFailed` for an expired row, skip the handler if another row with the same `internal_reference` is `paid` or open, and just close this row as `failed`.

**Interfaces:**
- `startMomoCharge(surface: SurfaceKey, params: ChargeMobileMoneyParams & { verifiedPayer?: boolean }, deps?): Promise<{ status: string; reference: string; gateway: Gateway; hubtelReference?: string }>`. `status` is `"pay_offline"` on accepted or unknown.
- Provider map: `mtn→mtn-gh`, `vod→vodafone-gh`, `tgo→tigo-gh`. `msisdn` as `233XXXXXXXXX`. `expires_at` = now + 15 minutes.
- Export `ChargeMobileMoneyParams` from `lib/paystack.ts` (type only).
- Alert with a throttled `notifyAdmins` on `isConfigRefusal(outcome)`, `relay_404`, Hubtel 404/405, and start errors.

- [ ] Tests: paystack config → `chargeMobileMoney` called with identical params, no row; hubtel accepted → row inserted before the call (order asserted), with internal_reference and metadata; refused → row `failed`, Paystack charged once; unknown → row pending, Paystack not called, status `pay_offline`; insert fails → Paystack, alert; `verifiedPayer: false` → Paystack, nothing sent to Hubtel; Hubtel not ready → Paystack; amount under 0.10 → Paystack; float amount rounded; merchant bearer → requested amount lowered, handler amount = full; description is `"Payment"`; each reference passes the opaque word test; a second start for the same order while one is open → no second prompt, no Paystack; an expired attempt whose order has a paid sibling → no `handleChargeFailed`; a refused row sets `refused_at` and the sweep skips it. RED → implement → GREEN → commit.

### Task 2: `startHostedPayment` + return route

**Files:** Modify `lib/payment-gateway/start.ts` + test. Create `app/api/payments/hubtel-return/route.ts` + test.

**Interfaces:**
- `startHostedPayment(surface, params: InitializePaymentParams, deps?): Promise<{ authorizationUrl: string; accessCode: string; reference: string; gateway: Gateway }>`. On Hubtel: `authorizationUrl` = `checkoutUrl`, `accessCode` = `""`, `reference` = the caller's. `expires_at` = now + 60 minutes.
- Return route: `GET /api/payments/hubtel-return?ref=<opaque>&sig=<hmac>`. Hubtel's return and cancel URLs must be on the app host, so this route verifies the signature, calls `confirmHubtelPayment(ref)` best effort, and redirects to the caller's original `redirectUrl` (with `reference=<caller's>`), which is stored server-side in `metadata`, never taken from the query. This handles shop subdomains and custom domains.

- [ ] Tests: hubtel accepted returns the checkout URL; refused → Paystack URL; unknown → **throw a clear "try again" error** (no URL to send them to and no fallback); return route with a bad sig → 400 and no redirect; good sig → redirects only to the stored URL; an open-redirect attempt via query is ignored. RED → implement → GREEN → commit.

### Task 3: Verifiers and handler corrections

**Files:** Modify `app/api/cron/verify-pending-payments/route.ts`, `lib/payment-cleanup-service.ts`, `app/api/admin/payment-reverify/route.ts`, `app/api/shop/payment-reverify/route.ts`, `app/api/payments/verify/route.ts`, `app/api/payments/momo-status/route.ts`, `lib/refunds/eligibility.ts`, `lib/payments/charge-events.ts`.

- Each verifier: rows with `payment_method = 'hubtel'` skip Paystack. `verify` and both reverify routes call `confirmHubtelPayment(reference)` instead, looked up by `internal_reference`. `momo-status` reports from the payment row without calling Paystack. USSD-table verifiers skip orders with a live `hubtel_payments` row (lookup by `internal_reference`).
- `lib/refunds/eligibility.ts`: a Hubtel-paid order isn't treated as abandoned.
- Handler: return 500 on a `credit_wallet_safely` `rpcError` (Paystack retries, Hubtel row goes to review). Neutral wording instead of "via Paystack" when `metadata.gateway === "hubtel"`. Add a read-only prod check to Task 8 for the `paystack_transaction_id` and `transaction_id` column types; if numeric, Hubtel's hex id must not be written there, so write it only to `hubtel_payments`. The handler skips those writes when `metadata.gateway === "hubtel"`.
- [ ] Tests for each verifier: a Hubtel row is untouched by the Paystack path, and a Paystack row behaves as before. rpcError → 500. RED → implement → GREEN → commit, one commit per file group.

### Task 4: Wire `/api/payments/initialize` (wallet_topup, storefront, dashboard_direct)

**Files:** Modify `app/api/payments/initialize/route.ts`, `app/api/payments/submit-otp/route.ts` (no change expected: Hubtel never returns `send_otp`; add a test).

- Surface: shop order → `storefront`; top-up → `wallet_topup`; upgrade → `dashboard_direct`; results-check service → `dashboard_direct`. Commission bot rows are handled in Task 6.
- Read `getSurfaceConfig(surface)` once, on the server. Fee calculation branches on gateway and bearer; `payment_method` is written accordingly; `momoDirect` uses `startMomoCharge`, hosted uses `startHostedPayment`.
- Hubtel `direct` on web: require a verified number (constraint above) or answer the same OTP-required response the route gives today.
- [ ] Tests: all existing tests pass unchanged on paystack; hubtel top-up → `fee` 0, `payment_method` hubtel, `amount` = price; client-supplied `gateway`/`mode` ignored; unverified number on Hubtel direct → OTP-required; merchant bearer on Paystack → fee 0. RED → implement → GREEN → commit.

### Task 5: Wire the remaining web starts (sms, storefront AFA, dashboard)

**Files:** Modify `app/api/sms/units/purchase/route.ts`, `app/api/sms/units/purchase-paystack/route.ts`, `lib/sms/activation-service.ts` (surface `sms`), `app/api/shop/afa/initialize/route.ts` (surface `storefront`), `lib/storefront-commission/payment.ts`, `app/api/results-check/initialize/route.ts`, `app/api/dashboard/ussd-shop/whatsapp-activate/route.ts` (surface `dashboard_direct`).

- SMS metadata (`type`, `sms_account_id`, …) and `smsbundle-` style references go through `internal_reference` and `metadata`, so the handler's SMS branch still matches. Pin this with a test through `confirmHubtelPayment` into the real `handleChargeSuccess`.
- [ ] Tests per route: paystack unchanged; hubtel path sets the right surface, internal reference and metadata. RED → implement → GREEN → commit.

### Task 6: Wire USSD

**Files:** Modify `lib/ussd/handlers/{afa,airtime,bundles,results-checker}.ts`, `lib/ussd-shop/handlers/{airtime,bundles,results-checker}.ts`, `lib/bot-commission/momo.ts` (surface `ussd`, or `whatsapp` when the channel is whatsapp, as `channel` already tells these handlers).

- Replace `chargeMobileMoney(` with `startMomoCharge(surface, ` at each site. `verifiedPayer` = `phone === dialingPhone`. Handlers that treat a Paystack error as a failed order keep doing so; Hubtel `unknown` must not fail the order.
- Writing `paystack_reference: orderId` stays (the handler looks up by id). `paystack_provider` stays required.
- [ ] Tests: for each handler one paystack-unchanged test and one hubtel-accepted test; `send_otp` branch never fires on Hubtel; a wrong-number payment (recipient differs from payer) still charges the dialler. RED → implement → GREEN → commit.

### Task 7: Wire WhatsApp

**Files:** Modify `lib/whatsapp-bot/shop-router.ts`, `lib/whatsapp-bot/router.ts` where they call charge paths directly.

- `verifiedPayer` = typed number equals sender, or `isPhoneOtpVerified(typed)`. Unverified → that payment goes to Paystack as today.
- [ ] Tests: sender's own number → Hubtel; another verified number → Hubtel; an unverified other number → Paystack; the prompt message never says which gateway. RED → implement → GREEN → commit.

### Task 8: Readiness, needs-review tooling, ship dark

**Files:** Modify `lib/payment-gateway/hubtel-readiness.ts` (ready only when `HUBTEL_COLLECTIONS_ENABLED === "true"` and all env present), `app/admin/gateway/page.tsx`. Create `app/admin/gateway/_components/NeedsReviewCard.tsx`, `app/api/admin/gateway/hubtel-payments/route.ts` + test.

- Admin list of `needs_review` and stale `confirming` rows: reference, internal reference, amount, reason from `last_check`, age. Actions behind `verifyAdminAccess`: **Re-check** (status check, shows the result), **Fulfil** (only when the status check says Paid at or above the amount: calls the handler, guarded so it can run once), **Mark failed**. Every action logged with the admin id. Add a NEW tag per `lib/nav-new.ts` only if a sidebar item is added.
- [ ] Tests: non-admin refused; Fulfil refused when status isn't Paid; two Fulfil clicks → one handler call. RED → implement → GREEN → commit.
- [ ] Full suite with nothing else running, placeholder-env build from PowerShell, fresh whole-branch review on the most capable model.
- [ ] Prod steps need the owner's OK, together with Plan 3's Task 7. Going live per surface comes only after a supervised real payment on that surface, one surface at a time, starting with `wallet_topup`.
