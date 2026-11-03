# Storefront Sub-Agent Instant Join Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a storefront visitor click "Join Now" and sign up as a sub-agent under that shop, with their own USSD code and a shop that opens once they set prices, without giving away cheaper rates or a cheap way to mass-produce shops.

**Architecture:** A closed joiner shop is `is_active=false` plus `joined_via='storefront'` and `prices_set_at IS NULL`. Every selling channel already filters on `is_active`, so the gate is reused rather than rebuilt, and the admin approval queue is changed to exclude these shops. New signups store a server-side join intent that is finalized when the email link is confirmed. Dealer rates move behind one helper that reads a per-shop flag.

**Tech Stack:** Next.js 15 App Router, Supabase (Postgres, Auth, service-role routes), Vitest with the fake-client pattern from `lib/shop-commerce/pricing.test.ts`.

**Spec:** `docs/superpowers/specs/2026-11-02-storefront-subagent-instant-join-design.md`

## Global Constraints

- Build in a worktree on a new branch from `main`. `lib/auth.ts`, `lib/auth-complete.ts` and `lib/post-auth-redirect.ts` have uncommitted changes on `feat/api-v2-console`; don't assume those exist.
- Everything ships dark behind `sub_agent_open_join_enabled`, default off. The exception is the private-invite rate rule in Task 4, which applies as soon as the code ships.
- Sub-agent costs always come from `subAgentCosts` or `subAgentCost` in `lib/shop-commerce/pricing.ts`. Never read a stored `parent_price`.
- No production access during Tasks 2-10: write migrations and selftests only. Dry run, apply, push and merge happen in Task 11 with the user's OK.
- Use the next free migration number above the highest on `main` and in the production database; check both, because the numbers may differ.
- Edit code with Edit/Write only, never `sed`.
- Handles go through `shopHandleOrFilter`. Role and parent are never read from `user_metadata` or the request body.
- Logs carry no phone numbers, emails or passwords.
- Customer-facing USSD text avoids "data" and "bundle". Web pages use the navy `--primary` accent, and new pages need `lg:` desktop layouts.
- Before pushing to `main`: `npm run test:run`, `npx tsc --noEmit`, a real placeholder-env `next build`, and check local `main` for other sessions' commits. Follow the production change protocol for every migration: precheck, self-rolling-back dry run, user OK, apply, verify. Nine order-health test failures are already known; anything else is new.
- Fresh reviewer required before merge: money, auth, schema and gate removal.

## Review Focus

Each line has its test in the owning task.

1. The confirmation email link is clicked twice, or the join form is double-submitted: one shop, one code, one alert (Tasks 4, 6).
2. The target shop gets blocked or becomes inactive between signup and email confirmation: no shop is created, and the person keeps a plain customer account (Task 6).
3. The same phone is typed as `0241234567` and `241234567`: treated as one number (Task 6).
4. Ten people join an owner with no catalog in a day: one SMS, one email (Task 7).
5. A joiner saves a zero-profit price: allowed, and the shop opens; a row with a negative margin doesn't count as priced (Task 8).

---

### Task 1: Stop sub-agents and owners setting their own wholesale cost

Retired, no work needed. Already fixed on `origin/main` by #27: `subAgentCosts` in `lib/shop-commerce/pricing.ts` prices every sub-agent channel live, never reads the stored `parent_price`, and order paths refuse negative margins through `marginsValid`. The save route still stores what it's sent, but nothing reads the value.

### Task 2: Schema, settings and column protection

**Files:**
- Create: `migrations/NNNN_storefront_subagent_join.sql`, `migrations/NNNN_storefront_subagent_join.selftest.sql`
- Modify: `app/api/public/config/route.ts`, `app/api/admin/settings/route.ts`

**Interfaces:**
- Produces on `user_shops`: `joined_via text NULL CHECK (joined_via = 'storefront')`, `prices_set_at timestamptz NULL`, `dealer_rates_enabled boolean NOT NULL DEFAULT true`, `sub_agent_setup_alert_at timestamptz NULL`. Default `true` means existing sub-agents change in no way, so no backfill.
- Produces table `sub_agent_join_intents`: `user_id uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE`, `parent_shop_id uuid NOT NULL REFERENCES user_shops ON DELETE CASCADE`, `shop_name text NOT NULL`, `first_name text`, `last_name text`, `phone text NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`, `consumed_at timestamptz`. RLS on, no policies, no grants to `anon` or `authenticated`.
- Produces `app_settings.sub_agent_open_join_enabled boolean NOT NULL DEFAULT false` on the singleton row (`.is("key", null)`), exposed read-only through `/api/public/config` and writable through admin settings.

