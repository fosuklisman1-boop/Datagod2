# Hubtel Main Code Wallet Payment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registered callers on `*713*235*1#` can pay from their Datagod wallet for Data Bundles, Airtime and Results Checker, behind a switch that ships off.

**Architecture:** Each flow's confirm splits into a shared "prepare" (all checks, returns the order to create) and a "pay" (wallet or Hubtel checkout). One new RPC debits the wallet and records a `hubtel_wallet_payments` row in one transaction. The existing `createOrderHandlers` post-payment code then marks the order paid and delivers, and a sweep recovers a process death.

**Tech Stack:** Next.js 15 route handlers, Supabase Postgres, Vitest (collects tests only under `lib/` and `app/`), PGlite for SQL tests.

**Spec:** `docs/superpowers/specs/2026-11-07-hubtel-main-wallet-design.md`

## Global Constraints

- Main mode only, `Platform` `USSD` only, switch `walletPayment` on, and only Data Bundles, Airtime, Buy Vouchers and Check Results.
- With the switch off, or for an ineligible caller, every screen and every path behaves as it does today. Existing tests pass unchanged.
- The shop code, AFA, Standard Bundles, Special Bundles, Pay Bills, Uzo USSD and WhatsApp do not change.
- Same price on wallet and MoMo. No PIN or SMS code.
- Exact copy: `Pay with:`, `1. Datagod Wallet`, `   (bal GHS 42.00)`, `2. MoMo`, `0. Cancel`, `Order cancelled.`, `Payment successful.`, `This order was already submitted.`
- Every USSD screen is at most 182 characters and printable ASCII plus newline.
- Use Edit/Write for code, never `sed`. Secrets never appear in commands. Logs and alerts carry ids and amounts, no phone numbers.
- Never commit `lib/ussd/bots/__snapshots__/uzo-golden.test.ts.snap`. Stage exact paths.
- Migrations get a pre-check, a self-rolling-back dry run and the owner's OK before they are applied. Run a real placeholder-env `next build` and check local `main` before pushing `main`, and only push with the owner's OK.
- Known failing tests on `main`: 9 in `lib/order-health-service.test.ts`, plus `lib/pricing/migration.test.ts` and `lib/standard-bundles/runtime.test.ts`.

## Review Focus

Each line has its test in the named task.

1. A caller's balance drops between the choice screen and pressing 1: no debit, no paid order, and they can still choose MoMo (Task 3).
2. A caller presses 1 twice, or Hubtel resends the request after a lost reply: one debit only, and the repeat says the order was already submitted (Tasks 1 and 3).
3. A caller on the choice screen presses 2 and pays by MoMo, then redials: the wallet is untouched (Task 4).
4. The price or stock changes while the choice screen is showing: nothing is charged and the caller is told to restart (Task 4).
5. Delivery throws after the debit: the money is visible to an admin through an URGENT alert and the order can be refunded to the wallet (Tasks 3 and 6).

---

### Task 1: Migration: wallet payment table and RPC

**Files:**
- Create: `migrations/0159_hubtel_wallet_payments.sql`, `migrations/0159_hubtel_wallet_payments.selftest.sql`, `lib/ussd-hubtel/wallet-migration.test.ts`

**Interfaces:**
- Produces table `hubtel_wallet_payments`: `id uuid pk`, `session_id text unique not null`, `order_table text not null`, `order_id uuid not null`, `user_id uuid not null`, `amount numeric(12,2) not null check (amount > 0)`, `state text not null default 'debited' check (state in ('debited','fulfilled','needs_review'))`, `review_reason text`, `transaction_reference text`, `created_at`, `updated_at`, unique (`order_table`, `order_id`), partial index on `created_at` where `state='debited'`. RLS on, no policies, `REVOKE ALL` from `PUBLIC, anon, authenticated`.
- Produces RPC, service role only: `pay_hubtel_order_from_wallet(p_session text, p_user uuid, p_table text, p_order uuid, p_amount numeric, p_source text, p_description text) RETURNS jsonb`, returning `{payment_id, replay, new_balance}`. Errors: `INSUFFICIENT_FUNDS`, `BAD_INPUT`, `ALREADY_CARTED`.

- [ ] **Step 1: Write the failing tests**

