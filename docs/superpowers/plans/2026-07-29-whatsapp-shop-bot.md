# WhatsApp Shop Bot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A menu-driven WhatsApp bot on a dedicated number that lets a customer enter a sub-agent **shop code** (or tap a `wa.me` link) and buy Data / Airtime / Results Checker at that shop's prices, gated behind a one-time **WhatsApp activation fee** the owner pays on `/dashboard/ussd-shop`.

**Architecture:** New `shopWaRouter` (mirrors `lib/ussd-shop/router.ts`) reached when the webhook sees the shop number's `phone_number_id`. Shop pricing + order creation live in a shared, channel-agnostic `lib/shop-commerce` module that **both** the USSD shop and the WhatsApp bot call. Orders are written to the existing tables (`ussd_shop_orders` / `airtime_orders` / `results_checker_orders`) tagged `channel='whatsapp_shop'`, so the existing Paystack webhook fulfils them; the webhook also deducts one shop token per completed WhatsApp order.

**Tech Stack:** Next.js 15 App Router, TypeScript, Supabase (service-role), Upstash Redis (sessions), Paystack `chargeMobileMoney`/`submitOtp`, WhatsApp Cloud API (Graph v25), Vitest.

**Reference spec:** `docs/superpowers/specs/2026-07-29-whatsapp-shop-bot-design.md`

---

## File Structure

**Phase 1 — Foundation & plumbing**
- Create: `lib/shop-commerce/pricing.ts` — `shopOwnerIsDealer`, `basePrice`, `fetchShopBundles`, `verifyBundlePrice` (extracted from `lib/ussd-shop/handlers/bundles.ts`).
- Create: `lib/shop-commerce/shop-code.ts` — `resolveShopCode(code)` returning shop + `whatsappActivated` + `tokenBalance` (extracted/extended from `lib/ussd-shop/handlers/shop.ts`).
- Create: `lib/shop-commerce/orders.ts` — `createShopBundleOrder`, `createShopAirtimeOrder`, `createShopRcOrder` (channel param).
- Create: `lib/shop-commerce/*.test.ts` — unit tests (fake supabase client).
- Modify: `lib/ussd-shop/handlers/bundles.ts`, `lib/ussd-shop/handlers/shop.ts` — call the shared module (behaviour unchanged; regression-tested).
- Modify: `lib/whatsapp-bot/send.ts` — `sendWhatsAppText(to, body, phoneNumberId?)` parameterised.
- Modify: `app/api/whatsapp/webhook/route.ts` — route by `metadata.phone_number_id` to `shopWaRouter`.
- Create: `lib/whatsapp-bot/shop-router.ts` — Phase-1 stub (acknowledges the shop number); filled in Phase 3.

**Phase 2 — Activation gate & dashboard**
- Create: `migrations/20260729_whatsapp_shop_activation.sql` — `ussd_shop_codes.whatsapp_activated` + `whatsapp_activated_at`; `ussd_shop_token_purchases.is_whatsapp_activation`.
- Modify: `app/api/admin/settings/route.ts` — add `whatsapp_shop_activation_fee`.
- Modify: `app/admin/ussd-shops/page.tsx` — fee input beside the USSD activation fee.
- Create: `app/api/dashboard/ussd-shop/whatsapp-activate/route.ts` — initialise the activation charge.
- Modify: `app/api/webhooks/paystack/route.ts` — on a WhatsApp-activation `charge.success`, set `whatsapp_activated=true` (no tokens).
- Modify: `app/dashboard/ussd-shop/page.tsx` — 2 tabs (USSD | WhatsApp Bot), gated link + instructions.
- Modify: `components/layout/sidebar.tsx:82` — rename label to `"USSD/WhatsApp Bot"`.

**Phase 3 — WhatsApp shop bot flows**
- Create: `lib/whatsapp-bot/shop-session.ts` — Redis session (mirror `lib/ussd-shop/session.ts`, 30-min TTL).
- Create: `lib/whatsapp-bot/shop-menus.ts` — WhatsApp menu strings (mirror `lib/ussd-shop/menus.ts`).
- Fill in: `lib/whatsapp-bot/shop-router.ts` — full state machine + Data/Airtime/RC handlers.
- Modify: `app/api/webhooks/paystack/route.ts` — deduct 1 token on `whatsapp_shop` order `charge.success`.
- Create: `lib/whatsapp-bot/shop-router.test.ts` — state-machine + token-deduction tests.

