# Blocked MTN Numbers: tracking, re-check, alerts — Design

Date: 2026-11-15. Status: implemented, dark.

## Intent

When the admin switch "Block unverified numbers" is on, an MTN recipient that
none of the selected whitelist providers approves is refused at checkout on
every ordering surface. Today that refusal leaves no trace: the customer is
turned away, the shop owner never learns a sale was lost, and nobody can tell
when a supplier later starts allowing the number.

This feature records every refusal, re-checks refused numbers on a schedule
against the same provider list checkout uses, shows the results to admin and
to the shop owner whose shop refused them, texts the customer once their
number is ready, and lets admin export the open list to hand to a supplier.

Why now: block rate is unknown, every block is a lost sale, and the owner
has asked for visibility plus a way to bring those customers back.

## How it works today (verified 2026-11-15 on origin/main and prod)

- The gate is `verifyRecipientsForOrder()` /
  `isRecipientBlocked()` in `lib/mtn-providers/customer-verification.ts`.
  It reads `admin_settings.customer_verification_settings`
  (`{ enabled, providers, block_unverified }`), asks the selected providers in
  the admin's order, caches definite verdicts (`lib/mtn-providers/verdict-cache.ts`:
  approvals forever, rejections 10 minutes, keyed by the ordered provider
  list), and returns `{ verdicts, blocking, blocked }`. It never throws and
  outages never block.
- Prod settings right now: checkout verification ON, `block_unverified` ON,
  providers `agentportalgh → kuntanii → bundleportal`. The older
  fulfillment-time gate (`mtn_whitelist_enabled`) is OFF and the registration
  gate is OFF, so no orders are held anywhere (0 `held_registration` rows).
- Twelve call sites enforce the block (all on `origin/main`):
  `app/api/shop/orders/create` (storefront), `app/api/orders/purchase`
  (dashboard single), `app/api/orders/create-bulk` (dashboard bulk),
  `app/api/v1/orders`, `lib/api-v2/endpoints/data-deps.ts` (API v2),
  `lib/ussd-hubtel/router.ts` + `confirm-note.ts` (Hubtel USSD main and shop
  flows), `lib/ussd/handlers/bundles.ts` (Uzo USSD main),
  `lib/ussd-shop/handlers/bundles.ts` + `confirm-by-text.ts` (Uzo USSD shop),
  `lib/whatsapp-bot/shop-router.ts` (WhatsApp shop bot), `lib/ai-tools.ts`
  (AI ordering, two sites), `lib/text-to-buy/catalogue.ts` and
  `lib/text-to-buy/services/airtime.ts` (Text-to-Buy).
- The web surfaces (storefront, dashboard single, dashboard bulk) call the
  public preview `POST /api/verify-phone-live` BEFORE the create route. With
  blocking on, the client hard-stops at the preview and the create route is
  never reached for that number. So the preview endpoint is where most web
  blocks actually happen; the create routes are the backstop.
- Nothing is persisted on a block. The storefront route logs one console
  warning with the shop id. The dealer bulk form offers a "Copy numbers"
  button. That is the entire audit trail today.
- An older tracker exists and is dormant: `mtn_number_registry.whitelist_status`
  (`allowed` / `blocked` / `exhausted`, migration 0092) written by the
  fulfillment-time gate, re-checked by `app/api/cron/mtn-whitelist-retry`
  (3 tries, 24h apart, then `exhausted`). Prod: 97,201 allowed, 72,519
  blocked, 66,402 unchecked, 0 exhausted. Every blocked row has
  `whitelist_retry_count = 0` and the newest check is 2026-10-19; no run
  appeared in production logs on 2026-11-15. The cron appears not to be
  firing. Separate issue, flagged, not fixed by this design.
- The two gates use different provider lists. The dormant cron checks all
  six registry providers (xpress, codecraft, agentportalgh, apexprime,
  bundleportal, kuntanii). A "now allowed" verdict for checkout must use the
  checkout list, or the customer would be blocked again.
- Volumes (30 days to 2026-11-15): storefront shop orders 6,548; USSD shop
  orders 9,375; dealer dashboard orders 4,966; USSD main 817; active shops
  1,346. Block rate: unknown.

## Goals

1. Record every positive block with where it happened (surface), which shop,
   who was buying when known, and what they tried to buy.
