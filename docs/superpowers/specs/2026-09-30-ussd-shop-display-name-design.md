# USSD Shop Display Name — Design

**Date:** 2026-09-30
**Status:** Approved for planning

## Problem

The shop/sub-agent USSD (`lib/ussd-shop/*`) prepends the shop's `shop_name` as a header on every screen. `shop_name` has zero content validation (confirmed in `app/api/shop/create/route.ts` and `app/api/shop/manage/route.ts`'s `EDITABLE_SHOP_FIELDS`) — a shop owner could freely name their shop something like "MTN Data Bundles Direct," which would reintroduce exactly the "data"/"bundle"/raw-network-name wording that the 2026-09-30 "Browse Services" rebrand (see `project-ussd-services-rebrand` memory) removed from the app's own copy.

## Design

### 1. Data model

New nullable column `user_shops.ussd_display_name` (`text`, default `NULL`), added via `migrations/0099_ussd_shop_display_name.sql` (next number after `0098_afa_fulfillment_provider.sql`). `resolveShopCode()` (`lib/shop-commerce/shop-code.ts`) changes:

```ts
// before
shopName: shopRow?.shop_name ?? 'Shop',
// after
shopName: shopRow?.ussd_display_name || shopRow?.shop_name || 'Shop',
```

`NULL`/empty means "use `shop_name`, unchanged" — every existing shop keeps working exactly as today with zero migration/backfill needed. Owners opt in whenever they choose to set a dedicated USSD name.

### 2. Validation logic

New pure module `lib/ussd-display-name.ts`:

```ts
export const BLOCKED_WORDS = ["data", "bundle", "bundles", "mtn", "telecel", "airteltigo", "at"]
const MAX_LENGTH = 30

export function validateUssdDisplayName(name: string): { valid: true } | { valid: false; reason: string } {
  const trimmed = name.trim()
  if (!trimmed) return { valid: false, reason: "Name is required" }
  if (trimmed.length > MAX_LENGTH) return { valid: false, reason: `Name must be ${MAX_LENGTH} characters or fewer` }
  for (const word of BLOCKED_WORDS) {
    if (new RegExp(`\\b${word}\\b`, "i").test(trimmed)) {
      return { valid: false, reason: `Name can't contain "${word}"` }
    }
  }
  return { valid: true }
}
```

- Whole-word matching (`\b...\b`), case-insensitive — chosen specifically to avoid false positives on ordinary substrings (e.g. "AirtelTigoDeals" with no space wouldn't match; "AirtelTigo Deals" would). The blocked word list deliberately includes the bare "AT" abbreviation despite its false-positive risk on ordinary short words — an explicit, accepted trade-off.
- 30-character cap — new constraint, not present on `shop_name`. Added because the shop USSD's package-list screen already has to fit a 160-character budget alongside the shop-name header (`lib/ussd-shop/menus.ts`'s `bundleMenu()`); an unbounded name risks squeezing that budget.
- Rejection is immediate and blocking (no auto-stripping, no admin-review queue) — the save simply fails with the reason shown to the shop owner, who edits and resubmits.

### 3. API route

New `app/api/dashboard/ussd-shop/display-name/route.ts`, `POST`, following the existing auth pattern used by `app/api/dashboard/ussd-shop/buy-sessions/route.ts` and `.../activate/route.ts` (raw `Authorization: Bearer <token>` → `supabase.auth.getUser(token)` → look up `user_shops` by `user_id`, NOT the admin-auth helper — this is a shop owner's own dashboard action, not an admin one):

```
POST /api/dashboard/ussd-shop/display-name
Body: { name: string }
```

- Runs `validateUssdDisplayName(name)` server-side (authoritative) — 400 with `{ error: reason }` on failure.
- Updates `user_shops.ussd_display_name` for the authenticated user's own shop.
- Returns `{ success: true, ussd_display_name: name }`.

### 4. UI

New small card on `app/dashboard/ussd-shop/page.tsx`, in the existing "USSD" tab (alongside the Shop Code card) — not a new page, not a new tab:

- Text input pre-filled with the shop's current `ussd_display_name`, or empty with a placeholder like `Currently showing: "<shop_name>"` when unset.
- Save button; calls `validateUssdDisplayName()` client-side first for instant feedback, then `POST`s to the new route (server-side validation is still authoritative — the client check is purely UX, never trusted alone).
- Inline error text under the input on either a client-side or server-side validation failure.
- Success toast + refreshed displayed value on save.

### Out of scope

- No retroactive enforcement on the existing `shop_name` field itself (still unrestricted, still used everywhere else — web storefront, dashboard, etc.) — only this new, USSD-specific field is filtered.
- No admin-facing management/override UI for this field in this pass.
- No changes to the main USSD (`lib/ussd/*`, not `lib/ussd-shop/*`) — it has no shop-name-equivalent field anywhere in its flow.

## Testing

- Unit tests for `validateUssdDisplayName()`: each blocked word (whole-word match), a name merely *containing* a blocked word as a substring without word boundaries (should pass, e.g. "AirtelTigoDeals"), empty/whitespace-only input, over-length input, and a valid ordinary name.
- API route test (fake-client pattern, matching this codebase's established convention) for: successful update, validation rejection (400 with reason), unauthenticated request (401), no shop found (404).
