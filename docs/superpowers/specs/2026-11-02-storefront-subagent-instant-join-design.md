# Storefront sub-agent instant join: design

Date: 2026-11-02
Status: draft, awaiting owner approval

## Why

Today a storefront visitor who wants to become a sub-agent fills in a request form, waits for the shop owner to approve it, receives a 7-day invite link by SMS or email, and only then signs up at `/join/[code]`. People are lost in that wait. The owner wants a visitor to click and sign up as a sub-agent under that shop, with no request and no link to wait for.

## Goals

1. Every eligible main shop has a permanent public join page, reached from "Join Now" on its storefront.
2. New people sign up there directly. Logged-in customers without a shop join by entering only a shop name.
3. Each new sub-agent gets their own USSD code automatically.
4. A new sub-agent logs in and sets prices before their shop opens.
5. Opening signup to the public doesn't give away cheaper rates or create a cheap way to mass-produce shops.

## Non-goals

- Sub-agents recruiting their own sub-agents. Pricing and profit sharing only handle one parent layer.
- Owners screening joiners. There is no approval step and no per-shop opt-out.
- Moving an existing shop under another shop.
- Changing data bundle pricing.

## Anti-goals: a failure even if it technically works

- A customer joins for free just to pay dealer rates on their own airtime and bills.
- A bot creates hundreds of live shops, burns the short USSD codes, or runs up SMS costs through owner alerts.
- A customer reaches an empty shop, or a USSD menu that shows products the web storefront doesn't.
- A closed shop can take an order on any channel.
- An unpriced shop appears in the admin shop approval queue.

## Decisions made by the owner

| Topic | Decision |
|---|---|
| Owner control | Instant for every shop, with no approval and no opt-out |
| Existing accounts | A logged-in customer with no shop can join and keeps their wallet and history. Shop owners, dealers and admins can't join |
| Rates | Storefront joiners pay customer rates on their own airtime, bills and cashback until their owner turns dealer rates on. Existing sub-agents keep theirs |
| Verification | New accounts verify their phone with a code on the join page, as normal signup does, and confirm their email before the shop goes live |
| Where signup happens | A dedicated join page |
| USSD | They get their own USSD code |
| Prices | They log in to set prices. Storefront and USSD stay closed until prices are saved, then open together |
| Owner has no catalog prices | They can still join. The owner gets SMS, email and push |
| Owner has catalog prices | The owner gets a push about the new recruit, and nothing else |
| Sub-agent storefronts | No recruiting card or slide. A direct visit to that shop's join link shows a polite message |
| Admin approval | Storefront joiners skip it. The shop opens when prices are saved, and admins review afterwards from a list of recent joiners and can block any of them |
| Dealer-rate switch | Only owners who are on dealer rates themselves can turn it on. New private-invite sub-agents under other owners start on customer rates. Existing sub-agents keep their current rates |

## The flow

### New person

1. They click "Join Now" on the storefront carousel slide or the About tab card, which replaces `SubAgentRequestForm`.
2. They land on `/join/shop/<handle>`, which shows the benefits, including their own USSD code, the wholesale prices and the form: name, email, phone, password, shop name.
3. They submit and see "Check your email". The join intent is stored server-side. No shop or USSD code exists yet.
4. They click the email link. The account is confirmed, and the sub-agent shop and USSD code are created. The owner is alerted.
5. They log in and land on the set-prices step.
6. They save prices and the shop opens. A final screen shows their USSD code, dial instructions and storefront link.

### Logged-in customer with no shop

They see the same page with a "Welcome back" heading and only the shop name field. Submitting changes their role to `sub_agent`, creates the shop and USSD code, alerts the owner and goes to the set-prices step. There's no email step because they already have an account.

### Who is refused

- Logged in and already owns a shop, or is a dealer or admin: a clear message, and no change to the account.
- Target shop is a sub-agent, or is inactive or blocked: a polite "This shop isn't taking sub-agents" page.
- Email or phone already registered, while logged out: prompt to log in, then continue the join.

### Owner has no catalog prices

The new sub-agent has nothing to price, so they see "Waiting for your shop owner to add products" and the shop stays closed. "Has catalog prices" means at least one active `sub_agent_catalog` row for an available package. When the owner adds catalog prices, waiting sub-agents get a push and in-app notice to come and set theirs.

## What the code does today, and what it means here

