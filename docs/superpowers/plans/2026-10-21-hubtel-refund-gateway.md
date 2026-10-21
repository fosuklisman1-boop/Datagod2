# Hubtel Refund Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin refund a Hubtel-USSD-paid bot order from `/admin/refunds` through Hubtel's Refund API, shipped dark.

**Architecture:** A new `hubtel` `RefundGateway` calls a new `POST /refund` route on the existing DigitalOcean relay (fixed IP) via a small client. Hubtel answers `0001` (pending) and later POSTs a callback to a new authenticated webhook, which settles the ledger through the existing `complete_order_refund` / `mark_refund_processing` RPCs. No migration: callback auth is an HMAC of the refund id, and the on/off switch is an env var.

**Tech Stack:** Next.js 15 route handlers, TypeScript, Vitest, Supabase RPCs (already present), Node `crypto`.

**Spec:** `docs/superpowers/specs/2026-10-21-hubtel-refund-gateway-design.md`

## Global Constraints

- No migration, no schema change. Existing RPCs only: `reserve_order_refund`, `mark_refund_processing`, `complete_order_refund`, `fail_order_refund`.
- Full refund only: the refund amount must equal `hubtel_transactions.amount_paid`; `amount_paid` must be >= 1.00 (Hubtel `4000`).
- 45-day limit measured from `paid_at`, enforced as 44 days.
- Paid = `hubtel_transactions.paid_at IS NOT NULL` and `amount_paid > 0`, matched on (`order_table`, `order_id`). More than one paid row for an order => gateway not offered.
- Only the codes `3000`, `4000`, `4509` mean definitely-not-refunded (`failed`). `4515` => pending (never resend). Timeout / relay error / any other reply => `unknown`, never retried. Any callback `responseCode` other than `0000` is parked (`processing` with a review note), never failed.
- Gateway is hidden unless env `HUBTEL_REFUND_ENABLED === "true"` (default off = dark).
- Callback URL is built from `NEXT_PUBLIC_APP_URL` (production). Callback token = HMAC-SHA256 of the refund id with env `HUBTEL_REFUND_CALLBACK_SECRET`, compared with `timingSafeEqual`.
- Edit/Write tools only for code (no sed). TDD. Run a real placeholder-env `next build` before pushing main. Money change: fresh reviewer on the diff before merge. Do not push to main without checking local main for other sessions' commits.
- Hubtel is only reached through the relay; never call `refund-api.hubtel.com` from Vercel.

## Review Focus

- Double click / two admins refunding the same order: second request must not reach Hubtel (existing one-active-refund guard in `reserve_order_refund`; test that `4515` => pending, not a second reserve).
- Callback replay (Hubtel retries or an attacker replays): second delivery for an already `completed` refund is a no-op with no second customer notification.
- Callback for a refund with the wrong token, wrong amount, or an `orderId` that differs from the stored `gateway_ref`: rejected (401) or parked, never completed.
- Relay not yet redeployed (returns 404 for `/refund`): a relay 404 means nothing reached Hubtel, so the client returns `failed` ("relay not updated") and the refund is compensated cleanly. This must not be confused with a Hubtel `3000`/`4509` 404, which arrives wrapped in `{ok, upstreamStatus, body}` with HTTP 200 from the relay.
- Order with two paid `hubtel_transactions` rows, or a paid row older than 44 days, or `amount_paid` < 1: gateway shown disabled with a reason.

---

### Task 1: Relay `POST /refund` route

**Files:**
- Modify: `lib/ussd-hubtel/relay-handler.ts`
- Modify: `scripts/hubtel-relay/server.ts`
- Test: `lib/ussd-hubtel/relay-handler.refund.test.ts` (new, copy the `mk`/`req` helpers from `relay-handler.cs.test.ts`)

