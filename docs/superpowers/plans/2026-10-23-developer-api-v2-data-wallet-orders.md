# Developer API v2 — Plan 3: Data Bundles, Wallet and Orders

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a standard-key developer list packages, buy data (single and bulk of up to 100), verify MTN numbers and look up orders by reference, with idempotent references, role pricing, sandbox isolation and full documentation, and attribute those orders to the key so the admin revenue/spent/orders tiles fill in.

**Architecture:** v2 orders are written to the EXISTING `api_orders` table so the whole fulfillment, status-sync, refund, order-health and delivery-notification machinery keeps seeing them. A new additive migration makes `api_orders.api_key_id` nullable, adds `api_v2_key_id` and a one-of-two CHECK, and adds an atomic, replay-aware RPC `place_api_v2_order` (service role only). Decision logic lives in pure, tested modules under `lib/api-v2/`; routes are thin wrappers over plan 1's `withV2`. Fulfillment dispatch reuses the same underlying providers as v1 without editing any v1 file. Stats attribution extends the plan 2 SQL functions.

**Tech Stack:** Next.js 15 route handlers (`after()` from `next/server`), Supabase (service role), Postgres plpgsql, Vitest (fake-client pattern), the docs registry from plan 2.

**Spec:** `docs/superpowers/specs/2026-10-22-developer-api-v2-design.md`. Prior plans: plan 1 foundation (live, dark), plan 2 console and docs kit (live, dark).

**Risk tier (feedback-review-gates):** Tier 1 — money, schema, order creation. Mandatory fresh most-capable-model reviewer on the whole branch, a database-reviewer pass on the migrations, the abuse-case pass below, failing tests first, and the prod change protocol for every migration.

## Datagod invariants this plan touches (feedback-business-logic-guardrails)

- Prices are re-verified from the DB at order time; never trust a price from the client (the request carries no price).
- Network prefix is validated against the network at order time (admin-toggleable map via `getPrefixValidationConfig`).
- `completed` is terminal and held MTN orders use status `held_registration`; no auto-resend of reversed orders; v2 never edits order status after creation except through the existing fulfillment code.
- An unregistered MTN number is never silently charged and dispatched: it is handled by the same whitelist/hold logic as v1 (see Task 6 decision).
- A disabled provider must not fall back to another network's provider: dispatch reuses `createMTNOrder` / `createNonMTNOrder` unchanged.
- Revenue/profit definitions follow `reference-profit-revenue-calculation`; the tiles here are API-wallet revenue only.
- Bulk work chunks `.in()` filters above a few hundred ids and respects the 8 s PostgREST timeout.

## Global Constraints

- v1 untouched: no edits to `app/api/v1/**`, `lib/api-auth.ts`, `place_api_order`, or v1 routes. v2 only ADDS (nullable column, new column, new function).
- Money path: every purchase is one atomic DB transaction (wallet lock, balance check, deduction, order insert, transaction row). The API never deducts, then inserts, in separate calls. A failed insert leaves the wallet untouched.
- Idempotency: `reference` is unique per key owner (`UNIQUE (user_id, api_reference)` already exists). Same request again returns the original order with **no second charge** (HTTP 200 with `replayed: true`); the same reference with a different network, size or recipient returns **409** and charges nothing. Concurrent identical requests must produce exactly one charge.
- The request carries no price; the server resolves the package and the role price. Role pricing rule is exactly v1's: `dealer` uses `dealer_price` when `> 0`, everyone else uses `price`.
- Networks (input is case-insensitive, output canonical): `MTN`, `Telecel`, `AT-iShare`, `AT-BigTime`, mapped to the `packages.network` values `MTN`, `Telecel`, `AT - iShare`, `AT - BigTime`. Only `is_available = true` packages can be bought. Package sizes are the package table's values; `volume_gb` must equal an available package size exactly.
- Recipient: a Ghana mobile number; accepted forms `0XXXXXXXXX`, `233XXXXXXXXX`, `+233XXXXXXXXX`; normalised once and used everywhere (prefix check, verification, storage, provider dispatch).
- Status mapping DB -> API: `pending`->`pending`, `processing`->`processing`, `completed`->`completed`, `failed`->`failed`, `refunded`->`refunded`, `held_registration`->`queued`. Any other DB value is shown as `processing` (never leak raw values).
- Responses use plan 1's envelope; order objects are an allow-list (`reference, network, volume_gb, recipient, price, status, created_at`), never `id`, provider references or error text.
- Purchase and bulk endpoints FAIL CLOSED (503) when the rate limiter is degraded (Redis unavailable). Rate-limit groups: `purchase` for `/data/purchase`, `bulk` for `/data/bulk`, `status` for packages/verify/order lookup (verify-number uses `status`).
- Sandbox (`test` keys): identical validation and pricing, then `placeSandboxOrder` (action `data_order`); never touches `wallets`, `api_orders` or any provider; replay and 409 semantics identical.
- Logs: no recipient numbers, no request bodies (plan 1 rule).
- Edit with Edit/Write tools, never `sed`. Real `next build` before pushing main. Every migration: precheck, self-rolling-back dry run, user OK, apply, verify (prod change protocol). Unique test phone numbers in tests.