- [ ] **Step 1: Write the selftest** that rolls itself back and raises on failure: an existing sub-agent reads `dealer_rates_enabled = true`, a logged-in user can't read `sub_agent_join_intents`, and a logged-in owner can't change `is_active`, `joined_via`, `prices_set_at` or `dealer_rates_enabled` on their own shop.
- [ ] **Step 2: Write the migration,** numbered 0146 or the next free number, including a `BEFORE UPDATE` trigger on `user_shops` that rejects changes to those four columns when `auth.role()` is `authenticated` or `anon`. Service-role routes and migrations are unaffected. Read `migrations/0145_shop_buyers_audience.sql` for the current style.
- [ ] **Step 3: Add the setting** to the two settings routes, with a focused test if those routes have tests.
- [ ] **Step 4: Run** `npx tsc --noEmit`. Expected: no new errors. The migration isn't run in this task.
- [ ] **Step 5: Commit** with `feat(shop): schema for storefront sub-agent join`.

### Task 3: One helper for dealer rates

**Files:**
- Create: `lib/sub-agents/dealer-rates.ts`, `lib/sub-agents/dealer-rates.test.ts`
- Modify: `lib/airtime-service.ts:353`, `lib/bills/runtime.ts:12-17`, `lib/ai-tools.ts:1792,1914`, `app/dashboard/airtime/page.tsx:136,441`
- Test: `lib/airtime-service.test.ts`

**Interfaces:**
- Produces: `getDealerRateTier(db, userId: string): Promise<"customer" | "dealer">`. `dealer` role is dealer. `sub_agent` is dealer unless their shop has `dealer_rates_enabled = false`. A sub-agent with no shop row is dealer, matching today. Everyone else is customer. Throws on a read error, as `getBuyerTier` does now.

- [ ] **Step 1: Write failing tests:** the four role cases above, and in `lib/airtime-service.test.ts`, "a sub_agent with dealer rates off pays the customer fee and customer cashback share". Keep the existing "sub_agent counts as dealer tier" tests passing with the flag on.
- [ ] **Step 2: Run** `npx vitest run lib/sub-agents lib/airtime-service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the helper and replace each listed check.** `getBuyerTier` delegates to it. The airtime page reads `dealer_rates_enabled` from the user's own shop for its quote and label.
- [ ] **Step 4: Sweep:** `grep -rn "sub_agent" app lib`, then query `pg_proc` for functions mentioning `sub_agent`. Route anything that grants a dealer rate through the helper. Data pricing checks that use `dealer` only stay as they are.
- [ ] **Step 5: Run** `npx vitest run lib/sub-agents lib/airtime-service.test.ts lib/bills`. Expected: PASS.
- [ ] **Step 6: Commit** with `feat(shop): per-shop dealer rate flag for sub-agents`.

### Task 4: Shared shop creation and USSD code issuing

**Files:**
- Create: `lib/sub-agents/create-shop.ts`, `lib/sub-agents/create-shop.test.ts`, `lib/ussd-shop/provision-code.ts`
- Modify: `app/api/shop/invites/[code]/route.ts:204-319`, `app/api/dashboard/ussd-shop/activate/route.ts:14-32`

**Interfaces:**
- Produces: `provisionShopCode(db, shopId: string)`, moved unchanged. `createSubAgentShop(db, opts: { userId: string; parent: { id: string; shop_name: string; tier_level: number }; shopName: string; shopSlug: string; via: "storefront" | "invite"; dealerRatesEnabled: boolean }): Promise<{ shopId: string; slug: string; created: boolean }>`. `via: "storefront"` inserts `is_active=false, joined_via='storefront'` and doesn't copy packages. `via: "invite"` inserts `is_active=true` and copies `shop_packages` as today. A unique violation on `user_id` returns the existing shop with `created: false`, without changing it. `makeShopSlug(name: string): string`, the base name plus a random 4-character suffix.

- [ ] **Step 1: Write failing tests:** storefront creates a closed shop with no `shop_packages` insert; invite creates an active shop and copies packages; a duplicate `user_id` returns `created: false` and writes nothing else (Review Focus 1).
- [ ] **Step 2: Run** `npx vitest run lib/sub-agents/create-shop.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement, and move the invite route onto it.** Failed `users` or `wallets` writes in the invite route now fail the request and delete the created auth user, instead of continuing. The route sets `dealerRatesEnabled` from `shopOwnerIsDealer(parent.id)`. It keeps `email_confirm: true` and otherwise behaves the same.
- [ ] **Step 4: Run** `npx vitest run lib/sub-agents`. Expected: PASS.
- [ ] **Step 5: Commit** with `refactor(shop): shared sub-agent creation and code provisioning`.

