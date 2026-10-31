# Per-user custom data bundle prices: design

Date: 2026-10-31
Status: implemented; see "Changes during implementation" for where the shipped behaviour differs from the original design

## Goal

An admin can give one user their own price for any data bundle package. That price is what the user pays on every channel and is their cost basis for their shop and sub-agents.

## Scope

In scope: data bundle packages (`packages` table) only.

Out of scope: airtime, utility bills, results checker, AFA, named/shared price lists, percentage discounts.

## Decisions

| Question | Decision |
|---|---|
| Products | Data bundles only |
| Input | A fixed price per package; packages with no custom price use the user's role price |
| Per-user switch | Each user has a pricing mode, Role price (default) or Custom price. Custom prices apply only in Custom mode; switching back to Role keeps the saved prices for later |
| Reach | Every channel: dashboard, bulk, API v1/v2, USSD, WhatsApp, AI tools, and shop/sub-agent cost basis |
| Shop effect | Shop and sub-agent selling prices do not change; the owner's profit grows by (role price − custom price) |
| Storage | New `user_package_prices` table plus one shared price resolver |
| Package price changes | Custom prices are fixed; later changes to `price` / `dealer_price` do not move them |

## Current state

The role price rule (`dealer_price` for dealers, and for admins in shop code, when set and > 0, otherwise `price`) is copied by hand in about 20 places (see "Charge points"). There is no per-user pricing and no provider cost column.

## Data model

Migration `migrations/0142_user_package_prices.sql`. Use the next free number at implementation time.

```sql
-- Per-user switch: 'role' (default) = normal role pricing; 'custom' = saved custom prices apply.
ALTER TABLE users ADD COLUMN pricing_mode text NOT NULL DEFAULT 'role'
  CHECK (pricing_mode IN ('role', 'custom'));

CREATE TABLE user_package_prices (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  price      numeric(10,2) NOT NULL CHECK (price > 0 AND price <= 10000),
  set_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, package_id)
);

CREATE TABLE user_package_price_audit (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('price', 'mode')),
  package_id uuid,                   -- set for kind = 'price'
  old_price  numeric(10,2),          -- kind 'price': null = no custom price before
  new_price  numeric(10,2),          -- kind 'price': null = custom price removed
  old_mode   text,                   -- set for kind = 'mode'
  new_mode   text,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
```

Row-level security (RLS) is enabled on both tables. Users may `SELECT` their own `user_package_prices` rows. Users cannot change their own `pricing_mode`: the existing `users` update restrictions (migration `0040_restrict_users_role_update.sql`) are extended to cover it. All writes go through the service role in the admin API. The audit table is readable by the service role only.

Match `packages.id` and `users.id` column types to the live schema at implementation time.

## Price resolver: `lib/pricing/package-price.ts`

The resolver is pure where possible. It is the only place the price rule lives.

```ts
type PricedPackage = { id: string; price: number; dealer_price: number | null }

/** Existing rule, unchanged: dealer (and admin, where shop code already does so) gets dealer_price when > 0. */
export function rolePrice(role: string, pkg: PricedPackage): number

/** custom ?? rolePrice */
export function effectivePrice(role: string, pkg: PricedPackage, custom: number | null | undefined): number

/**
 * The user's custom prices that apply right now. Reads users.pricing_mode first: in 'role' mode it
 * returns an empty map without reading prices. Throws on a read error (callers on a charge path refuse the request).
 */
export async function getCustomPrices(client, userId: string, packageIds?: string[]): Promise<Map<string, number>>
```

The resolver keeps one existing difference between channels: admins get the dealer price in shop code but not on the dashboard purchase path. `rolePrice` takes the same role input each caller uses today, so the refactor in rollout step 1 does not change behaviour.

## Charge points

Every place below switches to `effectivePrice`. Server-side prices ignore any price the client sends.

