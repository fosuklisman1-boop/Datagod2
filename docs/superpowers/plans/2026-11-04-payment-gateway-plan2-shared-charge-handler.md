# Payment Gateway — Plan 2: Shared charge handler

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Paystack webhook's `charge.success` and `charge.failed` branches, unchanged, into gateway-neutral functions in `lib/`, so Plan 3's Hubtel confirmation can run the exact same fulfilment code. Zero behaviour change for Paystack.

**Architecture:** `app/api/webhooks/paystack/route.ts` keeps signature checking and JSON parsing, then calls `handleChargeSuccess` / `handleChargeFailed`. Lock in current behaviour with tests through the route first, then move the code as text with no logic edits, then prove the move with a normalised comparison.

**Tech Stack:** Next.js 15 route handler, Supabase service-role client, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-hubtel-payment-gateway-design.md` ("Same fulfilment path").

**Plan 2 of 5.** Base branch: `feat/payment-gateway` (Plan 1) with `fix/dealer-upgrade-amount` merged in, because that fix edits the same code.

**Deliberate narrowing of the spec's "builder-check call":** the spec asked for a `confirmPayment(attempt, verifiedAmount)` shared by the webhook and `/api/payments/verify`. Fulfilment logic is also copied in `/api/admin/payment-attempts` PATCH, `cron/verify-pending-payments`, both reverify routes and `lib/payment-cleanup-service.ts`. Unifying all of them is a large rewrite Hubtel doesn't need: the webhook branch alone covers every surface and is already safe to re-run. Those other copies stay as they are. Plan 4 must stop their Paystack lookups from touching Hubtel-paid rows.

## Global Constraints

- No logic edits to moved code: no reordering, renaming, "tidying" or new checks. Only indentation, the top-of-function variable bindings below, and the `return` at the end of each function may differ.
- Paystack signature check stays in the route. `PAYSTACK_SECRET_KEY` is not read by the new module.
- HTTP behaviour is unchanged: every status code and JSON body the route returns today stays the same, including `400 {"error":"Underpayment"}` and the outer `catch`.
- Column names stay (`paystack_transaction_id`, `paystack_reference`). Renaming is out of scope.
- Edit/Write tools only (no sed or scripted edits). Run `next build` from PowerShell; it fails in the sandboxed Bash tool.

## Review Focus

1. **Paystack retrying a success event** — a second identical event must not credit or fulfil twice. Task 1.
2. **Metadata sent as a JSON string** — the existing string-parsing branch must survive the move. Task 1.
3. **An exception inside a moved branch** — the route's outer `catch` must still produce today's response, not an unhandled rejection. Task 1.
4. **A reference with no matching record** — keeps today's response. Task 1.
5. **Tests that read the route's source text** (`lib/admin-actions/wiring.test.ts`, `lib/sms/kill-switch.guard.test.ts`, others found by grep) — must follow the code to the new file rather than silently passing on an empty search. Task 2.

---

### Task 1: Lock in current behaviour through the route

**Files:**
- Create: `app/api/webhooks/paystack/charge-events.characterization.test.ts`

**Interfaces:**
- Consumes: the route's `POST`; the fake and signing helper pattern in `app/api/webhooks/paystack/dealer-upgrade.test.ts`.
- Produces: tests that import only `./route`, so they run unchanged before and after Task 2.

- [ ] **Step 1: Write the tests** (they must pass on today's code; this is characterization, not TDD), named and asserting:
  - `wallet top-up credits net of the fee` → `credit_wallet_safely` called once with `p_amount` = 100.00 for paid 10300 pesewas, fee 3; `wallet_payments.status` = `completed`.
  - `a shop order is marked paid` → `shop_orders.payment_status` = `completed`.
  - `an underpaid shop order is refused` → status 400, `{ error: "Underpayment" }`, `wallet_payments.status` unchanged.
  - `metadata sent as a JSON string still routes an sms_bundle payment` → the SMS branch runs.
  - `a USSD order found by reference is processed without a wallet_payments row`.
  - `an unknown reference` → pin the exact status and body returned today.
  - `a repeated success event credits once` → second call doesn't add a credit (fake `credit_wallet_safely` returns `already_processed: true`).
  - `charge.failed marks a pending USSD order failed`.
  - `a throwing database call` → pin the exact response from the outer `catch`.
  - `a bad signature` → 401, no database calls.
- [ ] **Step 2:** Run `npx vitest run app/api/webhooks/paystack` → all pass. Where a test fails, the test is wrong: fix the test to match today's behaviour and note anything surprising in the report rather than changing the route.
- [ ] **Step 3:** Commit `test(webhook): pin charge.success and charge.failed behaviour`.

### Task 2: Move the branches into `lib/payments/charge-events.ts`

**Files:**
- Create: `lib/payments/charge-events.ts`
- Modify: `app/api/webhooks/paystack/route.ts`, plus any test that reads the route's source text (find with `grep -rln "webhooks/paystack/route" lib app`)

**Interfaces:**
- Produces:
  - `interface ChargeEventData { reference: string; amount: number; status?: string; metadata?: unknown; id?: string | number; gateway_response?: string; [key: string]: unknown }` — `amount` is pesewas, the shape of Paystack's `event.data`.
  - `async function handleChargeSuccess(data: ChargeEventData): Promise<NextResponse | null>` — body of `if (event.event === "charge.success")`. Early `return NextResponse…` statements stay. Returns `null` at the point today's code falls through to the route's final response.
  - `async function handleChargeFailed(data: ChargeEventData): Promise<NextResponse | null>` — same for `charge.failed`.
- Moved code reads `data` where it read `event.data`; that substitution is the only permitted expression change. Module-level `supabase` is created the same way the route does. Add the top of file comment: "Moved unchanged from the Paystack webhook. Shared by every gateway that has confirmed a charge. Callers must verify the payment first; this code trusts `amount`."
- Route after the move: signature check, parse, `const res = event.event === "charge.success" ? await handleChargeSuccess(event.data) : event.event === "charge.failed" ? await handleChargeFailed(event.data) : null`, `if (res) return res`, then the existing remaining branches and final response. Non-charge events (transfers and so on) stay in the route.

- [ ] **Step 1:** Do the move.
- [ ] **Step 2: Prove it's a move.** Write a throwaway script in the scratchpad (not committed): extract the two branch bodies from `git show HEAD:app/api/webhooks/paystack/route.ts` and from the new file, strip leading whitespace, replace `event.data` with `data`, and diff. Expected: only the function wrappers and final returns differ. Paste the diff in the report.
- [ ] **Step 3:** `npx vitest run app/api/webhooks/paystack lib/admin-actions lib/sms/kill-switch lib/storefront-commission/confirm-bots` → all pass, with the Task 1 file untouched. For each source-reading test, repoint it and confirm it would still fail if the guarded text were removed.
- [ ] **Step 4:** `npx tsc --noEmit` → no errors in touched files.
- [ ] **Step 5:** Commit `refactor(webhook): move charge handlers into lib, no behaviour change`.

### Task 3: Verification gate

- [ ] **Step 1:** Full suite → only the pre-existing failures (9 order-health, `lib/pricing/migration`, `lib/standard-bundles/runtime`).
- [ ] **Step 2:** Placeholder-env `npm run build` from PowerShell → exit 0.
- [ ] **Step 3:** Fresh reviewer on the most capable model (money path): check the Step 2 diff, every early return, and that no module-level state or import changed meaning across the move. Fix findings with a failing test first.
- [ ] **Step 4:** After deploy, watch the webhook's runtime logs and one real wallet top-up through to `completed`.