Follow `lib/standard-bundles/bot-special-migration.test.ts`: static checks always run, and the PGlite behaviour block skips visibly when the package is absent. Assertions:
- A paying call debits the wallet once, writes one `transactions` row (`type='debit'`, the given source, `reference_id` = the order id, correct before and after balances) and one payment row in state `debited`.
- It does not touch the order row: `prosrc` names none of the four order tables in an UPDATE.
- A repeat with the same session returns `replay: true` with the same `payment_id` and no second debit, even with a different amount.
- A different session on the same order raises `BAD_INPUT` and writes nothing.
- A session with a `hubtel_transactions` row raises `ALREADY_CARTED` and writes nothing.
- A balance short by one pesewa raises `INSUFFICIENT_FUNDS` and writes nothing.
- `p_table` outside `ussd_orders, airtime_orders, results_checker_orders, results_check_requests` raises `BAD_INPUT`. So does an amount that is zero, negative or has 3 decimals, and a source outside `ussd_data_purchase, airtime_purchase, ussd_results_checker, results_check_request`.
- `anon` and `authenticated` cannot execute it, or read the table.
- The dry-run string is built by code that refuses a COMMIT or a bare `END;`, and ends in an always-raising block.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run lib/ussd-hubtel/wallet-migration.test.ts`
Expected: FAIL, migration file not found.

- [ ] **Step 3: Write the SQL**

One transaction, `lock_timeout` 5s. The RPC locks the wallet row first, then checks for a replay, then validates, then calls `deduct_wallet`, as `migrations/0141_special_bundles.sql` does. `SECURITY DEFINER`, `search_path = public`. Check `transactions_source_check`, if one exists, in the pre-checks: if it would refuse a source, widen it in this migration. Check that the four order tables' id columns are uuid, and list this in the pre-checks.

- [ ] **Step 4: Run them to verify they pass, then commit**

Do **not** apply the migration here. Task 7 does that.

```bash
git add migrations/0159_hubtel_wallet_payments.sql migrations/0159_hubtel_wallet_payments.selftest.sql lib/ussd-hubtel/wallet-migration.test.ts
git commit -m "feat(ussd-hubtel): wallet payment table and RPC"
```

### Task 2: The Main code switch

**Files:**
- Modify: `lib/ussd-hubtel/config.ts`, `lib/ussd-hubtel/line.ts`, `app/api/admin/ussd-hubtel/config/route.ts`, `components/admin/hubtel-line-settings.tsx`
- Test: `lib/ussd-hubtel/config.main-line.test.ts`, `app/api/admin/ussd-hubtel/route.line.test.ts` (or the existing line test beside the route), `app/admin/ussd-hubtel/line-settings.test.ts`

**Interfaces:**
- Produces `HubtelUssdConfig.walletPayment?: boolean`, and on `HubtelLinePatch`. `getHubtelMainLineConfig` returns `walletPayment` true only on a stored explicit `true`. `getHubtelUssdConfig` never returns it true.

- [ ] **Step 1: Write the failing tests**

- A stored main row without the field reads `false`. Stored `"yes"` reads `false`.
- `POST {line:"main", walletPayment:true}` saves it to the main row and leaves `hubtel_ussd_config` untouched. `walletPayment` without `line:"main"` is a 400, as `mode` with `line:"main"` is. A non-boolean is a 400.
- The Main tab renders a switch labelled `Wallet payment`, and the Shop tab doesn't. Saving it goes through `hubtelSaveBody`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run lib/ussd-hubtel/config.main-line.test.ts app/admin/ussd-hubtel/line-settings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement, following how `enabled` is handled on the main row**

- [ ] **Step 4: Run them to verify they pass, then commit**

```bash
git add lib/ussd-hubtel/config.ts lib/ussd-hubtel/line.ts lib/ussd-hubtel/config.main-line.test.ts app/api/admin/ussd-hubtel/config/route.ts components/admin/hubtel-line-settings.tsx app/admin/ussd-hubtel/line-settings.test.ts
git commit -m "feat(admin): wallet payment switch on the Hubtel main code"
```

### Task 3: Wallet payment engine and sweep

**Files:**
- Create: `lib/ussd-hubtel/wallet-pay.ts`, `lib/ussd-hubtel/wallet-pay.test.ts`
- Modify: `app/api/cron/hubtel-status-check/route.ts`, and its test

**Interfaces:**
- Consumes: the RPC from Task 1; `createOrderHandlers` from `order-handlers.ts`.
- Produces:
  - `type WalletTable = "ussd_orders" | "airtime_orders" | "results_checker_orders" | "results_check_requests"`
  - `WALLET_SOURCE: Record<WalletTable, string>`: `ussd_orders` is `ussd_data_purchase`, `airtime_orders` is `airtime_purchase`, `results_checker_orders` is `ussd_results_checker`, `results_check_requests` is `results_check_request`
  - `payFromWallet(deps: WalletPayDeps, input: { sessionId; userId; table: WalletTable; orderId; amount; description }): Promise<{ kind: "paid" | "replay" | "insufficient" | "unavailable"; paymentId?: string }>`. The RPC throwing is resolved by reading the payment row by session: found is `paid`, not found is `unavailable`. A read error returns `unavailable` and sends an URGENT alert.
  - `runWalletPostPayment(deps, paymentId, table, orderId): Promise<void>`: runs the handler, then sets `fulfilled`, or `needs_review` with an URGENT alert naming the order. Never throws.
  - `sweepWalletPayments(db, handlers, alert, now?): Promise<{ found; fulfilled; review }>`: rows `debited` older than 10 minutes go through the same post-payment step.
  - `findWalletPaymentBySession(db, sessionId)`

- [ ] **Step 1: Write the failing tests**

- `paid` calls the RPC with the source from `WALLET_SOURCE`.
- `INSUFFICIENT_FUNDS` gives `insufficient`, with no alert (Review Focus 1).
- `replay: true` gives `replay`, and post-payment isn't run again (Review Focus 2).
- The RPC throwing with a payment row found gives `paid`; with none found gives `unavailable`; a read error gives `unavailable` and an URGENT alert.
- The handler throwing gives `needs_review`, the reason stored, and an URGENT alert with the order id and no phone number (Review Focus 5). The function doesn't throw.
- An alert failing is logged and doesn't throw.
- The sweep picks only `debited` rows older than 10 minutes. Re-running against an order already completed by the handler ends in `fulfilled`. A second failure ends in `needs_review`, and that row isn't listed again.
- The status-check route runs the sweep, and a sweep failure doesn't stop its other work.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run lib/ussd-hubtel/wallet-pay.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the signatures above**

Alerts use the same admin alert function `lib/ussd-hubtel/order-handlers.ts` uses for its URGENT alerts.

- [ ] **Step 4: Run them to verify they pass, then commit**

Run: `npx vitest run lib/ussd-hubtel/wallet-pay.test.ts app/api/cron/hubtel-status-check`
Expected: PASS.

```bash
git add lib/ussd-hubtel/wallet-pay.ts lib/ussd-hubtel/wallet-pay.test.ts app/api/cron/hubtel-status-check/route.ts app/api/cron/hubtel-status-check/route.test.ts
git commit -m "feat(ussd-hubtel): pay an order from the wallet, with a recovery sweep"
```

### Task 4: The choice screen, with Data Bundles first

**Files:**
- Create: `lib/ussd-hubtel/flows/pay-choice.ts`, `lib/ussd-hubtel/flows/pay-choice.test.ts`
- Modify: `lib/ussd-hubtel/flow-kit.ts`, `lib/ussd-hubtel/flows/data.ts`, `lib/ussd-hubtel/types.ts`, `lib/ussd-hubtel/router.ts`

**Interfaces:**
- Consumes: `payFromWallet`, `runWalletPostPayment`, `findWalletPaymentBySession` from Task 3; `config.walletPayment` from Task 2.
- Produces:
  - `type PayKind = "data" | "airtime" | "rc" | "rc_check"`, and session field `payKind?: PayKind`
  - `HubtelStep` gains `"PAY_CHOICE"`, in `STEPS` only, never `SHOP_STEPS`
  - `type PreparedOrder = SubmitNewOrder`, and `type Prepare = (ctx: FlowCtx) => Promise<PreparedOrder | HubtelReply>`
  - `checkoutOrChoose(ctx, kind: PayKind, prepare: Prepare): Promise<HubtelReply>`, called from a flow's confirm after its replay check
  - `payChoiceStep(prepares: Partial<Record<PayKind, Prepare>>): StepHandler`
  - `walletOfferFor(ctx, price): Promise<{ userId: string; balance: number } | null>`

- [ ] **Step 1: Write the failing tests**

Drive the real router with fakes. Data Bundles only:
- Switch off, shop mode, `Platform` `Webstore`, an unregistered caller, or a balance one pesewa short: Confirm `1` gives AddToCart exactly as today, and no wallet read happens with the switch off.
- Eligible caller: Confirm `1` replies exactly `Pay with:\n1. Datagod Wallet\n   (bal GHS 42.00)\n2. MoMo\n0. Cancel`, step `PAY_CHOICE`, and no order row exists.
- `2` gives the same AddToCart as today and no wallet call (Review Focus 3).
- `0` finishes with `Order cancelled.`, with nothing created. Any other input repaints.
- `1` creates the order, then calls the RPC at the screen's price, then finishes with `Payment successful.` plus the wording Uzo uses, with post-payment run through `deps.defer`.
- `insufficient` fails the just-created order through `failOrderGuarded`, and replies `Insufficient balance.` with `2. MoMo` and `0. Cancel` (Review Focus 1).
- `unavailable` with no debit fails the order guarded, and ends with the unavailable text.
- A repeat of `1`, or a lost reply with the session gone, replies `This order was already submitted.` with no second debit (Review Focus 2). `replaySubmittedOrder` stays first, and a wallet-payment lookup by session sits next to it.
- Price changed, or the MTN recipient block, while on the screen: on `1` and on `2` alike, the existing message and no charge (Review Focus 4). `prepare` runs again on each.
- All new screens are at most 182 characters, including a 7-digit balance.
- A session with `mode` missing after Back counts as main mode.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run lib/ussd-hubtel/flows/pay-choice.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

- Move `data.ts` confirm's checks into `prepareData(ctx)`, returning the `submitOrder` args. `confirm` keeps its digit handling and replay check, then calls `checkoutOrChoose(ctx, "data", prepareData)`.
- Split order creation out of `submitOrder` only as far as the wallet path needs a created order id with no `hubtel_transactions` row. Export `createOrderRow(ctx, args)`. `submitOrder`'s behaviour is unchanged, and its tests stay as they are.
- `DATA_PREPARES` is passed from `router.ts` to `payChoiceStep`, which avoids an import cycle.
- A `PreparedOrder.table` outside `WalletTable` never offers the wallet.
- The wallet path calls `deps.defer` when it is present, otherwise it awaits post-payment.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run lib/ussd-hubtel`
Expected: PASS, with the existing data flow tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add lib/ussd-hubtel/flows/pay-choice.ts lib/ussd-hubtel/flows/pay-choice.test.ts lib/ussd-hubtel/flow-kit.ts lib/ussd-hubtel/flows/data.ts lib/ussd-hubtel/types.ts lib/ussd-hubtel/router.ts
git commit -m "feat(ussd-hubtel): wallet or MoMo choice for data on the main code"
```

### Task 5: Airtime and Results Checker

**Files:**
- Modify: `lib/ussd-hubtel/flows/airtime.ts:139-211`, `lib/ussd-hubtel/flows/rc-buy.ts:127-165`, `lib/ussd-hubtel/flows/rc-check.ts:200-242`, `lib/ussd-hubtel/router.ts`
- Test: `lib/ussd-hubtel/flows/pay-choice.services.test.ts`

**Interfaces:**
- Consumes: `checkoutOrChoose`, `payChoiceStep`, `Prepare` from Task 4.
- Produces: `prepareAirtime`, `prepareRc`, `prepareRcCheck`, registered for kinds `airtime`, `rc` and `rc_check`.

- [ ] **Step 1: Write the failing tests**

For each of the three:
- The choice screen shows at the price the service's confirm showed. For cashback airtime that is `cb.payAmount`, and for fee-priced airtime it is `amount`.
- `1` debits that price with the right source, and `2` gives today's AddToCart. Each existing stale-session message still applies on `1` and `2`: airtime rates changed, vouchers out of stock, price changed.
- Results Checker's cancel at its own confirm stays `2`, and its wallet screen's cancel is `0`.
- Stock is re-checked when `1` is pressed, so a voucher sold out in between gives the existing message and no debit.
- A wallet-paid Check Results combo with no voucher left ends in `needs_review` with an URGENT alert (the handler throws).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run lib/ussd-hubtel/flows/pay-choice.services.test.ts`
Expected: FAIL.