## Review Focus

- Concurrent identical purchases (same reference) charge once; two different references racing a balance that covers only one: exactly one succeeds, the other gets 402 and the balance never goes negative (Task 1 SQL + Task 6 tests with the fake).
- Reference reuse: same content = replay (200, no charge); different recipient/size/network = 409; a reference belonging to ANOTHER user never collides (unique per user) and never leaks that user's order; replay must not re-dispatch fulfillment.
- Price tampering: body fields `price`, `amount`, `package_id`, `status`, `user_id` are ignored/rejected, never used.
- Recipient edge cases: spaces, `+233`, `233` prefix, 9 or 11 digits, letters, unicode digits, empty string, array instead of string, a number type (`244123456`), leading/trailing newline.
- Size edge cases: `volume_gb` as string `"1"`, `1.0`, `0`, negative, `NaN`, `Infinity`, `1e3`, a size that exists only for an unavailable package (Telecel 5GB is unavailable in prod, AT-BigTime is entirely unavailable), huge numbers.
- Bulk: 0 items, 101 items, duplicate references inside one batch, a batch whose total exceeds the balance (reject all, no charge), mixed networks, one bad item rejects the whole batch before any charge, partial MTN-unregistered recipients skipped and reported, a batch re-sent after a timeout replays instead of double charging.
- Status of held MTN orders reads `queued`; refunded reads `refunded`; unknown values read `processing`.
- Fulfillment dispatch runs after the response via `after()`, is skipped on replay, and a provider failure never changes the HTTP result or loses the order (it stays `pending` for the existing recovery crons / fulfillment queue).
- Order lookup is owner-scoped: another user's reference returns 404 (not 403) and the same body as a missing reference.
- Rate limiter degraded: purchase/bulk 503; read endpoints keep working.

---

### Task 1: Migration `0130` — v2 order attribution and `place_api_v2_order`

**Files:**
- Create: `migrations/0130_api_v2_orders.sql` (next free number at execution time)

**Interfaces:**
- Produces (SQL): `api_orders.api_key_id` nullable; `api_orders.api_v2_key_id uuid references api_v2_keys(id) on delete restrict`; `CHECK ((api_key_id IS NOT NULL) <> (api_v2_key_id IS NOT NULL))` as `api_orders_exactly_one_key` (added `NOT VALID` then `VALIDATE`d in the same migration); partial index on `(api_v2_key_id) WHERE api_v2_key_id IS NOT NULL`; function `place_api_v2_order(p_user_id uuid, p_api_v2_key_id uuid, p_package_id uuid, p_network text, p_volume_gb numeric, p_price numeric, p_recipient_phone text, p_api_reference text, p_description text) returns jsonb` (`SECURITY DEFINER`, `SET search_path = public`, `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE ... TO service_role`).
- Result JSON: success `{ success: true, replayed: false, order_id, new_balance, created_at }`; replay `{ success: true, replayed: true, order_id, status, created_at }` (no money moved); failures `{ success: false, error: 'Insufficient balance', required, balance }` | `{ success: false, error: 'Reference reused with a different order', code: 'REFERENCE_REUSED' }` | `{ success: false, error: 'Wallet not found' }` | `{ success: false, error: 'Order could not be placed' }` (never `SQLERRM`).

