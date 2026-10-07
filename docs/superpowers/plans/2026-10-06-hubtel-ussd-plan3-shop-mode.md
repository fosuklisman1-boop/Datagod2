# Hubtel USSD — Plan 3: Shop Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the single Hubtel USSD code serve the shop USSD menu when `hubtel_ussd_config.mode === "shop"`: "enter shop code" first (one shop session token per Hubtel session, never double-billed), then the shop's product menu with shop-priced data bundles, airtime and results-checker vouchers, each paid through Hubtel AddToCart, with shop (and parent-shop) profit credited exactly once after payment.

**Architecture:** The mode is read on `Initiation` and pinned into the Redis session (`session.mode`); the router dispatches a session to the main step table or a new `SHOP_STEPS` table by that pinned mode, so flipping the admin toggle never changes an in-flight session. Shop flows are new `flows/shop*.ts` modules on Plan 2's flow kit (`goto` / `say` / `finish` / `submitOrder` / `replaySubmittedOrder`), with shop business lookups behind a `ShopServices` dependency that reuses the channel-agnostic `lib/shop-commerce` modules. Token billing is guarded by a Redis `SET NX` marker per (Hubtel SessionId, shop code). `ussd_shop_orders` gets its own post-payment handler mirroring the Paystack webhook's shop block; shop airtime and shop vouchers reuse Plan 2's `airtime_orders` / `results_checker_orders` handlers unchanged (the shared library functions credit `merchant_commission` from `shop_id`).

**Tech Stack:** Next.js 15 App Router route handlers, TypeScript, Supabase (service-role client), Upstash Redis (session + billing marker), Vitest with hand-rolled fakes.

**Spec:** `docs/superpowers/specs/2026-10-05-hubtel-ussd-design.md` (read §4.2, §5, §5.1, §6, §8, §9 and §14). Plan 1 (executed, the style reference): `docs/superpowers/plans/2026-10-05-hubtel-ussd-core-and-data-bundles.md`. Plan 2 (executes BEFORE this plan; its interfaces are what this plan builds on): `docs/superpowers/plans/2026-10-06-hubtel-ussd-plan2-airtime-rc-afa.md`. Ledger with rulings that stand: `.superpowers/sdd/2026-10-05-hubtel-ussd-core-and-data-bundles/progress.md` and `final-fix-report.md`.

**Run this plan only after Plan 2 is complete and committed.** Plan 2's code was not final when this plan was written. Every task therefore starts with **Step 0: verify the Plan 2 interface as built**: grep the named files, confirm the exact names and signatures this task uses, and adapt this task's code to the real ones. Record every difference in the task report (old name → real name, file:line). If a difference changes behaviour (not just a name), stop and report instead of guessing.

## How the Uzo shop code bills tokens today (read before Task 2)

Found while planning (`lib/ussd-shop/handlers/shop.ts`, `bundles.ts`, `router.ts`, `migrations/deduct_ussd_shop_token.sql`):

- A token is deducted by `deduct_ussd_shop_token(p_shop_code_id)` (atomic `token_balance - 1 WHERE token_balance > 0 AND status = 'active'`, returns boolean) **at the moment a code is accepted**, before the caller has chosen anything.
- Uzo has **no explicit idempotency**. A second deduction is avoided only because the session moves from `ENTER_SHOP_CODE` to `SELECT_PRODUCT`, so a re-sent code is parsed as a (bad) product pick. Uzo DOES deduct again when the caller presses `0` on the network menu (it returns to `ENTER_SHOP_CODE`) or after a "Time limit exceeded" restart and re-enters the code.
- **A session that never pays keeps its deduction.** There is no refund on cancel, timeout or abandoned payment. The token pays for the session, not for a sale.
- The low-session push fires when `pre-read token_balance - 1 === 10`, to `user_shops.user_id`, fire-and-forget.
- The WhatsApp shop bot bills differently (one token per completed order, in the Paystack webhook, `channel = 'whatsapp_shop'` only). That does not apply here: Hubtel shop rows use `channel = 'ussd_shop'`.

This plan keeps those billing semantics (billed at code acceptance, not refunded) and only adds the guard that a single Hubtel session is never billed twice for the same shop code (D3).

## Decisions made while planning

The code and spec did not settle these. Each is the conservative choice; the cost if wrong is stated. Rulings from Plans 1 and 2 stand.

