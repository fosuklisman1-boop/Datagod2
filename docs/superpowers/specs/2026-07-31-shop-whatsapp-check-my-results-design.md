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

`shopProductMenu()` (`lib/whatsapp-bot/shop-menus.ts`) gains a 4th line, `4. Check My Results` (renumbered to `3.` when Data is blocked, same as the existing Airtime/RC-voucher renumbering rule).

Freetext routing: the shop router's freetext-escape matcher currently sends any results-related phrase (`result`, `checker`, `waec`, `bece`, `voucher`) to the RC-voucher flow. It's extended to distinguish intent — phrases containing `"check"` alongside a results keyword (e.g. "check my result", "check results") route to the new flow's entry step; bare product words ("results", "voucher", "waec") keep routing to RC-voucher purchase as today. An ambiguous phrase falls back to the product menu (showing both options) rather than guessing.

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
- `channel: 'whatsapp'`, `whatsapp_number` = the customer's inbound WhatsApp number (no separate ask)
- `shop_id` = the sub-agent's shop, `merchant_commission` = from `calculateResultsCheckPrice({examBoard, mode, shopId})`
- `payment_status: 'pending_payment'`

No new table, no migration — `results_check_requests`, `user_shops.results_check_markup`, and the admin-notify infrastructure all already exist and are already shop-aware.

### 4. Payment & completion — reuse the existing generalized mechanism

`RCCHECK_CONFIRM` re-verifies board availability and re-prices server-side (never trusts cached session values), re-checks the shop's token balance (`fetchShopCodeTokenBalance`, same anti-race guard as every other confirm step), creates the request row, then charges via the existing `chargeMobileMoney({ reference: requestId, ... })` — identical mechanism to Data/Airtime/RC-voucher, just with the new table's row id as the reference.

This requires extending two existing generalization points that the code already calls out as designed for exactly this:
- `ShopOrderTable` (`'ussd_shop_orders' | 'airtime_orders' | 'results_checker_orders'`) gains `'results_check_requests'`.
- `SECONDARY_STATUS_COL` gains `results_check_requests: 'payment_status'`.

With those two additions, `markOrderOtpRequired`/`markOrderFailed` and the generalized `SUBMIT_OTP` handling work for the new table with no further changes — same as they do for the other three. Completion on successful payment is async via the **existing** Paystack webhook, which (per `lib/shop-commerce/orders.ts`'s header comment) already fulfills these tables by reference — `results_check_requests` completion is already wired there for the main bot/USSD/storefront, so this is adding a 4th table to an existing dispatch, not a new webhook path. The implementation plan must verify the webhook's `results_check_requests` branch isn't gated in a way that assumes a non-shop channel (e.g. a hardcoded shop_id-null expectation) before relying on it firing unchanged.

### 5. Admin notification: surface which shop a request came from

`notifyAdminsNewResultsCheckRequest()` (`lib/results-checker-service.ts`) currently labels a request's channel as "WhatsApp"/"Web"/"USSD" with no shop attribution. Small additive change: when `req.shop_id` is present, look up the shop name and append "via **<ShopName>**" to the notification message, so admins can tell a shop-bot request apart from the main number. No change to requests where `shop_id` is null (main bot/USSD/storefront-without-shop).

### 6. Mid-flow shop-code re-entry

The router's existing "customer sends a different shop code mid-order" handling lists specific in-progress steps it must escape cleanly from (`CONFIRM`, `AIRTIME_CONFIRM`, `RC_CONFIRM`, `ENTER_PAYMENT_PHONE`, etc.). All new `RCCHECK_*` steps are added to the equivalent sets so this behaves identically to every other in-progress order.

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
