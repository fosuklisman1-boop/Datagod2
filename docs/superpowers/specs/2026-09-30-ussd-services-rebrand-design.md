# USSD "Browse Services" Rebrand — Design

**Date:** 2026-09-30
**Status:** Approved for planning

## Problem

Both of Datagod's USSD menus (the main platform shortcode and the per-shop sub-agent shortcode) currently lead with product-first, "data bundle"-centric wording ("Buy Data Bundle" / "Data Bundle", "Select Bundle:", "1GB MTN"). The goal is a broader-positioning rebrand: read as a general services menu ("Browse Services") rather than a single-product data reseller, with carrier identity shown only via network nicknames instead of raw carrier names.

Along the way, this also fixes a real functional gap: `AT-BigTime` packages are already purchasable end-to-end (web storefront lists them, `lib/ussd/fulfill.ts` already fulfills them) but were never selectable on the USSD network menu — only `AT-iShare` was. Adding it as a nicknamed network option makes it reachable via USSD for the first time.

## Current State (from codebase research)

- **Main USSD**: `app/api/ussd/route.ts` → `lib/ussd/router.ts` → `lib/ussd/handlers/*.ts`, copy in `lib/ussd/menus.ts`. Top-level menu: `1. Buy Data Bundle, 2. AFA Registration, 3. Buy Airtime, 4. Results Checker, 0. Exit` (items independently admin-toggleable; "Buy Data Bundle" additionally gated by a per-caller whitelist).
- **Shop USSD**: `app/api/ussd-shop/route.ts` → `lib/ussd-shop/router.ts` → `lib/ussd-shop/handlers/*.ts`, copy in `lib/ussd-shop/menus.ts`. After shop-code entry: `1. Data Bundle, 2. Airtime, 3. Results Checker, 0. Exit` (no AFA option on this flow).
- **Data-bundle flow today, both**: Network selection → flat, price-sorted, paginated package list (no size/range grouping — sizes and prices all mixed in one list) → recipient phone entry → confirm → payment. Network and package are already separate USSD steps (`SELECT_NETWORK`, `SELECT_BUNDLE`); there is no separate "range" step and none is being added.
- **Main USSD's network menu** is a hardcoded 4-item list baked into `handlers/main.ts` (duplicating, not reusing, `networkMenu()` in `menus.ts`): MTN / Telecel / AirtelTigo / AT-iShare, keyed in `NETWORK_OPTIONS` (`handlers/bundles.ts`) to `packages.network` values `'MTN'`, `'Telecel'`, `'AirtelTigo'`, `'AT-iShare'` respectively.
- **Shop USSD's network menu** is dynamic — built per-shop from whichever networks that shop actually stocks (`sortNetworks()` / `NETWORK_PRIORITY` in `lib/ussd-shop/menus.ts`, currently only ranks `mtn`/`telecel`/`airteltigo`/`at-ishare`).
- **`AT-BigTime` is a real, already-fulfillable network** confirmed via: `app/dashboard/data-packages/page.tsx`'s `NETWORK_ORDER = ["MTN", "Telecel", "AT-iShare", "AT-BigTime"]` (the web storefront's actual category list, no generic "AirtelTigo"), and `lib/ussd/fulfill.ts`'s `fulfillableNetworks` list which already includes `"AT - BIGTIME"`/`"AT-BIGTIME"` alongside iShare. It is simply missing from the USSD's *selection* menu today. (Note: `lib/network-stock-service.ts` uses a spaced variant, `"AT - iShare"`/`"AT - BigTime"`, for stock tracking — a pre-existing inconsistency, unrelated to and out of scope for this change. The `packages.network` value used for querying/display is the unspaced form, `AT-iShare`/`AT-BigTime`.)
- **No "Browse Services" menu item exists anywhere today** — confirmed via repo-wide search. New terminology.
- **`NETWORK_OPTIONS[key].paystackProvider`** (`handlers/bundles.ts`) is only a fallback used when `paystackProviderFromPhone()` can't detect the payer's own network from their dialing number — `'tgo'` (the existing AirtelTigo-family value) is correct for both iShare and BigTime.

## Design

### 1. Shared nickname module

New file `lib/ussd/network-labels.ts`, imported by both `lib/ussd/*` and `lib/ussd-shop/*`, so the four nicknames are defined in exactly one place:

