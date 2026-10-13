# Commission Cashback — Part 1 (engine, admin, dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dashboard buyers of airtime, Utility Bills and Standard Bundles pay face value minus an admin-set share of the provider's commission, the provider still receives face value, and admins configure rates/shares and see a set-vs-actual margin report.

**Architecture:** One pure quote engine (`lib/cashback/quote.ts`) driven by an `admin_settings` config (`commission_cashback_config`, atomic patch RPC). Each dashboard checkout asks the engine at pay time; the client shows the same quote (via a small rates endpoint) and sends the price it showed, so a changed price is a 409, never a surprise charge. Orders store the quote; debit and refund paths use the paid amount.

**Tech Stack:** Next.js 15, TypeScript, Supabase (service role), Vitest, shadcn UI.

**Spec:** `docs/superpowers/specs/2026-10-13-commission-cashback-design.md` (approved 2026-10-13). Checkout display reference: `docs/hubtel-commission-services/ref/cashback-checkout-reference.png`.

## Global Constraints

- Cashback = face × rate% × share% — rate = provider rate (0–20, ≤3 decimals), share = % of commission (0–100). Computed in **integer pesewas, floored**: `Math.floor(facePesewas * rate * share / 10000 + 1e-9)`. Reference values: face 10, rate 3.96: share 25 → 0.09; 50 → 0.19; 20 → 0.07; 40 → 0.15.
- The provider/Hubtel always receives **face**; the wallet is debited **payAmount = face − customerCashback** (> 0).
- Part 1 applies cashback ONLY to channel `dashboard` with no shop (`shopId` absent). Every other caller (v1 API, shop routes, USSD/WhatsApp) keeps today's pricing byte-for-byte — they pass a channel whose switch stays off in Part 1 or don't call the engine at all.
- `applied=false` ⇒ today's pricing exactly (airtime fee + pay-separately toggle remain). `applied=true` on airtime ⇒ **no fee**, `pay_separately=false`, the toggle is hidden.
- Tier: `dealer` when users.role ∈ {dealer, sub_agent}, else `customer` (matches today's airtime fee tier).
- Provider for airtime = `getAirtimeProvider()` (lib/airtime-provider.ts) at checkout; `manual` ⇒ rate 0 ⇒ not applied. Bills/bundles provider = `hubtel`.
- Rate key `"<serviceKey>:<provider>"` with service keys from `lib/hubtel-cs/services.ts` (`airtime_mtn|airtime_telecel|airtime_at|data_*|bill_*`); groups: `airtime_*`→airtime, `data_*`→bundles, `bill_*`→bills.
- Config unreadable ⇒ not applied (fail safe: no discount). Defaults: all switches off, all rates/shares 0.
- Price-check: client sends `expectedPay`; server recomputes; differs by ≥ 0.01 ⇒ 409 "Price updated — please review" with the new quote, nothing written.
- Orders snapshot the quote; config changes never alter existing orders. Refunds return the paid amount (`COALESCE(paid_amount, amount)` for bills/bundles; airtime `total_paid` already is).
- **Ruling vs spec §6:** existing columns already hold face (`airtime_orders.airtime_amount`, `hubtel_bill_orders.amount`, `hubtel_data_orders.amount` — these are what is sent to the provider) so no `face_amount` column is added; `paid_amount` is added to bills/bundles only (airtime has `total_paid`).
- UI: the reference layout (picker label "… — GHS 2.90 (was GHS 3.00)", **You pay** bold right, **You receive** what is delivered, balance + red shortfall), "GHS" label, navy tokens, 500px + `lg:`; "(was …)" hidden when not applied.
- Migrations additive, `IF NOT EXISTS`, functions `SET search_path = public` + REVOKE/GRANT service_role. Next free number expected **0119**. Route files export only handlers + route config. Edit code with Edit/Write tools only (never sed/shell); regexes only in tested lib helpers. Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Debit vs provider amount: with cashback on, the wallet is debited `payAmount` and Hubtel/Digiwapy receive face — on all three services, including the bills/bundles RPCs (Tasks 1, 5, 6).
2. Refund after a cashback sale returns exactly `paid_amount` through every refund path (Hubtel review-queue adapters for bills and bundles, bills admin never-sent refund, bundles admin never-sent refund) — never face (Task 4).
3. Price changed between screen and pay (admin edits rates, tier changes, provider switched to manual) ⇒ 409, nothing charged (Tasks 5, 6).
4. Non-dashboard callers unchanged: v1 API airtime and shop airtime produce identical prices/rows to before (Task 5 regression tests).
5. Validator rejects any config where a sale could lose money: shares > 100, storefrontCustomer + storefrontShop > 100, rate outside 0–20 (Task 2).

---

### Task 1: Migration 0119 — config RPC, order snapshot columns, paid-amount debits, margin report

**Files:** Create `migrations/0119_commission_cashback.sql`.

- `commission_cashback_config_patch(p_patch jsonb) RETURNS jsonb` — same shape as `standard_bundles_config_patch` (0118): key `commission_cashback_config`, description "Commission cashback: master/surface switches, provider rates, shares."; top-level keys replace except `surfaces`, `rates`, `shares` which merge one level (`jsonb_typeof = 'object'` guard each).
- Columns (`ADD COLUMN IF NOT EXISTS`, all nullable): on `airtime_orders`, `hubtel_bill_orders`, `hubtel_data_orders`: `cashback_amount numeric(12,2)`, `shop_share_amount numeric(12,2)`, `cashback_rate numeric(6,3)`, `cashback_share numeric(6,2)`, `cashback_provider text`, `expected_commission numeric(12,4)`; on `hubtel_bill_orders` and `hubtel_data_orders` also `paid_amount numeric(12,2) CHECK (paid_amount IS NULL OR paid_amount > 0)`.
- `CREATE OR REPLACE` `bill_order_debit` and `data_order_debit`: identical to 0117/0118 except they deduct and record `COALESCE(o.paid_amount, o.amount)` (variable `v_pay`) in both `deduct_wallet` and the `transactions.amount`.
- `cashback_margin_report(p_from timestamptz, p_to timestamptz) RETURNS TABLE(service_key text, provider text, orders bigint, face_total numeric, actual_commission numeric, cashback_total numeric, shop_share_total numeric, expected_commission numeric)`:
  - Hubtel actual: from `hubtel_cs_transactions` where `state='fulfilled'` and `completed_at` in range, grouped by `service_key` (provider 'hubtel'): count, sum(amount), sum(commission).
  - Given out: from the three order tables, completed orders in range (`created_at`), grouped by service key (airtime: `'airtime_' || lower(map network: MTN→mtn, Telecel→telecel, AirtelTigo/AT→at)`; bills: `'bill_' || biller`; bundles: `service_key`) and `COALESCE(cashback_provider, 'hubtel')`: sum cashback_amount, sum shop_share_amount, sum expected_commission.
  - FULL OUTER JOIN on (service_key, provider); NULL sums → 0.
- REVOKE ALL FROM PUBLIC, anon, authenticated; GRANT EXECUTE TO service_role for all three functions.
- [ ] Write, commit `feat(cashback): migration 0119 config RPC, order snapshot columns, paid-amount debits, margin report (not applied)`.

---

### Task 2: Config + validator

**Files:** Create `lib/cashback/config.ts`, `lib/cashback/config.test.ts`. Mirror `lib/standard-bundles/config.ts`.

**Produces:**
```ts
export const CASHBACK_CONFIG_KEY = "commission_cashback_config"
export type CashbackChannel = "dashboard" | "bots" | "storefront" | "api"
export type CashbackGroup = "airtime" | "bundles" | "bills"
export type CashbackProvider = "hubtel" | "digiwapy"
export interface GroupShares { customer: number; dealer: number; storefrontCustomer: number; storefrontShop: number }
export interface CashbackConfig {
  enabled: boolean
  surfaces: Record<CashbackChannel, boolean>
  rates: Record<string, number>                       // "<serviceKey>:<provider>" -> %
  shares: Record<CashbackGroup, GroupShares> & { overrides: Record<string, Partial<GroupShares>> }
}
export function groupOf(serviceKey: string): CashbackGroup | null   // airtime_/data_/bill_ prefixes
export function resolveCashbackConfig(raw: unknown): CashbackConfig  // never throws; only literal true enables; invalid numbers -> 0; unknown keys dropped
export function validateCashbackPatch(body: unknown): { ok: true; patch: Partial<CashbackConfig> } | { ok: false; error: string }
export function effectiveShares(cfg: CashbackConfig, serviceKey: string): GroupShares   // group shares overlaid with overrides[serviceKey]
export async function getCashbackConfig(db: SupabaseClient): Promise<CashbackConfig>
export async function setCashbackConfig(db: SupabaseClient, patch: Partial<CashbackConfig>): Promise<CashbackConfig>
```
Validation: rate keys must match `^(airtime|data|bill)_[a-z_]+:(hubtel|digiwapy)$` and the service key must exist in `HUBTEL_CS_SERVICES` (lib/hubtel-cs/services.ts); rate 0–20 with ≤3 decimals; each share 0–100 with ≤2 decimals; `storefrontCustomer + storefrontShop ≤ 100` for every group AND for every group+override combination (validate against the merged result of current config + patch: `validateCashbackPatch(body, current)`).
Tests: defaults all off/0; literal-true only; rejects share 101, storefront sum 101 (group and via override), rate 20.5, rate with 4 decimals, unknown service key, unknown provider; accepts the spec example (airtime_mtn:hubtel 3.96, bill_ecg:hubtel 1.708, customer 25, dealer 50, storefront 20/40); effectiveShares override precedence. Commit `feat(cashback): config resolve/validate/patch`.

---

### Task 3: Quote engine

**Files:** Create `lib/cashback/quote.ts`, `lib/cashback/quote.test.ts`.

**Produces:**
```ts
export interface QuoteInput { serviceKey: string; provider: CashbackProvider | "manual"; faceAmount: number; buyer: "customer" | "dealer"; channel: CashbackChannel; shop?: boolean }
export interface CashbackQuote { applied: boolean; faceAmount: number; rate: number; share: number; commission: number; customerCashback: number; shopShare: number; payAmount: number; datagodKeeps: number; provider: string }
export function quoteCashback(i: QuoteInput, cfg: CashbackConfig): CashbackQuote
export function toPesewas(n: number): number        // Math.round(n * 100)
export function samePrice(a: number, b: number): boolean  // |toPesewas(a) - toPesewas(b)| < 1
```
Rules: not applied (cashback 0, payAmount = face, share 0) when `!cfg.enabled`, `!cfg.surfaces[channel]`, provider `manual`, no group, rate 0, or the relevant share 0. Share used: storefront ⇒ `storefrontCustomer` (shopShare from `storefrontShop`), else `customer|dealer`. Pesewa floor formula from Global Constraints. `commission` = face × rate / 100 rounded to 4 dp; `datagodKeeps` = commission − customerCashback − shopShare (4 dp). Guarantee `customerCashback + shopShare ≤ commission` and `payAmount ≥ 0.01` (else not applied).
Tests: the four reference values; tier switch; storefront split (0.07 + 0.15); each not-applied condition; `faceAmount` 0.01 with a high rate ⇒ cashback 0 (floor) and applied=false; override share; floating edge (face 1.15, rate 3.96, share 50 → 2 pesewas, no 1.9999 error); `samePrice`. Commit `feat(cashback): pure quote engine`.

---

### Task 4: Refunds and debits use the paid amount (bills + bundles)

**Files:** Modify `lib/hubtel-cs/adapters/bill-orders.ts`, `lib/hubtel-cs/adapters/data-orders.ts`, `lib/bills/admin-refund.ts` (+ its route if it reads amount), `lib/standard-bundles/admin.ts` + `app/api/admin/standard-bundles/refund/route.ts`, and every refund notification text that prints the amount; tests for each.

- Every wallet credit and every "GHS x refunded" message uses `Number(order.paid_amount ?? order.amount)`. Add `paid_amount` to every select those paths use.
- Tests: an order with `amount: 10, paid_amount: 9.81` refunds exactly 9.81 through each path (adapter `refundToWallet` for both tables, bills never-sent/stuck refund, bundles never-sent/stuck refund); an order with `paid_amount: null` refunds `amount` (legacy rows).
- Grep `app/api/admin/utility-bills` and `lib/bills/admin.ts` for any other `amount` used as money returned to a user; same treatment. Commit `fix(cashback): refunds return the amount actually paid`.

---

### Task 5: Dashboard airtime with cashback

**Files:** Modify `lib/airtime-service.ts` (`purchaseAirtime`), `app/api/airtime/purchase/route.ts`, `app/api/v1/airtime/route.ts` (pass `channel: "api"`), `lib/airtime-service.test.ts`.

- `PurchaseAirtimeParams` gains `channel: CashbackChannel` (required; dashboard route passes `"dashboard"`, v1 passes `"api"`) and `expectedPay?: number`; injectable `getCashbackConfig` / `getAirtimeProvider` for tests if the file's test pattern allows (follow its existing mocking style).
- After the enable/prefix/limits checks and only when `!shopId`: resolve tier (existing role read), provider (`getAirtimeProvider(supabase, network, isDigiWapyEnabledForNetwork)`), serviceKey (`airtime_` + `airtimeNetId(network)`), config (read failure ⇒ not applied), `q = quoteCashback({ … faceAmount: params.airtimeAmount, channel })`.
- If `q.applied`: `airtimeToRecipient = face`, `totalPaid = q.payAmount`, `feeAmount = 0`, `pay_separately = false`; if `expectedPay` given and `!samePrice(expectedPay, q.payAmount)` ⇒ throw code `PRICE_CHANGED` (route → 409 with `{ quote }`) **before** the duplicate check and debit. Insert the snapshot columns (`cashback_amount`, `shop_share_amount: 0`, `cashback_rate`, `cashback_share`, `cashback_provider`, `expected_commission`). Transaction description: `Airtime: ${network} GHS ${face} to ${phone} (cashback GHS ${q.customerCashback})`.
- If not applied: **existing code path unchanged** (fee math, toggle).
- Tests: applied ⇒ deduct_wallet called with payAmount (9.91 customer / 9.81 dealer for 10 MTN at 3.96/25/50), order row airtime_amount 10, fee 0, total_paid = pay, snapshot columns set, Hubtel/Digiwapy fulfillment receives airtime_amount 10; PRICE_CHANGED ⇒ no debit, no insert; provider manual ⇒ legacy fee path; `shopId` set ⇒ legacy path even with dashboard switch on; channel "api" with api switch off ⇒ legacy path identical to before (snapshot of the inserted row); config read throws ⇒ legacy path. Commit `feat(cashback): dashboard airtime priced with instant cashback`.

---

### Task 6: Utility Bills + Standard Bundles with cashback

**Files:** Modify `lib/bills/service.ts` (+ `BillsDeps`), `lib/bills/runtime.ts`, `app/api/bills/pay/route.ts`, `lib/standard-bundles/service.ts` (+ `BundlesDeps`), `lib/standard-bundles/runtime.ts`, `app/api/standard-bundles/buy/route.ts`, tests.

- Deps gain `getCashbackConfig(): Promise<CashbackConfig>` and `getBuyerTier(userId): Promise<"customer"|"dealer">` (runtime: users.role ∈ {dealer, sub_agent}).
- In `payBill` after all existing pre-checks (amount = face within the biller's min/max) and before the insert: quote with `serviceKey = BILLERS[biller].serviceKey`, provider `hubtel`, channel `dashboard`; config/tier read failure ⇒ not applied. `expectedPay` (new optional input; route passes body.expectedPay) mismatch ⇒ `{ok:false,status:409,error:"Price updated — please review", quote}` before any write. Insert `amount: face`, `paid_amount: q.applied ? q.payAmount : null`, snapshot columns when applied. Dispatch keeps sending `order.amount` (face) to Hubtel.
- `buyBundle` same, with `serviceKey = NETWORK_SERVICE[network]`, face = token amount (the Hubtel price). The replay/resume path re-debits via the RPC, which now uses `paid_amount` — no change needed, but add a test that a resumed cashback order debits paid_amount (fake debit records the amount it would deduct from the row).
- Responses include `{ faceAmount, paidAmount, cashback }` in the picked order fields (no other new fields).
- Tests per service: applied ⇒ debit amount = pay (fake RPC reads `paid_amount ?? amount`), Hubtel purchase amount = face, snapshot columns; 409 on mismatch with nothing written; not applied ⇒ `paid_amount` null and behaviour identical to before (existing tests still pass unchanged). Commit `feat(cashback): bills and standard bundles priced with instant cashback`.

---

### Task 7: Client quote endpoint + shared display helper

**Files:** Create `app/api/cashback/rates/route.ts`, `lib/cashback/display.ts` (+ test).

- `GET /api/cashback/rates` (auth via `lib/bills/route-auth.ts` `authenticate`; rate limit 60/min/user): returns for the caller's tier and channel `dashboard` only `{ applied: boolean; services: Record<serviceKey, { provider: string; rate: number; share: number }> }` containing only services where cashback applies (airtime provider resolved per network). Never throws (errors ⇒ `{ applied:false, services:{} }`). Does NOT expose the rest of the config.
- `lib/cashback/display.ts`: `quoteForDisplay(face, entry | undefined): { pay: number; cashback: number; applied: boolean }` (reuses `quoteCashback` maths via a minimal cfg so client and server round identically) and `priceLabel(face, q) => "GHS 2.90 (was GHS 3.00)" | "GHS 3.00"`, `shortfall(balance, pay) => number | null`.
- Tests: label formats, shortfall, display quote equals server quote for the reference values. Commit `feat(cashback): client rates endpoint and display helpers`.

---

### Task 8: Dashboard UI — airtime, bills, Standard Bundles

**Files:** Modify `app/dashboard/airtime/page.tsx`, `components/bills/*` (pay/confirm step), `components/standard-bundles/*` (grid card price + buy sheet), using `lib/cashback/display.ts` and `/api/cashback/rates`.

- Follow the reference image (`docs/hubtel-commission-services/ref/cashback-checkout-reference.png`): picker/card label shows "GHS pay (was GHS face)" when applied; summary rows **You pay** (bold, right) and **You receive** ("GHS 10.00 MTN airtime" / bundle display / "ECG GHS 50.00 to <account>"); "Balance GHS x — GHS y short" in red when short.
- Airtime: when applied, hide the "Pay processing fee separately" toggle and the fee line; when not applied, the page is exactly as today.
- Each pay request sends `expectedPay`; on 409 show the server message and the new price from `quote`, and require a second tap (no auto-charge at the new price).
- Rates fetched once per page load and re-fetched before opening a pay/confirm step if older than 5 minutes.
- Verify tsc/eslint; headless screenshot at 500px if feasible. Commit `feat(cashback): dashboard checkout shows you pay / you receive`.

---

### Task 9: Admin Cashback tab — settings + margin report

**Files:** Create `app/api/admin/cashback/{config,report}/route.ts`, `app/admin/hubtel-commission/cashback.tsx`; modify `app/admin/hubtel-commission/page.tsx` (new "Cashback" tab, controlled tabs already exist).

- Config GET/POST (`requireAdmin`, 403 without userId, `auditLog` on POST, `validateCashbackPatch(body, current)` → RPC). UI: master + four surface switches (bots/storefront/api shown but labelled "Part 2/3 — not yet active" and disabled); rate table rows = every service key × provider (airtime: hubtel + digiwapy; others: hubtel) with % inputs; shares per group (customer, dealer, storefront customer, storefront shop) + "override" expander per service; live example line per group for GHS 10 using `quoteCashback`.
- Report GET `?from&to` (default last 7 days) → `cashback_margin_report` RPC. UI table per service × provider: set rate %, actual rate % (`actual_commission / face_total × 100`, 3 dp; "—" if no Hubtel data), ✓ when |set − actual| ≤ 0.05 else ⚠ (also ⚠ when set is 0 and actual exists), commission earned, cashback given, shop shares, Datagod kept (= actual − cashback − shop; for digiwapy rows use expected and label "expected") — GHS amounts. "Use actual" button per row fills the rate input (admin still clicks Save).
- Commit `feat(cashback): admin cashback settings and margin report`.

---

### Task 10: Verification, Digiwapy check, runbook, gate

- Full vitest (only the 9 known `lib/order-health-service.test.ts` failures), tsc 0, real `next build` (placeholder env) exit 0.
- **Digiwapy commission check (controller, read-only, needs user OK for prod access):** fetch one real Digiwapy status response via the existing admin `digiwapy-debug` route or the cron log and record whether `commission` is present and in % or GHS; write the finding into the runbook. Until confirmed the report labels Digiwapy rows "expected".
- Runbook section "Commission Cashback — Part 1": apply 0119 BEFORE merge (pre-check `select to_regclass('public.hubtel_bill_orders')` exists and `select column_name from information_schema.columns where table_name='airtime_orders' and column_name='cashback_amount'` empty; post: functions exist, service_role-only EXECUTE, `select data_order_debit(gen_random_uuid())` → not_found, `select * from cashback_margin_report(now()-interval '7 days', now())` runs); enable: enter rates (airtime_*:hubtel 3.96, bill_ecg:hubtel 1.708), shares, master + dashboard switch; buy GHS 1 airtime to own number, check order total_paid = pay, airtime_amount = face, ledger amount = face, wallet history = pay; refund semantics; airtime fee drops on the dashboard only.
- Commit; STOP before migrating/pushing.

## Self-review

Spec §2 decisions → Global Constraints; §4 config → Tasks 1–2; §5 engine → Task 3; §6 order data → Tasks 1, 5, 6 (ruling on face columns); §7 admin → Task 9; §8 dashboard + display reference → Tasks 7–8 (bots/storefront/API = Parts 2–3); §9 refunds → Task 4 (shop clawback = Part 3); §11 errors → Tasks 3, 5, 6 (409, fail-safe); §12 testing → per task + Task 10; §13 rollout → Task 10. Digiwapy verification → Task 10.
