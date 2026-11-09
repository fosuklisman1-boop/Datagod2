# Kuntanii Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Kuntanii as the 11th fulfillment provider (MTN only), using all 7 documented API surfaces: order, pricing, status, not-received report and lookup, beneficiary verify, and webhook.

**Architecture:** There are three new library files:
- `kuntanii-core.ts` holds pure mapping and decision helpers.
- `kuntanii-client.ts` is a thin HTTP client that takes injectable fetch and sleep functions.
- `kuntanii-provider.ts` holds `KuntaniiProvider implements MTNProvider` and orchestrates the order: attempt-chain walk → size check → beneficiary pre-check → place.

These plug into the existing factory, whitelist registry, `saveMTNTracking`, `syncMTNOrderStatus`, cron and admin patterns. Webhooks are treated as signals only. The handler re-fetches the order's status with an authenticated GET and applies it through `syncMTNOrderStatus`.

**Tech Stack:** Next.js 15 App Router, TypeScript, Supabase (service role), Vitest, PGlite for SQL tests.

**Spec:** `docs/superpowers/specs/2026-11-03-kuntanii-provider-design.md` and the API docs `docs/kuntanii/kuntanii-api-docs-2026-11-03.txt`. Read both before starting. The spec's "Calls made by Claude" list is binding.

## Global Constraints

- Work in a git worktree branched from **main**, not from `feat/api-v2-console`. Use superpowers:using-git-worktrees.
- Base URL `https://kuntanii.com`. Env vars: `KUNTANII_API_KEY`, `KUNTANII_WEBHOOK_SECRET`, `KUNTANII_BASE_URL` (optional override). Never hard-code, log or commit key values. Before every `git add`, grep the staged diff for `kt_live_` and `kt_whsec_`.
- Every request sends `Authorization: Bearer <key>` and `Content-Type: application/json`. Order POSTs also send `X-Kuntanii-Idempotency-Key: <externalOrderId>`.
- Phones are sent in local format `0XXXXXXXXX`. `dataGb` is a whole GB number. The supported sizes come from the live plan list (1–10, 12, 15, 20, 25, 30, 40, 50, 100 GB as of 2026-11-03), with `bundleSizeMb = GB × 1024`.
- Normal pricing is `GET /api/integrations/pricing` with no parameter. Instant pricing is `?deliveryMode=instant`.
- `deliveryMode: "instant"` is sent only in instant mode, and an instant order is **never** resent as normal.
- Attempt ids are `<orderId>` for attempt 1 and `<orderId>-r<n>` for n = 2..5 (`MAX_ATTEMPTS = 5`).
- Map statuses by `code` and status strings, **never** by message text.
- Never log phone numbers. Use `redactPhone()`, which shows only the last 3 digits. Database errors go through `safeDbError` where it is already used.
- New tables have RLS enabled, no policies, and `REVOKE ALL FROM anon, authenticated`.
- Use the Edit/Write tools for code edits, never `sed`.
- Use the existing `notifyAdminsThrottled(type, title, message, actionUrl, throttleMs)` from `lib/sms/notify.ts:82` with `throttleMs = 3_600_000` and `actionUrl = "/admin/settings/mtn"`.
- Run tests with `npx vitest run <file>`. Before pushing main, run `npx tsc --noEmit`, then `npm run build` with placeholder env.

## Review Focus

1. **A timeout on the first POST followed by a successful retry.** The retry must send the identical body and idempotency key, and a `200 {idempotent:true}` reply counts as success. Test in Task 4.
2. **A re-send of an order Kuntanii already has as `pending` or `processed`.** No new POST may be sent; return success with the existing attempt id. Test in Task 4.
3. **A forged webhook claiming `processed` while the real status is `pending`.** The tracking row must not change except through the re-fetch. Test in Task 6.
4. **Instant mode refused with `422 VALIDATION_ERROR`.** Exactly one POST, carrying `deliveryMode: "instant"`, and no second POST without it. Test in Task 4.
5. **Phone input given as `233…`, `+233…`, with spaces, or as a non-MTN prefix.** Normalise to `0XXXXXXXXX` or reject before any network call. Test in Tasks 2 and 4.

---

### Task 1: Migration, response fields, tracking write

**Files:**
- Create: `migrations/0150_kuntanii_provider.sql`. Renumber to the next free number on main if 0150 is taken.
- Create: `migrations/0150_kuntanii_provider.selftest.sql`. Follow the PGlite pattern in memory `reference-pglite-sql-tests`; see `.claude/worktrees/feat-storefront-subagent-join/migrations/0148_storefront_subagent_join.selftest.sql` for shape.
- Modify: `lib/mtn-providers/types.ts`. `MTNOrderResponse` gains two optional fields, and `MTNProviderName` gains `"kuntanii"`.
- Modify: `lib/mtn-fulfillment.ts:29`. Its local `MTNOrderResponse` gains the same two optional fields.
- Modify: `lib/mtn-fulfillment.ts:990` (`saveMTNTracking`). Write the two new columns when they are present on `response`.
- Test: `lib/mtn-fulfillment.test.ts`. Add one case to the existing file.

