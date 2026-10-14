# Commission Cashback — Bots Plan 1: Shared Bot Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the five bots share — config (`bots` surface, per-group switches, per-rail payment fees), `quoteBots`, bot order creation for Pay Bills / Network Plans, payment confirmation generalised to bot orders, migration, refunds and admin settings — so Plans 2–4 only add menus.

**Architecture:** Extend, don't fork. The storefront engine already does unpaid-order creation (`lib/storefront-commission/{bills,bundles}.ts`), confirmation (`confirm.ts`: guarded flip, shop share once, dispatch once, recoverable), and refunds (`lib/refunds`). Bots are the same shape with a different channel (`bots`), an optional shop, a `bot_surface`, and a rail-specific fee. Generalise those modules to accept `channel: "storefront" | "bots"`; storefront behaviour must stay byte-identical.

**Tech Stack:** Next.js 15, TypeScript, Supabase (service role), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-cashback-bots-design.md` (approved 2026-10-14). Live predecessors: Plan A storefronts (`e089b68e`), Plan B API (`744a11b4`).

## Global Constraints

- `quoteBots({ serviceKey, provider, faceAmount, rail: "paystack" | "hubtel", shop: boolean }, cfg)`: shop ⇒ buyer `storefrontCustomer` share + shop `storefrontShop`; no shop ⇒ buyer `customer` share, shop 0; `fee = ceil_to_pesewa(base × cfg.botFees[rail][group] / 100)`; `pay = base + fee`; provider gets face. Applied only when `cfg.enabled && cfg.surfaces.bots && cfg.botGroups[group]`.
- Config additions: `botGroups: Record<CashbackGroup, boolean>` (default false), `botFees: { paystack: Record<CashbackGroup, number>; hubtel: Record<CashbackGroup, number> }` (0–10 %, ≤ 2 dp, default 0); validator allows `surfaces.bots = true`. Saves send fully merged objects (like shares).
- Bot bills/bundles orders: `channel = 'bots'`, `bot_surface ∈ (hubtel_ussd, ussd, ussd_shop, whatsapp, whatsapp_shop)`, `shop_id` for shop bots, `buyer_phone` (dialing/WhatsApp number, 233 form), `user_id` NULL, `amount = face`, `paid_amount = pay`, `payment_fee_amount`, cashback snapshot incl. `shop_share_amount`, `pending` + `unpaid`.
- Ghana Water is not creatable from `bot_surface` `hubtel_ussd | ussd | ussd_shop` (WhatsApp only) — enforced in the order-creation helper, not just menus.
- Names returned by bot verify are masked (reuse `lib/storefront-commission/mask.ts`); bot verify tokens are bound to `"bot:" + bot_surface + ":" + (shopId ?? "main")`.
- Confirmation: `confirmStorefrontOrder` → `confirmCommissionOrder` accepting `channel ∈ {storefront, bots}`; all existing guarantees unchanged (pesewa-exact, guarded flip, share once, dispatch once, resumable, deduped alerts). Storefront tests must pass unchanged.
- Refunds: storefront-only checks (`BAD_CHANNEL` in the refund RPCs, app filters, `STOREFRONT_REFUNDS_FROM`) extended to `channel='bots'` rows; refund amount = `paid_amount`; clawback of the shop share when present.
- No product words in anything sent to Hubtel / Paystack / Hubtel checkout (opaque references, neutral descriptions).
- Migration: next free number (expected **0123**), additive, `IF NOT EXISTS`, `SET search_path = public`, REVOKE/GRANT; the refund RPCs copied verbatim from their latest definitions (0120) with only the channel checks widened.
- Edit/Write tools only for code edits; regexes in tested lib helpers; route files export only handlers + config. Real `next build` before pushing; before any push check local main/origin for foreign commits and chain `merge --ff-only && push`. Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Storefront regression: every storefront create/confirm/refund path behaves exactly as before (existing tests unchanged and passing) (Tasks 3–5).
2. A bot order paid twice / confirmed by two callbacks ⇒ one flip, one share, one Hubtel POST (Task 4).
3. Main-bot orders (no shop) never create a `shop_profits` row; shop-bot orders create exactly one (Tasks 3–4).
4. Ghana Water from a USSD `bot_surface` is refused server-side (Task 3).
5. Validator: bots fees out of range / 3 dp rejected; `bots` surface allowed; merged saves never wipe other rails' fees (Task 1).

---

### Task 1: Config + `quoteBots`

**Files:** `lib/cashback/config.ts`, `lib/cashback/quote.ts` (+ tests).
Produces `CashbackConfig.botGroups`, `CashbackConfig.botFees`, `export type BotRail = "paystack" | "hubtel"`, `export function quoteBots(i: { serviceKey; provider; faceAmount; rail: BotRail; shop: boolean }, cfg): StorefrontQuote` (same result shape as `quoteStorefront`, incl. `base`, `paymentFee`, `feeRate`). Tests: GHS 10 MTN 3.96 — main bot customer 25 % + paystack fee 1.95 ⇒ cashback 0.09, base 9.91, fee 0.20 (ceil 19.32p), pay 10.11, shop 0; shop bot 20/40 + hubtel fee 1 ⇒ cashback 0.07, base 9.93, fee 0.10 (ceil 9.93p), pay 10.03, shop 0.15; gate off ⇒ not applied; validator cases; merged save. Commit `feat(cashback): bots surface, groups, per-rail fees and quoteBots`.

### Task 2: Migration 0123

**Files:** `migrations/0123_cashback_bots.sql`.
- Channel CHECKs on `hubtel_bill_orders` / `hubtel_data_orders` add `'bots'`; `bot_surface text` + CHECK (five values, NULL allowed for non-bot rows) + CHECK `(channel <> 'bots' OR bot_surface IS NOT NULL)`; partial unique index `hubtel_data_orders (bot_surface, buyer_phone, idempotency_key) WHERE channel = 'bots'`; index `(channel, created_at)` if absent.
- Refund RPCs (`reserve_order_refund`, `complete_order_refund`, `fail_order_refund` — latest definitions in 0120): widen the storefront channel checks to `channel IN ('storefront','bots')` for bills/bundles; airtime unchanged (bot airtime rows have `user_id` NULL already, like storefront airtime).
- `cashback_margin_report`: `p_channel` accepts `'bots'` (bills/bundles via `channel`; airtime bot rows via the mapping in the plan for Plans 2–4 — for now bills/bundles only, documented).
Commit `feat(cashback): migration 0123 bot orders and refund channels (not applied)`.

### Task 3: Bot order creation (bills + bundles)

**Files:** create `lib/bot-commission/{orders,verify,catalog}.ts` (+ tests); generalise shared helpers in `lib/storefront-commission/{bills,bundles}.ts` where needed (keep storefront behaviour identical).
- `botVerifyBill(deps, ctx, input)` — ctx `{ botSurface, shopId?, rail, buyerPhone }`; masked names; token binding per Global Constraints; Ghana Water refused for USSD surfaces.
- `botCatalog(deps, ctx, network)` — catalog with `quoteBots` prices per plan + catalog tokens.
- `botCreateBillOrder(deps, ctx, { token, amount, expectedPay })` / `botCreateBundleOrder(deps, ctx, { token, recipient, idempotencyKey, expectedPay })` → `{ ok, order: { id, reference, payAmount, faceAmount, customerCashback, paymentFee } } | { ok:false, status, error, quote? }`; inserts per Global Constraints; idempotent on retry (bundle key; bill token → existing order).
- No HTTP routes here (bots call these in-process). Tests incl. Review Focus 3 and 4. Commit `feat(cashback): bot order creation for Pay Bills and Network Plans`.

### Task 4: Confirmation generalised

**Files:** `lib/storefront-commission/confirm.ts` (+ runtime + tests).
- Rename/export `confirmCommissionOrder` (keep `confirmStorefrontOrder` as an alias); accept rows with `channel ∈ {storefront, bots}`; shop share only when `shop_id` and `shop_share_amount > 0`.
- Expose a rail-agnostic entry `confirmBotPayment(table, orderId, { paidAmount, reference, alert })` for Plans 2–4 to call from the Hubtel USSD callback and the Paystack webhook/verify (the Paystack branch for `cs_bill`/`cs_bundle` order types already routes storefront rows — make it accept bot rows too; Hubtel USSD wiring is Plan 2).
- Tests: bot main (no share), bot shop (one share), double confirm, amount mismatch, resume after crash; all storefront tests unchanged. Commit `feat(cashback): confirmation for bot orders`.

### Task 5: Refunds

**Files:** `lib/refunds/*` (+ tests), `app/admin/refunds` (labels).
- Bot rows listed/refundable like storefront rows (channel `bots`), label "Bot · <surface>"; Paystack reversal for Paystack-rail payments, Moolre payout to `buyer_phone`, manual; Hubtel-checkout payments (Hubtel USSD) refund via Moolre payout or manual (no Paystack reversal). Clawback when a shop share exists. Commit `feat(cashback): bot orders in refunds`.

### Task 6: Admin settings

**Files:** `app/admin/hubtel-commission/cashback.tsx`, `app/api/admin/cashback/config/route.ts` (if needed), bills/bundles admin lists.
- Bots surface switch live; per-group "Sell on bots"; two fee sets (Paystack bots / Hubtel USSD) with helper text; live examples (main bot + shop bot); margin report `bots` channel; lists show channel "Bot" + surface. Commit `feat(cashback): admin bot settings`.

### Task 7: Verification + runbook

- Full vitest (9 known order-health failures only), tsc 0, real build. Runbook "Commission Cashback — Bots (engine)": apply 0123 before merge (pre/post checks incl. refund RPC smoke), what Plans 2–4 add, nothing customer-visible until a bot plan ships. Commit; STOP before migrating/pushing.

## Self-review

Spec §3 → Task 1; §4 orders/confirm → Tasks 3–4; §7 data → Task 2; refunds (§2) → Task 5; §6 admin → Task 6; menus (§5) are Plans 2–4; Ghana Water rule enforced in Task 3.
