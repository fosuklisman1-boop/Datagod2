# Commission Cashback — Bots Plan 3: Main + Shop USSD (Uzo, Paystack) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cashback-priced **Network Plans**, **Pay Bills** and **airtime** to the two Uzo USSD menus. Payment is a Paystack MoMo prompt to the dialing number, and the shared bot engine confirms each order.
- Main menu: `lib/ussd`, served at `/api/ussd`.
- Shop menu: `lib/ussd-shop`, served at `/api/ussd-shop`.

**Architecture:**
- **Order creation.** The Plan 1 engine in `lib/bot-commission` creates every order (`botCreateBundleOrder`, `botCreateBillOrder`, `botVerifyBill`, `botCatalog`).
- **Charging.** A new in-process helper, `botChargeMomo`, writes the `wallet_payments` row (order type `cs_bundle` / `cs_bill`, opaque reference). It then fires `chargeMobileMoney` at the dialing number.
- **Confirmation.** Paystack's `charge.success` already reaches `settleStorefrontWebhook` → `confirmCommissionOrder`, which accepts `channel='bots'` rows. That path checks the amount to the pesewa, flips unpaid→paid with a guard, credits the shop share once and makes one Hubtel POST.
- **OTP.** Charges that need an OTP are finished on redial, through a Redis pointer.
- **Flows.** The Uzo flows are new modules under `lib/ussd/bots/` that reuse the pure screen helpers. The live Hubtel USSD code is not touched.

