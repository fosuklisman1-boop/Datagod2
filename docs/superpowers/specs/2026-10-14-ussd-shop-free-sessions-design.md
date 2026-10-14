# USSD Shop: Free Sessions + Admin-Controlled Activation Fee

Date: 2026-10-14
Status: Draft, awaiting user review

## 1. Goal

Shop owners no longer buy session tokens. Customers can enter any shop on every channel (Uzo USSD, Hubtel USSD in shop mode, WhatsApp shop bot) without tokens being spent. Shops are open by default. The admin can introduce an activation fee later.

The Hubtel code keeps its current admin main/shop mode toggle unchanged (`/admin/ussd-hubtel`).

## 2. Decisions (agreed in brainstorming)

| # | Decision |
|---|----------|
| D1 | The Uzo shop code stays live. The platform absorbs Uzo's per-session cost. |
| D2 | Session billing is removed on **all** channels: Uzo, Hubtel shop mode, and the WhatsApp shop bot. |
| D3 | Leftover `token_balance` values are ignored. No refunds and no money movement. |
| D4 | Every shop is open while the activation fee is GHS 0. The admin can set a fee later. |
| D5 | When a fee is set later, shops that are already open are **grandfathered** (they stay open). Only codes created after the fee is set must pay. |
| D6 | The WhatsApp shop activation fee follows the same rule as D4/D5. |
| D7 | Implementation approach: **activate at write time**. Codes are written as active (fee waived) while the fee is 0. The entry check becomes `status = 'active'`. |
| D8 | Hubtel routing is unchanged: the admin picks main OR shop mode as today. No direct dial and no "Visit a shop" item. |

### Probe result behind D8 (2026-10-14)

Dialing `*713*235*1234#` from a real phone gave "phone number invalid": the network rejects a further extension under Hubtel's `*713*235#` sub-code, so direct dial into a shop isn't possible. The user then chose to keep Hubtel routing exactly as it is today.

## 3. Remove session billing

### 3.1 Entry checks become `status === 'active'`

Remove every `tokenBalance` / `token_balance > 0` check and every token deduction from these places:

| Place | Change |
|---|---|
| `lib/ussd-shop/handlers/shop.ts` (`handleEnterShopCode`) | Drop the "no sessions left" branch, the `deduct_ussd_shop_token` RPC call, the low-session push, and the extra `user_shops.user_id` fetch that exists only for that push. |
| `lib/ussd-hubtel/flows/shop.ts` | Drop the deduction, the "no sessions left" replies, and the low-session push. Keep code resolution and the `status` check. Update doc comments that describe Uzo billing. |
| `lib/ussd-hubtel/billing-guard.ts` (+ test) | Delete it. Its only job was to stop one Hubtel session paying twice for the same code. Remove its use in the flow and its deps wiring. `recoverShopCodeEntry` stays. Only its billing comment changes. |
| `lib/ussd-hubtel/shop-services.ts` | Remove `deductToken`, the low-session threshold and the low-session push deps. |
| `lib/shop-commerce/token-deduction.ts` (+ test) | Delete it, and remove its three call sites in `app/api/webhooks/paystack/route.ts` (USSD shop data, airtime and results-checker branches of the WhatsApp shop sale). |
| `lib/whatsapp-bot/shop-router.ts` | Remove `tokenBalance > 0` from the "remembered shop" check and the "no sessions left" branch. |
| `lib/ai-tools.ts` | Remove the `buy_sessions` action and the token check in `resolve_shop_code`. Update the tool description. |
| `lib/shop-commerce/shop-code.ts` | Stop selecting and returning `tokenBalance` once nothing reads it. |
| `app/api/public/shop-ussd-code/route.ts` | `active = status === 'active'`. |

### 3.2 Removed outright

- `app/api/dashboard/ussd-shop/buy-sessions/route.ts`
- `app/api/admin/ussd-shops/[id]/tokens/route.ts` and its UI on `/admin/ussd-shops`
- In `app/dashboard/ussd-shop/page.tsx`: the "Buy Sessions" card, the "N sessions remaining" text, the low and zero-session warnings, and the "No Sessions" badge
- In `/admin/ussd-shops`: the token balance column/badge
- The admin settings fields `ussd_shop_session_price`, `ussd_shop_min_sessions` and `ussd_shop_max_sessions`: removed from the admin UI, `app/api/admin/settings/route.ts` and `app/api/public/config/route.ts`. The columns stay in the DB.
- Session-related text in the WhatsApp/AI copy (for example "contact the seller, no sessions left")

