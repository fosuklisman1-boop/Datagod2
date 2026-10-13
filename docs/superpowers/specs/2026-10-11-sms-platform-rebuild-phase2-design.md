# SMS Platform Rebuild — Phase 2 (Admin Console) Design

Date: 2026-10-11
Status: Approved in brainstorming (user, sections 1–3), pending spec review
Builds on: `2026-10-10-sms-platform-rebuild-phase1-design.md` (Phase 1 is built and live; see its §4 for the full
admin reference inventory, §5 for the backend this phase puts a UI on).

## 1. Goal

Replace `/admin/sms` with one **"SMS Platform"** page matching the reference's admin console: header with master
switch, status banner, six stat cards and seven tabs (Business Reviews, Sender IDs, Flagged, Messages, Accounts,
Bundles, Settings). `/admin/sms-centre` (admin broadcast, contacts, templates, providers) and `/admin/sms-health` are
unchanged. No customer-facing screens (Phase 3) and no scheduled sends (Phase 4).

## 2. Decisions

| # | Decision |
|---|---|
| P2-1 | **Master switch is a real kill switch now** (user choice). Off refuses new customer sends and new credit issuance; everything else is unaffected (§6). All other policy rules (caps, keywords, flags, holds) stay record-only until Phase 3. |
| P2-2 | One page at the existing route `/admin/sms`; the old page is replaced in the same release, nothing it did is lost (§3.2). |
| P2-3 | Each tab is its own component, loads on first open, and fails independently. Active tab lives in the URL (`?tab=`). |
| P2-4 | Held-campaign release/reject and turning enforcement on are **Phase 3**. The Flagged tab offers Dismiss and Suspend only. |
| P2-5 | Add a read-only **Policy preview** card (what the new rules *would* have done in the last 7 days, from `policy_shadow`) so caps and keyword lists can be tuned before Phase 3. |
| P2-6 | Bundle "Delete" is a guarded hard delete (inactive for ≥ 48 h) because an in-flight Paystack checkout for a deleted bundle would be paid but uncreditable. Otherwise the admin Deactivates. |

## 3. Architecture

### 3.1 Files
```
app/admin/sms/
  page.tsx                      shell: header, switch, banner, stat cards, tab bar (?tab=)
  _lib/api.ts                   authenticated fetch helper + response types (pattern: app/admin/sms-centre/_lib/api.ts)
  _lib/view.ts (+test)          pure helpers: money/number formatting, Ghana-card masking, status→badge, wa.me link, filter/sort
  _components/
    StatCards.tsx  SupplyStrip.tsx  StatusBanner.tsx
    BusinessReviewsTab.tsx  SenderIdsTab.tsx  FlaggedTab.tsx  MessagesTab.tsx
    AccountsTab.tsx  BundlesTab.tsx  SettingsTab.tsx   (Settings split into small section components)
lib/sms/admin-overview.ts (+test)   overview/stat logic
lib/sms/admin-lists.ts (+test)      messages / accounts / flags listing (search + paging)
lib/sms/admin-settings.ts (+test)   validate + save the SMS settings, audit, cache invalidation
lib/sms/kill-switch.ts (+test)      assertSmsEnabled()
migrations/20261011_sms_admin_console.sql   overview + list SQL functions (no backfill, see §5)
app/api/admin/sms-platform/...      thin routes over the lib services
```
UI uses the existing design system: `DashboardLayout`, `PageHeaderBanner`, shadcn `Tabs/Card/Badge/Dialog/Table`,
navy `--primary` and the clay utilities (`.clay`, `.clay-sm`, `.clay-inset`, …). Mobile: tables become stacked cards;
`lg:` widening from the start (per the desktop-layout rule).

### 3.2 What the old `/admin/sms` page becomes
| Old feature | New home |
|---|---|
| Allocate credits to an account | Accounts tab → row action |
| Suspend / unsuspend account | Accounts tab → row action (also Flagged → Suspend) |
| Activation fee, welcome bonus, price per credit | Settings → "Pricing & activation" |
| Wholesale supply panel | Header "Supply" strip |
| Flagged-message list + dismiss | Flagged tab |
| Bundle create/edit | Bundles tab |
| Sender-ID list, push/poll buttons | Sender IDs tab (push/poll controls only for admin-global senders; tenant approval is ours) |