**Interfaces:**
- Produces: `RelayConfig.refundBasicAuth?: string` (defaults to `statusBasicAuth`); `RelayConfig.refundBaseUrl?: string` (default `https://refund-api.hubtel.com`). Route `POST /refund` with body `{ "orderId": string, "callbackUrl": string }`; response shape identical to the other routes: `{ status: 200, body: { ok, upstreamStatus, body } }`, with `upstreamStatus: 0` on a network error.

- [ ] **Step 1: Write failing tests** in `relay-handler.refund.test.ts`: `401 without bearer`; `400 when orderId is not 32 hex chars`; `400 when callbackUrl is not https`; `forwards to https://refund-api.hubtel.com/refund/11684/order/<orderId>` with method POST, header `Authorization: Basic STATUS` (and `Basic REFUNDAUTH` when `refundBasicAuth` is set), JSON body exactly `{ callbackUrl }`; `maps a 202 {responseCode:"0001"} into {ok:true, upstreamStatus:202, body}`; `423 passes through as ok:false, upstreamStatus:423`; `fetch rejection => upstreamStatus 0`.
- [ ] **Step 2: Run** `npx vitest run lib/ussd-hubtel/relay-handler.refund.test.ts` — expect FAIL (404 not found).
- [ ] **Step 3: Implement** the `/refund` branch in `createRelayHandler`, same style and `UPSTREAM_TIMEOUT_MS` as `/status`. Validate `orderId` with `/^[a-f0-9]{32}$/`, `callbackUrl` with `new URL(...).protocol === "https:"` and length <= 500. Never echo credentials.
- [ ] **Step 4: Wire** `refundBasicAuth: process.env.HUBTEL_REFUND_BASIC_AUTH || undefined` in `server.ts`; add one line to `scripts/hubtel-relay/README.md` documenting `/refund` and the env var.
- [ ] **Step 5: Run** the new test file plus `lib/ussd-hubtel/relay-handler.test.ts` and `relay-handler.cs.test.ts` — expect PASS.
- [ ] **Step 6: Commit** `feat(relay): add POST /refund passthrough for Hubtel refunds`.

### Task 2: Refund client and callback token

**Files:**
- Create: `lib/refunds/hubtel-refund.ts`
- Test: `lib/refunds/hubtel-refund.test.ts`

**Interfaces:**
- Consumes: relay `POST /refund` from Task 1 (`HUBTEL_RELAY_URL`, `HUBTEL_RELAY_SECRET`, same bearer scheme as `lib/ussd-hubtel/relay.ts`).
- Produces:
  - `signCallbackToken(refundId: string): string` and `verifyCallbackToken(refundId: string, token: string): boolean` (HMAC-SHA256 hex; `false` on any malformed input or missing secret).
  - `buildCallbackUrl(refundId: string): string` => `${NEXT_PUBLIC_APP_URL}/api/webhooks/hubtel-refund?refund=<id>&t=<token>`; throws if either env is missing.
  - `classifyRefundReply(upstreamStatus: number, body: unknown): GatewayOutcome` (pure; `ref` = the Hubtel `orderId` when present).
  - `requestHubtelRefund(hubtelOrderId: string, refundId: string, fetchImpl?: typeof fetch): Promise<GatewayOutcome>`.

- [ ] **Step 1: Write failing tests.** `classifyRefundReply`: `(202,{responseCode:"0001",data:{orderId:"X"}})` => `{kind:"pending",ref:"X"}`; `(423,{responseCode:"4515"})` => pending; `(404,{responseCode:"3000"|"4000"|"4509"})` => `failed` with Hubtel's message in `error`; `(500,"html")` => `unknown`; `(0,"timeout")` => `unknown`; `(404, non-JSON body)` => `unknown`; a 404 whose `responseCode` is not one of the three => `unknown`. Token: round trip true; wrong token false; token for another refund id false; different length false (no throw); empty secret => `verify` false and `sign` throws. `requestHubtelRefund`: a relay `404` (route missing) => `{kind:"failed", error:"Hubtel relay has not been updated to support refunds"}`; relay unreachable / non-200 => `unknown`; relay not configured => `failed` ("relay not configured", nothing was sent).
- [ ] **Step 2: Run** `npx vitest run lib/refunds/hubtel-refund.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the four functions in `lib/refunds/hubtel-refund.ts`. Reuse the error-shape handling idea from `lib/ussd-hubtel/relay.ts`; 10 s timeout.
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(refunds): Hubtel refund client, reply classifier and callback token`.

