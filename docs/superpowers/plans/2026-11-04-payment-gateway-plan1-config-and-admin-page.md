# Payment Gateway — Plan 1: Per-surface config + `/admin/gateway` page

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the per-surface payment config (gateway × mode × fee bearer for 6 surfaces), make it the single source of truth for the existing "direct charge" behaviour, and move all payment settings to a new `/admin/gateway` page — with **zero change** to how payments behave today.

**Architecture:** A pure `lib/payment-gateway/config.ts` (types, defaults, sanitise, legacy seeding) + a cached reader `lib/payment-gateway/read-config.ts` backed by one `admin_settings` row `payment_gateway_config`. When the row is absent the config is *derived* from the legacy `storefront_direct_charge` / `wallet_direct_charge` keys, so deploy changes nothing. The legacy `isStorefrontDirectChargeEnabled` / `isWalletDirectChargeEnabled` become thin wrappers over the config. Hubtel cannot be selected in this plan (readiness is hard-false until Plans 3–4 ship).

**Tech Stack:** Next.js 15 App Router, Supabase (service-role client), Vitest, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-04-hubtel-payment-gateway-design.md` (sections "Per-surface settings", "New admin page").

This is **Plan 1 of 5**: (1) config + admin page → (2) extract gateway-neutral `confirmPayment` from the Paystack webhook → (3) Hubtel collection core (relay routes, client, callback, status sweep) → (4) wire the 6 surfaces + Paystack fallback → (5) Hubtel Send Money refunds.

## Global Constraints

- Surface keys exactly: `wallet_topup`, `storefront`, `dashboard_direct`, `sms`, `ussd`, `whatsapp`.
- Gateway values: `paystack` | `hubtel`. Mode values: `checkout` | `direct`. Fee bearer: `customer` | `merchant`.
- Defaults: every surface `gateway: "paystack"`, `feeBearer: "customer"`; `ussd` and `whatsapp` are always `mode: "direct"` (forced on read and on write).
- Settings row: `admin_settings` key `payment_gateway_config`, value `{ version: 1, surfaces: Record<SurfaceKey, SurfaceConfig>, hubtelFeePercent: number }`.
- Zero behaviour change on deploy: with the row absent, every existing `isStorefrontDirectChargeEnabled()` / `isWalletDirectChargeEnabled()` caller must return what it returns today.
- `hubtel` is rejected on write in this plan (`isHubtelCollectionReady()` returns `false` until Plan 4 flips it).
- Fee bearer is stored and shown only; nothing applies it until Plan 4.
- Reader cache: 30 s TTL, fail to last-known value (same as `lib/storefront-otp.ts`).
- Admin routes use `verifyAdminAccess`; no secrets in settings; PII-free logs.
- Sidebar: `/admin/gateway` registered in `lib/nav-new.ts` with `since: "2026-11-04"` and wired with `<NewTag>` + `markClicked()` like `/admin/sms`.
- Edits with Edit/Write tools only (no sed/shell edits); run a real `next build` with placeholder env before pushing main.

## Review Focus

1. **Settings page bulk save after the move** — saving `/admin/settings` must not overwrite fee/withdrawal values set on `/admin/gateway` (the Settings PUT must no longer include those keys). Test in Task 5.
2. **Legacy row present but config row absent** — `storefront_direct_charge = {enabled:true}` must still yield storefront `direct`, and an absent legacy row must still inherit the OTP gate. Test in Task 2.
3. **Corrupt / partial config JSON** (missing surfaces, unknown gateway string, `mode: "checkout"` on ussd) — reader returns sanitised values per field, never throws. Test in Task 1.
4. **DB read failure** after a successful read — reader returns last-known, not defaults (defaults could silently flip direct→checkout). Test in Task 2.
5. **Legacy POST routes after the new page exists** — `POST /api/admin/settings/wallet-direct-charge` must update `wallet_topup`, `dashboard_direct` and `sms` modes together (today's shared semantics) so old and new UIs never disagree. Test in Task 3.

---

### Task 1: Pure config module

**Files:**
- Create: `lib/payment-gateway/config.ts`
- Test: `lib/payment-gateway/config.test.ts`

**Interfaces:**
- Produces:
  - `type SurfaceKey = "wallet_topup" | "storefront" | "dashboard_direct" | "sms" | "ussd" | "whatsapp"`; `const SURFACE_KEYS: readonly SurfaceKey[]`
  - `type Gateway = "paystack" | "hubtel"`, `type PaymentMode = "checkout" | "direct"`, `type FeeBearer = "customer" | "merchant"`
  - `interface SurfaceConfig { gateway: Gateway; mode: PaymentMode; feeBearer: FeeBearer }`
  - `interface GatewayConfig { version: 1; surfaces: Record<SurfaceKey, SurfaceConfig>; hubtelFeePercent: number }`
  - `const DIRECT_ONLY_SURFACES: readonly SurfaceKey[] = ["ussd", "whatsapp"]`
  - `function deriveFromLegacy(l: { storefrontDirect: boolean; walletDirect: boolean }): GatewayConfig` — storefront.mode from `storefrontDirect`; wallet_topup, dashboard_direct, sms from `walletDirect`; ussd/whatsapp `direct`; all paystack/customer; `hubtelFeePercent: 0`.
  - `function sanitizeGatewayConfig(raw: unknown, fallback: GatewayConfig): GatewayConfig` — field-by-field: invalid/missing value → fallback's value; forces direct-only surfaces to `direct`; `hubtelFeePercent` clamped to 0..100 (non-finite → fallback).
  - `function validateGatewayConfigUpdate(raw: unknown, opts: { hubtelReady: boolean }): { ok: true; config: GatewayConfig } | { ok: false; error: string }` — strict (no fallback): every surface present and valid, `checkout` on a direct-only surface → error `"<surface> must use direct mode"`, `hubtel` while `!hubtelReady` → error `"Hubtel is not configured"`.

- [ ] **Step 1: Write failing tests** in `config.test.ts`:
  - `deriveFromLegacy({storefrontDirect:true, walletDirect:false})` → `storefront.mode === "direct"`, `wallet_topup/dashboard_direct/sms.mode === "checkout"`, `ussd/whatsapp.mode === "direct"`, every `gateway === "paystack"`, every `feeBearer === "customer"`.
  - `sanitizeGatewayConfig({ surfaces: { ussd: { gateway:"paystack", mode:"checkout", feeBearer:"customer" }, storefront: { gateway:"stripe" } }, hubtelFeePercent: 250 }, fb)` → `ussd.mode === "direct"`, `storefront.gateway === fb.surfaces.storefront.gateway`, missing surfaces equal fallback's, `hubtelFeePercent === 100`.
  - `sanitizeGatewayConfig(null, fb)` deep-equals `fb`; `sanitizeGatewayConfig("garbage", fb)` deep-equals `fb`.
  - `validateGatewayConfigUpdate(validFull, {hubtelReady:false})` ok; same with `storefront.gateway:"hubtel"` → `{ok:false, error:"Hubtel is not configured"}`; `whatsapp.mode:"checkout"` → `{ok:false, error:"whatsapp must use direct mode"}`; missing `sms` → `{ok:false}`.
- [ ] **Step 2:** `npx vitest run lib/payment-gateway/config.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement `lib/payment-gateway/config.ts` with the signatures above (pure, no Supabase imports).
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat(gateway): per-surface payment config model`.

### Task 2: Cached reader + legacy wrappers

**Files:**
- Create: `lib/payment-gateway/read-config.ts`, `lib/payment-gateway/legacy-direct-charge.ts`
- Modify: `lib/storefront-otp.ts:124-197` (direct-charge section)
- Test: `lib/payment-gateway/read-config.test.ts`

**Interfaces:**
- Consumes: Task 1 (`deriveFromLegacy`, `sanitizeGatewayConfig`, `SurfaceKey`, `SurfaceConfig`, `GatewayConfig`).
- Produces:
  - `legacy-direct-charge.ts`: the existing `readDirectChargeGate` logic moved verbatim (incl. "row absent ⇒ inherit OTP gate" and fail-to-last-known), exposed as `readLegacyStorefrontDirectCharge(): Promise<boolean>` and `readLegacyWalletDirectCharge(): Promise<boolean>`. It imports `isStorefrontOtpRequired` / `isWalletOtpRequired` from `lib/storefront-otp.ts`; `storefront-otp.ts` must not import it back at top level (no cycle).
  - `read-config.ts`: `const GATEWAY_CONFIG_KEY = "payment_gateway_config"`; `function createGatewayConfigReader(deps: { readRow: () => Promise<unknown | null>; readLegacy: () => Promise<{ storefrontDirect: boolean; walletDirect: boolean }>; now?: () => number; ttlMs?: number }): { get(): Promise<GatewayConfig>; invalidate(): void }` — row absent → `deriveFromLegacy(await readLegacy())`; row present → `sanitizeGatewayConfig(row, deriveFromLegacy(await readLegacy()))`; any throw → last-known if cached, else `deriveFromLegacy` with `{false,false}` only if legacy itself also throws; `get()` never rejects.
  - Module singleton: `getGatewayConfig(): Promise<GatewayConfig>`, `getSurfaceConfig(s: SurfaceKey): Promise<SurfaceConfig>`, `invalidateGatewayConfigCache(): void`.
  - Public direct-charge API (new file `lib/payment-gateway/direct-charge.ts`, re-exported from `lib/storefront-otp.ts` so existing imports keep working): `isStorefrontDirectChargeEnabled()` = storefront mode `direct`; `isWalletDirectChargeEnabled()` = `wallet_topup`; new `isDashboardDirectChargeEnabled()` = `dashboard_direct`; new `isSmsDirectChargeEnabled()` = `sms`. `invalidateStorefrontDirectChargeCache()` / `invalidateWalletDirectChargeCache()` keep their names and also call `invalidateGatewayConfigCache()`.

- [ ] **Step 1: Write failing tests** with fake deps:
  - row `null`, legacy `{storefrontDirect:true, walletDirect:true}` → storefront/wallet_topup/dashboard_direct/sms all `direct`.
  - row `{ version:1, surfaces:{ storefront:{gateway:"paystack",mode:"checkout",feeBearer:"merchant"} } }` → storefront `checkout`/`merchant`; other surfaces from legacy.
  - two `get()` within TTL → `readRow` called once; after `invalidate()` → called again; after `now` advances past `ttlMs` → called again.
  - first `get()` returns storefront `direct`, then `readRow` throws → post-TTL `get()` still storefront `direct` (last-known).
  - first-ever `readRow` throws, legacy `{true,false}` → result equals `deriveFromLegacy({true,false})`; `get()` resolves.
- [ ] **Step 2:** `npx vitest run lib/payment-gateway/read-config.test.ts` → FAIL.
- [ ] **Step 3:** Implement; refactor `lib/storefront-otp.ts` as above.
- [ ] **Step 4:** Record baseline on unchanged code first (`npx vitest run app/api/payments app/api/sms lib/storefront-otp`), then after the change: `npx vitest run lib/payment-gateway` → PASS and the baseline suites → identical pass/fail set.
- [ ] **Step 5:** Commit `feat(gateway): config reader; direct-charge gates read through it`.

### Task 3: Admin API + legacy route bridge + per-surface public flags

**Files:**
- Create: `app/api/admin/gateway/route.ts`, `lib/payment-gateway/hubtel-readiness.ts`, `lib/payment-gateway/write-config.ts`
- Modify: `app/api/admin/settings/storefront-direct-charge/route.ts`, `app/api/admin/settings/wallet-direct-charge/route.ts`, `app/api/public/turnstile-status/route.ts`, `app/api/payments/initialize/route.ts:282-292`, `app/api/sms/activate/route.ts:43`, `app/api/sms/units/purchase/route.ts:48`
- Test: `app/api/admin/gateway/route.test.ts`, `lib/payment-gateway/write-config.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `hubtel-readiness.ts`: `function isHubtelCollectionReady(): boolean` → `false` (the one line Plan 4 changes; comment says so) and `function hubtelReadinessReport(): { ready: boolean; missing: string[] }` listing missing env **names** among `HUBTEL_RELAY_URL`, `HUBTEL_RELAY_SECRET`, `HUBTEL_COLLECTION_ACCOUNT`, plus `"collections not enabled yet"` while not ready. Never values.
  - `write-config.ts`: `function saveGatewayConfig(db: SupabaseClient, config: GatewayConfig, actor: string): Promise<void>` (upsert `admin_settings` `{key: GATEWAY_CONFIG_KEY, value: config, description, updated_at}`, then `invalidateGatewayConfigCache()`); `function setSurfaceModes(db, surfaces: SurfaceKey[], mode: PaymentMode, actor: string): Promise<GatewayConfig>` (current via `getGatewayConfig()`, set modes — skip direct-only surfaces — save, return).
  - `GET /api/admin/gateway` → `{ success: true, config: GatewayConfig, hubtel: { ready, missing } }`.
  - `PUT /api/admin/gateway` body `{ config }` → `validateGatewayConfigUpdate(config, { hubtelReady: isHubtelCollectionReady() })`; 400 `{ error }` on failure; 200 `{ success: true, config }`; `console.warn` names the actor and changed surfaces.
  - Legacy POSTs keep request/response shape, write via `setSurfaceModes`: storefront route → `["storefront"]`; wallet route → `["wallet_topup","dashboard_direct","sms"]`. Legacy GETs read `getGatewayConfig()` (`storefront` / `wallet_topup`).
  - Public endpoint adds `dashboard_direct_charge` and `sms_direct_charge` booleans; existing fields unchanged.
  - Call sites: `payments/initialize` — `surfaceDirectOn` for `isUpgrade` uses `isDashboardDirectChargeEnabled()`, for `isTopup` `isWalletDirectChargeEnabled()`; the per-user rate cap condition becomes `(walletGateOn || walletDirectOn || dashboardDirectOn)`. Both SMS routes use `isSmsDirectChargeEnabled()`.