| Group | Files |
|---|---|
| Dashboard | `app/api/orders/purchase/route.ts`, `app/api/orders/create-bulk/route.ts` |
| Developer API | `app/api/v1/orders/route.ts`, `lib/api-v2/data-orders.ts` (`priceForRole`), `lib/api-v2/bundles.ts`, `lib/api-v2/order-store.ts`, the v2 catalog |
| USSD / WhatsApp / AI | `lib/ussd/handlers/bundles.ts`, `lib/ussd-hubtel/catalog.ts`, `lib/whatsapp-bot/router.ts`, `lib/ai-tools.ts` |
| Shops | `lib/shop-commerce/pricing.ts` (`basePrice`), `app/api/shop/orders/create/route.ts`, `app/api/shop/public-packages/route.ts`, `app/api/shop/invites/[code]/route.ts`, `app/api/shop/dealer-packages/route.ts`, `app/api/shop/dealer-price-list/route.ts`, `app/api/shop/sub-agent-catalog/route.ts` |
| Price displays | `lib/products-catalog.ts`, `app/dashboard/data-packages`, `app/dashboard/buy-stock`, `app/dashboard/shop-pricing`, `app/dashboard/sub-agent-catalog` |

Price displays stop working out prices on the client. They read the resolved price from their API, so what is shown is what is charged.

The final list comes from `grep -rn dealer_price` at implementation time. Any match not in this table gets added.

## Shop and sub-agent profit rule

Let `role` = the owner's role price, `cost` = `effectivePrice(...)` for the owner, and `margin` = the stored margin.

- Selling price = `role + margin`, unchanged, so customers see no difference.
- Owner profit = `margin + (role − cost)`.
- For sub-agent shops, the sub-agent's price stays `parent role price + wholesale_margin + sub-agent margin`. The parent's profit becomes `wholesale_margin + (parent role − parent cost)`. This includes stock purchases.
- No stored margin is rewritten. Removing a custom price, or switching the owner to Role mode, reverts them to normal profit with nothing to undo.

If `cost > role` (a custom price above the role price), the profit formula lowers the owner's profit. The admin screen warns about this case. It is allowed, but it can never make a shop's selling price change.

## Admin API and UI

- `GET /api/admin/users/[id]/custom-prices` returns the user's `pricing_mode` and every available data package with `price`, `dealer_price` and `custom_price` (or null). It is admin only.
- `PUT /api/admin/users/[id]/custom-prices` takes `{ pricing_mode?: 'role' | 'custom', prices?: [{ package_id, price: number | null }] }`, where `null` removes a custom price. It is admin only and validated as a whole: a price must be a number with at most 2 decimals, > 0 and ≤ 10000, and the package must exist. One bad row rejects the whole request with per-row errors. The write upserts or deletes the rows, sets the mode, and adds an audit row for each change. Prices and mode are saved in one database transaction (an RPC), so a user is never in Custom mode with a half-saved price list.
- Admin → Users gets a "Custom prices" action per user that opens a dialog. At the top is a **Pricing** toggle: **Role price** or **Custom price**. Below it the packages are grouped by network; each row has a price input, and a Clear button removes a custom price. The admin can edit prices in either mode; in Role mode the dialog says they are saved but not in use. Saving sends one `PUT`.
  - Switching to Custom with no custom prices saved is allowed; the user then pays role prices everywhere until prices are added.
  - The users list shows a "Custom pricing" badge on users in Custom mode, and the list can be filtered by it.
  - The dialog warns, without blocking, about a price below the dealer price ("may be below cost") and a price above the user's role price ("reduces this user's shop profit").
- There is no feature flag (see "Changes during implementation").

## Errors

- Charge path: if `getCustomPrices` fails, the request is refused with a "temporarily unavailable, try again" error and nothing is debited. It never falls back to the role price, which could overcharge a user who has a lower custom price.
- Display path: if the read fails, the role price is shown with a notice that prices may not be the user's latest.
- The pricing mode and custom prices are read once per request and never cached across requests. An admin's change, including flipping the toggle, applies to the very next purchase.