**Interfaces:**
- Produces: `MTNOrderResponse.provider_cost_ghs?: number` and `MTNOrderResponse.provider_reference?: string` on both response types.
- Produces: DB columns `mtn_fulfillment_tracking.provider_cost_ghs numeric(12,2)` and `provider_reference text`.
- Produces: tables `kuntanii_not_received_reports` and `kuntanii_unknown_attempts`, with columns exactly as listed in spec §5.
- Produces: partial unique index `kuntanii_nr_one_open_per_tracking ON kuntanii_not_received_reports(tracking_id) WHERE dispute_status IN ('open','escalated')`. Task 7 relies on this as its claim gate.

- [ ] **Step 1:** Write the selftest SQL. It asserts that both columns exist, both tables exist with RLS enabled, that `has_table_privilege('anon', 'public.kuntanii_not_received_reports', 'SELECT')` is false (and the same for `authenticated` and for the second table), that a second `open` report for the same `tracking_id` violates the unique index, and that `dispute_status = 'bogus'` violates the CHECK constraint.
- [ ] **Step 2:** Run the selftest via PGlite and confirm it FAILS because the tables don't exist yet.
- [ ] **Step 3:** Write the migration. Use `ADD COLUMN IF NOT EXISTS` and `CREATE TABLE IF NOT EXISTS`. Add `CHECK (dispute_status IN ('open','escalated','resolved','rejected'))`, create the partial unique index, enable RLS on both tables, and `REVOKE ALL ... FROM anon, authenticated`.
- [ ] **Step 4:** Run the selftest and confirm it PASSES.
- [ ] **Step 5:** Write the failing vitest `saveMTNTracking writes provider_cost_ghs and provider_reference when present`. It uses a fake supabase insert spy, a response `{ success:true, order_id:"o1", message:"ok", provider_cost_ghs: 3.85, provider_reference: "KT-1" }`, and expects the inserted row to contain `provider_cost_ghs: 3.85, provider_reference: "KT-1"`. Add a second case `omits both keys when absent`.
- [ ] **Step 6:** Implement the type changes and the conditional spread in `saveMTNTracking`. Run `npx vitest run lib/mtn-fulfillment.test.ts` and expect PASS. The 9 known order-health failures elsewhere are pre-existing and out of scope.
- [ ] **Step 7:** Commit with `feat(kuntanii): migration + provider cost/reference on tracking`.

The migration is **not applied** in this task. Applying it follows the prod protocol in Task 10.

---

### Task 2: Pure helpers — `kuntanii-core.ts`

**Files:**
- Create: `lib/mtn-providers/kuntanii-core.ts`
- Test: `lib/mtn-providers/kuntanii-core.test.ts`

**Interfaces (Produces):**
```ts
export type KuntaniiMode = "normal" | "instant"
export type KuntaniiPlan = { planCode: number; displayName: string; bundleSizeMb: number; unitPriceGhs: number }
export type KuntaniiOrderEntry = { orderReference?: string; status?: string; deliveryMode?: string; totalAmountGhs?: number; notReceivedStatus?: string | null }
export type OurStatus = "processing" | "completed" | "failed"
export type KuntaniiErrorClass = "NOT_ELIGIBLE" | "INSTANT_UNAVAILABLE" | "VALIDATION" | "ACCOUNT_HOLD" | "CONFLICT" | "RETRYABLE" | "NOT_FOUND" | "API_ERROR"
export const MAX_ATTEMPTS = 5
export function mapKuntaniiStatus(raw: string | undefined | null): OurStatus
export function aggregateOrdersStatus(orders: KuntaniiOrderEntry[]): OurStatus
export function classifyKuntaniiError(httpStatus: number, code: string | undefined, mode: KuntaniiMode): KuntaniiErrorClass
export function isSizeSupported(plans: KuntaniiPlan[], sizeGb: number): boolean
export function toLocalGhanaPhone(raw: string): string | null
export function attemptId(orderId: string, n: number): string
export function existingAttemptAction(orders: KuntaniiOrderEntry[]): "next" | "resume"
export function redactPhone(phone: string | null | undefined): string
export function sumCost(orders: KuntaniiOrderEntry[] | undefined, fallbackTotal?: number): number | undefined
```