### Task 5: Who can join, and the join page data

**Files:**
- Create: `lib/sub-agents/join-eligibility.ts`, `lib/sub-agents/join-eligibility.test.ts`, `lib/sub-agents/wholesale-packages.ts`, `app/api/shop/join/[handle]/route.ts`
- Modify: `app/api/shop/invites/[code]/route.ts:57-108`

**Interfaces:**
- Produces: `targetStatus(shop: { is_active: boolean; is_blocked: boolean; parent_shop_id: string | null } | null, enabled: boolean): "open" | "closed"`. `joinerStatus(user: { role: string; hasShop: boolean }): "can_join" | "has_shop" | "not_allowed"`, where `dealer` and `admin` are `not_allowed`, and a shop owner is `has_shop`. `getWholesalePackages(db, parentShopId: string)`, moved from the invite `GET`. `GET /api/shop/join/[handle]` returns `{ status, shop_name, wholesale_packages }`, and `shop_name` only when open.

- [ ] **Step 1: Write failing tests:** each `targetStatus` case (sub-agent shop, blocked, inactive, missing and switch off are all `closed`), each `joinerStatus` case.
- [ ] **Step 2: Run** `npx vitest run lib/sub-agents/join-eligibility.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement,** with the `GET` route and the shared wholesale function.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(shop): join eligibility and join page data`.

### Task 6: Joining: new accounts, logged-in customers and email confirmation

New joiners verify their phone on the join page through the existing `/api/auth/send-phone-otp` and `/api/auth/verify-phone-otp` routes (`purpose: "signup"`). The join `POST` checks the proof when the form is submitted. Normal signup finalizes through `/api/auth/signup`, whose 30-minute code window may have passed by the time the email link is clicked, so join intents must be handled before that path runs.

**Files:**
- Create: `lib/sub-agents/join.ts`, `lib/sub-agents/join.test.ts`
- Modify: `app/api/shop/join/[handle]/route.ts`, `lib/auth-complete.ts`

**Interfaces:**
- Consumes: `targetStatus`, `joinerStatus`, `createSubAgentShop`, `provisionShopCode`, and `notifyOwnerOfRecruit` from Task 7. Build Task 7 before this task.
- Produces: `startJoinIntent(db, input)`. `finalizeJoinIntent(db, userId: string): Promise<{ target: string } | null>`, which returns `null` when no intent exists, and otherwise `{ target: "/dashboard/shop-pricing?setup=1" }`, or `{ target: "/dashboard?join=closed" }` if the shop is no longer open. `normalizePhone(raw: string): string`, the local 10-digit form.
- `POST /api/shop/join/[handle]`, logged out, body `{ first_name, last_name, email, phone, password, shop_name, turnstileToken, website }`, responds `{ status: "confirm_email" }`. With a Bearer token, body `{ shop_name, turnstileToken }`, responds `{ status: "joined", target }`.