2. Re-check open blocked numbers on a schedule against the checkout provider
   list; detect the flip to allowed.
3. Admin page: see, filter, re-check, export, mark handled; daily digest and a
   spike alert.
4. Shop-owner page: see numbers blocked on their own shops, their status, and
   export; be told when a customer's number becomes ready.
5. Customer SMS, sent by the platform automatically, once per flip, with a
   "buy again" link to the shop where they were blocked.
6. Ship dark behind switches; enable in a supervised sequence.

## Non-goals

- Changing the block decision itself, its provider order, or its fail-open
  contract.
- Reviving or redesigning the dormant fulfillment-time whitelist cron
  (flagged separately).
- Owner-paid or owner-triggered customer SMS (owner chose platform-sent).
- WhatsApp or email alerts to customers (SMS only in v1; WhatsApp warm-window
  sends can be added later through the existing outbox pattern).
- Texting a dealer's end customers. Dealer-surface blocks (dashboard
  single, bulk, API v1/v2) are shown to the dealer and alert the dealer
  only (owner decision 2026-11-15).
- Non-MTN networks.

## Anti-goals (would make this a failure even if it "works")

- Telling a customer their number is ready when checkout would still block
  it (provider-list mismatch).
- Adding latency or a new failure mode to checkout. Recording must never
  block, slow, or throw into the order path.
- Leaking one shop's customer numbers to another shop, or any number to the
  browser without an owner-derived server check.
- Spamming customers: more than one SMS per flip, or an SMS to a number that
  is still blocked.
- Logging phone numbers in Vercel logs.

## Constraints

- Branch off `origin/main` (the block toggle, PRs #25, #26, #29, lives there;
  the current working branch `feat/api-v2-console` predates it). Use a
  worktree; the main working tree has many uncommitted changes.
- Next migration number is `0182` (verify on branch creation).
- Tables that hold customer phones follow the registry model: RLS enabled,
  `REVOKE ALL` from `anon` and `authenticated`, service-role only. The 0060
  default grant is closed with both the revoke and a role-scoped policy.
- Owner routes derive the shop list from the session user
  (`user_shops.user_id = auth user`), never from a client-supplied shop id
  alone. Pattern: `app/api/shop/manage/route.ts` (`assertOwnsShop`).
- SMS copy never names the network; use `networkColor("MTN")` like
  `SMSTemplates.mtnRegistrationHold`. One GSM segment (160 chars), same
  guarantee as `lib/sms/shop-order-confirmation.ts`.
- Crons: route wrapped in `backgroundCron`, auth via `verifyCronAuth`, entry
  in `lib/cron-migration/crons.json` and Batch A in `lib/cron-migration/jobs.ts`,
  scheduled on cron-job.org via `scripts/sync-cronjob-org.ts`. A `crons.json`
  entry alone schedules nothing.
- PostgREST calls through the service role inherit an 8 s statement timeout;
  every cron query needs an index and a `LIMIT`.
- Every new sidebar item gets a NEW tag via `lib/nav-new.ts`.
- Logs may carry counts and error class names, never phone numbers.

## Approaches considered

1. **Log and export only.** Record attempts, ship the admin page with export.
   No cron, no alerts. Cheapest, reveals the block rate within days, but the
   recovered revenue (customer comes back once allowed) needs the re-check
   and the SMS.
2. **Full loop (chosen).** Record, scheduled re-check against the checkout
   provider list, admin page, owner page, platform-sent customer SMS, owner
   in-app notice, exports. All plumbing (SMS, notifications, crons, admin
   settings, owner-derived routes) already exists.
3. **Revive the registry and its cron.** Extend `mtn_number_registry`'s
   whitelist columns and repair `mtn-whitelist-retry`. Fewer tables, but it
   entangles two gates with different provider lists, the registry has no
   shop or surface link so the owner page would need a side table anyway,
   and that cron is currently dead for reasons not yet understood.

Owner picked approach 2 on 2026-11-15, and picked "platform sends the
customer SMS automatically, Datagod pays".

## Design

### 1. Settings and switches

New `admin_settings` key `blocked_numbers_settings`:

```json
{ "enabled": false, "customer_sms_enabled": false,
  "retention_days": 30, "spike_threshold_per_hour": 25,
  "daily_sms_ceiling": 300 }
```

