# Withdrawal Fee Minimum & Minimum Withdrawal Amount — Design

## Goal

Make two currently-hardcoded withdrawal values admin-configurable:
1. **Withdrawal fee minimum** (new) — a GHS floor under the percentage-based withdrawal fee, so `feeAmount = max(percentage × amount, floor)`. Today there's no floor at all; a small withdrawal at a low fee percentage can charge almost nothing.
2. **Minimum withdrawal amount** (currently hardcoded to GHS 5.00 in `lib/shop-service.ts`) — the smallest amount a shop owner may request to withdraw.

## Context

- `app_settings` is a **wide, single-row table** (the row where `key IS NULL`), not the JSONB key-value `admin_settings` table used elsewhere in this codebase for MTN provider settings — each setting is its own typed column (`paystack_fee_percentage`, `wallet_topup_fee_percentage`, `withdrawal_fee_percentage`, all `numeric`). Adding the two new values means a real migration (`ALTER TABLE ... ADD COLUMN`), not a JSONB key addition.
- **`lib/shop-service.ts`'s `withdrawalService.createWithdrawalRequest`** is the sole place both values need enforcing:
  - Line 619: `if (withdrawalData.amount < 5) throw new Error("Minimum withdrawal amount is GHS 5.00")` — hardcoded floor on the request amount.
  - Lines 693-708: reads `withdrawal_fee_percentage` from `app_settings` (already a `service_role`-only, fail-closed read — see the existing comment at lines 687-692 explaining why a browser-side `anon` read there previously silently defaulted the fee to 0%), computes `feeAmount = amount × percentage`, no floor.
  - **`app/api/admin/withdrawals/approve/route.ts` does NOT recompute the fee** — it reads the already-stored `fee_amount`/`net_amount` columns from the `withdrawal_requests` row (set once, at creation time). So the floor logic only needs to live in `createWithdrawalRequest` — there is no second enforcement point to keep in sync.