- [ ] **Step 1: Write failing tests:**
  - Finalizing twice creates one shop, one code and one alert, and the second returns the same target (Review Focus 1).
  - Target blocked before confirmation: no shop, intent consumed, account stays `user`, target is `?join=closed` (Review Focus 2).
  - `normalizePhone("0241234567") === normalizePhone("241234567")`, and a duplicate in either form is refused (Review Focus 3).
  - A logged-in dealer, admin or shop owner gets 403 with no writes. A logged-in `user` becomes `sub_agent` with `dealer_rates_enabled=false`, keeping wallet rows untouched.
  - The role update is conditional on `role='user'`. If it fails, the just-created shop is deleted.
  - Sign-up returning a user with empty `identities` (already registered) responds with "log in to continue", and creates no intent.
  - A logged-out `POST` with no `phone_otp_verifications` row (`purpose='signup'`, `used=true`, under 30 minutes old) for that phone responds 400 and doesn't call sign-up. A logged-in upgrade needs no code.
- [ ] **Step 2: Run** `npx vitest run lib/sub-agents/join.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `lib/sub-agents/join.ts`.** New users: `signUp` with the anon client on the server, `emailRedirectTo` set to `${origin}/auth/callback`, then insert the intent. `finalizeJoinIntent`: claim the intent by setting `consumed_at` conditionally, re-check target and phone, write the `users` row (`role='sub_agent'`, only if absent or `user`) and wallet, create the shop, provision the code, alert the owner.
- [ ] **Step 4: Add the route handler:** honeypot, then `applyRateLimit(request, "sub_agent_join", RATE_LIMITS.SIGNUP.maxRequests, RATE_LIMITS.SIGNUP.windowMs)`, then Turnstile, then `targetStatus`, and refuse when `signups_enabled` is false. Same user-update call as `update-role` so `user_metadata.role` stays in step.
- [ ] **Step 5: Call `finalizeJoinIntent` first in `resolvePostAuthRedirect`,** and return its target when not `null`. Both `/auth/confirm` and `/auth/callback` pass through there. When the intent was already consumed by an earlier click, return the same target from the existing shop rather than falling through to the OTP path.
- [ ] **Step 6: Run** `npx vitest run lib/sub-agents lib/auth`. Expected: PASS.
- [ ] **Step 7: Commit** with `feat(shop): storefront sub-agent join flow`.

### Task 7: Owner alerts

**Files:**
- Create: `lib/sub-agents/notify-owner.ts`, `lib/sub-agents/notify-owner.test.ts`
- Modify: `lib/sms-service.ts` (template), `lib/email-service.ts` (template), `app/api/shop/sub-agent-catalog/route.ts`

**Interfaces:**
- Produces: `notifyOwnerOfRecruit(db, parentShopId: string, recruitShopName: string): Promise<void>`, which never throws. `notifyWaitingSubAgents(db, parentShopId: string): Promise<void>`. `SMSTemplates.subAgentCatalogNeeded(shopName: string)`, `EmailTemplates.subAgentCatalogNeeded(shopName: string, catalogUrl: string)`.

- [ ] **Step 1: Write failing tests:** with catalog prices, one push and no SMS or email. With none, push, SMS and email. Ten calls in a day with none: one SMS, one email (Review Focus 4), and the next day's call sends again. A failed SMS doesn't throw.
- [ ] **Step 2: Run** `npx vitest run lib/sub-agents/notify-owner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** "Has catalog prices" means at least one active `sub_agent_catalog` row for an available package. The throttle claims atomically: `UPDATE user_shops SET sub_agent_setup_alert_at = now() WHERE id = ? AND (sub_agent_setup_alert_at IS NULL OR sub_agent_setup_alert_at < now() - interval '24 hours') RETURNING id`, sending SMS and email only when a row returns.
- [ ] **Step 4: In the catalog route,** after an owner's first active catalog row is saved, call `notifyWaitingSubAgents`, which pushes to closed storefront joiners under that shop.
- [ ] **Step 5: Run** the same test. Expected: PASS.
- [ ] **Step 6: Commit** with `feat(shop): owner alerts for storefront recruits`.

### Task 8: Opening the shop, the closed state and the admin queue

**Files:**
- Create: `lib/sub-agents/open-shop.ts`, `lib/sub-agents/open-shop.test.ts`, `app/api/shop/open-after-pricing/route.ts`
- Modify: `app/api/admin/shops/route.ts:23-27`, `app/api/admin/shops/approve/route.ts`, `app/api/shop/sub-agents/[id]/route.ts:47-50`, the admin shops page, `lib/ussd-shop/handlers/shop.ts:31`, `app/shop/[slug]/` not-found branch

