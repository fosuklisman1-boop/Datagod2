# Bulk Package Price Update — Design

**Date:** 2026-09-21
**Status:** Approved for planning

## Problem

`app/admin/packages/page.tsx` only supports editing one package's price/dealer_price at a time via an inline edit form. When the admin needs to re-price a whole network (e.g. "raise all MTN dealer prices 5%" or "reset all Telecel packages to GHS 4.50/GB"), they must edit every row by hand. This feature adds bulk selection and bulk price recalculation to that page.

## Current State (from codebase research)

- **Page:** `app/admin/packages/page.tsx` — plain hand-rolled `<table>`, no checkboxes, no bulk actions. Single-row edit/delete/availability-toggle only. `AVAILABLE_NETWORKS` in this file (`["MTN", "Telecel", "AT - iShare", "AT - BigTime"]`) is stale — the real canonical network values enforced server-side are `MTN`, `AirtelTigo`, `Telecel` (see `app/api/admin/packages/route.ts` whitelist, `lib/products-catalog.ts`).
- **`packages` table columns relevant here:** `price` (user-facing, required, numeric), `dealer_price` (nullable numeric; falls back to `price` when unset or `0`), `network` (text), `size` (text, GB value with suffix stripped by the UI), `is_available` (boolean, the live enabled flag). No cost/margin columns exist on this table.
- **Existing single-row update:** `POST app/api/admin/packages/route.ts` with `{ packageData, packageId, isUpdate }`, guarded by `verifyAdminAccess`, whitelists fields via `ALLOWED_PACKAGE_FIELDS`, validates `network` enum / positive `price` / non-negative `dealer_price`. No array/batch support.
- **Bulk UI pattern to follow:** `app/admin/withdrawals/page.tsx` — `Checkbox` (shadcn) + `Set<string>` selection state + a conditional bulk-action toolbar shown only when something is selected.
- **Bulk API pattern to follow:** `app/api/admin/orders/bulk-update-status/route.ts` — its `inChunks()` helper (chunk size 200) avoids PostgREST `.in()` URL-length limits; also sets `export const maxDuration = 300` for longer-running batch routes.
- **Shop/sub-agent pricing** (`shop_packages`, `sub_agent_catalog`, `sub_agent_shop_packages`) stores margins as separate deltas layered on top of `packages.price`/`dealer_price` at read time. A bulk change to base prices automatically flows through to every storefront without touching those tables.
- **Admin auth:** `verifyAdminAccess` from `lib/admin-auth.ts`, reused identically here. Rate limiting distinguishes `ADMIN_HEAVY` (20 req/min) vs `ADMIN_GENERAL` via `isHeavyAdminOperation()` in `lib/rate-limit-config.ts`.
- **Audit log:** `admin_audit_log` table exists (`migrations/0069_admin_moderation_sms.sql`): `id, admin_id, action, target_user_id (nullable), old_value JSONB, new_value JSONB, created_at`. Written best-effort (fire-and-forget, never blocks the response) — see `app/api/admin/update-balance/route.ts` for the reference pattern.

## Design

### 1. UI / Selection Flow (`app/admin/packages/page.tsx`)

- Add a **network filter** control above the table using the real canonical values (`MTN` / `AirtelTigo` / `Telecel` / "All"). Fix the stale `AVAILABLE_NETWORKS` list while touching this file (it's used by the add/edit form's network `<select>` too — replace it with the canonical list in both places).
- Add a **checkbox column**: per-row checkbox plus a header "select all visible" checkbox. "Select all" respects the active network filter — filtering to MTN then selecting all only selects the visible MTN rows.
- Selection state: `Set<string>` of package ids, same as `app/admin/withdrawals/page.tsx`.
- When `selectedIds.size > 0`, show a **bulk action bar** above the table: "{N} packages selected", a "Bulk Update Prices" button, and a "Clear selection" link.

### 2. Bulk Update Modal — Calculation & Preview

Clicking "Bulk Update Prices" opens a shadcn `Dialog`:

- **Field toggles:** checkboxes "Update user price" / "Update dealer price" — either or both, independently.
- Each checked field gets its own sub-form:
  - **Mode** (radio): "Percentage adjustment" or "Set per-GB rate".
  - **Percentage mode:** signed number input (e.g. `+10`, `-5`). Formula: `new_value = round(old_value * (1 + pct/100), 2)`.
  - **Per-GB mode:** rate input (e.g. `4.50`). Formula: `new_value = round(size_gb * rate, 2)` — this **replaces** the price outright, it does not adjust the existing value.
- **Preview button:** computes new values client-side for every selected package (no write yet), renders a table — Package | Network | Size | Old Price | New Price | Old Dealer | New Dealer — with changed cells highlighted. Rows that would fail a safeguard (see §3) are flagged with a reason and excluded from the confirm count.
- **Confirm & Apply button:** disabled until a preview has been run and at least one valid row remains. Sends the batch to the API.
- After the API responds, show a results summary: "{N} updated, {M} skipped" with skip reasons listed.

### 3. Backend API & Safeguards

**New route:** `app/api/admin/packages/bulk-update-price/route.ts` (`POST`), `export const maxDuration = 300`.

Request body:
```ts
{
  packageIds: string[],
  updates: {
    price?:        { mode: "percentage" | "per_gb", value: number },
    dealer_price?: { mode: "percentage" | "per_gb", value: number },
  }
}
```

Server logic:
1. `verifyAdminAccess(req)`. Register `/api/admin/packages/bulk-update-price` in `HEAVY_ADMIN_OPERATIONS` (`lib/rate-limit-config.ts`) for the `ADMIN_HEAVY` rate-limit tier.
2. Validate `packageIds` non-empty array of UUIDs; validate `updates` has at least one of `price`/`dealer_price`; validate `mode` enum and `value` is a finite number (positive for `per_gb` rate).
3. Fetch current rows for `packageIds` via chunked `.in("id", chunk)` (reuse the `inChunks()` helper pattern from `bulk-update-status/route.ts`, chunk size 200), selecting `id, price, dealer_price, size, network`.
4. Recompute new values **server-side** per package using the formulas in §2 — never trust client-computed preview numbers.
5. Per-package safeguard checks (a failing package is skipped, not fatal to the batch):
   - Computed `price` or `dealer_price` `≤ 0` → skip, reason `"non_positive_price"`.
   - Computed `dealer_price > price` (comparing the *new* values, using the *other* field's old value when it wasn't part of this update) → skip, reason `"dealer_price_exceeds_price"`.
   - Round every computed value to 2 decimal places before comparison and storage.
6. Apply updates for all passing packages (`Promise.all` of per-row `.update().eq("id", id)` calls — package catalogs are small, dozens not thousands, so the heavier multi-chunk machinery `bulk-update-status` needs for large order tables isn't warranted here).
7. Insert one `admin_audit_log` row, best-effort / fire-and-forget:
   ```ts
   {
     admin_id: adminUserId,
     action: "bulk_price_update",
     target_user_id: null,
     old_value: { package_ids: packageIds, updates },
     new_value: {
       updated: [{ id, old_price, new_price, old_dealer_price, new_dealer_price }, ...],
       skipped: [{ id, reason }, ...],
     },
   }
   ```
8. Response: `{ updated: [...], skipped: [...] }`.

### Out of scope

- Bulk-adjusting shop/sub-agent margins (`shop_packages.profit_margin`, `sub_agent_catalog.wholesale_margin`, `sub_agent_shop_packages.sub_agent_profit_margin`) — base price changes flow through automatically at read time; margin bulk-editing would be a separate feature if ever needed.
- Bulk availability toggling — already exists as a separate single-row feature (`toggle-availability` route); not part of this scope.
- Pagination of the packages table — out of scope; the table is currently unpaginated and this feature doesn't change that.

## Testing

- Unit tests for the pure calculation functions (percentage and per-GB formulas, rounding, safeguard checks) — no DB/network involved, following the project's existing "pure money helper" test convention.
- API route test (or manual verification) for: mixed valid/invalid rows in one batch, `dealer_price`-only update, `price`-only update, both-fields update, auth rejection for non-admin.