- [ ] **Step 1: Precheck (read-only on prod, via the Supabase Management API fallback):** list every constraint, trigger, view and function that references `api_orders.api_key_id` or selects it from `user_api_keys` (`pg_depend`, `pg_get_viewdef`, `grep` the repo for `api_key_id` consumers under `app/` and `lib/`, including admin pages and stats RPCs). Record any consumer that would break when `api_key_id` is NULL (inner joins to `user_api_keys`); report them before changing anything. Confirm `place_api_order` is service-role only (it is, as of 2026-10-23).
- [ ] **Step 2: Write the migration** in one transaction (`BEGIN`, `SET LOCAL lock_timeout='5s'`, `SET LOCAL statement_timeout='120s'`), idempotent. `place_api_v2_order` body: (1) fast path: `SELECT ... FROM api_orders WHERE user_id = p_user_id AND api_reference = p_api_reference`; if found and `network`, `volume_gb`, `recipient_phone` all equal the parameters (compare `lower(network)`) return the replay JSON, otherwise return `REFERENCE_REUSED`; (2) lock the wallet row `FOR UPDATE`, check balance, deduct (`balance`, `total_spent`), insert the order with `api_v2_key_id` and `status 'pending'`, insert the `transactions` debit row exactly as `place_api_order` does (`source 'api_order'`), all inside one block; (3) an inner `EXCEPTION WHEN unique_violation` re-runs the lookup in the handler and returns replay or `REFERENCE_REUSED` (this is the race path; the wallet deduction of the losing transaction is rolled back with the block); (4) `WHEN OTHERS` returns the generic failure (log nothing sensitive). Mirror `migrations/place_api_order.sql` for column names.
- [ ] **Step 3: Do not apply** (Task 9). **Step 4: Commit** `feat(api-v2): v2 order attribution and atomic replay-aware placement`

---

### Task 2: Data-order rules (pure) — `lib/api-v2/data-orders.ts`

**Files:**
- Create: `lib/api-v2/data-orders.ts`
- Test: `lib/api-v2/data-orders.test.ts`

**Interfaces:**
- Produces: `type ApiNetwork = "MTN" | "Telecel" | "AT-iShare" | "AT-BigTime"`; `parseNetwork(v: unknown): { ok: true; network: ApiNetwork; dbNetwork: string } | { ok: false; error: string }`; `normalizeRecipient(v: unknown): { ok: true; msisdn: string; local: string } | { ok: false; error: string }` (`msisdn` is `233XXXXXXXXX`, `local` is `0XXXXXXXXX`); `parseVolume(v: unknown): { ok: true; gb: number } | { ok: false; error: string }` (finite positive number, at most 3 decimals, at most 1000); `parseReference(v: unknown): { ok: true; reference: string } | { ok: false; error: string }` (string 3–100 chars, trimmed, printable ASCII word chars, `-`, `_`, `.`, `:`); `interface PurchaseInput { network: ApiNetwork; dbNetwork: string; gb: number; msisdn: string; local: string; reference: string }`; `parsePurchaseBody(body: unknown): { ok: true; value: PurchaseInput } | { ok: false; error: string }` (rejects unknown price-like fields: `price`, `amount`, `package_id`, `status`, `user_id`, `total` with a 400 message "Unexpected field"); `parseBulkBody(body: unknown): { ok: true; items: PurchaseInput[] } | { ok: false; error: string; index?: number }` (1–100 items under key `orders`, references unique within the batch); `priceForRole(role: string, pkg: { price: number; dealer_price: number | null }): number` (v1 rule); `mapOrderStatus(dbStatus: unknown): "pending"|"processing"|"completed"|"failed"|"refunded"|"queued"`; `mapOrder(row): { reference; network; volume_gb; recipient; price; status; created_at }` (allow-list; `network` canonicalised from the DB string; `recipient` returned as `local`); `interface PackageRow { id: string; network: string; size: string; price: number; dealer_price: number | null }`; `findPackage(rows: PackageRow[], dbNetwork: string, gb: number): PackageRow | null` (numeric size equality).

