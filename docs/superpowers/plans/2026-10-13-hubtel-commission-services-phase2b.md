# Hubtel Commission Services — Phase 2b (Standard Bundles on the dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new customer page, **Standard Bundles**, that sells Hubtel's own data bundles at Hubtel's exact price (no markup): browse a network's bundles in category tabs, enter the recipient number, pay from the wallet.

**Architecture:** Mirrors the reviewed Phase 3a (`lib/bills/*`) design — reuse its patterns, not its tables: a `lib/standard-bundles/` engine (categories, config, signed catalog token, catalog cache, buy orchestration with injected deps), a `hubtel_data_orders` table with an atomic debit RPC, an order adapter registered in the hubtel-cs runtime, thin routes, a customer page and an admin card/list.

**Tech Stack:** Next.js 15, TypeScript, Supabase (service role), Vitest, `lib/hubtel-cs/*` (client.query/purchase), shadcn UI.

**Spec:** `docs/superpowers/specs/2026-10-13-hubtel-commission-services-phase2-design.md` §6–7 (+ §9 errors). Live data: `lib/hubtel-cs/testing/fixtures/live-bundle-query-2026-10-13.json` (MTN 37 / Telecel 27 / AT 30 bundles, identical across numbers). Reference implementation to mirror: `lib/bills/{service,token,config,runtime,route-auth,ui-helpers,admin,admin-refund}.ts`, `lib/hubtel-cs/adapters/bill-orders.ts`, `components/bills/BillPayFlow.tsx`, `migrations/0117_hubtel_bill_orders.sql`.

## Global Constraints

