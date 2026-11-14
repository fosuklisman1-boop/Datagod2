# Text-to-Buy Stage 2 (airtime and results-checker vouchers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers who text the main number can also buy airtime (`airtime 10`, `airtime 10 0241234567`) and results-checker vouchers (`2 wassce checkers`) with one text and one MoMo PIN, at the same prices, fees, limits and stock as the USSD menus, behind two admin switches that start OFF.

**Architecture:** The lane in `lib/text-to-buy/` stops being data-shaped: each service is a small adapter in `lib/text-to-buy/services/` (resolve, place, quote, read order, classify, notice copy), and the lane, the STATUS keyword and the follow-up notifier drive adapters. Data is moved onto the interface first with no behaviour change (pinned by a golden test written before the refactor). Airtime and vouchers then place orders through sms-capable wrappers around the existing USSD confirm logic (`lib/ussd/handlers/airtime.ts`, `results-checker.ts`), MoMo only, payer is the sender.

**Tech Stack:** Next.js 15 App Router (Node runtime), TypeScript, Supabase Postgres (service role), Vitest, existing `lib/airtime-pricing.ts`, `lib/results-checker-service.ts`, `lib/ussd/gateway-charge.ts`, `lib/ussd/gateway-test-kit.ts`.

**Spec:** `docs/superpowers/specs/2026-11-14-text-to-buy-stage2-design.md` (binding; read all of it). Code facts with file:line references: the recon notes summarised in the spec's section 6. Stage 1 plan for conventions: `docs/superpowers/plans/2026-11-13-text-to-buy-stage1-main-data.md`.

**Base:** branch `feat/ttb-stage2` in a new worktree from `origin/main` (Stage 1 is live there). Local `main` is stale: never branch from it. Copy the design and this plan into the worktree and commit them first (`docs(text-to-buy): stage 2 design and plan`).

## Global Constraints

- Scope: airtime and results-checker vouchers on the MAIN line only. No results-check service ("check my results"), AFA, bills, shop line, shop credits, cashback pricing on text, wallet payment, or airtime/voucher price-list keyword (`PRICES` stays data).
- The AI never prices. Its tool may carry `amount_ghs`, `board`, `quantity` only as a description of what the customer typed; every one is re-checked in code against the customer's own text. Every money figure in an SMS is filled by code from the value written to the order row.
- Payer is always the sender. MoMo only. No other number can be charged. Voucher PINs always go to the sender's number.
- One GSM-7 segment per lane reply, enforced through `fitOneSegment` / `sendReply` (which refuses anything else). The voucher PIN SMS never goes through `sendReply`.
- Ships dark: `ttb_airtime_enabled` and `ttb_results_checker_enabled` default false (missing key = false; only a stored `true` turns one on). With both off, the lane behaves exactly as Stage 1 for every text, except that an airtime or voucher text is now recognised and answered as "not understood" instead of being read as data.
- A text switch never turns on a service that is off on its own admin switch (`airtime_enabled_<network>`, `results_checker_enabled_<board>`). The USSD menu-visibility toggles (`getUssdServiceVisibility().airtime/resultsChecker`) are NOT the text gate.
- Shared caps stay shared across services: per-sender prompt cap, global prompt cap, one open order per sender (`ttb_orders_one_open`), the overall reply cap.
- Order rows keep `channel = 'ussd'` (the Telecel/AT OTP redial in `lib/ussd/router.ts` filters on it). No router change.
- No migration in this stage. `ttb_orders.service` / `order_table` are free text; settings are upserted; conversation state is JSON. Never apply SQL, set env vars or touch any database; implementers never run migrations.
- No Redis in the lane: the sms paths of the airtime and voucher handlers never call `setSession`; the session id stays the opaque `sms:<message id>`.
- Customer texts, phone numbers, amounts and PINs are never written to `console.*` by new code. Log outcome codes and row ids only.
- Charge references stay the opaque order UUID; nothing in a Hubtel clientReference names a surface or product.
- Existing USSD, WhatsApp and Send & Claim behaviour must not change. Each handler edit is preceded by characterisation tests on the untouched code (pattern: `lib/ussd/handlers/bundles.confirm-sms.test.ts`).
- Code edits use the Edit/Write tools only. Never sed/awk/perl on source files (tell subagents too).
- TDD: failing test first. Logic lives in `lib/` as pure or dependency-injected functions.
- Test phone numbers: senders and recipients `0200000101` to `0200000199`. Where a test needs a specific carrier, mock the prefix map / `detectAirtimeNetwork` instead of using a real-looking number.
- Known pre-existing full-suite failures (12): 9 in `lib/order-health-service.test.ts`, plus `lib/pricing/migration.test.ts` (0142), `lib/standard-bundles/runtime.test.ts` (getBuyerTier), `lib/admin-users/migration.test.ts`. Load-flaky in the full run only, green in isolation: `app/api/v2/sms/routes.test.ts` (3), `lib/sub-agents/earnings-migration.test.ts`. Any other failure is yours. `tsc`: record the baseline error list on the untouched branch in Task 1 (Stage 1 saw only pre-existing test files such as `lib/leaderboard/delivery.test.ts`); the end state must match it.
- A full test run can rewrite `lib/ussd/bots/__snapshots__/uzo-golden.test.ts.snap` with line-ending-only changes: revert it (`git checkout -- <path>`) instead of committing it.
- `.superpowers/` in the workspace is git-ignored; never commit it.
- `next build` only from PowerShell with the repo's placeholder env, in the final task (it fails inside the sandboxed Bash tool on Windows).
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Money paths are touched: a fresh reviewer is mandatory for every task marked so below, and a whole-branch review at the end.
- Admin UI: navy `--primary` accent, `lg:` widening from the start, no horizontal scroll at 500px.

## Review Focus

1. **Order-link trap.** An airtime or voucher link written with the database defaults (`data` / `ussd_orders`), or read against `ussd_orders`, looks like a missing order and is closed with no notices. Expect: `linkOrder` cannot be called without `service` and `orderTable`, refuses a mismatched pair, and the notifier never closes a link whose pair it does not know (it alerts instead). Tests in Task 1 (store) and Task 2 (notifier).
2. **"10gb", "10" and "send me 10" must never become airtime; an airtime text must never become a data order.** Expect: bare numbers stay GB; any data unit next to the number blocks airtime; an AI airtime read with no airtime or currency word is re-read as data; with the airtime switch off, `airtime 10` is answered as not understood and no data order is placed. Tests in Task 5 (rules, AI) and Task 6 (lane).
3. **The quote's money comes from the order row, not the preview.** The airtime fee tier is read live at confirm and the voucher confirm re-prices with no "price changed" check. Expect: the airtime quote shows `total_paid` and `airtime_amount` returned by the sms confirm; the voucher quote shows the returned `total_paid`, even when they differ from what resolve computed. Tests in Task 3, Task 6 and Task 9.
4. **Orphan rows and side effects on the sms path.** A funded registered sender would get the wallet detour (row written, menu returned, no charge); the handlers also wait 3 s, send a "redial" OTP SMS and write the session store. Expect for `sms`: no wallet detour whatever the balance, no wait, no OTP SMS, no `setSession`, no cashback evaluation (bot quote functions never called). Tests in Task 3 (airtime) and Task 7 (vouchers).
5. **Wrong or missing follow-ups.** Expect: the 30-minute delay notice for airtime and vouchers never says "No need to pay again"; vouchers never get a delivered notice (the PIN SMS is the delivery) and PINs never pass through `sendReply`; own-number airtime gets no delivered notice, gifts do; a paid voucher order parked at `pending` (stock ran out) gets the delay notice. Tests in Task 6 and Task 9.

---

## File Structure

Create:

| File | Responsibility |
|---|---|
| `lib/text-to-buy/services/types.ts` | The adapter contract (`ServiceAdapter`, `ServiceOffer`, `Refusal`, `PlaceResult`, `OrderRow`, `OrderKind`) |
| `lib/text-to-buy/services/classify.ts` | Pure status vocabularies to `OrderKind` (ussd_orders; airtime/voucher `status`+`payment_status`) |
| `lib/text-to-buy/services/data.ts` | Data adapter wrapping `resolveOffer`, `sessionForOffer`, `handleConfirm` |
| `lib/text-to-buy/services/airtime.ts` | Airtime adapter: recipient, network, switch, limits, fee tier, place, copy |
| `lib/text-to-buy/services/results-checker.ts` | Voucher adapter: board, stock, quantity, bulk price, place, copy |
| `lib/text-to-buy/services/index.ts` | `makeAdapters`, `adapterForLink` |
| `lib/text-to-buy/lane-golden.test.ts` (+ snapshot) | Characterisation of the Stage 1 lane and notifier, written before the refactor |
| `lib/ussd/handlers/airtime.confirm-sms.test.ts` | Characterisation (ussd, whatsapp) then the sms path |
| `lib/ussd/handlers/results-checker.confirm-sms.test.ts` | Same for vouchers |
| `lib/text-to-buy/services/*.test.ts`, `lib/text-to-buy/handle-inbound.services.test.ts`, `lib/text-to-buy/notify.services.test.ts` | Adapter, lane and notifier tests for the new services |