## Testing

- Resolver unit tests: role price, a custom price winning over the role price, a dealer with no or zero `dealer_price`, `getCustomPrices` returning nothing in Role mode even with saved prices, and `getCustomPrices` throwing.
- Toggle: a user with saved prices pays role prices in Role mode and custom prices in Custom mode; switching back to Role keeps the saved prices; a user cannot change their own mode.
- Each charge point: a user with a custom price is charged the custom price, and a user without one is charged exactly as before.
- Shops and sub-agents: the selling price is unchanged and the owner's (or parent's) profit increases by `role − cost`, including on stock purchases.
- Admin API: non-admins get 403, plus validation errors, an invalid `pricing_mode`, removing a price with null, and audit rows written for price and mode changes.
- Guard test: no file outside `lib/pricing/package-price.ts` reads `dealer_price` to choose a price. The allow-list covers admin editors and the bulk price tool.

## Rollout

1. Add the migration and resolver, then move every charge point onto `rolePrice`/`effectivePrice` with no custom prices present. Existing tests must pass unchanged, since behaviour does not change.
2. Add the admin API, audit log and dialog, with the dialog hidden behind the flag.
3. Switch on custom-price lookups at the charge points group by group, each group with its tests. When every group is done, turn on the flag.

## Changes during implementation

Where this section and the text above disagree, this section is what shipped.

- **Audit log.** Audit rows go to the existing `admin_audit_log`, with actions `pricing_mode_set`, `custom_price_set` and `custom_price_removed`. There is no separate audit table.
- **No global feature flag.** The `custom_prices_enabled` flag was dropped. `pricing_mode` defaults to `role`, so nothing changes for any user until an admin switches them, and the feature ships as one release.
- **RPC hardening.** `set_user_custom_prices` validates its input: each price is an unconstrained numeric with at most 2 decimals, package ids are uuids, the admin and the user must both exist, and a package may appear only once in a request. Every failure raises `BAD_INPUT`.
- **API v2 database check.** Migration 0142 also redefines `public.place_api_v2_order` from 0130, with one extra clause, so live API v2 accepts a user's custom price when they are in custom mode. This is needed because the RPC re-checks the submitted price against the package's normal and dealer prices, and would otherwise reject a custom price. A migration test guards against drift between the two function bodies. 0130 now carries a header note that it is superseded.
- **Shop rules.** Selling prices are unchanged.
  - Owner profit = margin + saving, with no clamp, rounded to 2 decimals.
  - Old-model parent profit = wholesale margin + saving.
  - New-model library parent profit = max(0, parent_price − the parent's effective price).
  - Negative margins are refused on every channel.
  - A sub-agent's own-shop old-model catalog rows use the parent's active wholesale margin.
  - The storefront uses the server-verified package id and scopes catalog lookups to the right shop.
  - A negative profit, which can only come from a custom price above the role price, is never credited or debited.
- **Sub-agent tier.** Sub-agents on the sub_agent tier keep paying the parent's catalog price.
- **Display-only pages.** These pages show the role price on purpose, because the selling price is role price + margin: public-packages, invites, dealer-price-list, sub-agent-catalog, parent-packages, shop-pricing, the sub-agent-catalog page, and dealer-packages (buy-stock orders against the dealer's own shop, which the create route prices at role price + margin; the saving is credited as shop profit).
- **New endpoint.** `GET /api/user/package-prices` returns `{ pricing_mode, prices, custom_ids }`. The dashboard never applies the per-network display adjustment to a custom price.
- **Admin view.** The admin GET also lists unavailable packages that carry a custom price, so they can be cleared.
- **Deploy order.** Apply migration 0142 BEFORE deploying the code. Otherwise every custom-price read fails and charge paths refuse with 503, and the Admin -> Users list fails because it selects `pricing_mode`.
