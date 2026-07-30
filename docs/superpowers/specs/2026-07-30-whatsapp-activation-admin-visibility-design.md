# WhatsApp Activation Visibility on Admin USSD Shops Page

**Date:** 2026-07-30
**Status:** Approved
**Goal:** Give admins visibility into which shop codes have WhatsApp activated, and a manual grant/revoke override, on the existing `/admin/ussd-shops` page — coexisting with the current USSD-focused tabs.

## Background

`ussd_shop_codes` has `whatsapp_activated` (boolean) and `whatsapp_activated_at` (timestamp) columns, set via the shop owner's paid self-service flow (`lib/shop-commerce/whatsapp-activation.ts`'s `activateWhatsappShop`, an atomic claim-then-pay wallet deduction). The admin page (`app/admin/ussd-shops/page.tsx` + `app/api/admin/ussd-shops/route.ts`) never selects or displays either column — admins currently have no way to see WhatsApp activation status at all.

A parallel, already-shipped pattern exists for USSD activation itself: `/api/admin/ussd-shops/[id]/activate` lets an admin manually activate a shop code (`activation_fee_paid = true`) without a real payment, logging a `ussd_shop_token_purchases` row with `amount_paid: 0, payment_method: 'manual'` for revenue-report consistency. This design mirrors that exact pattern for WhatsApp activation.

## Changes

### 1. API: include WhatsApp fields in the existing list endpoint

`GET /api/admin/ussd-shops` (`app/api/admin/ussd-shops/route.ts`) adds `whatsapp_activated, whatsapp_activated_at` to its `ussd_shop_codes` select and to the mapped response object. No new endpoint needed for this — it's an additive field on the existing list.

### 2. New endpoint: manual grant

`POST /api/admin/ussd-shops/[id]/whatsapp-activate` — admin-only (same `requireAdmin` guard as every other admin ussd-shops route). No request body needed (unlike USSD activation, there's no "initial tokens" concept for WhatsApp — it shares the same token pool).

- 404 if the shop code doesn't exist.
- 409 if `whatsapp_activated` is already `true`.
- On success: `UPDATE ussd_shop_codes SET whatsapp_activated = true, whatsapp_activated_at = now(), updated_at = now() WHERE id = $1`.
- Logs a `ussd_shop_token_purchases` row: `{ shop_code_id, shop_id, tokens_purchased: 0, amount_paid: 0, payment_method: 'manual', payment_status: 'completed', is_whatsapp_activation: true }` — matches the schema `lib/shop-commerce/whatsapp-activation.ts` already writes on a real paid activation, so admin-granted and customer-paid activations show up consistently in any WhatsApp-activation revenue/count reporting (this one simply has `amount_paid: 0`).
- Sends the shop owner a push notification (mirrors the USSD activate endpoint's `sendPushToUser` call): title "WhatsApp Shop Activated", body naming the shop and code.
- Returns `{ success: true, whatsapp_activated: true }`.

### 3. New endpoint: manual revoke

`POST /api/admin/ussd-shops/[id]/whatsapp-deactivate` — admin-only.

- 404 if the shop code doesn't exist.
- 409 if `whatsapp_activated` is already `false`.
- On success: `UPDATE ussd_shop_codes SET whatsapp_activated = false, whatsapp_activated_at = null, updated_at = now() WHERE id = $1`.
- No payment/refund logic and no `ussd_shop_token_purchases` row — this is a pure access-flag toggle. Any fee the shop owner previously paid (real or manually-granted) stays an unaffected historical transaction record; revoking access doesn't reverse it.
- No push notification (revocation is an internal/support action, not something to alert the shop owner about proactively — consistent with how USSD suspension today also sends no push).
- Returns `{ success: true, whatsapp_activated: false }`.

### 4. Admin page: new "WhatsApp Active" tab

`app/admin/ussd-shops/page.tsx` gains a fourth tab, positioned after "Active Codes" and before "Orders": **"WhatsApp Active (`{count}`)"**.

Table columns: Code, Shop, Activated (formatted `whatsapp_activated_at` date), Tokens, Orders, Actions. Same visual style as the existing "Active Codes" tab (badge-styled code, bold token count with the existing low/empty warning coloring).

Actions per row: a **"Revoke"** button (outline, destructive-leaning color, mirrors the existing "Suspend" button styling) that calls the deactivate endpoint and reloads.

Empty state: mirrors the existing tabs' empty-state pattern (centered icon + message, e.g. "No shops have WhatsApp activated yet.").

### 5. Admin page: WhatsApp badge in existing tables

The "Shop Codes" and "Active Codes" tables' Shop column gets a small green WhatsApp icon (from `lucide-react`, already a dependency — likely `MessageCircle` styled green, since this codebase doesn't have a literal WhatsApp brand icon available) rendered inline next to the shop name whenever that row's `whatsapp_activated` is `true`. No layout change otherwise.

### 6. Admin page: "Grant WhatsApp" action on non-activated rows

In the "Shop Codes" and "Active Codes" tables' Actions column, rows where `whatsapp_activated` is `false` get an additional small outline button — **"Grant WhatsApp"** — alongside the existing Tokens/Activate/Suspend/Delete buttons. Calls the new grant endpoint and reloads. Rows already `whatsapp_activated: true` don't show this button (the badge already communicates status; the revoke action lives on the dedicated tab, keeping the busier main tables from growing a second toggle button per row).

### 7. Admin page: stats card

The existing 5-card stats row (Activated & Active / Active Codes / Activation Revenue / Available Tokens / Today's Activations) gains a 6th card: **"WhatsApp Activated"** — count of `codes.filter(c => c.whatsapp_activated).length`, using a green-tinted icon consistent with the WhatsApp badge color chosen in section 5.

## Data flow

`loadAll()` (existing function) already fetches the full `codes` list from `GET /api/admin/ussd-shops` on page load and after every mutating action; no new fetch is introduced — the new tab, badges, and stat card all derive from the same `codes` state array once it includes the two new fields. The two new POST endpoints follow the exact `handleActivate`-style pattern already in the page (call endpoint → toast → `await loadAll()`).

## Out of scope

- No changes to the customer-facing paid WhatsApp activation flow or its wallet-deduction logic.
- No changes to the WhatsApp shop bot's own runtime logic (`lib/whatsapp-bot/shop-router.ts`, `shop-ai.ts`) — this is purely an admin visibility + manual override addition.
- No refund/reversal logic for revoked activations.