| # | Decision | Why | Cost if wrong |
|---|---|---|---|
| D1 | The mode is pinned as `session.mode` at Initiation. A session without `mode` (written by pre-Plan-3 code, at most 120 s old at deploy) runs as `main`. A Response with no session (expired / lost) first tries `replaySubmittedOrder`, then restarts in the CURRENT config mode; so does a stored session whose step is unknown to its pinned mode's table. | Spec §4.2 and the brief. Replay before restart keeps a paid-for cart replayable across a mode flip. | None. |
| D2 | The kill switch beats pinning: `enabled = false` releases every request, including in-flight shop sessions. | Brief: shop mode must respect the Hubtel kill switch. Same as main mode today. | A caller mid-flow is cut off when the admin turns the channel off (intended). |
| D3 | Token billing: one token per **(Hubtel SessionId, shop code)**. A Redis `SET NX` marker `ussd-hubtel:shop-billed:{sid}:{shopCodeId}` (TTL 1 h) is claimed BEFORE `deduct_ussd_shop_token`; it is released if the balance is 0 or the RPC does not deduct. Marker store error ⇒ "Shop unavailable. Try again." with NO deduction. Re-entering the same code in the same Hubtel session (lost-reply retry, concurrent duplicate, "Session expired" restart) is accepted without a second deduction, even if the balance has since reached 0. A different shop's code in the same session bills that shop. | Hubtel can redeliver a request and a restart re-asks for the code within the same SessionId; Uzo has no guard for either. Otherwise Uzo's billing semantics are kept exactly (billed at acceptance, never refunded). | One extra Redis call per code entry. If a marker `release` itself fails, that session can re-enter the code once without paying (logged). |
| D4 | The "no services" check runs at Initiation (before the code is asked), like main mode: if data / airtime / results checker are all hidden for this caller, release "No services available right now." | Avoids taking a shop token for a menu with nothing in it (Uzo would bill and show an empty menu). This is not a billing change for any usable session. | None. |
| D5 | `0` on the shop network menu returns to the shop product menu, not to code entry (Uzo returns to code entry and re-bills). `0` on the product menu releases "Goodbye." (Uzo). | No path back into code entry inside a session, so no second billing path. | A caller who wants a different shop must redial. |
| D6 | Shop product menu: header = shop display name (printable ASCII, whitespace collapsed, max 30 chars, "Shop" if empty) + "What would you like to buy?"; items `Buy Data Bundle`, `Buy Airtime`, `Results Checker`; `0. Exit`. Real network names (`MTN`, `Telecel`, `AT iShare`, `AT BigTime`; any other `packages.network` value is shown as stored). Never the Uzo nicknames or "Browse Services". | Spec §4.4; a long display name must not push menu items past the 182-char USSD cut. | Long shop names are shortened on screen only. |
| D7 | Visibility for the shop menu = `hubtel_ussd_config.visibility` (`data`, `airtime`, `resultsChecker`; `afa` is ignored: the shop menu has no AFA) AND `IMPLEMENTED_SERVICES` AND, for data, `!dataBlocked`. Uzo's shop menu uses the Uzo toggles (`getUssdServiceVisibility`); this channel uses its own (spec §9). `dataBlocked` comes from the same `isDataBlocked` as main mode, at Initiation; Uzo's repeat whitelist check at network select is not repeated (same inputs). Visibility is read per request (not pinned), exactly like main mode. | Mirror Uzo's gating with Hubtel's own settings. | None. |
| D8 | `ussd_shop_orders` row = `createShopBundleOrder`'s shape, written by `submitOrder`: `amount` = `shop_price` = verified shop price (no Paystack fee), `profit_amount` / `parent_profit_amount` snapshotted from `verifyBundlePrice` at confirm, `channel = 'ussd_shop'`, `paystack_provider = paystackProviderFromPhone(dialer) ?? 'mtn'` (NOT NULL column, unused here), `paystack_reference` left NULL (refunds fall back to the order id, as for Plan 1's `ussd_orders`), `shop_name` canonical, `customer_email` via `resolveEmail` (Uzo), `shop_owner_email` as Uzo. Uzo's "Payment not available for your number" refusal is dropped (it was a Paystack provider limit). | Same columns and money values as Uzo minus Paystack. | None. |
| D9 | Shop airtime / vouchers rows = `createShopAirtimeOrder` / `createShopRcOrder` shapes (`shop_id`, `merchant_commission`, `channel = 'ussd_shop'`, `user_id` null / omitted, `customer_email` null), `total_paid` = what the caller pays (no fee added). They are fulfilled by Plan 2's `airtime_orders` / `results_checker_orders` handlers UNCHANGED: `markAirtimeOrderPaid` and `fulfillPaidResultsCheckerOrder` credit `merchant_commission` to `shop_id` themselves (exactly what the Paystack webhook relies on). No token is deducted after payment (`channel` is never `whatsapp_shop`). | Brief: extend, do not fork; one code path for a table. | None. |
| D10 | `ussd_shop_orders` handler: the conditional mark `pending/otp_required → completed` (`UPDATE … RETURNING`) is the once-only gate (+ `processFulfillment`'s claim); profit, parent profit, customer tracking, `fulfillUssdOrder(…, "ussd_shop_orders")` and the recipient SMS (no community link) follow, as in the webhook. Two deliberate differences: (a) a fulfilment that THROWS leaves `order_status = 'pending'` (manual queue; the webhook sets `'failed'`, a dead end for a paid order) and (b) a failed `shop_profits` insert or an untriggered fulfilment makes the handler THROW at the end (after the customer has been served) so the tx row lands in `needs_review` instead of passing silently. | Spec §8: failures must be loudly visible; `shop_profits` has no unique key on `ussd_shop_order_id`, so a silent miss is never repaired. The handler is never re-run for a `needs_review` row, so throwing late cannot double-credit. | An admin must fix the profit row / fulfil manually, then Mark resolved. |
| D11 | Price drift between the confirm screen and "1" releases with "Price changed … restart" and creates no order, for all three shop flows (Plan 2 D6), including vouchers, where the Uzo shop silently re-priced. | The Hubtel cart must equal the confirm screen. | Rare extra restart. |
| D12 | Shop airtime keeps Uzo's prefix auto-detect and manual network pick and adds Plan 2's D7 (admin prefix validation when on) and D8 (strict amount regex). Fee: base rate for the SHOP OWNER's tier (`shopOwnerIsDealer`: dealer/admin ⇒ dealer rate) + the shop's `airtime_markup_{network}` capped at `10 - base` (and at least 0); `merchant_commission = round2(toDeliver × markup / 100)`, all as in Uzo's private `shopAirtimeFeeRate` (ported). | Same money as Uzo shop airtime. | None. |
| D13 | Shop vouchers: product "Results Checker" goes straight to the board list (enabled AND in stock), then quantity, then confirm, exactly the Uzo shop flow: no sub-menu, no "My Vouchers", no "Check Results". Price `calculateRCPrice({ examBoard, quantity, shopId, applyBulk: true })` (shop markup, bulk base when the threshold is met); the bulk hint shows the shop price at the threshold, as Uzo. | Follow exactly what the Uzo shop offers. | None. |
| D14 | Vouchers out of stock AFTER payment: Plan 2's handler throws ⇒ `needs_review`; the shared service credits `merchant_commission` only on automatic delivery, so the runbook tells the admin to credit the shop by hand when delivering manually (same gap as the Paystack path). | Reuse without forking the RC service. | Manual step for a rare case; documented. |
| D15 | Shop code input must match `^[A-Za-z0-9]{1,8}$` (`ussd_shop_codes.code` is `VARCHAR(8)`, generated as 4-6 digits) before any DB lookup; otherwise "Invalid code. Try again.". The code prompt uses `FieldType: "text"` (App/Webstore keyboards must allow any stored code). | Cheap input hygiene. | None. |
| D16 | Shop-specific lookups live in a new `ShopServices` dependency (`lib/ussd-hubtel/shop-services.ts`); Plan 2's `AirtimeServices` and `RcServices` are reused for limits / enabled / stock and are NOT changed. Shop steps are `SHOP_*` names in a separate `SHOP_STEPS` table. | Plan 2 interfaces stay stable; no step-name collision between modes. | None. |
| D17 | The admin config route accepts `mode: "shop"` and the page enables the option only in Task 7, after every shop flow exists. `setHubtelUssdConfig` already accepts it. | The route is the release gate: shop mode cannot be selected while partly built. | None. |

## Global Constraints

Every task's requirements implicitly include these.

- **Payment is Hubtel-only.** Every purchase ends in `AddToCart`. No wallet, Paystack, OTP, `PAYMENT_METHOD`, `SUBMIT_OTP` or pending-OTP-redial step on this channel (spec §5). The Uzo shop router's pending-OTP lookup at `op === 1` is NOT ported.
- **Order amount = OUR / the SHOP's price**, no Paystack fee added; `hubtel_transactions.expected_amount` = that same price (via `submitOrder`); the customer pays Hubtel's charge on top at Hubtel (spec §14).
- **The fulfilment callback is ALWAYS `success`**; failures go to `needs_review` (spec §8).
- **Fulfilment only through `processFulfillment`'s atomic claim.** Never call an order handler from the router, a flow or an admin route.
- **Payment fields are persisted before a handler runs** (already in `payment.ts`; do not change `payment.ts` or `status-check.ts`).
- **Handlers must be safe:** throw (⇒ `needs_review`) when the order is not in a payable state; never fulfil twice; never credit profit twice; never send an SMS for a non-payable order.
- **Phones:** Hubtel `Mobile` arrives as `233…`. Normalise with `toLocalPhone` / `toE164` from `lib/ussd-hubtel/protocol.ts`. `dialing_phone` is stored E.164 (`+233…`, Plan 1 convention); recipient / beneficiary / customer phones are stored local `0XXXXXXXXX`.
- **Hubtel messages:** printable ASCII + `\n` only, 182-char limit on `USSD` (Webstore / Hubtel-App untruncated). Always reply through `respond` / `release` / `addToCart` (via the flow-kit helpers `say` / `goto` / `finish` / `submitOrder`). No `·`, `—`, `✓`, emoji or other non-ASCII in menu text; shop names go through `shopHeader`.
- **Real network names** (MTN, Telecel, AT iShare, AT BigTime for data; MTN, Telecel, AT for airtime). Never the Uzo nicknames "Yellow Plans / Tele / Instant Blue / Delay Blue" or "Browse Services" (spec §4.4).
- `hubtel_transactions.order_table` CHECK is fixed by `migrations/0106_hubtel_ussd.sql` (`ussd_orders, ussd_shop_orders, airtime_orders, results_checker_orders, results_check_requests, ussd_afa_orders`). `ussd_shop_orders` is already allowed. **This plan adds no migration.**
- **Shop money logic is written out in full in this plan** (prices, profit snapshot, parent profit, token billing, airtime markup, voucher markup). Never implement it as "same as Uzo" by calling a Uzo handler.
- **Do not modify** `app/api/webhooks/paystack/route.ts`, `lib/ussd/**`, `lib/ussd-shop/**`, `lib/shop-commerce/**`, `lib/airtime-service.ts`, `lib/airtime-pricing.ts`, `lib/results-checker-service.ts`, `lib/push-service.ts`, `lib/customer-tracking-service.ts`, `lib/ussd-hubtel/payment.ts`, `lib/ussd-hubtel/status-check.ts`. Every function this plan uses is already exported; no `export` additions are needed.
- `lib/ussd-hubtel/menus.ts` must stay client-safe (no Supabase or server imports): the admin page imports from it.
- Tests: `npx vitest run lib/ussd-hubtel` stays green after every task; `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok` prints `ok` after every task. The 9 pre-existing failures in `lib/order-health-service.test.ts` are unrelated: do not fix them.
- Commit after each task with a `feat(hubtel): …` / `test(hubtel): …` / `docs(hubtel): …` message ending in the `Co-Authored-By` line from the session's attribution reminder. Stage only the files the task names.

## Review Focus

Failure modes a person would hit that happy-path tests miss, most likely first. Each has a pinned test in the owning task.

1. **Shop code retried or re-entered in the same Hubtel session** (lost reply ⇒ same code re-sent; two concurrent deliveries; "Session expired" restart then the same code): exactly one token per (session, code); the balance reaching 0 after our own deduction must not lock the caller out → Task 2 ("token billing" describe).
2. **Invalid, inactive, suspended or malformed shop code; a shop with 0 tokens; the RPC refusing (balance hit 0 concurrently)**: re-prompt, no deduction, and the billing marker released so a later valid attempt can still deduct → Task 2.
3. **Admin flips main ⇄ shop while sessions are in flight, or a session expires across the flip**: in-flight sessions finish in their own mode; new and restarted sessions use the new mode; a paid-for cart still replays → Task 2 ("mode pinning") and Task 3 (replay across a flip).
4. **Shop with no packages / a network with no bundles / a sub-agent shop** (catalog under the parent, parent profit): "No packages available" without losing the session; sub-agent prices, `profit_amount` and `parent_profit_amount` come from `verifyBundlePrice` with the parent id → Task 3.
5. **Duplicate or concurrent Hubtel delivery for a shop data order**: shop profit and parent profit credited once, fulfilment once → Task 4 (handler-level concurrency + `processFulfillment` double delivery).
6. **Late payment on a shop order that already expired** (order failed): no profit, no fulfilment, no SMS; the row lands in `needs_review` → Task 4.
7. **Shop changed its margin / markup between the confirm screen and "1"**: release, no order, for data, airtime and vouchers → Tasks 3, 5, 6.
8. **Kill switch turned off while a shop session is in flight**: next request released, no further billing → Task 2.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/ussd-hubtel/shop-services.ts` (+test, new) | `ShopServices` interface + defaults (shop code, token RPC, low-token push, catalog, price verification, order context, shop airtime fee rate, shop voucher price); pure `capShopAirtimeMarkup`, `shopAirtimeQuote` | 1 |
| `lib/ussd-hubtel/billing-guard.ts` (+test, new) | `ShopBillingGuard`: one token per (SessionId, shop code) via Redis `SET NX` | 1 |
| `lib/ussd-hubtel/flow-kit.ts` | `RouterDeps` gains `shop`, `shopBilling` | 1 |
| `lib/ussd-hubtel/testing/fakes.ts` | `fakeShop`, `fakeShopBilling`, `SHOP_CODE` (Task 1), `SHOP_CONFIG` (Task 2) | 1, 2 |
| `lib/ussd-hubtel/types.ts` | `SHOP_*` steps; `mode` + shop session fields | 2 |
| `lib/ussd-hubtel/menus.ts` (+test) | Shop menu resolution, shop header, code prompts, shop network menu | 2 |
| `lib/ussd-hubtel/flows/shop.ts` (+test, new) | Shop session start, shop-code step (billing), product-menu helpers | 2 |
| `lib/ussd-hubtel/router.ts` (+test) | Mode pinning, mode-based dispatch, shop product step, `SHOP_PRODUCT_ENTRIES` | 2, 3, 5, 6 |
| `lib/ussd-hubtel/flows/shop-data.ts` (+test, new) | Shop data bundles → `ussd_shop_orders` | 3 |
| `lib/ussd-hubtel/order-tables.ts` (+test) | `ussd_shop_orders` registry entry (replay, rollback, expiry) | 3 |
| `lib/ussd-hubtel/order-handlers.ts`, `order-handlers.shop.test.ts` (new) | `ussd_shop_orders` post-payment handler; shop rows through the airtime / RC handlers | 4, 5, 6 |
| `lib/ussd-hubtel/flows/shop-airtime.ts` (+test, new) | Shop airtime → `airtime_orders` | 5 |
| `lib/ussd-hubtel/flows/shop-rc.ts` (+test, new) | Shop vouchers → `results_checker_orders` | 6 |
| `app/api/admin/ussd-hubtel/config/route.ts` (+test, new) | Accept `mode: "shop"` | 7 |
| `app/admin/ussd-hubtel/page.tsx` | Enable the "Shop USSD" option, shop-mode note | 7 |
| `scripts/hubtel-simulate.ts`, `docs/hubtel-ussd-runbook.md` | `SHOP=1` simulator path; shop-mode runbook | 8 |

---

### Task 1: Shop services and the token billing guard

The shop business lookups and the once-per-session billing marker, behind interfaces the router and flows use (no customer-visible change yet).

**Files:**
- Create: `lib/ussd-hubtel/shop-services.ts`, `lib/ussd-hubtel/shop-services.test.ts`
- Create: `lib/ussd-hubtel/billing-guard.ts`, `lib/ussd-hubtel/billing-guard.test.ts`
- Modify: `lib/ussd-hubtel/flow-kit.ts` (`RouterDeps`)
- Modify: `lib/ussd-hubtel/router.ts` (`defaultRouterDeps`)
- Modify: `lib/ussd-hubtel/testing/fakes.ts` (`makeDeps` defaults, `fakeShop`, `fakeShopBilling`, `SHOP_CODE`)

**Interfaces:**
- Consumes (Plan 2, verify in Step 0): `RouterDeps` in `lib/ussd-hubtel/flow-kit.ts`; `defaultRouterDeps(supabase)` in `router.ts`; `makeDeps(over?, sup?)` in `testing/fakes.ts`. Library: `resolveShopCode`, `fetchShopNetworks`, `getCanonicalShopName`, `ResolvedShopCode` (`lib/shop-commerce/shop-code.ts`); `fetchShopBundles`, `verifyBundlePrice`, `shopOwnerIsDealer` (`lib/shop-commerce/pricing.ts`); `airtimeBaseFeeRate`, `airtimeNetworkKey`, `splitInclusive` (`lib/airtime-pricing.ts`); `calculateRCPrice` (`lib/results-checker-service.ts`); `resolveEmail` (`lib/ussd/resolve-email.ts`); `sendPushToUser` (`lib/push-service.ts`, dynamic import); RPC `deduct_ussd_shop_token(p_shop_code_id uuid) returns boolean`.
- Produces (used by Tasks 2-6):
  - `shop-services.ts`: `type ResolvedShopCode` (re-export), `interface ShopAirtimeRates { totalFeeRate: number; merchantCommissionRate: number }`, `interface ShopServices { resolveCode(code: string): Promise<ResolvedShopCode | null>; deductToken(shopCodeId: string): Promise<boolean>; notifyLowTokens(shopId: string, shopName: string): Promise<void>; networks(shopId: string, parentShopId?: string): Promise<string[]>; bundles(shopId: string, network: string, parentShopId?: string): Promise<BundleOption[]>; verifyBundlePrice(shopId: string, bundleId: string, parentShopId?: string): Promise<{ verifiedPrice: number; profitAmount: number; parentProfitAmount: number } | null>; orderContext(shopId: string, dialingPhone: string): Promise<{ shopName: string; customerEmail: string | null; shopOwnerEmail: string | null }>; airtimeFeeRate(shopId: string, network: string): Promise<ShopAirtimeRates>; rcPrice(board: ExamBoard, quantity: number, shopId: string): Promise<{ unitPrice: number; totalPaid: number; bulkApplied: boolean; merchantCommission: number }> }`, `defaultShopServices(supabase): ShopServices`, `capShopAirtimeMarkup(baseRate: number, rawMarkup: number): number`, `shopAirtimeQuote(amount: number, rates: ShopAirtimeRates): { fee: number; toDeliver: number; commission: number }`, `shopAirtimeFeeRate(supabase, shopId, network): Promise<ShopAirtimeRates>`, `notifyLowTokens(supabase, shopId, shopName): Promise<void>`, `LOW_TOKEN_ALERT_AT = 10`.
  - `billing-guard.ts`: `type BillingClaim = "claimed" | "already" | "error"`, `interface ShopBillingGuard { claim(sessionId: string, shopCodeId: string): Promise<BillingClaim>; release(sessionId: string, shopCodeId: string): Promise<void> }`, `shopBillingGuard: ShopBillingGuard`, `SHOP_BILLING_TTL_SECONDS`.
  - `RouterDeps.shop: ShopServices`, `RouterDeps.shopBilling: ShopBillingGuard`.
  - `testing/fakes.ts`: `SHOP_CODE: ResolvedShopCode`, `fakeShop(over?: Partial<ShopServices>): ShopServices`, `fakeShopBilling(fixed?: BillingClaim): ShopBillingGuard & { claimed: Set<string> }`.

- [ ] **Step 0: Verify the Plan 2 interface as built**

Run:
```bash
grep -n "export interface RouterDeps" -A 20 lib/ussd-hubtel/flow-kit.ts
grep -n "export function defaultRouterDeps" -A 16 lib/ussd-hubtel/router.ts
grep -n "export function makeDeps" -A 22 lib/ussd-hubtel/testing/fakes.ts
grep -n "^import" lib/ussd-hubtel/testing/fakes.ts
```
Expected: `RouterDeps` lives in `flow-kit.ts` and ends with Plan 2's service fields (`resolveDialer`, `airtime`, `rc`, `afa` or similar); `defaultRouterDeps` builds them; `makeDeps` builds a `deps: RouterDeps` object with a `...over` spread last. Confirm the exact last field of each (Steps 4-5 append after it). If `RouterDeps` lives elsewhere, edit that file instead and note it.

- [ ] **Step 1: Write the failing billing-guard test**

```ts
// lib/ussd-hubtel/billing-guard.test.ts
import { describe, it, expect } from "vitest"
import { shopBillingGuard } from "./billing-guard"

// No UPSTASH env in unit tests: this exercises the in-process (dev) path, same SET NX semantics.
describe("shopBillingGuard (no redis configured)", () => {
  it("claims once per (session, code), then reports already", async () => {
    expect(await shopBillingGuard.claim("bg-1", "code-1")).toBe("claimed")
    expect(await shopBillingGuard.claim("bg-1", "code-1")).toBe("already")
  })
  it("a different session or a different code is a separate claim", async () => {
    expect(await shopBillingGuard.claim("bg-2", "code-1")).toBe("claimed")
    expect(await shopBillingGuard.claim("bg-2", "code-2")).toBe("claimed")
    expect(await shopBillingGuard.claim("bg-3", "code-1")).toBe("claimed")
  })
  it("release lets the same session claim again (deduction did not happen)", async () => {
    expect(await shopBillingGuard.claim("bg-4", "code-1")).toBe("claimed")
    await shopBillingGuard.release("bg-4", "code-1")
    expect(await shopBillingGuard.claim("bg-4", "code-1")).toBe("claimed")
  })
  it("two concurrent claims: exactly one wins", async () => {
    const r = await Promise.all([shopBillingGuard.claim("bg-5", "c"), shopBillingGuard.claim("bg-5", "c")])
    expect([...r].sort()).toEqual(["already", "claimed"])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/ussd-hubtel/billing-guard.test.ts`
Expected: FAIL with `Failed to resolve import "./billing-guard"`.

- [ ] **Step 3: Write the billing guard**

```ts
// lib/ussd-hubtel/billing-guard.ts
// Shop-mode token billing guard: at most ONE shop session token per (Hubtel SessionId, shop code).
// The Uzo shop code deducts a token every time a code is accepted and relies only on the session
// moving past the code step to avoid a second deduction. Hubtel can redeliver a request (lost
// reply, retry) and a "Session expired" restart re-asks for the code within the same SessionId,
// so the claim is an explicit Redis SET NX marker, taken BEFORE deduct_ussd_shop_token runs.
import { Redis } from "@upstash/redis"

export type BillingClaim = "claimed" | "already" | "error"

export interface ShopBillingGuard {
  /** "claimed": this call may deduct. "already": this session already paid for this code. "error": guard unavailable, do NOT deduct. */
  claim(sessionId: string, shopCodeId: string): Promise<BillingClaim>
  /** Undo a claim whose deduction did not happen (no balance, RPC false or error). */
  release(sessionId: string, shopCodeId: string): Promise<void>
}

/** Far longer than any Hubtel session; short enough not to pile up keys. */
export const SHOP_BILLING_TTL_SECONDS = 60 * 60

let redis: Redis | null = null
try {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  }
} catch (e) {
  console.error("[HUBTEL-SHOP-BILLING] Failed to initialise Redis:", e)
}

const memory = new Map<string, number>() // dev only (same env rule as session.ts): key -> expiry ms
const key = (sessionId: string, shopCodeId: string) => `ussd-hubtel:shop-billed:${sessionId}:${shopCodeId}`

export const shopBillingGuard: ShopBillingGuard = {
  async claim(sessionId, shopCodeId) {
    const k = key(sessionId, shopCodeId)
    if (redis) {
      try {
        const res = await redis.set(k, "1", { nx: true, ex: SHOP_BILLING_TTL_SECONDS })
        return res === "OK" ? "claimed" : "already"
      } catch (e) {
        console.error("[HUBTEL-SHOP-BILLING] claim error for", sessionId, ":", e)
        return "error"
      }
    }
    const now = Date.now()
    const exp = memory.get(k)
    if (exp !== undefined && exp > now) return "already"
    memory.set(k, now + SHOP_BILLING_TTL_SECONDS * 1000)
    return "claimed"
  },
  async release(sessionId, shopCodeId) {
    const k = key(sessionId, shopCodeId)
    if (redis) {
      // If this fails the marker stays: this session may re-enter the code once without a
      // deduction (logged). Never deduct to compensate.
      try { await redis.del(k) } catch (e) { console.error("[HUBTEL-SHOP-BILLING] release error for", sessionId, ":", e) }
      return
    }
    memory.delete(k)
  },
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/ussd-hubtel/billing-guard.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing shop-services test**

```ts
// lib/ussd-hubtel/shop-services.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ isDealer: vi.fn(), baseRate: vi.fn(), push: vi.fn() }))
vi.mock("@/lib/shop-commerce/pricing", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/shop-commerce/pricing")>()),
  shopOwnerIsDealer: (...a: any[]) => h.isDealer(...a),
}))
vi.mock("@/lib/airtime-pricing", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/airtime-pricing")>()),
  airtimeBaseFeeRate: (...a: any[]) => h.baseRate(...a),
}))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: (...a: any[]) => h.push(...a) }))

import {
  capShopAirtimeMarkup, defaultShopServices, notifyLowTokens, shopAirtimeFeeRate, shopAirtimeQuote,
} from "./shop-services"

/** select/eq chains resolve to `row`; records the column list asked for. */
function fakeDb(row: Record<string, unknown> | null, rpc?: { data: unknown; error: { message: string } | null }) {
  const selects: string[] = []
  const b: any = {
    select: (cols: string) => { selects.push(cols); return b },
    eq: () => b,
    single: async () => ({ data: row, error: null }),
    maybeSingle: async () => ({ data: row, error: null }),
  }
  const rpcCalls: any[] = []
  const client: any = {
    from: () => b,
    rpc: async (...a: any[]) => { rpcCalls.push(a); return rpc ?? { data: true, error: null } },
  }
  return { client, selects, rpcCalls }
}

beforeEach(() => {
  h.isDealer.mockReset().mockResolvedValue(false)
  h.baseRate.mockReset().mockResolvedValue(3)
  h.push.mockReset().mockResolvedValue({ sent: 1, removed: 0 })
})

describe("capShopAirtimeMarkup (total fee rate never above 10%)", () => {
  it("keeps a markup that fits, caps one that does not, never negative", () => {
    expect(capShopAirtimeMarkup(3, 5)).toBe(5)
    expect(capShopAirtimeMarkup(3, 9)).toBe(7)
    expect(capShopAirtimeMarkup(3, -2)).toBe(0)
    expect(capShopAirtimeMarkup(12, 1)).toBe(0)
  })
})

describe("shopAirtimeQuote", () => {
  it("splits the paid amount fee-inclusively and gives the shop the markup share of what is delivered", () => {
    // 10 paid at 7% inclusive: fee 0.65, delivered 9.35; commission 9.35 x 2% = 0.187 -> 0.19
    expect(shopAirtimeQuote(10, { totalFeeRate: 7, merchantCommissionRate: 2 })).toEqual({ fee: 0.65, toDeliver: 9.35, commission: 0.19 })
  })
  it("no markup: no commission", () => {
    expect(shopAirtimeQuote(10, { totalFeeRate: 3, merchantCommissionRate: 0 }).commission).toBe(0)
  })
})

describe("shopAirtimeFeeRate", () => {
  it("dealer-owned shop: dealer base rate + the shop's markup for the network", async () => {
    h.isDealer.mockResolvedValue(true)
    const { client, selects } = fakeDb({ airtime_markup_mtn: "4" })
    expect(await shopAirtimeFeeRate(client, "shop-1", "MTN")).toEqual({ totalFeeRate: 7, merchantCommissionRate: 4 })
    expect(h.isDealer).toHaveBeenCalledWith("shop-1")
    expect(h.baseRate).toHaveBeenCalledWith("MTN", true)
    expect(selects).toContain("airtime_markup_mtn")
  })
  it("caps the markup so the total stays at 10%", async () => {
    h.baseRate.mockResolvedValue(8)
    const { client } = fakeDb({ airtime_markup_telecel: 5 })
    expect(await shopAirtimeFeeRate(client, "shop-1", "Telecel")).toEqual({ totalFeeRate: 10, merchantCommissionRate: 2 })
  })
  it("no markup column value: base rate only, no commission", async () => {
    const { client } = fakeDb(null)
    expect(await shopAirtimeFeeRate(client, "shop-1", "AT")).toEqual({ totalFeeRate: 3, merchantCommissionRate: 0 })
  })
})

describe("deductToken (deduct_ussd_shop_token)", () => {
  it("true only when the RPC says a token was taken", async () => {
    const ok = fakeDb(null, { data: true, error: null })
    expect(await defaultShopServices(ok.client).deductToken("code-1")).toBe(true)
    expect(ok.rpcCalls[0]).toEqual(["deduct_ussd_shop_token", { p_shop_code_id: "code-1" }])
    const none = fakeDb(null, { data: false, error: null })
    expect(await defaultShopServices(none.client).deductToken("code-1")).toBe(false)
  })
  it("throws on an RPC error (the caller refuses the code and deducts nothing)", async () => {
    const bad = fakeDb(null, { data: null, error: { message: "boom" } })
    await expect(defaultShopServices(bad.client).deductToken("code-1")).rejects.toThrow(/boom/)
  })
})

describe("notifyLowTokens", () => {
  it("pushes Uzo's low-session warning to the shop owner", async () => {
    const { client } = fakeDb({ user_id: "owner-9" })
    await notifyLowTokens(client, "shop-1", "Ama Data Hub")
    expect(h.push).toHaveBeenCalledWith("owner-9", {
      title: "Low Sessions Warning",
      body: 'Your USSD shop "Ama Data Hub" has only 10 sessions remaining. Top up to avoid service interruption.',
      data: { url: "/dashboard/ussd-shop" },
    })
  })
  it("no owner: no push; a failing push never throws", async () => {
    await notifyLowTokens(fakeDb(null).client, "shop-1", "X")
    expect(h.push).not.toHaveBeenCalled()
    h.push.mockRejectedValue(new Error("push down"))
    await expect(notifyLowTokens(fakeDb({ user_id: "o" }).client, "shop-1", "X")).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run lib/ussd-hubtel/shop-services.test.ts`
Expected: FAIL with `Failed to resolve import "./shop-services"`.

- [ ] **Step 7: Write the shop services**

```ts
// lib/ussd-hubtel/shop-services.ts
// Shop-mode business lookups, behind an interface so router/flow tests use fakes. Defaults reuse
// the channel-agnostic lib/shop-commerce modules shared by the Uzo shop code and the WhatsApp
// shop bot. The two Uzo-private helpers (shop airtime fee rate in lib/ussd-shop/handlers/airtime.ts,
// low-session push in lib/ussd-shop/handlers/shop.ts) are ported here with identical money logic.
import type { SupabaseClient } from "@supabase/supabase-js"
import type { BundleOption } from "@/lib/ussd/types"
import type { ExamBoard } from "@/lib/results-check-validation"
import { airtimeBaseFeeRate, airtimeNetworkKey, splitInclusive } from "@/lib/airtime-pricing"
import { calculateRCPrice } from "@/lib/results-checker-service"
import { fetchShopBundles, shopOwnerIsDealer, verifyBundlePrice } from "@/lib/shop-commerce/pricing"
import { fetchShopNetworks, getCanonicalShopName, resolveShopCode, type ResolvedShopCode } from "@/lib/shop-commerce/shop-code"
import { resolveEmail } from "@/lib/ussd/resolve-email"

export type { ResolvedShopCode }

/** The low-session push fires when a deduction leaves exactly this many tokens (Uzo rule). */
export const LOW_TOKEN_ALERT_AT = 10

export interface ShopAirtimeRates {
  /** Platform base rate for the shop owner's tier + the shop's (capped) markup, in %. */
  totalFeeRate: number
  /** The shop's markup share, in %: becomes merchant_commission. */
  merchantCommissionRate: number
}

export interface ShopServices {
  resolveCode(code: string): Promise<ResolvedShopCode | null>
  /** deduct_ussd_shop_token: true only when a token was taken. Throws on an RPC error. */
  deductToken(shopCodeId: string): Promise<boolean>
  /** Uzo's low-session push to the shop owner. Never throws. */
  notifyLowTokens(shopId: string, shopName: string): Promise<void>
  /** Distinct packages.network values the shop's data catalog offers (unsorted). */
  networks(shopId: string, parentShopId?: string): Promise<string[]>
  /** Every bundle of `network` at the shop's price, smallest first. */
  bundles(shopId: string, network: string, parentShopId?: string): Promise<BundleOption[]>
  /** Shop price + profit snapshot straight from the DB; null when no longer sold. */
  verifyBundlePrice(
    shopId: string, bundleId: string, parentShopId?: string
  ): Promise<{ verifiedPrice: number; profitAmount: number; parentProfitAmount: number } | null>
  /** Values the Uzo shop stores on ussd_shop_orders besides the price. */
  orderContext(shopId: string, dialingPhone: string): Promise<{ shopName: string; customerEmail: string | null; shopOwnerEmail: string | null }>
  airtimeFeeRate(shopId: string, network: string): Promise<ShopAirtimeRates>
  /** Voucher price with the shop's markup (bulk base when the threshold is met), as the Uzo shop. */
  rcPrice(board: ExamBoard, quantity: number, shopId: string): Promise<{ unitPrice: number; totalPaid: number; bulkApplied: boolean; merchantCommission: number }>
}

/** Uzo shopAirtimeFeeRate cap: base + markup <= 10%, markup never negative. */
export function capShopAirtimeMarkup(baseRate: number, rawMarkup: number): number {
  return Math.max(0, Math.min(rawMarkup, 10 - baseRate))
}

/** Uzo shop airtime split: fee-inclusive; the shop earns the markup share of what is delivered. */
export function shopAirtimeQuote(amount: number, rates: ShopAirtimeRates): { fee: number; toDeliver: number; commission: number } {
  const { fee, toDeliver } = splitInclusive(amount, rates.totalFeeRate)
  const commission = parseFloat(((toDeliver * rates.merchantCommissionRate) / 100).toFixed(2))
  return { fee, toDeliver, commission }
}

export async function shopAirtimeFeeRate(supabase: SupabaseClient, shopId: string, network: string): Promise<ShopAirtimeRates> {
  const isDealer = await shopOwnerIsDealer(shopId) // dealer/admin owner => dealer base rate
  const baseRate = await airtimeBaseFeeRate(network, isDealer)
  const column = `airtime_markup_${airtimeNetworkKey(network)}`
  const { data: shop } = await supabase.from("user_shops").select(column).eq("id", shopId).single()
  const raw = (shop as Record<string, unknown> | null)?.[column]
  const rawMarkup = Number.parseFloat(String(raw ?? 0)) || 0
  const markup = capShopAirtimeMarkup(baseRate, rawMarkup)
  return { totalFeeRate: baseRate + markup, merchantCommissionRate: markup }
}

export async function notifyLowTokens(supabase: SupabaseClient, shopId: string, shopName: string): Promise<void> {
  try {
    const { data } = await supabase.from("user_shops").select("user_id").eq("id", shopId).maybeSingle()
    const ownerId = (data as { user_id?: string } | null)?.user_id
    if (!ownerId) return
    const { sendPushToUser } = await import("@/lib/push-service")
    // Fire-and-forget, as Uzo: a slow push must not delay the USSD reply.
    sendPushToUser(ownerId, {
      title: "Low Sessions Warning",
      body: `Your USSD shop "${shopName}" has only ${LOW_TOKEN_ALERT_AT} sessions remaining. Top up to avoid service interruption.`,
      data: { url: "/dashboard/ussd-shop" },
    }).catch(e => console.warn("[HUBTEL-SHOP] low-session push failed:", e))
  } catch (e) {
    console.warn("[HUBTEL-SHOP] low-session alert failed:", e)
  }
}

async function shopOrderContext(supabase: SupabaseClient, shopId: string, dialingPhone: string) {
  const [customerEmail, owner, shopName] = await Promise.all([
    resolveEmail(dialingPhone).catch(() => null),
    supabase.from("user_shops").select("user_id, users!inner(email)").eq("id", shopId).single().then(r => r.data),
    getCanonicalShopName(shopId),
  ])
  const shopOwnerEmail = (owner as { users?: { email?: string | null } } | null)?.users?.email ?? null
  return { shopName, customerEmail: customerEmail ?? null, shopOwnerEmail }
}

export function defaultShopServices(supabase: SupabaseClient): ShopServices {
  return {
    resolveCode: code => resolveShopCode(code),
    deductToken: async shopCodeId => {
      const { data, error } = await supabase.rpc("deduct_ussd_shop_token", { p_shop_code_id: shopCodeId })
      if (error) throw new Error(`deduct_ussd_shop_token failed: ${error.message}`)
      return data === true
    },
    notifyLowTokens: (shopId, shopName) => notifyLowTokens(supabase, shopId, shopName),
    networks: (shopId, parentShopId) => fetchShopNetworks(shopId, parentShopId ?? null),
    bundles: (shopId, network, parentShopId) => fetchShopBundles(shopId, network, parentShopId),
    verifyBundlePrice: (shopId, bundleId, parentShopId) => verifyBundlePrice(shopId, bundleId, parentShopId),
    orderContext: (shopId, dialingPhone) => shopOrderContext(supabase, shopId, dialingPhone),
    airtimeFeeRate: (shopId, network) => shopAirtimeFeeRate(supabase, shopId, network),
    rcPrice: async (examBoard, quantity, shopId) => {
      const r = await calculateRCPrice({ examBoard, quantity, shopId, applyBulk: true })
      return { unitPrice: r.unitPrice, totalPaid: r.totalPaid, bulkApplied: r.bulkApplied, merchantCommission: r.merchantCommission }
    },
  }
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run lib/ussd-hubtel/shop-services.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 9: Wire the dependencies and the test fakes**

In `lib/ussd-hubtel/flow-kit.ts` add, with the other type imports:

```ts
import type { ShopServices } from "./shop-services"
import type { ShopBillingGuard } from "./billing-guard"
```

and append at the end of `interface RouterDeps` (after its last field, as found in Step 0):

```ts
  shop: ShopServices
  shopBilling: ShopBillingGuard
```

In `lib/ussd-hubtel/router.ts` add `import { defaultShopServices } from "./shop-services"` and `import { shopBillingGuard } from "./billing-guard"`, and append inside the object `defaultRouterDeps` returns (after its last field):

```ts
    shop: defaultShopServices(supabase),
    shopBilling: shopBillingGuard,
```

In `lib/ussd-hubtel/testing/fakes.ts` add the imports:

```ts
import type { BillingClaim, ShopBillingGuard } from "../billing-guard"
import type { ResolvedShopCode, ShopServices } from "../shop-services"
```

append inside the `deps` object in `makeDeps`, BEFORE `...over`:

```ts
    shop: fakeShop(),
    shopBilling: fakeShopBilling(),
```

and append at the end of the file:

```ts
/** An active shop code with tokens, owned by a regular (non-sub-agent) shop. */
export const SHOP_CODE: ResolvedShopCode = {
  shopCodeId: "code-1", shopId: "shop-1", shopName: "Ama Data Hub", parentShopId: null,
  status: "active", tokenBalance: 50, whatsappActivated: false,
}

/** Shop lookups. Only code "1234" resolves (to SHOP_CODE). Numbers are chosen for readable assertions. */
export function fakeShop(over: Partial<ShopServices> = {}): ShopServices {
  return {
    resolveCode: async code => (code === "1234" ? { ...SHOP_CODE } : null),
    deductToken: async () => true,
    notifyLowTokens: async () => {},
    networks: async () => ["MTN", "Telecel"],
    bundles: async () => [{ id: "pkg-1", size: "5", price: 12 }],
    verifyBundlePrice: async () => ({ verifiedPrice: 12, profitAmount: 2, parentProfitAmount: 0 }),
    orderContext: async () => ({ shopName: "Ama Data Hub Ltd", customerEmail: "0200585542@ussd.datagod.com", shopOwnerEmail: "owner@example.com" }),
    airtimeFeeRate: async () => ({ totalFeeRate: 7, merchantCommissionRate: 2 }),
    rcPrice: async (_board, qty) => ({ unitPrice: 22, totalPaid: 22 * qty, bulkApplied: false, merchantCommission: 2 * qty }),
    ...over,
  }
}

/**
 * Same SET NX semantics as the Redis guard (claim body runs synchronously, so concurrent calls
 * race exactly like the real thing). `fixed` forces every claim result (e.g. "error").
 */
export function fakeShopBilling(fixed?: BillingClaim): ShopBillingGuard & { claimed: Set<string> } {
  const claimed = new Set<string>()
  return {
    claimed,
    claim: async (sid, code) => {
      if (fixed) return fixed
      const k = `${sid}:${code}`
      if (claimed.has(k)) return "already"
      claimed.add(k)
      return "claimed"
    },
    release: async (sid, code) => { claimed.delete(`${sid}:${code}`) },
  }
}
```

- [ ] **Step 10: Run the Hubtel suite and typecheck**

Run: `npx vitest run lib/ussd-hubtel`
Expected: PASS (all files; nothing uses the new deps yet).
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`. If tsc rejects `redis.set(k, "1", { nx: true, ex: … })`, check the installed `@upstash/redis` `SetCommandOptions` and keep the same NX + expiry meaning; note it in the report.

- [ ] **Step 11: Commit**

```bash
git add lib/ussd-hubtel/shop-services.ts lib/ussd-hubtel/shop-services.test.ts lib/ussd-hubtel/billing-guard.ts lib/ussd-hubtel/billing-guard.test.ts lib/ussd-hubtel/flow-kit.ts lib/ussd-hubtel/router.ts lib/ussd-hubtel/testing/fakes.ts
git commit -m "feat(hubtel): shop services and once-per-session token billing guard"
```

---

### Task 2: Mode pinning, shop-code step, shop product menu

`mode` is pinned at Initiation; shop sessions start with "Enter shop code"; an accepted code bills one token (D3) and shows the product menu. Product entries are registered by Tasks 3, 5 and 6 (until then a product pick re-shows the menu; shop mode cannot be selected in the admin before Task 7).

Step transitions (shop mode):

| Step | Input | Next |
|---|---|---|
| Initiation | (no shop service visible to this caller) | release "No services available…" |
| | | SHOP_ENTER_CODE ("Welcome to Datagod\nEnter shop code:\n0. Exit", text field) |
| SHOP_ENTER_CODE | `0` | release "Goodbye." |
| | not `^[A-Za-z0-9]{1,8}$`, unknown, or status not `active` | same, "Invalid code. Try again." (no deduction) |
| | marker store error | same, "Shop unavailable. Try again." (no deduction) |
| | marker claimed, balance `<= 0` | same, "Shop has no sessions left." (marker released) |
| | marker claimed, RPC false / throws | same, "Shop unavailable. Try again." (marker released) |
| | marker claimed, deducted | SHOP_PRODUCT (low-session push when balance-1 = 10) |
| | marker already held (this session paid for this code) | SHOP_PRODUCT, no deduction |
| SHOP_PRODUCT | `0` | release "Goodbye." |
| | visible item digit | that product's entry (Tasks 3, 5, 6) |
| | other | same menu |

**Files:**
- Create: `lib/ussd-hubtel/flows/shop.ts`, `lib/ussd-hubtel/flows/shop.test.ts`
- Modify: `lib/ussd-hubtel/types.ts` (steps, session fields)
- Modify: `lib/ussd-hubtel/menus.ts`, `lib/ussd-hubtel/menus.test.ts`
- Modify: `lib/ussd-hubtel/router.ts`, `lib/ussd-hubtel/router.test.ts`
- Modify: `lib/ussd-hubtel/testing/fakes.ts` (`SHOP_CONFIG`)

**Interfaces:**
- Consumes: Task 1 `RouterDeps.shop`, `RouterDeps.shopBilling`, `fakeShop`, `fakeShopBilling`, `SHOP_CODE`, `LOW_TOKEN_ALERT_AT`. Plan 2 (verify in Step 0): `FlowCtx`, `StepTable`, `StepHandler`, `say`, `goto`, `finish` (`flow-kit.ts`); `hubtelRouter`, `MAIN_MENU_ENTRIES`, `STEPS`, `startSession` (`router.ts`); `IMPLEMENTED_SERVICES`, `MainMenuKey`, `HUBTEL_NETWORKS`, `ResolvedMenuItem` (`menus.ts`); `makeDeps`, `req`, `digitFor` (`testing/fakes.ts`); `keyForDigit` (`lib/ussd/menu-items.ts`).
- Produces (used by Tasks 3-8):
  - `types.ts`: steps `SHOP_ENTER_CODE | SHOP_PRODUCT | SHOP_DATA_NETWORK | SHOP_DATA_BUNDLE | SHOP_DATA_RECIPIENT | SHOP_DATA_CONFIRM | SHOP_AIRTIME_ENTER_RECIPIENT | SHOP_AIRTIME_SELECT_NETWORK | SHOP_AIRTIME_ENTER_AMOUNT | SHOP_AIRTIME_CONFIRM | SHOP_RC_SELECT_BOARD | SHOP_RC_ENTER_QTY | SHOP_RC_CONFIRM`; session fields `mode?: "main" | "shop"`, `shopCodeId?`, `shopId?`, `parentShopId?`, `shopName?`, `shopNetworks?: string[]`.
  - `menus.ts`: `type ShopMenuKey = "data" | "airtime" | "resultsChecker"`, `resolveShopMenu(visibility: Record<MainMenuKey, boolean>, dataBlocked: boolean): ResolvedMenuItem<ShopMenuKey>[]`, `SHOP_NAME_MAX = 30`, `shopHeader(name: string): string`, `shopCodePromptText()`, `shopCodeRetryText(reason: string)`, `shopMenuText(shopName: string, resolved)`, `shopNetworkLabel(dbName: string)`, `sortShopNetworks(networks: string[])`, `shopNetworkMenuText(shopName: string, networks: string[])`.
  - `flows/shop.ts`: `startShopSession(req, deps, config, prefix): Promise<HubtelReply>`, `shopMenuFor(config, dataBlocked)`, `shopMenuReply(ctx, prefix?): HubtelReply`, `backToProduct(ctx, prefix?): Promise<HubtelReply>`, `SHOP_ENTRY_STEPS: StepTable`.
  - `router.ts`: `SHOP_PRODUCT_ENTRIES: Partial<Record<ShopMenuKey, StepHandler>>`; sessions dispatched by `session.mode`.
  - `testing/fakes.ts`: `SHOP_CONFIG: () => Promise<HubtelUssdConfig>`.

- [ ] **Step 0: Verify the Plan 2 interface as built**

Run:
```bash
grep -n "export type HubtelStep" -A 12 lib/ussd-hubtel/types.ts
grep -n "export interface HubtelSession" -A 50 lib/ussd-hubtel/types.ts
grep -n "export function say\|export async function goto\|export async function finish\|export type StepTable\|export type StepHandler\|export interface FlowCtx" lib/ussd-hubtel/flow-kit.ts
grep -n "config.mode\|startSession\|const STEPS\|MAIN_MENU_ENTRIES\|STEPS\[session.step\]\|^import" lib/ussd-hubtel/router.ts
grep -n "export const IMPLEMENTED_SERVICES" -A 6 lib/ussd-hubtel/menus.ts
grep -rn "mode: \"shop\"" lib/ussd-hubtel --include=*.test.ts
grep -n "export function digitFor\|export const req\|export function makeDeps" lib/ussd-hubtel/testing/fakes.ts
```
Expected: the router still contains the Plan 1/2 guard `if (!config.enabled || config.mode !== "main") return release(sid, UNAVAILABLE, { platform })`, `if (req.Type === "Initiation") return startSession(req, deps, config, "")`, the no-session `return startSession(req, deps, config, "Session expired.\n")`, and the dispatch `const handler = STEPS[session.step]` / `if (!handler) return startSession(req, deps, config, "")`. `startSession` writes `{ step: "MAIN", dialingPhone: toE164(req.Mobile), platform: req.Platform, dataBlocked }`. `IMPLEMENTED_SERVICES` has all four flags `true`. The only `mode: "shop"` test is router.test.ts's "releases in shop mode (not built yet)". Adapt Step 6's replacements to the real text and note differences.

- [ ] **Step 1: Steps and session fields**

In `lib/ussd-hubtel/types.ts`, add these members to the end of the `HubtelStep` union (after its last member):

```ts
  | "SHOP_ENTER_CODE" | "SHOP_PRODUCT"
  | "SHOP_DATA_NETWORK" | "SHOP_DATA_BUNDLE" | "SHOP_DATA_RECIPIENT" | "SHOP_DATA_CONFIRM"
  | "SHOP_AIRTIME_ENTER_RECIPIENT" | "SHOP_AIRTIME_SELECT_NETWORK" | "SHOP_AIRTIME_ENTER_AMOUNT" | "SHOP_AIRTIME_CONFIRM"
  | "SHOP_RC_SELECT_BOARD" | "SHOP_RC_ENTER_QTY" | "SHOP_RC_CONFIRM"
```

and add inside `interface HubtelSession`, directly after `platform: HubtelPlatform`:

```ts
  /** Pinned at Initiation (spec §4.2); absent = main (sessions written before Plan 3). */
  mode?: "main" | "shop"
  // Shop mode: set when the shop code is accepted
  shopCodeId?: string
  shopId?: string
  parentShopId?: string // sub-agent shops: the catalog lives under the parent shop
  shopName?: string // display name (ussd_display_name || shop_name), screen header only
  shopNetworks?: string[] // packages.network values the shop sells, in menu order
```

Shop flows reuse the existing fields `network`, `bundlePage`, `bundleId`, `bundleSize`, `bundlePrice`, `recipientPhone` (Plan 1), `airtimeRecipient`, `airtimeNetwork`, `airtimeAmount`, `airtimeFee`, `airtimeToDeliver`, `rcBoardOptions`, `rcBoard`, `rcQty`, `rcUnitPrice`, `rcTotal`, `rcBulkApplied` (Plan 2).

- [ ] **Step 2: Write the failing menus test**

Append to `lib/ussd-hubtel/menus.test.ts` (add the new names to its import from `./menus`: `resolveShopMenu, shopHeader, shopCodePromptText, shopCodeRetryText, shopMenuText, shopNetworkLabel, sortShopNetworks, shopNetworkMenuText`):

```ts
describe("shop menus", () => {
  const on = { data: true, afa: true, airtime: true, resultsChecker: true }
  it("lists data, airtime and results checker with real wording; never AFA", () => {
    expect(resolveShopMenu(on, false).map(i => i.label)).toEqual(["Buy Data Bundle", "Buy Airtime", "Results Checker"])
  })
  it("hides data for a whitelist-blocked caller and each service the admin hides", () => {
    expect(resolveShopMenu(on, true).map(i => i.key)).toEqual(["airtime", "resultsChecker"])
    expect(resolveShopMenu({ ...on, airtime: false }, false).map(i => i.key)).toEqual(["data", "resultsChecker"])
    expect(resolveShopMenu({ data: false, afa: true, airtime: false, resultsChecker: false }, false)).toEqual([])
  })
  it("shopHeader: printable ASCII, collapsed spaces, max 30 chars, never empty", () => {
    expect(shopHeader("Ama \u{1F31F} Data Hub & More Super Long Name Ltd")).toBe("Ama Data Hub & More Super Long")
    expect(shopHeader("\u{1F31F}\u{1F31F}")).toBe("Shop")
    expect(shopHeader("  Kofi's   Shop ")).toBe("Kofi's Shop")
  })
  it("code prompts", () => {
    expect(shopCodePromptText()).toBe("Welcome to Datagod\nEnter shop code:\n0. Exit")
    expect(shopCodeRetryText("Invalid code. Try again.")).toBe("Invalid code. Try again.\nEnter shop code:\n0. Exit")
  })
  it("product menu text", () => {
    expect(shopMenuText("Ama Data Hub", resolveShopMenu(on, false))).toBe(
      "Ama Data Hub\nWhat would you like to buy?\n1. Buy Data Bundle\n2. Buy Airtime\n3. Results Checker\n0. Exit"
    )
  })
  it("network labels and order: real names, known networks first, others as stored", () => {
    expect(shopNetworkLabel("AT-iShare")).toBe("AT iShare")
    expect(shopNetworkLabel("AirtelTigo")).toBe("AirtelTigo")
    expect(sortShopNetworks(["AT-BigTime", "Zeta", "MTN", "AirtelTigo", "Telecel"])).toEqual(["MTN", "Telecel", "AT-BigTime", "AirtelTigo", "Zeta"])
    const text = shopNetworkMenuText("Ama Data Hub", ["MTN", "AT-iShare"])
    expect(text).toBe("Ama Data Hub\nSelect Network:\n1. MTN\n2. AT iShare\n0. Back")
    for (const nick of ["Yellow Plans", "Tele\n", "Instant Blue", "Delay Blue"]) expect(text).not.toContain(nick)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run lib/ussd-hubtel/menus.test.ts`
Expected: FAIL (`resolveShopMenu` is not exported / `is not a function`).

- [ ] **Step 4: Add the shop menu functions**

Append to `lib/ussd-hubtel/menus.ts` (it already imports `MenuItemDef`, `ResolvedMenuItem`, `renderMenuText`, `resolveMenuItems`; keep it client-safe):

```ts
// ── Shop mode (Plan 3) ────────────────────────────────────────────────────────
// The shop product menu has no AFA (same as the Uzo shop code). Hubtel wording, not the Uzo
// "Browse Services" rebrand.
export type ShopMenuKey = "data" | "airtime" | "resultsChecker"

const SHOP_ITEMS: MenuItemDef<ShopMenuKey>[] = [
  { key: "data", label: "Buy Data Bundle" },
  { key: "airtime", label: "Buy Airtime" },
  { key: "resultsChecker", label: "Results Checker" },
]

/** Hubtel admin visibility (afa ignored) AND built AND, for data, not whitelist-blocked. */
export function resolveShopMenu(
  visibility: Record<MainMenuKey, boolean>,
  dataBlocked: boolean
): ResolvedMenuItem<ShopMenuKey>[] {
  return resolveMenuItems(SHOP_ITEMS, {
    data: visibility.data && IMPLEMENTED_SERVICES.data && !dataBlocked,
    airtime: visibility.airtime && IMPLEMENTED_SERVICES.airtime,
    resultsChecker: visibility.resultsChecker && IMPLEMENTED_SERVICES.resultsChecker,
  })
}

export const SHOP_NAME_MAX = 30

/** Shop display name for a screen header: printable ASCII, single spaces, at most 30 chars. */
export function shopHeader(shopName: string): string {
  const clean = shopName.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim().slice(0, SHOP_NAME_MAX).trim()
  return clean || "Shop"
}

export function shopCodePromptText(): string {
  return "Welcome to Datagod\nEnter shop code:\n0. Exit"
}

export function shopCodeRetryText(reason: string): string {
  return `${reason}\nEnter shop code:\n0. Exit`
}

export function shopMenuText(shopName: string, resolved: ResolvedMenuItem<ShopMenuKey>[]): string {
  return renderMenuText(`${shopHeader(shopName)}\nWhat would you like to buy?`, resolved, "0. Exit")
}

/** Real name for a packages.network value; values Hubtel does not list are shown as stored. */
export function shopNetworkLabel(dbName: string): string {
  return HUBTEL_NETWORKS.find(n => n.dbName === dbName)?.label ?? dbName
}

/** HUBTEL_NETWORKS order first, anything else after it alphabetically. */
export function sortShopNetworks(networks: string[]): string[] {
  const rank = (n: string) => {
    const i = HUBTEL_NETWORKS.findIndex(h => h.dbName === n)
    return i === -1 ? HUBTEL_NETWORKS.length : i
  }
  return [...networks].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

export function shopNetworkMenuText(shopName: string, networks: string[]): string {
  const lines = networks.map((n, i) => `${i + 1}. ${shopNetworkLabel(n)}`)
  return `${shopHeader(shopName)}\nSelect Network:\n` + lines.join("\n") + "\n0. Back"
}
```

Run: `npx vitest run lib/ussd-hubtel/menus.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing shop-entry tests**

Add to `lib/ussd-hubtel/testing/fakes.ts` (add `import type { HubtelUssdConfig } from "../config"` at the top):

```ts
/** Shop mode, every service visible. */
export const SHOP_CONFIG = async (): Promise<HubtelUssdConfig> => ({
  enabled: true, mode: "shop", visibility: { data: true, afa: true, airtime: true, resultsChecker: true },
})
```

```ts
// lib/ussd-hubtel/flows/shop.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { fakeShop, fakeShopBilling, makeDeps, req, SHOP_CODE, SHOP_CONFIG } from "../testing/fakes"

const PRODUCT_MENU = "Ama Data Hub\nWhat would you like to buy?\n1. Buy Data Bundle\n2. Buy Airtime\n3. Results Checker\n0. Exit"

/** Initiation in shop mode, then the code. Returns the reply to the code. */
async function enterShop(deps: RouterDeps, code = "1234", sid = "S1") {
  await hubtelRouter(req({ Type: "Initiation", SessionId: sid }), deps)
  return hubtelRouter(req({ Message: code, SessionId: sid }), deps)
}

describe("shop mode: initiation", () => {
  it("asks for the shop code first (text field) and pins mode=shop", async () => {
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toBe("Welcome to Datagod\nEnter shop code:\n0. Exit")
    expect(r.FieldType).toBe("text")
    expect(r.ClientState).toBe("SHOP_ENTER_CODE")
    expect(store.get("S1")).toMatchObject({ mode: "shop", step: "SHOP_ENTER_CODE", dialingPhone: "+233200585542", platform: "USSD", dataBlocked: false })
  })
  it("every shop service hidden for this caller: released before any code (no token can be spent)", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps } = makeDeps({
      getConfig: async () => ({ enabled: true, mode: "shop", visibility: { data: true, afa: true, airtime: false, resultsChecker: false } }),
      isDataBlocked: async () => true,
      shop: fakeShop({ deductToken }),
    })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toMatch(/no services/i)
  })
  it("'0' at the code prompt says goodbye", async () => {
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG })
    const r = await enterShop(deps, "0")
    expect(r.Type).toBe("release")
    expect(r.Message).toBe("Goodbye.")
  })
})

describe("shop mode: shop code (review focus #2)", () => {
  it("valid code: deducts ONE token, shows the product menu, stores the shop with sorted networks", async () => {
    const deductToken = vi.fn(async () => true)
    const networks = vi.fn(async () => ["AT-iShare", "MTN"])
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken, networks }) })
    const r = await enterShop(deps)
    expect(deductToken).toHaveBeenCalledTimes(1)
    expect(deductToken).toHaveBeenCalledWith("code-1")
    expect(networks).toHaveBeenCalledWith("shop-1", undefined)
    expect(r.Message).toBe(PRODUCT_MENU)
    expect(r.ClientState).toBe("SHOP_PRODUCT")
    expect(store.get("S1")).toMatchObject({
      mode: "shop", step: "SHOP_PRODUCT", shopCodeId: "code-1", shopId: "shop-1", shopName: "Ama Data Hub", shopNetworks: ["MTN", "AT-iShare"],
    })
    expect(store.get("S1")?.parentShopId).toBeUndefined()
  })
  it("sub-agent shop: the parent id is stored and used for the catalog", async () => {
    const networks = vi.fn(async () => ["MTN"])
    const { deps, store } = makeDeps({
      getConfig: SHOP_CONFIG,
      shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, parentShopId: "parent-1" }), networks }),
    })
    await enterShop(deps)
    expect(networks).toHaveBeenCalledWith("shop-1", "parent-1")
    expect(store.get("S1")?.parentShopId).toBe("parent-1")
  })
  const refused: Array<[string, Partial<typeof SHOP_CODE> | null, string]> = [
    ["unknown code", null, "1234"],
    ["inactive code", { status: "inactive" }, "1234"],
    ["suspended code", { status: "suspended" }, "1234"],
    ["malformed input", {}, "12#4"],
    ["too long", {}, "123456789"],
  ]
  for (const [name, patch, input] of refused) {
    it(`${name}: "Invalid code", no deduction, stays on the code step`, async () => {
      const deductToken = vi.fn(async () => true)
      const resolveCode = vi.fn(async () => (patch === null ? null : { ...SHOP_CODE, ...patch }))
      const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode, deductToken }) })
      const r = await enterShop(deps, input)
      expect(r.Message).toBe("Invalid code. Try again.\nEnter shop code:\n0. Exit")
      expect(deductToken).not.toHaveBeenCalled()
      expect(store.get("S1")?.step).toBe("SHOP_ENTER_CODE")
      if (input === "12#4" || input === "123456789") expect(resolveCode).not.toHaveBeenCalled()
    })
  }
  it("zero tokens: 'no sessions left', no deduction, marker released (a top-up then works in the same session)", async () => {
    let balance = 0
    const deductToken = vi.fn(async () => true)
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, tokenBalance: balance }), deductToken }) })
    const r = await enterShop(deps)
    expect(r.Message).toBe("Shop has no sessions left.\nEnter shop code:\n0. Exit")
    expect(deductToken).not.toHaveBeenCalled()
    balance = 5
    const ok = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(ok.Message).toBe(PRODUCT_MENU)
    expect(deductToken).toHaveBeenCalledTimes(1)
  })
  it("RPC deducts nothing (balance hit 0 concurrently): 'Shop unavailable', marker released", async () => {
    const deductToken = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken }) })
    const r = await enterShop(deps)
    expect(r.Message).toBe("Shop unavailable. Try again.\nEnter shop code:\n0. Exit")
    await hubtelRouter(req({ Message: "1234" }), deps)
    expect(deductToken).toHaveBeenCalledTimes(2) // the retry was allowed to deduct
  })
  it("RPC error: 'Shop unavailable', nothing billed", async () => {
    const deductToken = vi.fn(async () => { throw new Error("rpc down") })
    const billing = fakeShopBilling()
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken }), shopBilling: billing })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await enterShop(deps)
    err.mockRestore()
    expect(r.Message).toContain("Shop unavailable. Try again.")
    expect(billing.claimed.size).toBe(0)
  })
  it("billing marker store error: 'Shop unavailable' and NO deduction", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken }), shopBilling: fakeShopBilling("error") })
    const r = await enterShop(deps)
    expect(r.Message).toContain("Shop unavailable. Try again.")
    expect(deductToken).not.toHaveBeenCalled()
  })
  it("low-session push only when the deduction leaves exactly 10", async () => {
    for (const [balance, pushes] of [[11, 1], [12, 0], [10, 0]] as const) {
      const notifyLowTokens = vi.fn(async () => {})
      const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, tokenBalance: balance }), notifyLowTokens }) })
      await enterShop(deps)
      expect(notifyLowTokens, `balance ${balance}`).toHaveBeenCalledTimes(pushes)
      if (pushes) expect(notifyLowTokens).toHaveBeenCalledWith("shop-1", "Ama Data Hub")
    }
  })
})