Modify:

| File | Change |
|---|---|
| `lib/text-to-buy/types.ts` | `Service` widened, `OrderTable`, `ExamBoardWord`, per-service `OrderRead` union |
| `lib/text-to-buy/store.ts` | Link functions carry `service`/`orderTable`; `orderRowFor` reads the right table; `serviceCountsToday`; `LastOrder` union |
| `lib/text-to-buy/fake-db.test-helper.ts` | Learns `airtime_orders`, `results_checker_orders`, `.not(col, "is", null)` |
| `lib/text-to-buy/handle-inbound.ts`, `inbound-steps.ts`, `notify.ts` | Driven through adapters |
| `lib/text-to-buy/parse-rules.ts`, `ai-reader.ts`, `replies.ts` | Airtime and voucher grammar, AI fields, copy |
| `lib/text-to-buy/settings.ts`, `admin-validate.ts`, `app/api/admin/text-to-buy/route.ts` | Two switches, confirm to turn on, per-service counts |
| `app/admin/text-to-buy/_components/{api.ts,format.ts,SettingsTab.tsx,OverviewTab.tsx}` | Switches, per-service counts |
| `lib/ussd/handlers/airtime.ts`, `lib/ussd/handlers/results-checker.ts` | Exported sms wrappers over the shared confirm logic |
| `docs/text-to-buy/runbook.md` | Stage 2 sections |

---

### Task 1: Service types, link plumbing and the lane golden test (no behaviour change)

Fresh reviewer mandatory (order-link trap; money follow-ups).

**Files:**
- Modify: `lib/text-to-buy/types.ts`, `lib/text-to-buy/store.ts`, `lib/text-to-buy/fake-db.test-helper.ts`, `lib/text-to-buy/handle-inbound.ts` (the one `linkOrder` call only)
- Create: `lib/text-to-buy/lane-golden.test.ts`
- Test: `lib/text-to-buy/store.test.ts` (extend), `lib/text-to-buy/lane-golden.test.ts`

**Interfaces:**
- Consumes: `makeFakeTtb` (fake-db helper), `processInbound`, `runTtbNotify` and the injected-deps harness of `lib/text-to-buy/handle-inbound.test.ts` / `notify.test.ts`.
- Produces:

```ts
// types.ts
export type Service = "data" | "airtime" | "results_checker"
export type OrderTable = "ussd_orders" | "airtime_orders" | "results_checker_orders"
export const ORDER_TABLE_OF: Record<Service, OrderTable> = { data: "ussd_orders", airtime: "airtime_orders", results_checker: "results_checker_orders" }
export type OrderRead = Extract<ReadResult, { kind: "order" }>   // still the data shape in this task; Task 5 makes it a union

// store.ts
export type OrderRow = { paymentStatus: string; orderStatus: string; amount: number }
/** ussd_orders: order_status, payment_status, amount. airtime_orders / results_checker_orders: status, payment_status, total_paid. Null when the row is gone. */
export async function orderRowFor(db: SupabaseClient, table: OrderTable, orderId: string): Promise<OrderRow | null>
export async function linkOrder(db: SupabaseClient, o: {
  line: Line; sender: string; service: Service; orderTable: OrderTable; orderId: string
  size: string; recipient: string; gift: boolean; amount: number
}): Promise<{ id: string } | { id: string; alreadyLinked: true } | "conflict">   // throws TtbStoreError when ORDER_TABLE_OF[service] !== orderTable
export type OrderLink = { id: string; orderId: string; service: string; orderTable: string; state: string; size: string; recipient: string; notices: string[]; createdAt: string }
export type WatchedLink = { /* Stage 1 fields */ } & { service: string; orderTable: string }
// ussdOrderStatus and ussdOrderForNotify stay, as thin wrappers over orderRowFor(db, "ussd_orders", id)
```

`latestOrderLink`, `watchedLinks` (`WATCH_COLUMNS`) also select `service, order_table`. `service`/`orderTable` on read links are raw strings on purpose (the notifier decides what it knows). A row with a null `service` or `order_table` (only possible in fakes; the columns are NOT NULL with defaults) maps to `data` / `ussd_orders`, mirroring the database defaults.

- [ ] **Step 1: Baseline.** On the untouched branch run `npx vitest run lib/text-to-buy lib/ussd` and `npx tsc --noEmit`; record the tsc error list in the task report.
- [ ] **Step 2: Golden test on untouched code.** Write `lane-golden.test.ts` with the harness of `handle-inbound.test.ts` (fake db + injected `resolve`, `confirm`, `prices`, `readAi`, `reply`, `feeOnTop`) and of `notify.test.ts`. Drive this matrix and `toMatchSnapshot()` for each: `{ outcome, readBy, reply }`, the `confirm` call arguments, the inserted `ttb_orders` row (all columns), the saved conversation, and the replies sent: texts `5gb`, `5gb 0200000102`, `PRICES` then `2`, `how much is 10gb` then `yes`, `again` after an order, `status` after an order, `yes` with nothing pending, `hello` (not understood), an AT sender with both products then `1`, a dry run of `5gb`; notifier runs over links in each order state of the Stage 1 table (waiting under and over the window, payment failed, repriced, paid, delivered gift, delivered own, delivery failed, refunded, order row missing). Run: PASS; commit the snapshot.
- [ ] **Step 3: Failing store tests** (extend `store.test.ts`):

```ts
it("linkOrder writes service and order_table", async () => {
  await linkOrder(c, { ...o, service: "airtime", orderTable: "airtime_orders" })
  expect(f.db.tables.ttb_orders[0]).toMatchObject({ service: "airtime", order_table: "airtime_orders" })
})
it("linkOrder refuses a mismatched pair", async () =>
  await expect(linkOrder(c, { ...o, service: "airtime", orderTable: "ussd_orders" })).rejects.toBeInstanceOf(TtbStoreError))
it("orderRowFor reads airtime_orders status columns", async () => {
  f.db.tables.airtime_orders = [{ id: A, status: "pending", payment_status: "completed", total_paid: 10, airtime_amount: 9.52 }]
  expect(await orderRowFor(c, "airtime_orders", A)).toEqual({ orderStatus: "pending", paymentStatus: "completed", amount: 10 })
  expect(await orderRowFor(c, "ussd_orders", A)).toBeNull()
})
it("orderRowFor reads results_checker_orders", ...)          // { orderStatus: "pending", paymentStatus: "completed", amount: 30 }
it("latestOrderLink and watchedLinks carry service and orderTable", ...)
it("a link row with null service maps to data / ussd_orders", ...)
```

- [ ] **Step 4: Run** `npx vitest run lib/text-to-buy/store.test.ts` — FAIL (unknown table in the fake, missing fields).
- [ ] **Step 5: Implement.** Fake `SCHEMA` adds `airtime_orders: ["id", "status", "payment_status", "total_paid", "airtime_amount", "updated_at"]` and `results_checker_orders: ["id", "status", "payment_status", "total_paid", "updated_at"]`. Store as in Interfaces. The lane's `linkOrder` call passes `service: "data", orderTable: "ussd_orders"`. The only edits allowed in Stage 1 test files: adding `service`/`orderTable` to `linkOrder` inputs and fixtures; no assertion changes.
- [ ] **Step 6: Run** `npx vitest run lib/text-to-buy` — PASS, golden snapshot unchanged (`git diff --stat` shows no `.snap` change).
- [ ] **Step 7: Commit** `refactor(text-to-buy): links carry service and order table; per-table order reads`.

---

### Task 2: Data onto the adapter interface (no behaviour change)

Fresh reviewer mandatory (money path refactor).

**Files:**
- Create: `lib/text-to-buy/services/{types.ts,classify.ts,data.ts,index.ts}`
- Modify: `lib/text-to-buy/handle-inbound.ts`, `lib/text-to-buy/inbound-steps.ts`, `lib/text-to-buy/notify.ts`
- Test: `lib/text-to-buy/services/classify.test.ts`, `lib/text-to-buy/services/data.test.ts`, `lib/text-to-buy/notify.services.test.ts`, `lane-golden.test.ts` (unchanged)

