# Apex Prime AFA Registration — Design

## Goal

Add Apex Prime as a second, admin-selectable AFA (MTN AFA 4.0) registration provider alongside the existing Sykes-only integration, funded from Apex Prime's Main Wallet, with genuine async status tracking via Apex Prime's own `/status` endpoint — not a guessed webhook payload.

## Context

- **AFA registration today is single-provider, no fallback.** `lib/sykes-afa-provider.ts` is the only provider. Two call sites fulfil orders through it: `lib/afa-fulfillment.ts` (`fulfillAfaOrder`, for the web/shop `afa_orders` table) and `lib/ussd/fulfill-afa.ts` (`fulfillUssdAfaOrder`, for the USSD `ussd_afa_orders` table). Both are invoked from a handful of callers (`app/api/afa/submit/route.ts`, `app/api/admin/afa-fulfillment/route.ts`, `app/api/webhooks/paystack/route.ts`) that only care about the function's `{success, message}` result — none of them touch Sykes directly, so adding a second provider is entirely encapsulated inside these two functions.
- **Sykes is synchronous; Apex Prime is not.** Sykes' `success: true` response is treated as the final outcome — `fulfillAfaOrder` marks the order `completed` immediately. Apex Prime's own sample response for a fresh registration returns `"status": "Waiting"` — the registration is queued for MTN network approval, not done. Copying Sykes' "mark completed on submit" shortcut onto Apex Prime would silently mark orders completed while MTN hasn't actually approved them — the same class of bug just fixed this session for Apex Prime data-bundle refunds (`normalizeApexStatus`, `lib/mtn-providers/apexprime-provider.ts`).
- **Apex Prime AFA API** (`https://apexprime.club/api/v1`, docs pasted verbatim by the user this session):
  - `POST /afa-registration` — `full_name`, `phone_number`, `gha_number` (Ghana Card, e.g. `GHA-727470287-0`), `location` all required; `payment_method` (`slot`/`wallet`/`auto`, default `auto`) and `callback_url` optional. Success response includes `registration_id`, `status: "Waiting"`, `payment_method_used`, `remaining_wallet_balance`.
  - `POST /status` — already used for bundle/store orders (`lib/mtn-providers/apexprime-provider.ts`'s `checkOrderStatus`) — takes `{type: "store"|"bundle"|"afa", order_id}` and is documented to also cover AFA registrations. Response envelope matches the bundle sample: `{success, message, order_id, status, ...}`.
  - No AFA-specific webhook payload was provided (unlike bundle/store's documented `order_status_update` event). Per this project's own history — AgentPortalGH's webhook silently never fired for a period, EazyGhData disabled webhook delivery entirely without notice — a webhook whose payload shape is unverified is not a safe sole confirmation path. **Decision: skip `callback_url` entirely; treat the documented, already-proven `/status` polling contract as the sole source of truth**, via a new per-minute cron mirroring the existing bundle/store sync cron. A webhook can be added later as a fast-path optimization once its real payload is seen, without changing the polling safety net.
  - `normalizeApexStatus(status, message)` (already fixed this session to catch the "completed status but refund in message" case) is reused as-is for AFA status normalization. This assumes Apex Prime's status vocabulary is consistent across bundle/store/AFA — unverified for AFA specifically, but safe: any unrecognized string defaults to `"processing"`, never wrongly to `"completed"`.
- **Payment method: `wallet`, hardcoded.** Per explicit choice, every Apex Prime AFA registration pays from the same Main Wallet balance already used for (and already balance-monitored for) Apex Prime data-bundle fulfillment — `lib/mtn-balance-alert.ts`'s existing balance check needs no changes; AFA wallet spend is automatically visible through the same `checkBalance()`/`/wallet` call. `slot`/`auto` are out of scope — no admin control is added for them.
- **Provider choice is frozen per-order, not looked up live.** `admin_settings.afa_provider_selection` — value shape `{provider: "sykes" | "apexprime"}`, matching the existing `mtn_provider_selection` convention (`lib/mtn-providers/factory.ts`) exactly, default `"sykes"` — is read once at submission time and stored onto the order row (`fulfillment_provider` column, new — mirrors `mtn_fulfillment_tracking.provider`). This is required so that: (a) the sync cron knows which orders are its own to poll without re-deriving the setting, and (b) an admin flipping the setting later never reinterprets an already-in-flight order under the wrong provider's rules.
- **No schema change needed for status values.** `afa_orders.fulfillment_status` and `ussd_afa_orders.fulfillment_status` both already allow `'pending'` (CHECK constraint, confirmed live) — the existing "in-flight, not yet confirmed" value doubles as "submitted to Apex Prime, awaiting MTN approval." Likewise `afa_orders.status` (unconstrained varchar) and `ussd_afa_orders.order_status` (CHECK allows `pending`/`processing`/`completed`/`failed`) already use `"processing"` as the in-flight marker. Only a new `fulfillment_provider` column is needed (confirmed absent from both tables via live schema query).
- **Apex Prime's own `registration_id` is reused as the tracking key** — stored in the existing `fulfillment_ref` column (already used to hold whatever reference a provider returns), no new "external id" column needed.
- **Failure convention matches Sykes exactly**: on a failed registration or a cron-confirmed failure, only `fulfillment_status`/`fulfillment_error`/`updated_at` are touched — `status`/`order_status` is deliberately left at `"processing"` (same as Sykes' existing failure path), so an admin can manually retry via the existing `/api/admin/afa-fulfillment` trigger without any new unblocking step.

## Design

### 1. Migration — `migrations/0098_afa_fulfillment_provider.sql`

Adds one column to both tables, defaulting existing rows to `'sykes'` (the only provider that has ever run):

```sql
ALTER TABLE afa_orders ADD COLUMN IF NOT EXISTS fulfillment_provider VARCHAR(20) NOT NULL DEFAULT 'sykes';
ALTER TABLE ussd_afa_orders ADD COLUMN IF NOT EXISTS fulfillment_provider VARCHAR(20) NOT NULL DEFAULT 'sykes';

ALTER TABLE afa_orders ADD CONSTRAINT afa_orders_fulfillment_provider_check
  CHECK (fulfillment_provider IN ('sykes', 'apexprime'));
ALTER TABLE ussd_afa_orders ADD CONSTRAINT ussd_afa_orders_fulfillment_provider_check
  CHECK (fulfillment_provider IN ('sykes', 'apexprime'));

CREATE INDEX IF NOT EXISTS idx_afa_orders_provider_pending
  ON afa_orders(fulfillment_provider, fulfillment_status) WHERE fulfillment_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_ussd_afa_orders_provider_pending
  ON ussd_afa_orders(fulfillment_provider, fulfillment_status) WHERE fulfillment_status = 'pending';
```

### 2. `lib/mtn-providers/apexprime-provider.ts` — two new auxiliary methods

Not part of the `MTNProvider` interface (AFA is a separate concern from data-bundle fulfillment) — auxiliary methods on the class, alongside `getWalletSummary()`/`verifyNumber()`.

```ts
export interface AfaRegisterPayload {
  fullName: string
  phoneNumber: string
  ghanaCardNumber: string
  location: string
}

export interface AfaRegisterResult {
  success: boolean
  registrationId?: string | number
  message: string
}

// on ApexPrimeProvider:
async registerAfa(payload: AfaRegisterPayload): Promise<AfaRegisterResult> {
  let res: Response
  try {
    res = await apiFetch("/afa-registration", {
      method: "POST",
      body: JSON.stringify({
        full_name: payload.fullName,
        phone_number: normalizePhoneNumber(payload.phoneNumber),
        gha_number: payload.ghanaCardNumber,
        location: payload.location,
        payment_method: "wallet",
      }),
    })
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "Network error" }
  }
  let json: any
  try { json = await res.json() } catch {
    return { success: false, message: `HTTP ${res.status} (non-JSON response)` }
  }
  if (!res.ok || json.success !== true) {
    return { success: false, message: json?.message ?? `API error ${res.status}` }
  }
  if (json.registration_id == null) {
    return { success: false, message: "Apex Prime returned no registration_id" }
  }
  return { success: true, registrationId: json.registration_id, message: json.message ?? "AFA registration initiated" }
}

async checkAfaStatus(registrationId: string | number): Promise<MTNOrderStatusResponse> {
  let res: Response
  try {
    res = await apiFetch("/status", {
      method: "POST",
      body: JSON.stringify({ type: "afa", order_id: registrationId }),
    })
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "Network error" }
  }
  let json: any
  try { json = await res.json() } catch {
    return { success: false, message: `HTTP ${res.status} (non-JSON response)` }
  }
  if (!res.ok || json.success !== true) {
    return { success: false, message: json?.message ?? `API error ${res.status}` }
  }
  return { success: true, status: normalizeApexStatus(json.status, json.message), message: json.message ?? "Status retrieved", order: json }
}
```

### 3. `lib/afa-fulfillment.ts` — provider branch

Add `getAfaProviderSelection()` (reads `admin_settings.afa_provider_selection`, defaults `"sykes"` on missing/malformed value — fail open to existing behavior). In `fulfillAfaOrder`:

- Resolve the provider once, write it onto `fulfillment_provider` in the same "mark as in-flight" update that already sets `fulfillment_status: "pending"` / `status: "processing"`.
- `"sykes"` → existing code path, unchanged.
- `"apexprime"` → call `registerAfa()`. On success: store `fulfillment_ref = String(registrationId)`, clear `fulfillment_error`, leave `fulfillment_status`/`status` at their in-flight values (the cron confirms later), return `{success: true, ...}`. On failure: same failure-update shape Sykes already uses (`fulfillment_status: "failed"`, `fulfillment_error`, `status` untouched).

### 4. `lib/ussd/fulfill-afa.ts` — identical branch

Same shape, targeting `ussd_afa_orders` / `order_status` instead of `afa_orders` / `status`.

### 5. `app/api/admin/settings/afa-provider/route.ts` (new)

Mirrors the existing `mtn-whitelist-switch` settings route pattern: admin-gated GET (current provider + `["sykes", "apexprime"]`) and POST (validates against that allowlist, upserts `admin_settings.afa_provider_selection`).

### 6. `app/admin/afa-settings/page.tsx` — provider selector

One new `Card` (placed above the existing "Registration Price" card): a two-option select bound to the new settings route, with a short description of what each provider means (Sykes: current default; Apex Prime: pays from the Main Wallet already used for Apex Prime data orders, async — registrations show as "processing" until MTN approves).

### 7. `app/api/cron/sync-afa-status/apexprime/route.ts` (new)

Mirrors `app/api/cron/sync-mtn-status/apexprime/route.ts`'s structure (batch size 50, 1s delay between requests, `verifyCronAuth`). Loops over both `afa_orders` (`status` column) and `ussd_afa_orders` (`order_status` column) via a small shared helper parameterized on table/status-column name. For each row with `fulfillment_provider = 'apexprime'` and `fulfillment_status = 'pending'`:

- `checkAfaStatus(fulfillment_ref)` → `"completed"`: set `fulfillment_status: "fulfilled"`, clear error, `fulfilled_at`, and the destination status column to `"completed"`.
- → `"failed"`: set `fulfillment_status: "failed"`, `fulfillment_error` (matches Sykes' failure convention — order status column untouched, admin can retry).
- → `"pending"`/`"processing"`: no-op, still waiting.

### 8. `vercel.json` — new cron entry

`{"path": "/api/cron/sync-afa-status/apexprime", "schedule": "* * * * *"}`, matching every other provider sync cron's cadence.

## Out of scope

- `callback_url` / AFA webhook — deferred until a verified payload example exists.
- `slot` and `auto` payment methods — wallet only; no per-registration payment-method override.
- Any change to Sykes' own behavior.
- Admin visibility into which specific orders are on which provider beyond what's already visible via `fulfillment_provider` (no new orders-list UI column requested).