describe("shop mode: token billing per Hubtel session (review focus #1)", () => {
  it("the same code re-sent after acceptance (lost reply): product menu again, ONE deduction", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken }) })
    await enterShop(deps)
    const again = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(again.Message).toBe(PRODUCT_MENU)
    expect(deductToken).toHaveBeenCalledTimes(1)
  })
  it("two concurrent deliveries of the code: ONE deduction, both see the product menu", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken }) })
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    const [a, b] = await Promise.all([hubtelRouter(req({ Message: "1234" }), deps), hubtelRouter(req({ Message: "1234" }), deps)])
    expect(deductToken).toHaveBeenCalledTimes(1)
    expect(a.Message).toBe(PRODUCT_MENU)
    expect(b.Message).toBe(PRODUCT_MENU)
  })
  it("session lost after acceptance, restarted, same code: no second deduction even at balance 0", async () => {
    let balance = 50
    const deductToken = vi.fn(async () => { balance -= 1; return true })
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, tokenBalance: balance }), deductToken }) })
    await enterShop(deps)
    store.delete("S1") // Redis TTL / miss
    balance = 0
    const restart = await hubtelRouter(req({ Message: "1" }), deps)
    expect(restart.Message).toBe("Session expired.\nWelcome to Datagod\nEnter shop code:\n0. Exit")
    const r = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(r.Message).toBe(PRODUCT_MENU)
    expect(deductToken).toHaveBeenCalledTimes(1)
  })
  it("a different shop's code in the same session bills that shop", async () => {
    const deductToken = vi.fn(async () => true)
    const resolveCode = async (code: string) =>
      code === "1234" ? { ...SHOP_CODE } : code === "5678" ? { ...SHOP_CODE, shopCodeId: "code-2", shopId: "shop-2", shopName: "Kofi Shop" } : null
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ resolveCode, deductToken }) })
    await enterShop(deps)
    store.delete("S1")
    await hubtelRouter(req({ Message: "1" }), deps)
    await hubtelRouter(req({ Message: "5678" }), deps)
    expect(deductToken.mock.calls).toEqual([["code-1"], ["code-2"]])
  })
  it("separate Hubtel sessions are billed separately", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken }) })
    await enterShop(deps, "1234", "S1")
    await enterShop(deps, "1234", "S2")
    expect(deductToken).toHaveBeenCalledTimes(2)
  })
})