- **`app/api/settings/fees/route.ts`** is a small, public (unauthenticated), no-DB-mutation GET endpoint returning `{paystack_fee_percentage, wallet_topup_fee_percentage, withdrawal_fee_percentage}`, with hardcoded fallback defaults on every error path. Both the web shop dashboard and the mobile app already call it (`mobile/src/lib/datagod.ts:212`) to get the live withdrawal fee percentage — extending its response is how both surfaces pick up the two new values without a separate endpoint.
- **`app/api/admin/settings/route.ts`** is the authenticated admin GET/POST for the whole `app_settings` singleton row — has an explicit allowed-fields list (~line 144), GET response defaults (two separate fallback object literals), POST body destructuring, and POST validation (`withdrawal_fee_percentage` is bounds-checked `0-100` since it's a percentage; the two new GHS-amount fields only need a `>= 0` check, no upper bound).
- **`app/admin/settings/page.tsx`** already has a "Withdrawal Fee Percentage" input (~line 1496) and a live "Withdrawal Preview (GHS 100 Requested)" calculation box (~line 1552) showing fee and net amount for a hypothetical GHS 100 withdrawal — the two new inputs are added alongside it, and the preview box updated to apply the floor.
- **`app/dashboard/shop-dashboard/page.tsx`** is the actual web UI shop owners use to request a withdrawal — not a secondary surface. It already fetches `withdrawal_fee_percentage` from `/api/settings/fees` (line 67-75) but separately hardcodes GHS 5 in four places: a client-side pre-submit toast (line 286), the amount input's `min` HTML attribute (line 604), a "Minimum: GHS 5.00" display string (line 609), and the fee preview calculation (lines 778-786, currently pure percentage with no floor). All four become dynamic, driven by the same fetch.
- **Deliberately out of scope**: `mobile/src/app/withdraw.tsx` has its own hardcoded "min 5.00" label (a separate Expo app with its own release cycle). It already calls the same `/api/settings/fees` endpoint for the percentage, so once this backend ships, wiring the label there is a small, independent follow-up — not part of this plan. The *enforcement* (server-side minimum-amount check in `createWithdrawalRequest`) already protects the mobile flow correctly regardless of what its label says; only the displayed text would go stale if an admin changes the minimum away from 5.

## Design

### 1. Migration — `migrations/add_withdrawal_minimums.sql`

```sql
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS withdrawal_fee_minimum numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS minimum_withdrawal_amount numeric NOT NULL DEFAULT 5;
```

Both `NOT NULL DEFAULT` so every existing row (including the singleton settings row) gets a value immediately on migration — `withdrawal_fee_minimum = 0` means "no floor," exactly matching today's behavior; `minimum_withdrawal_amount = 5` exactly matches today's hardcoded check. No backfill script needed — the column defaults handle it.

### 2. `lib/shop-service.ts` — `createWithdrawalRequest`

Extend the existing settings read (already fetching `withdrawal_fee_percentage`) to include both new columns in the same query, then use them:

```ts
const { data: settings, error: settingsError } = await db
  .from("app_settings")
  .select("withdrawal_fee_percentage, withdrawal_fee_minimum, minimum_withdrawal_amount")
  .is("key", null)
  .maybeSingle()
if (settingsError) {
  console.error(`[WITHDRAWAL-CREATE] Fee settings read failed (${settingsError.code}): ${settingsError.message}`)
  throw new Error("Could not determine the withdrawal fee right now. Please try again in a moment.")
}
if (settings?.withdrawal_fee_percentage) {
  withdrawalFeePercentage = settings.withdrawal_fee_percentage / 100
}
const withdrawalFeeMinimum = settings?.withdrawal_fee_minimum ?? 0
const minimumWithdrawalAmount = settings?.minimum_withdrawal_amount ?? 5
```

Move the minimum-amount validation (currently hardcoded, currently runs *before* this settings read) to *after* it, since it now needs `minimumWithdrawalAmount` from the same fail-closed read:

```ts
if (withdrawalData.amount < minimumWithdrawalAmount) {
  throw new Error(`Minimum withdrawal amount is GHS ${minimumWithdrawalAmount.toFixed(2)}`)
}
```

This is a deliberate behavior tightening: today, if the settings read fails, the withdrawal still proceeds using the hardcoded 5 minimum but a silently-zeroed fee (per the existing fail-closed comment, that specific failure mode was already fixed for the fee — this migration extends the same fail-closed guarantee to the minimum-amount check, so a settings-read failure blocks the whole request rather than silently falling back to a stale hardcoded minimum).

Fee calculation:

```ts
const percentageFee = Math.round(withdrawalData.amount * withdrawalFeePercentage * 100) / 100
const feeAmount = Math.max(percentageFee, withdrawalFeeMinimum)
const netAmount = withdrawalData.amount - feeAmount
```

### 3. `app/api/settings/fees/route.ts`

Add both fields to the `.select()`, the success response, and every fallback/default object (error path and no-settings path):

```ts
.select("paystack_fee_percentage, wallet_topup_fee_percentage, withdrawal_fee_percentage, withdrawal_fee_minimum, minimum_withdrawal_amount")
```

```ts
return NextResponse.json({
  paystack_fee_percentage: settings.paystack_fee_percentage || 3.0,
  wallet_topup_fee_percentage: settings.wallet_topup_fee_percentage || 0,
  withdrawal_fee_percentage: settings.withdrawal_fee_percentage || 0,
  withdrawal_fee_minimum: settings.withdrawal_fee_minimum ?? 0,
  minimum_withdrawal_amount: settings.minimum_withdrawal_amount ?? 5,
})
```

(Uses `??` rather than `||` for these two — `0` is a legitimate, meaningful value for `withdrawal_fee_minimum`, unlike the percentage fields where `||` was already being used loosely; keeping `??` here avoids accidentally replacing an admin-set `0` floor with the fallback.) Every fallback object (the `error`/no-settings/catch branches) gets `withdrawal_fee_minimum: 0, minimum_withdrawal_amount: 5` added, matching the migration's defaults exactly so a settings-read failure never presents a UI-displayed minimum that disagrees with what the backend will actually enforce.

### 4. `app/api/admin/settings/route.ts`

- Add `withdrawal_fee_minimum` and `minimum_withdrawal_amount` to the allowed-fields list (~line 144-146).
- Add both to the GET response and both default-fallback objects (matching the pattern already used for `withdrawal_fee_percentage`).
- Add both to the POST body destructuring.
- Add validation: both must be `>= 0` (no upper bound — unlike the percentage fields' `0-100` range, a GHS amount has no natural ceiling here):
  ```ts
  if (withdrawal_fee_minimum !== undefined && withdrawal_fee_minimum < 0) {
    return NextResponse.json({ error: "withdrawal_fee_minimum must be >= 0" }, { status: 400 })
  }
  if (minimum_withdrawal_amount !== undefined && minimum_withdrawal_amount < 0) {
    return NextResponse.json({ error: "minimum_withdrawal_amount must be >= 0" }, { status: 400 })
  }
  ```

### 5. `app/admin/settings/page.tsx`

Two new number inputs (GHS, `step="0.01"`, `min="0"`, no `max`) placed directly after the existing "Withdrawal Fee Percentage" field, each with its own state hook (`withdrawalFeeMinimum`/`setWithdrawalFeeMinimum`, `minimumWithdrawalAmount`/`setMinimumWithdrawalAmount`) following the exact same load/save wiring as the percentage field (loaded in the same GET response handler, included in the same POST save payload).

The "Withdrawal Preview (GHS 100 Requested)" box's fee line changes from pure percentage to the floor-applied calculation:

```tsx
<div className="flex justify-between">
  <span className="text-primary">
    Withdrawal fee (max of {withdrawalFeePercentage}% or GHS {withdrawalFeeMinimum.toFixed(2)}):
  </span>
  <span className="font-medium text-warning">
    -GHS {Math.max(100 * withdrawalFeePercentage / 100, withdrawalFeeMinimum).toFixed(2)}
  </span>
</div>
```

with "Shop receives" updated to subtract that same `Math.max(...)` value instead of the raw percentage figure.

### 6. `app/dashboard/shop-dashboard/page.tsx`

- Extend the existing `fetchWithdrawalFee` handler to also capture `withdrawal_fee_minimum` and `minimum_withdrawal_amount` from the same `/api/settings/fees` response into two new state hooks, defaulting to `0` and `5` respectively (matching the API's own fallback defaults) so the UI never shows `undefined` while the fetch is in flight.
- Line 286's toast: `Minimum withdrawal amount is GHS 5.00` → `` `Minimum withdrawal amount is GHS ${minimumWithdrawalAmount.toFixed(2)}` ``.
- Line 604's input: `min="5"` → `min={minimumWithdrawalAmount}`.
- Line 609's display text: `Minimum: GHS 5.00` → `` Minimum: GHS {minimumWithdrawalAmount.toFixed(2)} ``.
- Lines 778-786's fee preview: apply `Math.max(percentageFee, withdrawalFeeMinimum)` the same way as the admin preview box.

## Testing

- `lib/shop-service.ts`'s `createWithdrawalRequest` is not currently unit-tested (it's a large function with heavy Supabase chaining, no existing test file) — matches this codebase's established convention of not unit-testing `app/api/**`/complex service functions with heavy DB chaining; verified via `npx tsc --noEmit` and manual testing instead, consistent with how the rest of the withdrawal flow is verified today.
- Manual verification: set a non-zero `withdrawal_fee_minimum` and a `minimum_withdrawal_amount` other than 5 via the admin UI, confirm the shop dashboard's live preview and the actual created `withdrawal_requests` row's `fee_amount` reflect the floor; confirm a withdrawal request below the new minimum is rejected with the correct GHS amount in the error message; confirm `/api/settings/fees` returns both new fields.