```typescript
export const NETWORK_NICKNAMES: Record<string, string> = {
  'MTN': 'Yellow Plans',
  'Telecel': 'Tele',
  'AT-iShare': 'Instant Blue',
  'AT-BigTime': 'Delay Blue',
}
```

Both USSD codebases look up a `packages.network` value through this map wherever a network name would otherwise be shown to the customer (network menu, confirm screen). A value with no entry (e.g. a legacy generic `"AirtelTigo"` still present in some shop's stocked-network list) falls back to showing the raw value rather than erroring or silently hiding it.

### 2. Main USSD screen changes

- **Main menu** (`menus.ts` `MAIN_MENU_ITEMS`): label `"Buy Data Bundle"` → `"Browse Services"`. AFA Registration / Buy Airtime / Results Checker / Exit unchanged — this is a label swap only, not a new umbrella (picking it still leads straight into network selection, same as today).
- **Network menu**: the hardcoded list in `handlers/main.ts` is unified to call `menus.ts`'s `networkMenu()` (removing the current duplication) and both are updated to a 4-item, nickname-only list built from the shared map, dropping the generic `"AirtelTigo"` entry and adding `AT-BigTime`:
  ```
  Select Network:
  1. Yellow Plans
  2. Tele
  3. Instant Blue
  4. Delay Blue
  0. Back
  ```
  `NETWORK_OPTIONS` in `handlers/bundles.ts` gains a `'4': { dbName: 'AT-BigTime', paystackProvider: 'tgo' }` entry (shifting the old `'4': AT-iShare` to `'3'` in the new numbering, `AirtelTigo` removed).
- **Package list** (`bundleMenu()`): header `"Select Bundle:"` → `"Select Package:"`. Size/price rows unchanged (e.g. `"1GB - GHS 5.50"` stays — GB and price are product specs, not "bundle" terminology).
- **Recipient prompt** (`recipientPrompt()`): `"Enter recipient number\n(who gets the data):"` → `"Enter recipient number:\n(who gets it):"`.
- **Confirm screen** (`confirmMenu()`): the network-name line (e.g. `"1GB MTN"`) is rendered via the nickname map (e.g. `"1GB Yellow Plans"`). Everything else on that screen (phone numbers, price, Pay now/Cancel) is unchanged.
- **Payment method menu**: no "data"/"bundle" wording present today — unchanged.

### 3. Shop USSD screen changes

- **Product menu** (`ussd-shop/menus.ts` `productMenu()`/`PRODUCT_MENU_ITEMS`): label `"Data Bundle"` → `"Browse Services"`. Airtime / Results Checker / Exit unchanged.
- **Network menu** (`networkMenu(shopName, networks)`): still dynamic per-shop (only shows networks that shop actually stocks), but each raw network value is passed through the shared nickname map before rendering. `NETWORK_PRIORITY` gains an `'at-bigtime': 5` entry so it sorts correctly when present. `AT-BigTime` becomes selectable on shop USSD wherever a shop's catalog stocks it, same mechanism as the other three networks — no new plumbing needed there either.
- **Package list**: header `"Select Bundle:"` → `"Select Package:"`, same as main.
- **Recipient prompt**: same wording change as main.
- **Confirm screen**: same nickname substitution as main; shop-name header and no-wallet payment path unchanged.
- **Payment-sent message**: exact current string to be confirmed during planning; no "data"/"bundle" wording expected, so no change anticipated unless planning finds one.

### Out of scope

- SMS/WhatsApp delivery confirmations and any other channel (web storefront, dashboard, admin panel, AI/WhatsApp bot) — these are separate, platform-wide systems; only the two USSD menus' own copy is touched.
- Internal identifiers (`ussd_orders`, `package_size`, `bundlePrice`, table/column names) — not user-facing, unaffected.
- Admin-facing labels (the `data` visibility-toggle key, admin settings page wording) — functionally unchanged.
- `lib/network-stock-service.ts`'s spaced `"AT - iShare"`/`"AT - BigTime"` naming inconsistency — pre-existing, unrelated to this change, not touched.

## Testing

- Unit tests for the shared nickname lookup (`lib/ussd/network-labels.ts`): known networks map correctly, an unrecognized value falls back to itself.
- Existing USSD handler tests (if any) updated for the new menu copy and the added `AT-BigTime` network option; a new case verifying `AT-BigTime` is selectable and queries `packages.network = 'AT-BigTime'` correctly, mirroring the existing `AT-iShare` case.