describe("shop mode: product menu", () => {
  it("'0' says goodbye", async () => {
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG })
    await enterShop(deps)
    const r = await hubtelRouter(req({ Message: "0" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toBe("Goodbye.")
  })
  it("whitelist-blocked caller: no data item", async () => {
    const { deps } = makeDeps({ getConfig: SHOP_CONFIG, isDataBlocked: async () => true })
    const r = await enterShop(deps)
    expect(r.Message).toBe("Ama Data Hub\nWhat would you like to buy?\n1. Buy Airtime\n2. Results Checker\n0. Exit")
  })
  it("an admin-hidden service is not offered", async () => {
    const { deps } = makeDeps({ getConfig: async () => ({ enabled: true, mode: "shop", visibility: { data: true, afa: true, airtime: false, resultsChecker: true } }) })
    const r = await enterShop(deps)
    expect(r.Message).not.toContain("Buy Airtime")
  })
  it("an unknown pick re-shows the menu without billing again", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps, store } = makeDeps({ getConfig: SHOP_CONFIG, shop: fakeShop({ deductToken }) })
    await enterShop(deps)
    const r = await hubtelRouter(req({ Message: "9" }), deps)
    expect(r.Message).toBe(PRODUCT_MENU)
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
    expect(deductToken).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 6: Write the mode-pinning router tests**

In `lib/ussd-hubtel/router.test.ts` add `digitFor` and `fakeShop` to the import from `./testing/fakes`, and replace the test `"releases in shop mode (not built yet)"` with:

```ts
  it("shop mode answers Initiation with the shop-code prompt", async () => {
    const { deps } = makeDeps({ getConfig: async () => ({ enabled: true, mode: "shop", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }) })
    const r = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(r.Type).toBe("response")
    expect(r.Message).toContain("Enter shop code:")
  })
```

Append at the end of the file:

```ts
describe("hubtelRouter: mode pinning (spec 4.2, review focus #3)", () => {
  const ALL_ON = { data: true, afa: true, airtime: true, resultsChecker: true }

  it("a main session keeps running main after the admin flips to shop", async () => {
    let mode: "main" | "shop" = "main"
    const { deps, store } = makeDeps({ getConfig: async () => ({ enabled: true, mode, visibility: ALL_ON }) })
    const menu = await hubtelRouter(req({ Type: "Initiation" }), deps)
    expect(store.get("S1")?.mode).toBe("main")
    mode = "shop"
    const r = await hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Data Bundle") }), deps)
    expect(r.Message).toContain("Select Network:")
    expect(store.get("S1")?.step).toBe("SELECT_NETWORK")
  })
  it("a shop session keeps running shop after the admin flips to main", async () => {
    let mode: "main" | "shop" = "shop"
    const { deps, store } = makeDeps({ getConfig: async () => ({ enabled: true, mode, visibility: ALL_ON }) })
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    mode = "main"
    const r = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(r.Message).toContain("What would you like to buy?")
    expect(store.get("S1")).toMatchObject({ mode: "shop", step: "SHOP_PRODUCT" })
  })
  it("a NEW session uses the current mode", async () => {
    let mode: "main" | "shop" = "main"
    const { deps, store } = makeDeps({ getConfig: async () => ({ enabled: true, mode, visibility: ALL_ON }) })
    await hubtelRouter(req({ Type: "Initiation", SessionId: "S1" }), deps)
    mode = "shop"
    const r = await hubtelRouter(req({ Type: "Initiation", SessionId: "S2" }), deps)
    expect(r.Message).toContain("Enter shop code:")
    expect(store.get("S1")?.mode).toBe("main")
    expect(store.get("S2")?.mode).toBe("shop")
  })
  it("no session (expired, no order): restarts in the CURRENT mode", async () => {
    const { deps, store } = makeDeps({ getConfig: async () => ({ enabled: true, mode: "shop", visibility: ALL_ON }) })
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toBe("Session expired.\nWelcome to Datagod\nEnter shop code:\n0. Exit")
    expect(store.get("S1")).toMatchObject({ mode: "shop", step: "SHOP_ENTER_CODE" })
  })
  it("a session stored without a mode (written before Plan 3) runs as main even in shop mode", async () => {
    const { deps, store } = makeDeps({ getConfig: async () => ({ enabled: true, mode: "shop", visibility: ALL_ON }) })
    store.set("S1", { step: "MAIN", dialingPhone: "+233200585542", platform: "USSD" })
    const menu = await hubtelRouter(req({ Type: "Initiation", SessionId: "S9" }), makeDeps().deps) // main menu text, for the digit
    const r = await hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Data Bundle") }), deps)
    expect(r.Message).toContain("Select Network:")
  })
  it("a step unknown to the session's mode restarts in the current mode", async () => {
    const { deps, store } = makeDeps({ getConfig: async () => ({ enabled: true, mode: "main", visibility: ALL_ON }) })
    store.set("S1", { mode: "shop", step: "SELECT_NETWORK", dialingPhone: "+233200585542", platform: "USSD" })
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("Buy Data Bundle")
    expect(store.get("S1")?.mode).toBe("main")
  })
  it("kill switch releases an in-flight shop session and bills nothing more (review focus #8)", async () => {
    let enabled = true
    const deductToken = vi.fn(async () => true)
    const { deps } = makeDeps({ getConfig: async () => ({ enabled, mode: "shop", visibility: ALL_ON }), shop: fakeShop({ deductToken }) })
    await hubtelRouter(req({ Type: "Initiation" }), deps)
    enabled = false
    const r = await hubtelRouter(req({ Message: "1234" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toContain("Service unavailable")
    expect(deductToken).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 7: Run them to verify they fail**

Run: `npx vitest run lib/ussd-hubtel/flows/shop.test.ts lib/ussd-hubtel/router.test.ts`
Expected: FAIL: shop-mode Initiation is released by the old guard (`expected 'release' to be 'response'`), and the main-session mode assertion fails (`expected undefined to be 'main'`).

- [ ] **Step 8: Write the shop entry flow**

```ts
// lib/ussd-hubtel/flows/shop.ts
// Shop mode entry (spec §5 "Shop mode"): shop code first, then the shop's product menu. Port of
// lib/ussd-shop/handlers/shop.ts. Billing is Uzo's: one session token is deducted when the code
// is accepted and is never refunded if the caller does not buy. On this channel a Hubtel session
// pays at most once per shop code (deps.shopBilling), so retries and restarts never double-bill.
import type { HubtelUssdConfig } from "../config"
import {
  resolveShopMenu, shopCodePromptText, shopCodeRetryText, shopMenuText, sortShopNetworks, type MainMenuKey,
} from "../menus"
import { release, respond, toE164 } from "../protocol"
import { LOW_TOKEN_ALERT_AT } from "../shop-services"
import { finish, goto, say, type FlowCtx, type RouterDeps, type StepTable } from "../flow-kit"
import type { HubtelReply, HubtelRequest, HubtelSession } from "../types"

const CODE = { label: "Shop code", fieldType: "text" as const }
const PRODUCT = { label: "Shop menu" }
/** ussd_shop_codes.code is VARCHAR(8), generated as 4-6 digits. Anything else is not a code. */
const SHOP_CODE_RE = /^[A-Za-z0-9]{1,8}$/

export function shopMenuFor(config: HubtelUssdConfig, dataBlocked: boolean) {
  return resolveShopMenu(config.visibility as Record<MainMenuKey, boolean>, dataBlocked)
}

/** The product menu for the session's shop, without writing the session. */
export function shopMenuReply(ctx: FlowCtx, prefix = ""): HubtelReply {
  const s = ctx.session
  return say(ctx, prefix + shopMenuText(s.shopName ?? "Shop", shopMenuFor(ctx.config, s.dataBlocked === true)), "SHOP_PRODUCT", PRODUCT)
}

/** "0" on a shop flow's first screen: back to the product menu, keeping only the shop context. */
export async function backToProduct(ctx: FlowCtx, prefix = ""): Promise<HubtelReply> {
  const s = ctx.session
  const clean: HubtelSession = {
    mode: "shop", step: "SHOP_PRODUCT", dialingPhone: s.dialingPhone, platform: s.platform, dataBlocked: s.dataBlocked,
    shopCodeId: s.shopCodeId, shopId: s.shopId, parentShopId: s.parentShopId, shopName: s.shopName, shopNetworks: s.shopNetworks,
  }
  await ctx.deps.sessions.set(ctx.req.SessionId, clean)
  return shopMenuReply({ ...ctx, session: clean }, prefix)
}

/** Initiation (or a restart) in shop mode: pins mode=shop and asks for the shop code. */
export async function startShopSession(
  req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, prefix: string
): Promise<HubtelReply> {
  const dataBlocked = await deps.isDataBlocked(req.Mobile)
  // Checked BEFORE the code is asked, so no shop token is ever spent on an empty menu.
  if (shopMenuFor(config, dataBlocked).length === 0) {
    await deps.sessions.del(req.SessionId)
    return release(req.SessionId, "No services available right now. Please try again later.", { platform: req.Platform })
  }
  await deps.sessions.set(req.SessionId, {
    mode: "shop", step: "SHOP_ENTER_CODE", dialingPhone: toE164(req.Mobile), platform: req.Platform, dataBlocked,
  })
  return respond(req.SessionId, prefix + shopCodePromptText(), {
    label: CODE.label, fieldType: CODE.fieldType, clientState: "SHOP_ENTER_CODE", platform: req.Platform,
  })
}

async function enterCode(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, req } = ctx
  if (input === "0") return finish(ctx, "Goodbye.")
  const retry = (reason: string) => say(ctx, shopCodeRetryText(reason), "SHOP_ENTER_CODE", CODE)
  if (!SHOP_CODE_RE.test(input)) return retry("Invalid code. Try again.")

  const shop = await deps.shop.resolveCode(input)
  if (!shop || shop.status !== "active") return retry("Invalid code. Try again.")

  // One token per (Hubtel session, shop code). The marker is taken BEFORE deducting, so two
  // concurrent deliveries cannot both deduct; "already" means this session has paid for this
  // code (lost-reply retry or "Session expired" restart) and must not pay again.
  const claim = await deps.shopBilling.claim(req.SessionId, shop.shopCodeId)
  if (claim === "error") return retry("Shop unavailable. Try again.")
  if (claim === "claimed") {
    if (shop.tokenBalance <= 0) {
      await deps.shopBilling.release(req.SessionId, shop.shopCodeId)
      return retry("Shop has no sessions left.")
    }
    let deducted = false
    try {
      deducted = await deps.shop.deductToken(shop.shopCodeId) // atomic: balance > 0 AND status active
    } catch (e) {
      console.error("[HUBTEL-SHOP] Token deduction failed:", shop.shopCodeId, e)
    }
    if (!deducted) {
      await deps.shopBilling.release(req.SessionId, shop.shopCodeId)
      return retry("Shop unavailable. Try again.")
    }
    // Uzo rule: alert the owner when this deduction leaves exactly 10 sessions (pre-read balance - 1).
    if (shop.tokenBalance - 1 === LOW_TOKEN_ALERT_AT) await deps.shop.notifyLowTokens(shop.shopId, shop.shopName)
  }

  // A shop may sell only airtime / vouchers: an empty network list does not block entry (Uzo).
  const networks = sortShopNetworks(await deps.shop.networks(shop.shopId, shop.parentShopId ?? undefined))
  return goto(ctx, {
    step: "SHOP_PRODUCT",
    shopCodeId: shop.shopCodeId,
    shopId: shop.shopId,
    parentShopId: shop.parentShopId ?? undefined,
    shopName: shop.shopName,
    shopNetworks: networks,
  }, shopMenuText(shop.shopName, shopMenuFor(ctx.config, ctx.session.dataBlocked === true)), PRODUCT)
}

export const SHOP_ENTRY_STEPS: StepTable = {
  SHOP_ENTER_CODE: enterCode,
}
```

- [ ] **Step 9: Pin the mode and dispatch by it in the router**

In `lib/ussd-hubtel/router.ts`:

(a) Add the imports (merge `type ShopMenuKey` into the existing `./menus` import):

```ts
import { SHOP_ENTRY_STEPS, shopMenuFor, shopMenuReply, startShopSession } from "./flows/shop"
import type { ShopMenuKey } from "./menus"
```

(b) Directly after the `MAIN_MENU_ENTRIES` constant add:

```ts
/** First screen of each shop product (Tasks 3, 5, 6 register theirs). Shop mode only. */
export const SHOP_PRODUCT_ENTRIES: Partial<Record<ShopMenuKey, StepHandler>> = {}

/** Steps of a session pinned to shop mode. Never mixed with STEPS: a session runs one table. */
const SHOP_STEPS: StepTable = {
  ...SHOP_ENTRY_STEPS,
  SHOP_PRODUCT: handleShopProduct,
}
```

(c) Replace

```ts
  // Shop mode ships in Plan 3; treat it as unavailable until then.
  if (!config.enabled || config.mode !== "main") return release(sid, UNAVAILABLE, { platform })

  if (req.Type === "Initiation") return startSession(req, deps, config, "")
```

with

```ts
  // Kill switch: every request, including in-flight sessions of either mode.
  if (!config.enabled) return release(sid, UNAVAILABLE, { platform })

  // Spec §4.2: the mode is read on Initiation and pinned into the session.
  if (req.Type === "Initiation") return startForMode(req, deps, config, "")
```

(d) In the no-session branch replace `return startSession(req, deps, config, "Session expired.\n")` with `return startForMode(req, deps, config, "Session expired.\n")` (the `replaySubmittedOrder` call before it stays first).

(e) Replace

```ts
  const handler = STEPS[session.step]
  if (!handler) return startSession(req, deps, config, "")
```

with

```ts
  // Dispatch by the PINNED mode, never the current config (a session without one is main).
  const table = session.mode === "shop" ? SHOP_STEPS : STEPS
  const handler = table[session.step]
  if (!handler) return startForMode(req, deps, config, "")
```

(f) In `startSession`, change the stored session to include the mode:

```ts
  await deps.sessions.set(req.SessionId, { mode: "main", step: "MAIN", dialingPhone: toE164(req.Mobile), platform: req.Platform, dataBlocked })
```

(g) Add below `startSession`:

```ts
/** New or restarted session: the CURRENT config mode decides, and is pinned by the start function. */
function startForMode(req: HubtelRequest, deps: RouterDeps, config: HubtelUssdConfig, prefix: string): Promise<HubtelReply> {
  return config.mode === "shop" ? startShopSession(req, deps, config, prefix) : startSession(req, deps, config, prefix)
}

async function handleShopProduct(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return finish(ctx, "Goodbye.")
  const key = keyForDigit(shopMenuFor(ctx.config, ctx.session.dataBlocked === true), ctx.input)
  const start = key ? SHOP_PRODUCT_ENTRIES[key] : undefined
  return start ? start(ctx) : shopMenuReply(ctx)
}
```

`backToMain` in `flow-kit.ts` stays as it is: it writes a session without `mode`, which runs as main.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run lib/ussd-hubtel/flows/shop.test.ts lib/ussd-hubtel/router.test.ts lib/ussd-hubtel/menus.test.ts`
Expected: PASS.

- [ ] **Step 11: Run the Hubtel suite and typecheck**

Run: `npx vitest run lib/ussd-hubtel`
Expected: PASS (all files).
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`

- [ ] **Step 12: Commit**

```bash
git add lib/ussd-hubtel/types.ts lib/ussd-hubtel/menus.ts lib/ussd-hubtel/menus.test.ts lib/ussd-hubtel/flows/shop.ts lib/ussd-hubtel/flows/shop.test.ts lib/ussd-hubtel/router.ts lib/ussd-hubtel/router.test.ts lib/ussd-hubtel/testing/fakes.ts
git commit -m "feat(hubtel): pin USSD mode per session; shop-code step with once-per-session billing; shop menu"
```

---

### Task 3: Shop data bundles → `ussd_shop_orders`, registry entry and replay

Port of `lib/ussd-shop/handlers/bundles.ts` minus Paystack and OTP. Catalog and prices come from `lib/shop-commerce` (regular shops: `shop_packages` + owner's base price + `profit_margin`; sub-agent shops: `sub_agent_shop_packages`, else the parent's `sub_agent_catalog`). At "1" the price and the profit split are re-verified from the DB (`verifyBundlePrice`) and snapshotted into the order.

Step transitions:

| Step | Input | Next |
|---|---|---|
| SHOP_PRODUCT | "Buy Data Bundle" digit | no shop networks ⇒ same, "No packages available."; else SHOP_DATA_NETWORK |
| SHOP_DATA_NETWORK | `0` | SHOP_PRODUCT (D5) |
| | valid digit, network has bundles | SHOP_DATA_BUNDLE (page 0) |
| | valid digit, no bundles | same, "No <network> packages available." |
| SHOP_DATA_BUNDLE | `0` | SHOP_DATA_NETWORK |
| | "More..." digit | next page |
| | bundle digit | SHOP_DATA_RECIPIENT (phone field) |
| SHOP_DATA_RECIPIENT | `0` | SHOP_DATA_BUNDLE (same page) |
| | invalid / wrong network prefix (validation on) | same, reason |
| | ok | SHOP_DATA_CONFIRM |
| SHOP_DATA_CONFIRM | `2` | release "Order cancelled." |
| | `1` | replay guard; `verifyBundlePrice`; package gone ⇒ release; price drift ⇒ release; `submitOrder("ussd_shop_orders")` |

**Files:**
- Create: `lib/ussd-hubtel/flows/shop-data.ts`, `lib/ussd-hubtel/flows/shop-data.test.ts`
- Modify: `lib/ussd-hubtel/order-tables.ts`, `lib/ussd-hubtel/order-tables.test.ts`
- Modify: `lib/ussd-hubtel/router.ts` (entry + steps)

**Interfaces:**
- Consumes: Task 1 `ShopServices.bundles`, `.verifyBundlePrice`, `.orderContext`; Task 2 `backToProduct`, `shopMenuReply`, `shopHeader`, `shopNetworkLabel`, `shopNetworkMenuText`, `SHOP_PRODUCT_ENTRIES`, `SHOP_STEPS`, `SHOP_CONFIG`. Plan 2 (verify): `submitOrder(ctx, { table, row, price, logTag })`, `replaySubmittedOrder(deps, sid, platform)`, `ORDER_TABLES`, `HubtelOrderTable`, `OrderTableSpec`, `formatSize`, `HUBTEL_NETWORKS`; Plan 1 `bundleMenuText`, `recipientPromptText`, `confirmMenuText`; `fakeSupabase`, `NEW_ID`, `digitFor`.
- Produces: `flows/shop-data.ts`: `startShopData(ctx)`, `SHOP_DATA_STEPS: StepTable`; `HubtelOrderTable` includes `"ussd_shop_orders"`; `ORDER_TABLES.ussd_shop_orders`.

- [ ] **Step 0: Verify the Plan 2 interface as built**

Run:
```bash
grep -n "export async function submitOrder" -A 6 lib/ussd-hubtel/flow-kit.ts
grep -n "export async function replaySubmittedOrder" -A 30 lib/ussd-hubtel/flow-kit.ts
grep -n "export type HubtelOrderTable\|export interface OrderTableSpec\|^  [a-z_]*: {" lib/ussd-hubtel/order-tables.ts
grep -n "export function bundleMenuText\|export function recipientPromptText\|export function confirmMenuText\|export function formatSize" lib/ussd-hubtel/menus.ts
grep -n "export function fakeSupabase\|export const NEW_ID\|txConflictRow\|rows?:" lib/ussd-hubtel/testing/fakes.ts
```
Expected: `replaySubmittedOrder` reads `order_table` from the tx row, looks it up with `isHubtelOrderTable` / `ORDER_TABLES[tx.order_table]`, and selects `spec.cartColumns` from THAT table (this is the Plan 1 follow-up "replay must use tx.order_table": confirm it is done; if it still hardcodes `ussd_orders`, stop and report). `HubtelOrderTable` is the five-table union from Plan 2. `submitOrder` inserts `args.row`, writes the tx row with `order_table: args.table`, and on a tx error applies `ORDER_TABLES[args.table].failPatch()`.

- [ ] **Step 1: Register `ussd_shop_orders` (failing test first)**

Append inside the `describe("ORDER_TABLES", …)` block of `lib/ussd-hubtel/order-tables.test.ts`:

```ts
  it("ussd_shop_orders: payable statuses, fail patch and item name", () => {
    const s = ORDER_TABLES.ussd_shop_orders
    expect(s.payableStatuses).toEqual(["pending", "otp_required"])
    expect(s.failPatch()).toMatchObject({ order_status: "failed", payment_status: "failed" })
    expect(s.cartColumns).toBe("package_size, network")
    expect(s.cartItemName({ package_size: "5", network: "MTN" })).toBe("5GB MTN Data")
    expect(s.cartItemName({ package_size: "500MB", network: "AT-BigTime" })).toBe("500MB AT BigTime Data")
  })
```

Run: `npx vitest run lib/ussd-hubtel/order-tables.test.ts`
Expected: FAIL (`Cannot read properties of undefined (reading 'payableStatuses')`).

In `lib/ussd-hubtel/order-tables.ts` add `| "ussd_shop_orders"` to the `HubtelOrderTable` union and add this entry to `ORDER_TABLES`:

```ts
  // Shop-mode data bundles (Plan 3). Same statuses and cart wording as ussd_orders.
  ussd_shop_orders: {
    payableStatuses: ["pending", "otp_required"],
    failPatch: () => ({ order_status: "failed", payment_status: "failed", updated_at: now() }),
    cartColumns: "package_size, network",
    cartItemName: r => {
      const label = HUBTEL_NETWORKS.find(n => n.dbName === r.network)?.label ?? String(r.network)
      return `${formatSize(String(r.package_size))} ${label} Data`
    },
  },
```

Run: `npx vitest run lib/ussd-hubtel/order-tables.test.ts`
Expected: PASS (including the "only registers tables the CHECK allows" test).

- [ ] **Step 2: Write the failing flow test**

```ts
// lib/ussd-hubtel/flows/shop-data.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeShop, fakeSupabase, makeDeps, NEW_ID, OK_PKG, req, SHOP_CODE, SHOP_CONFIG } from "../testing/fakes"

async function toProduct(deps: RouterDeps) {
  await hubtelRouter(req({ Type: "Initiation" }), deps)
  return hubtelRouter(req({ Message: "1234" }), deps)
}
async function toNetworks(deps: RouterDeps) {
  const menu = await toProduct(deps)
  return hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Data Bundle") }), deps)
}
/** MTN (first shop network), first package, recipient -> confirm screen. */
async function toConfirm(deps: RouterDeps, recipient = "0244123456") {
  await toNetworks(deps)
  await hubtelRouter(req({ Message: "1" }), deps)
  await hubtelRouter(req({ Message: "1" }), deps)
  return hubtelRouter(req({ Message: recipient }), deps)
}
const shopDeps = (over: Parameters<typeof makeDeps>[0] = {}, sup = fakeSupabase({ pkg: OK_PKG })) =>
  makeDeps({ getConfig: SHOP_CONFIG, ...over }, sup)

describe("shop data: networks (review focus #4)", () => {
  it("lists only the shop's networks, real names, shop header", async () => {
    const { deps, store } = shopDeps({ shop: fakeShop({ networks: async () => ["AT-iShare", "MTN"] }) })
    const r = await toNetworks(deps)
    expect(r.Message).toBe("Ama Data Hub\nSelect Network:\n1. MTN\n2. AT iShare\n0. Back")
    expect(store.get("S1")?.step).toBe("SHOP_DATA_NETWORK")
  })
  it("a shop with no data packages: 'No packages available.' and stays on the product menu", async () => {
    const { deps, store } = shopDeps({ shop: fakeShop({ networks: async () => [] }) })
    const r = await toNetworks(deps)
    expect(r.Message).toContain("No packages available.\nAma Data Hub\nWhat would you like to buy?")
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
  })
  it("a network with no bundles: says so and stays on the network menu", async () => {
    const { deps, store } = shopDeps({ shop: fakeShop({ bundles: async () => [] }) })
    await toNetworks(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("No MTN packages available.")
    expect(store.get("S1")?.step).toBe("SHOP_DATA_NETWORK")
  })
  it("'0' on the network menu returns to the product menu without billing again (D5)", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps, store } = shopDeps({ shop: fakeShop({ deductToken }) })
    await toNetworks(deps)
    const r = await hubtelRouter(req({ Message: "0" }), deps)
    expect(r.Message).toContain("What would you like to buy?")
    expect(store.get("S1")).toMatchObject({ step: "SHOP_PRODUCT", shopId: "shop-1" })
    expect(deductToken).toHaveBeenCalledTimes(1)
  })
})

describe("shop data: packages and recipient", () => {
  it("shows shop prices and pages through them", async () => {
    const all = Array.from({ length: 7 }, (_, i) => ({ id: `pkg-${i + 1}`, size: String(i + 1), price: 10 + i }))
    const { deps, store } = shopDeps({ shop: fakeShop({ bundles: async () => all }) })
    await toNetworks(deps)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    expect(first.Message).toContain("1. 1GB - GHS 10.00")
    expect(first.Message).toContain("6. More...")
    const second = await hubtelRouter(req({ Message: "6" }), deps)
    expect(second.Message).toContain("7. 7GB - GHS 16.00")
    await hubtelRouter(req({ Message: "7" }), deps)
    expect(store.get("S1")).toMatchObject({ step: "SHOP_DATA_RECIPIENT", bundleId: "pkg-7", bundleSize: "7", bundlePrice: 16 })
  })
  it("rejects a recipient on another network (prefix validation on)", async () => {
    const { deps, store } = shopDeps()
    await toNetworks(deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    const r = await hubtelRouter(req({ Message: "0201234567" }), deps) // Telecel number for MTN data
    expect(r.Message).toContain("Enter recipient number")
    expect(store.get("S1")?.step).toBe("SHOP_DATA_RECIPIENT")
  })
  it("confirm shows the shop, bundle, recipient, shop price and payer", async () => {
    const { deps } = shopDeps()
    const r = await toConfirm(deps)
    expect(r.Message).toBe("Ama Data Hub\nConfirm order:\n5GB MTN\nTo: 0244123456\nGHS 12.00 from 0200585542\n1. Pay now\n2. Cancel")
  })
})

describe("shop data: confirm -> AddToCart", () => {
  it("creates the ussd_shop_orders row with the profit snapshot and returns AddToCart at the shop price", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps, store } = shopDeps({}, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "5GB MTN Data", Qty: 1, Price: 12 })
    expect(sup.inserts["ussd_shop_orders"][0]).toEqual({
      shop_code_id: "code-1",
      shop_id: "shop-1",
      dialing_phone: "+233200585542",
      recipient_phone: "0244123456",
      network: "MTN",
      paystack_provider: "vod",
      package_id: "pkg-1",
      package_size: "5",
      amount: 12,
      shop_price: 12,
      profit_amount: 2,
      parent_shop_id: null,
      parent_profit_amount: 0,
      shop_name: "Ama Data Hub Ltd",
      customer_email: "0200585542@ussd.datagod.com",
      shop_owner_email: "owner@example.com",
      order_status: "pending",
      payment_status: "pending",
      channel: "ussd_shop",
    })
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({
      session_id: "S1", order_table: "ussd_shop_orders", order_id: NEW_ID, expected_amount: 12, platform: "USSD",
    })
    expect(store.has("S1")).toBe(false)
  })
  it("sub-agent shop: catalog and price verification use the parent; parent profit is snapshotted (review focus #4)", async () => {
    const bundles = vi.fn(async () => [{ id: "pkg-1", size: "5", price: 12 }])
    const verifyBundlePrice = vi.fn(async () => ({ verifiedPrice: 12, profitAmount: 1, parentProfitAmount: 1.5 }))
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({
      shop: fakeShop({ resolveCode: async () => ({ ...SHOP_CODE, parentShopId: "parent-1" }), bundles, verifyBundlePrice }),
    }, sup)
    await toConfirm(deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    expect(bundles).toHaveBeenCalledWith("shop-1", "MTN", "parent-1")
    expect(verifyBundlePrice).toHaveBeenCalledWith("shop-1", "pkg-1", "parent-1")
    expect(sup.inserts["ussd_shop_orders"][0]).toMatchObject({ parent_shop_id: "parent-1", profit_amount: 1, parent_profit_amount: 1.5, amount: 12 })
  })
  it("shop changed its margin since the confirm screen: release, no order (review focus #7)", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ shop: fakeShop({ verifyBundlePrice: async () => ({ verifiedPrice: 13, profitAmount: 3, parentProfitAmount: 0 }) }) }, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toBe("Price changed to GHS 13.00. Please restart your order.")
    expect(sup.inserts["ussd_shop_orders"]).toBeUndefined()
  })
  it("package withdrawn from the shop since the confirm screen: release, no order", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ shop: fakeShop({ verifyBundlePrice: async () => null }) }, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toBe("Package no longer available. Please try again.")
    expect(sup.inserts["ussd_shop_orders"]).toBeUndefined()
  })
  it("'2' cancels without an order", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({}, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "2" }), deps)
    expect(r.Message).toBe("Order cancelled.")
    expect(sup.inserts["ussd_shop_orders"]).toBeUndefined()
  })
})