- Price = Hubtel's `Amount` exactly; never add fees or markup. No shop profit (storefronts are 2c).
- Ships dark: `standard_bundles_config` defaults `enabled: false`, every network `enabled: false`; sidebar link hidden until enabled.
- Config key `standard_bundles_config` in `admin_settings`, written only via `standard_bundles_config_patch(jsonb)` RPC (same pattern as 0117's `utility_bills_config_patch`).
- Buy order is fixed: auth → idempotency/validation → all pre-checks (config, network enabled, category not hidden, Hubtel enabled + `data_<net>` service enabled + not paused, phone valid for the network) → **re-query Hubtel for the buyer's number and require the exact `(Value, Amount)`** (else 409, nothing charged) → insert order → atomic `data_order_debit` RPC (debit + paid + `transactions` row, source `standard_bundle`) → claim `pending→processing` ("Dispatching…") → at most ONE `purchase`. Never resend, never auto-refund, never provider fallback.
- Bundle identity is `(value, amount)`; `value` is sent to Hubtel **exactly as returned** (no trim — Telecel values may carry spaces).
- Double-submit protection: client sends an `idempotencyKey` (uuid generated when the confirm dialog opens); `(user_id, idempotency_key)` UNIQUE on the order; a repeat returns the existing order (no second debit).
- Catalog token: HMAC-SHA256 with `HUBTEL_CS_CALLBACK_SECRET` and domain prefix `"bundles-catalog:"`, fields `(network, value, amount, display, category, issuedAt)`, valid 10 minutes, empty secret ⇒ fail closed. Not user-bound (catalog is per network); buy is authenticated.
- Refunds manual only: Hubtel review queue Refund (adapter `refundToWallet`, idempotent `data-refund-<order id>`), or the admin never-sent path (Task 9) mirroring `lib/bills/admin-refund.ts` (60 s grace, stuck-claim release ≥5 min, fully SQL-guarded release).
- Customer pay screen uses `classifyPayResponse` semantics from `lib/bills/ui-helpers.ts` (timeouts/5xx ⇒ "could not confirm, check your wallet", never "failed").
- Route files export only HTTP handlers/route config (`maxDuration = 60` on buy). Migrations additive, `IF NOT EXISTS`, RLS on, service-role only, functions `SET search_path = public` + REVOKE/GRANT. Next free migration on origin/main (expected `0118`).
- UI: navy tokens, light cards, 500px usable, `lg:` multi-column, NEW tag (`lib/nav-new.ts`).
- **Edit code with the Edit/Write tools, never sed/shell** (a shell edit once ate regex backslashes and broke all payments). Regexes live in pure tested helpers.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Bundle changed or not offered for the buyer's number between browse and buy ⇒ 409, nothing charged (Task 5).
2. Double-click / network retry on Buy ⇒ exactly one debit and one Hubtel POST (idempotency key, Task 5).
3. Debit succeeded but Hubtel errored before the POST ⇒ order pending+paid "Not sent", admin-visible and refundable after 60 s; never resent automatically (Tasks 5, 9).
4. Telecel bundle values with leading/trailing spaces reach Hubtel byte-for-byte (Tasks 2, 5).
5. Every live bundle maps to a real (non-"Other") category (Task 2, against the live fixture).

---

### Task 1: Migration 0118 — data orders, config patch RPC, atomic debit

**Files:** Create `migrations/0118_hubtel_data_orders.sql`.

- `hubtel_data_orders`: `id uuid pk default gen_random_uuid(), reference_code text unique not null, user_id uuid not null, channel text not null default 'dashboard' check (channel in ('dashboard')), network text not null check (network in ('MTN','TELECEL','AT')), service_key text not null, beneficiary_phone text not null, bundle_value text not null, bundle_display text not null, bundle_category text not null, amount numeric(12,2) not null check (amount > 0), status text not null default 'pending' check in ('pending','processing','completed','failed','refunded'), payment_status text not null default 'unpaid' check in ('unpaid','paid','refunded'), idempotency_key text not null, hubtel_client_reference text unique, commission numeric(12,6), failure_reason text, notes text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()`; `UNIQUE (user_id, idempotency_key)`; indexes `(user_id, created_at desc)`, `(status, created_at)`; RLS on; `REVOKE ALL … FROM anon, authenticated`.
- `standard_bundles_config_patch(p_patch jsonb) RETURNS jsonb` — copy `utility_bills_config_patch` from 0117 with key `standard_bundles_config`, description "Standard Bundles (Hubtel data): master switch, per-network switches, hidden categories, catalog reference numbers.", merging `networks` per network key (`jsonb_typeof(...)='object'` guard).
- `data_order_debit(p_order_id uuid) RETURNS text` — copy `bill_order_debit` from 0117 exactly, but on `hubtel_data_orders`, transactions `source = 'standard_bundle'`, description `'Standard bundle: ' || o.network || ' ' || o.bundle_display || ' to ' || o.beneficiary_phone`, `reference_id = o.reference_code`.
- REVOKE ALL FROM PUBLIC, anon, authenticated + GRANT EXECUTE TO service_role on both functions.
- [ ] Write, commit `feat(bundles): hubtel_data_orders, config patch and atomic debit RPCs (migration 0118, not applied)`.

---

### Task 2: Categories and catalog parsing

**Files:** Create `lib/standard-bundles/categories.ts`, `lib/standard-bundles/categories.test.ts`.

**Produces:** `type BundleNetwork = "MTN" | "TELECEL" | "AT"`; `BUNDLE_NETWORKS`; `NETWORK_SERVICE: Record<BundleNetwork, HubtelCsServiceKey>` (`data_mtn`, `data_telecel`, `data_at`); `CATEGORY_ORDER: Record<BundleNetwork, readonly string[]>`; `categoryOf(network, item: HubtelQueryItem): string`; `CatalogBundle { value: string /* exact */; display: string /* trimmed */; amount: number; category: string }`; `parseCatalog(network, items): CatalogBundle[]` (drops items with empty value or non-finite/≤0 amount; sorted by category order then amount).

Rules (spec §6, verified against live data):
- **MTN** by `Value`: contains `_Midnight_` → "Midnight"; `_Kokrokoo_` → "Kokrokoo"; `_Social_` → "Social Media"; `_Video_` → "Video"; `_Data_` → "Data". Order: Data, Video, Social Media, Midnight, Kokrokoo.
- **Telecel** by `Display` text before `" - "`: `No Expiry(12am` prefix → "Night"; `No Expiry` → "No Expiry"; `1 Hour` → "Hourly"; `N day(s)`: 1 → "Daily", 2–7 → "Weekly", 8–31 → "Monthly". Order: Hourly, Daily, Weekly, Monthly, No Expiry, Night.
- **AT** by `Value` prefix: `db_BigTime_Data_` → "BigTime"; `db_Fuse_` → "Fuse (Mins + Data)"; `db_Sika_Kokoo_` → "Kokoo"; `db_XXL_Family_Pack_` → "XXL Family". Order: BigTime, Kokoo, Fuse (Mins + Data), XXL Family.
- Anything else → "Other" (always last).

Tests: every bundle in the live fixture maps to a non-"Other" category, with counts MTN `{Data:14, Video:10, Social Media:8, Midnight:4, Kokrokoo:1}`, Telecel `{No Expiry:11, Monthly:8, Weekly:3, Hourly:2, Night:2, Daily:1}`, AT `{BigTime:12, Kokoo:8, Fuse (Mins + Data):7, XXL Family:3}` (totals 37/27/30 are certain; if a per-category count differs, check those bundles by hand against the rules — the rules are authoritative, the expected numbers are not); unknown values → "Other"; a Telecel value `" 5.7 GB"` keeps its spaces in `value`; empty/negative amounts dropped; MTN `RACT_Data_Flexi_Bundle` appears multiple times with different amounts (identity = value+amount). Commit `feat(bundles): category mapping verified against live Hubtel data`.

---

### Task 3: Config

**Files:** Create `lib/standard-bundles/config.ts` (+ test). Mirror `lib/bills/config.ts`.

**Produces:** `BUNDLES_CONFIG_KEY = "standard_bundles_config"`; `NetworkSetting { enabled: boolean; hiddenCategories: string[]; referenceNumber: string }`; `BundlesConfig { enabled: boolean; networks: Record<BundleNetwork, NetworkSetting> }`; defaults: everything off, `hiddenCategories: []`, reference numbers = Hubtel's documented sample numbers (`MTN 233246912184`, `TELECEL 233206439599`, `AT 233273833933`); `resolveBundlesConfig(raw)` (never throws; only literal `true` enables; reference number must be a valid Ghana mobile in 233 form else default; hiddenCategories strings only, max 20, each ≤40 chars); `validateBundlesPatch(body)` (strict; per-network patches carry complete `NetworkSetting`); `getBundlesConfig(db)`, `setBundlesConfig(db, patch)` via the RPC. Tests mirror `lib/bills/config.test.ts`. Commit.

---

### Task 4: Catalog token + catalog service

**Files:** Create `lib/standard-bundles/token.ts`, `lib/standard-bundles/catalog.ts` (+ tests).

- Token per Global Constraints (mirror `lib/bills/token.ts`; fields `network, value, amount, display, category, issuedAt`; domain `"bundles-catalog:"`; `verifyBundleToken(token, secret, now)`; tests incl. tamper, expiry, wrong secret, empty secret, and that a `lib/bills` token never verifies here).
- `getCatalog(deps, network)` → `{ ok: true; categories: { name: string; bundles: (CatalogBundle & { token: string })[] }[] } | { ok: false; status; error }`: checks config enabled + network enabled + Hubtel service enabled (browsing is allowed while Hubtel is paused; buying is not — Task 5); queries Hubtel with the network's reference number; `parseCatalog`; removes hidden categories; signs a token per bundle; caches the parsed (unsigned) list per network for 10 minutes in module memory (tokens re-signed per response so `issuedAt` is fresh); Hubtel error ⇒ 503 "Bundles unavailable right now" (no detail). Tests with fake deps (cache hit, hidden category removed, disabled network 403, Hubtel error 503). Commit.

---

### Task 5: Buy orchestration

**Files:** Create `lib/standard-bundles/service.ts` (+ test). Mirror `lib/bills/service.ts` (`payBill` + `dispatchInternal`), with these differences:

- Input `buyBundle(d, userId, { token, phone, idempotencyKey })`. `idempotencyKey` must match `/^[A-Za-z0-9-]{8,64}$/` (pure helper, tested). If an order already exists for `(userId, idempotencyKey)` return it (200, no new debit) — check before anything else and also map a unique violation on insert to "return the existing order".
- Phone: `isValidGhanaMobile` + the network-prefix check (`validateNetworkPrefix` / the admin-editable prefix map used by the Data page) for the token's network; normalised to 233 form.
- Pre-checks before any write (bundles + network enabled, category not hidden, Hubtel enabled + service enabled + not paused, secret present); config read errors ⇒ 503 fail closed.
- **Re-query** `client.query(NETWORK_SERVICE[network], phone233)`; require an item with `Value === token.value` (exact string) and `Amount === token.amount` (compare at 2dp); else 409 "This bundle isn't available for that number right now — refresh" (nothing written). Query failure ⇒ 503.
- Insert order (status pending/unpaid, bundle fields from the token) → `debitOrder` = `rpc('data_order_debit')` (ok / insufficient ⇒ failed + 402 / not_found ⇒ 409 / throw ⇒ re-read: paid ⇒ continue, else alert "debit outcome uncertain" (urgent) + 500) → claim `pending→processing` ("Dispatching…") → `purchase({ serviceKey, destination: phone233, amount, bundle: value /* exact */, orderTable: "hubtel_data_orders", orderId })` → same outcome handling as bills (`pending/created` ⇒ set ref from ['processing'], 0 rows ⇒ re-read + alert only if still processing without ref; needs_review / OutcomeUnknown ⇒ processing + alert; pre-POST error ⇒ revert to pending "Not sent: …" + alert; Duplicate ⇒ processing + alert).
- Required tests: the five Review Focus items, plus insufficient balance (no purchase), debit throw paid/unpaid, claim lost (no purchase), Telecel spaced value sent exactly, Hubtel paused ⇒ 503 with no write. Commit.

---

### Task 6: `hubtel_data_orders` adapter

**Files:** Create `lib/hubtel-cs/adapters/data-orders.ts` (+ test); register in `lib/hubtel-cs/runtime.ts` (+ runtime test). Mirror `lib/hubtel-cs/adapters/bill-orders.ts` exactly (guarded writes from pending|processing, notifications + push best-effort with "Standard bundle" wording and `action_url /dashboard/standard-bundles`, double-value admin alert when delivered after failed/refunded, `refundToWallet` only failed+paid, credit `credit_wallet_safely` reference `data-refund-<order id>` source `standard_bundle_refund`, then guarded failed→refunded). Commit.

---

### Task 7: Runtime wiring + customer routes

**Files:** Create `lib/standard-bundles/runtime.ts`, `app/api/standard-bundles/{catalog,buy,orders,availability}/route.ts`. Mirror `lib/bills/runtime.ts` + `app/api/bills/*` (Bearer auth via the existing `lib/bills/route-auth.ts` helpers, `checkPhoneVerified` on buy, `applyRateLimit` — catalog 30/min, buy 10/min per user, `maxDuration = 60` on buy, orders filtered by user with an explicit column list, availability never throws and returns `{ enabled, networks: [{ network, label }] }`). Tests for runtime wiring (debit RPC name/args, throw on error). Commit.

---

### Task 8: Customer page + sidebar

**Files:** Create `app/dashboard/standard-bundles/page.tsx`, `components/standard-bundles/*`; modify `lib/dashboard-nav-items.ts` (feature `"standard-bundles"`), the sidebar filter, `lib/nav-new.ts`.

- Page: header "Standard Bundles" + wallet balance; network pills (enabled networks only); category pill-tabs in `CATEGORY_ORDER`; bundle cards (display, "GHS x.xx") in a responsive grid (`lg:` 3–4 columns); tap ⇒ dialog: recipient number (prefilled from profile, validated for the network), bundle + price, wallet balance, **Buy** (idempotency key generated when the dialog opens; Pay guard ref; disabled in flight); outcomes via `classifyPayResponse` (409 "refresh" ⇒ reload catalog); done step shows real order status with the right icon; "My Standard Bundle orders" list (status labels like `billStatusLabel`).
- Sidebar: "Standard Bundles" (icon `Package` or similar) for user/dealer/sub_agent/admin, hidden unless availability enabled; NEW tag.
- Verify tsc/eslint/nav tests; headless screenshots if feasible. Commit.

---

### Task 9: Admin — config card, orders list, never-sent refund

**Files:** Modify `app/admin/hubtel-commission/page.tsx` (new "Standard Bundles" settings card) + create `app/api/admin/standard-bundles/{config,orders,refund}/route.ts`, `lib/standard-bundles/admin.ts`, and a "Standard Bundles" orders tab on the same admin page.

- Settings card: master switch; per network: enable, catalog reference number (validated), category chips to hide/show (from the last catalog, plus "Other"); Save via `validateBundlesPatch` → RPC.
- Orders tab: list (search ref/phone, status, network, date range; explicit columns; stats via a simple count query is fine — volume is small; cap 100 per page); per row: status pills, amount, commission, Hubtel ref; **Sync** for processing rows (existing check-status route); **Refund** only for never-sent orders (`pending`+`paid`, no ledger row, `updated_at` > 60 s) and stuck claims (≥5 min, fully SQL-guarded release) — mirror `lib/bills/admin-refund.ts` + `releaseStuckClaimRow`; orders with a Hubtel ledger row are refunded through the existing Hubtel review queue (adapter `refundToWallet`) — show a link instead.
- All mutating routes: `requireAdmin`, 403 without userId, `auditLog`, note required ≤500, guarded double-submit. Commit.

---

### Task 10: Verification, runbook, gate

- Full vitest (only the 9 known `lib/order-health-service.test.ts` failures allowed), tsc 0, real `next build` exit 0 (controller reruns if the sandbox blocks Google Fonts).
- Runbook "Phase 2b — Standard Bundles": apply 0118 before merge (pre-check `to_regclass('public.hubtel_data_orders')` null; post-checks: RLS, grants, `select data_order_debit(gen_random_uuid())` → `not_found`, `select standard_bundles_config_patch('{}'::jsonb)`); enable master + one network; buy the cheapest bundle to your own number; check order completed + commission + wallet history (`standard_bundle`); then other networks. Note categories come from live data mapping (re-check if Hubtel renames values). Commit; STOP before migrating/pushing.

## Self-review

Spec §6 (data model, catalog browse-first, categories, identity) → Tasks 1–4; §7 (page, buy flow, re-query, adapter, admin card) → Tasks 5–9; §9 errors → Task 5 tests; Phase 3a lessons (atomic debit, idempotent double-submit, claim, stuck-claim release, unconfirmed-payment UI, no sed) carried into Global Constraints and Tasks 5/8/9.