- [ ] **Step 1:** Write the failing tests:
  - `mapKuntaniiStatus`: `"pending"`→processing, `"processing"`→processing, `"processed"`→completed, `"cancelled"`→failed, `"not received"`→completed, `"NOT RECEIVED"`→completed (case-insensitive and trimmed), `"weird"`→processing, `undefined`→processing.
  - `aggregateOrdersStatus`: `[]`→processing; `[processed]`→completed; `[processed, pending]`→processing; `[cancelled, processed]`→failed; `[cancelled]`→failed.
  - `classifyKuntaniiError` (expected values from the spec §2 table): (422,"NO_APPROVED_RECIPIENTS",normal)→NOT_ELIGIBLE; (422,"NO_ELIGIBLE_RECIPIENTS",normal)→NOT_ELIGIBLE; (422,"VALIDATION_ERROR",instant)→INSTANT_UNAVAILABLE; (422,"VALIDATION_ERROR",normal)→VALIDATION; (400,"VALIDATION_ERROR",normal)→VALIDATION; (402,"INSUFFICIENT_CREDIT")→ACCOUNT_HOLD; (402,"GOVERNING_ACCOUNT_CREDIT_HOLD")→ACCOUNT_HOLD; 403 with each of PAYMENT_VERIFICATION_REQUIRED, ACCOUNT_ORDERS_PAUSED, PARENT_ORDERS_PAUSED, ORDERS_PAUSED, PRICING_PROFILE_REQUIRED, FORBIDDEN→ACCOUNT_HOLD; (401,"UNAUTHORIZED")→ACCOUNT_HOLD; (409,"CONFLICT")→CONFLICT; (429,"RATE_LIMITED")→RETRYABLE; 503 with each of CREDIT_UNAVAILABLE, BENEFICIARY_CHECK_UNAVAILABLE, CREDIT_RELAY_UNAVAILABLE→RETRYABLE; (404,"NOT_FOUND")→NOT_FOUND; (500,undefined)→RETRYABLE; (418,undefined)→API_ERROR.
  - `isSizeSupported(plans1to100, 1)` is true, as are 12 and 100; 11 is false, 0.5 is false, and an empty plan list returns false.
  - `toLocalGhanaPhone`: `"0241234567"`, `"233241234567"`, `"+233 24 123 4567"` and `" 024-123-4567 "` all give `"0241234567"`; `"12345"` gives null, and `"0241234567890"` gives null.
  - `attemptId("abc",1)` is `"abc"`, and `attemptId("abc",2)` is `"abc-r2"`.
  - `existingAttemptAction`: all entries cancelled→"next"; `[pending]`, `[processed]` and `[not received]`→"resume"; `[]`→"resume". Empty is a safety default: never re-place blind.
  - `redactPhone("0241234567")` is `"*******567"`, and `redactPhone(undefined)` is `""`.
  - `sumCost([{totalAmountGhs:3.85},{totalAmountGhs:7.7}])` is `11.55`, rounded to 2 dp. `sumCost([], 96)` is `96`. `sumCost(undefined)` is `undefined`.
- [ ] **Step 2:** Run `npx vitest run lib/mtn-providers/kuntanii-core.test.ts` and expect FAIL (module not found).
- [ ] **Step 3:** Implement. No imports from supabase or fetch; the file must stay pure.
- [ ] **Step 4:** Run the tests and expect PASS.
- [ ] **Step 5:** Commit with `feat(kuntanii): pure status/error/size/phone helpers`.

---

### Task 3: HTTP client — `kuntanii-client.ts`

**Files:**
- Create: `lib/mtn-providers/kuntanii-client.ts`
- Test: `lib/mtn-providers/kuntanii-client.test.ts`

**Interfaces:**
- Consumes: the Task 2 types.
- Produces:
```ts
export type KuntaniiOk<T> = { ok: true; status: number; data: T }
export type KuntaniiErr = { ok: false; status: number; code?: string; message: string; body?: unknown; network?: boolean }
export type KuntaniiResult<T> = KuntaniiOk<T> | KuntaniiErr
export type PricingBody = { deliveryMode: KuntaniiMode; pricingProfileName?: string; plans: KuntaniiPlan[] }
export type VerifyResult = { phoneNumber: string; normalizedPhone?: string; eligible: boolean; reason: string; message?: string }
export type OrderBody = { externalOrderId: string; deliveryMode?: string; outcome?: string; acceptedCount?: number; totalAmountGhs?: number; orderReference?: string; status?: string; idempotent?: boolean; orders?: KuntaniiOrderEntry[]; rejectedRecipients?: Array<{ phoneNumber: string; dataGb: number; reason: string }> }
export type ReportBody = { reportReference: string; orderReference?: string; disputeStatus?: string; status?: string }
export interface KuntaniiClient {
  getPricing(mode: KuntaniiMode): Promise<KuntaniiResult<PricingBody>>
  verifyBeneficiaries(phones: string[]): Promise<KuntaniiResult<{ results: VerifyResult[] }>>
  getOrder(externalOrderId: string): Promise<KuntaniiResult<OrderBody>>
  placeOrder(input: { externalOrderId: string; phoneNumber: string; dataGb: number; mode: KuntaniiMode }): Promise<KuntaniiResult<OrderBody>>
  reportNotReceived(externalOrderId: string, body: { phoneNumber: string; dataGb?: number; reasonCode?: string; description?: string }): Promise<KuntaniiResult<ReportBody>>
  getNotReceivedStatus(externalOrderId: string, reportReference: string): Promise<KuntaniiResult<{ status: string }>>
}
export function createKuntaniiClient(opts?: { fetchImpl?: typeof fetch; apiKey?: string; baseUrl?: string; sleep?: (ms: number) => Promise<void>; timeoutMs?: number }): KuntaniiClient
export function getCachedPlans(client: KuntaniiClient, mode: KuntaniiMode, now?: number): Promise<KuntaniiPlan[] | null>
export function __resetPlanCache(): void   // tests only
```