- `enabled` (default OFF): gates recording and the re-check cron. OFF means
  the feature is invisible and writes nothing.
- `customer_sms_enabled` (default OFF): gates the customer "number ready"
  SMS. Flip only after the first supervised flip is observed.
- `retention_days`: how long a blocked number stays open before it expires
  (default 30).
- `spike_threshold_per_hour`: distinct blocked numbers in a rolling hour
  that trigger the admin spike alert.
- `daily_sms_ceiling`: hard cap on "number ready" SMS per UTC day (cost
  guard; the cron stops sending for the day when reached and the digest
  says so).

The settings object is read through a 60-second in-process memo (same idea
as the SMS routing config cache) so the recorder adds no `admin_settings`
round-trip on the checkout path.

Route `GET/POST /api/admin/settings/blocked-numbers` (admin-only, same
validation style as `customer-verification/route.ts`). UI: a card on
`/admin/settings/mtn` directly under the "Customer verification" card, with a
link to the admin page.

### 2. Data model (migration `0182_mtn_blocked_numbers.sql`)

`mtn_blocked_numbers` — one row per canonical phone (`0XXXXXXXXX`):

| column | notes |
|---|---|
| id uuid pk | |
| phone text unique | canonical via `normalizeGhanaPhone` |
| status text | CHECK in (`blocked`, `allowed`, `expired`, `handled`) |
| first_blocked_at, last_blocked_at timestamptz | |
| attempts int | deduped attempts (see §3) |
| providers_rejected text[] | ordered checkout provider list at the last block |
| recheck_count int, last_rechecked_at, next_recheck_at timestamptz | |
| expires_at timestamptz | `first_blocked_at + retention_days` |
| allowed_at timestamptz, allowed_by text | provider that approved on the flip |
| customer_notified_at timestamptz, customer_notify_phone text, notify_attempts int | |
| submitted_to_supplier text, submitted_at timestamptz | set by the export dialog |
| handled_at timestamptz, handled_by uuid, notes text | admin |
| last_surface text, last_shop_id uuid | denormalised for list views |
| created_at, updated_at | |

Indexes: `(status, next_recheck_at)` partial where `status = 'blocked'`;
`(status, customer_notified_at)` partial where `status = 'allowed'`;
`(last_shop_id, last_blocked_at desc)`.

`mtn_blocked_attempts` — one row per deduped attempt:

| column | notes |
|---|---|
| id uuid pk | |
| blocked_number_id uuid | FK → `mtn_blocked_numbers(id)` ON DELETE CASCADE |
| phone text | denormalised, indexed |
| surface text | CHECK in (`storefront`, `storefront_preview`, `dashboard`, `dashboard_preview`, `dashboard_bulk`, `dashboard_bulk_preview`, `api_v1`, `api_v2`, `ussd_hubtel`, `ussd_hubtel_shop`, `ussd_uzo`, `ussd_uzo_shop`, `whatsapp_shop`, `whatsapp_ai`, `text_to_buy`, `text_to_buy_airtime`, `unknown`) |
| shop_id uuid null | `user_shops.id` when the surface belongs to a shop |
| user_id uuid null | dealer or API-key owner when authenticated |
| purchaser_phone text null | dialler / WhatsApp sender / storefront payment phone when known |
| product text null | e.g. `MTN 2GB`; amount numeric null |
| created_at timestamptz | |

Indexes: `(shop_id, created_at desc)`, `(phone, created_at desc)`,
`(created_at)`.

Both tables: RLS on, `REVOKE ALL` from `anon`, `authenticated`; policies for
`service_role` only. Attempts older than 90 days are purged by the cron
(they carry purchaser phones). Blocked-number rows are kept.

All reads go through service-role routes; no RPC is needed.

### 3. Recording

Add an optional `context` to the gate:

```ts
type BlockContext = {
  surface: BlockSurface
  shopId?: string | null
  userId?: string | null
  purchaserPhone?: string | null
  product?: string | null
  amount?: number | null
}
verifyRecipientsForOrder(phones, { ..., context?: BlockContext })
isRecipientBlocked(network, phone, context?: BlockContext)
```

When `blocked.length > 0` and `blocked_numbers_settings.enabled`, call
`recordBlockedRecipients(blocked, context ?? { surface: "unknown" },
settings.providers)` from a new `lib/blocked-numbers/record.ts`. Rules:

- Bounded: the whole record step races a 1,000 ms timeout and never throws.
  The block path is the failure path; a short wait there is acceptable,
  and a record that is lost on timeout is logged as a count only. Where a
  caller already has a deferred-work hook (Hubtel USSD's `deps.defer`), the
  record step runs there instead of inline.
- `purchaserPhone` is trusted only from server-verified sources: the USSD
  dialler (carrier-supplied), the WhatsApp sender (Meta-supplied), the
  Text-to-Buy sender (SMS-forwarder supplied). Web surfaces (storefront,
  dashboard, bulk) and the preview endpoint NEVER accept a purchaser phone
  from the request body; for them `purchaser_phone` is null and any SMS
  goes to the blocked number itself. Reason: the preview endpoint is public,
  so a body-supplied purchaser phone would let anyone make Datagod text a
  victim on each flip.
- Dedupe: no new attempt row if the same `(phone, surface, shop_id)` was
  recorded in the last 10 minutes (the storefront checks on blur and again
  on submit; the preview and the create route can both fire). `attempts`
  counts deduped attempts.
- Upsert the number row: insert with `status = 'blocked'`, or on conflict
  bump `last_blocked_at`, `attempts`, `providers_rejected`, `last_surface`,
  `last_shop_id`. A row in `allowed`, `expired` or `handled` that is blocked
  again returns to `blocked` with a fresh `expires_at`, `recheck_count = 0`,
  `next_recheck_at = now() + 1 day`, `customer_notified_at = null`.
- The preview endpoint `POST /api/verify-phone-live` gains optional body
  fields `surface` (validated against the enum, only the `_preview` values
  accepted from the browser) and `shop_slug` (resolved server-side to a
  `user_shops.id`; unknown slug → no shop). Recording happens only when a
  number is positively blocked AND `blocking` is on. The three web clients
  send these fields. Abuse budget: the existing 20/min/IP rate limit, the
  dedupe window, and the fact that a fake number still costs the caller a
  real provider rejection.
- Each of the twelve server-side call sites passes its real context. What
  each knows today:
  - storefront create: `shop_id`, customer phone, package, price.
  - dashboard purchase / bulk: auth `user_id`, package, price.
  - API v1 / v2: API-key owner `user_id`, package.
  - Hubtel USSD: dialler (`session.msisdn`), shop id in the shop flow
    (`session.shopId`), package.
  - Uzo USSD main / shop: `session.dialingPhone`, `session.shopId`, bundle.
  - WhatsApp shop bot: sender (`from`), `session.shopId`, bundle.
  - AI ordering (`lib/ai-tools.ts`): WhatsApp sender, `shop.shopId`.
  - Text-to-Buy: sender, shop id on the shop line, product.
- The whole-branch review must check all twelve sites pass a surface other
  than `unknown`.

### 4. Re-check cron and state machine

Route `GET /api/cron/mtn-blocked-recheck`, daily at 06:30 UTC, Batch A,
wrapped in `backgroundCron`, `maxDuration = 300`. Steps:

1. Skip entirely when `blocked_numbers_settings.enabled` is false.
2. Expire: `status = 'blocked' AND expires_at < now()` → `expired`.
3. Select up to 2,000 rows `status = 'blocked' AND next_recheck_at <= now()`
   ordered by `next_recheck_at`.
4. Run `resolveVerdicts(phones, …)` with the current
   `customer_verification_settings` (the checkout list, the admin's order,
   strict batch calls) and a 60 s timeout, in chunks of 500. Result per
   phone: `true` allowed, `false` still rejected, `null` unchecked.
   - `null` (outage/timeout): leave the row untouched; it is retried next run.
   - `false`: `recheck_count += 1`, `last_rechecked_at = now()`,
     `next_recheck_at = now() + (recheck_count < 7 ? 1 day : 7 days)`.
   - `true`: `status = 'allowed'`, `allowed_at = now()`, `allowed_by` =
     approving provider (extend `checkCustomerFacingVerification` to return
     `approvedBy` per phone; small, tested change), then
     `setCachedVerdicts(new Map([[phone, true]]), providers)` so the next
     checkout answers instantly. Verified 2026-11-15: `getCachedVerdicts`
     reads the permanent approval key first and only falls back to the
     rejection key, so a live 10-minute rejection is overridden the moment
     the approval is written. No delete helper is needed.
5. Notify (same run, bounded): for `status = 'allowed' AND
   customer_notified_at IS NULL AND notify_attempts < 3`, up to 300 rows per
   run: send the customer SMS (§5) when `customer_sms_enabled`, then the
   owner in-app notice (§6). Set `customer_notified_at` on a successful or
   skipped-by-switch send; bump `notify_attempts` on failure.
6. Purge attempts older than 90 days (chunked delete, `LIMIT 5000`).
7. Spike check (§7).

Admin "Re-check now": `POST /api/admin/blocked-numbers/recheck` with
`{ ids?: string[] }` (≤ 500) or `{ all: true }` (first 2,000 due or expired
rows) runs the same `recheckBlockedNumbers()` from
`lib/blocked-numbers/recheck.ts` and returns `{ checked, allowed,
stillBlocked, unchecked }`. Expired rows are re-opened when explicitly
re-checked.

### 5. Customer SMS ("number ready")

- Sent by the platform, paid by Datagod, through `sendSMS` with
  `type: "mtn_number_ready"`, `reference` = the blocked-number id.
- Eligible surfaces: only those where the customer typed the number
  themselves: storefront (and its preview), Hubtel USSD main and shop, Uzo
  USSD main and shop, WhatsApp shop and AI ordering, Text-to-Buy. Dealer
  dashboard single and bulk, API v1 and v2 are NOT eligible by default:
  those numbers belong to a dealer's end customers who never dealt with
  Datagod, and one bulk paste could fan out into hundreds of texts. The
  eligibility list is a constant in `lib/blocked-numbers/sms.ts`. Owner
  decision 2026-11-15: dealer surfaces are excluded; the dealer is alerted
  instead (§6b).
- Recipient: the server-verified `purchaser_phone` from the latest eligible
  attempt when present (USSD dialler, WhatsApp sender, Text-to-Buy sender),
  otherwise the blocked number itself. Stored in `customer_notify_phone`.
- Copy, built by `lib/sms/number-ready.ts` with the same one-segment
  guarantee and tests as the shop confirmation builder:
  - With a shop: `DTGOD: 024XXXXXXX is now ready for {networkColor} data on
    {shop name}. Buy again: {short shop link}` (shop link from the same
    builder the shop confirmation SMS uses; shortened or dropped if it would
    overflow).
  - Without a shop (dealer, API, main USSD, Text-to-Buy main line):
    `DTGOD: 024XXXXXXX is now ready for {networkColor} data. Dial {main USSD
    code} or visit datagod.store`. The USSD code comes from the admin
    settings already used by the SEO pages.
- Once per flip. Three caps, all enforced in the notify step:
  1. Per blocked number: at most 2 ready-SMS in any 90 days, tracked by
     `ready_sms_count` + `ready_sms_window_start` on the number row.
  2. Per notify phone: at most 2 ready-SMS in any 90 days to the same
     `customer_notify_phone`, checked with a count over
     `mtn_blocked_numbers` rows that share that notify phone and were
     notified in the window (indexed `(customer_notify_phone,
     customer_notified_at)`). This closes the "text a victim repeatedly via
     many blocked numbers" path.
  3. Global: `daily_sms_ceiling` per UTC day.
- Never sent while `status != 'allowed'`.

### 6. Shop owner

**Notification.** One number can be blocked at several shops, so the
notice is driven by attempts, not by the number row's `last_shop_id`. In
the same cron step, for each newly allowed number, collect every
`shop_id` with an attempt inside the retention window, resolve
`user_shops.user_id`, and insert one in-app notification per shop per run
through `notificationService.createNotification` (type `order_update`,
title "Customer numbers ready", message "N customer number(s) blocked on
{shop} are now ready." with ", we've texted them to buy again." appended
only for the shop whose link was in the SMS, `action_url` to the owner
page). The customer SMS links to the shop of the latest eligible attempt.
No owner SMS or email in v1.

**Page.** A separate dashboard page `/dashboard/blocked-numbers` (owner
asked for a separate page rather than a tab), added to the dealer sidebar
in `lib/dashboard-nav-items.ts` and registered in `lib/nav-new.ts` for the
NEW tag. The page has two sections, shown only when relevant to the user:
"My shops" (this section, for users who own a shop) and "My orders" (§6b,
for dashboard/API blocks under the user's own account). Every per-row
figure the owner sees in "My shops" is computed from
THAT shop's own attempts: first tried, last tried, attempts, what they
tried to buy. Only the status comes from the shared number row, with owner
labels Waiting for activation / Ready / Expired (no "texted" label for
owners, since the text may have linked to another shop). Plus a "Copy
message" button that copies a WhatsApp-ready text the owner can send
manually. Filters: status, date
range. Export: xlsx of the owner's rows. Empty state explains the feature
when `enabled` is off.

**Route.** `GET /api/shop/blocked-numbers?status=&from=&to=&page=` and
`GET /api/shop/blocked-numbers/export`. Owner-derived: shops where
`user_shops.user_id = session user` (sub-agent shops the user owns are
included because they are the user's own rows; a parent does NOT see
sub-agents' numbers in v1). Joins attempts → numbers, filtered by
`attempts.shop_id IN (owner's shops)`. Service role, RLS bypass by design,
ownership enforced in the route. Paginated, 50 per page, bounded export
(10,000 rows).

**Dashboard tile.** On `/dashboard/shop-dashboard`, a small count "Customers
waiting on number activation" linking to the page. Builder may fold this
into the Customers page header instead.

### 6b. Dealer (account owner) for dashboard and API blocks

Owner decision 2026-11-15: numbers blocked on the dealer dashboard
(single or bulk) or through API v1/v2 are the dealer's own customers.
Datagod never texts them. Instead:

- **"My orders" section** on `/dashboard/blocked-numbers`: rows where
  `mtn_blocked_attempts.user_id = session user`, with the same per-row
  figures computed from the user's own attempts (first tried, last tried,
  attempts, surface: Dashboard / Bulk / API, product) and the status labels
  Waiting for activation / Ready / Expired. Export xlsx (bounded 10,000
  rows). A "Copy numbers" button for the Ready rows so the dealer can paste
  them straight into the bulk form.
- **Route** `GET /api/user/blocked-numbers?status=&from=&to=&page=` and
  `/export`, session-derived (`user_id` from the auth session only).
- **Alert to the account owner** when any of their numbers flips to
  allowed: one in-app notification per user per cron run ("N of your
  blocked numbers are now ready for data; open Blocked numbers to re-order")
  plus a push through the existing `sendPushToUser` path. No SMS or email
  in v1.
- Dealer-surface attempts never trigger the customer SMS (§5) even if the
  same number was also blocked on a shop surface; the shop attempt decides
  that on its own.

### 7. Admin

**Page** `/admin/blocked-numbers`, sidebar link next to "MTN Registration"
with a NEW tag (`lib/nav-new.ts` + the hand-wired `<NewTag>` pattern used by
`/admin/sms`).

- Tiles: Open (blocked), Became allowed (7 d), Customers texted (7 d),
  Expired, Blocked attempts (24 h), Attempts by surface (7 d, small table).
- Table (server-paginated, 50/page): phone, status, first/last blocked,
  attempts, surfaces (chips), shop name(s), providers rejected, last
  re-check, allowed by, submitted to supplier, texted. Search by phone or
  shop; filters: status, surface, shop, date range.
- Row/bulk actions: Re-check now, Mark handled (with note), Re-open.
- Exports (admin-only, both added to `HEAVY_ADMIN_OPERATIONS`):
  - **Full report** xlsx: all columns above, filtered as the table.
  - **Supplier list** xlsx: a single `Phone` column of open blocked numbers
    in local `0XXXXXXXXX` format, the same shape as the MTN Registration
    export, for handing to AgentPortalGH, Kuntanii or Bundle Portal. The
    dialog has a supplier dropdown and a checkbox "Mark these numbers as
    submitted to {supplier}" which sets `submitted_to_supplier` /
    `submitted_at`. The table then shows "Submitted to X (3 d ago)" so
    numbers still blocked long after submission stand out.
- **Daily digest** at the end of the cron through the admin-actions
  notifier deps (`notifyAdminsEmail` + `notifyAdminsPush`): "Yesterday:
  N blocked attempts (M numbers, top surfaces …), K became allowed, S
  customers texted, E expired." Counts only, no phones.
- **Spike alert**: a lightweight check in the recorder: after each insert,
  if DISTINCT blocked numbers in the last 60 minutes exceed
  `spike_threshold_per_hour` and no spike alert was sent in the last 6
  hours (`admin_settings` key `blocked_numbers_last_spike_alert_at`), send
  one admin push + email. Counting distinct numbers rather than attempts
  blunts a single bot replaying one number. This is a rough heuristic by
  design: the cheapest detector for a provider returning false rejections
  (the AgentPortalGH polarity bug class). The daily digest is the precise
  picture; a block-rate denominator (total checks) is deliberately not
  recorded in v1.

**Settings card** on `/admin/settings/mtn` (§1).

### 8. Security and abuse pass

- Free / someone else's: both tables service-role only; owner routes derive
  shops from the session; admin routes use `verifyAdminAccess`; cron routes
  use `verifyCronAuth`.
- Twice: SMS idempotency via `customer_notified_at` plus the 90-day cap;
  attempt dedupe window; re-check is idempotent.
- Cheaper / no-auth: the preview endpoint's new fields are validated and
  only record positive rejections while blocking is on; rate limit stays.
- At scale: partial indexes, `LIMIT`s on every cron query, chunked provider
  calls, 90-day attempt purge, bounded exports.
- PII: logs carry counts and error class names only; exports are gated and
  heavy-op rate-limited; the owner page shows only the owner's rows.
- Business invariants untouched: no order row, wallet, or payment path is
  modified; the block decision is unchanged.

### 9. Rollout (ship dark)

1. Merge; apply migration 0182 with the usual precheck → dry run → apply.
2. Register the cron on cron-job.org via the sync script; confirm the first
   run in Vercel logs.
3. Flip `enabled` ON. Watch the admin page fill for 24–48 h; sanity-check the
   block rate and the surface breakdown against expectations.
4. Export a supplier list, hand it over, wait for the first flips.
5. After the first observed flip with a correct `allowed_by`, flip
   `customer_sms_enabled` ON and watch the first few sends.
6. Announce to shop owners and dealers (channel announcement, "Post now").

Rollback: `enabled` OFF stops recording and the cron; nothing else changes.

### 10. Testing

Logic lives in `lib/blocked-numbers/` and is unit-tested with the fake-client
pattern (`reference-testing`): dedupe window, upsert transitions
(blocked → allowed → blocked again), schedule and expiry arithmetic,
`resolveVerdicts` → state mapping including `null`, SMS copy stays within
one segment with and without a shop link, owner scoping (a shop id outside
the owner's set is never returned), spike detection with the 6 h cooldown,
and that the preview endpoint rejects non-`_preview` surfaces from the
browser. The migration gets a PGlite self-test like `0181_*.selftest.sql`.
Each call-site change has a test asserting the context passed.

## Left to the builder

- Exact file layout under `lib/blocked-numbers/` and the admin/owner page
  component structure (follow `/admin/mtn-registration` and
  `/dashboard/customers` conventions; desktop multi-column from the start).
- Whether the owner dashboard tile lives on `shop-dashboard` or the
  Customers header.
- How `approvedBy` is threaded out of `checkCustomerFacingVerification`
  without changing its public result shape for existing callers.
- Chunk sizes inside the cron as long as every query stays under the 8 s
  PostgREST timeout.

## Builder check (2026-11-15) and resolutions

A fresh reviewer read the draft cold and raised five questions.

1. **Who can the platform text, and how is that abuse-capped?** Settled
   (author's call): purchaser phone is trusted only from carrier/Meta/
   forwarder-verified sources; web surfaces never accept one and text the
   blocked number itself; three caps (per number, per notify phone, global
   daily ceiling). See §3 and §5.
2. **One number row, several shops.** Settled (author's call): owner page
   figures come from that shop's own attempts; every shop with an attempt
   in the window gets the "ready" notice; the SMS links to the latest
   eligible shop; owners never see a "texted" label. See §6.
3. **Should the SMS go out for dealer dashboard, bulk and API blocks?**
   Owner decided 2026-11-15: no. Dealer blocks get their own section on the
   dealer's Blocked numbers page and alert the account owner only (§6b).
4. **Spike alert noise.** Settled: distinct numbers per hour, 6 h cooldown,
   documented as a rough heuristic. See §7.
5. **Settings read on the checkout path.** Settled: 60 s in-process memo,
   1,000 ms record bound, deferred where the caller already defers. See §1
   and §3.