**Interfaces:**
- Consumes: Task 1; `resolveOffer`, `sessionForOffer`, `sizeLabel`, `parseSizeMb` (`catalogue.ts`); `handleConfirm` (`lib/ussd/handlers/bundles.ts`); `quoteReply`, `unpaidReply`, `deliveredGiftReply`, `paidNotDeliveredReply`, `unavailableReply`, `wrongNumberReply`, `fitOneSegment` (`replies.ts`); `productQuestion`, `dedupeNearest`, `lastOrderOf`, `orderStatusOf`, `OrderStatus` (`inbound-steps.ts`).
- Produces:

```ts
// services/types.ts
export type OrderKind = "waiting" | "payment_failed" | "paid" | "delivered" | "delivery_failed" | "refunded"  // notify.ts re-exports it
export type PayerNetwork = QuoteInput["payerNetwork"]
export type Refusal = { outcome: "asked" | "unavailable"; reply: string; pending?: Pending; remember: boolean }
export type Amounts = { amountGhs: number; deliversGhs?: number }
export type PlaceResult = { orderId?: string; amountGhs?: number; deliversGhs?: number }
export interface ServiceOffer {
  service: Service
  size: string              // stored in ttb_orders.size; re-textable token for unpaid/status replies
  recipientLocal: string
  gift: boolean
  previewGhs: number        // dry-run quote and the fee-on-top lookup only
  previewDeliversGhs?: number
  paystackProvider: "mtn" | "vod" | "tgo"
  lastOrder: LastOrder
}
export interface ServiceAdapter<O extends ServiceOffer = ServiceOffer> {
  readonly service: Service
  readonly orderTable: OrderTable
  /** The TEXT switch only. Live service switches are re-checked in resolve and again inside the handler. */
  textEnabled(s: TtbSettings): boolean
  resolve(db: SupabaseClient, senderLocal: string, read: OrderRead): Promise<{ ok: true; offer: O } | { ok: false; refusal: Refusal }>
  place(offer: O, messageId: string, senderLocal: string): Promise<PlaceResult>
  quote(offer: O, a: Amounts, ctx: { feeOnTop: boolean; payerNetwork: PayerNetwork }): string
  notPlacedReply(offer: O): string
  readOrder(db: SupabaseClient, orderId: string): Promise<OrderRow | null>
  classify(row: { paymentStatus: string; orderStatus: string }): OrderKind
  statusOf(link: { state: string }, row: OrderRow | null): OrderStatus
  notices: { unpaid(size: string): string; delivered(l: { size: string; recipient: string; gift: boolean }): string | null; paidNotDelivered(): string }
}

// services/classify.ts
export function classifyOrder(row: { paymentStatus: string; orderStatus: string }): OrderKind        // moved verbatim from notify.ts; notify.ts re-exports it
export function classifyStatusOrder(row: { paymentStatus: string; orderStatus: string }): OrderKind  // airtime_orders / results_checker_orders vocabulary

// services/data.ts
export type DataOffer = ServiceOffer & { service: "data"; offer: Offer }
export function dataAdapter(deps?: { resolve?: typeof resolveOffer; confirm?: typeof handleConfirm }): ServiceAdapter<DataOffer>

// services/index.ts
export type Adapters = Partial<Record<Service, ServiceAdapter>>
export type AdapterDeps = { resolve?: typeof resolveOffer; confirm?: typeof handleConfirm }   // later tasks add airtimeConfirm, rcConfirm
export function makeAdapters(deps?: AdapterDeps): Adapters
/** The adapter for a stored link, or null when (service, orderTable) is not a pair ORDER_TABLE_OF knows or no adapter is registered. */
export function adapterForLink(adapters: Adapters, link: { service: string; orderTable: string }): ServiceAdapter | null

// handle-inbound.ts: InboundDeps gains, and changes
adapters?: Adapters                                   // merged over makeAdapters({ resolve, confirm })
feeOnTop?: (offer: ServiceOffer) => Promise<boolean>  // was (offer: Offer); default uses offer.previewGhs and offer.paystackProvider
// notify.ts: NotifyDeps gains
adapters?: Adapters
```

`classifyStatusOrder` mapping (spec 5.5): status `completed` → delivered; status `refunding|refunded` → refunded; payment `completed` → status `failed` ? delivery_failed : paid (covers `pending|processing|flagged` and anything unknown); payment `failed|expired` → payment_failed; status `failed|expired` → payment_failed; else waiting (`pending_payment`, `otp_required`).

Data adapter: `textEnabled` always true (data stays gated by `mainEnabled` and `visibility.data` exactly as now). `resolve` maps `OfferResult` to `Refusal` exactly as `handle-inbound.ts` does today (choose_product → `productQuestion`, remember with pending; need_recipient → "Which <label> number should receive it?", remember; bad_recipient → `wrongNumberReply()`, remember; no_package → `unavailableReply(label, dedupeNearest(nearest))`; others → `unavailableReply("this network", [])`; the last two not remembered). `size` = the stored package size verbatim, `lastOrder = lastOrderOf(offer, read.sizeMb)`. `place` = `confirm("1", "sms:" + messageId, sessionForOffer(sender, offer), "sms", { momoOnly: true })` mapped to `{ orderId, amountGhs: response.amount }`. `quote` keeps the Stage 1 rule `feeOnTop && !(amountGhs > offer.price + 0.005)`. `notPlacedReply` = `unavailableReply(networkLabel, [])`. `statusOf` = `orderStatusOf`. Notices = today's templates (`delivered` only for gifts).

Lane changes (behaviour identical for data): step 7-8 order path picks `adapters[read.service]`; missing adapter or `!textEnabled(settings)` → the step 5 not-understood path. `price_query` and `PRICES` stay data-only and keep calling `resolve`/`prices` directly. STATUS reads `adapterForLink(adapters, link)?.readOrder` and `statusOf` (no adapter → `orderStatusOf(link, null)`). The "unusable amount" branch: data keeps `notPlacedReply`; other services use `placedNeutralReply()` (Task 6 adds it; in this task the branch exists only for data). Notifier `followLink`: `adapterForLink` null → do NOT close; `alert("Text-to-Buy: link with unknown order table: <link id>")` at most once per run; otherwise `readOrder` / `classify` / `notices` from the adapter, with the Stage 1 state machine unchanged.

- [ ] **Step 1: Failing tests.**
  - `classify.test.ts`: `classifyOrder` keeps every case of the existing notify classify tests (move them by import, not by copy); `classifyStatusOrder` table: `pending_payment/pending_payment` waiting, `otp_required/pending_payment` waiting, `failed/failed` payment_failed, `expired/expired` payment_failed, `completed/pending` paid, `completed/processing` paid, `completed/flagged` paid, `completed/completed` delivered, `completed/failed` delivery_failed, `completed/refunding` refunded, `completed/refunded` refunded.
  - `data.test.ts`: each `OfferResult` reason maps to the Refusal above with the exact Stage 1 strings; `place` passes `"sms"`, `{ momoOnly: true }`, session id `sms:<messageId>`; `quote` drops "+ MoMo charge" when the amount is above the offer price.
  - `notify.services.test.ts`: a link with `service: "airtime", order_table: "ussd_orders"` is not closed and alerts once; two such links in one run alert once; a link with `service: "nonsense"` likewise; a data link whose `ussd_orders` row is missing still closes (Stage 1 behaviour).