- [ ] **Step 3: Move each confirm's checks into its prepare, following Task 4's shape**

- [ ] **Step 4: Run them to verify they pass, then commit**

Run: `npx vitest run lib/ussd-hubtel`
Expected: PASS, with the existing airtime, RC and RC-check tests unchanged.

```bash
git add lib/ussd-hubtel/flows/airtime.ts lib/ussd-hubtel/flows/rc-buy.ts lib/ussd-hubtel/flows/rc-check.ts lib/ussd-hubtel/flows/pay-choice.services.test.ts lib/ussd-hubtel/router.ts
git commit -m "feat(ussd-hubtel): wallet or MoMo choice for airtime and results checker"
```

### Task 6: Refunds and stale-order crons

**Files:**
- Modify: `lib/refunds/orders.ts`, `app/api/cron/expire-stale-airtime/route.ts`, and any refund file the tests show must change
- Test: `lib/refunds/hubtel-wallet.test.ts`, `app/api/cron/expire-stale-airtime/route.wallet.test.ts`

**Interfaces:**
- Consumes: `hubtel_wallet_payments` from Task 1.

- [ ] **Step 1: Write the failing tests**

For a wallet-paid order on each of the four tables that failed delivery:
- `/admin/refunds` lists it, with the wallet as the only rail. Hubtel, Moolre and manual payout rails are refused.
- A refund credits the same user's wallet once, and a second refund is refused.
- A MoMo-paid order on the same tables gets the same rails as today.
- `expire-stale-airtime` leaves an `airtime_orders` or `results_checker_orders` row with a `debited` wallet payment alone, however old it is, and still expires one without.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run lib/refunds/hubtel-wallet.test.ts app/api/cron/expire-stale-airtime`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add the Task 3 sources to `WALLET_DEBIT_SOURCES` only if that list is what proves a wallet payment for these tables; otherwise read `hubtel_wallet_payments` directly. Read `lib/refunds/orders.ts` and each table's refund RPC first. Search all crons that update these four tables to a failed or expired state, not only the one named here, and add the same guard or record in your report why it can't reach these rows. **If refunds need more than a small change, stop and report it**, as the spec requires.

- [ ] **Step 4: Run them to verify they pass, then commit**

Run: `npx vitest run lib/refunds app/api/cron`
Expected: PASS.

```bash
git add lib/refunds/orders.ts lib/refunds/hubtel-wallet.test.ts app/api/cron/expire-stale-airtime/route.ts app/api/cron/expire-stale-airtime/route.wallet.test.ts
git commit -m "feat(refunds): Hubtel wallet orders refund to the wallet only"
```

### Task 7: Review, apply, ship dark, supervised test

**Files:**
- Modify: `docs/hubtel-ussd-runbook.md` (a "Wallet payment on the main code" section)

- [ ] **Step 1: Fresh reviewer on the whole branch**

Mandatory, since this covers money and schema. Verify each finding, re-grade it, and fix with a failing test first.

- [ ] **Step 2: Report on `users.phone_number`**

Read how it's set and verified, and how many accounts share a number (count only, no numbers). Tell the owner what you find, as the spec asks.

- [ ] **Step 3: Write the runbook section**

Cover the switch, alerts and what to do, refunds, and the supervised test.

- [ ] **Step 4: Run the full checks**

Run: `npx vitest run`, `npx tsc --noEmit`, a placeholder-env `next build`.
Expected: only the known failures, the same 21 `tsc` errors in the two known test files, and the build passes.

- [ ] **Step 5: Run the migration protocol**

Pre-check, dry run, **get the owner's OK**, apply, then verify the table, RLS, grants and RPC.

- [ ] **Step 6: Check local `main`, get the owner's OK, push, watch the deploy**

Expected: READY with the alias assigned. `walletPayment` is off, and paid traffic continues.

- [ ] **Step 7: Supervised test with the owner**

From the owner's phone with a small balance, with the switch on: one each of data, airtime, vouchers and Check Results; a balance too short; a Cancel; a MoMo choice from the new screen. Confirm Hubtel accepts a session ending with no checkout. Expected for each paid one: one debit, one `transactions` row, the payment row `fulfilled`, the order delivered, and no `hubtel_transactions` row.

- [ ] **Step 8: Update the memory files and tell the owner the result**