- [ ] **Step 1:** Write the failing tests. Use a fake `fetchImpl` that records calls; the key comes from opts and is never read from env in tests.
  - `getPricing("normal")` calls `GET https://kuntanii.com/api/integrations/pricing` with no query string. `getPricing("instant")` adds `?deliveryMode=instant`. Both send header `Authorization: Bearer test_key`.
  - `placeOrder` in normal mode sends the body `{"externalOrderId":"o1","items":[{"phoneNumber":"0241234567","dataGb":3}]}` with **no** `deliveryMode` key, plus header `X-Kuntanii-Idempotency-Key: o1`. In instant mode the body includes `"deliveryMode":"instant"`.
  - `placeOrder` retries once on a 503 response with the identical body and key. It makes 2 calls total, and `sleep` is called once with 2000.
  - `placeOrder` retries once on a thrown network error, and a second failure returns `{ok:false, network:true}`.
  - `placeOrder` does **not** retry on 422 (1 call).
  - A `200 {"idempotent":true,...}` reply returns `ok:true`.
  - A non-JSON body returns `{ok:false, code:undefined}` with a message containing the HTTP status.
  - `getOrder("o1")` calls `/api/integrations/orders/o1`, and the id is URL-encoded.
  - `reportNotReceived` makes a POST to `/orders/o1/not-received`, and `getNotReceivedStatus` uses the query string `reportReference=NR-1`.
  - `verifyBeneficiaries` sends `{"phoneNumbers":[...]}`.
  - `getCachedPlans` makes one fetch for two calls within 5 minutes, refetches after `now + 300_001`, and returns `null` when the fetch fails (no throw).
- [ ] **Step 2:** Run the tests and expect FAIL.
- [ ] **Step 3:** Implement. The default `fetchImpl` is the global `fetch` with `AbortSignal.timeout(timeoutMs ?? 30_000)`. Default `apiKey` is `process.env.KUNTANII_API_KEY ?? ""` and default `baseUrl` is `process.env.KUNTANII_BASE_URL ?? "https://kuntanii.com"`. The retry rule applies only to `placeOrder` and uses `classifyKuntaniiError(...) === "RETRYABLE"` or a network error. The plan cache is a module-level `Map<KuntaniiMode, {at, plans}>`.
- [ ] **Step 4:** Run the tests and expect PASS.
- [ ] **Step 5:** Commit with `feat(kuntanii): HTTP client with idempotent single retry + plan cache`.

---

### Task 4: Provider class + factory wiring

**Files:**
- Create: `lib/mtn-providers/kuntanii-provider.ts`
- Test: `lib/mtn-providers/kuntanii-provider.test.ts`
- Modify: `lib/mtn-providers/factory.ts`. Add `"kuntanii"` to the provider check at L40, to `VALID_PROVIDERS` at L61, and as a case in the `getMTNProvider()` switch near L116 and the `getProviderByName()` switch near L246. **Do not** add it to `NON_MTN_CAPABLE`.
- Modify: `lib/mtn-providers/provider-display.ts`. Add a display entry for `kuntanii` with the label "Kuntanii", matching the shape of the `bundleportal` entry.
- Test: `lib/mtn-providers/factory.test.ts`. Add the cases `getProviderByName("kuntanii").name === "kuntanii"` and `NON_MTN_CAPABLE` lists never contain `"kuntanii"`.

**Interfaces:**
- Consumes: Task 2 helpers and the Task 3 `KuntaniiClient` / `getCachedPlans`.
- Produces:
```ts
export const DELIVERY_MODE_KEY = "kuntanii_delivery_mode"           // admin_settings key, value { mode: "normal" | "instant" }
export async function getDeliveryMode(): Promise<KuntaniiMode>     // default "normal"; any read error -> "normal"
export type KuntaniiDeps = {
  client?: KuntaniiClient
  getMode?: () => Promise<KuntaniiMode>
  alert?: (type: string, title: string, message: string) => Promise<void>
  recordUnknownAttempt?: (externalOrderId: string) => Promise<void>
}
export class KuntaniiProvider implements MTNProvider {
  name: "kuntanii"
  constructor(deps?: KuntaniiDeps)
  createOrder(req: MTNOrderRequest): Promise<MTNOrderResponse>   // response includes provider_cost_ghs / provider_reference on success
  checkOrderStatus(id: string | number): Promise<MTNOrderStatusResponse> // order = raw body incl. orders[].notReceivedStatus
  checkBalance(): Promise<number | null>                           // always null
}
```
The default `alert` is `notifyAdminsThrottled(type, title, message, "/admin/settings/mtn", 3_600_000)`. The default `recordUnknownAttempt` inserts `{ external_order_id, order_id }` into `kuntanii_unknown_attempts` using `onConflict: external_order_id` and ignores errors.

`createOrder` order of operations (spec §2). This is the algorithm; it is not determined by the signature:
1. If `network !== "MTN"`, return VALIDATION. Otherwise `phone = toLocalGhanaPhone(req.recipient_phone)`; if it is null or fails `validatePhoneNetworkMatch(phone, "MTN")`, return VALIDATION. No network call happens on this path.
2. `base = req.client_ref ?? crypto.randomUUID()`. Walk `n = 1..MAX_ATTEMPTS`, calling `getOrder(attemptId(base, n))`:
   - 404 means the id is free: use it and stop walking.
   - ok with `existingAttemptAction(orders) === "resume"`: **return success** with `order_id` set to that id and a message saying the existing attempt was resumed. Do not POST.
   - ok with "next": continue.
   - any other error: return `error_type: "RETRYABLE"`.
   - If the walk runs out, return `API_ERROR` with the message "attempt cap reached".
