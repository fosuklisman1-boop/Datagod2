# Commission Cashback — Bots Plan 2: Hubtel USSD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The live Hubtel USSD code ("Clingshub", currently shop mode) gains **Network Plans** and **Pay Bills** menus and cashback-priced **airtime**, paid through Hubtel's AddToCart checkout, confirmed through the shared bot engine.

**Architecture:** Plug into the existing Hubtel USSD framework (`lib/ussd-hubtel/*`): new steps + flows in `flows/`, menu entries via `menuFor` + `config.visibility`, orders created with the bot engine (`lib/bot-commission`), carts via the existing `submitOrder` (which inserts the `hubtel_transactions` row and answers AddToCart with an opaque `cartItemNameFor` name), and payment completion via the existing `processFulfillment` → per-table order handler → `confirmCommissionOrder`.

**Tech Stack:** Next.js 15, TypeScript, Supabase, Vitest, Hubtel USSD protocol.

**Spec:** `docs/superpowers/specs/2026-10-14-cashback-bots-design.md`. Engine (live-dark): `docs/superpowers/plans/2026-10-14-cashback-bots-1-engine.md`, carried items in runbook "Commission Cashback — Bots (Plan 1)" §4.

## Global Constraints

- Rail `hubtel`; `bot_surface = 'hubtel_ussd'`; shop context when the session is in shop mode with an accepted shop (use the session's resolved `shopId`, which the shop-code resolver already gates for blocked/unapproved shops); main mode ⇒ no shop. Build `BotContext` exactly as `resolveBotContext` requires.
- Price shown and charged = `quoteBots(..., rail: "hubtel")` `payAmount`; Hubtel adds its own checkout charge on top (existing behaviour: "our price: Hubtel adds its own charge on top"), so the recommended `botFees.hubtel` is 0 (runbook).
- Menus appear only when `cfg.enabled && cfg.surfaces.bots && cfg.botGroups[group]` AND `hubtel_ussd_config.visibility.networkPlans / payBills` (new visibility flags, default true) — the cashback switch is the real gate. Airtime with cashback off = today's pricing byte-for-byte.
- Names: "Network Plans", "Pay Bills" — no "data"/"bundle" words on any screen. Ghana Water never offered (WhatsApp only; also refused server-side).
- Screens ≤ 182 chars (tested helper); plans paged 5 per screen with `0 Next` / `00 Back`; confirm screen: `Pay GHS x (was GHS y)` + `You receive …`.
- ECG on USSD: `1 This number` (dialing phone) / `2 Other number` / `3 Meter number` → meters (masked names) or meter entry (`1 Prepaid 2 Postpaid`) → `1 Yes, link meter X to <phone>` consent → amount → confirm.
- Hubtel never sees product words: carts use `cartItemNameFor(orderId)`; never send BILL-/SB- references.
- `hubtel_transactions.order_table` gains `hubtel_bill_orders`, `hubtel_data_orders` (migration, next free number, expected **0124**; `ORDER_TABLES` entries + `order-tables.test.ts` pin); expiry/rollback fail patch for unpaid bot orders: `status:'failed', failure_reason:'payment not completed'` (payment_status stays `unpaid`).
- Order handler for the two tables: read the order, call `confirmCommissionOrder` with `paidAmount = paid_amount` (processFulfillment's `decidePayment` already compared Hubtel's amount to `expected_amount = paid_amount`) and reference = Hubtel OrderId; outcome `confirmed/resumed/already_processed` ⇒ OK for the callback; otherwise needs_review.
- Abuse caps from the engine apply; 429/403 `Fail`s map to friendly USSD text ("Too many attempts. Please try later." / "Not available").
- Edit/Write tools only; regexes in tested helpers; real `next build`; before pushing check origin/local main for foreign commits and chain `merge --ff-only && push`. Trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Airtime on Hubtel USSD with cashback off is byte-identical (screens + price + order row) (Task 3).
2. One Hubtel payment ⇒ one confirm, one shop share, one Hubtel POST — including duplicate/late callbacks handled by `processFulfillment` (Task 2).
3. An unpaid bot order that expires is marked failed and is never refundable/dispatched (Task 2).
4. USSD text never exceeds 182 chars and never contains "data"/"bundle" (Tasks 4–5).
5. Shop mode: share credited only for an accepted, unblocked shop; main mode never credits a share (Tasks 2, 4–5).

---

### Task 1: Migration + config visibility
`migrations/0124_hubtel_ussd_bot_orders.sql`: widen `hubtel_transactions.order_table` CHECK (find its name; drop/recreate with the two new tables). `lib/ussd-hubtel/config.ts`: visibility `networkPlans`, `payBills` (default true) + admin UI toggles on the existing Hubtel USSD admin page. Tests. Commits.

### Task 2: Order tables + handlers
`lib/ussd-hubtel/order-tables.ts` (+ test pin), `lib/ussd-hubtel/order-handlers.ts` (`createOrderHandlers` / fail handlers for the two tables per Global Constraints), using `confirmCommissionOrder` from the engine. Tests: paid ⇒ confirmed once (duplicate callback ⇒ already_processed), shop vs main share, amount path, expiry fail patch. Commit.

### Task 3: Airtime with cashback
`flows/airtime.ts` + `flows/shop-airtime.ts`: quote with `quoteBots(rail hubtel, shop per mode)` when applied; confirm screen shows cashback; `airtime_orders` row snapshot columns + `payment_fee_amount`; `submitOrder` price = payAmount; when not applied the code path is unchanged (byte-identity test of screens and inserted row). Commit.

### Task 4: Network Plans flow
New steps (`NP_NETWORK`, `NP_CATEGORY`, `NP_PLAN`, `NP_RECIPIENT`, `NP_CONFIRM`) + `flows/network-plans.ts` using `botCatalog` (catalog tokens in session), paging helper, recipient default = dialing phone, `botCreateBundleOrder` (idempotency key = session id) then `submitOrder` with the created order — refactor `submitOrder` to accept an already-created order id (bot orders are created by the engine) without changing existing callers. Tests incl. paging, truncation, 409 → "price changed, try again". Commit.

### Task 5: Pay Bills flow
New steps (`PB_BILLER`, `PB_ECG_MODE`, `PB_ACCOUNT`, `PB_METER_TYPE`, `PB_METERS`, `PB_CONSENT`, `PB_AMOUNT`, `PB_CONFIRM`) + `flows/pay-bills.ts` using `botVerifyBill` (masked names) and `botCreateBillOrder`, then `submitOrder` with the created order. Ghana Water absent. Tests. Commit.

### Task 6: Menus, verification, runbook
Wire both flows into `menuFor` / main + shop menus (`router.ts`, `menus.ts`), margin-report note, full vitest (9 known failures only), tsc, real build, runbook "Commission Cashback — Bots (Plan 2: Hubtel USSD)" (apply 0124 before deploy; enable bots + groups; Hubtel fee 0 recommended; test with a test number in shop mode). STOP before migrating/pushing.

## Self-review

Spec §5 menus → Tasks 3–5; §4 orders/payment (Hubtel rail) → Tasks 1–2; carried items: gated shop resolver (Global Constraints), opaque Hubtel refs (Global Constraints), friendly cap text (Global Constraints). Payer-phone refunds: Hubtel rail pays from the dialing phone = `buyer_phone`, so no change needed here.
