# Mobile App v2 — Push Notifications, Withdrawals, Modern Buttons

**Date:** 2026-06-12
**Status:** Approved by owner
**Scope:** The Expo app in `mobile/` (SDK 55). Server-side additions live in the
Next.js web app but change no existing behavior.

## Context

v1 shipped the dealer dashboard (login, home, data, airtime, wallet, orders,
profile) on Expo SDK 55, reskinned to the web's "Modern Fintech" tokens. The
owner wants full web parity eventually; this was decomposed into phases:

- **v2 (this spec):** push notifications + in-app feed, shop withdrawals,
  ultra-modern button system
- **v3:** shop dashboard & sub-agents
- **v4:** results checker + remaining parity (AFA, transactions, complaints, …)

## Constraints discovered during design

1. **Expo Go cannot receive remote pushes** (SDK 53+ limitation). All push
   client code must fail silently in Expo Go. Real pushes activate when the
   owner later creates a development build (Android dev-build APK is free via
   EAS; iOS requires an Apple Developer account).
2. **Mobile talks to production** (`https://www.datagod.store`). The withdrawal
   endpoints exist on branch `feat/moolre-withdrawal-integration`; the mobile
   withdrawal flow works on-device only after that branch deploys.
3. Withdrawals are **shop-scoped** (shop owners withdraw shop earnings), not
   general wallet withdrawals.

## Part 1 — Push notification infrastructure

### Data

New table `device_push_tokens`:

| column | type | notes |
|---|---|---|
| id | uuid pk default gen_random_uuid() | |
| user_id | uuid not null references auth.users | |
| token | text not null unique | Expo push token (`ExponentPushToken[…]`) |
| platform | text not null | `ios` / `android` |
| device_name | text | from `expo-device` |
| created_at | timestamptz default now() | |
| last_seen_at | timestamptz default now() | bumped on re-register |

RLS: owners can select/insert/delete their own rows. The dispatch route uses the
service-role client.

### Server (new API routes)

- `POST /api/push/register` — Bearer-authed (same `auth.getUser(token)` pattern
  as all user routes). Upserts `{token, platform, device_name}` for the caller;
  bumps `last_seen_at`. `DELETE` with a token body removes it (logout).
- `POST /api/push/dispatch` — called by a **Supabase database webhook** on
  `notifications` INSERT. Auth: shared secret in a header
  (`x-push-webhook-secret`), compared against env `PUSH_WEBHOOK_SECRET`; fails
  closed if unset. Reads the inserted row (`record.user_id`, `title`,
  `message`, `type`), fetches that user's tokens, POSTs to
  `https://exp.host/--/api/v2/push/send` (batched, max 100/request). Tokens
  rejected as `DeviceNotRegistered` are deleted. Always returns 200 to the
  webhook (errors logged, never retry-stormed).

### One-time config (manual, documented in the plan)

- Supabase dashboard: Database Webhook on `public.notifications` INSERT →
  `https://www.datagod.store/api/push/dispatch` with the secret header.
- Vercel env: `PUSH_WEBHOOK_SECRET`.
- EAS project (`eas init`, free) so `getExpoPushTokenAsync({projectId})` can
  mint tokens in dev builds; `extra.eas.projectId` lands in `app.json`.

### Mobile

New `mobile/src/lib/push.ts`:

- `registerForPush()` — called after login and on app start when a session
  exists. Requests permission, gets the Expo token, POSTs to
  `/api/push/register`. Every step wrapped: permission denied, Expo Go throw,
  or network failure → silent no-op.
- `unregisterPush()` — called before logout; best-effort DELETE.
- Foreground handler: banner + badge via `expo-notifications` default handler.
- Tap routing: notification `data.type` → route (`order_update`→`/orders`,
  `payment_success`/`balance_updated`→`/wallet`, `withdrawal_*`→`/withdrawals`,
  else `/notifications`).

New dependency: `expo-notifications` (SDK 55-matched via `expo install`).

## Part 2 — In-app Notifications screen