These findings shape the design. Paths are as of branch `feat/api-v2-console`.

**Signup route.** `POST /api/shop/invites/[code]` has no captcha or rate limit, because a private code protected it. It also sets `email_confirm: true`, and it continues after a failed `users` or `wallets` write. The new route can't reuse it as it stands. Move the shared account and shop creation into a `lib/` function and give the new route its own guards.

**The approval queue is keyed on `is_active`.** `/api/shop/create` forces `is_active=false`, and `/api/admin/shops` treats `is_active=false` as pending. An unpriced sub-agent shop therefore can't be represented with `is_active=false` alone, or it would land in the admin approval queue and could be approved without prices. Use a separate field for "prices not yet set".

**Prices.** The invite route copies rows into `shop_packages`, but a sub-agent's prices live in `sub_agent_shop_packages`, which is what `/api/shop/public-packages` reads (see the comment at `app/dashboard/shop-pricing/page.tsx:31-34`). The new flow shouldn't copy into `shop_packages`.

**Channels disagree.** With no `sub_agent_shop_packages` rows, the USSD menu falls back to the parent's `sub_agent_catalog` (`lib/ussd-shop/handlers/shop.ts:51-58`, `lib/shop-commerce/shop-code.ts:98-113`), while the web fallback reads the catalog under the sub-agent's own shop id. The closed check applies to unpriced storefront joiners. It must live in one shared place and be applied on every channel that can sell for a shop: web storefront, web checkout and order creation, both USSD menus (Uzo and Hubtel), the WhatsApp shop bot, and the airtime and results-checker storefront routes. The builder should sweep for all entry points rather than trust this list.

**Dealer rates follow the role.** `sub_agent` counts as dealer tier at `lib/airtime-service.ts:353` and `lib/bills/runtime.ts:16`, and in `lib/ai-tools.ts` and `app/dashboard/airtime/page.tsx` for quotes and display. Commission cashback shares follow the same tier. Dashboard data pricing is `dealer` only (`app/dashboard/data-packages/page.tsx:180`), so it isn't affected. Replace the role checks with one shared helper, and sweep with grep and `pg_proc` for others.

**USSD codes.** `provisionShopCode` in `app/api/dashboard/ussd-shop/activate/route.ts:14` already generates a unique code, and migration 0121's trigger opens a new code for free while the fee is 0. Move it to `lib/` and reuse it. Read the dial code from settings, never hardcode it.

**Subdomains and custom domains.** `middleware.ts` rewrites `<sub>.datagod.store/*` to `/shop/<sub>/*`, so "Join Now" has to link to the join page on the main domain. Keep honouring the `sub_agent_recruit` hidden-page setting used by custom domains (`lib/custom-domain-pages.ts`).

**Recruiting gaps today.** `PATCH /api/shop/sub-agent-requests/[id]` has no role check, so a sub-agent could technically approve a request and create an invite. Close this while here, and refuse requests against sub-agent shops.

**Removing a sub-agent.** `/api/shop/sub-agents/[id]` sets `parent_shop_id` to null and `tier_level` to 1, leaving the shop active. With open signup, someone could end up with an independent active shop that no admin reviewed. The builder should check what a removed storefront joiner ends up as, and leave them closed if they would otherwise become an unreviewed main shop.

**Sub-agents can set their own wholesale cost.** `POST` and `PUT /api/shop/sub-agent-catalog` store `parent_price` from the request body, and order pricing trusts it (`lib/shop-commerce/pricing.ts:188-189`, `app/api/shop/orders/create/route.ts:326-328`). A sub-agent can lower what they pay by calling the route directly. The server must derive this value. It's fixed first and ships on its own, because it's live today and open signup would expose it to anyone.

**Normal signup verifies the phone.** The join page reuses `/api/auth/send-phone-otp` and `/api/auth/verify-phone-otp`, and the server checks the verified code when the form is submitted. A join finalizes through its own intent rather than `/api/auth/signup`, because the email link can be clicked after that route's 30-minute code window. The closed shop is `is_active=false` plus `joined_via='storefront'` and `prices_set_at IS NULL`, which reuses every channel's existing `is_active` check, and the admin queue excludes those shops.

## Data changes

Field names are the builder's choice.