describe("shop data: idempotent CONFIRM and replay (review focus #3)", () => {
  const winner = { order_table: "ussd_shop_orders", order_id: "o-winner", expected_amount: 12, state: "awaiting_payment" }
  it("a duplicate '1' creates ONE order + ONE tx and replays the same AddToCart", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({}, sup)
    await toConfirm(deps)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(second.Item).toEqual(first.Item)
    expect(sup.inserts["ussd_shop_orders"]).toHaveLength(1)
    expect(sup.inserts["hubtel_transactions"]).toHaveLength(1)
  })
  it("tx insert hits a unique violation: orphan shop order failed, winner's cart replayed", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG, txConflictRow: winner })
    const { deps } = shopDeps({}, sup)
    await toConfirm(deps)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    err.mockRestore()
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "5GB MTN Data", Qty: 1, Price: 12 })
    expect(sup.updates.some(u => u.table === "ussd_shop_orders" && u.patch.order_status === "failed" && u.patch.payment_status === "failed")).toBe(true)
  })
  for (const mode of ["shop", "main"] as const) {
    it(`session expired after AddToCart: the next '1' replays the SHOP cart (config now ${mode})`, async () => {
      const sup = fakeSupabase({ rows: { hubtel_transactions: { ...winner, order_id: "o1" }, ussd_shop_orders: { package_size: "2", network: "Telecel" } } })
      const { deps } = makeDeps({ getConfig: async () => ({ enabled: true, mode, visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }) }, sup)
      const r = await hubtelRouter(req({ Message: "1" }), deps)
      expect(r.Type).toBe("AddToCart")
      expect(r.Item).toEqual({ ItemName: "2GB Telecel Data", Qty: 1, Price: 12 })
    })
  }
})
```

Note: `paystack_provider: "vod"` is what `paystackProviderFromPhone("+233200585542")` returns for the default test caller (020 = Telecel). If Step 3's run shows a different value, assert the real `paystackProviderFromPhone("+233200585542") ?? "mtn"` result instead and note it.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run lib/ussd-hubtel/flows/shop-data.test.ts`
Expected: FAIL: "Buy Data Bundle" has no shop entry yet, so the network-menu tests see the product menu again (`expected 'Ama Data Hub\nWhat would you like…' to be 'Ama Data Hub\nSelect Network:…'`). The two replay tests may already pass (they prove Plan 2's generic replay + Step 1's registry entry).

- [ ] **Step 4: Write the shop data flow**

```ts
// lib/ussd-hubtel/flows/shop-data.ts
// Shop-mode data bundles. Port of lib/ussd-shop/handlers/bundles.ts minus Paystack and OTP: the
// shop's catalog and prices (lib/shop-commerce), CONFIRM ends in AddToCart at the shop price.
import { validateNetworkPrefix } from "@/lib/phone-format"
import { paystackProviderFromPhone } from "@/lib/ussd/paystack-provider"
import {
  bundleMenuText, confirmMenuText, recipientPromptText, shopHeader, shopNetworkLabel, shopNetworkMenuText,
} from "../menus"
import { toLocalPhone } from "../protocol"
import { finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import { backToProduct, shopMenuReply } from "./shop"
import type { HubtelReply, HubtelSession } from "../types"

const NETWORK = { label: "Select network" }
const PACKAGE = { label: "Select package" }
const RECIPIENT = { label: "Recipient number", fieldType: "phone" as const }
const CONFIRM = { label: "Confirm order" }

const shopName = (s: HubtelSession) => s.shopName ?? "Shop"
const networksOf = (s: HubtelSession) => s.shopNetworks ?? []

function networkScreen(s: HubtelSession): string {
  return shopNetworkMenuText(shopName(s), networksOf(s))
}

function confirmText(s: HubtelSession): string {
  return `${shopHeader(shopName(s))}\n` + confirmMenuText(
    shopNetworkLabel(s.network!), s.bundleSize!, s.bundlePrice!, s.recipientPhone!, toLocalPhone(s.dialingPhone)
  )
}

/** One page of the shop's bundles. Re-fetched every time: shop prices may change mid-session. */
async function pageOf(ctx: FlowCtx, network: string, page: number) {
  const all = await ctx.deps.shop.bundles(ctx.session.shopId!, network, ctx.session.parentShopId)
  const size = ctx.deps.pageSize
  return { bundles: all.slice(page * size, (page + 1) * size), total: all.length }
}

export async function startShopData(ctx: FlowCtx): Promise<HubtelReply> {
  if (networksOf(ctx.session).length === 0) return shopMenuReply(ctx, "No packages available.\n")
  return goto(ctx, { step: "SHOP_DATA_NETWORK" }, networkScreen(ctx.session), NETWORK)
}

async function selectNetwork(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, session } = ctx
  if (input === "0") return backToProduct(ctx) // D5: never back to code entry
  const network = /^\d+$/.test(input) ? networksOf(session)[Number(input) - 1] : undefined
  if (!network) return say(ctx, networkScreen(session), "SHOP_DATA_NETWORK", NETWORK)
  const { bundles, total } = await pageOf(ctx, network, 0)
  if (bundles.length === 0) {
    return say(ctx, `No ${shopNetworkLabel(network)} packages available.\n` + networkScreen(session), "SHOP_DATA_NETWORK", NETWORK)
  }
  return goto(ctx, { step: "SHOP_DATA_BUNDLE", network, bundlePage: 0 }, bundleMenuText(bundles, 0, total, deps.pageSize), PACKAGE)
}

async function selectBundle(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, session } = ctx
  if (input === "0") return goto(ctx, { step: "SHOP_DATA_NETWORK" }, networkScreen(session), NETWORK)
  const page = session.bundlePage ?? 0
  const offset = page * deps.pageSize
  const { bundles, total } = await pageOf(ctx, session.network!, page)
  const chosen = /^\d+$/.test(input) ? Number(input) : NaN

  if (chosen === offset + bundles.length + 1 && offset + bundles.length < total) {
    const next = page + 1
    const nextPage = await pageOf(ctx, session.network!, next)
    return goto(ctx, { step: "SHOP_DATA_BUNDLE", bundlePage: next }, bundleMenuText(nextPage.bundles, next, nextPage.total, deps.pageSize), PACKAGE)
  }

  const selected = Number.isInteger(chosen) ? bundles[chosen - offset - 1] : undefined
  if (!selected) return say(ctx, bundleMenuText(bundles, page, total, deps.pageSize), "SHOP_DATA_BUNDLE", PACKAGE)
  return goto(ctx, {
    step: "SHOP_DATA_RECIPIENT", bundleId: selected.id, bundleSize: selected.size, bundlePrice: selected.price,
  }, recipientPromptText(), RECIPIENT)
}

async function enterRecipient(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, session } = ctx
  if (input === "0") {
    const page = session.bundlePage ?? 0
    const { bundles, total } = await pageOf(ctx, session.network!, page)
    return goto(ctx, { step: "SHOP_DATA_BUNDLE" }, bundleMenuText(bundles, page, total, deps.pageSize), PACKAGE)
  }
  const local = toLocalPhone(input.replace(/\s+/g, ""))
  const reprompt = (msg: string) => say(ctx, `${msg}\n${recipientPromptText()}`, "SHOP_DATA_RECIPIENT", RECIPIENT)
  if (!/^0[0-9]{9}$/.test(local)) return reprompt("Invalid number. Enter a valid Ghana phone number.")

  // Network <-> prefix hard block (admin-toggleable), as the Uzo shop.
  const prefix = await deps.getPrefixConfig()
  if (prefix.enabled && session.network) {
    const check = validateNetworkPrefix(session.network, local, prefix.map)
    if (!check.ok) return reprompt(check.message ?? "Number does not match the selected network.")
  }
  return goto(ctx, { step: "SHOP_DATA_CONFIRM", recipientPhone: local }, confirmText({ ...session, recipientPhone: local }), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { input, deps, req, session } = ctx
  if (input === "2") return finish(ctx, "Order cancelled.")
  if (input !== "1") return say(ctx, confirmText(session), "SHOP_DATA_CONFIRM", CONFIRM)

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  // Re-verify the shop price and the profit split straight from the DB (stale-session guard).
  const verified = await deps.shop.verifyBundlePrice(session.shopId!, session.bundleId!, session.parentShopId)
  if (!verified) return finish(ctx, "Package no longer available. Please try again.")
  if (Math.abs(verified.verifiedPrice - session.bundlePrice!) > 0.01) {
    return finish(ctx, `Price changed to GHS ${verified.verifiedPrice.toFixed(2)}. Please restart your order.`)
  }
  const info = await deps.shop.orderContext(session.shopId!, session.dialingPhone)

  return submitOrder(ctx, {
    table: "ussd_shop_orders",
    price: verified.verifiedPrice,
    logTag: "HUBTEL-SHOP-DATA",
    // Same columns as lib/shop-commerce/orders.ts createShopBundleOrder (the Uzo shop insert).
    row: {
      shop_code_id: session.shopCodeId,
      shop_id: session.shopId,
      dialing_phone: session.dialingPhone,
      recipient_phone: session.recipientPhone,
      network: session.network,
      // NOT NULL column; unused on this channel (payment is Hubtel's).
      paystack_provider: paystackProviderFromPhone(session.dialingPhone) ?? "mtn",
      package_id: session.bundleId,
      package_size: session.bundleSize,
      amount: verified.verifiedPrice, // the shop price only: Hubtel adds its own charge on top
      shop_price: verified.verifiedPrice,
      profit_amount: verified.profitAmount, // credited to shop_id after payment
      parent_shop_id: session.parentShopId ?? null,
      parent_profit_amount: verified.parentProfitAmount, // credited to parent_shop_id after payment
      shop_name: info.shopName,
      customer_email: info.customerEmail,
      shop_owner_email: info.shopOwnerEmail,
      order_status: "pending",
      payment_status: "pending",
      channel: "ussd_shop",
    },
  })
}

export const SHOP_DATA_STEPS: StepTable = {
  SHOP_DATA_NETWORK: selectNetwork,
  SHOP_DATA_BUNDLE: selectBundle,
  SHOP_DATA_RECIPIENT: enterRecipient,
  SHOP_DATA_CONFIRM: confirm,
}
```

- [ ] **Step 5: Wire the entry and steps**

In `lib/ussd-hubtel/router.ts` add `import { SHOP_DATA_STEPS, startShopData } from "./flows/shop-data"`, set `data: startShopData,` in `SHOP_PRODUCT_ENTRIES`, and add `...SHOP_DATA_STEPS,` to `SHOP_STEPS`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run lib/ussd-hubtel/flows/shop-data.test.ts lib/ussd-hubtel/order-tables.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the Hubtel suite and typecheck**

Run: `npx vitest run lib/ussd-hubtel`
Expected: PASS.
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`

- [ ] **Step 8: Commit**

```bash
git add lib/ussd-hubtel/flows/shop-data.ts lib/ussd-hubtel/flows/shop-data.test.ts lib/ussd-hubtel/order-tables.ts lib/ussd-hubtel/order-tables.test.ts lib/ussd-hubtel/router.ts
git commit -m "feat(hubtel): shop-mode data bundles into ussd_shop_orders with profit snapshot"
```

---

### Task 4: `ussd_shop_orders` post-payment handler

Mirrors the Paystack webhook's shop block (`app/api/webhooks/paystack/route.ts` ≈ lines 497-672) with the differences in D10. The expiry fail handler comes from the registry (Task 3) automatically.

Order of operations (each written out below, not delegated to Uzo):
1. Read the order; missing ⇒ throw; `payment_status = 'completed'` ⇒ return (already processed).
2. Conditional mark `payment_status: pending|otp_required → completed` with `.select("id")`; 0 rows ⇒ throw "not in a payable state" (late payment after expiry, or a concurrent winner). This is the once-only gate for everything below.
3. `profit_amount > 0` ⇒ insert `shop_profits { shop_id, ussd_shop_order_id, profit_amount, status: "credited" }`.
4. `parent_shop_id` set and `parent_profit_amount > 0` ⇒ insert the same for `parent_shop_id`.
5. Customer tracking (non-fatal).
6. `fulfillUssdOrder(id, network, recipient_phone, package_size ?? "", false, "ussd_shop_orders")`; it sets the precise `order_status`. If it THROWS: `order_status = 'pending'`, remember the problem.
7. Recipient SMS `ussdOrderConfirmed(package_size, network)` (no community link) unless the order is held or fulfilment threw. No payer SMS (same as the webhook).
8. Any profit insert error or an untriggered fulfilment ⇒ throw at the end ⇒ `needs_review`.

**Files:**
- Modify: `lib/ussd-hubtel/order-handlers.ts`
- Create: `lib/ussd-hubtel/order-handlers.shop.test.ts`

**Interfaces:**
- Consumes: Task 3 `ORDER_TABLES.ussd_shop_orders`. Plan 2 (verify): `createOrderHandlers(supabase): OrderHandlers`, `createFailHandlers(supabase): OrderHandlers` (registry-driven), `processFulfillment(store, handlers, info)` (`payment.ts`), `HubtelTxStore`, `HubtelTxRow` (`types.ts`). Library: `fulfillUssdOrder(orderId, network, recipientPhone, packageSize, forceManual?, orderTable?)` (`lib/ussd/fulfill.ts`), `customerTrackingService.trackCustomer(input)` (`lib/customer-tracking-service.ts`), `sendSMS`, `SMSTemplates.ussdOrderConfirmed(packageSize, network, channelLink?)` (`lib/sms-service.ts`).
- Produces: `createOrderHandlers(...).ussd_shop_orders(orderId): Promise<void>`.

- [ ] **Step 0: Verify the Plan 2 interface as built**

Run:
```bash
grep -n "export function createOrderHandlers" -A 14 lib/ussd-hubtel/order-handlers.ts
grep -n "export function createFailHandlers" -A 16 lib/ussd-hubtel/order-handlers.ts
grep -n "^import" lib/ussd-hubtel/order-handlers.ts
grep -n "await import(" lib/ussd-hubtel/order-handlers.ts
grep -n "listIndeterminate\|claim(" lib/ussd-hubtel/types.ts
```
Expected: `createOrderHandlers` returns an object with `ussd_orders`, `airtime_orders`, `results_checker_orders`, `results_check_requests`, `ussd_afa_orders` and a `// Plan 3 registers ussd_shop_orders` comment; `createFailHandlers` loops over `ORDER_TABLES`; `ORDER_TABLES` is imported. List every module the file dynamically imports: the new test file must `vi.mock` each of them (Step 1 mocks the Plan 2 set; add any other found). `HubtelTxStore` has exactly `findBySession, claim, update, listPendingCallbacks, listAwaitingPayment, listStaleProcessing, listIndeterminate`; if it has more, add them to `memStore` in Step 1 as no-ops returning `[]`.

- [ ] **Step 1: Write the failing handler tests**

```ts
// lib/ussd-hubtel/order-handlers.shop.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const fulfillUssdOrder = vi.fn()
const sendSMS = vi.fn()
const trackCustomer = vi.fn()
const markAirtimeOrderPaid = vi.fn()
const fulfillPaidResultsCheckerOrder = vi.fn()
vi.mock("@/lib/ussd/fulfill", () => ({ fulfillUssdOrder: (...a: any[]) => fulfillUssdOrder(...a) }))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: (...a: any[]) => sendSMS(...a),
  SMSTemplates: {
    ussdOrderConfirmed: (size: string, network: string, link?: string) => `confirmed ${size} ${network} ${link ?? "no-link"}`,
    ussdPaymentConfirmed: () => "paid",
    ussdAirtimePaymentReceived: () => "airtime-paid",
    ussdAfaPaymentReceived: () => "afa-paid",
  },
}))
vi.mock("@/lib/app-settings", () => ({ getJoinCommunityLink: async () => "link" }))
vi.mock("@/lib/customer-tracking-service", () => ({ customerTrackingService: { trackCustomer: (...a: any[]) => trackCustomer(...a) } }))
vi.mock("@/lib/airtime-service", () => ({ markAirtimeOrderPaid: (...a: any[]) => markAirtimeOrderPaid(...a) }))
vi.mock("@/lib/results-checker-service", () => ({
  fulfillPaidResultsCheckerOrder: (...a: any[]) => fulfillPaidResultsCheckerOrder(...a),
  fulfillPaidResultsCheckRequest: vi.fn(),
}))
vi.mock("@/lib/ussd/fulfill-afa", () => ({ fulfillUssdAfaOrder: vi.fn() }))

import { createOrderHandlers, createFailHandlers } from "./order-handlers"
import { processFulfillment } from "./payment"
import type { HubtelTxRow, HubtelTxStore } from "./types"

/**
 * Table-aware fake. Reads return a COPY of rows[table] (a concurrent reader keeps its stale view,
 * like a real DB read). update().eq().in(col, vals).select() applies only when rows[table][col]
 * is in vals, synchronously at call time (so two racing handlers get exactly one winner);
 * an awaited update without .select() always applies. shop_profits inserts are recorded.
 */
function fakeDb(rows: Record<string, any>, opts: { profitError?: boolean } = {}) {
  const updates: Array<{ table: string; patch: any; inCol?: string; inVals?: string[] }> = []
  const profits: any[] = []
  const client: any = {
    from(table: string) {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: rows[table] ? { ...rows[table] } : null, error: null }) }) }),
        update: (patch: any) => {
          const rec: { table: string; patch: any; inCol?: string; inVals?: string[] } = { table, patch }
          const apply = () => { Object.assign(rows[table], patch); updates.push(rec) }
          const chain: any = {
            eq: () => chain,
            in: (col: string, vals: string[]) => { rec.inCol = col; rec.inVals = vals; return chain },
            select: async () => {
              const row = rows[table]
              const ok = !!row && (!rec.inCol || (rec.inVals ?? []).includes(row[rec.inCol]))
              if (ok) apply()
              return { data: ok ? [{ id: row.id }] : [], error: null }
            },
            then: (res: any) => { if (rows[table]) apply(); return res({ error: null }) },
          }
          return chain
        },
        insert: async (list: any[]) => {
          if (table === "shop_profits") {
            if (opts.profitError) return { error: { message: "profit insert failed" } }
            profits.push(...list)
          }
          return { error: null }
        },
      }
    },
  }
  return { client, updates, profits }
}

const shopOrder = (over: Record<string, unknown> = {}) => ({
  id: "o1", shop_id: "shop-1", shop_code_id: "code-1", dialing_phone: "+233200585542", recipient_phone: "0244123456",
  network: "MTN", package_size: "5", amount: 12, shop_price: 12, profit_amount: 2,
  parent_shop_id: null, parent_profit_amount: 0, channel: "ussd_shop",
  order_status: "pending", payment_status: "pending", ...over,
})

beforeEach(() => {
  for (const m of [fulfillUssdOrder, sendSMS, trackCustomer, markAirtimeOrderPaid, fulfillPaidResultsCheckerOrder]) m.mockReset()
  fulfillUssdOrder.mockResolvedValue({ success: true, message: "ok" })
  markAirtimeOrderPaid.mockResolvedValue({ success: true })
})

describe("ussd_shop_orders post-payment handler", () => {
  it("pending: marks paid (conditional), credits the shop once, tracks, fulfils from ussd_shop_orders, SMSes the recipient only", async () => {
    const { client, updates, profits } = fakeDb({ ussd_shop_orders: shopOrder() })
    await createOrderHandlers(client).ussd_shop_orders("o1")
    expect(updates[0]).toMatchObject({ table: "ussd_shop_orders", patch: { payment_status: "completed" }, inCol: "payment_status", inVals: ["pending", "otp_required"] })
    expect(profits).toEqual([expect.objectContaining({ shop_id: "shop-1", ussd_shop_order_id: "o1", profit_amount: 2, status: "credited" })])
    expect(trackCustomer).toHaveBeenCalledWith(expect.objectContaining({
      shopId: "shop-1", phoneNumber: "0244123456", customerName: "USSD Customer", totalPrice: 12, slug: "ussd_shop", orderId: "o1",
    }))
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(fulfillUssdOrder).toHaveBeenCalledWith("o1", "MTN", "0244123456", "5", false, "ussd_shop_orders")
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(sendSMS.mock.calls[0][0]).toMatchObject({ phone: "0244123456", message: "confirmed 5 MTN no-link", reference: "o1" })
  })
  it("sub-agent order: shop profit AND parent profit, each once", async () => {
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder({ profit_amount: 1, parent_shop_id: "parent-1", parent_profit_amount: 1.5 }) })
    await createOrderHandlers(client).ussd_shop_orders("o1")
    expect(profits.map(p => [p.shop_id, p.profit_amount])).toEqual([["shop-1", 1], ["parent-1", 1.5]])
  })
  it("zero shop profit: no shop_profits row", async () => {
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder({ profit_amount: 0 }) })
    await createOrderHandlers(client).ussd_shop_orders("o1")
    expect(profits).toEqual([])
  })
  it("late payment on an expired (failed) order: throws, no profit, no fulfilment, no SMS (review focus #6)", async () => {
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder({ order_status: "failed", payment_status: "failed" }) })
    await expect(createOrderHandlers(client).ussd_shop_orders("o1")).rejects.toThrow(/not in a payable state: failed/)
    expect(profits).toEqual([])
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
    expect(trackCustomer).not.toHaveBeenCalled()
  })
  it("already completed: no-op", async () => {
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder({ payment_status: "completed" }) })
    await createOrderHandlers(client).ussd_shop_orders("o1")
    expect(profits).toEqual([])
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
  })
  it("two handler runs racing on the same order: profit credited once, fulfilled once (review focus #5)", async () => {
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder({ parent_shop_id: "parent-1", parent_profit_amount: 1.5 }) })
    const h = createOrderHandlers(client)
    const results = await Promise.allSettled([h.ussd_shop_orders("o1"), h.ussd_shop_orders("o1")])
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1)
    expect(profits).toHaveLength(2) // one for the shop, one for the parent
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
  })
  it("held for MTN registration: no confirmation SMS", async () => {
    fulfillUssdOrder.mockResolvedValue({ success: true, message: "held", held: true })
    const { client } = fakeDb({ ussd_shop_orders: shopOrder() })
    await createOrderHandlers(client).ussd_shop_orders("o1")
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("provider failure (success:false) is the manual queue's job: no throw, SMS still sent (as the webhook)", async () => {
    fulfillUssdOrder.mockResolvedValue({ success: false, message: "provider down" })
    const { client } = fakeDb({ ussd_shop_orders: shopOrder() })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    await createOrderHandlers(client).ussd_shop_orders("o1")
    err.mockRestore()
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })
  it("fulfilment throws: order left pending, profit still credited, no SMS, then throws (needs_review)", async () => {
    fulfillUssdOrder.mockRejectedValue(new Error("module crashed"))
    const { client, updates, profits } = fakeDb({ ussd_shop_orders: shopOrder() })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(createOrderHandlers(client).ussd_shop_orders("o1")).rejects.toThrow(/fulfilment could not be triggered/)
    err.mockRestore()
    expect(updates.some(u => u.patch.order_status === "pending")).toBe(true)
    expect(profits).toHaveLength(1)
    expect(sendSMS).not.toHaveBeenCalled()
  })
  it("profit insert fails: customer still served, then throws so the row lands in needs_review", async () => {
    const { client } = fakeDb({ ussd_shop_orders: shopOrder() }, { profitError: true })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(createOrderHandlers(client).ussd_shop_orders("o1")).rejects.toThrow(/shop profit not credited/)
    err.mockRestore()
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })
  it("missing order: throws", async () => {
    const { client } = fakeDb({})
    await expect(createOrderHandlers(client).ussd_shop_orders("o1")).rejects.toThrow(/not found/)
  })
  it("fail handler (expiry) only fails an unpaid shop order", async () => {
    const { client, updates } = fakeDb({ ussd_shop_orders: shopOrder() })
    await createFailHandlers(client).ussd_shop_orders("o1")
    expect(updates[0]).toMatchObject({
      table: "ussd_shop_orders", patch: { order_status: "failed", payment_status: "failed" }, inCol: "payment_status", inVals: ["pending", "otp_required"],
    })
  })
})

/** In-memory HubtelTxStore with an atomic claim, enough for processFulfillment. */
function memStore(over: Partial<HubtelTxRow> = {}): HubtelTxStore & { row: () => HubtelTxRow } {
  let r = {
    session_id: "S1", hubtel_order_id: null, platform: "USSD", order_table: "ussd_shop_orders", order_id: "o1", mobile: "+233200585542",
    expected_amount: 12, amount_paid: null, amount_after_charges: null, state: "awaiting_payment", callback_status: "not_due",
    callback_attempts: 0, callback_last_error: null, callback_sent_at: null, status_check_attempts: 0, last_status_check_at: null,
    paid_at: null, created_at: "2026-10-06T10:00:00.000Z", updated_at: "2026-10-06T10:00:00.000Z", ...over,
  } as HubtelTxRow
  return {
    row: () => r,
    findBySession: async () => ({ ...r }),
    claim: async (_sid, from = ["awaiting_payment"], where) => {
      if (!from.includes(r.state)) return false
      if (where?.callback_status && r.callback_status !== where.callback_status) return false
      if (where?.paid_atIsNull && r.paid_at != null) return false
      r = { ...r, state: "processing" }
      return true
    },
    update: async (_sid, patch) => { r = { ...r, ...patch } as HubtelTxRow },
    listPendingCallbacks: async () => [],
    listAwaitingPayment: async () => [],
    listStaleProcessing: async () => [],
    listIndeterminate: async () => [],
  }
}

const paid = { sessionId: "S1", hubtelOrderId: "H1", amountPaid: 12.5, amountAfterCharges: 12, isSuccessful: true }

describe("shop order through processFulfillment", () => {
  it("duplicate Hubtel delivery: fulfilled once, shop profit once (review focus #5)", async () => {
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder() })
    const store = memStore()
    const err = vi.spyOn(console, "error").mockImplementation(() => {}) // the loser logs loudly while the winner is processing
    const outcomes = await Promise.all([
      processFulfillment(store, createOrderHandlers(client), paid),
      processFulfillment(store, createOrderHandlers(client), paid),
    ])
    err.mockRestore()
    expect([...outcomes].sort()).toEqual(["duplicate", "fulfilled"])
    expect(profits).toHaveLength(1)
    expect(fulfillUssdOrder).toHaveBeenCalledTimes(1)
    expect(store.row()).toMatchObject({ state: "fulfilled", callback_status: "pending", hubtel_order_id: "H1" })
  })
  it("payment after the order expired: needs_review, handler never runs (review focus #6)", async () => {
    const { client, profits } = fakeDb({ ussd_shop_orders: shopOrder({ order_status: "failed", payment_status: "failed" }) })
    const store = memStore({ state: "failed" })
    const outcome = await processFulfillment(store, createOrderHandlers(client), paid)
    expect(outcome).toBe("needs_review")
    expect(profits).toHaveLength(0)
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(store.row()).toMatchObject({ state: "needs_review", callback_status: "pending" })
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run lib/ussd-hubtel/order-handlers.shop.test.ts`
Expected: FAIL: `createOrderHandlers(...).ussd_shop_orders is not a function` in the handler describe; the fail-handler test and "payment after the order expired" already pass (registry + Plan 1 late-payment path).

