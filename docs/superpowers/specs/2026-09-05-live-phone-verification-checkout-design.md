# Live Phone-Number Verification at Checkout — Design

## Goal

Give customers a live, informational preview — right at checkout, before payment — of whether their MTN number is verified by any of our provider network's number-verification checks. If not verified, let them proceed anyway with a clear, accurate warning, rather than discovering a delay only after paying.

## Context

- This codebase already has a multi-provider whitelist system: `lib/mtn-providers/provider-whitelist.ts`'s `WHITELIST_REGISTRY` — an array of `{name, configured(), check(msisdn), checkBatch(msisdns)}` entries for the 4 providers currently capable of number verification: Xpress, CodeCraft, AgentPortalGH, Apex Prime. `checkWhitelistForOrder()` already implements "try all configured providers, allowed if any says yes" — the exact combination semantics this feature needs, just currently only invoked internally, silently, during actual fulfillment (`lib/mtn-fulfillment.ts:createMTNOrder()`).
- That internal fulfillment-time gate already holds an order (`WHITELIST_BLOCKED` status) when no configured provider approves the number, and the existing 24h/72h retry cron (`app/api/cron/mtn-whitelist-retry`) automatically re-checks and releases it once any provider approves — this machinery is not being duplicated by this feature; see "Proceed anyway" semantics below.
- Session-fresh finding (2026-09-05): Apex Prime's own `/verify-number` endpoint is a real, live check against MTN's own approval status, not a rubber stamp — confirmed via their "MTN Pre-Check & Approval Note": first-time MTN numbers must clear MTN's own approval before receiving data; a not-yet-approved number is `awaiting_mtn_approval`, not a hard rejection, and clears over time.
- Existing phone-format validation (`lib/phone-validation.ts`'s `validatePhoneNumber()`) already runs client-side at each of the 4 checkout surfaces below, checking digit count and network-prefix match — this is a separate, existing, unrelated check (format only, no live provider call) and is not modified by this feature.
- Resolved via Q&A this session:
  - Covers 4 surfaces: shop storefronts, the dashboard's individual-purchase flow, the dashboard's bulk-paste flow, and the dealer API — each with different UX given their different shapes (single order vs. batch vs. no UI at all).
  - The check fires once, on the final submit/pay click — not live-as-you-type.
  - Web surfaces block briefly on the check result (spinner, then either proceed straight through or show a warning); the check fails open (treated as verified) on any error or timeout, consistent with every other whitelist-related check in this codebase.
  - This is a **new, independent** admin-configurable toggle and provider subset — deliberately separate from the internal fulfillment-time gate's own settings. The two can therefore disagree occasionally (this check says "unverified" but the internal gate's own provider set approves it anyway at fulfillment time, or vice versa) — accepted as a known trade-off in exchange for independent control.
  - MTN only for now — Telecel/AT-iShare are out of scope until each provider's check is separately confirmed to behave correctly for those networks.
  - This check is stateless and live only — no new database table, no new retry cron. The "you'll receive it automatically once verified" promise made to the customer is backed entirely by the *existing* internal fulfillment gate + 24h retry cron, which already runs on every order regardless of what this preview said.

## Design

### 1. Shared backend check

New function in `lib/mtn-providers/provider-whitelist.ts`:

```ts
export interface CustomerVerificationSettings {
  enabled: boolean
  providers: string[]
}

export async function getCustomerVerificationSettings(): Promise<CustomerVerificationSettings> {
  // reads admin_settings key "customer_verification_settings", defaults
  // to { enabled: false, providers: [] } on any error or missing row (fail closed
  // on the FEATURE itself — if we can't read the setting, don't run an unconfigured
  // check; this is distinct from fail-open on the check's own network calls below)
}

export async function checkCustomerFacingVerification(
  phones: string[]
): Promise<Array<{ phone: string; verified: boolean }>> {
  const settings = await getCustomerVerificationSettings()
  if (!settings.enabled || settings.providers.length === 0) {
    return phones.map(phone => ({ phone, verified: true })) // feature off = always "verified" = no warning ever shown
  }
  const configured = WHITELIST_REGISTRY.filter(
    p => settings.providers.includes(p.name) && p.configured()
  )
  if (configured.length === 0) {
    return phones.map(phone => ({ phone, verified: true })) // fail open — nothing usable configured
  }
  // For each phone: try each configured provider in registry order, verified=true
  // on first approval. Any provider call that throws is treated as "no" from that
  // provider only (not a whole-check failure) — matches checkWhitelistForOrder's
  // existing per-provider try/catch pattern.
}
```

This reuses `WHITELIST_REGISTRY` and its providers' existing `check()`/`checkBatch()` functions verbatim — no new provider integration code. `checkCustomerFacingVerification` always takes an array (even a single phone is `[phone]`) so the exact same function serves both single-order and bulk surfaces.

### 2. New public API route — `app/api/verify-phone-live/route.ts`

```
POST /api/verify-phone-live
Body: { phones: string[] }  (1 for shop/individual-dashboard, many for bulk-paste)
Response: { results: Array<{ phone: string; verified: boolean }> }
```

No admin auth (public — shop storefronts are unauthenticated). Rate-limited by IP using this codebase's existing rate-limiting helper (`lib/rate-limiter.ts`, same pattern as other public endpoints) — a phone-verification call that fans out to paid third-party APIs on a public surface needs abuse protection, but full Turnstile-per-check would add checkout friction disproportionate to the risk; IP rate-limiting is the existing lighter-weight tool this codebase already reaches for on similar public endpoints. Caps the `phones` array length (e.g. 100) to bound worst-case cost per call.

