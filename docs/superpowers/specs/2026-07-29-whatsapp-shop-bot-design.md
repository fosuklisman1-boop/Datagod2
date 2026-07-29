# WhatsApp Shop Bot — Design

**Status:** Approved design (brainstorm complete) — pending implementation plan.
**Date:** 2026-07-29

## Goal

A menu-driven WhatsApp bot that mirrors the **USSD shop** (`lib/ussd-shop/`): a
customer enters a **shop code** (or taps a shop's `wa.me` deep link), then buys
**Data / Airtime / Results Checker** at that sub-agent shop's own prices — running
on a **dedicated WhatsApp number** the owner has already added under the existing
Meta app.

This parallels how the existing WhatsApp bot (`lib/whatsapp-bot/router.ts`,
`waRouter`) mirrors the *main* USSD flow — but scoped to a shop, with shop pricing
and the shop's pre-paid token balance.

## Decisions (locked during brainstorm)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Shop scoping | **Shop code** on a shared bot number, plus a per-shop `wa.me` deep link |
| 2 | Which number | A **dedicated** WhatsApp number, **same Meta app** as the main number (routed by `phone_number_id`) |
| 3 | Token billing | **1 token per completed order** (gate `>0` at confirm; deduct on `charge.success`) |
| 4 | Products | **All three** — Data, Airtime, Results Checker (full parity) |
| 5 | Architecture | **Dedicated shop router + shared `lib/shop-commerce`**; USSD-shop refactored onto the shared module (test-guarded) |
| 6 | WhatsApp activation | **One-time unlock fee per shop code**, admin-configurable, managed on `/dashboard/ussd-shop`. Sessions stay **shared** with USSD (no separate balance) |

## Architecture

### Entry & routing
- The new number is under the **same Meta app**, so both numbers hit the existing
  `POST /api/whatsapp/webhook`. Meta includes the receiving number in each payload
  at `entry[].changes[].value.metadata.phone_number_id`.
- The webhook routes by that id: **shop number → `shopWaRouter`**; anything else →
  the existing `waRouter` / AI path (unchanged). A new env var
  `WHATSAPP_SHOP_PHONE_NUMBER_ID` holds the shop number's id.
- Because it's a **dedicated number**, every inbound message is shop-mode — no
  `shop` keyword and no collision with the main bot's menu numbers.
- Deep link: `https://wa.me/<NEW_NUMBER>?text=<code>` pre-fills the shop code, so a
  single send drops the customer into that shop. Typing anything non-code at the
  first step → the bot asks for a code.

### Sending replies from the shop number
- The Graph send call targets `/{phone_number_id}/messages`. `lib/whatsapp-bot/send.ts`
  is **parameterized** to send from a chosen number id (defaulting to the main
  number for existing callers); the shop bot passes `WHATSAPP_SHOP_PHONE_NUMBER_ID`.
- Same access token works for both numbers (same app), so **no new token** is needed.

### Components

**New**
- `lib/whatsapp-bot/shop-router.ts` — the state machine, mirroring
  `lib/ussd-shop/router.ts` steps, rendering WhatsApp menus (text) instead of USSD
  `cont/end`. Steps: `ENTER_CODE → SELECT_PRODUCT → …product sub-flows… → ENTER_PAYMENT_PHONE → CONFIRM → (OTP)`.
- `lib/whatsapp-bot/shop-session.ts` — Redis-backed session keyed by the customer's
  phone, longer TTL than USSD (WhatsApp is async; ~30 min). Holds `shopCodeId`,
  `shopId`, `shopName`, `parentShopId`, product selection, recipient, payment phone,
  pending order/OTP.
- `lib/shop-commerce/` — **channel-agnostic** shop commerce core (the reuse unit):
  - `resolveShopCode(code)` → `{ shopCodeId, shopId, shopName, parentShopId, status, tokenBalance }`.
  - `getShopNetworks(shopId, parentShopId)` → available networks.
  - `getShopBundles(shopId, parentShopId, network)` → bundles priced with the shop's markup.
  - `createShopBundleOrder(...)`, `createShopAirtimeOrder(...)`, `createShopRcOrder(...)`
    → insert into the existing tables tagged `channel = 'whatsapp_shop'`, returning `{ orderId, amount, … }`.
- `app/api/whatsapp/webhook/route.ts` — add the `phone_number_id` branch to dispatch
  to `shopWaRouter`.

**Reused as-is (no behavioural change)**
- `lib/paystack.ts` `chargeMobileMoney` + `submitOtp` for the MoMo direct charge.
- Blacklist checks, profit crediting, delivery SMS.
- The Paystack webhook's existing **fulfillment** for `ussd_shop_orders` /
  `airtime_orders` / `results_checker_orders` **by reference** → the shop bot charges
  with `reference = order.id` and fulfillment/profit crediting are automatic.

**Small addition to the webhook**
- Add a step: when a `charge.success` resolves to a **`channel = 'whatsapp_shop'`**
  order, call `deduct_ussd_shop_token(shop_code_id)` (this is the per-completed-order
  token billing — it does **not** exist today; USSD deducts at session entry instead).

**Refactored (test-guarded)**
- `lib/ussd-shop/handlers/*` — pricing + order-creation logic **extracted into
  `lib/shop-commerce`** and both channels call it, so the shop-markup math lives in
  one place. USSD-shop presentation (USSD menus, per-session token deduction) stays.

### Data flow — data bundle (representative)
1. Inbound to shop number → webhook → `shopWaRouter`.
2. `ENTER_CODE`: `resolveShopCode` → **WhatsApp-activated?** active? `token_balance > 0`?
   else re-prompt / "not set up for WhatsApp" / "out of sessions".
3. `SELECT_PRODUCT` → product menu (Data / Airtime / Results Checker), respecting the
   data whitelist gate exactly as USSD-shop does.
4. Data: network → bundle (shop price) → recipient number → **MoMo payment number**
   (always asked, never assumed to be the WA sender — matches the existing WA bot rule).
5. `CONFIRM`: re-check `token_balance > 0`; create the order (`channel='whatsapp_shop'`);
   `chargeMobileMoney(reference = order.id)`; if Paystack returns `send_otp`, ask for
   the OTP and `submitOtp`.
6. On approval, the **existing webhook** marks paid, fulfills, credits profit, **and
   deducts 1 shop token** (`deduct_ussd_shop_token`) for `whatsapp_shop` orders.

Airtime and Results Checker follow the same shape as their USSD-shop counterparts
(`SHOP_AIRTIME_*`, `SHOP_RC_*`), writing to `airtime_orders` / `results_checker_orders`
with `channel='whatsapp_shop'`.

### Token billing (per completed order)
- **Gate at CONFIRM**: require `token_balance > 0` before charging, else
  "This shop is out of sessions — please tell the seller." → a 0-token shop can't sell.
- **Deduct on completion**: the Paystack webhook calls `deduct_ussd_shop_token` when a
  `whatsapp_shop` order's `charge.success` lands (atomic RPC, never negative). Browsing
  and abandoned chats cost nothing. For this the order must carry the **`shop_code_id`**
  (which code paid for it) — `createShop*Order` stores it on `whatsapp_shop` orders so
  the webhook can resolve the code to deduct. (If a table lacks the column, add it or
  resolve `shop_id → active code` in the webhook — the plan will pick one.)
- Edge (rare): two orders completing against a shop's last token — the second
  `deduct` returns false; the paid order still fulfills (a free sale). Acceptable; the
  confirm-time gate prevents the common 0-token case.

### WhatsApp activation (one-time unlock + gated access)
Mirrors the existing USSD activation (`ussd_shop_codes.activation_fee_paid` +
`ussd_shop_activation_fee` admin setting), on the **same** `/dashboard/ussd-shop` page.

- **Data model:** add `whatsapp_activated BOOLEAN DEFAULT false` and
  `whatsapp_activated_at TIMESTAMPTZ` to `ussd_shop_codes`. Applies to an existing
  active code (a shop first sets up its USSD code, then unlocks WhatsApp as an add-on).
- **Admin fee:** new app-setting `whatsapp_shop_activation_fee` (amount), edited on
  `/admin/ussd-shops` right beside `ussd_shop_activation_fee`.
- **Payment:** reuse the USSD activation payment path — a Paystack charge tagged as a
  WhatsApp activation (e.g. `ussd_shop_token_purchases` with an `is_whatsapp_activation`
  marker, `tokens_purchased = 0` since it grants **no** sessions). On `charge.success`
  the webhook sets `whatsapp_activated = true, whatsapp_activated_at = now()` — it does
  **not** touch `token_balance` (sessions stay shared with USSD).
- **Gated dashboard UX** (`/dashboard/ussd-shop`), the key requirement:
  - **Before payment:** show the WhatsApp activation fee + an "Activate WhatsApp Shop"
    button. The `wa.me` link and instructions are **hidden**.
  - **After payment** (`whatsapp_activated = true`): reveal the shop's
    **`wa.me/<NEW_NUMBER>?text=<code>` deep link** (with copy button) plus
    **instructions** — how to share the link, that customers can also just send the
    shop code, and the Data/Airtime/Results-Checker flow — presented like the existing
    USSD instructions block on that page.
- **Bot gate:** `resolveShopCode` returns `whatsappActivated`; the shop-router
  `ENTER_CODE` step requires `whatsapp_activated = true` (in addition to `status='active'`
  and `token_balance > 0`). If a valid code isn't WhatsApp-activated →
  "This shop isn't set up for WhatsApp yet." So even a leaked code can't transact until
  the owner has paid.

### Error handling
- Invalid / inactive shop code → re-prompt.
- `token_balance = 0` at confirm → "out of sessions".
- Payment / OTP failure → mirror the existing WA bot's messaging + retry.
- Session timeout (Redis TTL) → friendly "session expired, send the shop code again".
- Blacklisted recipient → existing block path.
- Unknown input at a menu step → re-render that menu (USSD-shop behaviour).

### Admin inbox note
`whatsapp_conversations` / `whatsapp_messages` are keyed by the **customer's** phone,
so shop-bot chats surface in the same `/admin/whatsapp` inbox. Out of scope to split
by business number now; if needed later, tag the conversation with the receiving
`phone_number_id`.

## Testing

Vitest with the existing fake-Supabase-client pattern:
- `lib/shop-commerce` unit tests: shop-markup pricing (regular shop vs sub-agent /
  dealer parent), and order creation per product (correct table, `channel`, amounts).
- `shop-router` step tests: the state machine transitions with a fake session + client
  (code entry, product selection, confirm gating on tokens).
- Token deduction on `charge.success` for a `whatsapp_shop` order.
- A regression test that the refactored USSD-shop pricing still matches current output.
- **Activation gate:** `resolveShopCode` / `ENTER_CODE` rejects a code that is active
  with tokens but **not** WhatsApp-activated; and the webhook flips `whatsapp_activated`
  on a WhatsApp-activation `charge.success` **without** granting tokens.

## Out of scope (YAGNI)
- No separate Meta app / webhook (same app, routed by `phone_number_id`).
- No AI / free-text shop bot — menu-driven only (mimics USSD).
- No per-shop WhatsApp numbers (one dedicated number serves all shops).
- Admin-inbox split by business number (revisit only if it becomes confusing).

## Required configuration
- `WHATSAPP_SHOP_PHONE_NUMBER_ID` — the new number's Meta `phone_number_id` (Vercel env).
- The dedicated number must be subscribed to the app's webhook in Meta (the owner set
  up the number; confirm webhook subscription during rollout).
- DB migration: `ussd_shop_codes.whatsapp_activated` + `whatsapp_activated_at`
  (+ `ussd_shop_token_purchases.is_whatsapp_activation` if that path is used).
- Admin setting `whatsapp_shop_activation_fee` (default 0 until the owner sets it).
