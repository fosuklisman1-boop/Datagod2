# Blocked MTN Numbers Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every MTN number the "Block unverified numbers" gate refuses, re-check them daily against the checkout provider list, and alert admin, shop owners, dealers and (for shop/bot surfaces) customers when a number becomes allowed.

**Architecture:** A fire-and-forget recorder hangs off the shared gate `verifyRecipientsForOrder()` and writes to two service-role-only tables. A daily cron re-runs `resolveVerdicts()` on open numbers, flips allowed ones, warms the verdict cache, and drives a notify step (customer SMS, shop in-app, dealer in-app + push, admin digest). Admin and user pages read through service-role routes that derive scope from the session.

**Tech Stack:** Next.js 15 App Router, Supabase (Postgres 17, service role), Vitest, PGlite for migration self-tests, xlsx, cron-job.org.

**Spec:** `docs/superpowers/specs/2026-11-15-blocked-numbers-tracking-design.md`

## Global Constraints

- Branch from `origin/main` in a new worktree (`feat/blocked-numbers`); copy the spec and this plan in and commit them first. The block toggle (PRs #25/#26/#29) is not on `feat/api-v2-console`.
- Migration number `0182` (re-verify the highest `migrations/0NNN_*` on the branch first). Implementers never apply migrations; prod apply follows the prod change protocol.
- New tables: RLS on, `REVOKE ALL` from `anon` and `authenticated`, no policies, service_role only.
- Settings key `blocked_numbers_settings`, defaults `{ enabled: false, customer_sms_enabled: false, retention_days: 30, spike_threshold_per_hour: 25, daily_sms_ceiling: 300 }`; read through a 60 s in-process memo.
- Recording: positive blocks only, only when `blocking` is on AND `enabled`; bounded by 1,000 ms; never throws; dedupe window 10 minutes on `(phone, surface, shop_id)`.
- `purchaser_phone` only from USSD dialler, WhatsApp sender, Text-to-Buy sender. Web surfaces and `/api/verify-phone-live` never accept one.
- Customer SMS surfaces: `storefront`, `storefront_preview`, `ussd_hubtel`, `ussd_hubtel_shop`, `ussd_uzo`, `ussd_uzo_shop`, `whatsapp_shop`, `whatsapp_ai`, `text_to_buy`, `text_to_buy_airtime`. Never `dashboard*`, `api_v1`, `api_v2`.
- SMS caps: 2 per blocked number per 90 d, 2 per notify phone per 90 d, `daily_sms_ceiling` per UTC day. Exactly one GSM segment. Never name the network: use `networkColor("MTN")`. SMS type `mtn_number_ready`.
- Re-check schedule: next check +1 day while `recheck_count < 7`, then +7 days; expire at `first_blocked_at + retention_days`. A `null` verdict leaves the row untouched.
- Attempts purged after 90 days.
- Logs: counts and error class names only, never phone numbers.
- Every query in a cron or route has an index and a `LIMIT`; PostgREST caps statements at 8 s.
- New sidebar items get a NEW tag (`lib/nav-new.ts`; admin links also need the hand-wired `markClicked` + `<NewTag>` pattern from `/admin/sms`).
- Code edits with Edit/Write tools only, never sed.

## Review Focus

1. **Bulk paste of 500 numbers with 400 blocked** — recorder batches (one upsert, one insert) and stays within 1,000 ms or drops silently. Test in Task 3.
2. **Same number blocked at shop A then shop B, then allowed** — both owners notified, SMS links to B only, each owner's figures come from their own attempts. Tests in Tasks 6 and 8.
3. **Allowed, texted, then blocked again** — row returns to `blocked`, `customer_notified_at` cleared, per-number cap still stops a third SMS within 90 d. Tests in Tasks 3 and 6.
4. **Provider outage during the cron** — every verdict `null`: no row changes, no SMS, result reports `unchecked = n`. Test in Task 5.
5. **Public preview called with a forged `surface: "storefront"` or a `purchaser_phone` field** — non-preview surface is not recorded, purchaser field ignored. Test in Task 4.

---

### Task 1: Migration 0182 and its self-test

**Files:**
- Create: `migrations/0182_mtn_blocked_numbers.sql`
- Create: `migrations/0182_mtn_blocked_numbers.selftest.sql`
- Create: `lib/blocked-numbers/migration-0182.test.ts`

**Interfaces:**
- Produces: tables `public.mtn_blocked_numbers`, `public.mtn_blocked_attempts` with the columns in spec §2 plus `ready_sms_count int NOT NULL DEFAULT 0`, `ready_sms_window_start timestamptz`. Status CHECK (`blocked`,`allowed`,`expired`,`handled`); surface CHECK with the 17 values in spec §2.
- Indexes: `mtn_blocked_numbers(status, next_recheck_at) WHERE status='blocked'`; `(status, customer_notified_at) WHERE status='allowed'`; `(last_shop_id, last_blocked_at DESC)`; `(customer_notify_phone, customer_notified_at)`; `mtn_blocked_attempts(shop_id, created_at DESC)`, `(user_id, created_at DESC)`, `(phone, created_at DESC)`, `(created_at)`, `(blocked_number_id)`.

- [ ] **Step 1: Write the failing test** following `lib/text-to-buy/migration-0181.test.ts` (read via `git show origin/main:`): text checks (one `BEGIN;`, `lock_timeout = '5s'`, one `COMMIT`), `buildRunString` assertions (no COMMIT, no bare `END;`, ends `RAISE EXCEPTION 'SELFTEST_OK 0182...'`), and a PGlite run (skips when PGlite is absent) expecting the error text to start with `SELFTEST_OK 0182`.
- [ ] **Step 2: Run** `npx vitest run lib/blocked-numbers/migration-0182.test.ts`. Expected: FAIL, file not found.
- [ ] **Step 3: Write the migration** with header pre-checks (`to_regclass` of both tables returns NULL), `BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s';`, `CREATE TABLE IF NOT EXISTS`, indexes, `ENABLE ROW LEVEL SECURITY`, `REVOKE ALL ... FROM anon, authenticated`, `GRANT SELECT, INSERT, UPDATE, DELETE ... TO service_role`, `COMMIT;`.
- [ ] **Step 4: Write the self-test DO block** with labelled scenarios: `catalog` (both tables, RLS on, zero policies, each index present), `grants` (none for anon/authenticated; service_role has all four), `check` (status `'bogus'` and surface `'bogus'` raise `check_violation`), `cascade` (deleting a number row deletes its attempts). Ends `RAISE EXCEPTION 'SELFTEST_OK 0182'; END $selftest$;`.
- [ ] **Step 5: Run** the test. Expected: PASS (PGlite case passes or skips).
- [ ] **Step 6: Commit** `feat(blocked-numbers): migration 0182 tables and self-test`.

### Task 2: Settings, types and the settings route

**Files:**
- Create: `lib/blocked-numbers/types.ts`, `lib/blocked-numbers/settings.ts`, `lib/blocked-numbers/settings.test.ts`
- Create: `app/api/admin/settings/blocked-numbers/route.ts`

**Interfaces:**
- `types.ts`: `BLOCK_SURFACES` (the 17 values, `as const`); `type BlockSurface`; `PREVIEW_SURFACES = ["storefront_preview","dashboard_preview","dashboard_bulk_preview"]`; `DEALER_SURFACES = ["dashboard","dashboard_preview","dashboard_bulk","dashboard_bulk_preview","api_v1","api_v2"]`; `SMS_SURFACES` (the 10 in Global Constraints); `type BlockContext = { surface: BlockSurface; shopId?: string|null; userId?: string|null; purchaserPhone?: string|null; product?: string|null; amount?: number|null }`.
- `settings.ts`: `BLOCKED_SETTINGS_KEY = "blocked_numbers_settings"`; `type BlockedNumbersSettings`; `DEFAULT_BLOCKED_SETTINGS`; `parseBlockedSettings(raw: unknown): BlockedNumbersSettings`; `getBlockedNumbersSettings(opts?: { fresh?: boolean }): Promise<BlockedNumbersSettings>` (60 s memo, any error → defaults); `_resetSettingsMemo(): void`.

- [ ] **Step 1: Write failing tests.** `parseBlockedSettings`: `null` → defaults; `{enabled:true}` → enabled, rest default; `retention_days` 0 → 1, 400 → 365; `daily_sms_ceiling: -5` → 0; `enabled: "yes"` → false. Memo: second call within 60 s skips the fake client (`vi.useFakeTimers`); after 61 s reads again; `{fresh:true}` always reads.
- [ ] **Step 2: Run** `npx vitest run lib/blocked-numbers/settings.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both files. Clamp to integers: `retention_days` 1..365, `spike_threshold_per_hour` 1..10000, `daily_sms_ceiling` 0..10000.
- [ ] **Step 4: Implement the route** mirroring `app/api/admin/settings/customer-verification/route.ts`: `GET` → `{ success, settings }`; `POST` type-checks each field, merges with stored (omitted = keep), upserts `admin_settings` with `updated_by`, returns the saved value. Both behind `verifyAdminAccess`. Log only the two booleans.
- [ ] **Step 5: Run** tests. Expected: PASS.
- [ ] **Step 6: Commit** `feat(blocked-numbers): settings and admin settings route`.

### Task 3: Recorder

**Files:**
- Create: `lib/blocked-numbers/record.ts`, `lib/blocked-numbers/record.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces: `recordBlockedRecipients(phones: string[], ctx: BlockContext, providers: string[], deps?: RecordDeps): Promise<{ recorded: number; deduped: number }>` (never throws, races 1,000 ms); pure `planRecord(input: { phones; ctx; now: Date; retentionDays: number; recentKeys: Set<string>; existing: Map<string, ExistingRow> }): { numberUpserts: NumberUpsert[]; attempts: AttemptInsert[]; deduped: number }`; `dedupeKey(phone, surface, shopId?): string`.
- `RecordDeps = { db: SupabaseClient; settings(): Promise<BlockedNumbersSettings>; now(): Date; afterInsert?(n: number): Promise<void> }` (Task 9 wires the spike check here).

- [ ] **Step 1: Write failing `planRecord` tests:**
  - New phone → one upsert `{status:"blocked", attempts:1, recheck_count:0, next_recheck_at: now+1d, expires_at: now+30d, providers_rejected, last_surface, last_shop_id}` and one attempt.
  - Phone with a recent key → zero attempts, `deduped: 1`, upsert bumps `last_blocked_at` but not `attempts`.
  - Existing `allowed` row → `status:"blocked"`, `recheck_count:0`, `customer_notified_at:null`, fresh `expires_at`; `ready_sms_count` untouched.
  - Existing `blocked` row → `attempts: existing+1`; `first_blocked_at` and `expires_at` kept.
  - `"0241234567"` and `"233241234567"` in one call → one upsert for `0241234567`.
  - `"abc"` → dropped.
  - 500 phones → one `numberUpserts` array of 500 and one `attempts` array.
  - `ctx.purchaserPhone` is kept only when `ctx.surface` is not in `PREVIEW_SURFACES` or `DEALER_SURFACES`.
- [ ] **Step 2: Write failing `recordBlockedRecipients` tests** (fake chainable client): `enabled:false` → no DB call; a never-resolving db → `{recorded:0,deduped:0}` after 1,000 ms (fake timers); a throwing db → zeros, and the logged string has no run of 9+ digits.
- [ ] **Step 3: Run** `npx vitest run lib/blocked-numbers/record.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** One `.in("phone", canon)` select for existing rows, one select of attempts in the last 10 minutes, one `upsert(onConflict: "phone")`, re-select ids, one attempts `insert`. Chunk `.in()` at 500.
- [ ] **Step 5: Run.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(blocked-numbers): bounded, deduped recorder`.

### Task 4: Gate context and the preview endpoint

**Files:**
- Modify: `lib/mtn-providers/customer-verification.ts`, `lib/mtn-providers/customer-verification.test.ts`
- Modify: `app/api/verify-phone-live/route.ts`; create `app/api/verify-phone-live/route.test.ts` if absent
- Modify: `app/shop/[slug]/storefront-client.tsx`, `app/dashboard/data-packages/page.tsx`, `components/bulk-orders-form.tsx`

**Interfaces:**
- Consumes: Task 3 `recordBlockedRecipients`.
- Produces: `verifyRecipientsForOrder(phones, opts?: { timeoutMs?; registry?; settings?; context?: BlockContext; defer?: (t: () => Promise<unknown>) => void })` (return shape unchanged); `isRecipientBlocked(network, phone, context?: BlockContext)`; `checkCustomerFacingVerificationDetailed(phones, registry?, settings?): Promise<Array<{ phone: string; verified: boolean; approvedBy: string | null }>>`, with `checkCustomerFacingVerification` becoming a wrapper that drops `approvedBy`.

- [ ] **Step 1: Write failing gate tests:** blocking on + rejecting fake registry + `context:{surface:"storefront", shopId:"s1"}` → mocked recorder called once with `([p], ctx, providers)`; with `defer` passed, recorder goes through `defer` and is not awaited; blocking off → never called; verified number → never called; no context → never called; recorder throwing leaves `blocked` unchanged. Detailed check returns `approvedBy: "kuntanii"` when only the second provider approves.
- [ ] **Step 2: Write failing route tests:** `{phones:[p], surface:"storefront_preview", shop_slug:"abc"}` → recorder context `{surface:"storefront_preview", shopId:<resolved>}`; `surface:"storefront"` or missing → no recording; a `purchaser_phone` body field never reaches the context; unknown slug → `shopId: null`.
- [ ] **Step 3: Run** both. Expected: FAIL.
- [ ] **Step 4: Implement.** After `blocked` is computed: if `blocked.length && opts.context`, `task = () => recordBlockedRecipients(blocked, opts.context, settings.providers)`; `opts.defer ? opts.defer(task) : await task()`. The route resolves `shop_slug` against `user_shops` (`shop_slug` or `subdomain`, active) with a 5-minute memo and passes context only for `PREVIEW_SURFACES` values.
- [ ] **Step 5: Update the three clients** to send `surface` (`storefront_preview` / `dashboard_preview` / `dashboard_bulk_preview`), plus `shop_slug` on the storefront.
- [ ] **Step 6: Run** `npx vitest run lib/mtn-providers app/api/verify-phone-live`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(blocked-numbers): record blocks from the shared gate and the preview`.

### Task 5: Re-check engine and cron

**Files:**
- Create: `lib/blocked-numbers/recheck.ts`, `lib/blocked-numbers/recheck.test.ts`
- Create: `app/api/cron/mtn-blocked-recheck/route.ts`
- Modify: `lib/cron-migration/crons.json` (add `{ "path": "/api/cron/mtn-blocked-recheck", "schedule": "30 6 * * *" }`), `lib/cron-migration/jobs.ts` (Batch A)

**Interfaces:**
- Consumes: `resolveVerdicts`, `getCustomerVerificationSettings`, `checkCustomerFacingVerificationDetailed` (Task 4), `setCachedVerdicts`.
- Produces: pure `nextState(row: { recheck_count: number }, verdict: boolean|null, approvedBy: string|null, now: Date): Patch | null`; `recheckBlockedNumbers(opts: { ids?: string[]; all?: boolean; limit?: number; reopenExpired?: boolean }, deps?): Promise<{ checked; allowed; stillBlocked; unchecked; expired: number; newlyAllowedIds: string[] }>`.

- [ ] **Step 1: Write failing `nextState` tests:** `false`, count 0 → `{recheck_count:1, next_recheck_at: now+1d, last_rechecked_at: now}`; count 6 → `+7d`; `true, "agentportalgh"` → `{status:"allowed", allowed_at: now, allowed_by:"agentportalgh"}`; `null` → `null`.
- [ ] **Step 2: Write failing `recheckBlockedNumbers` tests:** expire step runs first (`expires_at < now` → `expired`); selects `status='blocked' AND next_recheck_at <= now` limit 2000; all-null verdicts → zero updates and `unchecked = n`; allowed phone → `setCachedVerdicts(Map([[phone,true]]), checkoutProviders)`; `{ids, reopenExpired:true}` includes expired rows; resolver receives chunks of at most 500.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement** `recheck.ts`. 60 s resolver timeout per chunk; `approvedBy` captured from the detailed check inside `resolveVerdicts`' `check` hook.
- [ ] **Step 5: Implement the cron route:** `export const GET = backgroundCron("mtn-blocked-recheck", run)`, `maxDuration = 300`, `verifyCronAuth`. Disabled → `{ok:true, skipped:"disabled"}`. Order: recheck → `runNotify()` (Task 6) → purge attempts older than 90 d (limit 5000) → `sendDailyDigest()` (Task 9). Response and log carry counts only.
- [ ] **Step 6: Run.** Expected: PASS.
- [ ] **Step 7: Commit** `feat(blocked-numbers): daily re-check cron`.

### Task 6: Notify step (customer SMS, shop and dealer alerts)

**Files:**
- Create: `lib/sms/number-ready.ts`, `lib/sms/number-ready.test.ts`
- Create: `lib/blocked-numbers/notify.ts`, `lib/blocked-numbers/notify.test.ts`

**Interfaces:**
- Consumes: `readPublicUssdCodes` (`lib/seo/ussd-codes.ts`), `networkColor`, `calculateSegments` (`lib/sms/segments`), `notificationService.createNotification`, `sendPushToUser`, `sendSMS`.
- Produces: `buildNumberReadySms(i: { phone: string; networkLabel: string; shopName?: string|null; subdomain?: string|null; rootDomain: string; mainUssdCode?: string|null }): string`; pure `planNotify(rows, attemptsByNumber, now, settings, sentToday: number, notifyPhoneCounts: Map<string, number>): NotifyPlan` with `NotifyPlan = { sms: Array<{ numberId; to; text }>; shopNotices: Array<{ shopId; count; texted: boolean }>; dealerNotices: Array<{ userId; count }>; skipped: Array<{ numberId; reason: "cap_number"|"cap_phone"|"ceiling"|"sms_off"|"not_eligible" }> }`; `runNotify(deps?): Promise<{ texted; shopNotices; dealerNotices; skipped; failed: number }>`.

- [ ] **Step 1: Write failing builder tests:** shop + subdomain → contains `Buy again: https://<sub>.datagod.store` and `calculateSegments(msg).segments === 1`; a 40-character shop name degrades to the bare host, then no link, always one segment; no shop → contains the main USSD code; no shop and no code → contains `datagod.store`; never contains `MTN`; subdomain `"a.b"` → no link.
- [ ] **Step 2: Write failing `planNotify` tests:**
  - `customer_sms_enabled:false` → no `sms`, reason `sms_off`, shop and dealer notices still planned.
  - latest eligible attempt `ussd_uzo_shop` with purchaser `0551112222` → `to: "0551112222"`.
  - only `dashboard_bulk` attempts → no SMS (`not_eligible`), one dealer notice for that `user_id`.
  - attempts at shop A then B → notices for both, `texted:true` only for B, SMS links B.
  - `ready_sms_count: 2` inside 90 d → `cap_number`; notify phone with 2 in 90 d → `cap_phone`; `sentToday === daily_sms_ceiling` → `ceiling`.
  - three numbers for one dealer → one dealer notice with `count: 3`.
- [ ] **Step 3: Run** both. Expected: FAIL.
- [ ] **Step 4: Implement** the builder (degradation like `lib/sms/shop-order-confirmation.ts`) and `planNotify`.
- [ ] **Step 5: Implement `runNotify`:** select `status='allowed' AND customer_notified_at IS NULL AND notify_attempts < 3` limit 300; load their attempts within retention; count today's texted rows and per-notify-phone counts in 90 d; execute the plan. On send, or any skip reason: set `customer_notified_at = now`. Only on an actual send: set `customer_notify_phone`, increment `ready_sms_count`, reset `ready_sms_window_start` when null or older than 90 d. On send failure: `notify_attempts += 1`. Shop and dealer copy exactly as spec §6 and §6b; dealers also get `sendPushToUser`; `action_url: "/dashboard/blocked-numbers"`.
- [ ] **Step 6: Run.** Expected: PASS.
- [ ] **Step 7: Commit** `feat(blocked-numbers): number-ready SMS and owner/dealer alerts`.

### Task 7: Wire the twelve call sites

**Files (modify, plus each one's existing test file):**
- `app/api/shop/orders/create/route.ts` → `{ surface: "storefront", shopId: shop_id, product: \`${network} ${size}\`, amount: finalTotalPrice }`
- `app/api/orders/purchase/route.ts` → `{ surface: "dashboard", userId, product: \`${network} ${size}\`, amount: price }`
- `app/api/orders/create-bulk/route.ts` → `{ surface: "dashboard_bulk", userId, product: network }`
- `app/api/v1/orders/route.ts` → `{ surface: "api_v1", userId: user.id, product: \`${sanitizedNetwork} ${volumeGb}GB\` }`
- `lib/api-v2/endpoints/data.ts` + `data-deps.ts`: `DataDeps.verifyMtn(locals, ctx?: { userId?: string })`, `realVerifyMtn` passes `{ surface: "api_v2", userId }`
- `lib/ussd-hubtel/flow-kit.ts` (`verifyRecipient(phoneLocal, ctx?: BlockContext)`), `router.ts` (forwards `ctx` and `defer: deps.defer`), `confirm-note.ts` (passes `{ surface: session.shopId ? "ussd_hubtel_shop" : "ussd_hubtel", shopId: session.shopId ?? null, purchaserPhone: <request Mobile> }`)
- `lib/ussd/handlers/bundles.ts` → `{ surface: "ussd_uzo", purchaserPhone: session.dialingPhone, product }`
- `lib/ussd-shop/handlers/bundles.ts` and `confirm-by-text.ts` (`recipientBlocked(network, recipientLocal, ctx?)`) → `{ surface: "ussd_uzo_shop", shopId: session.shopId, purchaserPhone: <dialler / sender> }`
- `lib/whatsapp-bot/shop-router.ts` → `{ surface: "whatsapp_shop", shopId: session.shopId, purchaserPhone: from }`
- `lib/ai-tools.ts` (both sites) → `{ surface: "whatsapp_ai", shopId: shop.shopId ?? null, userId: dialer.userId ?? null, purchaserPhone: <WhatsApp sender in scope> }`
- `lib/text-to-buy/catalogue.ts` → `{ surface: "text_to_buy", purchaserPhone: i.senderLocal, shopId: <shop-line shop id when present> }`; `lib/text-to-buy/services/airtime.ts` → same with `"text_to_buy_airtime"`

**Interfaces:** consumes Task 4 signatures; produces nothing new.

- [ ] **Step 1: For each site, write one failing test** asserting the mocked gate was called with an object containing the listed `surface` and, where listed, `shopId` / `userId` / `purchaserPhone`.
- [ ] **Step 2: Run** `npx vitest run app/api/shop app/api/orders app/api/v1 lib/api-v2 lib/ussd-hubtel lib/ussd lib/ussd-shop lib/whatsapp-bot lib/ai-tools lib/text-to-buy`. Expected: FAIL on the new assertions.
- [ ] **Step 3: Implement** each change. Web and API sites never pass `purchaserPhone`.
- [ ] **Step 4: Verify coverage:** `git grep -n "isRecipientBlocked(\|verifyRecipientsForOrder(\|verifyRecipient(" -- lib app ':!*.test.ts'` — every non-definition call passes a context. Paste the list into the commit body.
- [ ] **Step 5: Run** `npm run test:run`. Expected: only the 9 known order-health failures.
- [ ] **Step 6: Commit** `feat(blocked-numbers): pass block context from every ordering surface`.

### Task 8: User page (My shops and My orders)

**Files:**
- Create: `lib/blocked-numbers/user-view.ts`, `lib/blocked-numbers/user-view.test.ts`
- Create: `app/api/user/blocked-numbers/route.ts`, `app/api/user/blocked-numbers/export/route.ts`, plus a route test
- Create: `app/dashboard/blocked-numbers/page.tsx`
- Modify: `lib/dashboard-nav-items.ts` (add `{ href: "/dashboard/blocked-numbers", label: "Blocked Numbers", icon: ShieldAlert, roles: ["user","admin","sub_agent","dealer"] }` to `shopItems` after Customers), `lib/nav-new.ts` (`"/dashboard/blocked-numbers": { since: "2026-11-15" }`), `app/dashboard/shop-dashboard/page.tsx` (waiting-count tile linking to the page)

**Interfaces:**
- Produces: pure `aggregateForScope(attempts: AttemptRow[], numbers: Map<string, NumberRow>): UserBlockedRow[]`, `UserBlockedRow = { phone; firstTried; lastTried; attempts: number; products: string[]; surfaces: BlockSurface[]; status: "waiting" | "ready" | "expired" }`. Status map: `blocked` → waiting, `allowed` → ready, `expired` and `handled` → expired. Route `GET ?section=shops|orders&status=&from=&to=&page=` → `{ rows, total, page, hasShops: boolean, hasOrders: boolean }`.

- [ ] **Step 1: Write failing `aggregateForScope` tests:** two shops' attempts for one phone, passing only shop A's → A's counts and dates only; status mapping as above; sorted by `lastTried` desc.
- [ ] **Step 2: Write failing route tests:** no Bearer → 401; `section=shops` filters attempts to `shop_id IN (session user's user_shops ids)` and ignores any client `shop_id` param; `section=orders` filters `user_id = session user` and `surface IN DEALER_SURFACES`; page size 50; export capped at 10,000 rows, xlsx columns Phone, First tried, Last tried, Attempts, Product, Status.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement** the helper and routes (Bearer auth pattern from `app/api/shop/manage/route.ts`).
- [ ] **Step 5: Build the page:** sections shown per `hasShops` / `hasOrders`; status and date filters; Export; per-row "Copy message" on Ready rows (`Your number {phone} is now ready. You can buy your data again now.`); "Copy ready numbers" in My orders; empty state when `enabled` is off. `lg:` multi-column, navy primary.
- [ ] **Step 6: Run** tests, then headless screenshots at 500 px and 1280 px.
- [ ] **Step 7: Commit** `feat(blocked-numbers): shop owner and dealer page`.

### Task 9: Admin page, routes, digest and spike alert

**Files:**
- Create: `lib/blocked-numbers/admin-view.ts`, `lib/blocked-numbers/alerts.ts`, tests for both
- Create: `app/api/admin/blocked-numbers/route.ts` (list + stats), `.../recheck/route.ts`, `.../update/route.ts`, `.../export/route.ts`
- Create: `app/admin/blocked-numbers/page.tsx`
- Modify: `components/layout/sidebar.tsx` (link after MTN Registration with `markClicked` + `<NewTag>`), `lib/nav-new.ts` (`"/admin/blocked-numbers"`), `lib/rate-limit-config.ts` (add `/api/admin/blocked-numbers/export` and `/api/admin/blocked-numbers/recheck` to `HEAVY_ADMIN_OPERATIONS`), `app/admin/settings/mtn/page.tsx` (settings card under Customer verification), `lib/blocked-numbers/record.ts` (wire `afterInsert` → `maybeSendSpikeAlert`), cron route (call `sendDailyDigest`)

**Interfaces:**
- Produces: `buildDigest(stats: DigestStats): { subject; html; pushTitle; pushBody }`; `sendDailyDigest(deps?)` via admin-actions `notifyAdminsEmail` + `notifyAdminsPush`; `maybeSendSpikeAlert(deps?): Promise<boolean>` (distinct phones in last 60 min > `spike_threshold_per_hour` and `admin_settings.blocked_numbers_last_spike_alert_at` older than 6 h; stamps on send); export `?kind=report|supplier&supplier=<name>&mark=1`; update `{ id, action: "handle"|"reopen", note? }`; recheck `{ ids?: string[] } | { all: true }`.

- [ ] **Step 1: Write failing tests:** `buildDigest` output has no run of 9+ digits; 26 distinct phones with threshold 25 and no stamp → sends and stamps; stamp 2 h old → no send; 30 attempts of one phone → no send. Supplier export → single `Phone` column, `0XXXXXXXXX`, only `status='blocked'`; `mark=1` stamps `submitted_to_supplier` / `submitted_at` on exactly those rows and writes `admin_audit_log` (`action: "export_blocked_numbers"`, count only). `handle` requires a note of at most 500 chars; `reopen` sets `status:"blocked"`, `next_recheck_at: now`. Recheck with more than 500 ids → 400. Non-admin on any route → rejected.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** libs and routes (`verifyAdminAccess`, service role, limits per spec §7).
- [ ] **Step 4: Build the admin page** (tiles, server-paginated table, filters, bulk actions, two exports with a supplier dropdown limited to the current checkout provider list) and the settings card (two switches and three numbers posting to Task 2's route).
- [ ] **Step 5: Run** tests, then a headless screenshot.
- [ ] **Step 6: Commit** `feat(blocked-numbers): admin page, exports, digest and spike alert`.

### Task 10: Verification gate and runbook

**Files:**
- Modify: spec status line → "implemented, dark"
- Create: `docs/blocked-numbers-runbook.md` (spec §9 rollout, 0182 pre-checks, cron-job.org sync command, rollback)

- [ ] **Step 1: Run** `npx tsc --noEmit`. Expected: no new errors versus `origin/main`.
- [ ] **Step 2: Run** `npm run test:run`. Expected: only the 9 known order-health failures.
- [ ] **Step 3: Run** a placeholder-env `next build`. Expected: success with no route-export violations.
- [ ] **Step 4: Write the runbook.**
- [ ] **Step 5: Commit** `docs(blocked-numbers): runbook`.
- [ ] **Step 6: Whole-branch review** on the most capable model, checking: every gate call site passes a context, the cron's step order, no phone numbers in logs, owner scoping in both user routes, no SMS ever planned for a dealer surface.