- [ ] **Step 1: Write failing tests:**
  - `write-config.test.ts`: `setSurfaceModes(fakeDb, ["wallet_topup","dashboard_direct","sms"], "direct", "a@x")` → upserted value has those three `direct`, storefront unchanged; next `getGatewayConfig()` re-reads (cache invalidated).
  - `route.test.ts` (mock `verifyAdminAccess` as in `app/api/admin/settings/customer-verification/route.test.ts`): non-admin → the mocked error response is returned; PUT `storefront.gateway:"hubtel"` → 400 `"Hubtel is not configured"`; PUT `ussd.mode:"checkout"` → 400 `"ussd must use direct mode"`; valid PUT → 200 and upsert called with key `payment_gateway_config`; GET → `hubtel.ready === false`, and with `HUBTEL_RELAY_SECRET="s3cret"` set the JSON body does not contain `"s3cret"`.
- [ ] **Step 2:** Run both → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Tests PASS; `npx tsc --noEmit` → no new errors.
- [ ] **Step 5:** Commit `feat(gateway): admin API, legacy toggle bridge, per-surface direct flags`.

### Task 4: Client readers use their own surface flag

**Files:**
- Modify: `app/dashboard/upgrade/page.tsx:84-85` (read `dashboard_direct_charge`), `app/dashboard/sms/_components/MomoDialog.tsx:21-22` (read `sms_direct_charge`)