**Tech Stack:** Next.js 15, TypeScript, Supabase, Upstash Redis (USSD sessions), Paystack charge API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-cashback-bots-design.md`. The relevant sections are §2 shares, §3 pricing, §4 orders and payment, §5 menus and §9 errors.
- **Engine:** Plan 1 (`docs/superpowers/plans/2026-10-14-cashback-bots-1-engine.md`). Its carried items are in runbook "Commission Cashback — Bots (Plan 1)" step 4.
- **Pattern reference:** the Plan 2 flows `lib/ussd-hubtel/flows/network-plans.ts`, `pay-bills.ts` and `airtime-cashback.ts`. They are reviewed and live-dark.

## Global Constraints

### Surfaces
| Menu | `botSurface` | Shop | Buyer share | Shop share |
|---|---|---|---|---|
| Main USSD | `"ussd"` | none | `customer` | none |
| Shop USSD | `"ussd_shop"` | `shopId` (see below) | `storefrontCustomer` | `storefrontShop` |

- On shop USSD, `shopId` is the shop id the session already resolved through `resolveShopCode`. Only status `active` counts; fail closed when it is absent.
- Both menus use rail `"paystack"`.

### User decisions (2026-10-20)
- Hubtel USSD stays exactly as it is.
- The Uzo menus KEEP their current wording rule (the "Browse Services" rebrand): no `data` / `bundle` words on any screen.
  - Hubtel plan and category names are rewritten with a tested helper. Whole-word `data` becomes `Internet`, `bundle(s)` is stripped, and an empty result becomes `Plan`.
  - The menu entries are named **"Network Plans"** and **"Pay Bills"**.
- Network Plans and Pay Bills are paid by **MoMo only**, as a prompt to the dialing number. They have no wallet option.
- Airtime keeps today's wallet option for dealers on the main menu.

### Gate
- The new menus show only when all of these hold:
  - `cfg.enabled`, `cfg.surfaces.bots` and `cfg.botGroups[group]` are on (group `bundles` ⇒ Network Plans, `bills` ⇒ Pay Bills);
  - the new `ussd_service_visibility` flag `networkPlans` / `payBills` is on (default true).
- The config read fails closed, which hides the menus.
- With the switches off, every existing menu, screen, price and order row is byte-identical. Tests pin this.

### Price
- **Price shown = price charged = the engine's `payAmount`.** That is `quoteBots` on rail paystack, plus `botFees.paystack[group]` on top, rounded up.
- The confirm screen shows `Pay GHS x (was GHS y)` and what the buyer receives. The "(was …)" part appears only when the price is below face.

### Uzo screen conventions
- 160-char limit (`SCREEN_LIMIT` in `lib/ussd/menus.ts` and `lib/ussd-shop/menus.ts`).
- Network nicknames come from `lib/ussd/network-labels.ts`.
- Lists page the Uzo way, like `bundleMenu`: an `N. More...` item plus `0. Back`.
- Choices use the `1. Confirm` / `2. Cancel` style.
- Shop screens pass names through the existing `gsm7()`.
- Every new screen must fit without the `...` truncation clipping the footer. Tests assert the footer is present and the text does not end in `...`.

### Payment
- **Charge:** `botChargeMomo` charges `paid_amount` to the dialing number, using `paystackProviderFromPhone`. With no provider it shows "Payment not available for your number."
- **No OTP or direct-charge switches:** the dialing number is network-authenticated, so the storefront OTP and direct-charge admin switches do not apply on USSD. This is a ruling, and the runbook records it.
- **No product words leave our system:**
  - reference: opaque, from `newPaystackReference()`;
  - metadata: `{ source: "ussd_bot", bot_surface, order_type }`;
  - receipt purpose: `STOREFRONT_PAYMENT_PURPOSE`.
- **`wallet_payments` row:** `order_type` `cs_bundle` / `cs_bill`, `order_id`, `amount` = `paid_amount`, `fee` 0, `status` pending, `payment_type` `shop_order`, `shop_id`, and `email` = `botPaymentEmail()`.
- **Payer phone:** recorded with `recordPayerPhone` (`lib/refunds/payer-phone.ts`).
- **Per-phone cap:** 3 charges per hour, the same budget as the storefront `momodirect_phone` cap. It applies on top of the engine's pending-order caps.

### Order creation
- Bundle orders use `idempotencyKey` = the USSD session id.
- After `botCreate*Order`, read the row back. Charge it only when `status='pending' AND payment_status='unpaid'`.
- If the charge call throws, fail the order with the guarded patch, filtered on `payment_status='unpaid'`, `channel='bots'` and `status='pending'`. Never touch a paid order.

### Errors
| Case | Screen text |
|---|---|
| 409 | "Price changed. Please try again." |
| 429 | "Too many attempts. Please try later." |
| 403 | "Not available right now." |
| anything else | "Service unavailable. Please try again later." |

- Never show provider or DB error text.
- Never offer Ghana Water. The engine also refuses it on USSD surfaces.

### WhatsApp stays untouched
- The WhatsApp bot reuses `lib/ussd/handlers/airtime.ts` and `bundles.ts` through their `channel` param.
- Cashback in this plan applies only when `channel === "ussd"`. WhatsApp output stays byte-identical, and a test pins this. Plan 4 owns WhatsApp.

### No migration expected
- `bot_surface` already allows `ussd` / `ussd_shop` (0123), and `airtime_orders.channel` already has `ussd` / `ussd_shop`.
- If a task finds a CHECK that blocks it, STOP and report. Do not write a migration without the controller.

### Working rules
- Edit code with the Edit/Write tools only, never sed or heredocs. Put logic in `lib/`.
- Run a real `next build` before merging.
- Before pushing, check origin/local main for foreign commits, and chain `merge --ff-only && push`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **One payment, one effect.** One MoMo payment gives exactly one confirm, one shop share and one Hubtel POST. That includes a duplicate webhook, `/api/payments/verify` racing the webhook, and an OTP finished on redial (Task 1).
2. **Switches off means no change.** The main menu, the shop product menu, airtime screens, prices and rows, and every WhatsApp screen stay byte-identical (Tasks 2, 3, 6).
3. **Shop shares.** Shop USSD credits a share only to the resolved active shop. Main USSD never credits one (Tasks 3–5).
4. **No untraced orders.** Two cases must always leave a trace: a charge that fails to start, and an order the engine hands back that is not pending+unpaid. Neither may end as a chargeable order, or as a paid order that can't be delivered (Tasks 1, 4, 5).
5. **Screens.** No screen exceeds 160 chars or shows "data"/"bundle". Names from Hubtel are rewritten (Tasks 2, 4, 5).

---

### Task 1: Bot MoMo charge helper + OTP pointer

**Files:**
- Create: `lib/bot-commission/momo.ts`, `lib/bot-commission/momo.test.ts`
- Create: `lib/bot-commission/otp-pointer.ts`, `lib/bot-commission/otp-pointer.test.ts`
- Read, with no behaviour change:
  - `app/api/payments/initialize/route.ts` (momoDirect block ~L614-724)
  - `app/api/webhooks/paystack/route.ts` (~L874-894)
  - `lib/storefront-commission/confirm.ts` (`settleStorefrontPayment`)
  - `lib/storefront-commission/payment.ts`
  - `lib/refunds/payer-phone.ts`
  - `lib/paystack.ts` (`chargeMobileMoney`, `submitOtp`)
  - `lib/ussd/session.ts` (Redis client)

**Interfaces:**
- Produces:
  ```ts
  export type BotOrderType = "cs_bill" | "cs_bundle"
  export interface BotChargeInput { orderType: BotOrderType; orderId: string; botSurface: "ussd" | "ussd_shop"; shopId: string | null; dialingPhone: string }
  export type BotChargeResult =
    | { ok: true; reference: string; status: string }
    | { ok: false; code: "NOT_PAYABLE" | "NO_PROVIDER" | "RATE_LIMITED" | "CHARGE_FAILED"; message: string }
  export interface BotMomoDeps { /* db, chargeMobileMoney, submitOtp, recordPayerPhone, rateLimit, otpPointer, now */ }
  export async function botChargeMomo(d: BotMomoDeps, i: BotChargeInput): Promise<BotChargeResult>
  export function getBotMomoRuntime(): BotMomoDeps
  // otp-pointer.ts
  export interface BotOtpPointer { reference: string; orderType: BotOrderType; orderId: string; createdAt: string }
  export async function setBotOtpPointer(phone: string, p: BotOtpPointer): Promise<void>   // TTL 10 min, key by normalised local phone
  export async function peekBotOtpPointer(phone: string): Promise<BotOtpPointer | null>
  export async function clearBotOtpPointer(phone: string): Promise<void>
  export async function submitBotOtp(d: BotMomoDeps, p: BotOtpPointer, otp: string): Promise<{ ok: boolean }>
  ```
- Consumed by Tasks 4 and 5 (charge) and Task 6 (redial OTP).

- [ ] **Step 1: Write failing tests** in `momo.test.ts` with fake deps:
  - **Happy path:** a pending+unpaid `channel='bots'` row is charged its `paid_amount` (not `amount`) at the dialing number. One `wallet_payments` row is inserted with the exact fields in Global Constraints. The reference is opaque (no product words), and so is the metadata.
  - **Refusals:** `NOT_PAYABLE`, with no wallet_payments row and no charge, when the row is paid, failed, not `bots`, the wrong `bot_surface`, or (shop) a different `shop_id`. Reuse `checkCommissionPayable`.
  - **No provider:** `NO_PROVIDER` for a number with no MoMo provider.
  - **Cap:** `RATE_LIMITED` after 3 charges in an hour for one phone.
  - **Charge throws:** `chargeMobileMoney` throwing gives `CHARGE_FAILED`. The `wallet_payments` row is marked failed and the order is failed with the guarded patch (filters `payment_status='unpaid'`, `channel='bots'`, `status='pending'`). A paid row is untouched.
  - **OTP:** a `send_otp` status stores an OTP pointer for the dialing phone.
  - **Payer phone:** recorded via `recordPayerPhone`.
  - **OTP submission:** `submitBotOtp` calls `submitOtp(reference, otp)` and clears the pointer. On `failed` it fails the order with the guarded patch.
- [ ] **Step 2:** Run `npx vitest run lib/bot-commission` and expect it to FAIL.
- [ ] **Step 3: Implement `momo.ts` and `otp-pointer.ts`.**
  - `momo.ts`: a pure core with injected deps, plus `getBotMomoRuntime()`. The runtime wires the service-role client, `chargeMobileMoney`, `submitOtp`, `recordPayerPhone`, and the rate-limit store that `applyRateLimit` uses (find it). Call that store with key `mp:<digits>`, 3 per hour.
  - `otp-pointer.ts`: reuse the Upstash client from `lib/ussd/session.ts`, with key `ussd-bot-otp:<0XXXXXXXXX>`.
- [ ] **Step 4: Write the webhook proof test** next to the existing storefront settle tests. It must show that `settleStorefrontPayment` confirms a `channel='bots'`, `bot_surface='ussd_shop'` row paid through a `cs_bundle` `wallet_payments` row:
  - one paid flip, one shop share and one dispatch;
  - a second identical webhook returns `already_processed`, with no second share or dispatch;
  - `verifyStorefrontPayment` racing the webhook gives the same single effect.

  If this does not pass without production-code changes, STOP and report.
- [ ] **Step 5:** Run the tests and expect PASS. Then `rm -rf .next && npx tsc --noEmit -p .`.
- [ ] **Step 6:** Commit with message `feat(cashback): bot MoMo charge helper + OTP pointer`.

### Task 2: Uzo wording + screen helpers, visibility flags, admin toggles

**Files:**
- Create: `lib/ussd/bots/screen.ts`, `lib/ussd/bots/screen.test.ts`
- Modify: `lib/ussd-service-visibility.ts` (+test), `app/api/admin/ussd/service-visibility/route.ts` (+test if present), and the admin page that edits `ussd_service_visibility` (find it from the route's callers).

**Interfaces:**
- Produces:
  ```ts
  export const UZO_SCREEN_LIMIT = 160
  export function uzoSafeLabel(text: string): string
  export function uzoPagedList<T>(items: T[], page: number, label: (t: T) => string, opts: { header: string; pageSize?: number }): { text: string; pageItems: T[]; hasMore: boolean }
  export function uzoConfirmText(o: { pay: number; face: number; receive: string; recipient?: string; payer: string }): string
  export function botErrorText(status: number): string
  export function fitsUzo(text: string): boolean
  ```
- Behaviour of each:
  - `uzoSafeLabel`: strips `bundle(s)` first, then rewrites whole-word `data` to `Internet`, using letters as the word boundary so "Data1" is still rewritten. It collapses spaces and returns `Plan` for an empty result.
  - `uzoPagedList`: Uzo-style numbering that continues across pages, `N. More...` only when more items remain, and `0. Back`. Labels are shortened so the whole screen stays ≤ 160.
  - `uzoConfirmText`: `Pay GHS x (was GHS y)` / `You get …` / `To: 0XX…` / `MoMo: 0XX…` / `1. Confirm` / `2. Cancel`. It is fitted to ≤ 160 and the footer is never clipped; long parts are shortened first.
- `UssdServiceVisibility` gains `networkPlans: boolean; payBills: boolean`. Both default to true, and a missing field reads as true.
- Consumed by Tasks 4–6.

- [ ] **Step 1: Write failing tests:**
  - `uzoSafeLabel`:

    | Input | Output |
    |---|---|
    | `"Data 1GB"` | `"Internet 1GB"` |
    | `"Databundle"` | `"Internet"` |
    | `"metadata"` | `"metadata"` |
    | `"Data1"` | `"Internet1"` |
    | `"Bundles"` | `"Plan"` |
    | `"Social Bundle (7 days)"` | `"Social (7 days)"` |
  - Paging: page 0, 1 and the last page; numbering continues; `More...` appears only when more remain; every page is ≤ 160 with 40-char labels.
  - Confirm text with and without "was". With 40-char labels the text still ends in `1. Confirm\n2. Cancel`.
  - The error mapping.
  - Visibility: missing `networkPlans`/`payBills` reads as true, and the existing four fields are unchanged.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4: Admin.** Add two new switches, "Network Plans" and "Pay Bills", on the page that edits USSD service visibility. They save through the existing route, whose validator must accept the two booleans. If the page lives in the sidebar, no new sidebar item is needed.
- [ ] **Step 5:** Run the tests and tsc, and expect PASS.
- [ ] **Step 6:** Commit.

### Task 3: Airtime with cashback (main USSD + shop USSD)

**Files:**
- Modify: `lib/ussd/handlers/airtime.ts`, `lib/ussd/menus.ts` (prompt and confirm text variants), `lib/ussd-shop/handlers/airtime.ts`, `lib/ussd-shop/menus.ts`
- Create: `lib/ussd/bots/airtime.ts` (+test), the shared quote/columns glue.
- Read:
  - `lib/cashback/storefront-airtime.ts` (`quoteBotAirtime`)
  - `lib/ussd-hubtel/flows/airtime-cashback.ts` (`usableCashbackQuote`, `cashbackAirtimeColumns`, `cashbackPromptApplies`). Import these; don't copy them.
  - `lib/ussd-hubtel/flows/shop-airtime.ts`, for how Plan 2 priced shop airtime and set the shop share.
  - The Paystack webhook's airtime branch, for how `merchant_commission` becomes a `shop_profits` credit and how the paid amount is checked.

**Behaviour:**
- **When it applies:** only when `quoteBotAirtime(network, face, { rail: "paystack", shop })` returns a usable quote.
- **Row values:**
  - face = the amount typed (the airtime delivered);
  - charge and `total_paid` = `payAmount`;
  - `fee_amount` = `paymentFee`;
  - cashback snapshot columns and `payment_fee_amount` via `cashbackAirtimeColumns`;
  - shop USSD only: `merchant_commission` = the quote's `shopShare`, with no markup.
- **Screens:**
  - The prompt reads "Enter airtime amount" when cashback applies. Decide this with `cashbackPromptApplies` at the minimum amount, as Plan 2 does.
  - The confirm screen shows "Pay GHS x (was GHS y)".
- **Wallet:** the main-USSD wallet option stays, and the wallet pays `payAmount`.
- **Not applied, or `channel === "whatsapp"`:** today's code path, byte-identical in screens and the inserted row.
- **At confirm:** re-quote, as a stale-session guard. The MoMo charge amount is the row's `total_paid`.

- [ ] **Step 1: Write failing tests:**
  - applied on main (customer share);
  - applied on shop (storefront shares, `merchant_commission` = shop share);
  - not applied: the row and screens are byte-identical (snapshot against today's output);
  - WhatsApp channel: byte-identical even when cashback is on;
  - the wallet path charges `payAmount`;
  - a re-quote mismatch at confirm shows "Price changed. Please try again." and creates no order.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS, then tsc. Add a test confirming the webhook's airtime paid-amount check accepts `total_paid` for a cashback row, and that the shop share credited equals `merchant_commission`. No webhook change is expected; if one is needed, STOP and report.
- [ ] **Step 5:** Commit.

### Task 4: Network Plans flow (main + shop)

**Files:**
- Create: `lib/ussd/bots/network-plans.ts`, `lib/ussd/bots/network-plans.test.ts`
- Modify: `lib/ussd/types.ts` and `lib/ussd-shop/types.ts` (new steps and session fields), and `lib/ussd/router.ts` and `lib/ussd-shop/router.ts` (dispatch the new steps only; the menu entries are Task 6).

**Interfaces:**
- One flow module, parameterised by surface:
  ```ts
  export interface UzoBotCtx { surface: "ussd" | "ussd_shop"; sessionId: string; dialingPhone: string; shopId: string | null; shopName?: string }
  export async function startNetworkPlans(ctx: UzoBotCtx, session: UzoBotSession): Promise<UzoResponse>
  export async function handleNetworkPlansStep(ctx: UzoBotCtx, input: string, session: UzoBotSession): Promise<UzoResponse>
  ```
- Steps:
  1. `NP_NETWORK`
  2. `NP_CATEGORY`
  3. `NP_PLAN`, paged with `uzoPagedList`
  4. `NP_RECIPIENT`: `1. My number` / `2. Other number`
  5. `NP_CONFIRM`
- The session carries the engine catalog token, never a price the client could alter.
- Confirm `1` runs, in order:
  1. `botCreateBundleOrder(deps, { botSurface, shopId, rail: "paystack", buyerPhone: dialingPhone }, { token, recipient, idempotencyKey: sessionId, expectedPay })`;
  2. read the order back and check it is pending+unpaid;
  3. `botChargeMomo({ orderType: "cs_bundle", … })`;
  4. `end("MoMo prompt sent to 0XX…. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.")`.
- Engine failures are shown via `botErrorText`.

- [ ] **Step 1: Write failing tests:**
  - The full happy path on main and on shop, including the context passed to the engine: shop ⇒ shopId, main ⇒ null.
  - Paging forward and back.
  - Names rewritten by `uzoSafeLabel`.
  - Every screen passes `fitsUzo` with its footer intact.
  - 409, 429, 403 and other errors.
  - A read-back that is not pending/unpaid gives a refusal and no charge.
  - A charge failure fails the order (guarded) and shows friendly text.
  - `0` goes back at each step.
  - The network list uses Uzo nicknames.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS, then tsc.
- [ ] **Step 5:** Commit the flow and the router dispatch together, so each commit is green.

### Task 5: Pay Bills flow (main + shop)

**Files:**
- Create: `lib/ussd/bots/pay-bills.ts`, `lib/ussd/bots/pay-bills.test.ts`
- Modify: the two `types.ts` files and the two `router.ts` files (dispatch only).
- Read: `lib/ussd-hubtel/flows/pay-bills.ts`, the reviewed pattern. Use the same steps and rules, with Uzo text conventions.

**Behaviour:**
- **ECG** steps:
  1. `PB_BILLER`
  2. `PB_ECG_MODE`: `1. This number` / `2. Other number` / `3. Meter number`
  3. `PB_METERS` (masked names) or `PB_ACCOUNT`
  4. `PB_METER_TYPE`: `1. Prepaid` / `2. Postpaid`, informational only
  5. `PB_CONSENT`: `1. Yes, link meter X to <phone>`. The meter is linked only on `1`.
  6. `PB_AMOUNT`: min/max, with the amount due shown as a hint
  7. `PB_CONFIRM`
- **Other billers:** account → `botVerifyBill` (masked name) → amount → confirm.
- **Ghana Water:** absent.
- **Confirm:** `botCreateBillOrder` → read-back → `botChargeMomo({ orderType: "cs_bill", … })` → the same end text as Task 4.

- [ ] **Step 1: Write failing tests:**
  - each ECG path;
  - a TV biller;
  - Ghana Water absent;
  - shop vs main context;
  - verify errors never leak provider text;
  - the consent step gates the meter link;
  - amount bounds;
  - every screen passes `fitsUzo`;
  - the error mapping;
  - the read-back refusal;
  - a charge failure gives a guarded fail.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS, then tsc.
- [ ] **Step 5:** Commit.

### Task 6: Menus, OTP on redial, verification, runbook

**Files:**
- Modify:
  - `lib/ussd/menus.ts` (`MainMenuKey` gains `networkPlans` and `payBills`, placed after the existing items)
  - `lib/ussd/handlers/main.ts`
  - `lib/ussd/router.ts` (op=1 OTP lookup)
  - `lib/ussd-shop/menus.ts` (`ProductMenuKey`)
  - `lib/ussd-shop/handlers/shop.ts`
  - `lib/ussd-shop/router.ts` (op=1)
  - `docs/hubtel-commission-services/runbook.md`
- Create: `lib/ussd/bots/gate.ts` (+test), with `botMenusVisible(db): Promise<{ networkPlans: boolean; payBills: boolean }>`. It combines the cashback gate with the visibility flags and fails closed.

**Behaviour:**
- **New menu items** go at the END of each menu, so existing digits never move.
  - With the gate off, `mainMenu()`/`productMenu()` output and digit dispatch are byte-identical. Test both menus, with the gate on and off, in every combination.
  - `mainMenu()` with no arguments, called by the WhatsApp bot and the AI tool, stays unchanged.
- **Redial (op=1):** add `peekBotOtpPointer(dialingPhone)` as one more candidate in the existing pending-OTP lookup, where the newest `created_at` wins. When the pointer wins, show the existing OTP prompt and send the input to `submitBotOtp`. Input `0` cancels, with a guarded fail and the pointer cleared.
- **Runbook section** "Commission Cashback — Bots (Plan 3: main + shop USSD)", covering:
  - a pre-deploy SQL check that `surfaces.bots` and `botGroups` are off;
  - no migration needed;
  - enable steps: the Bots surface and groups, the `botFees.paystack` value, and the visibility switches;
  - a test with a test number on both menus;
  - the ruling that USSD has no OTP or direct-charge switch;
  - refunds: Paystack reversal is available and the payer phone is recorded;
  - a link to the needs-review procedure in Plan 2 step 8;
  - rollback.
- **Full verification:**
  - `rm -rf .next`;
  - full `npx vitest run`, expecting only the 9 known `lib/order-health-service.test.ts` failures;
  - `npx tsc --noEmit -p .`;
  - a real `next build` with placeholder env.

- [ ] **Step 1:** Write failing tests for the menus, the gate and OTP redial.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run and expect PASS.
- [ ] **Step 4:** Write the runbook section.
- [ ] **Step 5:** Run the full verification.
- [ ] **Step 6:** Commit in pieces. STOP before merging or pushing.

## Self-review

- **Spec coverage:**
  - §2 shares → Global Constraints;
  - §3 pricing → Tasks 3–5, through `quoteBots` and the engine;
  - §4 Paystack rail and shared confirm → Task 1 (webhook proof test);
  - §5 menus → Tasks 4–6;
  - §9 errors → Global Constraints and Tasks 4–5;
  - §10 testing → each task, plus the Task 6 verification.
- **Carried items:**
  - direct MoMo charge to the number the bot asks for (on USSD, the dialing number) → Task 1;
  - in-process payment init, with no `/api/payments/initialize` hop → Task 1;
  - payer phone for refunds → Task 1;
  - margin-report airtime mapping → stays a runbook follow-up, unchanged from Plan 2.
- **User decisions 2026-10-20:** wording rule kept on Uzo, MoMo only, Hubtel untouched → Global Constraints.
- **Review Focus coverage:**
  - item 1 → Task 1 Step 4 and the Task 6 OTP tests;
  - item 2 → Tasks 3 and 6;
  - item 3 → the context tests in Tasks 3–5;
  - item 4 → the failure tests in Tasks 1, 4 and 5;
  - item 5 → the screen tests in Tasks 2, 4 and 5.
- **Type consistency:** `UzoBotCtx` and `UzoBotSession` are defined in Task 4 and reused in Task 5. `BotChargeInput` and `BotOtpPointer` are defined in Task 1 and used in Tasks 4–6.