---

## PHASE 1 — Foundation & plumbing

Goal: extract the shop commerce logic into `lib/shop-commerce`, prove the USSD shop still behaves identically, parameterise WhatsApp send, and route the shop number to a stub. Nothing user-facing changes.

### Task 1.1: Extract shop pricing into `lib/shop-commerce/pricing.ts`

**Files:**
- Create: `lib/shop-commerce/pricing.ts`
- Create: `lib/shop-commerce/pricing.test.ts`

- [ ] **Step 1: Write the failing test** (`lib/shop-commerce/pricing.test.ts`)

Mirror the existing fake-client test pattern (see `lib/sms/*.test.ts`). Test `basePrice` (pure) directly, and `fetchShopBundles` with a fake supabase.

```ts
import { describe, it, expect } from "vitest"
import { basePrice } from "./pricing"

describe("basePrice", () => {
  it("uses dealer_price for dealers when set", () => {
    expect(basePrice({ price: 10, dealer_price: 8 }, true)).toBe(8)
  })
  it("uses price for dealers when dealer_price is 0/absent", () => {
    expect(basePrice({ price: 10, dealer_price: 0 }, true)).toBe(10)
    expect(basePrice({ price: 10 }, true)).toBe(10)
  })
  it("uses price for non-dealers regardless of dealer_price", () => {
    expect(basePrice({ price: 10, dealer_price: 8 }, false)).toBe(10)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:run -- pricing`
Expected: FAIL — cannot find module `./pricing`.

- [ ] **Step 3: Implement `pricing.ts`**

Move `sizeToMb`, `shopOwnerIsDealer`, `basePrice`, and `fetchShopBundles` **verbatim** from `lib/ussd-shop/handlers/bundles.ts:21-155` into `lib/shop-commerce/pricing.ts` and `export` them. Also add a pure re-verify helper extracted from `handleConfirm` (`lib/ussd-shop/handlers/bundles.ts:340-405`):