3. `mode = await getMode()`. `plans = await getCachedPlans(client, mode)`. If `plans` is non-null and `!isSizeSupported(plans, req.size_gb)`, return `UNSUPPORTED_SIZE`. If `plans` is null, continue (fail open).
4. `verifyBeneficiaries([phone])`. If ok and `results[0].eligible === false`, return `NOT_ELIGIBLE` with Kuntanii's `reason`. If not ok, continue (fail open).
5. `placeOrder({ externalOrderId: id, phoneNumber: phone, dataGb: req.size_gb, mode })`:
   - ok: if the reply is an idempotent replay and `aggregateOrdersStatus(orders ?? [{status}]) === "failed"`, return a failure. If `acceptedCount === 0`, return `NOT_ELIGIBLE`. Otherwise return success with `{ order_id: id, provider_cost_ghs: idempotent ? undefined : sumCost(orders, totalAmountGhs), provider_reference: orderReference }`.
   - error: map with `classifyKuntaniiError(status, code, mode)`. For `ACCOUNT_HOLD` and `INSTANT_UNAVAILABLE`, call `alert("kuntanii_" + (code ?? "hold").toLowerCase(), "Kuntanii: orders refused", "<code>: <message>")`. For a network error or `RETRYABLE`, call `recordUnknownAttempt(id)`. Return `{ success:false, error_type: <class>, message }`.

`checkOrderStatus(id)`: a `FAILED_INIT_` prefix returns failed. On 404, return `{success:false}`. On ok, return `{ success:true, status: aggregateOrdersStatus(orders ?? [{ status }]), message, order: body }`. Unknown raw statuses are logged with `console.warn` (ids only).

- [ ] **Step 1:** Write the failing tests. Use a fake client built from `vi.fn()`s, a fake `getMode`, an `alert` spy and a `recordUnknownAttempt` spy:
  - `rejects non-MTN without any client call`. Telecel request → `success:false`, `error_type:"VALIDATION"`, and every client spy has 0 calls.
  - `normalises +233 phone and sends local format`. `"+233241234567"` → `placeOrder` is called with `phoneNumber:"0241234567"`.
  - `walk: 404 on first id places with base id`. `getOrder("ord1")` returns 404 → `placeOrder` gets `externalOrderId:"ord1"`.
  - `walk: cancelled first attempt places ord1-r2`. `getOrder("ord1")` returns `orders:[{status:"cancelled"}]` and `getOrder("ord1-r2")` returns 404 → placed with `"ord1-r2"`.
  - `walk: pending existing attempt resumes without POST`. → `success:true`, `order_id:"ord1"`, `placeOrder` has 0 calls.
  - `walk: processed existing attempt resumes without POST (no re-delivery)`. Same assertions.
  - `walk: lookup 500 fails RETRYABLE and never POSTs`.
  - `unsupported size skips before verify`. Plans are 1/2/3 GB and `size_gb` is 11 → `error_type:"UNSUPPORTED_SIZE"`, and verify and place each have 0 calls.
  - `pricing failure fails open`. `getPricing` gives `ok:false` → `placeOrder` is called.
  - `ineligible beneficiary skips`. `results:[{eligible:false, reason:"not_on_beneficiary_list"}]` → `NOT_ELIGIBLE`, and place has 0 calls.
  - `verify failure fails open`. → `placeOrder` is called.
  - `instant refused is never resent as normal`. Mode is instant and `placeOrder` returns `{ok:false,status:422,code:"VALIDATION_ERROR"}` → `placeOrder` has exactly 1 call with `mode:"instant"`, `error_type:"INSTANT_UNAVAILABLE"`, and `alert` is called once.
  - `account hold alerts with code-based type`. 403 `ORDERS_PAUSED` → `alert` is called with type `"kuntanii_orders_paused"`, and the result is `ACCOUNT_HOLD`.
  - `success records cost and reference`. A 201 with `orders:[{orderReference:"KT-1", totalAmountGhs:11.55}]` → `provider_cost_ghs:11.55` and `provider_reference:"KT-1"`.
  - `idempotent replay does not overwrite cost`. `{idempotent:true, status:"pending"}` → success and `provider_cost_ghs` is undefined.
  - `idempotent replay of cancelled is a failure`.
  - `network failure records unknown attempt`. `placeOrder` returns `{ok:false, network:true}` → `recordUnknownAttempt("ord1")`.
  - `checkOrderStatus maps processed → completed and passes body through`. `checkOrderStatus("FAILED_INIT_x")` → failed with no client call. A 404 → `success:false`.
  - `checkBalance returns null`.
- [ ] **Step 2:** Run `npx vitest run lib/mtn-providers/kuntanii-provider.test.ts lib/mtn-providers/factory.test.ts` and expect FAIL.
- [ ] **Step 3:** Implement the provider, the factory cases and the display entry. `getDeliveryMode` reads `admin_settings` through `supabaseAdmin`, the same way `getActiveMtnRoute` does in `bundleportal-provider.ts`. Spec §12: log every place and status response body as `[KUNTANII-RAW]` JSON, with every `phoneNumber` and `normalizedPhone` value passed through `redactPhone`. This verifies the undocumented fields; remove it after go-live Task 10 Step 9.
- [ ] **Step 4:** Run the tests and expect PASS. Then run `npx tsc --noEmit` and expect no new errors.
- [ ] **Step 5:** Commit with `feat(kuntanii): provider with attempt-chain walk, pre-checks, factory wiring`.

---

### Task 5: Whitelist registry

**Files:**
- Modify: `lib/mtn-providers/provider-whitelist.ts`. Add `checkKuntanii` and `checkKuntaniiBatch` next to the bundleportal ones, and register an entry after `bundleportal` at L255–260.
- Test: `lib/mtn-providers/provider-whitelist.test.ts`.

