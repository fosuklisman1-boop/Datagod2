# SMS Provider Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-SMS-category provider selectors (Moolre / Hubtel / Global) in SMS Centre → Providers, plus a per-send provider picker on broadcast, admin SMS and customer bulk compose screens.

**Architecture:** A pure `categoryOf(type)` map plus a `categoryProviders` setting (admin_settings JSON) read via `getRoutingConfig()`. `sendSMS` leads with `payload.provider` ?? the category's provider. Bulk paths persist the chosen provider on `sms_send_logs.provider_override` so queue retries (`send-drain`, held, scheduled) honour it; broadcast persists it on `broadcast_logs.sms_provider`.

**Tech Stack:** Next.js 15 route handlers, Supabase (service role), Vitest, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-12-sms-provider-control-design.md`

## Global Constraints

- Providers offered in selectors: exactly `moolre`, `hubtel`, plus the value `global` (= old behaviour: `[primary, ...fallbacks]`).
- OTP: the selector may lead, but an open OTP breaker still forces the fallback provider first. OTP call sites never pass `payload.provider`.
- Custom sender-ID narrowing (`narrowProvidersForSender`) runs AFTER the lead is chosen and is never bypassed.
- Hubtel solvency/out-of-funds gates and the Hubtel "unknown outcome → no double-send" rule are unchanged.
- Settings read failure fails open to current behaviour (`global`).
- New DB columns are nullable and written ONLY when a provider is set (ordinary sends work before the migration is applied).
- Category defaults (verbatim): otp=global, order_confirmation_platform=moolre, order_confirmation_own_sender=hubtel, payments_wallet=moolre, admin_action_outcomes=moolre, security_alerts=global, system=moolre, admin_broadcast=global, customer_bulk=global.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Run `npm run test:run` baseline: only the 9 known failures in `lib/order-health-service.test.ts`.

## Review Focus

- Unknown/new message type → falls into `system` (never throws, never unrouted).
- OTP with open breaker + selector=hubtel → still leads with the fallback.
- Provider chosen but unconfigured (no Hubtel creds) → skipped, fallback proceeds, no crash.
- Custom sender not approved on chosen provider → narrowing still applies.
- Queue retry after first attempt failed → same provider as the original pick (not the global primary).
- Tenant sends `provider` while tenant choice is disabled → ignored (category applies), not an error that leaks the setting.

---

### Task 1: Categories + routing config + settings API

**Files:**
- Create: `lib/sms/categories.ts`, `lib/sms/categories.test.ts`
- Modify: `lib/sms/routing.ts` (RoutingConfig, parse, getRoutingConfig keys, setRoutingConfig), `app/api/admin/sms-settings/route.ts`
- Test: `lib/sms/routing.test.ts` (extend if it exists, else create)

**Interfaces:**
- Produces: `SmsCategory` union; `SMS_CATEGORIES: readonly SmsCategory[]`; `CATEGORY_DEFAULTS: Record<SmsCategory, "global"|"moolre"|"hubtel">`; `categoryOf(type: string): SmsCategory`; `RoutingConfig.categoryProviders: Record<SmsCategory, "global"|"moolre"|"hubtel">`; `RoutingConfig.tenantProviderChoice: boolean`; `setRoutingConfig` patch gains `categoryProviders?: Partial<Record<SmsCategory, string>>` and `tenantProviderChoice?: boolean`.

- [ ] **Step 1: Failing tests** (`lib/sms/categories.test.ts`)

```ts
import { describe, it, expect } from "vitest"
import { categoryOf, CATEGORY_DEFAULTS, SMS_CATEGORIES } from "./categories"

