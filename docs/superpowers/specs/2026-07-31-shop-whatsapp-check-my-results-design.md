# "Check My Results" on the Shop WhatsApp Bot

**Date:** 2026-07-31
**Status:** Approved
**Goal:** Let a sub-agent's WhatsApp shop customers have Datagod check their WASSCE/BECE/NOVDEC result on their behalf (combo or own-voucher), not just buy a voucher — bringing the shop bot to parity with the main WhatsApp bot, USSD, and the web storefront, which all already offer this.

## Background

The shop WhatsApp bot (`lib/whatsapp-bot/shop-router.ts`) sells three products today: Data, Airtime, and Results Checker **vouchers** (`results_checker_orders`). It has no way for a customer to have Datagod actually perform a result check — that "Check My Results" service exists only on the main WhatsApp bot/USSD (`results_check_requests`, `RC_CHECK_*` steps in `lib/ussd/handlers/results-checker.ts`) and the web storefront (`/shop/[slug]`'s "Check My Results" tab).

The service already supports per-shop attribution end to end — `results_check_requests.shop_id`, `user_shops.results_check_markup`, and `calculateResultsCheckPrice({examBoard, mode, shopId})` all exist because the storefront uses them. This feature wires the shop bot's WhatsApp conversation into that same, already-shop-aware backend — it does not change `results-checker-service.ts`, `results-check-validation.ts`, the `results_check_requests` table, or the admin delivery page.

Rejected alternative: delegating to the shared `RC_CHECK_*` USSD handlers directly (as the main WhatsApp bot does). Those handlers have no concept of `shop_id`/markup, and every other shop-bot product (Data, Airtime, RC-voucher) is already a shop-native reimplementation rather than a delegate call — delegating here would be inconsistent and would risk coupling shop-specific needs onto code the main bot and USSD depend on.

## Changes

### 1. Menu: new top-level option

`shopProductMenu()` (`lib/whatsapp-bot/shop-menus.ts`) gains a 4th line, `4. Check My Results` (renumbered to `3.` when Data is blocked, same as the existing Airtime/RC-voucher renumbering rule). Entry is via that menu digit only — the shop bot's deterministic router has no keyword-based freetext matcher to extend (`shopNaturalToDigit` only resolves network names and confirm/cancel words at specific steps); any other freetext at `SELECT_PRODUCT` already escapes to the AI conversation handler (`shop-ai.ts`) today, same as it does for the existing three products. Teaching the AI layer to place a Check-My-Results order conversationally is out of scope here, exactly mirroring how the RC-voucher purchase flow itself has no bespoke freetext path either.

### 2. Conversational flow (new shop-prefixed session steps in `shop-router.ts`)

Mirrors the main bot's `RC_CHECK_*` step order and validation exactly, adapted for the shop's WhatsApp-first context:

```
RCCHECK_SELECT_BOARD        1. WASSCE  2. BECE  3. NOVDEC
  -> RCCHECK_CANDIDATE_TYPE  1. School  2. Private
    -> RCCHECK_MODE          1. Buy voucher + check (GHS X)   2. I have a voucher (GHS Y)
                             (skipped when the board has 0 voucher stock -- forced to
                              own_voucher, same rule the main bot uses)
      -> [RCCHECK_ENTER_VOUCHER]   own_voucher only: "PIN/Serial", board-aware format
        -> RCCHECK_ENTER_INDEX     board-aware digit count (10, or 10/12 for BECE)
          -> RCCHECK_ENTER_YEAR
            -> RCCHECK_ENTER_DOB   DD/MM/YYYY
              -> RCCHECK_ENTER_PAYMENT_PHONE   shopPaymentPhonePrompt(), reused verbatim
                -> RCCHECK_CONFIRM
```

Two deviations from the USSD/main-bot sequence, both because the shop bot is WhatsApp-only:
- **No WA-number step.** The USSD flow's `RC_CHECK_WA_NUMBER` step exists so a USSD customer can optionally supply a WhatsApp number for media delivery; the shop bot already knows the customer's WhatsApp number from the inbound message, so `whatsapp_number` is set automatically and this step is skipped entirely (same reason the main bot's WA channel already skips it).
- **Payment-phone is its own step** placed right before `RCCHECK_CONFIRM`, matching the shop bot's existing RC-voucher flow shape (`RC_ENTER_PAYMENT_PHONE` -> `RC_CONFIRM`) rather than the USSD flow's inline wallet-vs-MoMo choice inside the confirm screen.

Every step's `0` (back) mirrors the exact back-target chain already implemented in `handleRcCheckBoard`/`handleRcCheckCandidateType`/etc. — this is a mechanical port of existing, already-tested back-navigation logic, not new design.

Validation is reused as-is from `lib/results-check-validation.ts` (`isValidVoucherPin`/`isValidVoucherSerial`, board-aware) plus the same index-number and DOB regexes already inlined in the USSD handlers, ported verbatim.

### 3. Data: new request-creation helper

`createShopCheckResultsRequest()` added to `lib/shop-commerce/orders.ts`, sibling to `createShopRcOrder`. Inserts into `results_check_requests`:

- `mode` ('combo' | 'own_voucher'), `exam_board`, `candidate_type`, `index_number`, `exam_year`, `dob`
- `voucher_pin`/`voucher_serial` (own_voucher mode only, else null)
- `phone_number` = the customer's own WhatsApp number in local format (this table's NOT NULL identity column — mirrors how the USSD handler sets it to the caller's own number), `whatsapp_number` = the same number again (no separate ask — the shop bot only has one number for this customer)
- `channel: 'whatsapp_shop'` — **not** the plain `'whatsapp'` the main bot uses. This is load-bearing: `deductTokenIfWhatsappShopOrder()` (`lib/shop-commerce/token-deduction.ts:71`) gates strictly on `order.channel === "whatsapp_shop"`, the exact literal `airtime_orders`/`results_checker_orders` rows already use for shop-bot sales
- `shop_id` = the sub-agent's shop, `merchant_commission` = from `calculateResultsCheckPrice({examBoard, mode, shopId}).merchantCommission`
- `payment_reference` = a generated customer-facing reference (`secureReference("RCK", 2, 3)`, already imported in `shop-router.ts`) — mirrors the USSD handler's `referenceCode` pattern; **distinct** from the Paystack charge `reference`, which (per every other shop product) is the row's own `id`, not this human-readable code
- `user_id: null` (shop-bot customers are anonymous WhatsApp users, same as the other three shop order tables)
- `payment_status: 'pending_payment'`, `status: 'pending'` (this table has *two* separate state columns — see Change 4)

No new table, no migration — `results_check_requests`, `user_shops.results_check_markup`, and the admin-notify infrastructure all already exist and are already shop-aware.

### 4. Payment & completion — reuse the existing generalized mechanism

`RCCHECK_CONFIRM` re-verifies board availability and re-prices server-side (never trusts cached session values), re-checks the shop's token balance (`fetchShopCodeTokenBalance`, same anti-race guard as every other confirm step), creates the request row, then charges via the existing `chargeMobileMoney({ reference: requestId, ... })` — identical mechanism to Data/Airtime/RC-voucher, just with the new table's row id as the reference.

This requires extending two existing generalization points in `shop-router.ts` that the code already calls out as designed for exactly this:
- `ShopOrderTable` (`'ussd_shop_orders' | 'airtime_orders' | 'results_checker_orders'`) gains `'results_check_requests'`.
- `BROAD_STATUS_COL` gains `results_check_requests: 'status'` — this table has *two* independent state columns (`payment_status`: `pending_payment`/`paid`/`otp_required`/`failed`, and `status`: `pending`/`checking`/`completed`/`failed`), same split `airtime_orders`/`results_checker_orders` already have. `markOrderOtpRequired` always writes only `payment_status` regardless of table (unchanged); `markOrderFailed` writes both `payment_status` and whatever `BROAD_STATUS_COL[table]` resolves to — `'status'` for this table.

With those two additions, `markOrderOtpRequired`/`markOrderFailed` and the generalized `SUBMIT_OTP` case work for the new table with no further changes — same as they do for the other three.

**Webhook fix required (not just verification).** Completion on successful payment is async via the existing Paystack webhook (`app/api/webhooks/paystack/route.ts`), which already has a direct-reference lookup branch for `results_check_requests` (~line 753 — it tries `id = reference` after the `airtime_orders`/`results_checker_orders` branches, used today by the main bot's direct-charge flow). Tracing that branch found it does **not** call `deductTokenIfWhatsappShopOrder()` or credit `shop_profits`, unlike the `airtime_orders`/`results_checker_orders` branches immediately above it — because it's never before had to handle a `shop_id`-bearing row. This is a real, currently-latent gap this feature would otherwise walk into (an order the shop makes money on, but where the shop's profit is never recorded and its session token is never deducted). Fix, scoped narrowly to avoid touching the main bot/USSD-momo behavior that already relies on this branch:
- Add `shop_id, merchant_commission, channel` to the branch's existing `.select(...)` (currently `"id, fee, payment_status, phone_number, exam_board, index_number, exam_year, payment_reference, mode, voucher_pin"`).
- After the existing `payment_status`/`status` update, insert into `shop_profits` when `shop_id` and `merchant_commission > 0` — same insert shape `fulfillPaidResultsCheckRequest()` already uses (`results-checker-service.ts:933-956`): `{shop_id, results_check_request_id, profit_amount: merchant_commission, status: 'credited', created_at, updated_at}`, with the same `code !== "23505"` duplicate-guard and FK-column fallback.
- When `channel === 'whatsapp_shop'`, call `deductTokenIfWhatsappShopOrder({channel, shop_id})` (dynamic import, mirroring the identical call already made for `airtime_orders`/`results_checker_orders` a few dozen lines above in the same file).
- Everything else in that branch (combo voucher assignment, `notifyAdminsNewResultsCheckRequest`, the WhatsApp confirmation send) is untouched — it already works, and already fires regardless of channel.

### 5. Admin notification: surface which shop a request came from

`notifyAdminsNewResultsCheckRequest()` (`lib/results-checker-service.ts:146`) labels a request's channel as `req.channel === "whatsapp" ? "WhatsApp" : req.channel === "web" ? "Web" : "USSD"` — with the new `channel: 'whatsapp_shop'` value this feature introduces, that falls through to the wrong label, "USSD". Fix: add an explicit `"whatsapp_shop"` branch → `"WhatsApp Shop"`. Additionally, when `req.shop_id` is present, look up the shop name (`user_shops.shop_name`) and append "via **<ShopName>**" to the message, so admins can tell which sub-agent a request came from. No change to requests where `shop_id` is null (main bot/USSD/storefront-without-shop).

### 6. AI-escape gating for the new steps

Once a session exists, `shopWaRouter` is driven entirely by `session.step` — there is no separate "customer sent a different shop code mid-order" mechanism to extend (verified directly in the code; the router's `!session` branch only ever runs on the *first* message of a conversation). What **does** need extending is the existing `MONEY_STEPS`/`FREE_TEXT_ENTRY_STEPS` gate that decides whether non-digit freetext escapes to the AI conversation handler instead of being processed by the current step:
- `RCCHECK_ENTER_PAYMENT_PHONE` and `RCCHECK_CONFIRM` join `MONEY_STEPS` (money-moving steps never escape to AI, matching every other product's payment-phone/confirm steps).
- `RCCHECK_ENTER_VOUCHER` and `RCCHECK_ENTER_DOB` join `FREE_TEXT_ENTRY_STEPS` — their valid input contains `/` (PIN/Serial, DD/MM/YYYY), which fails the router's `isDigitOrZero` check and would otherwise escape to the AI before ever reaching these steps. `RCCHECK_ENTER_INDEX`/`RCCHECK_ENTER_YEAR` take pure digits and need no listing, same as the existing `RC_ENTER_QTY`.

## Error handling

- **Board/service disabled entirely**: same top-level "any exam board available" gate the RC-voucher flow already checks before entering `RC_SELECT_BOARD` also gates entry to `RCCHECK_SELECT_BOARD` — same "Results Checker unavailable" fallback message.
- **0 stock for the chosen board**: forces `own_voucher` mode automatically (matches USSD/main-bot behavior) rather than erroring.
- **Stale-session race** (stock or pricing changed between `RCCHECK_MODE` and `RCCHECK_CONFIRM`): re-verified server-side at confirm time, same pattern as Data/Airtime/RC-voucher confirm steps.
- **Charge failure**: `markOrderFailed('results_check_requests', requestId)`, generic "could not start payment" message — identical wording/pattern to the other three flows.
- **Zero token balance on the shop code**: same "no sessions left, contact the seller" message the other three flows already show.

## Explicit exclusions (scope)

- No "check status of a pending request" / retrieval flow via the shop bot chat — the shop bot has no status-check for *any* of its existing products today either, so this stays consistent rather than introducing a first-of-its-kind capability.
- No changes to the main WhatsApp bot, USSD, storefront, or `results-checker-service.ts`'s pricing/fulfillment logic — purely additive to the shop bot.
- No new database migrations.

## Testing

Extend `lib/whatsapp-bot/shop-router.test.ts` (existing fake-client pattern, per [[reference-testing]]) with the new `RCCHECK_*` steps: both modes' happy paths, board/candidate/mode validation failures, 0-stock forcing own_voucher, back-navigation at each step, charge failure, and the OTP branch. Mirrors the existing Data/Airtime/RC-voucher test coverage shape in the same file.