- [ ] **Step 2: Run** `npx vitest run lib/text-to-buy/services lib/text-to-buy/notify.services.test.ts` — FAIL.
- [ ] **Step 3: Implement** the adapter files, then move the lane and notifier onto them.
- [ ] **Step 4: Run** `npx vitest run lib/text-to-buy` — PASS; `lane-golden` snapshot and every Stage 1 test unchanged (`git diff` on `lib/text-to-buy/*.test.ts` and `.snap` shows only Task 1's permitted input additions).
- [ ] **Step 5: Commit** `refactor(text-to-buy): service adapter interface; data moved onto it`.

---

### Task 3: Airtime confirm path for text (`sms` channel)

Fresh reviewer mandatory (money).

**Files:**
- Modify: `lib/ussd/handlers/airtime.ts`
- Create: `lib/ussd/handlers/airtime.confirm-sms.test.ts`
- Test: also `lib/ussd/handlers/airtime.test.ts`, `airtime.gateway.test.ts` (must stay green untouched)

**Interfaces:**
- Consumes: `UssdChannel`, `ussdChargeSurface` (already maps `"sms"` → `"sms_order"`), the `lib/ussd/gateway-test-kit.ts` harness.
- Produces:

```ts
/**
 * Text-to-Buy: confirm a staged airtime session as channel "sms". MoMo only (no wallet detour whatever the balance),
 * no 3 s wait, no OTP SMS, never any cashback (legacy fee pricing only), never calls setSession.
 * Session needs: dialingPhone (+233...), airtimeNetwork, airtimeRecipient (local), airtimeAmount (what the payer pays).
 */
export async function confirmAirtimeByText(sessionId: string, session: USSDSession): Promise<UzoResponse & { delivers?: number }>
// success: orderId = the airtime_orders id, amount = total_paid as inserted, delivers = airtime_amount as inserted.
// every refusal (switch off, outside limits, no MoMo provider, insert failed): no orderId.
```

`handleAirtimeConfirm` keeps its exact signature (channel `'ussd' | 'whatsapp'`, so the "channel is required (compile-time)" test stays valid). Both become thin wrappers over one private `confirmAirtime(input, sessionId, session, channel: 'ussd' | 'whatsapp' | 'sms', opts)`; `chargeAirtimeMomo` takes the same widened private channel. `promptCashback`, `quoteFor`, `usableQuoteFor` keep `Channel` in their signature so the compiler forbids passing `"sms"`; the cashback re-quote block is skipped for `"sms"` even when the session carries `airtimeCashbackPay`. Row `channel` stays `"ussd"`; `metadata.source` and `payment_type` stay `"ussd_airtime"`.

- [ ] **Step 1: Characterisation on untouched code.** In `airtime.confirm-sms.test.ts` (copy the mock block of `bundles.confirm-sms.test.ts` / `airtime.gateway.test.ts`; also mock `../resolve-dialer` and spy on `../bots/airtime`), for `ussd` and `whatsapp`, with a non-funded dialer and a funded registered dialer: response message, the `airtime_orders` insert payload (all columns), `setSession` calls, `startUssdCharge` surface only after the timer (`runAfter`), `send_otp` side effects (USSD: `sendSMS` with `ussdOtpRequired`; WhatsApp: `setWaSession` + `sendWhatsAppText`), and the `AIRTIME_PAYMENT_METHOD` menu for the funded dialer. Run: PASS.
- [ ] **Step 2: Failing sms tests** (`describe("sms channel")`, sender `+233200000101`, rate 5, amount 10):

```ts
it("returns orderId, amount = total_paid and delivers = airtime_amount", async () => {
  const r = await confirmAirtimeByText("sms:m1", s({ airtimeAmount: 10 }))
  expect(r.orderId).toBe(order().id); expect(r.amount).toBe(order().total_paid); expect(r.delivers).toBe(order().airtime_amount)
  expect(order()).toMatchObject({ total_paid: 10, airtime_amount: 9.52, fee_amount: 0.48, channel: "ussd" })
})
it("a funded registered sender gets no wallet detour: charge started, no payment-method step", ...)
it("charges on sms_order with no wait (runNoWait) and never calls setSession", ...)
it("send_otp: payment_status otp_required, no sendSMS, no sendWhatsAppText, no setWaSession", ...)
it("charge throws: status and payment_status failed", ...)
it("airtimeCashbackPay on the session is ignored: legacy pricing, airtimeRequote and every uzo/wa quote function not called", ...)
it("isAirtimeEnabled false: no row, no orderId", ...)
it("amount above getAirtimeLimits max: no row, no orderId", ...)
it("the fee tier is read at confirm: a dealer sender gets the dealer rate in airtime_amount", ...)
```

- [ ] **Step 3: Run** `npx vitest run lib/ussd/handlers/airtime.confirm-sms.test.ts` — sms tests FAIL.
- [ ] **Step 4: Implement** as in Interfaces; the sms branch follows `bundles.ts` (`if (channel !== 'sms') await wait`, the sms OTP branch sends nothing).
- [ ] **Step 5: Run** `npx vitest run lib/ussd lib/whatsapp-bot` — PASS, characterisation unchanged.
- [ ] **Step 6: Commit** `feat(ussd): airtime confirm for text (MoMo only, returns order id and amounts)`.

---

### Task 4: Text switches for airtime and vouchers

Fresh reviewer mandatory (gates a money path; admin API).

**Files:**
- Modify: `lib/text-to-buy/settings.ts`, `lib/text-to-buy/admin-validate.ts`, `app/api/admin/text-to-buy/route.ts`, `app/admin/text-to-buy/_components/{api.ts,format.ts,SettingsTab.tsx}`
- Test: `lib/text-to-buy/settings.test.ts`, `admin-validate.test.ts`, `app/api/admin/text-to-buy/route.test.ts` (extend)

**Interfaces:**
- Produces: `TtbSettings` gains `airtimeEnabled: boolean` (`ttb_airtime_enabled`) and `resultsCheckerEnabled: boolean` (`ttb_results_checker_enabled`), both in `TTB_SETTING_KEYS`, `TTB_DEFAULTS` false, loaded as `raw.<key> === true`, `RULES` `{ kind: "bool" }`. PUT: turning either on (or `mainEnabled`) without `confirm: true` → 400 `confirm_required`. `FIELD_LABELS`: "Airtime by text", "Checkers by text". No seed row: the first save creates the key.

Settings tab: two switches with helper text. Airtime: "Customers text e.g. airtime 10. Uses the airtime fees, limits and per-network switches; a network off there stays off here." Checkers: "Customers text e.g. 2 wassce. Uses checker prices, bulk price and stock; a board off there stays off here. PINs go to the number that texted." Turning one on opens the same confirm dialog pattern as the Overview main switch ("Customers can buy <service> by text from the main number. Do a supervised paid test first."), then saves with `confirm: true`. `IntField`/`Form` in `SettingsTab.tsx` exclude the two new boolean fields.

- [ ] **Step 1: Failing tests:** defaults false; `{ value: "true" }` and `{ value: 1 }` stay false; `{ value: true }` turns each on; validation rejects non-booleans; PUT `{ airtimeEnabled: true }` without confirm → 400 `confirm_required` and nothing written; with confirm → written as `{ "value": true }` and one alert naming `ttb_airtime_enabled` only; PUT turning it off needs no confirm.
- [ ] **Step 2: Run** `npx vitest run lib/text-to-buy/settings.test.ts lib/text-to-buy/admin-validate.test.ts app/api/admin/text-to-buy` — FAIL.
- [ ] **Step 3: Implement.** `npx tsc --noEmit` must be clean (`RULES` is a `Record<TtbSettingField, Rule>`).
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(text-to-buy): airtime and checker text switches (default off)`.

---

### Task 5: Reading airtime texts (rules and AI)

Fresh reviewer mandatory (the AI money fence).

**Files:**
- Modify: `lib/text-to-buy/types.ts`, `lib/text-to-buy/parse-rules.ts`, `lib/text-to-buy/ai-reader.ts`, `lib/text-to-buy/inbound-steps.ts` (narrowing only)
- Test: `lib/text-to-buy/parse-rules.test.ts`, `lib/text-to-buy/ai-reader.test.ts` (extend)

**Interfaces:**
- Produces:

```ts
// types.ts
export type ExamBoardWord = "WASSCE" | "BECE" | "NOVDEC"
export type OrderRead =
  | { kind: "order"; service: "data"; sizeMb: number; networkHint: NetworkHint | null; recipient: string | null; bare: boolean }
  | { kind: "order"; service: "airtime"; amountGhs: number; networkHint: AirtimeNetwork | null; recipient: string | null }
  | { kind: "order"; service: "results_checker"; board: ExamBoardWord | null; quantity: number }   // Task 8 uses it
// ReadResult = OrderRead | price_query (service "data" only) | keyword | ask | not_order | unknown
```

Rules (`parseOrderText`), tried in this order: airtime grammar, voucher grammar (Task 8), data grammar. Airtime needs exactly one airtime word (`airtime`, `credit`, `recharge`, `topup`, `top up`) AND one amount (digits, at most 2 decimals, optional `ghs`/`ghc`/`gh` prefix or `ghs`/`cedi`/`cedis` suffix), optional network word (`mtn`, `telecel`, `voda`, `vodafone`, `airteltigo`, `at`; `ishare`/`bigtime` are not airtime words and make it unknown), optional one Ghana number. Any `gb`/`g`/`gig`/`gigs`/`mb`/`data` in the text makes the airtime grammar fail (it then falls to the data grammar or unknown). Recipient as in Stage 1 (local form).

AI (`propose_sms_order`) gains `service: "data" | "airtime" | "results_checker"` (default data), `amount_ghs` (number, "the airtime amount in cedis exactly as the customer typed it; never a price"), `board` (enum of three), `quantity` (integer). System prompt adds: "A number with no airtime or currency word is a data size in GB."; "Never state a price; amount_ghs is only the airtime amount the customer typed."; "Questions must not contain numbers." Re-checks in `mapToolInput` for `service: "airtime"`:
1. `amount_ghs` finite, > 0, at most 2 decimals, else ask "How much airtime do you want?".
2. The amount appears as a number token in the current text or an earlier user turn (Ghana phone numbers removed first), and that token is not followed by optional space and `gb|g|gig|gigs|mb|data`; else ask "How much airtime do you want?".
3. If neither the text nor an earlier user turn has an airtime word or a currency word (`ghs|ghc|cedi|cedis|₵`), the read is re-made as the data read Stage 1 would give for `size_gb = amount_ghs` (then the data checks apply).
4. Recipient re-checked exactly as data; network mapped to `AirtimeNetwork` (`AT-iShare`/`AT-BigTime` → `AT`).
A `price_query` whose `service` is not data → `not_order` (no airtime or voucher price answers).

- [ ] **Step 1: Failing tests.**

```ts
const air = (amountGhs: number, networkHint: any = null, recipient: string | null = null) =>
  ({ kind: "order", service: "airtime", amountGhs, networkHint, recipient })
it.each([
  ["airtime 10", air(10)], ["10 airtime", air(10)], ["airtime ghs10", air(10)], ["airtime GHS 10", air(10)],
  ["airtime 10 cedis", air(10)], ["airtime 10.50", air(10.5)], ["credit 5", air(5)], ["topup 20", air(20)], ["top up 20", air(20)],
  ["recharge 5 telecel", air(5, "Telecel")], ["mtn airtime 10", air(10, "MTN")], ["airtime 10 at", air(10, "AT")],
  ["airtime 10 0200000102", air(10, null, "0200000102")],
])("airtime: %s", (t, e) => expect(parseOrderText(t)).toEqual(e))
it.each(["10", "10gb", "10 gigs", "at 10", "mtn 10"])("still data: %s", (t) =>
  expect(parseOrderText(t)).toMatchObject({ kind: "order", service: "data" }))
it("bare 10 is still 10GB and bare", () => expect(parseOrderText("10")).toMatchObject({ service: "data", sizeMb: 10000, bare: true }))
it.each(["airtime 10gb", "airtime 10 data", "airtime", "airtime 10.555", "airtime 10 20", "airtime 10 ishare", "airtime 10 0200000102 0200000103"])
  ("unknown: %s", (t) => expect(parseOrderText(t)).toEqual({ kind: "unknown" }))
```

  AI (inject `createMessage`): "pls buy me 10 cedis credit" + `{intent:"order", service:"airtime", amount_ghs:10}` → airtime 10; "10gb" + `{service:"airtime", amount_ghs:10}` → ask "How much airtime do you want?"; "airtime 10gb" + same → ask; "send 10 data" + same → ask; "send me 10" + same → data `sizeMb: 10000`; "airtime 5" + `amount_ghs: 50` → ask; amount from an earlier user turn is accepted; recipient not in the text → ask "Which number should receive it?"; `{intent:"ask", question:"How much? e.g. 10"}` → `notUnderstoodReply()`; `{intent:"price_query", service:"airtime"}` → `not_order`. Replace the Stage 1 schema test (`ai-reader.test.ts` line 167) with: the only schema property whose name matches `/price|amount|cost/i` is `amount_ghs`, and its description contains "never a price".
- [ ] **Step 2: Run** `npx vitest run lib/text-to-buy/parse-rules.test.ts lib/text-to-buy/ai-reader.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Narrow `pickedOption`, `rebuildFromLastOrder` and the lane on `read.service === "data"` where they use `sizeMb`/`bare`. Until Task 6 an airtime read reaches the lane with no airtime adapter, so it takes the not-understood path.
- [ ] **Step 4: Run** `npx vitest run lib/text-to-buy` — PASS, golden snapshot unchanged.
- [ ] **Step 5: Commit** `feat(text-to-buy): read airtime texts (rules and AI, with code-side re-checks)`.

---

### Task 6: Airtime adapter, replies, lane wiring, notices and Try-it

Fresh reviewer mandatory (money).

**Files:**
- Create: `lib/text-to-buy/services/airtime.ts`, `lib/text-to-buy/services/airtime.test.ts`, `lib/text-to-buy/handle-inbound.services.test.ts`
- Modify: `lib/text-to-buy/replies.ts`, `lib/text-to-buy/store.ts` (`LastOrder`), `lib/text-to-buy/inbound-steps.ts`, `lib/text-to-buy/services/index.ts`, `lib/text-to-buy/handle-inbound.ts`
- Test: also `replies.test.ts`, `store.test.ts`, `notify.services.test.ts` (extend)

**Interfaces:**
- Consumes: `confirmAirtimeByText` (Task 3); `detectAirtimeNetwork`, `isAirtimeEnabled`, `getAirtimeLimits`, `airtimeBaseFeeRate`, `splitInclusive`, `AirtimeNetwork` (`lib/airtime-pricing.ts`); `resolveDialer` (`lib/ussd/resolve-dialer.ts`); `dialerGetsDealerRate` (`lib/sub-agents/dealer-rates.ts`); `detectNetworkWithMap`, `ghanaSignificant`, `normalizeGhanaPhone` (`lib/phone-format.ts`); `getPrefixValidationConfig`; `isRecipientBlocked`; `paystackProviderFromPhone`; `classifyStatusOrder`; `orderRowFor`.
- Produces:

```ts
// services/airtime.ts
export type AirtimeOffer = ServiceOffer & { service: "airtime"; network: AirtimeNetwork; amountGhs: number }
export function airtimeAdapter(deps?: { confirm?: typeof confirmAirtimeByText }): ServiceAdapter<AirtimeOffer>
export function airtimeSession(senderLocal: string, o: AirtimeOffer): USSDSession
  // { step: "AIRTIME_CONFIRM", dialingPhone: "+233" + significant, airtimeNetwork, airtimeRecipient, airtimeAmount } and nothing else
// services/index.ts: AdapterDeps gains airtimeConfirm?: typeof confirmAirtimeByText; makeAdapters registers airtime
// store.ts
export type LastOrder =
  | { sizeMb: number; network: string; recipient: string }                               // data: the Stage 1 shape, unchanged
  | { service: "airtime"; amountGhs: number; network: string; recipient: string }
  | { service: "results_checker"; board: ExamBoardWord; quantity: number }               // Task 9 uses it
// replies.ts
export function amountToken(n: number): string     // 10 -> "10", 10.5 -> "10.50"
export function airtimeQuoteReply(i: { networkLabel: string; recipientLocal: string; payGhs: number; getsGhs: number; feeOnTop: boolean; payerNetwork: PayerNetwork }): string
export function airtimeGiftDeliveredReply(size: string, recipientLocal: string): string
export function delayedReply(): string
export function airtimeLimitsReply(min: number, max: number): string
export function airtimeOffReply(networkLabel: string): string
export function airtimeWrongNumberReply(): string
export function airtimeNetworkQuestion(): string
export function placedNeutralReply(): string
export function notUnderstoodReply(s?: { airtime?: boolean; resultsChecker?: boolean }): string   // no argument = the Stage 1 string
// helpReply takes the same optional argument
```

Exact copy:

```ts
airtimeQuoteReply(..10, 9.52, feeOnTop false, MTN) -> "MTN airtime for 0200000102: you pay GHS 10.00, they get GHS 9.52. Approve the MoMo prompt now. No prompt? Dial *170#, 6, 3."
// feeOnTop: "you pay GHS 10.00 + MoMo charge, they get GHS 9.52."   tip as quoteReply; parts dropped from the end
airtimeGiftDeliveredReply("airtime 10", R) -> "Airtime sent to 0200000102. Text airtime 10 to buy again."
delayedReply()            -> "We received your payment. Delivery is delayed; we are on it and will update you."
airtimeLimitsReply(1,500) -> "Airtime is GHS 1 to 500. Text e.g. airtime 10."
airtimeOffReply("MTN")    -> "MTN airtime is not available now."
airtimeWrongNumberReply() -> "That phone number is not valid. Text e.g. airtime 10 0241234567."
airtimeNetworkQuestion()  -> "Which network is that number on? 1) MTN 2) Telecel 3) AT"
placedNeutralReply()      -> "Your order was placed. Approve the MoMo prompt if you get one."
notUnderstoodReply({ airtime: true, resultsChecker: true }) ->
  "Text 5GB for data, airtime 10 for airtime, or 2 wassce for checkers. For someone else add the number: 5GB 0241234567. Text PRICES for the list."
// airtime only: "Text 5GB for data or airtime 10 for airtime. For someone ..."; checkers only: "Text 5GB for data or 2 wassce for checkers. For someone ..."
```

Airtime `resolve` (spec 5.2), in order: recipient = `read.recipient` or the sender; `gift` = differs. Network = `detectNetworkWithMap(recipient, map)` (admin map first), else `detectAirtimeNetwork(recipient)`, else `read.networkHint`, else refusal `asked` with `airtimeNetworkQuestion()` and `pending` choices `[MTN, Telecel, AT]` whose reads are this read with `networkHint` set (remember true). A hint that disagrees with a detected network: no typed recipient → `asked` "Which <hint> number should receive it?" (remember); typed recipient → `asked` `airtimeWrongNumberReply()`. MTN + `isRecipientBlocked("MTN", recipient)` → `asked` `airtimeWrongNumberReply()`. `!isAirtimeEnabled(network)` → `unavailable` `airtimeOffReply`. Outside `getAirtimeLimits()` → `unavailable` `airtimeLimitsReply(min, max)`. Preview: `splitInclusive(amount, await airtimeBaseFeeRate(network, dialerGetsDealerRate(await resolveDialer("+233" + significant))))`. `size` = `"airtime " + amountToken(amount)`; `previewGhs` = amount; `previewDeliversGhs` = toDeliver; `paystackProvider` = the sender's, else the network's (`mtn`/`vod`/`tgo`). Any thrown read → `unavailable` with the fixed text "Airtime is not available now." `place` = `confirm("sms:" + messageId, airtimeSession(sender, offer))` → `{ orderId, amountGhs: r.amount, deliversGhs: r.delivers }`. `quote` uses `a.amountGhs` and `a.deliversGhs` (never the preview after a real placement). `notPlacedReply` = `airtimeOffReply(network)`. Notices: `unpaid` = `unpaidReply(size)`; `delivered` = gift ? `airtimeGiftDeliveredReply(size, recipient)` : null; `paidNotDelivered` = `delayedReply()`. `textEnabled` = `s.airtimeEnabled`. `readOrder` = `orderRowFor(db, "airtime_orders", id)`; `classify` = `classifyStatusOrder`; `statusOf`: waiting → awaiting_payment (failed when the link is closed), payment_failed → failed, paid/delivery_failed → processing, delivered → delivered, refunded → failed.

Lane: an order whose amounts are unusable = `amountGhs` not finite, or service airtime and `deliversGhs` not finite → the existing alert path, reply `placedNeutralReply()` for non-data. `notUnderstoodReply`/`helpReply` get `{ airtime: settings.airtimeEnabled, resultsChecker: settings.resultsCheckerEnabled }`. `rebuildFromLastOrder` handles the airtime `LastOrder`; `parseLastOrder` accepts the three shapes and still accepts stored Stage 1 rows.

- [ ] **Step 1: Failing tests.**
  - `replies.test.ts`: each exact string above; worst case (`Telecel`, pay and get `9999.99`, feeOnTop, TELECEL payer) is one segment and keeps both amounts, the recipient and "Approve the MoMo prompt now."; `notUnderstoodReply()` unchanged.
  - `services/airtime.test.ts` (mock the pricing, dialer, prefix and verification modules): own-number `airtime 10` → recipient = sender, `gift: false`, network from the sender; gift → network from the recipient; admin map wins over the static table; both unknown with no hint → the network question with 3 choices, and picking `2` resolves Telecel; hint mismatch with and without a typed number; MTN blocked; per-network switch off → `airtimeOffReply`; below min and above max → `airtimeLimitsReply(1, 500)`; customer rate 5 → previewDelivers 9.52, dealer → `airtimeBaseFeeRate(network, true)`; `getUssdServiceVisibility` is never called; `airtimeSession` has no `airtimeCashbackPay`, `userId` or `walletBalance`; `place` passes session id `sms:<id>`.
  - `handle-inbound.services.test.ts` (fake db + injected adapters): switch off → `airtime 10` gives outcome `not_order`, the data `resolve` and every `confirm` never called (Review Focus 2); switch on → `place` once, reply equals `airtimeQuoteReply` built from the PLACED amounts when they differ from the preview (preview 9.52, placed delivers 9.70) (Review Focus 3); the link row has `service: "airtime", order_table: "airtime_orders", size: "airtime 10"`; an open data order blocks an airtime order (`openOrderReply`) and `promptsUnpaid` counts it; dry run returns the quote from the preview and calls neither `place` nor `linkOrder`; `again` after an airtime order rebuilds the same amount, network and recipient; `yes` after an unpaid airtime link rebuilds it; `status` reads `airtime_orders`; placed with `delivers` undefined → `placedNeutralReply()` and the alert.
  - `notify.services.test.ts`: airtime gift completed → `airtimeGiftDeliveredReply`; own-number completed → closed, no SMS; paid 30 minutes not completed → `delayedReply()`, and no reply text sent for airtime contains "No need to pay again" (Review Focus 5); status `failed` after payment → `delayedReply()`; `refunded` → closed, no SMS; `pending_payment` past the window → `unpaidReply("airtime 10")`.
- [ ] **Step 2: Run** `npx vitest run lib/text-to-buy` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run lib/text-to-buy lib/ussd` — PASS, golden snapshot unchanged.
- [ ] **Step 5: Commit** `feat(text-to-buy): airtime by text (adapter, replies, notices, dry run)`.

---

### Task 7: Voucher confirm path for text (`sms` channel)

Fresh reviewer mandatory (money).

**Files:**
- Modify: `lib/ussd/handlers/results-checker.ts`
- Create: `lib/ussd/handlers/results-checker.confirm-sms.test.ts`
- Test: also `results-checker.gateway.test.ts` (green, untouched)

**Interfaces:**
- Produces:

```ts
/**
 * Text-to-Buy: confirm a staged voucher session as channel "sms". Re-checks board and stock and re-prices
 * (calculateRCPrice, applyBulk true) exactly as handleRcConfirm. MoMo only, no 3 s wait, no OTP SMS, never setSession.
 * Session needs: dialingPhone (+233...), rcBoard, rcQty.
 */
export async function confirmRcByText(sessionId: string, session: USSDSession): Promise<UzoResponse>
// success: orderId = results_checker_orders id, amount = total_paid as inserted. Every refusal: no orderId.
```

`handleRcConfirm` keeps its signature; both wrap one private `confirmRc(input, sessionId, session, channel: 'ussd' | 'whatsapp' | 'sms', opts)`. For `sms`: the wallet-eligible branch (`RC_PAYMENT_METHOD`) is skipped whatever the balance; none of the `setSession` calls run (including the one before order creation and the one after it); `createRcOrderAndChargeMomo` (private, channel widened) skips the 3 s wait and the OTP SMS and returns `{ ...end(...), orderId, amount: total }`. Row `channel` stays `"ussd"`; `customer_phone` stays the sender's local number (PINs go there); `metadata.source` / `payment_type` unchanged.

- [ ] **Step 1: Characterisation on untouched code** for `ussd` and `whatsapp` (mocks as `results-checker.gateway.test.ts`): response, insert payload, `setSession` calls, surface after the timer, `send_otp` split, the wallet menu for a funded dialer, the out-of-stock refusal. Run: PASS.
- [ ] **Step 2: Failing sms tests:** returns `orderId` and `amount` = inserted `total_paid`; the amount is the RE-PRICED total when `calculateRCPrice` returns a different total than the session's `rcTotal` (Review Focus 3); funded registered sender → no wallet step, charge started; `sms_order` surface with `runNoWait`; `setSession` never called; `send_otp` → `otp_required`, no `sendSMS`/WhatsApp; charge throws → `failed`/`failed`; board disabled or `getAvailableCount < qty` → no row, no `orderId`; `customer_phone` is the sender's local number and `channel` is `"ussd"`.
- [ ] **Step 3: Run** — sms tests FAIL. **Step 4: Implement.** **Step 5: Run** `npx vitest run lib/ussd lib/whatsapp-bot` — PASS.
- [ ] **Step 6: Commit** `feat(ussd): voucher confirm for text (MoMo only, returns order id and total)`.

---

### Task 8: Reading voucher texts (rules and AI)

Fresh reviewer mandatory (the AI money fence).

**Files:**
- Modify: `lib/text-to-buy/parse-rules.ts`, `lib/text-to-buy/ai-reader.ts`
- Test: `parse-rules.test.ts`, `ai-reader.test.ts` (extend)

**Interfaces:** Produces the `results_checker` member of `OrderRead` (Task 5). Rules: a board word (`wassce`, `bece`, `novdec`, `nov dec`, `nov/dec`) and/or a checker word (`checker`, `checkers`, `voucher`, `vouchers`), optional leading quantity (1 to 3 digits, optional `x`). No quantity → 1, except a plural checker word with no number → unknown (the AI asks). No board and no quantity other than 1 → board null. Any Ghana number, network word or data unit in the text → unknown. The rules grammar is tried after airtime and before data.

AI re-checks for `service: "results_checker"`: `board` must be one of the three AND a board word must appear in the current text or an earlier user turn, else ask "Which checker: WASSCE, BECE or NOVDEC?"; `quantity` must be an integer 1 to 100 that is 1, or appears as digits, or as a word `one`..`ten`, in the customer's text, else ask "How many checkers do you want?"; any `recipient` is dropped (PINs go to the sender).

- [ ] **Step 1: Failing tests.**

```ts
const rc = (board: any, quantity: number) => ({ kind: "order", service: "results_checker", board, quantity })
it.each([
  ["2 wassce checkers", rc("WASSCE", 2)], ["bece voucher", rc("BECE", 1)], ["3 novdec", rc("NOVDEC", 3)],
  ["wassce", rc("WASSCE", 1)], ["2x bece", rc("BECE", 2)], ["nov dec checker", rc("NOVDEC", 1)],
  ["checker", rc(null, 1)], ["5 checkers", rc(null, 5)],
])("voucher: %s", (t, e) => expect(parseOrderText(t)).toEqual(e))
it.each(["wassce checkers", "2 wassce 0200000102", "2 wassce mtn", "2gb wassce"])("unknown: %s", (t) =>
  expect(parseOrderText(t)).toEqual({ kind: "unknown" }))
it("bare 3 is still data", () => expect(parseOrderText("3")).toMatchObject({ service: "data", sizeMb: 3000 }))
```

  AI: "i need two wassce checker" + `{service:"results_checker", board:"WASSCE", quantity:2}` → rc WASSCE 2; "checkers pls" + board `BECE` → ask "Which checker: WASSCE, BECE or NOVDEC?"; "wassce checkers" + quantity 5 → ask "How many checkers do you want?"; recipient given → dropped.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run lib/text-to-buy` — PASS.
- [ ] **Step 5: Commit** `feat(text-to-buy): read voucher texts (rules and AI)`.

---

### Task 9: Voucher adapter, replies, lane wiring and notices

Fresh reviewer mandatory (money; PIN handling).

**Files:**
- Create: `lib/text-to-buy/services/results-checker.ts`, `lib/text-to-buy/services/results-checker.test.ts`
- Modify: `lib/text-to-buy/replies.ts`, `lib/text-to-buy/services/index.ts`, `lib/text-to-buy/inbound-steps.ts`
- Test: also `replies.test.ts`, `handle-inbound.services.test.ts`, `notify.services.test.ts`

**Interfaces:**
- Consumes: `confirmRcByText` (Task 7); `buildRcBoardOptions` (`lib/ussd/handlers/results-checker.ts`); `isExamBoardEnabled`, `getAvailableCount`, `getMaxQuantity`, `calculateRCPrice`, `ExamBoard` (`lib/results-checker-service.ts`).
- Produces:

```ts
export type VoucherOffer = ServiceOffer & { service: "results_checker"; board: ExamBoardWord; quantity: number }
export function resultsCheckerAdapter(deps?: { confirm?: typeof confirmRcByText; boards?: typeof buildRcBoardOptions }): ServiceAdapter<VoucherOffer>
export function voucherSession(senderLocal: string, o: VoucherOffer): USSDSession   // { step: "RC_CONFIRM", dialingPhone, rcBoard, rcQty } only
// AdapterDeps gains rcConfirm?: typeof confirmRcByText
// replies.ts
export function voucherQuoteReply(i: { board: ExamBoardWord; quantity: number; amountGhs: number; feeOnTop: boolean; payerNetwork: PayerNetwork }): string
export function voucherOffReply(board: ExamBoardWord | null): string
export function voucherMaxReply(board: ExamBoardWord, cap: number): string
export function voucherBoardQuestion(boards: ExamBoardWord[]): string
```

Exact copy:

```ts
voucherQuoteReply(WASSCE, 2, 30, false, MTN) -> "2 WASSCE checkers, GHS 30.00. Approve the MoMo prompt now. PINs come by SMS to this number. No prompt? Dial *170#, 6, 3."
// quantity 1: "1 WASSCE checker, GHS 15.00. Approve the MoMo prompt now. PIN comes by SMS to this number. ..."; feeOnTop: "GHS 30.00 + MoMo charge"
voucherOffReply("BECE") -> "BECE checkers are not available now."      voucherOffReply(null) -> "Checkers are not available now."
voucherMaxReply("WASSCE", 5) -> "You can buy up to 5 WASSCE checkers per order."
voucherBoardQuestion(["WASSCE","BECE","NOVDEC"]) -> "Which checker? 1) WASSCE 2) BECE 3) NOVDEC"
```

`resolve` (spec 5.2): board null → `buildRcBoardOptions()`: none → `unavailable` `voucherOffReply(null)`; one → use it; several → `asked` `voucherBoardQuestion` with `pending` choices (remember). Board given: `!isExamBoardEnabled` or `getAvailableCount === 0` → `unavailable` `voucherOffReply(board)`; `quantity > min(available, getMaxQuantity())` → `unavailable` `voucherMaxReply(board, cap)`. Price: `calculateRCPrice({ examBoard: board, quantity, applyBulk: true }).totalPaid` → `previewGhs`. Recipient = sender, `gift: false`; `size` = `"<qty> <board lowercase>"` (e.g. `"2 wassce"`); `paystackProvider` = the sender's, else `"mtn"` (fee-on-top lookup only; the handler refuses a non-MoMo sender). Any throw → `unavailable` `voucherOffReply(null)`. `quote` uses the placed `amountGhs`. `notPlacedReply` = `voucherOffReply(board)`. Notices: `unpaid` = `unpaidReply(size)`; `delivered` → always null; `paidNotDelivered` = `delayedReply()`. `readOrder` = `orderRowFor(db, "results_checker_orders", id)`; `classify` = `classifyStatusOrder`; `statusOf` as airtime. `textEnabled` = `s.resultsCheckerEnabled`. The adapter module imports nothing from `lib/sms-service.ts` or `lib/results-checker-notification-service.ts`: PINs stay on `deliverVouchers`.

- [ ] **Step 1: Failing tests.**
  - `replies.test.ts`: exact strings; worst case `NOVDEC`, quantity 50, `9999.99`, feeOnTop → one segment and keeps the amount and "PINs come by SMS to this number."
  - `services/results-checker.test.ts`: board null with three boards → question, `2` picks BECE; one board in stock → used; none → `voucherOffReply(null)`; board off; stock 0; quantity above stock and above max quantity (cap = the smaller); `calculateRCPrice` called with `applyBulk: true` and the bulk total is the preview; recipient = sender; the module source contains neither `deliverVouchers` nor `sms-service` (read the file text in the test).
  - `handle-inbound.services.test.ts`: switch off → `2 wassce` is `not_order`, nothing placed; on → link `service: "results_checker", order_table: "results_checker_orders", size: "2 wassce", gift: false, recipient: <sender>`; the quote amount is the placed total when it differs from the preview; no lane reply contains `PIN:`.
  - `notify.services.test.ts` (Review Focus 5): completed voucher link → closed with `delivered_at`, `reply` never called; paid with status `pending` (stock ran out) at 30 minutes → `delayedReply()`; `failed` after payment → `delayedReply()`; `expired`/`expired` → unpaid notice and closed.
- [ ] **Step 2: Run** `npx vitest run lib/text-to-buy` — FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run lib/text-to-buy lib/ussd` — PASS.
- [ ] **Step 5: Commit** `feat(text-to-buy): checker vouchers by text (adapter, replies, notices)`.

---

### Task 10: Admin per-service counts and the runbook

Standard reviewer (no money path; read-only counts and docs).

**Files:**
- Modify: `lib/text-to-buy/store.ts`, `lib/text-to-buy/fake-db.test-helper.ts`, `app/api/admin/text-to-buy/route.ts`, `app/admin/text-to-buy/_components/{api.ts,OverviewTab.tsx}`, `docs/text-to-buy/runbook.md`
- Test: `lib/text-to-buy/store-admin.test.ts`, `app/api/admin/text-to-buy/route.test.ts` (extend)

**Interfaces:**

```ts
/** Main-line links created since `from`, per service: prompts = links, paid = paid_at not null, delivered = delivered_at not null. Count queries only (head: true); no new database function. */
export async function serviceCountsToday(db: SupabaseClient, from: Date): Promise<Record<Service, { prompts: number; paid: number; delivered: number }>>
// GET /api/admin/text-to-buy adds: services: Record<Service, { prompts: number; paid: number; delivered: number }>
```

The fake learns `.not(col, "is", null)`. Overview card "By service today": one row per service (Data, Airtime, Checkers) with prompts, paid, delivered and an "Off" badge for a service whose text switch is off.

Runbook: add a "Stage 2: airtime and checkers" part with: what it is (texts customers send, the quote they get, PINs by SMS to the texting number); the two switches and that the per-network airtime switches and per-board checker switches still apply; switch-on order (one service at a time, each only after a supervised paid test on MTN, Telecel and AT for airtime and on one board for checkers); supervised test script (own-number `airtime 1`, gift airtime to a second phone, unknown-prefix question, below/above limits, `10gb` stays data, `2 wassce` with bulk price, out of stock, ignored prompt, late approval) with the expected SMS for each; accepted gaps in plain words: a completed voucher order whose PIN SMS never arrives gets no lane follow-up (check the order and the SMS log), voucher stock is not reserved so a paid order can wait at `pending` (customer gets the delay notice; an admin resolves it), the webhook's own SMS (airtime "payment received", voucher PINs) bypass the lane's reply caps and sender ID, admin "Failed" on a paid airtime order credits a registered payer's wallet, Telecel on Paystack needs a one-time code the text lane cannot collect (keep `sms_order` on Hubtel), caps are shared across services, rows stay `channel = 'ussd'`; an OWNER check before switching vouchers on: run read-only `select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'results_checker_orders'::regclass` and record whether `expired` is allowed (the lane closes its own link at 30 minutes either way); rollback = switch off, nothing to undo in the database; announcement (labelled **Hold until launch**), with how-to-use steps:

```
New: buy airtime and checkers by text!
Text the main number:
- airtime 10  (GHS 10 airtime for your own number)
- airtime 10 0241234567  (for someone else)
- 2 wassce  (2 WASSCE checkers; also bece, novdec)
Approve the MoMo prompt with your PIN. Checker PINs come by SMS to the number you texted from.
```

- [ ] **Step 1: Failing tests:** counts per service from seeded links (only `line = 'main'`, only since `from`); GET returns `services` for a non-empty and an empty table; 403 for non-admins (existing gate).
- [ ] **Step 2: Run** `npx vitest run lib/text-to-buy/store-admin.test.ts app/api/admin/text-to-buy` — FAIL. **Step 3: Implement** the store function, route field and Overview card. **Step 4: Run** — PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: Look at it** at 500px and 1280px (headless Chrome from PowerShell, admin login required); if no admin session is available, say so in the report and leave the check to the owner.
- [ ] **Step 6: Write the runbook part.** **Step 7: Commit** `feat(text-to-buy): per-service overview counts; stage 2 runbook`.

---

### Task 11: Final verification and stop

**Files:** none new.

- [ ] **Step 1: Full suite:** `npm run test:run`. Every failure must be one of the 12 known (Global Constraints) or the named load-flaky files, each re-run green in isolation; any other failure is yours. Revert a line-ending-only `uzo-golden.test.ts.snap` change.
- [ ] **Step 2: Types:** `npx tsc --noEmit` — exactly the Task 1 baseline list.
- [ ] **Step 3: Real build, from PowerShell** with the repo's placeholder env: `npm run build` — exit 0.
- [ ] **Step 4: Sweep** the branch diff (`git diff origin/main...HEAD`): no `console.` call in `lib/text-to-buy/`, the two handler sms paths or the admin route that prints a text, body, sender, phone, amount or PIN variable; no `sed -i`, `TODO`, `FIXME`; no file under `.superpowers/`; no migration file; `lane-golden` snapshot identical to Task 1's commit.
- [ ] **Step 5: Stop and report.** Do not merge, push, apply SQL, change settings or env vars. Report commits, test counts with every failure attributed, the build result, what was and was not checked in a browser, and the open launch gates (owner's `pg_get_constraintdef` check, supervised paid tests per network and board, the announcement held until launch). The owner then decides on the whole-branch review (opus) and the switch-on.

---

## Self-review

- **Spec coverage:** every design section maps to a task (map below). Section 6 items: 6.1 order-link trap → Tasks 1, 2; 6.2 no order id → Tasks 3, 7; 6.3 wallet detour → Tasks 3, 7; 6.4 fee model / quote from the row → Tasks 3, 6; 6.5 channel stays `ussd` → Tasks 3, 7 (insert assertions); 6.6 PIN SMS → Task 9; 6.7 voucher stock → Task 9 (notifier `pending` test) and Task 10 (runbook); 6.8 webhook SMS bypass → Task 10; 6.9 Telecel on Paystack → Task 10; 6.10 fake learns tables → Task 1; 6.11 RC `expired` → Task 2 (classified either way) and Task 10 (owner check). Reply wording for delay notices → Task 6 (`delayedReply`), reused in Task 9. Shared caps → Task 6 test.
- **Step scan:** every task has failing tests with named cases, a run-to-fail command, an implement step with exact signatures, a run-to-pass command and a commit. No placeholders.
- **Type consistency:** `Service`/`OrderTable`/`ORDER_TABLE_OF` (Task 1) are used by `linkOrder`, `orderRowFor`, `adapterForLink`, `serviceCountsToday`. `OrderRead` becomes a union in Task 5 and the results-checker member is filled in Task 8. `PlaceResult.deliversGhs` comes from `confirmAirtimeByText`'s `delivers`. `LastOrder` union (Task 6) covers all three services; Stage 1 rows parse unchanged. `classifyStatusOrder` serves both new adapters. `feeOnTop` dep now takes `ServiceOffer`.
- **Review Focus coverage:** 1 → Task 1 (store), Task 2 (notifier); 2 → Task 5, Task 6; 3 → Tasks 3, 6, 7, 9; 4 → Tasks 3, 7; 5 → Tasks 6, 9.
- **Proportion:** bodies are given only where the signature and tests do not decide the algorithm (status mapping, re-check order, resolve order, exact copy).

## Spec coverage map

| Design section | Tasks |
|---|---|
| 1 Intent, 2 Goals / non-goals / anti-goals | 5, 6, 8, 9 (anti-goal tests), Global Constraints |
| 3 Owner decisions | 3, 4, 6 (fee pricing, no cashback, MoMo only) |
| 4 Approach (one interface, data first) | 1, 2 |
| 5.1 Reading the text | 5 (airtime), 8 (vouchers) |
| 5.2 Resolving | 6 (airtime), 9 (vouchers), 4 (gating) |
| 5.3 Placing the order | 3, 7 (handlers), 6, 9 (adapters) |
| 5.4 Replies | 6, 9 |
| 5.5 Follow-ups | 2 (per-table notifier), 6, 9 (notices), 10 (accepted gap) |
| 5.6 Admin | 4 (switches), 6 (Try-it), 10 (counts) |
| 6 Constraints 1 to 11 | see Self-review |
| 7 Settings | 4 |
| 8 Data (no migration) | 1, 10 (counts from the link table), 11 (sweep) |
| 9 Abuse cases | 5 (amount confusion), 6 (spoofed sender, caps, tier), 9 (voucher exhaustion), 10 (admin Failed in runbook) |
| 10 Build order and rollout | task order 1-2, 3-6, 7-9, 10-11; runbook switch-on order |
| 11 Left to the builder | decided below |
| 12 Calls Claude made | 6 (prefix map first, no delivered notice own-number, reworded delay notice), 9 (PINs to sender), 3/7 (channel `ussd`), 10 (runbook) |

## Calls made while planning

1. **Adapter files:** `lib/text-to-buy/services/{types,classify,data,airtime,results-checker,index}.ts`; adapters are factories taking deps so the Stage 1 tests keep injecting `resolve`/`confirm` unchanged (the neutrality proof).
2. **`price_query` and `PRICES` stay outside the adapter, data only;** an AI price question about airtime or vouchers becomes `not_order` (the help text then names the services). The design rules out a price list; answering single prices was left open and is not built.
3. **Switch off = not understood.** An airtime or voucher text with its switch off takes the Stage 1 not-understood path (same reply rules), so a dark deploy announces nothing and can never fall through to a data order.
4. **Turning a service on needs `confirm: true`,** like the main switch, because it puts a new money path live.
5. **AI airtime without an airtime or currency word is re-read as data** (keeps "send me 10" = 10GB, design 5.1) instead of asking.
6. **Board and quantity must be written by the customer** (board word in the text; quantity 1, digits or one..ten), from the anti-goal "a MoMo prompt for a board or quantity the customer did not write". "wassce checkers" with no number goes to the AI, which asks.
7. **Vouchers ignore a typed number** (rules: unknown; AI: recipient dropped); PINs always go to the sender.
8. **The Stage 1 AI schema test is relaxed** to allow exactly `amount_ghs` (the design names that field; the old test banned any "amount" name). The prompt and the code re-check keep the fence.
9. **`metadata.source` / `payment_type` stay `ussd_airtime` / `ussd_results_checker`** for text orders (nothing reads them for routing; the link table identifies text orders, consistent with keeping `channel = 'ussd'`).
10. **Unknown link pair:** not closed, one admin alert per notifier run; a null `service`/`order_table` (fakes only) maps to the database defaults.
11. **Re-textable size tokens:** `airtime 10` (own and gift alike, as the design lists) and `2 wassce`; YES and AGAIN rebuild the full order, including a gift recipient, from `last_order`.
12. **Neutral reply when an order exists but its amounts are unusable** (`placedNeutralReply`) for the new services; data keeps its Stage 1 reply so the golden test stays identical.
13. **Both settings keys land in Task 4** (with the airtime work) so the Settings tab changes once; the vouchers switch reads nothing until Task 9 and defaults off.