- On `user_shops`: how the sub-agent joined (`storefront` or `invite`), whether dealer rates are on, and when prices were first set.
- Existing sub-agents: backfill so dealer rates stay on and the shop counts as already priced. Nothing changes for them.
- New sub-agents from private invite links: dealer rates on only if the inviting owner is on dealer rates, otherwise customer rates. This applies once the new code ships, regardless of the admin setting below, because it closes an existing loophole.
- Join intents: a store for the pending shop name and target shop between signup and email confirmation. Don't trust `user_metadata` for role or parent, because users can edit it themselves.
- Owner alert throttle: a record that makes the throttle below enforceable.

## Owner experience

- `/dashboard/sub-agents` lists each sub-agent with how they joined. Owners on dealer rates (`dealer` or `admin` role, checked on the server) see a dealer-rates switch on storefront joiners. It starts off. Owners on customer rates don't see it, and the server refuses the change.
- Existing sub-agents and private-invite sub-agents have no switch. Their rate is fixed when they join, so an owner can't take away rates someone already has.
- Alerts fire only after a sub-agent is real: on email confirmation for new accounts, on join for upgrades.
- Pending requests already in the queue can still be approved or rejected. Private invite links stay.

## Safety

Every item is the builder's to test.

- **At scale:** Turnstile, honeypot and an IP rate limit on the join route, reusing `lib/turnstile` and `applyRateLimit`. The shop and USSD code are only created after email confirmation.
- **Owner alert cost:** at most one SMS and one email per owner per 24 hours for the no-catalog alert, however many people join. Push can batch or repeat. Without this, a public form becomes a way to spend SMS credit and spam an owner.
- **Twice:** double clicks and replayed confirmations must not create two shops or two codes, and must not change a shop that already exists.
- **Someone else's:** the dealer-rate switch derives the owner from the session and only changes their own sub-agents. Parent shop is resolved server-side from the handle via `shopHandleOrFilter`. Role is set only on the server.
- **Cheaper:** a new joiner's airtime and bills quote at customer rates, on every channel. The sub-agent's own cost for data remains catalog-based.
- **Logs:** no phone numbers, emails or passwords.

## Rollout

Ship dark behind an admin setting that defaults to off. While off, storefronts keep the current request form. Follow the project's production change protocol: dry-run the migration and backfill, get approval, apply, verify, build, then a supervised live test on a real shop before turning it on. This touches money and auth, so it needs a fresh reviewer before merge.

Build on its own branch from `main`, not on `feat/api-v2-console`. Note that `lib/post-auth-redirect.ts` and the related `lib/auth.ts` changes are uncommitted on that branch, so don't assume they exist on `main`.

## Calls made by the designer

The owner can overrule any of these.

- Permanent URL shape `/join/shop/<handle>`.
- A 24-hour throttle on no-catalog SMS and email alerts.
- "Open" is a one-time latch set when a sub-agent first saves at least one priced package. It doesn't re-check on every request, which keeps USSD fast, and a later catalog change doesn't close the shop.
- Scope of the price gate: it covers storefront joiners only. Private-invite signups keep today's behaviour, including their auto-confirmed email and their USSD fallback to the parent catalog, and so do existing sub-agents, so nothing they sell today changes. The shared `lib/` function should fix failed `users` and `wallets` writes for both routes. Bringing invites under the gate is a possible follow-up.
- Waiting sub-agents are told when the owner adds catalog prices.
- The storefront request form and its public endpoint retire when the feature is switched on.
- USSD code issued at email confirmation, or at join for upgrades. If the activation fee is later above 0, the code waits until they pay from the dashboard, and the join page shouldn't promise it as free.
- The wholesale prices shown on the public join page come from the owner's sub-agent catalog, so anyone can see them.
- A closed shop's USSD and storefront message avoids "data" and "bundle" wording, per the USSD rebrand.

## Left to the builder

Field and table names, the join-intent storage, how the email link carries the join through confirmation, the set-prices screen's reuse of `/dashboard/shop-pricing`, and how "Save" opens the shop. New pages use the navy accent and need `lg:` desktop layouts.

## Admin review after joining

Normal new shops wait for admin approval (`/api/shop/create` forces `is_active=false`). Storefront joiners skip this, so admins get a list of recent storefront joiners showing the shop, parent shop and join date, with the existing block action (`is_blocked`). Logged-in upgrades have no email step, so they rely on login, the rate limit and this list. Don't add caps unless the supervised test shows a need.