**Interfaces:**
- Produces: `openPricedShop(db, userId: string): Promise<{ status: "opened" | "already_open" | "no_prices" | "blocked"; ussdCode?: string; subdomain?: string }>`. `getShopPublicState(handle: string): Promise<"open" | "setting_up" | "missing">`.

- [ ] **Step 1: Write failing tests:**
  - `openPricedShop`: no saved rows gives `no_prices`; only negative-margin rows, or rows the parent no longer offers per `subAgentCosts`, also give `no_prices`; a zero-margin row opens (Review Focus 5); opening twice gives `already_open` without a second write; a blocked shop stays closed. An invite or main shop isn't changed.
  - Admin `status=pending` excludes `joined_via='storefront'`, and approve refuses a closed storefront joiner.
  - Removing a storefront joiner sets `parent_shop_id=null, tier_level=1, is_active=false, joined_via=null, dealer_rates_enabled=false`, which puts them in the normal admin queue. Removing an invited sub-agent behaves as it does today.
  - `status=storefront_joiners` lists recent joiners, newest first, with their parent shop.
- [ ] **Step 2: Run** `npx vitest run lib/sub-agents/open-shop.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Open with a conditional update on `prices_set_at IS NULL AND is_blocked = false`, setting `is_active=true` and `prices_set_at=now()`. Update the comment in the removal route, which currently says it never touches `is_active`.
- [ ] **Step 4: Sweep the sell paths.** Confirm each of these filters on `is_active` or gets `status` from `resolveShopCode`: `app/api/shop/orders/create`, `payments/initialize`, `shop/airtime/initialize`, `shop/airtime/public-constraints`, `shop/afa/initialize`, `shop/results-checker/initialize`, `shop/results-check/initialize`, `shop/orders/search`, `public/shop-ussd-code`, `lib/storefront-commission/shop.ts`, `lib/ussd-hubtel/shop-services.ts`, `lib/ussd-shop/handlers/shop.ts`, `lib/whatsapp-bot/shop-router.ts`, `lib/ai-tools.ts:1219,1515`. Add a test and a fix for any that don't. The storefront shows "This shop isn't open yet" for `setting_up`.
- [ ] **Step 5: Add a "Recent storefront joiners" view** to the admin shops page, using the existing block action.
- [ ] **Step 6: Run** `npx vitest run lib/sub-agents lib/shop-commerce lib/ussd-shop lib/ussd-hubtel lib/whatsapp-bot`. Expected: PASS.
- [ ] **Step 7: Commit** with `feat(shop): open joiner shops once priced, keep them out of approvals`.

### Task 9: Join page, storefront button and request form

**Files:**
- Create: `app/join/shop/[handle]/page.tsx`, `lib/sub-agents/join-url.ts`, `lib/sub-agents/join-url.test.ts`
- Modify: `app/shop/[slug]/storefront-client.tsx:157,229-236,1120-1124,1740-1750`, `app/api/shop/sub-agent-requests/route.ts`, `app/api/shop/sub-agent-requests/[id]/route.ts`

**Interfaces:**
- Produces: `joinShopUrl(handle: string): string`, always on the main domain (`NEXT_PUBLIC_APP_URL`), so it works from subdomain and custom-domain storefronts.

- [ ] **Step 1: Write failing tests:** `joinShopUrl` is absolute and on the main domain. Request `POST` refuses a sub-agent shop, and refuses all shops when the switch is on. `PATCH` approve refuses an owner whose role is `sub_agent`, whatever the switch. Pending requests can still be approved or rejected with the switch on.
- [ ] **Step 2: Run** `npx vitest run lib/sub-agents/join-url.test.ts app/api/shop/sub-agent-requests`. Expected: FAIL.
- [ ] **Step 3: Implement the routes and the page.** The page follows the approved mockup: offer list including "Your own USSD code customers can dial", wholesale prices and the form. New joiners enter the code sent to their phone before they can submit, using the same send and verify calls as `app/auth/signup/page.tsx:192,221`. It shows the short "Welcome back" form when logged in, the "Check your email" state after submitting, and the refusal messages from Task 5. Add Turnstile and the honeypot, reusing `TurnstileWidget` and `HoneypotField`.
- [ ] **Step 4: Change the storefront.** When `shop.parent_shop_id` is set, hide the card and slide regardless of the switch. When the switch is on, the slide's CTA becomes "Join Now" and links to `joinShopUrl`, and the About card replaces `SubAgentRequestForm`. When off, the form stays. Keep honouring `subAgentRecruitHidden`.
- [ ] **Step 5: Run** the tests, then check the page at 500px and desktop width with headless Chrome. Expected: PASS, with no horizontal scroll.
- [ ] **Step 6: Commit** with `feat(shop): storefront join page and Join Now button`.

### Task 10: Set-prices step and owner dashboard

**Files:**
- Create: `lib/sub-agents/rate-switch.ts`, `lib/sub-agents/rate-switch.test.ts`
- Modify: `app/dashboard/shop-pricing/page.tsx`, `app/dashboard/sub-agents/page.tsx`, `app/api/shop/sub-agents/[id]/route.ts`, `app/api/shop/sub-agent-stats/route.ts`

**Interfaces:**
- Consumes: `openPricedShop`.
- Produces: `canSetDealerRates(ownerRole: string, target: { parent_shop_id: string | null; joined_via: string | null }, ownerShopId: string): boolean`, true only for `dealer` or `admin` owners, and a target that is their own storefront joiner. `PATCH /api/shop/sub-agents/[id]` with `{ dealer_rates_enabled: boolean }`.

- [ ] **Step 1: Write failing tests:** `canSetDealerRates` is false for a `user` owner, another owner's sub-agent, an invited or existing sub-agent, and true for a dealer owner's storefront joiner. The owner shop comes from the session, never the request.
- [ ] **Step 2: Run** `npx vitest run lib/sub-agents/rate-switch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the check and `PATCH` handler.** The stats route returns `joined_via` and `dealer_rates_enabled`.
- [ ] **Step 4: Update `/dashboard/sub-agents`:** show how each sub-agent joined, and the switch only where the owner is on dealer rates and the row is a storefront joiner.
- [ ] **Step 5: Update `/dashboard/shop-pricing?setup=1`.** Closed joiners see "Set your prices" with a "Save and open my shop" button calling `/api/shop/open-after-pricing`, then the final screen with the USSD code, the dial code from settings and the storefront link. With no parent catalog, they see "Waiting for your shop owner to add products". If the activation fee is above 0, the final screen sends them to `/dashboard/ussd-shop` to activate instead of showing the code as ready.
- [ ] **Step 6: Run** tests, then check both pages at 500px and desktop width. Expected: PASS.
- [ ] **Step 7: Commit** with `feat(shop): set-prices step and owner dealer-rate switch`.