## 4. Backend

All routes: `verifyAdminAccess`; **writes also require `auth.userId`** (the CRON_SECRET bearer has none) and write an
`admin_audit_log` row (admin id, action, target user, old/new values — never document paths or card data).

### 4.1 Overview — `GET /api/admin/sms-platform/overview`
Returns `{ stats, tabCounts, supply, featureEnabled, policyEnforced, provider, unrecordedPurchases, policyPreview }`.
- **Total Revenue (GH₵)** = Σ `sms_unit_transactions.amount_ghs` where reason ∈ (`bundle_wallet`,`bundle_paystack`) and delta > 0, **plus** Σ `sms_accounts.amount_paid` (activation fees). Pending credits are not summed (settled rows keep their amount; counting both would double-count).
- **Credits Sold** = Σ delta of those bundle rows. **Purchases** = their count. `unrecordedPurchases`/`unrecordedCredits` = those with `amount_ghs IS NULL`.
- **Pending Reviews** = `sms_business_profiles.status='submitted'`. **Pending Senders** = tenant `sms_sender_ids.local_status='pending'`. **Fraud Flags** = open `sms_flags` severity `fraud` + legacy `sms_send_logs.flagged`.
- **Supply** comes from `getWholesaleCredits()`'s inputs, exposed as a snapshot `{provider, backedCredits, balanceGhs|null, queuedUnsent, error?}` so the UI can say *why* the number is 0 (relay failing, balance unreadable) instead of just showing 0. (`lib/sms/wholesale.ts` gains `getWholesaleSnapshot()`; `getWholesaleCredits()` wraps it unchanged.)
- **Policy preview** = counts of recorded `policy_shadow` decisions by `decision`/`code` over the last 7 days.
- Implemented as SQL functions (`sms_admin_overview()`, `sms_policy_preview(p_days)`) so the sums are exact beyond the 1000-row cap and under the 8 s PostgREST timeout.

### 4.2 Lists (search + paging, 25/page, newest first)
- `GET …/messages?q=&status=&page=` — from `sms_send_logs`: sender, mode, status, recipients, time, owner user id, message, and delivered/failed/pending counts (SQL function). `q` matches message/sender (ILIKE) or an exact user-id UUID.
- `GET …/accounts?q=&page=` — SQL function `sms_admin_accounts(p_q,p_limit,p_offset)`: user id, owner type, mode, status, unit balance, **bought** (Σ positive purchase deltas), **used** (Σ `credits_used`), default sender name, API-limit override. `q` matches user id, sender, mode, status.
- `GET …/flags?severity=&status=` — unified list of `sms_flags` rows and legacy flagged send logs; `POST …/flags/[id]` `{action: "dismiss"|"suspend"}` (legacy rows use the existing `dismissFlag`; suspend uses `suspendSmsAccount`).

### 4.3 Settings — `GET/PATCH /api/admin/sms-platform/settings`
GET returns every SMS setting grouped by section (the 15 Phase 1 keys + `sms_activation_fee`, `sms_welcome_bonus_credits`, `sms_price_per_credit`). PATCH takes **one section at a time**, validates server-side with the Phase 1 ranges (caps ≥ 1; auto-suspend 1–100; review threshold 1–500; API limit 1–10 000; Hubtel cost 0.0001–10; lists trimmed, de-duplicated, sender-pool upper-cased, allowed domains normalised), writes through `tenant_global_settings`, writes an audit row with old/new, and calls `invalidateSmsSettingsCache()`. `sms_policy_enforced` is **not** writable here (Phase 3). The existing `updateSmsSettings` allowlist and `/api/admin/shop-sms` PATCH keep working for compatibility.
Provider routing keeps using `/api/admin/sms-settings` (its Hubtel readiness guard already exists).

