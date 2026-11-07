# Hubtel Internet Bundles and USSD Special Bundles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One "Internet Bundles" entry on both Hubtel codes, then Special Bundles sold through it on MTN with one Hubtel payment delivering every unit.

**Architecture:** Part A replaces two top-level menu items with one, deriving the sub-screen from existing visibility flags, with no new session state. Part B adds an unpaid group of `channel='bots'` child rows; the payment row points at child 1, and group-aware code flips and credits every child, then dispatches them in the background.

**Tech Stack:** Next.js 15 route handlers, Supabase Postgres, Vitest (collects tests only under `lib/` and `app/`), PGlite for SQL tests.

**Spec:** `docs/superpowers/specs/2026-11-07-hubtel-internet-bundles-design.md`

## Global Constraints

- Part A ships and passes a live dial on both codes before Part B starts. Part B ships dark behind `special.ussdEnabled`, default off.
- Uzo USSD, WhatsApp bots, the storefront, the API and dashboard Special Bundles do not change behaviour. `create_special_bundle_orders` is not edited.
- Exact copy: `Internet Bundles`, `Data Bundles`, `Standard Bundles`, `Special Bundles`.
- USSD sizes are `standard_bundles_config.special.multiples`. There is no USSD size list.
- Every USSD screen is at most 182 characters and printable ASCII plus newline.
- Single-order payment and fail behaviour stays as it is: existing tests pass unchanged except where they assert the old menu.
- Use Edit/Write for code, never `sed`. Secrets never appear in commands. Logs carry ids and lengths, no phone numbers.
- Migrations get a pre-check, a self-rolling-back dry run and the owner's OK before they are applied. Run a real placeholder-env `next build` and check local `main` before pushing `main`.
- Known failing tests on `main`: 9 in `lib/order-health-service.test.ts`, plus `lib/pricing/migration.test.ts` and `lib/standard-bundles/runtime.test.ts`.

## Review Focus

Each line has its test in the named task.

1. A caller presses 0 on Data Bundles when only that type is visible: they return to the main or shop menu, never to a one-item screen (Task 1).
2. A shop caller who is whitelist-blocked for data sees Standard Bundles only, and Back returns to the shop menu with the shop context intact (Task 1).
3. Hubtel retries the same payment notification after all children flipped: nothing is sent twice and no second share is credited (Task 7).
4. A Special order expires unpaid, or an admin marks it "not paid": every child fails, not only child 1 (Task 6).
5. The admin saves the existing Special card: `ussdEnabled` keeps its value, because `special` is replaced whole (Task 3).

---

# Part A: the menu

### Task 1: Internet Bundles menu on both codes

**Files:**
- Create: `lib/ussd-hubtel/flows/internet-bundles.ts`, `lib/ussd-hubtel/flows/internet-bundles.test.ts`
- Modify: `lib/ussd-hubtel/menus.ts`, `lib/ussd-hubtel/types.ts`, `lib/ussd-hubtel/router.ts`, `lib/ussd-hubtel/flows/data.ts:28`, `lib/ussd-hubtel/flows/shop-data.ts:46`, `lib/ussd-hubtel/flows/network-plans.ts:113`
- Test (update old-menu assertions): `lib/ussd-hubtel/menus.test.ts`, `router.test.ts`, `router.lines.test.ts`, `router.bot-menus.test.ts`

**Interfaces:**
- Produces in `menus.ts`:
  - `type ServiceKey = "data" | "afa" | "airtime" | "resultsChecker" | "networkPlans" | "payBills"`. `IMPLEMENTED_SERVICES` is keyed by it, so the admin page is unchanged.
  - `type InternetType = "data" | "networkPlans"`
  - `type MainMenuKey = "internet" | "afa" | "airtime" | "resultsChecker" | "payBills"`
  - `type ShopMenuKey = "internet" | "airtime" | "resultsChecker" | "payBills"`
  - `resolveInternetTypes(visibility: MenuVisibility, dataBlocked: boolean, bots?: BotMenuGate): InternetType[]`, always in the order data, networkPlans
  - `internetMenuText(types: InternetType[]): string`