### Task 11: Go-live checks

- [ ] **Step 1: Run** `npm run test:run`, `npx tsc --noEmit` and a placeholder-env `next build`. Expected: only the 10 failures recorded at baseline (9 order-health plus the `0142 place_api_v2_order` drift test).
- [ ] **Step 2: With the user's OK,** query live `pg_proc` for functions mentioning `sub_agent` and confirm none grants a dealer rate by role. Then run the migration's dry run through the Management API, apply it, and verify the columns exist.
- [ ] **Step 2c: Read-only, report to the user before merging:** count shops with `is_active=false` that took orders in the last 30 days, on any channel. Task 8 gated 8 public sell routes that previously ignored `is_active`, so those shops would stop selling.
- [ ] **Step 2b: With the user's OK,** update the Supabase signup confirmation email template so its `/auth/confirm` link ends with `&rt={{ .RedirectTo }}`. The exact link is in the Task 6 report. Without it, the join nonce never arrives and joins fall back to the normal signup path. Also confirm the Supabase redirect allow-list accepts the join redirect URL.
- [ ] **Step 2a: Fresh reviewer, then merge dark, with the user's OK.** Confirm with the switch off that storefronts still show the request form and `/join/shop/<handle>` shows the closed message.
- [ ] **Step 3: Supervised test with the user, on one real shop, with the switch on:** a new email through to an open shop, a USSD dial on both menus, and a real low-value order. A logged-in customer upgrade. A no-catalog owner receives SMS, email and push. A closed shop refuses an order on every channel. A joiner gets customer rates on airtime and bills. Then switch off until the user decides.
- [ ] **Step 4: Update memory** with a project note for this feature and any production findings from Task 1.