### 4.4 Existing endpoints reused
Business reviews (`business-reviews`, `[id]` incl. `retry_mode`), sender IDs (`sender-ids/[id]`), account PATCH (mode / API-limit), `sms/allocate`, `sms/bundles` (+ new DELETE with the 48 h guard), `shop-sms` POST (suspend/dismiss).

## 5. Revenue history (amended 2026-10-11 after investigating the data)
56 bundle purchases (38 wallet, 18 Paystack, 2026-06-17 → 2026-10-07) predate amount recording, and the old summary function returns 0 bundle revenue. **An exact backfill is not possible**: the 18 Paystack purchases (refs `smsqty-…`) left no row in `payment_attempts`, `wallet_payments` or `transactions` (they exist only at Paystack), and the 37 wallet quantity purchases were priced from `sms_price_per_credit`, which has no history. Only 1 purchase (a wallet bundle at an unchanged price) is derivable, not worth special logic. **Decision: no backfill and no estimates.** The revenue card is labelled "Recorded revenue" and shows a note "N earlier purchases (X credits) have no recorded amount", driven by `unrecorded_purchases` / `unrecorded_credits` from the overview function. Every purchase from the Phase 1 deploy onward carries `amount_ghs`.

## 6. Kill switch
`lib/sms/kill-switch.ts: assertSmsEnabled()` reads `featureEnabled` from the cached settings (60 s per instance; the instance
handling the admin PATCH is invalidated immediately; UI says "takes effect within a minute"). If the settings cannot be loaded it
**fails open** (defaults to on) so a database blip never stops sending.

Refused with `SMS is temporarily unavailable. Please try again later.` (error code `SMS_DISABLED`, HTTP 503 on the public API):
`enqueueSend` (covers dashboard, shop and `/api/v1/sms/send`), wallet bundle purchase, quantity purchase, Paystack checkout
initiation, activation (wallet / Paystack / direct charge) and welcome-bonus claim.
**Never blocked:** Paystack webhooks for payments already made (customer paid → always credited), already-queued messages
(already charged, they keep draining), refunds, DLR polling, OTP/transactional platform messages, admin broadcast.
Default is on, so deployment changes nothing until an admin flips it.

## 7. Error handling and UX safety
- Per-tab loading / empty / error states; one failing tab never blanks the page; Refresh re-fetches the visible tab and the overview.
- Confirmation dialogs for revoke, reject, suspend, mode change (shows what happens to sender IDs), bundle delete; rejection reasons required (server-enforced).
- Business documents open only via the existing 5-minute signed links (the audit row is written server-side); the Ghana Card is shown as "ID ending 1234" — only the last 4 digits exist in storage.
- Sender-ID Approve is disabled with an explanation until Hubtel is the active provider (the service refuses regardless).
- "Retry mode switch" appears on an approved application whose mode change failed.

## 8. Testing
- Services (`admin-overview`, `admin-lists`, `admin-settings`, `kill-switch`) tested against a fake database: revenue definition incl. NULL amounts and pending-row exclusion, search + paging edges, settings validation per section and audit rows, kill switch at **every** blocked entry point and every non-blocked path.
- SQL functions verified live in rolled-back transactions (counts against known fixtures) before the migration is committed.
- `_lib/view.ts` helpers unit-tested; components are presentational (data in, JSX out).
- Visual check at phone width and desktop using fixture data in a throwaway local preview (never committed; the real page needs a login, which tests never perform).
- Gates unchanged: `tsc`, full `vitest` (only the 9 known `order-health-service` failures allowed), placeholder-env `next build`, then push.

## 9. Rollout
One migration (SQL functions), then deploy. Sidebar link `/admin/sms` is unchanged. No customer-visible change; the
kill switch defaults on. The page reads real Phase 1 data (flags and shadow policy start empty until Phase 1 code has been serving traffic).

## 10. Out of scope
Held-campaign release/reject; enforcement toggle; customer screens; scheduled sends; billed order confirmations; changes to `/admin/sms-centre`.