### Task 3: Load Hubtel payment facts onto the order

**Files:**
- Modify: `lib/refunds/types.ts` (`PaymentSource`)
- Modify: `lib/refunds/orders.ts` (`enrichCommission`, bot rows only)
- Test: `lib/refunds/orders.test.ts` (add cases using its existing fake-db pattern)

**Interfaces:**
- Produces: `PaymentSource.gateway: "paystack" | "wallet" | "hubtel" | null` and `PaymentSource.hubtel?: { orderId: string; amountPaid: number; paidAt: string; paidRows: number }`. Set only for bot rows (`isBotRow`) with `bot_surface === "hubtel_ussd"` where `hubtel_transactions` has a row for (`order_table = table`, `order_id`) with `paid_at` not null and `hubtel_order_id` not null. `gateway` becomes `"hubtel"` only when no Paystack reference was found; `paidRows` counts paid rows for the order.

- [ ] **Step 1: Write failing tests**: bot hubtel_ussd row with one paid transaction => `payment.hubtel` populated with `amountPaid` as a number and `gateway:"hubtel"`; two paid rows => `paidRows: 2`; transaction with `paid_at` null => no `hubtel`, gateway stays null; a row that also has a Paystack reference keeps `gateway:"paystack"` and still carries `hubtel`; a non-bot storefront row never gets `hubtel`.
- [ ] **Step 2: Run** `npx vitest run lib/refunds/orders.test.ts` — expect the new cases FAIL.
- [ ] **Step 3: Implement.** Add one batched `inRows(db, "hubtel_transactions", "order_id, hubtel_order_id, amount_paid, paid_at", "order_id", ids, q => q.eq("order_table", table).not("paid_at","is",null))` in `enrichCommission` (the helper already chunks `.in()`), group by order id, populate `payment`. Then `grep -rn "payment.gateway" app components lib` and fix any exhaustive switch or label map so the new `"hubtel"` value renders as "Hubtel" instead of breaking types.
- [ ] **Step 4: Run** `npx vitest run lib/refunds` and `npx tsc --noEmit` — expect PASS / no type errors.
- [ ] **Step 5: Commit** `feat(refunds): load Hubtel payment facts for Hubtel USSD bot orders`.

### Task 4: The `hubtel` gateway, with a fixed-amount hook

**Files:**
- Create: `lib/refunds/gateways/hubtel.ts`
- Modify: `lib/refunds/gateways/index.ts` (insert after `moolreGateway`, before `walletGateway`; manual stays last)
- Modify: `lib/refunds/types.ts` (`RefundGateway.fixedAmount?`)
- Modify: `lib/refunds/service.ts` (`previewRefund`, `executeRefund`)
- Test: `lib/refunds/gateways/hubtel.test.ts`; update the registry assertion in `gateways.test.ts` (id list now includes `"hubtel"`; manual still last)

**Interfaces:**
- Consumes: `requestHubtelRefund` (Task 2), `payment.hubtel` (Task 3).
- Produces: `hubtelGateway: RefundGateway` (`id: "hubtel"`, `label: "Hubtel (refund to payer)"`); optional `RefundGateway.fixedAmount?(order: RefundableOrder): number | null`; `RefundPreview.gateways[i].fixedAmount?: number`.