**Interfaces:**
- Consumes: Task 3 public fields. The `r.ok ? … : {…}` fallback objects default the new field to `false`, matching today.

- [ ] **Step 1:** Change the two readers (wallet top-up and storefront readers keep their existing fields).
- [ ] **Step 2:** `npx tsc --noEmit` clean; `npx vitest run app/dashboard/sms` → pass.
- [ ] **Step 3:** Commit `feat(gateway): upgrade + SMS pages read their own direct-charge flag`.

### Task 5: `/admin/gateway` page + move settings off `/admin/settings`

**Files:**
- Create: `app/admin/gateway/page.tsx`, `app/admin/gateway/_components/SurfacesCard.tsx`, `GatewayFeesCard.tsx`, `VerificationCard.tsx`, `PayoutsCard.tsx`, `app/admin/gateway/_lib/fee-fields.ts`, `app/admin/settings/_lib/save-payload.ts`
- Modify: `app/admin/settings/page.tsx` (remove: fee card ~L1591–1730 and its preview, storefront/wallet OTP cards, both direct-charge cards, reset-verifications + verified count, with their state/handlers/loaders; build the bulk save body via `save-payload.ts`), `lib/nav-new.ts` (add `"/admin/gateway": { since: "2026-11-04" }`), `components/layout/sidebar.tsx` (admin link after `/admin/settings`, `<NewTag>` + `markClicked()` per the `/admin/sms` pattern)
- Test: `app/admin/gateway/_lib/fee-fields.test.ts`, `app/admin/settings/_lib/save-payload.test.ts`