```ts
// Returns the DB-verified retail price + profit split for a bundle, or null if the
// package is gone. Extracted from the USSD-shop confirm step so both channels
// re-verify identically (anti stale-session price attack).
export async function verifyBundlePrice(
  shopId: string,
  bundleId: string,
  parentShopId?: string,
): Promise<{ verifiedPrice: number; profitAmount: number; parentProfitAmount: number } | null> {
  // …exact logic from handleConfirm lines 347-401…
}
```
Keep the `ShopBundleOption` type import from `lib/ussd-shop/types` (or move it to `lib/shop-commerce/pricing.ts` and re-export from types — pick one and be consistent).

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:run -- pricing` → PASS. Then `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add lib/shop-commerce/pricing.ts lib/shop-commerce/pricing.test.ts
git commit -m "feat(shop-commerce): extract shop bundle pricing into a shared module"
```

### Task 1.2: `lib/shop-commerce/shop-code.ts` — resolve shop code (+ WhatsApp-activated)

**Files:**
- Create: `lib/shop-commerce/shop-code.ts`
- Create: `lib/shop-commerce/shop-code.test.ts`

- [ ] **Step 1: Failing test** — `resolveShopCode` returns `{ found:false }` for an unknown code; for a known active code returns `{ found:true, shopId, shopName, parentShopId, status, tokenBalance, whatsappActivated }`. Use a fake client returning a `ussd_shop_codes` row joined to `user_shops`.

- [ ] **Step 2: Run to verify it fails.** `npm run test:run -- shop-code` → FAIL.

- [ ] **Step 3: Implement.** Extract the lookup from `lib/ussd-shop/handlers/shop.ts:23-60` into a pure resolver (no token deduction here — deduction stays channel-specific). Select `whatsapp_activated` too:

```ts
export interface ResolvedShopCode {
  shopCodeId: string; shopId: string; shopName: string
  parentShopId: string | null; status: string
  tokenBalance: number; whatsappActivated: boolean
}
export async function resolveShopCode(code: string): Promise<ResolvedShopCode | null> {
  const { data: sc } = await supabase.from("ussd_shop_codes")
    .select("id, shop_id, status, token_balance, whatsapp_activated").eq("code", code.trim()).maybeSingle()
  if (!sc) return null
  const { data: shop } = await supabase.from("user_shops")
    .select("shop_name, parent_shop_id").eq("id", sc.shop_id).single()
  return {
    shopCodeId: sc.id, shopId: sc.shop_id, shopName: shop?.shop_name ?? "Shop",
    parentShopId: (shop as any)?.parent_shop_id ?? null, status: sc.status,
    tokenBalance: sc.token_balance, whatsappActivated: sc.whatsapp_activated === true,
  }
}
```
Note: `whatsapp_activated` column is added in Phase 2; until then the select errors — so in Phase 1, default it defensively: wrap the select and treat a missing column as `whatsappActivated:false` (Phase 2 migration makes it real). Simpler: this task lands **after** Phase 2's migration if executing strictly in order; if executing Phase 1 first, select without `whatsapp_activated` and hardcode `whatsappActivated:false`, then re-add the column read in Phase 2 Task 2.x. **Pick the ordering at execution and keep the resolver's return shape stable.**

- [ ] **Step 4: Pass.** `npm run test:run -- shop-code` → PASS; `tsc` clean.
- [ ] **Step 5: Commit.** `git commit -m "feat(shop-commerce): shared shop-code resolver with whatsapp-activated flag"`

### Task 1.3: `lib/shop-commerce/orders.ts` — channel-tagged order creation

**Files:**
- Create: `lib/shop-commerce/orders.ts`
- Create: `lib/shop-commerce/orders.test.ts`

- [ ] **Step 1: Failing test** — `createShopBundleOrder({...channel:'whatsapp_shop'})` inserts into `ussd_shop_orders` with `channel='whatsapp_shop'`, `shop_code_id`, the priced amount, and returns `{ orderId }`. Assert the inserted row via the fake client's captured payload.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement.** Extract the order INSERT from `handleConfirm` (`lib/ussd-shop/handlers/bundles.ts:432-455`) into `createShopBundleOrder`, adding a `channel` argument written to the row (USSD passes `'ussd_shop'`, WhatsApp passes `'whatsapp_shop'`). Signature:

```ts
export interface BundleOrderInput {
  shopCodeId: string; shopId: string; parentShopId: string | null
  dialingPhone: string; recipientPhone: string; network: string
  paystackProvider: string; bundleId: string; bundleSize: string
  verifiedPrice: number; profitAmount: number; parentProfitAmount: number
  chargeAmount: number; shopName: string | null
  customerEmail: string | null; shopOwnerEmail: string | null
  channel: "ussd_shop" | "whatsapp_shop"
}
export async function createShopBundleOrder(i: BundleOrderInput): Promise<{ orderId: string } | { error: string }> { … }
```
Add `createShopAirtimeOrder` and `createShopRcOrder` with the equivalent fields, extracted from `lib/ussd-shop/handlers/airtime.ts` and `results-checker.ts` order inserts (read those files during this task and mirror their insert payloads, adding `channel`). Airtime/RC orders already use `channel` (`'ussd_shop'`), so the change is just accepting the value as a param.

- [ ] **Step 4: Pass.** `tsc` clean.
- [ ] **Step 5: Commit.** `git commit -m "feat(shop-commerce): channel-tagged shop order creation (ussd_shop | whatsapp_shop)"`

### Task 1.4: Refactor USSD-shop handlers onto the shared module (regression-guarded)

**Files:**
- Modify: `lib/ussd-shop/handlers/bundles.ts`, `lib/ussd-shop/handlers/shop.ts`
- Modify: `lib/ussd-shop/handlers/airtime.ts`, `lib/ussd-shop/handlers/results-checker.ts`

- [ ] **Step 1: Characterisation test first.** Before changing USSD-shop, add a test that pins current pricing output for a representative fake shop (regular + sub-agent) via `fetchShopBundles`, so the refactor can't drift. `npm run test:run -- pricing` includes it.
- [ ] **Step 2: Replace** the in-file `sizeToMb/shopOwnerIsDealer/basePrice/fetchShopBundles` in `bundles.ts` with `import { … } from "@/lib/shop-commerce/pricing"`; replace the confirm-time re-verify block with `verifyBundlePrice(...)`; replace the order INSERT with `createShopBundleOrder({ …, channel: "ussd_shop" })`. Do the same shop-code lookup swap in `shop.ts` (call `resolveShopCode`, then keep the USSD-only token deduction + network build). Airtime/RC: route their order INSERTs through `createShop{Airtime,Rc}Order({ channel:"ussd_shop" })`.
- [ ] **Step 3: Run the full suite** `npm run test:run` → all green; `tsc` clean.
- [ ] **Step 4: Manual smoke note.** The USSD shop is exercised via the Uzo gateway; add a comment in the PR/commit to smoke-test a real USSD data purchase after deploy.
- [ ] **Step 5: Commit.** `git commit -m "refactor(ussd-shop): use shared lib/shop-commerce for pricing + order creation"`

### Task 1.5: Parameterise `sendWhatsAppText` for the shop number

**Files:**
- Modify: `lib/whatsapp-bot/send.ts:268-304`
- Create: `lib/whatsapp-bot/send-shop.test.ts` (or extend `send.test.ts`)

- [ ] **Step 1: Failing test.** Assert that `sendWhatsAppText(to, body, "SHOPID")` POSTs to `…/SHOPID/messages`, and that omitting the arg uses `WHATSAPP_PHONE_NUMBER_ID`. Mock `global.fetch`, capture the URL.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement.** Add an optional 3rd param defaulting to the env var:

```ts
export async function sendWhatsAppText(to: string, body: string, phoneNumberId?: string): Promise<string | null> {
  const pnid = phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID
  const token = process.env.WHATSAPP_ACCESS_TOKEN
  if (!pnid || !token) { console.error("[WA-SEND] …not set"); return null }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${pnid}/messages`
  // …unchanged…
}
```
Existing callers pass 2 args → unchanged. The shop bot passes `process.env.WHATSAPP_SHOP_PHONE_NUMBER_ID`.

- [ ] **Step 4: Pass.** `tsc` clean; full suite green.
- [ ] **Step 5: Commit.** `git commit -m "feat(whatsapp): sendWhatsAppText can target a specific phone_number_id"`

### Task 1.6: Route the shop number in the webhook → `shopWaRouter` stub

**Files:**
- Create: `lib/whatsapp-bot/shop-router.ts` (stub)
- Modify: `app/api/whatsapp/webhook/route.ts`

- [ ] **Step 1: Stub `shop-router.ts`.**

```ts
import { sendWhatsAppText } from "./send"
// Handles inbound messages that arrived on the dedicated shop WhatsApp number.
// Phase 1: acknowledge only. Phase 3 fills in the full menu state machine.
export async function shopWaRouter(from: string, _text: string, _inboundMsgId: string | null): Promise<void> {
  await sendWhatsAppText(from, "🛍️ Shop bot coming soon. Send your shop code to begin.", process.env.WHATSAPP_SHOP_PHONE_NUMBER_ID)
}
```

- [ ] **Step 2: Wire the webhook.** In `app/api/whatsapp/webhook/route.ts`, where the payload is parsed, read `const recvPnid = change?.value?.metadata?.phone_number_id`. Before the existing waRouter/AI dispatch, add:

```ts
if (recvPnid && recvPnid === process.env.WHATSAPP_SHOP_PHONE_NUMBER_ID) {
  const { shopWaRouter } = await import("@/lib/whatsapp-bot/shop-router")
  await shopWaRouter(from, text, msg.id)
  return NextResponse.json({ ok: true })   // do not fall through to the main bot
}
```
Place this **after** signature/verify handling and inbound logging, **before** `getWaSession`/`handleWithAI`. (Match the exact variable names in that file — `from`, `text`, `msg.id`, and the `change`/`value.metadata` path.)

- [ ] **Step 3: Test.** Add a webhook test (or a focused `shopWaRouter` test) asserting a shop-number payload calls `shopWaRouter` and does **not** invoke the main router. Mock the imports.
- [ ] **Step 4: Pass + `tsc`.**
- [ ] **Step 5: Commit + set env.** `git commit -m "feat(whatsapp): route the dedicated shop number to shopWaRouter"`. Add `WHATSAPP_SHOP_PHONE_NUMBER_ID` to Vercel (value from Meta → WhatsApp → API Setup).

**Phase 1 done:** USSD shop unchanged (now on shared commerce), the shop number replies with the stub. Deploy + smoke-test a USSD data purchase.

---

## PHASE 2 — Activation gate & dashboard

Goal: a shop can pay the one-time WhatsApp fee and, once paid, see its `wa.me` link + instructions in a new "WhatsApp Bot" tab. Bot still stubbed.

### Task 2.1: Migration — activation columns
- Create `migrations/20260729_whatsapp_shop_activation.sql`:
```sql
ALTER TABLE ussd_shop_codes
  ADD COLUMN IF NOT EXISTS whatsapp_activated BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_activated_at TIMESTAMPTZ;
ALTER TABLE ussd_shop_token_purchases
  ADD COLUMN IF NOT EXISTS is_whatsapp_activation BOOLEAN NOT NULL DEFAULT false;
```
Apply via the Supabase Management API (see `reference-supabase-access`). Then in `lib/shop-commerce/shop-code.ts`, restore the real `whatsapp_activated` read (Task 1.2 note).
- Commit the migration file.

### Task 2.2: Admin fee setting `whatsapp_shop_activation_fee`
- Modify `app/api/admin/settings/route.ts` — add `whatsapp_shop_activation_fee` to the settings read (default 0) and the writable set (mirror `ussd_shop_activation_fee` at lines 58/150/270).
- Modify `app/admin/ussd-shops/page.tsx` — a numeric input beside the existing activation-fee field (mirror line 147/185), persisting `whatsapp_shop_activation_fee`.
- Test: extend the settings-route test (if present) or add one asserting the key round-trips.
- Commit.

### Task 2.3: Activation charge route + webhook flip
- Create `app/api/dashboard/ussd-shop/whatsapp-activate/route.ts` (mirror `app/api/dashboard/ussd-shop/activate/route.ts`): auth the shop owner, load their `ussd_shop_codes` row, reject if `whatsapp_activated` already true or fee ≤ 0, create a `ussd_shop_token_purchases` row `{ is_whatsapp_activation:true, tokens_purchased:0, shop_code_id, shop_id }`, and initialise a Paystack charge (reuse the existing activation payment pattern; reference = purchase id or a `wallet_payments` row with `order_type` marking it).
- Modify `app/api/webhooks/paystack/route.ts` — in the `ussd_shop_token_purchases` branch (route.ts:207-273 / 860-935), when `is_whatsapp_activation` is true, set `ussd_shop_codes.whatsapp_activated=true, whatsapp_activated_at=now()` and **skip** the token/activation credit. Guard idempotently on `payment_status`.
- Tests: webhook flips the flag without granting tokens; route rejects double-activation.
- Commit.

### Task 2.4: Dashboard 2 tabs + gated link/instructions
- Modify `app/dashboard/ussd-shop/page.tsx` — wrap existing content in a "USSD" tab; add a "WhatsApp Bot" tab. When `whatsapp_activated` is false: show fee + "Activate WhatsApp Shop" button → POST the Task 2.3 route → redirect to Paystack. When true: show the `wa.me/${SHOP_NUMBER}?text=${code}` link (copy button) + an instructions block mirroring the existing USSD instructions section. Fetch the code's `whatsapp_activated` in the page's existing data load. Expose the shop number to the client via `NEXT_PUBLIC_WHATSAPP_SHOP_NUMBER` (display number, not the id).
- Modify `components/layout/sidebar.tsx:82` — label `"USSD Shop"` → `"USSD/WhatsApp Bot"`.
- Test: none required for the label; add a small render/logic test only if the page has existing tests.
- Commit.

**Phase 2 done:** owners can activate + see the link/instructions; deduct/bot still pending.

---

## PHASE 3 — WhatsApp shop bot flows

Goal: fill in `shopWaRouter` with the full menu flow for all three products, and deduct a token on completion.

### Task 3.1: `lib/whatsapp-bot/shop-session.ts`
- Mirror `lib/ussd-shop/session.ts` (Upstash + in-memory fallback), key `wa-shop:session:<phone>`, TTL 1800s. Session type mirrors `USSDShopSession` (`lib/ussd-shop/types.ts`) plus a `paymentPhone` field (WhatsApp asks for the MoMo number explicitly). Steps: `ENTER_CODE, SELECT_PRODUCT, SELECT_NETWORK, SELECT_BUNDLE, ENTER_RECIPIENT, ENTER_PAYMENT_PHONE, CONFIRM, SUBMIT_OTP` + airtime/RC equivalents.
- Test: set/get/delete round-trip with the in-memory fallback.
- Commit.

### Task 3.2: `lib/whatsapp-bot/shop-menus.ts`
- Mirror `lib/ussd-shop/menus.ts` but return plain WhatsApp text (no USSD `CON/END`). Reuse `sortNetworks` from the shared module. Menus: product menu, network menu, bundle menu (paged), recipient prompt, **payment-phone prompt** (new), confirm menu, OTP prompt, "payment sent" message.
- Test: a couple of formatting assertions.
- Commit.

### Task 3.3: `shopWaRouter` — Data flow
- Replace the Phase-1 stub. Load/instantiate the shop session; dispatch on `session.step`, mirroring `lib/ussd-shop/router.ts` + `handlers/bundles.ts`, but: render via `shop-menus`, send via `sendWhatsAppText(from, text, WHATSAPP_SHOP_PHONE_NUMBER_ID)`, and insert an **`ENTER_PAYMENT_PHONE`** step between recipient and confirm. `ENTER_CODE` calls `resolveShopCode` and **rejects** unless `status==='active' && tokenBalance>0 && whatsappActivated`. `CONFIRM` calls `verifyBundlePrice` + `createShopBundleOrder({channel:'whatsapp_shop'})`, then `chargeMobileMoney({ phone: session.paymentPhone, reference: orderId, … })`; on `send_otp`, go to `SUBMIT_OTP` and `submitOtp`. Log inbound/outbound via `logMessage` for inbox visibility.
- Tests: state-machine transitions (code→product→network→bundle→recipient→payment phone→confirm), activation-gate rejection, price re-verify mismatch → restart.
- Commit.

### Task 3.4: `shopWaRouter` — Airtime + Results Checker flows
- Mirror `lib/ussd-shop/handlers/airtime.ts` and `results-checker.ts` step-for-step, swapping I/O + adding the payment-phone step and `createShop{Airtime,Rc}Order({channel:'whatsapp_shop'})`.
- Tests: one happy-path each.
- Commit.

### Task 3.5: Token deduction on completion
- Modify `app/api/webhooks/paystack/route.ts` — in each branch that resolves a `whatsapp_shop`-channel order to `charge.success` (`ussd_shop_orders` / `airtime_orders` / `results_checker_orders`), after marking paid, call `supabase.rpc("deduct_ussd_shop_token", { p_shop_code_id: <order.shop_code_id> })`. Only for `channel==='whatsapp_shop'` (USSD already deducted at session entry). Idempotent: guard on the same "already processed" checks the branch already uses.
- Test: a `whatsapp_shop` order completion deducts exactly one token; a `ussd_shop` order does not.
- Commit.

**Phase 3 done:** end-to-end WhatsApp shop purchase works; token billed per completed order.

---

## Self-review (against the spec)

- **Entry/routing (spec §Entry):** Phase 1 Task 1.6 (route by `phone_number_id`). ✓
- **Send from shop number (spec §Sending):** Task 1.5. ✓
- **Shared `lib/shop-commerce` + USSD refactor (spec §Components):** Tasks 1.1–1.4. ✓
- **All three products (spec §Products):** Tasks 3.3–3.4. ✓
- **Per-order token billing (spec §Token):** Task 3.5 (deduct) + gate in 3.3. ✓
- **Activation unlock + admin fee + gated dashboard + sidebar (spec §Activation):** Tasks 2.1–2.4. ✓
- **`channel='whatsapp_shop'` into existing tables → existing webhook fulfils (spec §Data flow):** Task 1.3 + reuse. ✓
- **Tests (spec §Testing):** pricing/orders/shop-code units, router state machine, token-deduction, activation-flip. ✓

**Ordering note:** the `whatsapp_activated` column (Phase 2 Task 2.1) is read by `resolveShopCode` (Phase 1 Task 1.2). If executing strictly Phase-1-first, land Task 1.2 with `whatsappActivated:false` hardcoded and switch to the real column read in Task 2.1. Return shape stays stable so Phase 3's gate is unaffected.

**Config to set at rollout:** `WHATSAPP_SHOP_PHONE_NUMBER_ID` (server) + `NEXT_PUBLIC_WHATSAPP_SHOP_NUMBER` (display), the migration applied, `whatsapp_shop_activation_fee` set by the admin, and the dedicated number subscribed to the app webhook in Meta.
