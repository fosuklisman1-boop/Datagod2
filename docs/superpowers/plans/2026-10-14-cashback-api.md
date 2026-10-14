# Commission Cashback — Plan B: Public API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API resellers (`/api/v1`, API-key auth, wallet-paid) buy airtime, Standard Bundles and Utility Bills with their tier's cashback share.

**Architecture:** Thin v1 routes over the live, reviewed engines: `purchaseAirtime` (already takes `channel: "api"`), `buyBundle` / `getCatalog` (lib/standard-bundles), `verifyBill` / `payBill` (lib/bills). The engines already price with `quoteCashback`; Plan B passes `channel: "api"` through, enables the `api` surface in the config validator, and adds the v1 surface (auth, per-key rate limits, sandbox mode, snake_case, docs registry, logging).

**Tech Stack:** Next.js 15, TypeScript, Supabase (service role), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-cashback-storefront-api-design.md` §3 (api pricing) and §6 (endpoints). Plan A is live (`e089b68e`).

## Global Constraints

- API price = `face − customerCashback` with the API user's tier share (`dealer` for role dealer/sub_agent, else `customer`), channel `api`, **no payment fee** (wallet-paid). Switch: `cfg.surfaces.api` (validator now allows enabling `api`; `bots` stays rejected).
- When the api surface is off: airtime keeps today's v1 pricing byte-for-byte; bundles/bills endpoints return 403 `{ success:false, error:"not_available" }`.
- Orders: bills/bundles rows with `channel='api'`, `user_id` = API key owner (wallet debited via the existing RPCs `bill_order_debit` / `data_order_debit` which deduct `COALESCE(paid_amount, amount)`); all Phase 3a/2b safety rules unchanged (single-use verify token, idempotency key per user, pre-checks before debit, atomic debit, dispatch claim, never resend, manual refunds via the existing wallet paths — api rows are wallet rows, so the Hubtel review queue / admin refunds apply as for dashboard rows).
- Every v1 route: `authenticateApiKey`, per-key rate limit (GET = key limit; POST = max(5, floor(limit/3)) like airtime), `checkPhoneVerified` where airtime does, `logApiRequest`, `classifyServiceError`, **sandbox keys** never touch Hubtel or the wallet (mirror `placeSandboxOrder` / `getSandboxOrder`).
- Request/response fields snake_case like existing v1; money as numbers in GHS with 2 dp; `expected_pay` optional on purchases → 409 `{ success:false, error:"price_changed", quote:{ face_amount, pay_amount, customer_cashback } }`.
- Nothing sent to Hubtel carries product words (engines already use opaque refs).
- Route files export only handlers + route config; `maxDuration = 60` on purchase routes. Edit/Write tools only; regexes in tested lib helpers. Real `next build` before pushing; before pushing main, check local main for foreign commits and chain `merge --ff-only && push`. Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No migration expected (0117–0120 already allow `channel='api'`); if one is needed it is **0122** (0121 is taken).

## Review Focus

1. API surface off ⇒ v1 airtime responses/charges identical to today; bundles/bills 403 (Tasks 1, 3).
2. Sandbox key ⇒ no wallet debit, no Hubtel call, deterministic fake order for every new endpoint (Tasks 2–3).
3. Idempotency across retries from integrators: same `idempotency_key` ⇒ one order/one debit (bundles); same `verify_token` ⇒ one bill (Tasks 2–3).
4. An API key can only read its own orders (`GET …/{reference}` scoped to the key owner) (Tasks 2–3).
5. Price check: `expected_pay` mismatch ⇒ 409 with nothing debited (Tasks 1–3).

---

### Task 1: Engine wiring + config

**Files:** `lib/cashback/config.ts` (+ test): allow surface `api`. `lib/bills/service.ts`, `lib/standard-bundles/service.ts` (+ tests): add an optional `channel: "dashboard" | "api"` to `payBill` / `buyBundle` inputs (default `dashboard`), used for the quote and stored on the order row; api requires `user_id` (wallet). `app/api/v1/airtime/route.ts`: confirm `channel:"api"` + `expected_pay` already wired (Part 1) — add a test that with the api surface off the response/charge is unchanged and with it on cashback applies with the key owner's tier.
Commit `feat(cashback): api channel in bills/bundles engines and config`.

### Task 2: v1 Standard Bundles

**Files:** `app/api/v1/bundles/route.ts` (GET catalog `?network=MTN|TELECEL|AT` → `{ success, network, categories:[{ name, bundles:[{ bundle_token, display, face_amount, pay_amount, customer_cashback }] }] }`; POST `{ bundle_token, phone, idempotency_key, expected_pay? }` → `{ success, order:{ reference, status, payment_status, face_amount, paid_amount, cashback, network, bundle, phone, created_at } }`), `app/api/v1/bundles/[reference]/route.ts` (GET own order status), `lib/api-v1/bundles.ts` (+ tests: mapping, sandbox, errors).
Sandbox: catalog from the live fixture shape (static), purchase returns a fake completed order without wallet/Hubtel.
Commit `feat(api): v1 Standard Bundles endpoints`.

### Task 3: v1 Utility Bills

**Files:** `app/api/v1/bills/verify/route.ts` (POST `{ biller, account?, phone?, email?, broadband_account?, meter_type? , add_meter?, consent? }` → `{ success, customer_name, amount_due, suggested_amount, verify_token, meters? }`), `app/api/v1/bills/route.ts` (POST `{ verify_token, amount, expected_pay? }` → order), `app/api/v1/bills/[reference]/route.ts`, `lib/api-v1/bills.ts` (+ tests). API names are NOT masked (authenticated, wallet-paying reseller — same as dashboard). Sandbox as Task 2.
Commit `feat(api): v1 Utility Bills endpoints`.

### Task 4: Docs registry, admin, verification, runbook

- `lib/api-docs-registry.ts`: document the new endpoints (requests, responses, errors incl. 403 not_available, 409 price_changed, sandbox notes) in the existing format.
- Cashback tab: API surface switch active (bots stays "coming later"); margin report channel filter gains `api`.
- Admin bills/bundles lists: channel `API` label.
- Full vitest (9 known order-health failures only), tsc 0, real `next build`.
- Runbook "Commission Cashback — API": no migration; enable the API surface; test with a sandbox key, then one live key (cheapest bundle to own number, GHS 1 airtime, smallest bill).
Commit; STOP before pushing.

## Self-review

Spec §6 endpoints → Tasks 2–3 (+ airtime Task 1); §3 api pricing → Task 1; admin/docs → Task 4. Storefront pieces were Plan A.