**Interfaces:**
- Consumes: `GET/PUT /api/admin/gateway` (Task 3); existing `PUT /api/admin/settings` (it updates only keys present in the body — send only the keys a card owns); existing `storefront-otp`, `wallet-otp` routes and the phone-verification reset/count endpoints the Settings page uses today (moved UI calls them unchanged).
- Produces:
  - `fee-fields.ts`: `const GATEWAY_PAGE_SETTINGS_KEYS = ["paystack_fee_percentage","wallet_topup_fee_percentage","withdrawal_fee_percentage","withdrawal_fee_minimum","minimum_withdrawal_amount"] as const`; `function pickGatewaySettings(form: Record<string, unknown>): Partial<Record<(typeof GATEWAY_PAGE_SETTINGS_KEYS)[number], number>>` (only those keys, finite numbers only).
  - `save-payload.ts`: `function buildSettingsSavePayload(state: SettingsFormState): Record<string, unknown>` — the object the Settings page PUTs today, minus every `GATEWAY_PAGE_SETTINGS_KEYS` key.

Page layout (`lg:` two columns, single column on mobile):
1. **Surfaces** — 6 rows: Gateway select (Hubtel disabled, tooltip lists `hubtel.missing`), Mode select (`checkout` disabled on ussd/whatsapp), Fee bearer select (helper text: "applies once Hubtel ships"); Wallet top-up row also has "Extra fee %" (`wallet_topup_fee_percentage`). Save → `PUT /api/admin/gateway`, plus `PUT /api/admin/settings` with `{ wallet_topup_fee_percentage }` only.
2. **Gateway fees & status** — Paystack fee % (`paystack_fee_percentage`), Hubtel fee % (`config.hubtelFeePercent`, via gateway PUT), Hubtel status badge, the moved fee-preview box.
3. **Payment verification** — moved as-is.
4. **Payouts** — moved as-is (withdrawal fee %, fee minimum, minimum withdrawal).