**Interfaces:**
- Consumes: `createKuntaniiClient().verifyBeneficiaries` from Task 3 and `toLocalGhanaPhone` from Task 2.
- Produces: the registry entry `{ name: "kuntanii", configured: () => !!process.env.KUNTANII_API_KEY, check: checkKuntanii, checkBatch: checkKuntaniiBatch }`.

- [ ] **Step 1:** Write the failing tests. Mock `./kuntanii-client`.
  - `kuntanii check maps eligible → allowed`. `eligible:false, reason:"blocked_number"` gives `{allowed:false, provider:"kuntanii", reason:"blocked_number"}`.
  - `kuntanii check fails open on client error`. The result is `allowed:true`.
  - `kuntanii batch chunks at 100`. 250 numbers lead to 3 `verifyBeneficiaries` calls, and the results are matched by array position.
  - `kuntanii batch fails open per chunk`.
  - `registry includes kuntanii configured by KUNTANII_API_KEY`.
  - `validateProviderSelection(["kuntanii"])` is valid. This makes the customer-verification admin selection accept it.
- [ ] **Step 2:** Run the tests and expect FAIL.
- [ ] **Step 3:** Implement. Numbers that `toLocalGhanaPhone` returns null for get `allowed:false` with reason `"invalid_phone_number"` and are not sent.
- [ ] **Step 4:** Run the tests and expect PASS.
- [ ] **Step 5:** Commit with `feat(kuntanii): beneficiary verify in whitelist registry`.

---

### Task 6: Webhook (signal + re-fetch)

**Files:**
- Create: `app/api/webhooks/mtn/kuntanii/route.ts`
- Create: `lib/mtn-providers/kuntanii-webhook-processor.ts`
- Test: `lib/mtn-providers/kuntanii-webhook-processor.test.ts`

**Interfaces:**
- Consumes: `syncMTNOrderStatus(trackingId)` from `lib/mtn-fulfillment.ts:855`, and `refreshOpenDisputes(trackingId)` from Task 7. Pass it as an injected dep so this task doesn't block on Task 7.
- Produces:
```ts
export const REFETCH_THROTTLE_MS = 15_000
export function extractExternalOrderId(body: unknown): string | null   // data.externalOrderId; string, ≤ 64 chars, /^[0-9a-f-]{36}(-r[2-5])?$/i else null
export function signatureHeaderSnapshot(headers: Headers): Record<string, string>  // header names + values only for /signature|sig|timestamp/i
export async function processKuntaniiWebhook(input: { externalOrderId: string; event: string | null }, deps?: {
  findTracking?: (externalOrderId: string) => Promise<{ id: string; webhook_received_at: string | null } | null>
  markReceived?: (trackingId: string) => Promise<void>
  sync?: (trackingId: string) => Promise<unknown>
  refreshOpenDisputes?: (trackingId: string) => Promise<void>
  now?: () => number
}): Promise<"ignored" | "throttled" | "synced">
```
The route reads the raw body with a 64 KB cap. It parses JSON, runs `extractExternalOrderId`, and logs `signatureHeaderSnapshot` together with `X-Kuntanii-Event` and `X-Kuntanii-Delivery` (no body, no phone numbers). It returns `200 {received:true}` immediately and runs `processKuntaniiWebhook` inside `after()` from `next/server`, following `app/api/webhooks/mtn/agentportalgh/route.ts`. Invalid JSON or a missing id still returns 200, with a warning log only.

`findTracking` queries `mtn_fulfillment_tracking` with `provider = 'kuntanii'` and `mtn_order_id = externalOrderId`, takes the newest row, and returns `id, webhook_received_at`. Throttling skips the sync when `now - webhook_received_at < REFETCH_THROTTLE_MS`. Otherwise it calls `markReceived` and then `sync`. When `event` starts with `order.not_received_`, it also calls `refreshOpenDisputes`.

- [ ] **Step 1:** Write the failing tests:
  - `forged body status is never applied`. The processor's input type has no status field at all. Assert that `sync` is called with the tracking id and that there is no other write path; `markReceived` only touches `webhook_received_at`.
  - `unknown externalOrderId → "ignored"`, and `sync` has 0 calls.
  - `within 15s of last receipt → "throttled"`, and `sync` has 0 calls.
  - `not_received event refreshes disputes`.
  - `extractExternalOrderId` rejects a non-string, a 200-character string and `"DB-ORDER-12345"`, and accepts a UUID and `"<uuid>-r2"`.
  - `signatureHeaderSnapshot` keeps `x-kuntanii-signature` and `x-kuntanii-timestamp` and drops `content-type` and `authorization`.