- **Entry point:** bell icon + unread-count badge in the Home screen header
  (the tab bar stays at six tabs). Opens stack screen `/notifications`.
- **Data:** direct Supabase reads from the `notifications` table with the
  mobile client — the same user-scoped queries
  `lib/notification-service.ts` runs on the web (list newest-first limit 100,
  mark-as-read, mark-all-read, delete, unread count). RLS already permits this
  (the web does it client-side today).
- **UI:** card list matching the web page — type icon, title, message,
  relative time, unread dot; pull-to-refresh; "Mark all read" header action;
  swipe-or-button delete. Empty state: "No notifications yet."
- Unread badge on the Home bell refreshes on focus.

Fully testable in Expo Go immediately.

## Part 3 — Withdrawals (shop owners)

- **Eligibility:** on Wallet tab focus, look up `user_shops` for the session
  user. No shop → no new UI (v2 adds no upsell).
- **Shop earnings card** (Wallet tab, below balance): shop available balance
  (replicate the web's `shopService.getShopBalance` query/RPC), buttons
  **Withdraw** and **History**.
- **Withdraw screen** (stack route `/withdraw`):
  1. Method picker: MTN MoMo / Telecel / AT / Bank (same methods as web).
  2. Account entry. Bank method first loads the bank list from
     `GET /api/user/withdrawals/banks` into a picker.
  3. **Validate** via `POST /api/user/withdrawals/validate-account` — shows the
     resolved account name; the submit button stays disabled until validation
     succeeds (fail closed).
  4. Amount entry with fee preview fetched from `GET /api/settings/fees`;
     net-amount shown before submit.
  5. Submit `POST /api/user/withdrawals/create`
     `{shopId, amount, withdrawal_method, account_details}` → success state
     ("Request submitted — pending admin approval").
- **History screen** (stack route `/withdrawals`): list the user's
  `withdrawal_requests` (replicating `withdrawalService.getWithdrawalRequests`)
  with amount, net, method, date, and the shared `StatusBadge`.
- Errors: server messages surfaced verbatim in alerts (the create route returns
  domain validation messages as 400s).

## Part 4 — Ultra-modern button system

Rebuild `Button` in `mobile/src/components/ui.tsx` (API unchanged — same
props, so all call sites keep working):

- **primary:** indigo→violet `LinearGradient` fill (same pair as the wallet
  hero), white bold label.
- **secondary** (new): soft indigo fill (`primary` at 10% alpha) with indigo
  label — the web's soft-fill look.
- **danger / ghost:** kept, restyled to the same geometry.
- **Press feel:** scale-to-0.97 spring animation (`Pressable` + RN `Animated`;
  no new dependency — Reanimated is available but plain Animated suffices),
  plus `expo-haptics` light impact on press-in (silently skipped on web).
- **States:** inline `ActivityIndicator` when `busy`; 50% opacity when
  disabled.

New dependency: `expo-haptics` (SDK 55-matched).

## Error handling summary

| Failure | Behavior |
|---|---|
| Push permission denied / Expo Go / register network error | Silent no-op |
| Dispatch: invalid webhook secret | 401, no send |
| Dispatch: Expo API partial failure | Log, prune dead tokens, still 200 |
| Withdrawal validate fails | Submit stays disabled, message shown |
| Withdrawal create 400 | Server message in alert |
| Notifications feed query error | Inline error text + pull-to-refresh retry |

## Verification

1. `cd mobile && npx tsc --noEmit` clean; `npx expo export --platform android`
   bundles.
2. Expo Go on device: notifications feed lists/marks/deletes; bell badge
   updates; buttons animate with haptics; withdrawal screens render (submit
   testable after the branch deploys to production).
3. Push end-to-end: deferred to a free Android development build — insert a
   row into `notifications` and confirm device delivery + token pruning.
4. Web app: `npx tsc --noEmit` at root stays at its pre-existing baseline
   (new API routes only).

## Out of scope (v3/v4)

Shop dashboard, sub-agents, results checker, AFA, transactions, complaints,
customers, upgrade flow, USSD shop, Google OAuth, iOS dev build.