- [ ] **Step 3: Write the handler**

In `lib/ussd-hubtel/order-handlers.ts` add this function above `createOrderHandlers`, add `ussd_shop_orders: orderId => ussdShopOrderPostPayment(supabase, orderId),` to the object `createOrderHandlers` returns, and delete the `// Plan 3 registers ussd_shop_orders` comment:

```ts
/**
 * Mirrors the Paystack webhook's ussd_shop_orders branch (app/api/webhooks/paystack/route.ts,
 * "Handle USSD shop orders"): conditional claim → shop profit → parent profit → customer tracking
 * → fulfillUssdOrder(…, "ussd_shop_orders") → recipient SMS without the community link.
 * Deliberate differences: no paystack_reference / payment_attempts (not a Paystack payment); no
 * WhatsApp token deduction (channel 'ussd_shop': the token was billed at code entry); a fulfilment
 * that THROWS leaves the order 'pending' for the manual queue (the webhook sets 'failed'); and a
 * missing profit credit or an untriggered fulfilment throws at the END (after the customer has
 * been served) so the tx row lands in needs_review instead of passing silently. shop_profits has
 * no unique key on ussd_shop_order_id: the conditional mark below plus processFulfillment's claim
 * on this order's single tx row are what make every credit happen exactly once; a needs_review
 * row is never re-run, so throwing late cannot double-credit.
 */
async function ussdShopOrderPostPayment(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data: order, error: lookupErr } = await supabase.from("ussd_shop_orders").select("*").eq("id", orderId).maybeSingle()
  if (lookupErr) console.error("[HUBTEL-ORDER] ussd_shop_orders lookup failed:", orderId, lookupErr)
  if (!order) throw new Error(`ussd_shop_orders ${orderId} not found`)
  if (order.payment_status === "completed") return // already processed

  // Once-only gate: only an order still unpaid can be marked paid; 0 rows ⇒ not payable.
  const payable = ORDER_TABLES.ussd_shop_orders.payableStatuses
  const { data: marked, error: markErr } = await supabase
    .from("ussd_shop_orders")
    .update({ payment_status: "completed", updated_at: new Date().toISOString() })
    .eq("id", orderId)
    .in("payment_status", [...payable])
    .select("id")
  if (markErr) throw markErr
  if (!marked || marked.length === 0) {
    throw new Error(`ussd_shop_orders ${orderId} not in a payable state: ${order.payment_status}`)
  }

  const problems: string[] = []
  const credit = async (shopId: string, amount: unknown, who: "shop" | "parent shop") => {
    const { error } = await supabase.from("shop_profits").insert([{
      shop_id: shopId,
      ussd_shop_order_id: orderId,
      profit_amount: amount,
      status: "credited",
      created_at: new Date().toISOString(),
    }])
    if (error) {
      console.error(`[HUBTEL-ORDER] Failed to credit ${who} profit:`, orderId, error)
      problems.push(`${who} profit not credited (${error.message})`)
    }
  }
  // The shop's own margin (DB trigger syncs shop_available_balance).
  if (Number(order.profit_amount) > 0) await credit(order.shop_id, order.profit_amount, "shop")
  // Sub-agent orders: the parent shop's wholesale margin.
  if (order.parent_shop_id && Number(order.parent_profit_amount) > 0) {
    await credit(order.parent_shop_id, order.parent_profit_amount, "parent shop")
  }

  // Customer tracking, as the webhook. Non-fatal.
  try {
    const { customerTrackingService } = await import("@/lib/customer-tracking-service")
    await customerTrackingService.trackCustomer({
      shopId: order.shop_id,
      phoneNumber: order.recipient_phone,
      email: "",
      customerName: "USSD Customer", // channel is always ussd_shop on this path
      totalPrice: Number(order.amount) || 0,
      slug: order.channel || "ussd_shop",
      orderId,
    })
  } catch (e) {
    console.error("[HUBTEL-ORDER] Customer tracking failed for shop order (non-fatal):", orderId, e)
  }

  let fulfillResult: { success: boolean; message: string; held?: boolean } | undefined
  try {
    const { fulfillUssdOrder } = await import("@/lib/ussd/fulfill")
    // Trust the status fulfillUssdOrder sets (processing / pending for manual / failed on blacklist).
    fulfillResult = await fulfillUssdOrder(orderId, order.network, order.recipient_phone, order.package_size ?? "", false, "ussd_shop_orders")
    if (!fulfillResult.success) console.error("[HUBTEL-ORDER] USSD shop fulfilment failed:", orderId, fulfillResult.message)
  } catch (e) {
    console.error("[HUBTEL-ORDER] Failed to trigger USSD shop fulfilment:", orderId, e)
    await supabase.from("ussd_shop_orders").update({ order_status: "pending", updated_at: new Date().toISOString() }).eq("id", orderId)
    problems.push(`fulfilment could not be triggered (${e instanceof Error ? e.message : String(e)}); order left pending for manual fulfilment`)
  }

  // Recipient SMS (shop orders omit the community link); a held order already got the hold SMS.
  if (fulfillResult && !fulfillResult.held) {
    try {
      const { sendSMS, SMSTemplates } = await import("@/lib/sms-service")
      await sendSMS({
        phone: order.recipient_phone,
        message: SMSTemplates.ussdOrderConfirmed(order.package_size, order.network),
        type: "order_confirmation",
        reference: orderId,
      })
    } catch (e) { console.warn("[HUBTEL-ORDER] shop recipient SMS failed:", e) }
  }

  if (problems.length > 0) throw new Error(`ussd_shop_orders ${orderId}: ${problems.join("; ")}`)
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run lib/ussd-hubtel/order-handlers.shop.test.ts lib/ussd-hubtel/order-handlers.test.ts`
Expected: PASS (both files; Plan 2's handler tests unchanged).

- [ ] **Step 5: Run the Hubtel suite and typecheck**

Run: `npx vitest run lib/ussd-hubtel`
Expected: PASS.
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`

- [ ] **Step 6: Commit**

```bash
git add lib/ussd-hubtel/order-handlers.ts lib/ussd-hubtel/order-handlers.shop.test.ts
git commit -m "feat(hubtel): ussd_shop_orders post-payment handler (shop + parent profit once, fulfil, SMS)"
```

---

### Task 5: Shop airtime → `airtime_orders`

Port of `lib/ussd-shop/handlers/airtime.ts` minus Paystack and OTP, with Plan 2's D7/D8 gates. Money (D12), written out:

- `rates = deps.shop.airtimeFeeRate(shopId, network)`: base = `airtimeBaseFeeRate(network, shopOwnerIsDealer(shopId))`; markup = `capShopAirtimeMarkup(base, user_shops.airtime_markup_{network})`; `totalFeeRate = base + markup`, `merchantCommissionRate = markup`.
- `{ fee, toDeliver, commission } = shopAirtimeQuote(amount, rates)`: `fee = round2(amount × total / (100 + total))`, `toDeliver = round2(amount − fee)`, `commission = round2(toDeliver × markup / 100)`.
- Order: `total_paid = amount` (= Hubtel Price), `airtime_amount = toDeliver`, `fee_amount = fee`, `merchant_commission = commission`, `shop_id`. After payment Plan 2's `airtime_orders` handler calls `markAirtimeOrderPaid`, which inserts `shop_profits { shop_id, airtime_order_id, profit_amount: merchant_commission }` when both are set.

Step transitions: as Plan 2's airtime table with `SHOP_AIRTIME_*` steps, except `0` on the recipient screen returns to SHOP_PRODUCT.

**Files:**
- Create: `lib/ussd-hubtel/flows/shop-airtime.ts`, `lib/ussd-hubtel/flows/shop-airtime.test.ts`
- Modify: `lib/ussd-hubtel/router.ts`
- Modify: `lib/ussd-hubtel/order-handlers.shop.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 `ShopServices.airtimeFeeRate`, `shopAirtimeQuote`; Task 2 `backToProduct`, `shopHeader`; Plan 2 (verify): `RouterDeps.airtime.isEnabled(network)`, `.getLimits()`, `AIRTIME_NETWORKS`, `airtimeLabel`, `AirtimeNetworkKey` (`menus.ts`), session fields `airtimeRecipient`, `airtimeNetwork`, `airtimeAmount`, `airtimeFee`, `airtimeToDeliver`, `ORDER_TABLES.airtime_orders` (item `"<NET> Airtime to <phone>"`), `createOrderHandlers(...).airtime_orders`; `fakeAirtime`.
- Produces: `flows/shop-airtime.ts`: `startShopAirtime(ctx)`, `SHOP_AIRTIME_STEPS: StepTable`, text builders `shopAirtimeRecipientText(shopName)`, `shopAirtimeNetworkText()`, `shopAirtimeAmountText(label, min, max)`, `shopAirtimeConfirmText(shopName, label, recipient, pay, get, payerLocal)`.

- [ ] **Step 0: Verify the Plan 2 interface as built**

Run:
```bash
grep -n "airtime" lib/ussd-hubtel/flow-kit.ts lib/ussd-hubtel/services.ts | head -20
grep -n "AIRTIME_NETWORKS\|export function airtimeLabel\|AirtimeNetworkKey" lib/ussd-hubtel/menus.ts
grep -n "airtimeRecipient\|airtimeNetwork\|airtimeAmount\|airtimeFee\|airtimeToDeliver" lib/ussd-hubtel/types.ts
grep -n "airtime_orders: {" -A 6 lib/ussd-hubtel/order-tables.ts
grep -n "async function airtimeOrderPostPayment" -A 30 lib/ussd-hubtel/order-handlers.ts
grep -n "export function fakeAirtime" -A 4 lib/ussd-hubtel/testing/fakes.ts
```
Expected: `RouterDeps.airtime` has `isEnabled(network)` and `getLimits()`; `AIRTIME_NETWORKS` = MTN/Telecel/AT with digits 1-3; the session fields exist with those names; the airtime handler does NOT refuse a row with `shop_id` set or `channel = 'ussd_shop'` (it read-checks `payment_status` and calls `markAirtimeOrderPaid`). If the airtime handler refuses shop rows, stop and report (D9 depends on it).

- [ ] **Step 1: Write the failing flow test**

```ts
// lib/ussd-hubtel/flows/shop-airtime.test.ts
import { describe, it, expect, vi } from "vitest"
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeAirtime, fakeShop, fakeSupabase, makeDeps, NEW_ID, OK_PKG, req, SHOP_CONFIG } from "../testing/fakes"

const shopDeps = (over: Parameters<typeof makeDeps>[0] = {}, sup = fakeSupabase({ pkg: OK_PKG })) =>
  makeDeps({ getConfig: SHOP_CONFIG, ...over }, sup)

async function toAirtime(deps: RouterDeps) {
  await hubtelRouter(req({ Type: "Initiation" }), deps)
  const menu = await hubtelRouter(req({ Message: "1234" }), deps)
  return hubtelRouter(req({ Message: digitFor(menu.Message, "Buy Airtime") }), deps)
}
async function toConfirm(deps: RouterDeps, recipient = "0244123456", amount = "10") {
  await toAirtime(deps)
  await hubtelRouter(req({ Message: recipient }), deps)
  return hubtelRouter(req({ Message: amount }), deps)
}

describe("shop airtime: recipient", () => {
  it("asks for the recipient under the shop header, phone field", async () => {
    const { deps, store } = shopDeps()
    const r = await toAirtime(deps)
    expect(r.Message).toBe("Ama Data Hub\nBuy Airtime\nEnter recipient number:\n0. Back")
    expect(r.FieldType).toBe("phone")
    expect(store.get("S1")?.step).toBe("SHOP_AIRTIME_ENTER_RECIPIENT")
  })
  it("'0' returns to the product menu without billing again", async () => {
    const deductToken = vi.fn(async () => true)
    const { deps, store } = shopDeps({ shop: fakeShop({ deductToken }) })
    await toAirtime(deps)
    const r = await hubtelRouter(req({ Message: "0" }), deps)
    expect(r.Message).toContain("What would you like to buy?")
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
    expect(deductToken).toHaveBeenCalledTimes(1)
  })
  it("unknown prefix: network pick with real names; the pair is still prefix-validated", async () => {
    const { deps, store } = shopDeps()
    await toAirtime(deps)
    const menu = await hubtelRouter(req({ Message: "0230000000" }), deps)
    expect(menu.Message).toBe("Select recipient network:\n1. MTN\n2. Telecel\n3. AT\n0. Back")
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("Enter recipient number:")
    expect(store.get("S1")?.step).toBe("SHOP_AIRTIME_ENTER_RECIPIENT")
  })
  it("unknown prefix with validation off: the picked network is used", async () => {
    const { deps, store } = shopDeps({ getPrefixConfig: async () => ({ enabled: false, map: DEFAULT_NETWORK_PREFIXES }) })
    await toAirtime(deps)
    await hubtelRouter(req({ Message: "0230000000" }), deps)
    await hubtelRouter(req({ Message: "2" }), deps)
    expect(store.get("S1")).toMatchObject({ step: "SHOP_AIRTIME_ENTER_AMOUNT", airtimeRecipient: "0230000000", airtimeNetwork: "Telecel" })
  })
  it("network airtime disabled: re-prompts the recipient", async () => {
    const { deps, store } = shopDeps({ airtime: fakeAirtime({ isEnabled: async n => n !== "MTN" }) })
    await toAirtime(deps)
    const r = await hubtelRouter(req({ Message: "0244123456" }), deps)
    expect(r.Message).toContain("MTN airtime is unavailable.")
    expect(store.get("S1")?.step).toBe("SHOP_AIRTIME_ENTER_RECIPIENT")
  })
})

describe("shop airtime: amount and price", () => {
  for (const bad of ["0.5", "501", "abc", "10.555", "10abc", "-5"]) {
    it(`rejects "${bad}"`, async () => {
      const { deps, store } = shopDeps()
      const r = await toConfirm(deps, "0244123456", bad)
      expect(r.Message).toContain("Enter a valid amount.")
      expect(store.get("S1")?.step).toBe("SHOP_AIRTIME_ENTER_AMOUNT")
    })
  }
  it("confirm uses the SHOP's fee rate (owner tier + markup): pay 10.00, they get 9.35", async () => {
    const airtimeFeeRate = vi.fn(async () => ({ totalFeeRate: 7, merchantCommissionRate: 2 }))
    const { deps, store } = shopDeps({ shop: fakeShop({ airtimeFeeRate }) })
    const r = await toConfirm(deps)
    expect(airtimeFeeRate).toHaveBeenCalledWith("shop-1", "MTN")
    expect(r.Message).toBe("Ama Data Hub\nMTN to 0244123456\nYou pay GHS 10.00\nThey get GHS 9.35\nfrom 0200585542\n1. Pay now\n2. Cancel")
    expect(store.get("S1")).toMatchObject({ step: "SHOP_AIRTIME_CONFIRM", airtimeAmount: 10, airtimeFee: 0.65, airtimeToDeliver: 9.35 })
  })
})

describe("shop airtime: confirm -> AddToCart", () => {
  it("creates a shop airtime order with the shop's commission and returns AddToCart at what the caller pays", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({}, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "MTN Airtime to 0244123456", Qty: 1, Price: 10 })
    const row = sup.inserts["airtime_orders"][0]
    expect(row).toMatchObject({
      network: "MTN", beneficiary_phone: "0244123456", airtime_amount: 9.35, fee_amount: 0.65, total_paid: 10,
      pay_separately: false, status: "pending_payment", payment_status: "pending_payment",
      user_id: null, shop_id: "shop-1", merchant_commission: 0.19,
      customer_name: "USSD Customer", customer_email: null, dialing_phone: "+233200585542", channel: "ussd_shop",
    })
    expect(row.reference_code).toMatch(/^AT-/)
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({ order_table: "airtime_orders", order_id: NEW_ID, expected_amount: 10 })
  })
  it("shop markup changed since the confirm screen: release, no order (review focus #7)", async () => {
    let markup = 2
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ shop: fakeShop({ airtimeFeeRate: async () => ({ totalFeeRate: 5 + markup, merchantCommissionRate: markup }) }) }, sup)
    await toConfirm(deps)
    markup = 4
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("release")
    expect(r.Message).toBe("Airtime rates changed. Please restart your order.")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
  it("limits lowered since the confirm screen: release, no order", async () => {
    let max = 500
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ airtime: fakeAirtime({ getLimits: async () => ({ min: 1, max }) }) }, sup)
    await toConfirm(deps)
    max = 5
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("Amount must be GHS 1-5")
    expect(sup.inserts["airtime_orders"]).toBeUndefined()
  })
  it("a duplicate '1' creates ONE order and replays the same cart", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({}, sup)
    await toConfirm(deps)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(second.Item).toEqual(first.Item)
    expect(sup.inserts["airtime_orders"]).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/ussd-hubtel/flows/shop-airtime.test.ts`
Expected: FAIL: "Buy Airtime" has no shop entry yet (`expected 'Ama Data Hub\nWhat would you like…' to be 'Ama Data Hub\nBuy Airtime…'`).

- [ ] **Step 3: Write the shop airtime flow**

```ts
// lib/ussd-hubtel/flows/shop-airtime.ts
// Shop-mode Buy Airtime. Port of lib/ussd-shop/handlers/airtime.ts minus Paystack and OTP. The
// SHOP's fee: platform base rate for the shop OWNER's tier + the shop's airtime markup (total
// capped at 10%); the markup share of what is delivered is the shop's merchant_commission,
// credited after payment by markAirtimeOrderPaid (Plan 2's airtime_orders handler, unchanged).
import { detectAirtimeNetwork } from "@/lib/airtime-pricing"
import { validateNetworkPrefix } from "@/lib/phone-format"
import { secureReference } from "@/lib/secure-random"
import { AIRTIME_NETWORKS, airtimeLabel, shopHeader, type AirtimeNetworkKey } from "../menus"
import { toLocalPhone } from "../protocol"
import { shopAirtimeQuote } from "../shop-services"
import { finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import { backToProduct } from "./shop"
import type { HubtelReply } from "../types"

const RECIPIENT = { label: "Recipient number", fieldType: "phone" as const }
const NETWORK = { label: "Recipient network" }
const AMOUNT = { label: "Airtime amount", fieldType: "decimal" as const }
const CONFIRM = { label: "Confirm airtime" }
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/

export function shopAirtimeRecipientText(shopName: string): string {
  return `${shopHeader(shopName)}\nBuy Airtime\nEnter recipient number:\n0. Back`
}

export function shopAirtimeNetworkText(): string {
  return "Select recipient network:\n" + AIRTIME_NETWORKS.map(n => `${n.digit}. ${n.label}`).join("\n") + "\n0. Back"
}

export function shopAirtimeAmountText(label: string, min: number, max: number): string {
  return `${label} Airtime\nEnter amount to pay\n(GHS ${min} - ${max}):\n0. Back`
}

export function shopAirtimeConfirmText(shopName: string, label: string, recipient: string, pay: number, get: number, payerLocal: string): string {
  return (
    `${shopHeader(shopName)}\n${label} to ${recipient}\nYou pay GHS ${pay.toFixed(2)}\n` +
    `They get GHS ${get.toFixed(2)}\nfrom ${payerLocal}\n1. Pay now\n2. Cancel`
  )
}

const nameOf = (ctx: FlowCtx) => ctx.session.shopName ?? "Shop"

export async function startShopAirtime(ctx: FlowCtx): Promise<HubtelReply> {
  return goto(ctx, { step: "SHOP_AIRTIME_ENTER_RECIPIENT" }, shopAirtimeRecipientText(nameOf(ctx)), RECIPIENT)
}

const toRecipient = (ctx: FlowCtx, msg = "") =>
  goto(ctx, { step: "SHOP_AIRTIME_ENTER_RECIPIENT", airtimeRecipient: undefined, airtimeNetwork: undefined },
    (msg ? `${msg}\n` : "") + shopAirtimeRecipientText(nameOf(ctx)), RECIPIENT)

async function enterRecipient(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return backToProduct(ctx)
  const local = toLocalPhone(ctx.input.replace(/\s+/g, ""))
  if (!/^0[0-9]{9}$/.test(local)) {
    return say(ctx, "Invalid number.\n" + shopAirtimeRecipientText(nameOf(ctx)), "SHOP_AIRTIME_ENTER_RECIPIENT", RECIPIENT)
  }
  const network = detectAirtimeNetwork(local)
  if (!network) return goto(ctx, { step: "SHOP_AIRTIME_SELECT_NETWORK", airtimeRecipient: local }, shopAirtimeNetworkText(), NETWORK)
  return useNetwork(ctx, local, network)
}

async function selectNetwork(ctx: FlowCtx): Promise<HubtelReply> {
  if (ctx.input === "0") return toRecipient(ctx)
  const picked = AIRTIME_NETWORKS.find(n => n.digit === ctx.input)
  if (!picked) return say(ctx, shopAirtimeNetworkText(), "SHOP_AIRTIME_SELECT_NETWORK", NETWORK)
  return useNetwork(ctx, ctx.session.airtimeRecipient!, picked.key)
}

/** Availability + prefix gate (Plan 2 D7), then ask the amount. */
async function useNetwork(ctx: FlowCtx, local: string, network: AirtimeNetworkKey): Promise<HubtelReply> {
  const { deps } = ctx
  const label = airtimeLabel(network)
  if (!(await deps.airtime.isEnabled(network))) return toRecipient(ctx, `${label} airtime is unavailable.`)
  const prefix = await deps.getPrefixConfig()
  if (prefix.enabled) {
    const check = validateNetworkPrefix(network, local, prefix.map)
    if (!check.ok) return toRecipient(ctx, check.message ?? "Number does not match the network.")
  }
  const { min, max } = await deps.airtime.getLimits()
  return goto(ctx, { step: "SHOP_AIRTIME_ENTER_AMOUNT", airtimeRecipient: local, airtimeNetwork: network },
    shopAirtimeAmountText(label, min, max), AMOUNT)
}

async function enterAmount(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, session } = ctx
  if (ctx.input === "0") return toRecipient(ctx)
  const network = session.airtimeNetwork!
  const label = airtimeLabel(network)
  const { min, max } = await deps.airtime.getLimits()
  const invalid = () => say(ctx, "Enter a valid amount.\n" + shopAirtimeAmountText(label, min, max), "SHOP_AIRTIME_ENTER_AMOUNT", AMOUNT)

  const amount = AMOUNT_RE.test(ctx.input) ? Number(ctx.input) : NaN
  if (!(amount > 0) || amount < min || amount > max) return invalid()
  const q = shopAirtimeQuote(amount, await deps.shop.airtimeFeeRate(session.shopId!, network))
  if (!(q.toDeliver > 0)) return invalid()

  return goto(ctx, { step: "SHOP_AIRTIME_CONFIRM", airtimeAmount: amount, airtimeFee: q.fee, airtimeToDeliver: q.toDeliver },
    shopAirtimeConfirmText(nameOf(ctx), label, session.airtimeRecipient!, amount, q.toDeliver, toLocalPhone(session.dialingPhone)), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, req, session } = ctx
  const network = session.airtimeNetwork!
  const label = airtimeLabel(network)
  const amount = session.airtimeAmount!
  if (ctx.input === "2") return finish(ctx, "Order cancelled.")
  if (ctx.input !== "1") {
    return say(ctx, shopAirtimeConfirmText(nameOf(ctx), label, session.airtimeRecipient!, amount, session.airtimeToDeliver!, toLocalPhone(session.dialingPhone)), "SHOP_AIRTIME_CONFIRM", CONFIRM)
  }

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  // Stale-session guard: settings, limits and the shop's markup may have changed.
  if (!(await deps.airtime.isEnabled(network))) return finish(ctx, `${label} airtime is no longer available.`)
  const { min, max } = await deps.airtime.getLimits()
  if (amount < min || amount > max) return finish(ctx, `Amount must be GHS ${min}-${max}. Please restart.`)
  const q = shopAirtimeQuote(amount, await deps.shop.airtimeFeeRate(session.shopId!, network))
  if (Math.abs(q.toDeliver - session.airtimeToDeliver!) > 0.001) {
    return finish(ctx, "Airtime rates changed. Please restart your order.")
  }

  return submitOrder(ctx, {
    table: "airtime_orders",
    price: amount,
    logTag: "HUBTEL-SHOP-AIRTIME",
    // Same columns as lib/shop-commerce/orders.ts createShopAirtimeOrder (the Uzo shop insert).
    row: {
      reference_code: secureReference("AT", 2, 3),
      network,
      beneficiary_phone: session.airtimeRecipient,
      airtime_amount: q.toDeliver, // what the beneficiary receives
      fee_amount: q.fee,
      total_paid: amount, // what the caller pays = Hubtel Price; Hubtel adds its charge on top
      pay_separately: false,
      status: "pending_payment",
      payment_status: "pending_payment",
      user_id: null,
      shop_id: session.shopId,
      merchant_commission: q.commission, // credited to shop_id by markAirtimeOrderPaid after payment
      customer_name: "USSD Customer",
      customer_email: null,
      dialing_phone: session.dialingPhone,
      channel: "ussd_shop",
    },
  })
}

export const SHOP_AIRTIME_STEPS: StepTable = {
  SHOP_AIRTIME_ENTER_RECIPIENT: enterRecipient,
  SHOP_AIRTIME_SELECT_NETWORK: selectNetwork,
  SHOP_AIRTIME_ENTER_AMOUNT: enterAmount,
  SHOP_AIRTIME_CONFIRM: confirm,
}
```

In `lib/ussd-hubtel/router.ts` add `import { SHOP_AIRTIME_STEPS, startShopAirtime } from "./flows/shop-airtime"`, set `airtime: startShopAirtime,` in `SHOP_PRODUCT_ENTRIES`, and add `...SHOP_AIRTIME_STEPS,` to `SHOP_STEPS`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/ussd-hubtel/flows/shop-airtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Pin that a shop airtime row goes through the same handler**

Append to `lib/ussd-hubtel/order-handlers.shop.test.ts`:

```ts
describe("shop airtime row through Plan 2's airtime_orders handler (no fork)", () => {
  it("marks paid once via markAirtimeOrderPaid, which owns the shop profit credit", async () => {
    const { client } = fakeDb({ airtime_orders: {
      id: "t1", network: "MTN", beneficiary_phone: "0244123456", dialing_phone: "+233200585542", airtime_amount: 9.35,
      payment_status: "pending_payment", shop_id: "shop-1", merchant_commission: 0.19, channel: "ussd_shop",
    } })
    await createOrderHandlers(client).airtime_orders("t1")
    expect(markAirtimeOrderPaid).toHaveBeenCalledTimes(1)
    expect(markAirtimeOrderPaid.mock.calls[0][0]).toBe("t1")
  })
})
```

Run: `npx vitest run lib/ussd-hubtel/order-handlers.shop.test.ts`
Expected: PASS. If Plan 2's airtime handler selects with a chain this fake does not support (Step 0 showed it), extend `fakeDb`'s `select` chain accordingly and note it.

- [ ] **Step 6: Run the Hubtel suite and typecheck**

Run: `npx vitest run lib/ussd-hubtel`
Expected: PASS.
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`

- [ ] **Step 7: Commit**

```bash
git add lib/ussd-hubtel/flows/shop-airtime.ts lib/ussd-hubtel/flows/shop-airtime.test.ts lib/ussd-hubtel/router.ts lib/ussd-hubtel/order-handlers.shop.test.ts
git commit -m "feat(hubtel): shop-mode airtime with shop fee rate and merchant commission"
```

---

### Task 6: Shop results-checker vouchers → `results_checker_orders`

Port of `lib/ussd-shop/handlers/results-checker.ts` minus Paystack and OTP (D13). Money, written out: `deps.shop.rcPrice(board, qty, shopId)` = `calculateRCPrice({ examBoard, quantity, shopId, applyBulk: true })`: unit = `base + min(shop markup, admin max markup)`, or `bulk base + markup` when `qty >= bulk_min` and the bulk price is lower; `total = round2(unit × qty)`; `merchantCommission = round2(markup × qty)`. Order: `total_paid = total` (= Hubtel Price), `unit_price`, `merchant_commission`, `shop_id`. After payment Plan 2's `results_checker_orders` handler calls `fulfillPaidResultsCheckerOrder`, which credits `shop_profits { shop_id, results_checker_order_id, profit_amount: merchant_commission }` when the vouchers are delivered.

Step transitions:

| Step | Input | Next |
|---|---|---|
| SHOP_PRODUCT | "Results Checker" digit | no board enabled AND in stock ⇒ same, "Results Checker unavailable."; else SHOP_RC_SELECT_BOARD |
| SHOP_RC_SELECT_BOARD | `0` | SHOP_PRODUCT |
| | valid digit | SHOP_RC_ENTER_QTY |
| SHOP_RC_ENTER_QTY | `0` | SHOP_RC_SELECT_BOARD (boards re-read) |
| | cap `< 1` (sold out meanwhile) | SHOP_PRODUCT, "<BOARD> vouchers are sold out." |
| | not an integer in `1..cap` | same, "Enter a valid quantity." |
| | ok | SHOP_RC_CONFIRM |
| SHOP_RC_CONFIRM | `2` | release "Order cancelled." |
| | `1` | replay; board enabled and stock ≥ qty; price drift ⇒ release; `submitOrder` |

**Files:**
- Create: `lib/ussd-hubtel/flows/shop-rc.ts`, `lib/ussd-hubtel/flows/shop-rc.test.ts`
- Modify: `lib/ussd-hubtel/router.ts`, `lib/ussd-hubtel/router.test.ts` (entry-registry test)
- Modify: `lib/ussd-hubtel/order-handlers.shop.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 `ShopServices.rcPrice`; Task 2 `backToProduct`, `shopMenuReply`, `shopHeader`, `SHOP_PRODUCT_ENTRIES`; Plan 2 (verify): `RouterDeps.rc.isBoardEnabled(board)`, `.availableCount(board)`, `.maxQuantity()`, `.bulkHint(board)`, `ALL_BOARDS` (`flows/rc-buy.ts`), session fields `rcBoardOptions`, `rcBoard`, `rcQty`, `rcUnitPrice`, `rcTotal`, `rcBulkApplied`, `ORDER_TABLES.results_checker_orders` (item `"<BOARD> Checker x<qty>"`), `createOrderHandlers(...).results_checker_orders`, `fakeRc`; `ExamBoard` (`lib/results-check-validation.ts`).
- Produces: `flows/shop-rc.ts`: `startShopRc(ctx)`, `SHOP_RC_STEPS: StepTable`, `shopRcBoardText(shopName, boards)`, `shopRcQtyText(board, available, max, bulk)`, `shopRcConfirmText(shopName, board, qty, total, payerLocal, bulkUnit)`.

- [ ] **Step 0: Verify the Plan 2 interface as built**

Run:
```bash
grep -n "export interface RcServices" -A 14 lib/ussd-hubtel/services.ts
grep -n "export const ALL_BOARDS" lib/ussd-hubtel/flows/rc-buy.ts
grep -n "rcBoardOptions\|rcBoard?\|rcQty\|rcUnitPrice\|rcTotal\|rcBulkApplied" lib/ussd-hubtel/types.ts
grep -n "results_checker_orders: {" -A 6 lib/ussd-hubtel/order-tables.ts
grep -n "async function rcOrderPostPayment" -A 30 lib/ussd-hubtel/order-handlers.ts
grep -n "export function fakeRc" -A 10 lib/ussd-hubtel/testing/fakes.ts
```
Expected: `RcServices` has `isBoardEnabled`, `availableCount`, `maxQuantity`, `bulkHint` (returning `{ minQty, bulkBasePrice } | null`); `ALL_BOARDS` is exported (if not, define `const ALL_BOARDS: ExamBoard[] = ["WASSCE", "BECE", "NOVDEC"]` locally and note it); the RC handler does not refuse shop rows and throws on `status: "pending"` (out of stock after payment).

- [ ] **Step 1: Write the failing flow test**

```ts
// lib/ussd-hubtel/flows/shop-rc.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter, type RouterDeps } from "../router"
import { digitFor, fakeRc, fakeShop, fakeSupabase, makeDeps, NEW_ID, OK_PKG, req, SHOP_CONFIG } from "../testing/fakes"

const shopDeps = (over: Parameters<typeof makeDeps>[0] = {}, sup = fakeSupabase({ pkg: OK_PKG })) =>
  makeDeps({ getConfig: SHOP_CONFIG, ...over }, sup)

async function toBoards(deps: RouterDeps) {
  await hubtelRouter(req({ Type: "Initiation" }), deps)
  const menu = await hubtelRouter(req({ Message: "1234" }), deps)
  return hubtelRouter(req({ Message: digitFor(menu.Message, "Results Checker") }), deps)
}
async function toConfirm(deps: RouterDeps, qty = "2") {
  await toBoards(deps)
  await hubtelRouter(req({ Message: "1" }), deps)
  return hubtelRouter(req({ Message: qty }), deps)
}

describe("shop vouchers: boards and quantity", () => {
  it("goes straight to the boards that are enabled AND in stock, under the shop header", async () => {
    const { deps, store } = shopDeps({ rc: fakeRc({ isBoardEnabled: async b => b !== "NOVDEC", availableCount: async b => (b === "BECE" ? 0 : 10) }) })
    const r = await toBoards(deps)
    expect(r.Message).toBe("Ama Data Hub\nSelect exam:\n1. WASSCE\n0. Back")
    expect(store.get("S1")).toMatchObject({ step: "SHOP_RC_SELECT_BOARD", rcBoardOptions: ["WASSCE"] })
  })
  it("every board sold out: 'Results Checker unavailable.' and stays on the product menu", async () => {
    const { deps, store } = shopDeps({ rc: fakeRc({ availableCount: async () => 0 }) })
    const r = await toBoards(deps)
    expect(r.Message).toContain("Results Checker unavailable.\nAma Data Hub\nWhat would you like to buy?")
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
  })
  it("'0' on the board list returns to the product menu", async () => {
    const { deps, store } = shopDeps()
    await toBoards(deps)
    await hubtelRouter(req({ Message: "0" }), deps)
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
  })
  it("quantity screen shows the cap and the SHOP's bulk price at the threshold", async () => {
    const rcPrice = vi.fn(async (_b: string, q: number) => (q >= 5
      ? { unitPrice: 17, totalPaid: 17 * q, bulkApplied: true, merchantCommission: 2 * q }
      : { unitPrice: 22, totalPaid: 22 * q, bulkApplied: false, merchantCommission: 2 * q }))
    const { deps } = shopDeps({
      rc: fakeRc({ availableCount: async () => 8, bulkHint: async () => ({ minQty: 5, bulkBasePrice: 15 }) }),
      shop: fakeShop({ rcPrice }),
    })
    await toBoards(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toBe("WASSCE Checker\nHow many vouchers?\n(1 - 8):\nBuy 5+ for GHS 17.00 each\n0. Back")
    expect(rcPrice).toHaveBeenCalledWith("WASSCE", 5, "shop-1")
  })
  for (const bad of ["11", "0.5", "abc", "-1"]) {
    it(`rejects quantity "${bad}"`, async () => {
      const { deps, store } = shopDeps()
      const r = await toConfirm(deps, bad)
      expect(r.Message).toContain("Enter a valid quantity.")
      expect(store.get("S1")?.step).toBe("SHOP_RC_ENTER_QTY")
    })
  }
  it("sold out between board and quantity: back to the product menu", async () => {
    let stock = 10
    const { deps, store } = shopDeps({ rc: fakeRc({ availableCount: async () => stock }) })
    await toBoards(deps)
    await hubtelRouter(req({ Message: "1" }), deps)
    stock = 0
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("WASSCE vouchers are sold out.")
    expect(store.get("S1")?.step).toBe("SHOP_PRODUCT")
  })
  it("confirm shows the shop, board x qty, shop total and payer", async () => {
    const { deps } = shopDeps()
    const r = await toConfirm(deps)
    expect(r.Message).toBe("Ama Data Hub\nWASSCE x 2\nGHS 44.00 from 0200585542\nPIN(s) sent by SMS\n1. Pay now\n2. Cancel")
  })
})

describe("shop vouchers: confirm -> AddToCart", () => {
  it("creates a shop RC order with the shop's commission; AddToCart at the shop total", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({}, sup)
    await toConfirm(deps)
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "WASSCE Checker x2", Qty: 1, Price: 44 })
    const row = sup.inserts["results_checker_orders"][0]
    expect(row).toMatchObject({
      exam_board: "WASSCE", quantity: 2, customer_name: "USSD Customer", customer_email: null, customer_phone: "0200585542",
      unit_price: 22, fee_amount: 0, total_paid: 44, shop_id: "shop-1", merchant_commission: 4,
      status: "pending_payment", payment_status: "pending_payment", dialing_phone: "+233200585542", channel: "ussd_shop",
    })
    expect(row).not.toHaveProperty("user_id") // createShopRcOrder does not set it
    expect(row.reference_code).toMatch(/^RC-/)
    expect(sup.inserts["hubtel_transactions"][0]).toMatchObject({ order_table: "results_checker_orders", order_id: NEW_ID, expected_amount: 44 })
  })
  it("shop markup changed since the confirm screen: release, no order (review focus #7, D11)", async () => {
    let unit = 22
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ shop: fakeShop({ rcPrice: async (_b, q) => ({ unitPrice: unit, totalPaid: unit * q, bulkApplied: false, merchantCommission: 2 * q }) }) }, sup)
    await toConfirm(deps)
    unit = 25
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toBe("Price changed to GHS 50.00. Please restart your order.")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
  })
  it("stock dropped below the quantity since the confirm screen: release, no order", async () => {
    let stock = 10
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({ rc: fakeRc({ availableCount: async () => stock }) }, sup)
    await toConfirm(deps)
    stock = 1
    const r = await hubtelRouter(req({ Message: "1" }), deps)
    expect(r.Message).toContain("no longer available")
    expect(sup.inserts["results_checker_orders"]).toBeUndefined()
  })
  it("a duplicate '1' creates ONE order and replays the same cart", async () => {
    const sup = fakeSupabase({ pkg: OK_PKG })
    const { deps } = shopDeps({}, sup)
    await toConfirm(deps)
    const first = await hubtelRouter(req({ Message: "1" }), deps)
    const second = await hubtelRouter(req({ Message: "1" }), deps)
    expect(second.Item).toEqual(first.Item)
    expect(sup.inserts["results_checker_orders"]).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/ussd-hubtel/flows/shop-rc.test.ts`
Expected: FAIL: "Results Checker" has no shop entry yet.

- [ ] **Step 3: Write the shop vouchers flow**

```ts
// lib/ussd-hubtel/flows/shop-rc.ts
// Shop-mode results-checker vouchers. Port of lib/ussd-shop/handlers/results-checker.ts minus
// Paystack and OTP: board -> quantity -> confirm (no sub-menu, no My Vouchers, no Check Results,
// exactly what the Uzo shop offers). Price = calculateRCPrice with the shop's markup; the markup
// x qty is merchant_commission, credited by fulfillPaidResultsCheckerOrder on delivery.
import type { ExamBoard } from "@/lib/results-check-validation"
import { secureReference } from "@/lib/secure-random"
import { shopHeader } from "../menus"
import { toLocalPhone } from "../protocol"
import { finish, goto, replaySubmittedOrder, say, submitOrder, type FlowCtx, type StepTable } from "../flow-kit"
import { ALL_BOARDS } from "./rc-buy"
import { backToProduct, shopMenuReply } from "./shop"
import type { HubtelReply } from "../types"

const BOARD = { label: "Select exam" }
const QTY = { label: "Quantity", fieldType: "number" as const }
const CONFIRM = { label: "Confirm vouchers" }

export function shopRcBoardText(shopName: string, boards: string[]): string {
  return `${shopHeader(shopName)}\nSelect exam:\n` + boards.map((b, i) => `${i + 1}. ${b}`).join("\n") + "\n0. Back"
}

export function shopRcQtyText(board: string, available: number, max: number, bulk: { minQty: number; unitPrice: number } | null): string {
  const cap = Math.min(available, max)
  const hint = bulk ? `\nBuy ${bulk.minQty}+ for GHS ${bulk.unitPrice.toFixed(2)} each` : ""
  return `${board} Checker\nHow many vouchers?\n(1 - ${cap}):${hint}\n0. Back`
}

export function shopRcConfirmText(shopName: string, board: string, qty: number, total: number, payerLocal: string, bulkUnit: number | null): string {
  const bulk = bulkUnit != null ? `\nBulk rate GHS ${bulkUnit.toFixed(2)} each` : ""
  return `${shopHeader(shopName)}\n${board} x ${qty}${bulk}\nGHS ${total.toFixed(2)} from ${payerLocal}\nPIN(s) sent by SMS\n1. Pay now\n2. Cancel`
}

const nameOf = (ctx: FlowCtx) => ctx.session.shopName ?? "Shop"

/** Boards that are enabled AND in stock, fixed order (Uzo buildRcBoardOptions). */
async function boardOptions(ctx: FlowCtx): Promise<ExamBoard[]> {
  const rc = ctx.deps.rc
  const picks = await Promise.all(ALL_BOARDS.map(async b => ((await rc.isBoardEnabled(b)) && (await rc.availableCount(b)) > 0 ? b : null)))
  return picks.filter((b): b is ExamBoard => b !== null)
}

/** Quantity screen; the bulk hint shows the SHOP's unit price at the threshold (Uzo shop). */
async function qtyScreen(ctx: FlowCtx, board: ExamBoard) {
  const rc = ctx.deps.rc
  const [available, max, hint] = await Promise.all([rc.availableCount(board), rc.maxQuantity(), rc.bulkHint(board)])
  let bulk: { minQty: number; unitPrice: number } | null = null
  if (hint) {
    const atThreshold = await ctx.deps.shop.rcPrice(board, hint.minQty, ctx.session.shopId!)
    if (atThreshold.bulkApplied) bulk = { minQty: hint.minQty, unitPrice: atThreshold.unitPrice }
  }
  return { available, max, text: shopRcQtyText(board, available, max, bulk) }
}

export async function startShopRc(ctx: FlowCtx): Promise<HubtelReply> {
  const boards = await boardOptions(ctx)
  if (boards.length === 0) return shopMenuReply(ctx, "Results Checker unavailable.\n")
  return goto(ctx, { step: "SHOP_RC_SELECT_BOARD", rcBoardOptions: boards }, shopRcBoardText(nameOf(ctx), boards), BOARD)
}

async function selectBoard(ctx: FlowCtx): Promise<HubtelReply> {
  const options = (ctx.session.rcBoardOptions ?? []) as ExamBoard[]
  if (ctx.input === "0") return backToProduct(ctx)
  const board = /^\d+$/.test(ctx.input) ? options[Number(ctx.input) - 1] : undefined
  if (!board) return say(ctx, shopRcBoardText(nameOf(ctx), options), "SHOP_RC_SELECT_BOARD", BOARD)
  const { text } = await qtyScreen(ctx, board)
  return goto(ctx, { step: "SHOP_RC_ENTER_QTY", rcBoard: board }, text, QTY)
}

async function enterQty(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, session } = ctx
  const board = session.rcBoard as ExamBoard
  if (ctx.input === "0") {
    const boards = await boardOptions(ctx)
    if (boards.length === 0) return backToProduct(ctx, "Results Checker unavailable.\n")
    return goto(ctx, { step: "SHOP_RC_SELECT_BOARD", rcBoardOptions: boards }, shopRcBoardText(nameOf(ctx), boards), BOARD)
  }
  const { available, max, text } = await qtyScreen(ctx, board)
  const cap = Math.min(available, max)
  if (cap < 1) return backToProduct(ctx, `${board} vouchers are sold out.\n`)
  const qty = /^\d+$/.test(ctx.input) ? Number(ctx.input) : NaN
  if (!(qty >= 1 && qty <= cap)) return say(ctx, "Enter a valid quantity.\n" + text, "SHOP_RC_ENTER_QTY", QTY)

  const pricing = await deps.shop.rcPrice(board, qty, session.shopId!)
  return goto(ctx, {
    step: "SHOP_RC_CONFIRM", rcQty: qty, rcUnitPrice: pricing.unitPrice, rcTotal: pricing.totalPaid, rcBulkApplied: pricing.bulkApplied,
  }, shopRcConfirmText(nameOf(ctx), board, qty, pricing.totalPaid, toLocalPhone(session.dialingPhone), pricing.bulkApplied ? pricing.unitPrice : null), CONFIRM)
}

async function confirm(ctx: FlowCtx): Promise<HubtelReply> {
  const { deps, req, session } = ctx
  const board = session.rcBoard as ExamBoard
  const qty = session.rcQty!
  if (ctx.input === "2") return finish(ctx, "Order cancelled.")
  if (ctx.input !== "1") {
    return say(ctx, shopRcConfirmText(nameOf(ctx), board, qty, session.rcTotal!, toLocalPhone(session.dialingPhone), session.rcBulkApplied ? session.rcUnitPrice! : null), "SHOP_RC_CONFIRM", CONFIRM)
  }

  const replay = await replaySubmittedOrder(deps, req.SessionId, req.Platform)
  if (replay) return replay

  // Stale-session guard: stock, board switch and the shop's price may have moved.
  const [enabled, available] = await Promise.all([deps.rc.isBoardEnabled(board), deps.rc.availableCount(board)])
  if (!enabled || available < qty) {
    return finish(ctx, `${board} vouchers are no longer available in that quantity. Please try again.`)
  }
  const pricing = await deps.shop.rcPrice(board, qty, session.shopId!)
  if (Math.abs(pricing.totalPaid - session.rcTotal!) > 0.001) {
    return finish(ctx, `Price changed to GHS ${pricing.totalPaid.toFixed(2)}. Please restart your order.`)
  }

  return submitOrder(ctx, {
    table: "results_checker_orders",
    price: pricing.totalPaid,
    logTag: "HUBTEL-SHOP-RC",
    // Same columns as lib/shop-commerce/orders.ts createShopRcOrder (the Uzo shop insert).
    row: {
      reference_code: secureReference("RC", 2, 3),
      exam_board: board,
      quantity: qty,
      customer_name: "USSD Customer",
      customer_email: null,
      customer_phone: toLocalPhone(session.dialingPhone), // the PINs are SMSed here after payment
      unit_price: pricing.unitPrice,
      fee_amount: 0,
      total_paid: pricing.totalPaid, // the shop price; Hubtel adds its own charge on top
      shop_id: session.shopId,
      merchant_commission: pricing.merchantCommission, // credited to shop_id on voucher delivery
      status: "pending_payment",
      payment_status: "pending_payment",
      dialing_phone: session.dialingPhone,
      channel: "ussd_shop",
    },
  })
}

export const SHOP_RC_STEPS: StepTable = {
  SHOP_RC_SELECT_BOARD: selectBoard,
  SHOP_RC_ENTER_QTY: enterQty,
  SHOP_RC_CONFIRM: confirm,
}
```

In `lib/ussd-hubtel/router.ts` add `import { SHOP_RC_STEPS, startShopRc } from "./flows/shop-rc"`, set `resultsChecker: startShopRc,` in `SHOP_PRODUCT_ENTRIES`, and add `...SHOP_RC_STEPS,` to `SHOP_STEPS`.

- [ ] **Step 4: Pin the entry registry and the RC handler reuse**

In `lib/ussd-hubtel/router.test.ts` add `SHOP_PRODUCT_ENTRIES` to the import from `./router` and append inside `describe("hubtelRouter: flow registry", …)`:

```ts
  it("every shop product has an entry handler", () => {
    for (const key of ["data", "airtime", "resultsChecker"] as const) {
      expect(SHOP_PRODUCT_ENTRIES[key], key).toBeTypeOf("function")
    }
  })
```

Append to `lib/ussd-hubtel/order-handlers.shop.test.ts`:

```ts
describe("shop voucher row through Plan 2's results_checker_orders handler (no fork)", () => {
  it("marks payment and lets fulfillPaidResultsCheckerOrder deliver (it credits the shop commission)", async () => {
    fulfillPaidResultsCheckerOrder.mockResolvedValue({ success: true, status: "completed", message: "ok", newlyPaid: true })
    const { client } = fakeDb({ results_checker_orders: {
      id: "r1", exam_board: "WASSCE", quantity: 2, status: "pending_payment", payment_status: "pending_payment",
      shop_id: "shop-1", merchant_commission: 4, channel: "ussd_shop",
    } })
    await createOrderHandlers(client).results_checker_orders("r1")
    expect(fulfillPaidResultsCheckerOrder).toHaveBeenCalledTimes(1)
    expect(fulfillPaidResultsCheckerOrder).toHaveBeenCalledWith("r1")
  })
  it("out of stock after payment: throws (needs_review; admin delivers AND credits the shop by hand, D14)", async () => {
    fulfillPaidResultsCheckerOrder.mockResolvedValue({ success: false, status: "pending", message: "Stock exhausted", newlyPaid: true })
    const { client } = fakeDb({ results_checker_orders: {
      id: "r1", exam_board: "WASSCE", quantity: 2, status: "pending_payment", payment_status: "pending_payment", shop_id: "shop-1", merchant_commission: 4,
    } })
    await expect(createOrderHandlers(client).results_checker_orders("r1")).rejects.toThrow(/out of stock/)
  })
})
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/ussd-hubtel/flows/shop-rc.test.ts lib/ussd-hubtel/router.test.ts lib/ussd-hubtel/order-handlers.shop.test.ts`
Expected: PASS. (If Plan 2's RC handler error text differs from `/out of stock/`, match the real text and note it.)

- [ ] **Step 6: Run the Hubtel suite and typecheck**

Run: `npx vitest run lib/ussd-hubtel`
Expected: PASS.
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`

- [ ] **Step 7: Commit**

```bash
git add lib/ussd-hubtel/flows/shop-rc.ts lib/ussd-hubtel/flows/shop-rc.test.ts lib/ussd-hubtel/router.ts lib/ussd-hubtel/router.test.ts lib/ussd-hubtel/order-handlers.shop.test.ts
git commit -m "feat(hubtel): shop-mode results-checker vouchers with shop markup"
```

---

### Task 7: Admin can select shop mode

The release gate (D17): until this task the config route rejects `mode: "shop"`, so shop mode cannot be turned on while partly built.

**Files:**
- Modify: `app/api/admin/ussd-hubtel/config/route.ts`
- Create: `app/api/admin/ussd-hubtel/config/route.test.ts`
- Modify: `app/admin/ussd-hubtel/page.tsx`

**Interfaces:**
- Consumes: `getHubtelUssdConfig`, `setHubtelUssdConfig`, `hubtelEnvReady` (`lib/ussd-hubtel/config.ts`, Plan 1, unchanged); `verifyAdminAccess` (`lib/admin-auth.ts`).
- Produces: `POST /api/admin/ussd-hubtel/config` accepts `mode: "main" | "shop"`; anything else ⇒ 400 `{ error: "mode must be 'main' or 'shop'" }`.

- [ ] **Step 0: Verify the current files as built**

Run:
```bash
grep -n "mode" app/api/admin/ussd-hubtel/config/route.ts
grep -n "SelectItem\|PageHeaderBanner\|config.mode" app/admin/ussd-hubtel/page.tsx
ls app/api/admin/ussd-hubtel/resolve/route.test.ts
```
Expected: the route still has `if (body?.mode !== undefined && body.mode !== "main") {` returning `"Only 'main' mode is available yet"`; the page has `<SelectItem value="shop" disabled>Shop USSD (coming soon)</SelectItem>` and the banner subtitle `"One Hubtel code serving the main menu. Configure the channel and watch payments."`; Plan 2's route test exists (the mocking pattern below is the same). Adapt the replacements to the real text.

- [ ] **Step 1: Write the failing route test**

```ts
// app/api/admin/ussd-hubtel/config/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  auth: { isAdmin: true, userId: "admin-1" } as any,
  get: vi.fn(),
  set: vi.fn(),
  envReady: vi.fn(),
}))
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => h.auth) }))
vi.mock("@/lib/ussd-hubtel/config", () => ({
  getHubtelUssdConfig: (...a: any[]) => h.get(...a),
  setHubtelUssdConfig: (...a: any[]) => h.set(...a),
  hubtelEnvReady: (...a: any[]) => h.envReady(...a),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ insert: () => Promise.resolve({ error: null }) }) }),
}))