### 3.3 Kept in the DB, unused

`ussd_shop_codes.token_balance`, `ussd_shop_token_purchases` and `deduct_ussd_shop_token()` are left in place and become dead. Dropping them is a separate later cleanup. Leaving them avoids a destructive migration and keeps the purchase history.

## 4. Fee-driven opening and grandfathering

### 4.1 Migration (next free number at implementation time; 0119 is the latest on main and the cashback work may claim 0120)

1. `ALTER TABLE ussd_shop_codes ADD COLUMN activation_fee_waived boolean NOT NULL DEFAULT false, ADD COLUMN whatsapp_activation_waived boolean NOT NULL DEFAULT false;` These are audit flags. They record whether a code was opened for free rather than paid for.
2. Replace `auto_assign_ussd_shop_code()`. Same code generation as today, but the INSERT reads the singleton `app_settings` row (`key IS NULL`):
   - `COALESCE(ussd_shop_activation_fee, 0) = 0` → `status='active', activation_fee_paid=true, activation_paid_at=now(), activation_fee_waived=true`
   - otherwise `status='inactive'` (today's behaviour)
   - `COALESCE(whatsapp_shop_activation_fee, 0) = 0` → `whatsapp_activated=true, whatsapp_activated_at=now(), whatsapp_activation_waived=true`
   - A missing settings row is treated as fee 0 (open). This matches the `?? 0` defaults the activate routes use today.
3. One-off backfill, guarded by the same fee reads:
   - If the USSD fee is 0: `UPDATE ussd_shop_codes SET status='active', activation_fee_paid=true, activation_paid_at=now(), activation_fee_waived=true WHERE status='inactive' AND activation_fee_paid=false;` Suspended codes are not touched.
   - If the WhatsApp fee is 0: the same pattern for `whatsapp_activated=false` rows whose `status <> 'suspended'`.
4. Pre-check: count the rows each UPDATE will touch, and show them to the user before applying to prod.

### 4.2 Grandfathering

No extra mechanism is needed. A code opened while the fee was 0 has `status='active'`. Raising the fee changes only what the trigger writes for new codes. The existing dealer activate routes (`/api/dashboard/ussd-shop/activate`, `/whatsapp-activate`) keep working unchanged for codes created after a fee is set. They already return 409 "Already activated" for waived codes because `activation_fee_paid=true` / `whatsapp_activated=true`.

### 4.3 Admin

- Suspend/unsuspend on `/admin/ussd-shops` is unchanged. A suspended shop is closed on every channel.
- The admin fee inputs (USSD and WhatsApp activation fee) get one line of help text: "0 = every shop is open. Raising it affects only shops created after you save."

## 5. Error handling

- Inactive or suspended codes are still refused on every channel with today's messages.
- The Hubtel kill switch and mode toggle behave exactly as today.
- The migration's fee reads use `COALESCE(fee, 0)`. A missing settings row opens shops.

## 6. Testing

- **Shop flows (Uzo, Hubtel shop mode, WhatsApp):** update the existing tests. Entry succeeds at `token_balance = 0`, no deduction is called, inactive/suspended codes are still refused. Delete the tests for `billing-guard`, `token-deduction`, the low-session push and "no sessions left".
- **Paystack webhook:** WhatsApp shop sale branches no longer deduct.
- **Public shop-ussd-code:** active at `token_balance = 0`; inactive/suspended → inactive.
- **Migration:** run against a non-prod database or inside a transaction with rollback: trigger output at fee 0 and fee > 0 for both fees, backfill counts, suspended rows untouched.
- **Build:** `npx tsc --noEmit`, `npm run test:run`, and a real `next build` with placeholder env before pushing main.
- **Live:** after deploy, one shop purchase via Uzo and one via WhatsApp for a shop at `token_balance = 0` (and via Hubtel if the admin has it in shop mode). Then check that `token_balance` did not change.

## 7. Rollout order

1. Migration (pre-check counts shown to the user, then apply).
2. Deploy the code changes.
3. Live checks (section 6).
4. Update memory (project-shop-feature, project-whatsapp-shop-bot, project-hubtel-ussd).

## 8. Out of scope

- Hubtel routing changes (direct dial, a "Visit a shop" item, showing the Hubtel code on the dealer page or storefront).
- Dropping `token_balance`, `ussd_shop_token_purchases` and `deduct_ussd_shop_token` (later cleanup).
- Refunding leftover balances (D3).
- Any change to customer-side pricing.