describe("categoryOf", () => {
  it.each([
    ["phone_otp", "otp"], ["otp_required", "otp"], ["password_reset_link", "otp"],
    ["order_confirmed", "order_confirmation_platform"], ["order_payment_confirmed", "order_confirmation_platform"],
    ["wallet_topup_success", "payments_wallet"], ["data_purchase_success", "payments_wallet"], ["airtime_completed", "payments_wallet"],
    ["withdrawal_approved", "admin_action_outcomes"], ["shop_rejected", "admin_action_outcomes"], ["complaint_resolved", "admin_action_outcomes"],
    ["security_alert", "security_alerts"], ["password_changed", "security_alerts"],
    ["broadcast", "admin_broadcast"], ["shop_sms", "customer_bulk"],
    ["totally_new_type", "system"], ["", "system"],
  ])("%s -> %s", (t, c) => expect(categoryOf(t)).toBe(c))
  it("defaults cover every category", () => {
    for (const c of SMS_CATEGORIES) expect(["global", "moolre", "hubtel"]).toContain(CATEGORY_DEFAULTS[c])
  })
})
```

Routing tests: `parseRoutingConfig([])` → `categoryProviders` equals `CATEGORY_DEFAULTS`; a row `{key:"sms_category_providers", value:{otp:"hubtel", bogus:"moolre", system:"mnotify"}}` → otp=hubtel, `bogus` dropped, system stays default (invalid provider rejected); `sms_tenant_provider_choice_enabled` true/"true" → true, missing → false.

- [ ] **Step 2:** Run `npx vitest run lib/sms/categories.test.ts lib/sms/routing.test.ts` → FAIL.
- [ ] **Step 3: Implement** `categories.ts`: explicit `Set`s per category plus prefix rules (`airtime_` → payments_wallet; `withdrawal_|shop_|afa_|results_check_|sender_id_|complaint_` with suffix `approved|rejected|completed|resolved` → admin_action_outcomes; plain `shop_sms` → customer_bulk, so check `shop_sms` before the `shop_` prefix). Fallthrough returns `"system"`. In `routing.ts` extend `RoutingConfig`, `parseRoutingConfig` (read keys `sms_category_providers`, `sms_tenant_provider_choice_enabled`), add both keys to the `.in("key", [...])` list, extend `setRoutingConfig` (validate each category + value ∈ global|moolre|hubtel; if any value is `hubtel` require `hubtelConfigFromEnv()` else error "Hubtel credentials are not set in Vercel"; writes follow the existing update-then-insert pattern; `tenantProviderChoice` stored as boolean) and allow a patch with only the new fields (the "No routing fields" check must count them).
- [ ] **Step 4:** In `app/api/admin/sms-settings/route.ts` PATCH, accept `categoryProviders` and `tenantProviderChoice` and pass them through; GET already returns the full config.
- [ ] **Step 5:** Run tests → PASS. `npx tsc --noEmit` clean for touched files.
- [ ] **Step 6:** Commit `feat(sms): provider categories + category routing config`.

---

### Task 2: `sendSMS` honours payload.provider and category lead

**Files:**
- Modify: `lib/sms-service.ts` (`SMSPayload`, order building ~lines 876-900)
- Test: `lib/sms-service.order.test.ts` (new; mock `getRoutingConfig`, `isOtpBreakerOpen` via supabase mock, env keys)

**Interfaces:**
- Consumes: `categoryOf`, `RoutingConfig.categoryProviders` (Task 1).
- Produces: `SMSPayload.provider?: "moolre" | "hubtel"`. Extract a pure exported `buildProviderOrder({ payload, routing, isOtp, breakerOpen, fallbackProvider, otpEnvProvider })` returning `string[]` (pre-filter, pre-narrowing) so it is unit-testable without network.

- [ ] **Step 1: Failing tests** against `buildProviderOrder`:
  - routing primary=hubtel, fallbacks=[moolre], category selector global → `["hubtel","moolre"]` (unchanged).
  - type `wallet_topup_success`, `payments_wallet=moolre` → `["moolre","hubtel"...]` (lead moolre, then remaining `[primary, ...fallbacks]` de-duped).
  - `payload.provider="hubtel"` with type `wallet_topup_success` → leads hubtel.
  - OTP, selector=hubtel, breaker closed → leads hubtel; breaker open → leads `fallbackProvider` (selector ignored).
  - OTP, selector=global, `SMS_OTP_PROVIDER=moolre` → leads moolre (today's behaviour).
  - unknown type → follows `system` selector.
- [ ] **Step 2:** Run → FAIL. **Step 3: Implement.** Order rules (spec §Mechanism): `lead = payload.provider ?? (isOtp ? (breakerOpen ? fallbackProvider : sel !== "global" ? sel : (otpEnv || primary)) : sel !== "global" ? sel : undefined)`; `base = isOtp ? [fallbackProvider, primary, ...fallbacks] : [primary, ...fallbacks]`; `order = lead ? [lead, ...base] : (isOtp ? [... today's otp order] : base)`; keep the existing de-dupe + configured filter + sender narrowing + try-each loop. Replace the inline block in `sendSMS` by a call to `buildProviderOrder`. For OTP types with `payload.provider` set, ignore it (log a warning) — OTP never takes a forced provider.
- [ ] **Step 4:** Run the new tests and existing `lib/sms*` tests → PASS. **Step 5:** Commit `feat(sms): category/provider-aware provider order in sendSMS`.

---

### Task 3: Migration + bulk dispatch honours provider (send-service, drain, held, scheduled)

**Files:**
- Create: `migrations/20261020_sms_provider_control.sql`
- Modify: `lib/sms/campaign-dispatch.ts` (new trailing param), `lib/sms/send-service.ts` (`EnqueueSendOptions.provider`, insert `provider_override`, pass to dispatch), `lib/sms/dispatch-claimed.ts` (+ param), `lib/sms/held-service.ts`, `lib/sms/scheduled-service.ts`, `lib/sms/send-drain.ts`
- Test: `lib/sms/campaign-dispatch.test.ts`, `lib/sms/dispatch-claimed.test.ts`, `lib/sms/send-drain` test (extend existing patterns)

**Interfaces:**
- Consumes: `RoutingConfig.categoryProviders.customer_bulk`.
- Produces: `dispatchCampaign(items, senderId, onChunkSent?, deadline?, provider?: "moolre"|"hubtel")`; `dispatchClaimed(db, logId, items, senderId, claimedAtMs, provider?)`; `EnqueueSendOptions.provider?: "moolre"|"hubtel"`; column `sms_send_logs.provider_override text null`.

- [ ] **Step 1: Migration** (`ALTER TABLE sms_send_logs ADD COLUMN IF NOT EXISTS provider_override text CHECK (provider_override IN ('moolre','hubtel')); ALTER TABLE broadcast_logs ADD COLUMN IF NOT EXISTS sms_provider text CHECK (sms_provider IN ('moolre','hubtel','global'));`). Do not apply to prod in this task.
- [ ] **Step 2: Failing tests:** `dispatchCampaign` with `provider="moolre"` while routing.primary=hubtel → Moolre chunks used; `provider="hubtel"` while primary=moolre and Hubtel configured → Hubtel batch; `provider="hubtel"` with Hubtel unconfigured → Moolre (existing fallback); `provider` undefined → unchanged. `dispatchClaimed` passes provider through. Drain: a claimed row whose log has `provider_override="hubtel"` calls `sendSMS({..., provider:"hubtel"})`.
- [ ] **Step 3: Implement.** In `dispatchCampaign` replace `routing.primary !== "hubtel"` with `(provider ?? effectivePrimary) !== "hubtel"` where `effectivePrimary` = `routing.categoryProviders.customer_bulk` if not `global`, else `routing.primary`. In `enqueueSend` write `provider_override` into `extraLogCols` only when `opts.provider` is set, and pass `opts.provider ?? undefined` to `dispatchCampaign`. In held/scheduled services add `provider_override` to the log `select` and pass it into `dispatchClaimed`. In `send-drain.ts` fetch `provider_override` for the touched logs (single `.in("id", logIds)` query; chunk if >200) and pass `provider: map.get(row.send_log_id) ?? undefined` to `sendSMS` (type stays `shop_sms`).
- [ ] **Step 4:** Tests PASS; `npx vitest run lib/sms` PASS. **Step 5:** Commit `feat(sms): persist and honour per-send provider on bulk sends`.

---

### Task 4: Order confirmations (own sender vs platform)

**Files:**
- Modify: `lib/sms/order-confirmation.ts` (`sendBilledConfirmation` passes `provider`), `app/api/fulfillment/process-order/route.ts` (resolve category for own-sender branch)
- Test: `lib/sms/order-confirmation.billing.test.ts` (extend)

**Interfaces:**
- Consumes: `getRoutingConfig().categoryProviders.order_confirmation_own_sender`, `EnqueueSendOptions.provider` (Task 3).
- Produces: `BilledConfirmationInput.provider?: "moolre"|"hubtel"`.

- [ ] **Step 1: Failing test:** `sendBilledConfirmation({..., provider:"hubtel"})` calls the injected `enqueue` with `opts = { source:"order_confirmation", provider:"hubtel" }`; without provider → opts has no `provider` key.
- [ ] **Step 2:** FAIL → implement: build opts as `{ source: "order_confirmation", ...(input.provider ? { provider: input.provider } : {}) }`.
- [ ] **Step 3:** In `process-order/route.ts` before `sendBilledConfirmation`, compute `const sel = (await getRoutingConfig()).categoryProviders.order_confirmation_own_sender; const provider = sel === "global" ? undefined : sel` (wrapped in try/catch → undefined) and pass it. The free path is unchanged: its `type: "order_confirmed"` already maps to `order_confirmation_platform`.
- [ ] **Step 4:** Tests PASS. Commit `feat(sms): route own-sender order confirmations by category`.

---

### Task 5: Admin broadcast provider (API + drain + retry + UI)

**Files:**
- Modify: `app/api/admin/broadcast/route.ts` (init validation + insert), `lib/broadcast-drain.ts` (pass provider to `sendSMS`, select `sms_provider`), `app/api/admin/broadcast/retry/route.ts` (reuse stored), `app/admin/broadcast/page.tsx` (picker)
- Create: `components/sms/ProviderSelect.tsx` (shared), test `components/sms/ProviderSelect.test.tsx` only if the repo already tests components; otherwise skip.
- Test: `lib/broadcast-drain.test.ts` (extend or create)

**Interfaces:**
- Produces: `<ProviderSelect value onChange allowDefaultLabel? />` with options `""` (label from prop, default "System default"), `moolre`, `hubtel`; broadcast `init` body field `smsProvider?: "moolre"|"hubtel"|"global"`.

- [ ] **Step 1: Failing tests:** drain calls `sendSMS` with `provider: "hubtel"` when `broadcast.sms_provider="hubtel"`, with no `provider` for `global`/null (so the `admin_broadcast` category applies via the type `broadcast`); init rejects `smsProvider:"mnotify"` with 400.
- [ ] **Step 2:** Implement validation (`["moolre","hubtel","global"]`), store `sms_provider` on the `broadcast_logs` insert ONLY when provided; add `sms_provider` to the drain's broadcast select; pass `...(bc.sms_provider && bc.sms_provider !== "global" ? { provider: bc.sms_provider } : {})`.
- [ ] **Step 3:** UI: render `ProviderSelect` under the SMS channel checkbox (only when sms channel selected), include `smsProvider` in the init body.
- [ ] **Step 4:** Tests + `npx tsc --noEmit` PASS. Commit `feat(broadcast): per-send SMS provider picker`.

---

### Task 6: Customer bulk + admin SMS Messages send routes and compose UI

**Files:**
- Modify: `app/api/v1/sms/send/route.ts`, `app/api/shop/sms/send/route.ts`, the dashboard SMS compose route (find via `grep -rn "enqueueSendBatched" app`), `lib/sms/send-service.ts` (`EnqueueSendOptions.provider` plumbing through `enqueueSendBatched`/enforced paths), admin SMS Messages compose (`app/admin/sms/_components/MessagesTab.tsx` and its send route), dashboard compose component under `app/dashboard/sms/_components/compose/`
- Create: `lib/sms/provider-pick.ts` + test: `resolveSendProvider({ requested, isAdmin, tenantChoiceEnabled })` → `"moolre"|"hubtel"|undefined`

**Interfaces:**
- Consumes: `RoutingConfig.tenantProviderChoice`, `EnqueueSendOptions.provider`.
- Produces: pure `resolveSendProvider`: invalid value → undefined; admin → requested if valid; non-admin → requested only when `tenantChoiceEnabled`, else undefined (silently ignored).

- [ ] **Step 1: Failing tests** for `resolveSendProvider` (all four branches + `"global"`/`""`/garbage → undefined).
- [ ] **Step 2:** Implement; each tenant route reads `getRoutingConfig()` and passes `provider: resolveSendProvider(...)` into `enqueueSendBatched` options (ensure the enforced/batched wrappers forward `opts.provider` to `enqueueSend`). Admin Messages route passes `isAdmin: true`.
- [ ] **Step 3:** UI: admin Messages compose always shows `ProviderSelect`; dashboard compose shows it only when a new `GET /api/sms/config`-style field `providerChoice` is true (extend whichever existing endpoint the compose page already calls for settings; if none, add `providerChoice` to the existing policy-preview/compose-config response).
- [ ] **Step 4:** Tests PASS. Commit `feat(sms): per-send provider on admin and customer bulk sends`.

---

### Task 7: SMS Centre → Providers "Provider routing by SMS type" card + docs

**Files:**
- Modify: `app/admin/sms-centre/_components/ProvidersTab.tsx`
- Create: `docs/superpowers/runbooks/sms-provider-control.md`
- Modify: memory note is updated by the controller at finish, not by the implementer.

**Interfaces:**
- Consumes: `/api/admin/sms-settings` GET/PATCH with `categoryProviders`, `tenantProviderChoice`; `SMS_CATEGORIES` labels (export a `CATEGORY_LABELS: Record<SmsCategory,string>` from `categories.ts`).

- [ ] **Step 1:** Extend the `Routing` type with `categoryProviders` and `tenantProviderChoice`; add a Card listing one row per category: label, `Select` (Global / Moolre / Hubtel), and for Global a muted "→ {primary}" hint; a Checkbox "Let customers choose the provider when sending bulk SMS"; a Save button calling PATCH; toast on result; surface the API error text (Hubtel credentials missing) verbatim.
- [ ] **Step 2:** Runbook: category table, how to change, deploy checklist (apply migration `20261020_sms_provider_control.sql`; after deploy watch Moolre balance and `sms_logs.provider` by `message_type` for 1h), rollback (set all categories to Global).
- [ ] **Step 3:** Visual check: run `npm run build` equivalent per memory rule (placeholder-env `next build`), fix route-export violations if any.
- [ ] **Step 4:** Commit `feat(admin): provider routing by SMS type card + runbook`.

---

## Self-review

- Spec coverage: categories/settings (T1), sendSMS lead + OTP breaker (T2), bulk persistence/retries (T3), confirmations by sender (T4), broadcast picker (T5), admin + customer bulk pickers with tenant gate (T6), Providers-page card + runbook + migration note (T7).
- Types consistent: `SmsCategory`, `categoryProviders`, `provider?: "moolre"|"hubtel"`, `provider_override`, `sms_provider` used identically across tasks.
- No placeholders; the one discovery step (T6 dashboard compose config endpoint) names the grep and the fallback.