### 3. Admin settings — new route + UI card

New route `app/api/admin/settings/customer-verification/route.ts` (GET returns current `CustomerVerificationSettings` + the list of available providers via the existing `listWhitelistProviders()`; POST validates the submitted provider subset via the existing `validateProviderSelection()` helper before saving — both already exported and tested, reused as-is).

New card on `/admin/settings/mtn` (Overview tab): a single on/off `Switch` plus one checkbox per entry from `listWhitelistProviders()` (labeled the same as the existing `PROVIDER_LABELS` map), enabled/checked state driven by the new settings.

### 4. Shop storefront — `app/shop/[slug]/page.tsx`, `handleSubmitOrder`

After the existing phone normalization (`phoneResult.normalized`, current line ~362) and before the `POST /api/shop/orders/create` call (current line ~389): call `/api/verify-phone-live` with `{ phones: [normalizedPhone] }`. If `verified: true` (including on a fetch error/timeout — wrap in try/catch, default to verified), proceed exactly as today, unchanged. If `verified: false`, show a confirmation dialog:

> "This number hasn't been verified yet. If you proceed, your order will still be processed, but delivery may be delayed until it clears — you'll receive it automatically once verified."

with two buttons: **Proceed anyway** (continues into the existing order-creation flow unchanged) and **Change number** (closes the dialog, returns focus to the phone field, no order created).

### 5. Dashboard individual purchase — `app/dashboard/data-packages/page.tsx`, `handlePhoneNumberSubmit`

Identical pattern to §4: insert the live-check call right after the existing `validatePhoneNumber()` call (current line ~264) and before `POST /api/orders/purchase` (current line ~285). Same warning copy, same two-button choice.

### 6. Dashboard bulk-paste form — `components/bulk-orders-form.tsx`, `handleConfirmSubmission`

Inside `handleConfirmSubmission` (current line ~457), before the `POST /api/orders/create-bulk` call (current line ~476): call `/api/verify-phone-live` with every normalized phone from `validationResults.orders[]` in one batched request. If every phone comes back verified, submit exactly as today, unchanged. If one or more are unverified, show a dialog listing the specific unverified numbers (masked to last 4 digits is unnecessary here — these are the admin's own submitted numbers, already visible to them in the form) with three choices:

- **Proceed with all** — submits the full batch unchanged, same as today.
- **Remove unverified & submit rest** — filters `validationResults.orders[]` down to only the verified ones before calling `/api/orders/create-bulk`; if this leaves zero orders, disable this option instead of submitting an empty batch.
- **Cancel** — closes the dialog, returns to the form, no submission.

### 7. Dealer API — `app/api/v1/orders/route.ts`

Server-side call to `checkCustomerFacingVerification([phone])` directly (no HTTP round-trip needed, same process) alongside existing order-creation logic. The order is created/queued exactly as it is today regardless of the result — this check never blocks or alters dealer API order creation. The success response gains one additional field:

```json
{ "success": true, "order_id": "...", "verification_warning": false }
```

`verification_warning: true` when the number wasn't verified by any configured provider — the dealer's own integration decides whether/how to surface this to their end customer.

### 8. Error handling

- Backend check function: any individual provider's `check()`/`checkBatch()` throwing is caught per-provider (matches `checkWhitelistForOrder`'s existing pattern) — one provider erroring doesn't fail the whole check, it just doesn't count as an approval from that provider.
- Public API route: any unexpected error returns `{ results: phones.map(phone => ({ phone, verified: true })) }` (HTTP 200, fail open) rather than a 5xx — a broken verification endpoint must never block checkout.
- Frontend call sites: wrap the `fetch` itself in try/catch; on any network failure or non-2xx response, treat as if every phone came back verified (no warning shown, proceed normally) — the feature degrades to invisible, never to blocking.
- Admin settings read (`getCustomerVerificationSettings`): fails to `{enabled: false, providers: []}` — an unreadable/misconfigured setting means the feature is off, not that it blocks checkout.

### 9. Testing

- Pure unit tests for `checkCustomerFacingVerification()` and `getCustomerVerificationSettings()` using fake `WhitelistEntry` fixtures (same pattern already established in `provider-whitelist.test.ts`) — covering: feature disabled → all verified; no configured providers → all verified; mixed batch (some phones approved, some not) → correct per-phone results; a provider's check throwing → doesn't crash the batch, that provider just doesn't count.
- `/api/verify-phone-live` route: integration-style test asserting fail-open behavior (mock the settings/registry to throw, assert HTTP 200 with all `verified: true`) and the `phones` array length cap.
- `/api/admin/settings/customer-verification`: test that POST rejects an unknown or unconfigured provider name via the existing `validateProviderSelection` contract (already covered generically by that function's own tests — this route's test just needs to confirm it's actually wired to call it).
- Frontend integration for the 3 call sites is verified manually (per this codebase's established practice for UI flows) rather than with new component tests, matching how the existing phone-format validation at these same call sites is handled today.

## Out of scope

- Telecel/AT-iShare — MTN only for this feature; extending later requires confirming each of the 4 providers' checks actually behave correctly for non-MTN networks first.
- Any new persistence, retry cron, or tracking table for "proceed anyway" orders — the existing internal fulfillment-time whitelist gate and its 24h/72h retry cron already provide the actual hold-and-auto-deliver behavior; this feature is a stateless preview only.
- Changing the *internal* fulfillment-time whitelist gate's own settings or provider set in any way — it remains fully independent, per the explicit decision to accept the (rare) inconsistency this creates.
- Live-as-you-type checking (debounced on blur) — the check fires once, on final submit, at all 4 surfaces.