- [ ] **Step 1: Write failing tests** covering every edge in Review Focus: network case-insensitivity and canonical mapping (accept only the four names plus case variants and the spaced DB forms `AT - iShare` / `AT - BigTime`); each recipient form (`0244123456`, `233244123456`, `+233244123456`, with internal spaces/dashes stripped) normalises identically; `244123456`, `024412345`, `02441234567`, `abc`, `""`, `["0244123456"]`, a number type, newline-wrapped input fail; volume `"1"`, `1`, `1.0` ok (1), `0`, `-1`, `NaN`, `Infinity`, `1e3`, `1001`, `1.2345` fail; reference length 2/101 fail, a reference with spaces or unicode fails; `parsePurchaseBody({..., price: 1})` fails with "Unexpected field"; `parseBulkBody` with 0 items, 101 items, duplicate references fails and reports the index; `priceForRole("dealer", {price: 10, dealer_price: 8})` is 8, dealer with `dealer_price` 0 or null is 10, `user`/`sub_agent`/`admin` are 10; `mapOrderStatus` for all six mapped values and an unknown value (`processing`); `mapOrder` returns exactly the seven allow-listed keys even if the row carries `id`, `provider_reference`, `error_message`, `api_key_id`; `findPackage` matches `"1"` and `"1.0"` sizes numerically and returns null for a missing size.
- [ ] **Step 2: Run** `npx vitest run lib/api-v2/data-orders.test.ts` — FAIL. **Step 3: Implement** reusing existing helpers where they exist (`normalizePhoneNumber`, prefix validation stays in Task 6). **Step 4: Run** — PASS. **Step 5: Commit** `feat(api-v2): data order rules`

---

### Task 3: Order data access — `lib/api-v2/order-store.ts`