- Produces in `internet-bundles.ts`:
  - `internetTypesFor(ctx: FlowCtx): InternetType[]`
  - `startInternetBundles(entries: Partial<Record<InternetType, StepHandler>>): StepHandler`
  - `internetMenuStep(entries): StepHandler`
  - `backFromInternetType(ctx: FlowCtx, prefix?: string): Promise<HubtelReply>`
- `HubtelStep` gains `"INTERNET_MENU"`, registered in both `STEPS` and `SHOP_STEPS`.

- [ ] **Step 1: Write the failing tests in `internet-bundles.test.ts` and `menus.test.ts`**

Use the fakes the router tests use. Assertions, for main and shop mode unless stated:
- `main menu with all visible` equals `Welcome to Clingshub\n1. Internet Bundles\n2. AFA Registration\n3. Buy Airtime\n4. Results Checker\n5. Pay Bills\n0. Exit`.
- `shop menu with all visible` contains `1. Internet Bundles\n2. Buy Airtime\n3. Results Checker\n4. Pay Bills\n0. Exit`.
- `both types visible`: digit 1 replies exactly `Internet Bundles\n1. Data Bundles\n2. Standard Bundles\n0. Back`, session step `INTERNET_MENU`.
- `only data visible`: digit 1 opens the data network screen. Only networkPlans visible: digit 1 opens `Standard Bundles\nSelect network:`.
- `neither visible`: no `Internet Bundles` line, and the other items renumber from 1.
- `back from data, both visible`: 0 on the first data screen shows the Internet Bundles screen. The same for Standard Bundles.
- `back, one type visible`: 0 returns to the main or shop menu (Review Focus 1).
- `shop, data blocked`: only Standard Bundles is offered; Back returns to `SHOP_PRODUCT` with `shopId`, `shopName` and `shopNetworks` kept (Review Focus 2).
- `0 on INTERNET_MENU` returns to the main or shop menu. An invalid digit repaints the Internet Bundles screen.
- `a type hidden while the caller is on INTERNET_MENU`: its digit repaints the current screen and opens nothing.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run lib/ussd-hubtel/flows/internet-bundles.test.ts lib/ussd-hubtel/menus.test.ts`
Expected: FAIL, module not found and old menu text.

- [ ] **Step 3: Implement**

- In `menus.ts`, `MAIN_ITEMS` and `SHOP_ITEMS` carry `{ key: "internet", label: "Internet Bundles" }` first and no `data` or `networkPlans` items. `internet` is visible when `resolveInternetTypes(...)` is not empty. `data` keeps its existing `visibility.data && implemented && !dataBlocked` rule, and `networkPlans` keeps `botVisible`.
- `internet-bundles.ts` imports `backToMain` and `backToProduct` but no flow's start function, which avoids an import cycle. The router passes `{ data: startData, networkPlans: startNetworkPlans }` for main and `{ data: startShopData, networkPlans: startNetworkPlans }` for shop.
- `backFromInternetType`: two types visible means a cleaned session on `INTERNET_MENU` (the same fields `backToMain` / `backToProduct` keep), otherwise it calls `backToMain` or `backToProduct` by `session.mode`, passing `prefix` to `backToProduct`.
- Replace the three back calls listed under Files. `leave` in `network-plans.ts` calls `backFromInternetType(ctx, prefix)`.
- In `router.ts`, `MAIN_MENU_ENTRIES` and `SHOP_PRODUCT_ENTRIES` map `internet` to `startInternetBundles(...)`.
- Update the test that pins "every IMPLEMENTED_SERVICES key has an entry" so a key is satisfied by the top-level or the internet entries.

- [ ] **Step 4: Update old-menu assertions and run the Hubtel suite**

Run: `npx vitest run lib/ussd-hubtel lib/ussd/handlers/main.test.ts app/admin/ussd-hubtel`
Expected: PASS. Uzo's `lib/ussd/*` files are untouched. Only label and digit assertions change in existing tests; if a behaviour assertion would have to change, stop and report it.

- [ ] **Step 5: Update the runbook and commit**

In `docs/hubtel-ussd-runbook.md`, note Pay Bills moved to 5 on main and 4 on shop and describe the Internet Bundles screen. In `components/admin/hubtel-line-settings.tsx`, label the two toggles `Internet Bundles: Data Bundles` and `Internet Bundles: Standard Bundles`, keeping their keys.

```bash
git add lib/ussd-hubtel components/admin/hubtel-line-settings.tsx docs/hubtel-ussd-runbook.md
git commit -m "feat(ussd-hubtel): one Internet Bundles entry on both codes"
```

### Task 2: Ship Part A

**Files:** none changed.

- [ ] **Step 1: Run the full checks**

Run: `npx vitest run`, `npx tsc --noEmit`, then a placeholder-env `next build`.
Expected: only the known failures in Global Constraints, no new `tsc` errors, build passes.

- [ ] **Step 2: Check local `main`, merge, push, watch the deploy**

Expected: Vercel READY with the alias assigned to the new commit.

- [ ] **Step 3: Live check with the owner**

Owner dials `*714*2547#` and `*713*235#`, and opens Internet Bundles, each type, and Back.
Expected: `hubtel_ussd_interactions` shows `INTERNET_MENU` rows, new paid `hubtel_transactions` rows keep arriving, and no `Service unavailable` replies. **Part B does not start until this passes.**

---

# Part B: Special Bundles on USSD

### Task 3: Migration and the USSD switch

**Files:**
- Create: `migrations/0158_bot_special_bundles.sql`, `migrations/0158_bot_special_bundles.selftest.sql`, `lib/standard-bundles/bot-special-migration.test.ts`
- Modify: `lib/standard-bundles/config.ts`, `lib/standard-bundles/config.test.ts`, the Special card on the Standard Bundles tab of `/admin/hubtel-commission`, and `app/api/admin/standard-bundles/config/route.ts` if it restricts fields

**Interfaces:**
- Produces RPC, service role only: `create_bot_special_bundle_orders(p_surface text, p_buyer text, p_shop uuid, p_group_key text, p_n integer, p_rows jsonb, p_total numeric) RETURNS jsonb`, returning `{group_id, order_ids, replay}`.
- Produces `SpecialSetting.ussdEnabled: boolean`. Missing means `false`.

- [ ] **Step 1: Write the failing SQL and config tests**

In PGlite, following `special-migration.test.ts`:
- Two identical calls create N rows once: the second returns `replay: true` with the same ids.
- Rows are `channel='bots'`, `user_id` NULL, `status='pending'`, `payment_status='unpaid'`, `special_index` 1..N, `idempotency_key = key || ':' || i`, with surface, buyer and shop set. `wallets` and `transactions` are unchanged.
- `p_total` other than N x `paid_amount`, differing rows, a non-MTN unit, `paid_amount <> amount - cashback`, a surface other than `hubtel_ussd`, or a `shop_share_amount` with `p_shop` NULL each raise `BAD_INPUT` and write nothing.
- A dashboard Special row still inserts, and a `channel='storefront'` Special row is refused by the CHECK.
- `anon` and `authenticated` cannot execute the function.

In `config.test.ts`:
- A stored `special` without `ussdEnabled` reads `false`.
- `ussdEnabled: "yes"` is rejected. A patch with `ussdEnabled: true` is kept.
- A rendered save of the Special card's existing fields keeps `ussdEnabled` (Review Focus 5).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run lib/standard-bundles/bot-special-migration.test.ts lib/standard-bundles/config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

The SQL widens the CHECK to `channel IN ('dashboard','bots') AND network='MTN'`, and adds the RPC modelled on 0141's validation without the wallet lock and debit. Replay is looked up on (`bot_surface`, `buyer_phone`, `key:1`, `channel='bots'`), and `uq_hubtel_data_orders_bots_idem` backs it up. `payment_fee_amount` is 0 on every row. Add a `REVOKE` and `GRANT` as in 0141, a dry run, and pre-checks modelled on 0141's. Add the switch to `cleanSpecial`, the validator's allowed keys and the admin card, with the label `Sell on Hubtel USSD`.

- [ ] **Step 4: Run them to verify they pass, then commit**

Do **not** apply the migration here. Applying it is Task 8.

```bash
git add migrations/0158_* lib/standard-bundles app/api/admin/standard-bundles app/admin components/admin
git commit -m "feat(bundles): unpaid Special groups for Hubtel USSD, behind a switch"
```

### Task 4: Special engine for bots

**Files:**
- Create: `lib/bot-commission/special-orders.ts`, `lib/bot-commission/special-orders.test.ts`
- Modify: `lib/standard-bundles/special-service.ts` (export `ignoreHidden`), `lib/bot-commission/runtime.ts` (wire the RPC), `lib/ussd-hubtel/services.ts` (`NetworkPlansServices`), `lib/ussd-hubtel/testing/fakes.ts`

**Interfaces:**
- Consumes: the RPC from Task 3; `findSpecialUnit`, `buildSpecialEntries`, `verifySpecialToken`, `prepareBundlePurchase`, `quoteBots`, `checkBotPendingCaps`.
- Produces:
  - `botSpecialPlans(d, ctx): Promise<{ ok: true; plans: BotSpecialPlan[] } | Fail>`, where `BotSpecialPlan = { token: string; display: string; n: number; faceAmount: number; payAmount: number }`
  - `botCreateSpecialOrder(d, ctx, input: { token; recipient; idempotencyKey; expectedPay }): Promise<{ ok: true; order: { id: string; groupId: string; n: number; payAmount: number } } | (Fail & { quote?: PriceQuote })>`. `order.id` is child 1.
  - `findSpecialFirstChild(d, ctx, key): Promise<string | null>`
  - On `NetworkPlansServices`: `specialPlans(ctx)`, `createSpecialOrder(ctx, input)`, `findSpecialOrderId(ctx, key)`

- [ ] **Step 1: Write the failing tests**

- `botSpecialPlans` returns `{ok:true, plans:[]}` unless `special.enabled`, `special.ussdEnabled`, the bots bundles gate and the unit in the live catalog are all true.
- Price: for unit face 3.00, `payAmount` = N x the `quoteBots` per-unit price (floored per unit), never `quoteBots` of the total.
- Shop context: `shop_share_amount` is the per-unit share. Main context: 0.
- Create: the surface must be `hubtel_ussd`, otherwise 403 and no write. `expectedPay` differing gives 409 with the live quote and no write. A size no longer in `multiples` gives `PRICES_REFRESHED`.
- Caps: `checkBotPendingCaps` runs once per create. A buyer with 4 pending single orders can still create a size 15 group, and a group counts once against later creates.
- A repeat with the same key returns the same `order.id`, with no second write and no second cap check.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/bot-commission/special-orders.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the signatures above in `special-orders.ts`**

For "a group counts once", the runtime's `countPending` for `hubtel_data_orders` must exclude rows with `special_index > 1`. Put this in the runtime query and test the query filter.

- [ ] **Step 4: Run to verify they pass, then commit**

```bash
git add lib/bot-commission lib/standard-bundles/special-service.ts lib/ussd-hubtel/services.ts lib/ussd-hubtel/testing/fakes.ts
git commit -m "feat(bots): price and create unpaid Special groups"
```

### Task 5: Special Bundles in the Standard Bundles flow

**Files:**
- Modify: `lib/ussd-hubtel/flows/network-plans.ts`, `lib/ussd-hubtel/types.ts`
- Test: `lib/ussd-hubtel/flows/network-plans.special.test.ts`

**Interfaces:**
- Consumes: `NetworkPlansServices.specialPlans`, `createSpecialOrder`, `findSpecialOrderId` from Task 4.
- Produces: `export const SPECIAL_CATEGORY = "Special Bundles"`, and session field `npSpecial?: boolean`.

- [ ] **Step 1: Write the failing tests**

- MTN with plans: the first category line is `1. Special Bundles`, and existing categories follow in their usual order. Telecel and AT never show it.
- `specialPlans` returning no plans, or throwing, leaves the normal category list intact, with no error screen.
- A Hubtel category that happens to be named `Special Bundles` is dropped from the list, so the digit always means ours.
- Picking it shows `MTN Special Bundles` with lines like `1. 1.22GB - GHS x.xx` and every size reachable by paging. Every screen is at most 182 characters, including with 6 sizes.
- `00` returns to categories. Recipient and confirm screens match Standard Bundles, and Telecel and AT recipient rules are unaffected.
- Confirm `1` calls `createSpecialOrder` with `expectedPay` = the shown total, then answers AddToCart at that total with `CH order <first 8 of child 1>`. Nothing else is written.
- A repeat confirm or lost reply: `replaySubmittedOrder` returns the identical cart, and `createSpecialOrder` is not called again.
- `createSpecialOrder` throws after committing: `findSpecialOrderId` finds child 1, `failOrphanEngineOrder` fails the group, and the caller sees the unavailable text.
- `409` gives `Price changed. Please try again.`, `429` gives the too-many text, `403` gives `Not available right now.`
- Shop mode passes the session's `shopId`. A shop session with no `shopId` fails closed with no order.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/ussd-hubtel/flows/network-plans.special.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Branch only where `npSpecial` is true. The plain Standard Bundles paths and their tests stay as they are. Map `BotSpecialPlan` to `NpPlan` as `{ t: token, d: display, f: faceAmount, p: payAmount }`, so paging, recipient and confirm screens are shared. Use the delivery note the same way as Standard Bundles.

- [ ] **Step 4: Run to verify they pass, then commit**

Run: `npx vitest run lib/ussd-hubtel`
Expected: PASS.

```bash
git add lib/ussd-hubtel
git commit -m "feat(ussd-hubtel): Special Bundles first on MTN Standard Bundles"
```

### Task 6: Unpaid groups fail together

**Files:**
- Create: `lib/ussd-hubtel/special-group.ts`, `lib/ussd-hubtel/special-group.test.ts`
- Modify: `lib/ussd-hubtel/order-tables.ts` (`failOrderGuarded`), `lib/ussd-hubtel/order-handlers.ts` (`guardedFailUpdate`, `failOrderStrict`)

**Interfaces:**
- Produces: `readSpecialGroup(supabase, table, orderId): Promise<{ groupId: string; children: SpecialGroupChild[] } | null>`. It returns null for non-Special rows and for tables other than `hubtel_data_orders`, and throws on a read error. `SpecialGroupChild = { id; special_index; channel; status; payment_status; paid_amount; payment_reference }`, ordered by `special_index`.

- [ ] **Step 1: Write the failing tests**

- `createFailHandlers` on child 1 fails every child that is pending + unpaid and `channel='bots'` (Review Focus 4).
- `failOrderStrict` on child 1 fails all children. If no child changed, it throws as it does today.
- A child already paid is untouched, and a dashboard Special row is never touched by these paths.
- Non-Special rows produce the same single update as today. Pin this with the existing tests unchanged.
- A group read error in the lenient path logs an error and fails child 1 by id. In the strict path it throws.
- A stale-sweep test pins that a `hubtel_ussd` Special child is not swept, because that surface has its own expiry.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/ussd-hubtel/special-group.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Read the group first, then apply the same guarded patch with `.eq("special_group_id", groupId)` in place of `.eq("id", id)`, and always keep the `channel='bots'` guard.

- [ ] **Step 4: Run to verify they pass, then commit**

Run: `npx vitest run lib/ussd-hubtel lib/bot-commission`
Expected: PASS.

```bash
git add lib/ussd-hubtel lib/bot-commission
git commit -m "fix(ussd-hubtel): an unpaid Special group fails as one"
```

### Task 7: Payment confirms the group and dispatches in the background

**Files:**
- Create: `lib/ussd-hubtel/special-payment.ts`, `lib/ussd-hubtel/special-payment.test.ts`
- Modify:
  - `lib/ussd-hubtel/order-handlers.ts` (`botCommissionPostPayment`, `createOrderHandlers` options, `recordBotPaymentForReview` for groups)
  - `lib/standard-bundles/special-service.ts` (export the dispatch loop as `dispatchSpecialGroup`, behaviour unchanged)
  - `lib/storefront-commission/confirm-runtime.ts` (add `confirmBotPaymentQueued`)
  - `lib/standard-bundles/special-watch.ts` (message only, if needed)
  - `app/api/ussd-hubtel/fulfillment/route.ts` and `app/api/cron/hubtel-status-check/route.ts` (pass `defer`, `export const maxDuration = 300`)

**Interfaces:**
- Consumes: `readSpecialGroup` from Task 6, `confirmBotOrder`, `buildSettleDeps`.
- Produces:
  - `confirmBotPaymentQueued(table, orderId, p, queue: string[]): Promise<ConfirmResult>`, which is `confirmBotOrder` with `deps.dispatch` replaced by `async (_t, id) => { queue.push(id); return "pending" }`. This leaves `confirm.ts` unchanged.
  - `specialGroupPostPayment(supabase, group, facts, opts: { confirmQueued; dispatchGroup; defer }): Promise<void>`
  - `createOrderHandlers(supabase, opts?: { confirmBot?; defer?: (task: () => Promise<void>) => void })`

- [ ] **Step 1: Write the failing tests**

- Hubtel amount equals the sum of children, pesewa-exact: every child is flipped with the same reference, a share is credited per child in shop mode, and the handler returns before any dispatch. Then the deferred task dispatches each child once, in `special_index` order.
- Amount differs by 1 pesewa: no child is flipped by the engine and nothing is dispatched. Every unpaid child gets `recordBotPaymentForReview`, and the handler throws, which gives `needs_review`.
- One child is `failed` before payment: nothing is dispatched, and the group is held as above.
- Replay after everything flipped: no second share, no second dispatch (Review Focus 3).
- Replay after the process died mid-group: children flipped but never sent are queued by the engine's `resumed` outcome, and only those are dispatched.
- Confirm returns `error` on child 3: children already flipped are still dispatched, the handler throws so the row lands in `needs_review`, and an URGENT alert names the group.
- `defer` missing: dispatch runs inline.
- Children stuck pending + paid: `watchStuckSpecialGroups` alerts for a `channel='bots'` group. It has no channel filter, so pin this.
- `recordBotPaymentForReview` on child 1 covers every child that is still unpaid.
- A non-group `hubtel_data_orders` row and `hubtel_bill_orders` take today's path, shown by the existing `order-handlers.bots.test.ts` passing unchanged.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run lib/ussd-hubtel/special-payment.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`botCommissionPostPayment` selects `special_group_id` too and branches only when it is set. Compare `amountAfterCharges` with the sum in integer pesewas. `dispatchSpecialGroup` keeps its 240-second budget and URGENT alerts. `dispatchBundleOrder` sends no customer SMS today, so add none. If review finds a per-unit customer SMS on the `bots` channel, send one for the group instead. Unique indexes on `hubtel_data_orders` do not include `payment_reference` (checked in production 2026-11-07), so one reference across children is allowed.

- [ ] **Step 4: Check admin views and refunds**

Add a test that a `channel='bots'` Special child appears in `app/api/admin/standard-bundles/orders/route.ts` and in `/admin/refunds` with the payer's phone as the refund destination. Change them only if the test fails. Refund per child, and refuse a second refund of the same child through the existing RPC guard.

- [ ] **Step 5: Run to verify they pass, then commit**

Run: `npx vitest run lib/ussd-hubtel lib/bot-commission lib/storefront-commission lib/standard-bundles lib/refunds`
Expected: PASS, apart from the known failure in `lib/standard-bundles/runtime.test.ts`.

```bash
git add lib app/api
git commit -m "feat(ussd-hubtel): one Hubtel payment delivers a whole Special group"
```

### Task 8: Fresh review, apply, ship dark, supervised test

**Files:**
- Modify: `docs/hubtel-ussd-runbook.md` (a Special Bundles on USSD section)

- [ ] **Step 1: Fresh reviewer on Part B**

Mandatory, since Part B covers money and schema. Verify each finding, re-grade it, and fix with a failing test first.

- [ ] **Step 2: Find out what `Hubtel code 2001` means**

Check `docs/hubtel-commission-services/hubtel-docs-full-2026-10-12.md` and the production ledger counts (no phone numbers). Record the answer in the runbook. If it means repeated purchases are being refused, stop and tell the owner before going further.

- [ ] **Step 3: Run the migration protocol**

Pre-check counts, run the self-rolling-back dry run, **get the owner's OK**, apply, then verify the CHECK, the RPC grants and that dashboard Special still works.

- [ ] **Step 4: Run full checks, then deploy with `ussdEnabled` off**

Run: `npx vitest run`, `npx tsc --noEmit`, a placeholder-env `next build`. Check local `main`, push, watch the deploy.
Expected: the MTN category list shows no Special Bundles line, and paid traffic continues.

- [ ] **Step 5: Supervised live test, with the owner turning on `Sell on Hubtel USSD`**

Main code: smallest size, then the largest. Shop code: one purchase.
Expected for each: one `hubtel_transactions` row `fulfilled`, N children `completed`, the data on the handset, the callback sent, and the shop share = N x the per-unit share on the shop purchase.

- [ ] **Step 6: Update the memory files and tell the owner the result**