- [ ] **Step 1: Write failing tests:** `pickGatewaySettings({ paystack_fee_percentage: 3, signups_enabled: true, minimum_withdrawal_amount: 5, withdrawal_fee_minimum: "x" })` → exactly `{ paystack_fee_percentage: 3, minimum_withdrawal_amount: 5 }`; `buildSettingsSavePayload(sampleState)` has none of `GATEWAY_PAGE_SETTINGS_KEYS` and still has `signups_enabled`, `ordering_enabled`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Build the page and cards; strip the moved cards/state/payload keys from Settings; add nav entry + sidebar link.
- [ ] **Step 4:** Tests PASS; `npx tsc --noEmit` clean; headless screenshots of `/admin/gateway` at 500px and 1280px show all four sections, and `/admin/settings` no longer shows the moved cards.
- [ ] **Step 5:** Commit `feat(gateway): /admin/gateway page; payment settings moved off /admin/settings`.

### Task 6: Verification gate

- [ ] **Step 1:** `npm run test:run` → only the 9 known order-health failures.
- [ ] **Step 2:** Placeholder-env `next build` → succeeds.
- [ ] **Step 3:** Fresh reviewer on the whole branch (money-path settings + gate change); fix findings with a failing test first.
- [ ] **Step 4:** Before deploy record `GET /api/public/turnstile-status`; after deploy the same `direct_charge` / `wallet_direct_charge` values come back, and saving `/admin/settings` leaves the fee values on `/admin/gateway` unchanged.
