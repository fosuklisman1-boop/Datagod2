# Per-user custom data bundle prices: design

Date: 2026-10-31
Status: approved design, awaiting implementation plan

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
| Reach | Every channel: dashboard, bulk, API v1/v2, USSD, WhatsApp, AI tools, and shop/sub-agent cost basis |
| Shop effect | Shop and sub-agent selling prices do not change; the owner's profit grows by (role price − custom price) |
| Storage | New `user_package_prices` table plus one shared price resolver |
| Package price changes | Custom prices are fixed; later changes to `price` / `dealer_price` do not move them |

## Current state

The role price rule (`dealer_price` for dealers, and for admins in shop code, when set and > 0, otherwise `price`) is copied by hand in about 20 places (see "Charge points"). There is no per-user pricing and no provider cost column.

## Data model

Migration `migrations/0142_user_package_prices.sql`. Use the next free number at implementation time.

```sql
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
  package_id uuid NOT NULL,
  old_price  numeric(10,2),          -- null = no custom price before
  new_price  numeric(10,2),          -- null = custom price removed
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
```

Row-level security (RLS) is enabled on both tables. Users may `SELECT` their own `user_package_prices` rows. All writes go through the service role in the admin API. The audit table is readable by the service role only.

Match `packages.id` and `users.id` column types to the live schema at implementation time.

## Price resolver: `lib/pricing/package-price.ts`

The resolver is pure where possible. It is the only place the price rule lives.

```ts
type PricedPackage = { id: string; price: number; dealer_price: number | null }

/** Existing rule, unchanged: dealer (and admin, where shop code already does so) gets dealer_price when > 0. */
export function rolePrice(role: string, pkg: PricedPackage): number

/** custom ?? rolePrice */
export function effectivePrice(role: string, pkg: PricedPackage, custom: number | null | undefined): number

/** One query for a user's custom prices. Throws on a read error (callers on a charge path refuse the request). */
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
- No stored margin is rewritten. Removing a custom price reverts the owner to normal profit with nothing to undo.

If `cost > role` (a custom price above the role price), the profit formula lowers the owner's profit. The admin screen warns about this case. It is allowed, but it can never make a shop's selling price change.

## Admin API and UI

- `GET /api/admin/users/[id]/custom-prices` returns every available data package with `price`, `dealer_price` and `custom_price` (or null). It is admin only.
- `PUT /api/admin/users/[id]/custom-prices` takes `{ prices: [{ package_id, price: number | null }] }`, where `null` removes a custom price. It is admin only and validated as a whole: a price must be a number with at most 2 decimals, > 0 and ≤ 10000, and the package must exist. One bad row rejects the whole request with per-row errors. The write upserts or deletes the rows and adds an audit row for each change.
- Admin → Users gets a "Custom prices" action per user that opens a dialog grouped by network. Each row has a price input, and a Clear button removes a custom price. Saving sends one `PUT`.
  - The dialog warns, without blocking, about a price below the dealer price ("may be below cost") and a price above the user's role price ("reduces this user's shop profit").
- The dialog sits behind a feature flag (`custom_prices_enabled` in admin settings) until rollout step 3 is done.

## Errors

- Charge path: if `getCustomPrices` fails, the request is refused with a "temporarily unavailable, try again" error and nothing is debited. It never falls back to the role price, which could overcharge a user who has a lower custom price.
- Display path: if the read fails, the role price is shown with a notice that prices may not be the user's latest.
- Custom prices are read once per request and never cached across requests. An admin's change applies to the very next purchase.

## Testing

- Resolver unit tests: role price, a custom price winning over the role price, a dealer with no or zero `dealer_price`, and `getCustomPrices` throwing.
- Each charge point: a user with a custom price is charged the custom price, and a user without one is charged exactly as before.
- Shops and sub-agents: the selling price is unchanged and the owner's (or parent's) profit increases by `role − cost`, including on stock purchases.
- Admin API: non-admins get 403, plus validation errors, removing a price with null, and audit rows written.
- Guard test: no file outside `lib/pricing/package-price.ts` reads `dealer_price` to choose a price. The allow-list covers admin editors and the bulk price tool.

## Rollout

1. Add the migration and resolver, then move every charge point onto `rolePrice`/`effectivePrice` with no custom prices present. Existing tests must pass unchanged, since behaviour does not change.
2. Add the admin API, audit log and dialog, with the dialog hidden behind the flag.
3. Switch on custom-price lookups at the charge points group by group, each group with its tests. When every group is done, turn on the flag.