import { POST } from "./route"

const base = { enabled: false, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } }
const post = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/ussd-hubtel/config", { method: "POST", body: JSON.stringify(body) })

beforeEach(() => {
  h.auth = { isAdmin: true, userId: "admin-1" }
  h.get.mockReset().mockResolvedValue(base)
  h.set.mockReset().mockResolvedValue({ ...base, mode: "shop" })
  h.envReady.mockReset().mockReturnValue({ ready: true, missing: [] })
})

describe("POST /api/admin/ussd-hubtel/config: mode", () => {
  it("accepts mode 'shop'", async () => {
    const res = await POST(post({ mode: "shop" }))
    expect(res.status).toBe(200)
    expect(h.set.mock.calls[0][1]).toMatchObject({ mode: "shop" })
  })
  it("still accepts mode 'main'", async () => {
    h.set.mockResolvedValue(base)
    const res = await POST(post({ mode: "main" }))
    expect(res.status).toBe(200)
    expect(h.set.mock.calls[0][1]).toMatchObject({ mode: "main" })
  })
  it("rejects any other mode with 400 and writes nothing", async () => {
    for (const mode of ["bogus", "", "Shop", 1, null]) {
      const res = await POST(post({ mode }))
      expect(res.status, String(mode)).toBe(400)
      expect(await res.json()).toEqual({ error: "mode must be 'main' or 'shop'" })
    }
    expect(h.set).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run app/api/admin/ussd-hubtel/config`
Expected: FAIL: `accepts mode 'shop'` gets 400 (`expected 400 to be 200`).

- [ ] **Step 3: Accept shop mode in the route**

In `app/api/admin/ussd-hubtel/config/route.ts` replace

```ts
  if (body?.mode !== undefined && body.mode !== "main") {
    return NextResponse.json({ error: "Only 'main' mode is available yet" }, { status: 400 })
  }
```

with

```ts
  if (body?.mode !== undefined && body.mode !== "main" && body.mode !== "shop") {
    return NextResponse.json({ error: "mode must be 'main' or 'shop'" }, { status: 400 })
  }
```

Run: `npx vitest run app/api/admin/ussd-hubtel/config`
Expected: PASS (3 tests).

- [ ] **Step 4: Enable the option on the page**

In `app/admin/ussd-hubtel/page.tsx`:

(a) Replace `<SelectItem value="shop" disabled>Shop USSD (coming soon)</SelectItem>` with `<SelectItem value="shop">Shop USSD (shop code first)</SelectItem>`.

(b) Replace the banner subtitle `"One Hubtel code serving the main menu. Configure the channel and watch payments."` with `"One Hubtel code serving the main menu or the shop menu. Configure the channel and watch payments."`.

(c) Directly after the closing `</div>` of the Mode row (the `<div className="flex items-center justify-between">` that holds the Mode `<Select>`), add:

```tsx
                {config.mode === "shop" && (
                  <p className="text-xs text-muted-foreground">
                    Shop mode: callers enter a shop code first, and each call costs that shop one session token when the code is
                    accepted. AFA is not offered in shop mode; the other toggles below apply to the shop menu. Calls already in
                    progress keep the mode they started with.
                  </p>
                )}
```

- [ ] **Step 5: Typecheck, lint and test**

Run: `npx vitest run lib/ussd-hubtel app/api/admin/ussd-hubtel`
Expected: PASS.
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`
Run: `npx eslint app/admin/ussd-hubtel app/api/admin/ussd-hubtel lib/ussd-hubtel`
Expected: 0 errors (pre-existing `no-explicit-any` warnings are acceptable).

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/ussd-hubtel/config/route.ts app/api/admin/ussd-hubtel/config/route.test.ts app/admin/ussd-hubtel/page.tsx
git commit -m "feat(hubtel): admin can switch the Hubtel code to shop mode"
```

---

### Task 8: Simulator `SHOP=1` path and shop-mode runbook

No unit tests (project convention for scripts/docs, as Plans 1-2); verified by typecheck. The live simulator run stays a runbook item for the owner (never against production).

**Files:**
- Modify: `scripts/hubtel-simulate.ts`
- Modify: `docs/hubtel-ussd-runbook.md`

**Interfaces:**
- Consumes: Plan 2's simulator (`FLOWS`, `pick`, `Step`, `interact`, `main`, env `FLOW`, `MOBILE`, `RECIPIENT`, `AMOUNT`, `REPLAY`); the shop texts from Tasks 2-6 ("Enter shop code:", "Buy Data Bundle", "Buy Airtime", "Results Checker", "1. Pay now").
- Produces: env `SHOP=1` (shop mode) and `SHOP_CODE` for `scripts/hubtel-simulate.ts`; `FLOW=data|airtime|rc` in shop mode.

- [ ] **Step 0: Verify the Plan 2 simulator and runbook as built**

Run:
```bash
grep -n "const FLOWS\|const pick\|type Step\|async function main\|const first\|let reply" scripts/hubtel-simulate.ts
grep -n "^#\|0107\|Shop mode is not on the Hubtel channel\|^6\. \*\*Plan 2" docs/hubtel-ussd-runbook.md
```
Expected: Plan 2's `FLOWS` record, `pick(label)`, `Step` type and a `main()` that starts with `const f = FLOWS[flow]`, `const first = await interact("Initiation", "*713#")`, `let reply = await interact("Response", pick(f.menu)(first.Message))`. The runbook has the Plan 2 title, the `0107` prerequisite bullet, a PHASE B step 6 for Plan 2 services, section 4 "Operate", and section 5 "Known limitations (after Plan 2)" with the bullet "Shop mode is not on the Hubtel channel yet…". Adapt the anchors below to the real text.

- [ ] **Step 1: Add the shop path to the simulator**

(a) In the header comment, after the `// FLOW = …` line, add:

```ts
// SHOP=1 walks SHOP mode (set Mode = "Shop USSD" on /admin/ussd-hubtel first): it enters SHOP_CODE
// (an ACTIVE code with tokens in that non-production project; each run spends one token), then
// FLOW = data (default) | airtime | rc from the shop's menu.
```

(b) After the `FLOWS` constant add:

```ts
const shop = process.env.SHOP === "1"
const shopCode = process.env.SHOP_CODE ?? "1234"
const SHOP_FLOWS: Record<string, { menu: string; steps: Step[] }> = {
  // first network the shop sells, first package, recipient
  data: { menu: "Buy Data Bundle", steps: ["1", "1", recipient] },
  // recipient, amount the caller pays
  airtime: { menu: "Buy Airtime", steps: [recipient, process.env.AMOUNT ?? "1"] },
  // first board in stock, quantity 1
  rc: { menu: "Results Checker", steps: ["1", "1"] },
}
```

(c) Replace the first three statements of `main()`:

```ts
  const f = FLOWS[flow]
  if (!f) throw new Error(`Unknown FLOW "${flow}". Use one of: ${Object.keys(FLOWS).join(", ")}`)
  const first = await interact("Initiation", "*713#")
  let reply = await interact("Response", pick(f.menu)(first.Message))
```

with:

```ts
  const flows = shop ? SHOP_FLOWS : FLOWS
  const f = flows[flow]
  if (!f) throw new Error(`Unknown FLOW "${flow}"${shop ? " in shop mode" : ""}. Use one of: ${Object.keys(flows).join(", ")}`)
  let menu = await interact("Initiation", "*713#")
  if (shop) {
    if (menu.Type !== "response" || !menu.Message.includes("Enter shop code")) {
      return console.log('Not in shop mode (set Mode = "Shop USSD" on /admin/ussd-hubtel) - stopping.')
    }
    menu = await interact("Response", shopCode)
    if (menu.Type !== "response" || !menu.Message.includes("What would you like to buy?")) {
      return console.log("Shop code refused (invalid, inactive, or no sessions left) - stopping.")
    }
  } else if (menu.Type !== "response" || menu.Message.includes("Enter shop code")) {
    return console.log("The code is in shop mode: run with SHOP=1 SHOP_CODE=<code> - stopping.")
  }
  let reply = await interact("Response", pick(f.menu)(menu.Message))
```

The rest of `main()` (steps loop, "1" = Pay now, fulfilment post, `REPLAY`) is unchanged.

- [ ] **Step 2: Typecheck the script**

Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`

- [ ] **Step 3: Update the runbook**

In `docs/hubtel-ussd-runbook.md`:

(a) Replace the title line with `# Hubtel USSD — go-live runbook (Plans 1-3: data, airtime, results checker, AFA, shop mode)`.

(b) After the `0107_hubtel_resolution.sql` prerequisite bullet add:

```markdown
- [ ] **Plan 3 (shop mode) adds NO migration**: `0106` already allows `ussd_shop_orders` in `hubtel_transactions.order_table`, and `0107` must already be applied (Plan 2). **Deploy ordering:** deploy Plan 3 with the Mode still on **Main USSD**, wait until the new deployment is the only one serving production, and only then switch the Mode to **Shop USSD**. An instance still running pre-Plan-3 code answers every shop-mode request with "Service unavailable".
```

(c) In PHASE A step 2, after the Plan 2 per-flow list, add:

```markdown
   **Shop mode (Plan 3).** On the same non-production server set Mode = **Shop USSD** on `/admin/ussd-hubtel`, pick a test shop whose code is `active` with a few tokens, and note its balance (`select code, status, token_balance from ussd_shop_codes where code = '<CODE>';`). Then:
   - `SHOP=1 SHOP_CODE=<CODE> FLOW=data`: expect the shop's name and "What would you like to buy?", only the networks that shop sells (real names), shop prices, then `AddToCart` "<size> <network> Data" at the shop price (no fee added). After fulfilment: the `ussd_shop_orders` row is `payment_status=completed`, `channel=ussd_shop`; `shop_profits` has exactly ONE row with `ussd_shop_order_id` = that order for the shop (`profit_amount` = the order's `profit_amount`), plus exactly one for the parent shop if it is a sub-agent shop with `parent_profit_amount > 0`; `token_balance` went down by exactly 1.
   - The same with `REPLAY=1`: the second delivery is `outcome: "duplicate"` and there is still exactly one `shop_profits` row per shop for the order.
   - `SHOP=1 SHOP_CODE=<CODE> FLOW=airtime` and `FLOW=rc`: `AddToCart` at the shop price; the `airtime_orders` / `results_checker_orders` row has `shop_id` set and `channel=ussd_shop`; after fulfilment a `shop_profits` row for its `merchant_commission` exists when that is > 0 (for vouchers only once they were delivered).
   - Token billing: each simulator run is one Hubtel session, so `token_balance` drops by exactly 1 per run whether or not the purchase completes. An unknown, inactive or suspended code, or a code with 0 tokens, is refused with no deduction.
   - Switch the Mode back to **Main USSD** unless you are going live in shop mode.
```

(d) In PHASE B, after step 6 (Plan 2 services), add:

```markdown
7. **Shop mode (only if the code will run in shop mode):** switch the Mode to **Shop USSD**. Calls already in progress finish in the mode they started with; new calls get the shop-code prompt. With your own test shop, make ONE small purchase per shop service you will offer and check: the row on `/admin/ussd-hubtel` (state `fulfilled`, `callback_status=sent`); the shop's `token_balance` dropped by exactly 1 for that call; `shop_profits` has exactly one row per shop for the order. Switching the Mode back is always safe.
```

(e) In section 4 (Operate) add:

```markdown
- **Shop mode billing:** one session token per Hubtel session per shop code, taken when the code is accepted (the Uzo shop-code rule). It is NOT refunded when the caller cancels, times out or never pays. A retried request or a "Session expired" restart of the same Hubtel session never takes a second token; entering a different shop's code in the same session charges that shop. If Redis is unavailable when a code is entered, the caller sees "Shop unavailable. Try again." and nothing is charged.
- **Shop profit:** credited once, after payment: data orders by the Hubtel handler (`shop_profits.ussd_shop_order_id`, shop + parent shop); airtime and vouchers by the shared airtime / results-checker services (`airtime_order_id` / `results_checker_order_id`, from `merchant_commission`). A duplicate Hubtel delivery never credits twice.
- **Shop `needs_review` reasons:** "shop profit not credited" / "parent shop profit not credited" (the `shop_profits` insert failed: insert the missing row by hand with the order's `profit_amount` / `parent_profit_amount`, then Mark resolved); "fulfilment could not be triggered" (the order was left `pending`: fulfil it from the manual queue, then Mark resolved); shop vouchers out of stock after payment (deliver the vouchers AND credit the shop its `merchant_commission` by hand, because the service only credits it on automatic delivery, then Mark resolved).
- **Late payment on a shop order** (paid after the order expired): the row lands in `needs_review`; the order stays failed, no profit is credited and nothing is delivered. Deliver (and credit profit) or refund manually.
```

(f) In section 5, change the heading to `## 5. Known limitations (after Plan 3)` and replace the bullet that starts `- Shop mode is not on the Hubtel channel yet` with:

```markdown
- Shop mode serves one shop per call through its shop code and offers data, airtime and results-checker vouchers only: no AFA, no "My Vouchers", no "Check Results" (same as the Uzo shop code). Shop orders use `channel='ussd_shop'` like Uzo shop orders; join `hubtel_transactions (order_table, order_id)` to tell Hubtel ones apart.
- In shop mode, "0" on the network menu returns to the shop's menu (the Uzo shop code returns to code entry); to use another shop, redial.
```

- [ ] **Step 4: Full verification**

Run: `npx vitest run lib/ussd-hubtel app/api/admin/ussd-hubtel`
Expected: PASS.
Run: `npm run test:run`
Expected: everything passes except the 9 pre-existing, unrelated failures in `lib/order-health-service.test.ts`. Any other failure must be fixed.
Run: `npx tsc --noEmit 2>&1 | grep -E "hubtel" || echo ok`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add scripts/hubtel-simulate.ts docs/hubtel-ussd-runbook.md
git commit -m "docs(hubtel): shop-mode simulator path and runbook"
```

---

## Self-Review (spec coverage)

| Requirement | Covered by |
|---|---|
| Spec §1/§2/§5 "Shop mode: Initiation → enter shop code → shop product menu → same sub-flows as `lib/ussd-shop` up to CONFIRM", AddToCart | Task 2 (code + menu), Tasks 3, 5, 6 (flows end in `submitOrder`) |
| Spec §4.2 mode read on Initiation and pinned; toggling never changes an in-flight session; brief: no session ⇒ current mode | Task 2 (`session.mode`, `SHOP_STEPS` dispatch, "mode pinning" describe); D1 |
| Spec §5.1 shop mode on App/Webstore still uses the code step; FieldType per screen | Task 2 (`startShopSession` regardless of platform; code `text`, recipient `phone`, amount `decimal`, qty `number`) |
| Spec §6 insert into `ussd_shop_orders` / `airtime_orders` / `results_checker_orders` + `hubtel_transactions` | Tasks 3, 5, 6 via `submitOrder`; `ORDER_TABLES.ussd_shop_orders` (Task 3) |
| Spec §8 always-success callback; failures loud | Task 4 handler throws ⇒ `needs_review` (D10); `processFulfillment` unchanged |
| Spec §9 admin mode toggle main / shop; Hubtel-specific visibility | Task 7 (route + page); Task 2 `resolveShopMenu` uses `hubtel_ussd_config.visibility` (D7) |
| Brief 1: remove the main-only restriction in router, config route, page | Tasks 2, 7 |
| Brief 2: pin mode; Response without session restarts in current mode | Task 2 |
| Brief 3: shop code via `resolveShopCode`; invalid / inactive / no tokens as Uzo; deduct at acceptance; never twice per SessionId; document Uzo behaviour | Tasks 1-2 (`billing-guard.ts`, `enterCode`); "How the Uzo shop code bills tokens today"; D3 |
| Brief 4: shop data → `ussd_shop_orders` with profit snapshot; claim-based handler; profit once; parent profit; `fulfillUssdOrder(…, "ussd_shop_orders")`; fail handler | Tasks 3, 4 |
| Brief 5: shop airtime and shop RC as the Uzo shop offers; reuse Plan 2 handlers | Tasks 5, 6; D9, D13 |
| Brief 6: replay keyed by `tx.order_table`, extended for `ussd_shop_orders` | Task 3 Step 0 (verify) + Step 1 (registry) + replay tests |
| Brief 7: visibility applies to the shop menu; kill switch respected | Task 2 (menu tests, kill-switch test); D2, D7 |
| Brief 8: simulator `SHOP=1`; runbook (token billing per session, profit once, deploy ordering) | Task 8 |
| Spec §11 router steps for both modes, simulator | Tasks 2-6 tests; Task 8 |
| Review Focus 1-8 | #1, #2 Task 2 ("shop code", "token billing"); #3 Task 2 ("mode pinning") + Task 3 replay across a flip; #4 Task 3 networks / sub-agent; #5 Task 4 race + `processFulfillment` duplicate; #6 Task 4 late payment (handler + `processFulfillment`); #7 Tasks 3, 5, 6 drift tests; #8 Task 2 kill switch |

Gaps carried forward (not in scope): Plan 1 deferred M3 (`dialing_phone` stored `+233…`, so the Uzo shop's pending-OTP lookup and "my orders" do not list Hubtel shop orders; `/admin/refunds` payer phone format) and M5 (callback double-send) remain open. The Paystack-path gap that vouchers delivered manually after a stock-out never auto-credit `merchant_commission` is shared, documented (D14), not fixed.

Placeholder scan: no TBD/TODO steps; every code step shows the code; every Plan 2 dependency has a Step 0 grep. Type consistency: `RouterDeps` grows only by `shop` and `shopBilling` (Task 1) and `makeDeps` gains matching defaults in the same task; `ShopServices` method names (`resolveCode`, `deductToken`, `notifyLowTokens`, `networks`, `bundles`, `verifyBundlePrice`, `orderContext`, `airtimeFeeRate`, `rcPrice`) are identical in Tasks 1-6 and in `fakeShop`; `ShopBillingGuard.claim/release` and `BillingClaim` identical in Tasks 1-2; steps `SHOP_ENTER_CODE … SHOP_RC_CONFIRM` are declared once (Task 2) and used with the same spelling; `HubtelOrderTable` gains only `"ussd_shop_orders"` (Task 3); `SHOP_PRODUCT_ENTRIES` keys `data` / `airtime` / `resultsChecker` match `ShopMenuKey`; `shopHeader`, `shopMenuReply`, `backToProduct` are named identically wherever used.