**Files:**
- Create: `lib/api-v2/order-store.ts`
- Test: `lib/api-v2/order-store.test.ts` (fake client, the repo's pattern)

**Interfaces:**
- Consumes: `SupabaseLike` from `lib/api-v2/store.ts`; `PackageRow`, `mapOrder` from Task 2.
- Produces (client injected first): `listAvailablePackages(client, dbNetwork?: string): Promise<PackageRow[]>` (only `is_available = true`, ordered by network then numeric size); `placeV2Order(client, p: { userId; apiV2KeyId; packageId; dbNetwork; gb; price; msisdn; reference; description }): Promise<PlaceResult>` where `PlaceResult = { ok: true; replayed: boolean; orderId: string; createdAt: string; status?: string; newBalance?: number } | { ok: false; code: "INSUFFICIENT_BALANCE" | "REFERENCE_REUSED" | "WALLET_NOT_FOUND" | "FAILED"; required?: number; balance?: number }` (calls `rpc("place_api_v2_order", ...)`, maps the JSON, never throws, an RPC error becomes `FAILED`); `getOrderByReference(client, userId: string, reference: string): Promise<OrderRow | null>` (filters on BOTH `user_id` and `api_reference`, explicit columns, no `provider_reference`/`error_message`); `getWalletBalance(client, userId): Promise<number | null>` (for the bulk pre-check).

- [ ] **Step 1: Write failing tests** with a fake: `placeV2Order` maps each RPC JSON shape (success, replay, insufficient, reused, wallet missing, generic failure) and an RPC transport error to the right `PlaceResult`; it passes exactly the parameter names of Task 1; it never forwards extra fields; `getOrderByReference` calls the fake with both filters and returns null when absent; the select list excludes `provider_reference`, `error_message`, `api_key_id`; `listAvailablePackages` filters availability and sorts sizes numerically (`2` before `10`).
- [ ] **Step 2–4:** FAIL, implement, PASS. **Step 5: Commit** `feat(api-v2): order data access`

---

### Task 4: Fulfillment dispatch — `lib/api-v2/fulfillment.ts`

**Files:**
- Create: `lib/api-v2/fulfillment.ts`
- Test: `lib/api-v2/fulfillment.test.ts` (injected deps)

**Interfaces:**
- Produces: `interface FulfillmentDeps { isMtnAuto(): Promise<boolean>; createMtnOrder(req): Promise<MtnResult>; saveMtnTracking(...): Promise<void>; holdMtnOrder(...): Promise<{ held: boolean }>; markProcessing(orderId: string): Promise<void>; createNonMtnOrder(req): Promise<unknown> }`; `dispatchFulfillment(deps: FulfillmentDeps, o: { orderId: string; dbNetwork: string; gb: number; msisdn: string; local: string }): Promise<{ attempted: boolean; outcome: "mtn" | "non_mtn" | "skipped" | "error" }>` (never throws); `realFulfillmentDeps(): FulfillmentDeps` wiring the SAME underlying modules v1 uses (`lib/mtn-fulfillment`, `lib/mtn-hold`, `lib/non-mtn-fulfillment`) with `orderType "api"`/table `api_orders` exactly as `app/api/v1/orders/route.ts` does (read it, copy the semantics, do not edit it); `scheduleFulfillment(o)`: calls `after()` from `next/server` with `dispatchFulfillment(realFulfillmentDeps(), o)`.
- If the repo's fulfillment-queue pattern (`fulfillment_queue`, `lib/fulfillment-queue*`) is how other order sources hand work to providers, use it instead of calling providers inline and say so in the report; otherwise mirror v1's direct dispatch.

- [ ] **Step 1: Write failing tests:** MTN network with auto-fulfillment on calls `createMtnOrder` once with `client_ref = orderId`, then `saveMtnTracking` (or `holdMtnOrder` when `held`) and `markProcessing` only on success; MTN with auto off does nothing (`skipped`); Telecel / AT-iShare call `createNonMtnOrder` with the right `network` and `orderType "api"`; networks v1 does not auto-fulfil are `skipped`; a thrown provider error returns `outcome: "error"` and never rethrows; `dispatchFulfillment` has no hidden global state (calling it twice calls providers twice; avoiding a second call on a replay is the CALLER's job).
- [ ] **Step 2–4:** FAIL, implement, PASS. **Step 5: Commit** `feat(api-v2): order fulfillment dispatch`

---

### Task 5: Fail-closed purchases in `withV2`

**Files:**
- Modify: `lib/api-v2/handler.ts`; Test: `lib/api-v2/handler.test.ts`

**Interfaces:**
- Consumes: plan 1's `withV2(opts, handler)` / `runV2`.
- Produces: new option `opts.failClosedWhenLimiterDegraded?: boolean` (default false). When true and the rate limiter result has `degraded: true`, the wrapper returns 503 `MSG_UNAVAILABLE` WITHOUT running the handler and without logging a 429.

- [ ] **Step 1: Write failing tests:** with the option true and a fake limiter returning `{allowed: true, degraded: true}` the handler is not called and the response is 503; with the option false the handler runs (existing behaviour); with the option true and a normal allowed result the handler runs; a denied result is still 429.
- [ ] **Step 2–4:** FAIL, implement (a few lines at the existing rate-limit call), PASS; run the whole `lib/api-v2` suite to prove nothing else changed. **Step 5: Commit** `feat(api-v2): purchase endpoints fail closed when the limiter is degraded`

---

### Task 6: Endpoint handlers and routes

**Files:**
- Create: `lib/api-v2/endpoints/data.ts` (pure-ish handlers with injected deps), `lib/api-v2/endpoints/data.test.ts`
- Create routes: `app/api/v2/packages/route.ts`, `app/api/v2/data/purchase/route.ts`, `app/api/v2/data/bulk/route.ts`, `app/api/v2/data/verify-number/route.ts`, `app/api/v2/orders/[reference]/route.ts`

**Interfaces:**
- Consumes: Tasks 2–5, plan 1's `withV2`, `V2Context`, store, `getPrefixValidationConfig` + `validateNetworkPrefix` (`lib/phone-format`), the phone-verification guard used by the v1 bundles route (`lib/phone-verify-guard` `checkPhoneVerified`; read how `app/api/v1/bundles/route.ts` and the dashboard order routes call it and what shape it returns), `placeSandboxOrder`/`getSandboxOrder` (`lib/sandbox.ts`).
- Produces: handler factories taking `DataDeps = { client; prefixConfig(): Promise<...>; verifyMtn(msisdns: string[]): Promise<Map<string, boolean | null>>; sandbox: {...}; schedule(o): void; now(): Date }` and returning functions of `(req body/params, ctx: V2Context)` to `{ status; data? ; error? }`: `listPackagesHandler`, `purchaseHandler`, `bulkHandler`, `verifyNumberHandler`, `orderLookupHandler`.
- Endpoint contracts: `GET /packages?network=&size_gb=` (standard key, group `status`) returns `{ packages: [{ network, size_gb, price }] }` at the caller's role price only for available packages; `POST /data/purchase` (group `purchase`, fail closed) body `{ network, volume_gb, recipient, reference }` returns 201 `{ order, new_balance }` on a new order, 200 `{ order, replayed: true }` on a replay, 400 invalid input or network/prefix mismatch, 402 insufficient balance (with `required`), 404 package not found/unavailable, 409 `REFERENCE_REUSED` or an unregistered MTN recipient blocked by the whitelist guard (no charge), 503 limiter degraded; `POST /data/bulk` (group `bulk`, fail closed) body `{ orders: [...] }` (1–100): validate EVERYTHING first (parse, package lookup, prefix check, reference uniqueness); any validation failure rejects the whole batch with 400 and the index, no charge; then verify MTN recipients, skip the unregistered ones and list them under `skipped`; check the summed price of the remaining items against the wallet (402 for the whole batch, no charge); then place each item through `placeV2Order` sequentially (a mid-batch 402 or failure marks that item `failed` and continues), returning 200 `{ results: [{ reference, status: "placed"|"replayed"|"failed", order?, error? }], skipped: [...], total_charged }`; `POST /data/verify-number` body `{ network, phone }` (group `status`) returns `{ allowed: boolean, checked: boolean }` (`checked:false` and `allowed:true` when non-MTN or the check is unavailable, failing open like the reference); `GET /orders/{reference}` (group `status`) returns `{ order }` or 404 for unknown OR another user's reference (identical body).
- Single-purchase decision (documented, mine): when the whitelist guard blocks an MTN recipient return 409 and charge nothing (matches the spec's 409), whereas v1's hold-at-fulfillment mechanism stays for numbers that pass the guard but later fail registration.
- Sandbox branch in every purchase/bulk path (`ctx.environment === "test"`): identical parsing, package lookup, pricing and prefix checks, then `placeSandboxOrder` with `action: "data_order"`; replay/409 semantics preserved; never touch `wallets` or `api_orders`; `getSandboxOrder` for lookups.

- [ ] **Step 1: Write failing tests** with fake deps (money tests first): a new purchase calls `placeV2Order` once with the SERVER-resolved price (dealer 8 vs user 10) and schedules fulfillment once; a replay returns 200 `replayed: true`, does NOT schedule fulfillment and does NOT call the provider; `REFERENCE_REUSED` returns 409; `INSUFFICIENT_BALANCE` returns 402 with `required` and no scheduling; body price fields are rejected before any DB call; an unavailable package (Telecel 5 GB, any AT-BigTime) returns 404; network/prefix mismatch returns 400 `NETWORK_MISMATCH`; MTN recipient blocked by the guard returns 409 and `placeV2Order` is NOT called; verification outage fails open for `verify-number` but for `purchase` follows the guard's own fail-open/closed contract (state which in a test name); bulk: 101 items, duplicate references and one invalid item each reject the whole batch with NO `placeV2Order` calls; a batch whose total exceeds the balance returns 402 with no calls; a mixed batch places valid items, lists unregistered MTN items under `skipped`, and `total_charged` equals the sum of placed (not replayed) prices; a replayed bulk item is reported `replayed` and charged 0; order lookup returns 404 with an identical body for missing and foreign references; `verify-number` returns `allowed:true, checked:false` for Telecel; every handler returns `mapOrder` objects only (assert exact keys); a test key never calls the real store or `placeV2Order`, only the sandbox deps.
- [ ] **Step 2: Run** `npx vitest run lib/api-v2/endpoints/data.test.ts` — FAIL. **Step 3: Implement** handlers then the five thin routes (`requiredType: "standard"`, groups as above, `failClosedWhenLimiterDegraded: true` for purchase and bulk, `export const dynamic = "force-dynamic"`, `maxDuration = 60`; bulk placed sequentially).
- [ ] **Step 4: Run** the tests — PASS; `npx tsc --noEmit -p . 2>&1 | grep -E "api-v2|api/v2"` empty. **Step 5: Commit** `feat(api-v2): data, packages, verify-number and order lookup endpoints`

---

### Task 7: Documentation

**Files:**
- Modify: `lib/api-v2/docs/registry.ts`, `lib/api-v2/docs/registry.test.ts`

**Interfaces:**
- Consumes: Task 6 contracts. Produces: five new `V2Endpoint` entries (`packages`, `data/purchase`, `data/bulk`, `data/verify-number`, `orders/{reference}`) in a new "Data" section group, plus prose sections "Order statuses" (the six statuses and what each means, including that `queued` means an MTN number is awaiting registration and `refunded` means the wallet was credited back) and "Bulk orders" (validation-first, skipped numbers, partial results, replay-safe resends).

- [ ] **Step 1: Write failing tests:** every new endpoint has params, a request example where applicable, a success example whose keys equal `mapOrder`'s allow-list, the REAL error set (400, 402, 403 variants via the exported constants, 404, 409, 429, 503), a rate-limit string, notes covering role pricing, idempotent references and the no-price rule; the status list in the docs equals the mapper's output set (import the union and compare); the documented network names equal `parseNetwork`'s accepted canonical names; the docs mention that test keys use a sandbox wallet.
- [ ] **Step 2–4:** FAIL, write the entries (real examples with Ghana numbers like `0244000001`), PASS. **Step 5: Commit** `docs(api-v2): document data, packages, verification and orders`

---

### Task 8: Order attribution in admin stats (migration `0131`) and shapers

**Files:**
- Create: `migrations/0131_api_v2_stats_orders.sql`
- Modify: `lib/api-v2/admin-stats.ts`, `lib/api-v2/admin-stats.test.ts`

**Interfaces:**
- Produces (SQL): `CREATE OR REPLACE` of `api_v2_admin_stats(p_since)` and `api_v2_key_activity(p_key, p_since)` (same signatures, same grants re-asserted: service_role only) adding `revenue` (sum of `price` for `api_orders` with `api_v2_key_id IS NOT NULL`, `created_at >= p_since`, status not in `failed`,`refunded`), `revenue_lifetime` (same, no time filter), `orders` (count, same filters), `pending_orders` (status in `pending`,`processing`,`held_registration`) in the first, and `spent`, `orders`, `pending` in the second (filtered to the key). All new fields default to `0` when there are no rows. Keep every existing field and name unchanged.
- Produces (TS): `AdminStats.revenue24h`/`revenueLifetime` become `number | null` populated from `revenue`/`revenue_lifetime` when numeric else `null`; `KeyActivity.spent`, `orders` become `number | null` likewise and add `pending: number | null`.

- [ ] **Step 1: Write failing tests:** with `revenue: 96.9, revenue_lifetime: 8806.64` the shaper returns those numbers (2 dp), with the fields absent (older function version) it returns `null` (so an unapplied 0131 degrades to hidden tiles), malformed values give `null`, negatives clamp to `null`; the per-key shaper maps `spent`, `orders`, `pending` the same way; existing assertions that `revenue24h` is ALWAYS null are updated to the new rule.
- [ ] **Step 2–4:** FAIL, implement, PASS; confirm the plan 2 UI needs no change (tiles/fields already render only when non-null; if a component still hard-codes null, fix it in this task). **Step 5: Write the migration; do not apply** (Task 9). **Step 6: Commit** `feat(api-v2): attribute orders to keys in admin stats`

---

### Task 9: Apply, verify, review, ship

**Files:** none new.

- [ ] **Step 1: Precheck + dry run migration 0130** (prod change protocol): the Task 1 consumer precheck results shown to the user; a self-rolling-back `DO ... RAISE EXCEPTION` dry run that creates everything and then calls `place_api_v2_order` against a throwaway wallet/user/key it creates inside the transaction, asserting inside the block: first call charges and creates one order; second identical call is a replay with no second charge; a different recipient with the same reference returns `REFERENCE_REUSED`; an over-balance call returns `Insufficient balance` and leaves the balance unchanged; `anon`/`authenticated` lack EXECUTE; existing `api_orders` rows still satisfy the new CHECK. Show the user the output and wait for their OK; then apply and verify the same facts read-only (constraint exists and validated, function exists with service-role-only EXECUTE, anon REST rpc denied).
- [ ] **Step 2: Same protocol for `0131`** (functions only), then call both stats functions through the service role and confirm the zero-shape output now includes the new fields.
- [ ] **Step 3: Local verification in a clean worktree:** full `npx vitest run` (only the known failures: the nine order-health tests and the load-flaky AFA test), real placeholder-env `next build` exit 0 listing the five new routes.
- [ ] **Step 4: Reviews (Tier 1):** a database-reviewer pass on both migrations, then a fresh most-capable-model whole-branch reviewer briefed with this plan's Review Focus and Global Constraints, the diff, and the ledger; ask it to check what the change REMOVED or loosened (nullable `api_key_id`, any consumer of `user_api_keys` joins) as well as what it added; abuse-case pass (free, someone else's, twice, cheaper, no-auth, at-scale) on every endpoint. Fix confirmed findings in ONE wave with failing tests first, then one scoped re-review.
- [ ] **Step 5: Merge** per the protocol (fetch, check other sessions' commits, merge origin/main in the clean worktree, build, push, watch every recent deploy until READY).
- [ ] **Step 6: Supervised live check (v2 still dark):** with the user logged in as admin, enable v2 for `admin`, generate a TEST standard key, then with curl: `GET /packages`, a sandbox `POST /data/purchase` (new = 201, same again = 200 `replayed`, same reference with a different recipient = 409), `POST /data/bulk` with 2 items, `GET /orders/{reference}`, `POST /data/verify-number` for an MTN and a Telecel number; confirm sandbox balance moves and the REAL wallet and `api_orders` do not change. Only with the user's explicit OK and a live key approved by them: ONE real purchase of the cheapest available package to a number the user names, watching the wallet debit, the `api_orders` row (with `api_v2_key_id`), fulfillment and the final status, and confirm the admin console now shows revenue and an order for that key. Then switch v2 back off.
- [ ] **Step 7: Update memory** (`project-api-v2-foundation`: plan 3 shipped, statuses, the order table decision, what plan 4 picks up).