- [ ] **Step 2:** Run the tests and expect FAIL.
- [ ] **Step 3:** Implement the processor and the route.
- [ ] **Step 4:** Run the tests and expect PASS, and `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit with `feat(kuntanii): webhook as signal, authenticated re-fetch`.

---

### Task 7: Disputes lib + admin API

**Files:**
- Create: `lib/mtn-providers/kuntanii-disputes.ts`
- Create: `app/api/admin/kuntanii/route.ts`
- Test: `lib/mtn-providers/kuntanii-disputes.test.ts`

**Interfaces:**
- Consumes: Task 3 client, `DELIVERY_MODE_KEY` / `getDeliveryMode` from Task 4, `verifyAdminAccess` from `@/lib/admin-auth` (the same pattern as `app/api/admin/apexprime/route.ts`).
- Produces:
```ts
export type DisputeStatus = "open" | "escalated" | "resolved" | "rejected"
export function normaliseDisputeStatus(raw: string | undefined): DisputeStatus | null
export async function fileNotReceived(input: { trackingId: string; adminUserId: string; description?: string; reasonCode?: string }, deps?: { db?: SupabaseLike; client?: KuntaniiClient }): Promise<{ ok: true; reportReference: string } | { ok: false; status: 400 | 404 | 409 | 502; error: string }>
export async function refreshDispute(reportId: string, deps?: { db?: SupabaseLike; client?: KuntaniiClient }): Promise<DisputeStatus | null>
export async function refreshOpenDisputes(trackingId: string, deps?: { db?: SupabaseLike; client?: KuntaniiClient }): Promise<void>
export async function refreshStaleDisputes(limit: number, olderThanMs: number, deps?: { db?: SupabaseLike; client?: KuntaniiClient }): Promise<number>
```
`SupabaseLike` is the minimal structural type the tests' fake implements. Define it locally.

`fileNotReceived` follows these rules:
- Load the tracking row server-side and require `provider === "kuntanii"` and `status === "completed"`; otherwise return 400. A missing row returns 404.
- Validate `description` at 500 characters or fewer and `reasonCode` at 50 or fewer; otherwise return 400.
- Take `phoneNumber` (via `toLocalGhanaPhone`), `dataGb` (from `size_gb`) and `externalOrderId` (from `mtn_order_id`) from the row, never from the request.
- **Claim first:** insert a placeholder report row with `dispute_status = 'open'`. A unique-violation (Postgres `23505`) returns 409 "already open".
- Call the API. On failure, delete the placeholder and return 502. On success, update the row with `report_reference`, `order_reference` and `dispute_status` (normalised).

Route actions follow spec §6:
- `GET ?action=settings` → `{ mode }`.
- `GET ?action=pricing` → `{ normal, instant }`, both fetched live, each `null` on failure.
- `GET ?action=disputes&trackingId=` → rows without `phone_number`.
- `POST {action:"set-delivery-mode", mode}` → mode must be in the enum, then upsert `admin_settings`.
- `POST {action:"report-not-received", trackingId, description?, reasonCode?}` → `fileNotReceived`, with `adminUserId` taken from the verified session.
- `POST {action:"refresh-dispute", reportId}`.

- [ ] **Step 1:** Write the failing tests with a fake db and a fake client:
  - `normaliseDisputeStatus` maps `"Escalated"` to `"escalated"` and `"weird"` to null.
  - `fileNotReceived refuses non-kuntanii (400)`, `refuses non-completed (400)` and `404 on missing row`.
  - `derives phone/size/id from the row, not input`. Assert the arguments passed to `client.reportNotReceived`.
  - `second filing while open → 409` (the fake insert throws `{code:"23505"}`), and the client is never called.
  - `API failure removes the claim row → 502`.
  - `description over 500 chars → 400`.
  - `refreshDispute` updates `dispute_status` and `last_checked_at`.
  - `refreshStaleDisputes` respects `limit`.
- [ ] **Step 2:** Run the tests and expect FAIL.
- [ ] **Step 3:** Implement the lib and the route.
- [ ] **Step 4:** Run the tests and expect PASS, then wire `refreshOpenDisputes` as the Task 6 route's default dep.
- [ ] **Step 5:** Commit with `feat(kuntanii): not-received disputes + admin API`.

---

### Task 8: Status-sync cron + unknown-attempt checks + scheduling

**Files:**
- Create: `app/api/cron/sync-mtn-status/kuntanii/route.ts`. Copy the structure of `app/api/cron/sync-mtn-status/apexprime/route.ts` and change the provider to `"kuntanii"` and the log prefix to `[CRON-KUNTANII]`. Keep the reversal block.
- Create: `lib/mtn-providers/kuntanii-unknown-attempts.ts`
- Test: `lib/mtn-providers/kuntanii-unknown-attempts.test.ts`
- Modify: `lib/cron-migration/crons.json`. Add `{ "path": "/api/cron/sync-mtn-status/kuntanii", "schedule": "* * * * *" }` after the apexprime entry.
- Test: `lib/cron-migration/jobs.test.ts`. Add `/api/cron/sync-mtn-status/kuntanii` to the batch-C list at L32–41.

**Interfaces:**
- Consumes: `refreshStaleDisputes` from Task 7, the Task 3 client, and the Task 4 `alert` default.
- Produces: `export async function checkUnknownAttempts(deps?): Promise<{ checked: number; alerted: number }>`. It selects unresolved rows from the last 24 hours (up to 20). For each it calls `getOrder`:
  - 404: leave it, and set `resolved_at` once the row is more than 24 hours old.
  - ok: set `last_status` and `resolved_at`. If the aggregate is not `failed`, call `alert("kuntanii_possible_double_delivery", "Kuntanii: possible double delivery", "order <order_id> attempt <external_order_id> is <status> at Kuntanii")`. The message has no phone number.

The cron runs status sync, then `checkUnknownAttempts()`, then `refreshStaleDisputes(20, 30*60_000)`.

- [ ] **Step 1:** Write the failing tests: `404 younger than 24h stays unresolved`, `found pending → alert + resolved`, `found cancelled → resolved, no alert`, `respects limit 20`. Also add the `jobs.test.ts` line.
- [ ] **Step 2:** Run `npx vitest run lib/mtn-providers/kuntanii-unknown-attempts.test.ts lib/cron-migration/jobs.test.ts` and expect FAIL.
- [ ] **Step 3:** Implement the lib, the cron route and the crons.json entry.
- [ ] **Step 4:** Run the tests and expect PASS.
- [ ] **Step 5:** Commit with `feat(kuntanii): status sync cron + unknown-attempt watcher`.

---

### Task 9: Admin UI

**Files:**
- Modify: `app/admin/settings/mtn/page.tsx`:
  - Add `"kuntanii"` to the `useState` union at L66 and to the local `MTNProviderName` at L152. Do **not** add it to `NonMTNProvider` at L160.
  - Add `kuntanii: "Kuntanii"` to the labels at L1245.
  - Add `{ value: "kuntanii", label: "Kuntanii", sub: "MTN only · staff-fulfilled · credit account" }` to the MTN provider option list near L1539.
  - Add a new `TabsContent value="kuntanii"` next to the bundleportal one at L2498, with an `ActivationCard` and a new `KuntaniiCard`.
- Create: `components/admin/kuntanii-card.tsx`. It has the Normal/Instant toggle (POST `set-delivery-mode`), the line "Instant must be enabled by Kuntanii; refused instant orders fail over to the next provider", a pricing table (GB | Normal GHS | Instant GHS, merged by `bundleSizeMb`), "Balance: n/a — credit account", and the webhook URL to register: `${origin}/api/webhooks/mtn/kuntanii`.
- Create: `components/admin/kuntanii-dispute-control.tsx`. Props are `{ trackingId: string; status: string }`. It renders only when `status === "completed"`. It shows a "Report not received" button that opens a confirm dialog with an optional note of up to 500 characters, then shows a dispute badge (open/escalated/resolved/rejected) with a refresh icon. On 409 it shows "A report is already open".
- Modify: `app/admin/mtn-logs/page.tsx`. In the row actions near L615–640, render `<KuntaniiDisputeControl trackingId={log.id} status={log.status} />` when `log.provider === "kuntanii"`.
- Modify: `app/admin/order-payment-status/page.tsx`. Add `{ value: "kuntanii", label: "Kuntanii" }` to the MTN branch list only (near L70), not the non-MTN list.
- Modify: `app/admin/phone-verification/page.tsx:28`. Add `kuntanii: "Kuntanii"`.

**Interfaces:** Consumes the Task 7 route actions only.

- [ ] **Step 1:** Implement the components and page edits. Use the existing shadcn primitives found in sibling cards, and widen the card at `lg:` like its siblings. Use the navy `--primary` accent. No new sidebar item is needed.
- [ ] **Step 2:** Run `npx tsc --noEmit` and expect a clean result.
- [ ] **Step 3:** Run `npm run dev`. Take headless screenshots at 500 px and at desktop width (see the `reference-headless-screenshots` memory) of `/admin/settings/mtn` on the Kuntanii tab and of `/admin/mtn-logs`. Check that the pricing table renders the 18 live plans.
- [ ] **Step 4:** Commit with `feat(kuntanii): admin card, provider lists, dispute control`.

---

### Task 10: Verification, review, docs, go-live

**Files:**
- Create: `C:\Users\User2\.claude\projects\c--Users-User2--gemini-antigravity-ide-scratch-Datagod2\memory\project-kuntanii-provider.md`, plus a pointer line in `MEMORY.md`.

- [ ] **Step 1:** Run `npx vitest run` and expect every new test to pass. The only failures allowed are the 9 known order-health failures.
- [ ] **Step 2:** Run `npx tsc --noEmit` and expect it clean. Then run `npm run build` with placeholder env and expect it to succeed. This catches Next route-export violations.
- [ ] **Step 3:** Get a fresh-reviewer gate, which is mandatory because this touches money and schema. Dispatch `ecc:security-reviewer` and `ecc:typescript-reviewer` on the branch diff. Verify each finding and re-grade it, and fix confirmed ones with a failing test first.
- [ ] **Step 4:** Run `git diff main --stat`, then grep the full diff for `kt_live_`, `kt_whsec_`, `sbp_`, `eyJ`. Expect no matches.
- [ ] **Step 5:** Apply the migration under the prod change protocol. Run precheck counts, then a self-rolling-back `RAISE` dry run. **Get the user's OK**, then apply and verify that the columns and tables exist and that anon has no SELECT.
- [ ] **Step 6:** Ask the user to confirm that `KUNTANII_API_KEY` and `KUNTANII_WEBHOOK_SECRET` are set in Vercel Production. Then check local main for other sessions' commits, merge, push, watch the deploy, and do a live check that `GET /api/webhooks/mtn/kuntanii` responds.
- [ ] **Step 7:** Register the cron on cron-job.org with the existing sync script, and confirm the job exists.
- [ ] **Step 8:** Have the user register the webhook URL in Kuntanii and tick Kuntanii in the admin customer-verification provider selection.
- [ ] **Step 9:** Watch the first real Kuntanii orders' logs, which redact phone numbers. Record the real status body, event names and signature headers in the docs txt "LIVE PROBE RESULTS" section.
- [ ] **Step 10:** Write the memory file covering what was shipped, the commit, the migration number, open items (signature verification, key rotation), the auto-switch-allowed decision and the attempt-id scheme. Then remind the user to rotate the key.