- [ ] **Step 1: Write failing tests** for `supports()`: env flag unset/"false" => `{ok:false, reason: "Hubtel refunds are not enabled"}`; no `payment.hubtel` => reason "Not paid through Hubtel"; `paidRows > 1` => reason mentions "refund manually"; `paidAt` 45 days ago => not ok, 43 days ago => ok; `amountPaid` 0.50 => not ok; wallet-only table => not ok. `fixedAmount(order)` returns `amountPaid`. `refund(ctx)`: calls `requestHubtelRefund(hubtel.orderId, ctx.refundId)` and returns its outcome; if `ctx.amount !== amountPaid` returns `{kind:"failed", error:"Hubtel refunds the full amount only"}` **without** calling Hubtel. `checkStatus` returns `{kind:"pending", ref: gatewayRef}` (Hubtel has no refund-status endpoint; the callback settles it). Service tests: `executeRefund` with gateway `hubtel` and an amount different from `fixedAmount` throws `BAD_AMOUNT`; `previewRefund` includes `fixedAmount`.
- [ ] **Step 2: Run** `npx vitest run lib/refunds/gateways lib/refunds/service.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `hubtel.ts`, register it, add `fixedAmount?` to the interface, and in `executeRefund` (after the existing `validateRefundAmount` call) reject with `RefundError("BAD_AMOUNT", ...)` when the gateway has `fixedAmount` returning a number that differs from `input.amount` by more than 0.005; in `previewRefund` copy `fixedAmount` per gateway.
- [ ] **Step 4: Run** `npx vitest run lib/refunds` — expect PASS (including the 9 known unrelated order-health failures staying exactly as before; do not "fix" them).
- [ ] **Step 5: Commit** `feat(refunds): Hubtel refund gateway (full amount, dark behind HUBTEL_REFUND_ENABLED)`.

### Task 5: Settle a stored refund from an external outcome

**Files:**
- Modify: `lib/refunds/service.ts`
- Test: `lib/refunds/service.test.ts`

**Interfaces:**
- Produces: `applyGatewayOutcome(deps: RefundDeps, stored: StoredRefund, outcome: GatewayOutcome): Promise<Settled>` — loads the order context (`contextFor`) and runs `settleStored` (so a `completed` outcome calls `complete_order_refund` and sends the customer notification exactly as reconcile does). Throws `RefundError("ORDER_NOT_PENDING")` when `stored.status` is not `reserved` or `processing`.

- [ ] **Step 1: Write failing tests**: completed outcome on a `processing` row => `complete_order_refund` called once, `notify` called once, returns `{status:"completed"}`; row already `completed` => throws `ORDER_NOT_PENDING`, no RPC, no notify; `unknown`/pending outcome => `mark_refund_processing`, no notify.
- [ ] **Step 2: Run** `npx vitest run lib/refunds/service.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `applyGatewayOutcome` by exporting a thin wrapper over the existing private `contextFor` + `settleStored`.
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(refunds): applyGatewayOutcome for callback-driven settlement`.

### Task 6: Callback webhook

**Files:**
- Create: `app/api/webhooks/hubtel-refund/route.ts`
- Create: `lib/refunds/hubtel-callback.ts` (pure handler, so the route stays thin and testable)
- Test: `lib/refunds/hubtel-callback.test.ts`

**Interfaces:**
- Consumes: `verifyCallbackToken` (Task 2), `applyGatewayOutcome` (Task 5), `defaultDeps`, `refundDb` from `lib/refunds/http`.
- Produces: `handleHubtelRefundCallback(deps: RefundDeps, input: { refundId: string | null; token: string | null; body: unknown; loadRefund(id: string): Promise<StoredRefund | null> }): Promise<{ status: number; body: { ok: boolean; note?: string } }>`.

Behaviour: no/invalid token => `401`, nothing read. Row not found or `gateway !== "hubtel"` => `404`. Row not `reserved`/`processing` => `200 {note:"already settled"}` (replay no-op). `responseCode === "0000"` and `data.orderId === stored.gateway_ref` and `|Number(data.amount) - Number(stored.amount)| < 0.005` => `applyGatewayOutcome(... {kind:"completed", ref: \`${data.externalTransactionId} (charges GHS ${data.charges})\`})`. Any other body (other code, mismatched orderId/amount, malformed JSON) => `applyGatewayOutcome(... {kind:"unknown", error: "Hubtel callback <code>: <message> — review"})` which parks the row as `processing` with that note. Always `200` for an authenticated, matched row so Hubtel stops retrying.

- [ ] **Step 1: Write failing tests** for each branch above (bad token 401 and `loadRefund` never called; missing refund 404; wrong gateway 404; completed row replay 200 with no RPC; success => `complete_order_refund` with the `ref` string containing the external id and charges; amount mismatch => parked, `complete_order_refund` not called; orderId mismatch => parked; `responseCode:"4509"` => parked; non-object body => parked).
- [ ] **Step 2: Run** `npx vitest run lib/refunds/hubtel-callback.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `hubtel-callback.ts` and a `POST` route that reads `refund` and `t` from the query, parses the JSON body defensively, loads the refund row from `order_refunds` (select `*`), and calls the handler. `export const dynamic = "force-dynamic"`. Log only ids, never the token or full body.
- [ ] **Step 4: Run** the test file and `npx tsc --noEmit` — expect PASS.
- [ ] **Step 5: Commit** `feat(refunds): authenticated Hubtel refund callback webhook`.

### Task 7: Admin dialog, runbook, verification

**Files:**
- Modify: the refund dialog component under `components/admin/` that renders `preview.gateways` (find with `grep -rn "gateways" components/admin | grep -i refund`): when the selected gateway has `fixedAmount`, prefill and disable the amount input and show "Hubtel refunds the full amount only".
- Create: `docs/superpowers/plans/2026-10-21-hubtel-refund-rollout.md` (short runbook)
- Test: `lib/refunds/ui-outcome.test.ts` only if outcome wording changes; otherwise a component-free check (see Step 3)

- [ ] **Step 1: Implement** the dialog change; the amount field uses `gateways.find(g => g.id === selected)?.fixedAmount`.
- [ ] **Step 2: Write the runbook** (checklist, in this order): redeploy the relay (copy `relay-handler.ts` + `server.ts`, add `HUBTEL_REFUND_BASIC_AUTH` if the status credential is rejected, restart systemd); set `HUBTEL_REFUND_CALLBACK_SECRET` on Vercel (random 32+ bytes, never in a command line or settings file); ask Hubtel whether the callback host must be registered and whether refunds draw from our Hubtel balance; set `HUBTEL_REFUND_ENABLED=true`; supervised refund of one real 1–2 GHS Hubtel USSD order; watch the callback arrive and the History row go `completed`; check the recorded charges; note that a refund stuck in `processing` is resolved from History and by the callback only (there is no Hubtel status endpoint, so no cron).
- [ ] **Step 3: Verify**: `npx vitest run lib/refunds lib/ussd-hubtel`, `npx tsc --noEmit`, then a real build with placeholder env (`next build`, per the saved lesson), then a headless screenshot of the dialog at 500px width with a Hubtel-eligible order (fixture or local mock) showing the disabled amount.
- [ ] **Step 4: Fresh reviewer** (money tier): dispatch a reviewer on the whole diff with the Review Focus list; re-grade findings, fix with failing tests first.
- [ ] **Step 5: Commit** `feat(refunds): Hubtel refund dialog amount lock and rollout runbook`; update memory files (project-hubtel-commission-services or a new project note) with the shipped-dark status and the enable runbook.

---

## Self-review notes

- **Spec coverage:** gateway (T4), relay `/refund` (T1), callback webhook (T6, token + amount + orderId checks), error-code mapping (T2), full-refund/44-day/paid-row rules (T3/T4), charges recorded and shown (T6 writes them into `gateway_ref`, visible in History), dark launch (T4 env flag), supervised first refund (T7).
- **Deviation from the spec:** the spec said the existing reconcile cron would cover stuck pending refunds. Hubtel has no refund-status endpoint, so there is nothing for a cron to check; `checkStatus` returns pending and stuck rows are handled from History. Flagged to the user.
- **Callback host / charges / funding source** are unknowns the user chose to discover during the supervised test (runbook step), not assumptions in code.
