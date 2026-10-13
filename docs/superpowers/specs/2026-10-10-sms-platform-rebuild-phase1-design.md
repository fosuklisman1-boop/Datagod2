# SMS Platform Rebuild — Program Overview + Phase 1 (Foundation) Design

Date: 2026-10-10
Status: Approved in brainstorming (user), pending spec review

## 1. Context

DATAGOD already runs a multi-tenant SMS product (migrations 0061–0075, `lib/sms/**`,
`app/dashboard/sms`, `app/admin/sms`, `app/admin/sms-centre`). We are rebuilding it to match a
25-screen reference (KFT SMS on kingflexygh.com), adapted to our design system (navy `#1B388B`,
claymorphism). The user's rule: **anything in the reference we don't have, we build.**

The reference introduces a compliance layer we lack entirely: **Platform vs Business sending
modes**, business **KYC**, per-mode **caps**, per-mode **content policy**, **flags → hold →
auto-suspend**, a **sender pool**, per-mode **price lists**, a **master switch** and **allowed roles**.

The user also decided to move all SMS to **Hubtel**, which passes any sender ID through without
network registration — so sender-ID approval is entirely our own decision, and our moderation is
the only safeguard against impersonation.

## 2. Program: four phases (Approach A — extend the existing system)

Each phase gets its own spec → plan → build → review → deploy cycle.

1. **Foundation (this spec).** Data model, migration, Hubtel adapter + routing, delivery-report
   refunds, KYC backend, sender-ID rules, per-mode bundles + revenue recording, send-policy engine
   (shipped in *record-only* mode).
2. **Admin console.** Single "SMS Platform" page with the reference's 7 tabs, replacing
   `/admin/sms`. `/admin/sms-centre` (admin broadcast, providers) and `/admin/sms-health` stay.
3. **Customer side.** Home, Compose, Records, Contacts, Credits, Business & Sender ID. Policy
   enforcement switched on when this ships.
4. **Extras.** Scheduled sends (2 min–30 days); billed order confirmations under own sender ID.

## 3. Decisions (from brainstorming, 2026-10-10)

| # | Question | Decision |
|---|---|---|
| D1 | Who can use SMS | Admin-chosen **Allowed Roles** setting; **keep** the GH₵20 activation fee + 10-credit welcome bonus |
| D2 | Existing accounts' mode | **Everyone starts in Platform mode**; Business mode only via KYC |
| D3 | Existing approved sender IDs | **Oldest stays usable** (becomes the one KYC-free ID); the rest are **paused** and reactivate on KYC approval |
| D4 | Pricing | **Per-mode bundle lists only**; remove "buy any amount" |
| D5 | Order confirmations | Opt-in "use my sender ID" toggle. Off (default) = free from platform sender. On = shop's sender ID, **billed credits**; falls back to free platform sender if credits run out (Phase 4) |
| D6 | KYC documents | **Uploaded in the form**, private storage, shown to admin on the review card |
| D7 | Provider | **Hubtel everywhere** (campaigns, OTP, transactional, admin broadcast). Moolre/mNotify kept only as automatic fallback, platform-sender messages only |

## 4. Reference inventory (for Phases 2–4)

### Admin ("SMS Platform", single page)
- Header: title, LIVE badge, subtitle; **master switch** + Refresh; status banner ("Live — customers
  can buy credits and send SMS").
- Stat cards (2-col): Total Revenue (GH₵), Credits Sold, Purchases, Pending Reviews, Pending
  Senders, Fraud Flags.
- Tabs with count badges: **Business Reviews · Sender IDs · Flagged · Messages · Accounts ·
  Bundles · Settings**.
- **Business Reviews:** card per pending business (name, Under Review badge, user ID, submitted
  time, current mode, website link, description, masked Ghana Card, "Chat 233…" WhatsApp button,
  Approve / Reject); collapsible "Previously approved (n)" / "Previously rejected (n)".
- **Sender IDs:** "Under Review (n)" rows (name in mono + copy, user ID, requested time, Approve /
  Reject — *no "Submit to provider" step for us, Hubtel needs none*); "Approved (n)" with approved
  time + Revoke.
- **Flagged:** chips All / Fraud / Info with counts; empty state "Nothing flagged — all clear";
  populated row to design (message/account, reason, severity, actions: dismiss, release/reject
  held campaign, suspend).
- **Messages:** search (sender, message, user, status); card per send: sender, mode badge,
  status badge, recipient count + time, user ID, message body bubble.
- **Accounts:** search (user ID, sender, mode, status); table User (copy) · Mode · Status ·
  Credits ("X bought · Y used") · Default sender; per-row actions: suspend/unsuspend, change mode,
  API rate-limit override. Render as stacked cards on mobile.
- **Bundles:** grouped "Platform (n)" / "Business (n)"; card: name, Active badge, "credits · price
  · sort N", Edit / Deactivate / Delete; plus "New bundle".
- **Settings:** Sender ID Pool (chips + add + Save); Allowed Roles (checkboxes + Save); Sending
  Caps per mode (max recipients/send, sends/hour, recipients/day; reference defaults Platform
  300/20/500, Business 1000/2000/1,000,000); Blocked Keywords (platform, comma-separated);
  Moderation Thresholds (auto-suspend after N fraud flags, 1–100, default 2; flag-review
  threshold, 1–500, default 5); SMS API Rate Limit (requests/min default 30, 1–10,000,
  per-account override in Accounts); Business mode lists (blocked keywords, flagged keywords,
  allowed domains).

### Customer
- **Home:** back link, title + mode badge, subtitle, Refresh; balance hero (credits, Send SMS,
  Buy Credits, "Sending as X"); "Use my sender ID for order confirmations" toggle; 30-day stats
  (Campaigns, Recipients, Credits used); tiles Records / Contacts / Credits / Business & Sender ID;
  limits line ("300 recipients/send · 20 sends/hour · 500 recipients/day"); Recent Credit
  Activity + View all.
- **Compose:** credit pill; "Sending as" dropdown (labelled platform default / pool / own) + mode
  badge; Recipients tabs Paste / Groups / Mine (own shop customers) / CSV, "Ghana numbers only ·
  duplicates removed", "n / cap recipients (unique)" + bar; Message with Templates / Save template,
  GSM-7 vs Unicode segment counter, live phone preview with sender name, Hide preview; Send later
  (2 min–30 days); summary Recipients × SMS each = Total credits, wallet; Review & Send (disabled
  until a recipient) → confirmation.
- **Records:** status chips All / Queued / Processing / Completed / Partial / Failed (+ Held,
  Scheduled); empty state + "Send your first SMS"; campaign detail with delivery breakdown.
- **Contacts:** "+ New Group", empty state, group list, create/edit group.
- **Credits:** bundle cards (credits, price, ≈ GHS/SMS, Buy; best value highlighted), note
  (paid from main wallet; 1 credit = 1 segment; failed deliveries refunded), Credit History ledger
  referencing campaigns.
- **Business & Sender ID:** stepper Register → In review → Approved → Sender ID; KYC form
  (name 2–120, description 10–2000, website, Ghana Card GHA-XXXXXXXXX-X, WhatsApp number,
  document uploads, Save draft, Submit for review); Your Sender IDs (request field 0/11, rules,
  list with statuses); Platform vs Business comparison.

### Keep (we have it, the reference doesn't)
`{shop_*}` personalization tokens, contact opt-outs, MoMo name verification of contacts, solvency
gate, provider failover, activation fee + welcome bonus (D1).

## 5. Phase 1 design

### 5.1 Data model

All changes extend existing tables; no data is moved or re-created.

**`sms_accounts`**
- `mode text not null default 'platform' check (mode in ('platform','business'))`
- `mode_changed_at timestamptz`
- `fraud_flag_count int not null default 0`
- `review_hold boolean not null default false`
- `api_rate_limit_override int null` (1–10,000)
- `default_sender_id uuid null references sms_sender_ids(id) on delete set null`
- `owner_type` gains `individual` (users in an allowed role without a shop)

**`sms_business_profiles`** (new)
- `id`, `sms_account_id` → `sms_accounts`, `business_name` (2–120), `description` (10–2000),
  `website`, `whatsapp_number`, `ghana_card_last4` (char 4), `ghana_card_doc_path`,
  `registration_doc_path`, `status` (`draft`/`submitted`/`approved`/`rejected`), `submitted_at`,
  `reviewed_by`, `reviewed_at`, `rejection_reason`, `docs_purge_after timestamptz`, timestamps.
- One `draft`/`submitted` row per account at a time (partial unique index). Decided rows are kept
  as history.
- Documents in a **private** storage bucket `sms-kyc`; admins view via short-lived signed URLs.
  Files are deleted by cron 30 days after the decision (`docs_purge_after`); paths nulled.

**`sms_sender_ids`**
- `local_status` gains `paused` and `revoked`.
- `kyc_free boolean not null default false`, `is_pool boolean not null default false`,
  `approved_by`, `approved_at`, `revoked_at`, `rejection_reason`.
- Unique index on `upper(sender_id)` where `local_status = 'active'` (no two accounts share an
  active ID).

**`sms_bundles`**: `mode text not null default 'platform'`, `sort_order int not null default 0`.
Existing three bundles become Platform bundles (admin reprices). "Buy any amount" endpoint
(`/api/sms/units/purchase`) is retired at Phase 3 (kept until then so nothing breaks).

**`sms_unit_transactions`**: `amount_ghs numeric(12,2) null` recorded on purchases.

**`sms_flags`** (new): `id`, `sms_account_id`, `send_log_id` (nullable), `severity`
(`fraud`/`info`), `reason`, `matched`, `status` (`open`/`dismissed`/`actioned`), `created_at`,
`resolved_by`, `resolved_at`. Today's `sms_send_logs.flagged/flag_reason` stay populated for
backward compatibility.

**`sms_send_logs`**: `status` gains `held` (and later `scheduled`); `mode text` snapshot at send;
`policy_shadow jsonb null` (record-only decision, see 5.3).

**`sms_messages`**: `delivery_status` (`pending`/`delivered`/`failed`), `delivered_at`,
`provider_message_id`, `cost_ghs numeric(8,4)`, `refunded boolean not null default false`.
`sms_send_logs` also gains `provider_batch_id`.

**Settings** (`tenant_global_settings`, jsonb values):
`sms_feature_enabled` (bool), `sms_policy_enforced` (bool, **false** in Phase 1),
`sms_allowed_roles` (string[]), `sms_sender_pool` (string[]),
`sms_caps` ({platform:{per_send,per_hour,per_day}, business:{…}}),
`sms_blocked_keywords` (platform list), `sms_business_blocked_keywords`,
`sms_business_flagged_keywords`, `sms_business_allowed_domains`,
`sms_auto_suspend_flags` (2), `sms_flag_review_threshold` (5),
`sms_api_rate_limit_default` (30), `sms_protected_sender_names` (string[], seeded with telcos,
mobile-money brands, major Ghanaian banks, government bodies, DATAGOD).

Caps are computed from `sms_send_logs` (indexed on `sms_account_id, created_at`); no counter table.

### 5.2 Migration of existing accounts (one transaction)
- All accounts → `mode = 'platform'`.
- Per account: oldest `active` sender ID → `kyc_free = true`; other `active` IDs → `paused`.
- Existing bundles → `mode = 'platform'`, sort by price.
- Seed all settings with defaults above; `sms_policy_enforced = false`.
- Invariant asserted in the migration's SQL test: `sum(unit_balance)` identical before/after; no
  sender ID deleted; account count unchanged.

### 5.3 Send policy engine
`lib/sms/policy.ts` — pure function `evaluateSendPolicy(input) → { decision, flags[], reason }`
with no I/O (caller passes account, settings, recent usage, sender, recipients, message). Called
at the top of `enqueueSend`, which every customer send path uses (dashboard, `/api/v1/sms/send`,
later scheduled sends). Admin broadcast and OTP/transactional are platform traffic and bypass it.

Order (first failure stops, before any debit):
1. Master switch off → `unavailable`.
2. Role not allowed / account suspended → reject.
3. Sender not allowed for mode (platform: platform default or own `kyc_free`; business: own
   active IDs or pool) → reject.
4. Caps for mode: per-send recipients; sends in last hour; recipients in last 24 h + this send.
   Message states when the limit resets.
5. Content —
   - Platform: platform blocked keyword → block + fraud flag; any link not on our own domains →
     block (our domains = `datagod.store` and all its subdomains, plus every active row in
     `custom_domains`, read live); built-in phishing/shortener/lookalike rules → block + fraud flag.
   - Business: business blocked keywords + built-in phishing rules → block + fraud flag;
     business flagged keywords → allow + info flag; suspicious link → info flag unless domain in
     business allowed list; normal links allowed.

After recording a fraud flag (DB function, atomic): increment `fraud_flag_count`; if ≥
`sms_auto_suspend_flags` → suspend; if total open flags ≥ `sms_flag_review_threshold` →
`review_hold = true`. Campaigns from a held account are debited and stored with `status = 'held'`
until an admin releases (send) or rejects (full refund).

**Record-only mode (Phase 1):** when `sms_policy_enforced = false`, the engine runs and writes
its would-be decision to `policy_shadow` on the send log, but the send proceeds exactly as today.
In this mode **no new consequences apply**: no new blocks, no caps, no `sms_flags` rows counted
toward thresholds, no auto-suspend, no `review_hold`. (Today's existing content filter keeps
behaving as it does now.) Enforcement turns on with Phase 3.

API rate limit for `/api/v1/sms/send`: `api_rate_limit_override ?? sms_api_rate_limit_default`
per minute (replaces `users.rate_limit_per_min / 3`).

Every rejection carries a customer-facing message stating what to change.

### 5.4 Hubtel (built from the Hubtel SMS + Balance Query docs supplied 2026-10-10)
`lib/sms/providers/hubtel.ts` owns every Hubtel detail:
- **Auth:** HTTP Basic with the SMS API credentials (`HUBTEL_SMS_CLIENT_ID`,
  `HUBTEL_SMS_CLIENT_SECRET`, Vercel env). Sends go straight from Vercel (no IP whitelist is
  documented for `sms.hubtel.com`).
- **Single:** `POST https://sms.hubtel.com/v1/messages/send` `{From, To, Content}`.
- **Batch, same text:** `POST /v1/messages/batch/simple/send` `{From, Recipients[], Content}`.
- **Batch, per-recipient text** (used whenever `{shop_*}` tokens make texts differ):
  `POST /v1/messages/batch/personalized/send` `{From, personalizedRecipients:[{To, Content}]}`.
- Batch responses return `batchId` and `data[]` of `{recipient, content, messageId}`; store
  `provider_batch_id` on the send log and `provider_message_id` per message.
- **Error trap:** Hubtel can return HTTP **201 with a non-zero body `status`** (1 invalid
  destination, 2 invalid source/sender, 100 malformed). Success = 2xx **and** body `status === 0`.
  HTTP 402 or body status 12 = out of funds → keep messages queued for retry + immediate admin
  alert. 400 with 3/4/6/7/8 = permanent failure (refund).
- **Cost:** responses/status checks carry `rate` (GH₵ per SMS); stored per message
  (`sms_messages.cost_ghs`) for true cost/margin reporting.
- Batch size: chunk at 100 recipients per request (conservative; docs give no limit). Revisit
  after live testing.
- Routing: Hubtel becomes the primary via the existing `admin_settings.sms_primary_provider`.
  Customer campaigns (today hard-wired to Moolre bulk) are rewired through routing. Fallback
  Moolre → mNotify for platform-sender messages only; custom-sender messages retry on Hubtel.
- Hubtel made primary **only after one live test SMS** succeeds. Rollback = one setting.

### 5.5 Delivery status and refunds
- Hubtel's REST API has **no delivery-report webhook** (DLRs are SMPP-only, which needs a
  persistent socket Vercel can't hold). Instead a cron (every 2 min) polls
  `GET /v1/messages/batch/{batchId}` for batches with non-final messages; one call returns every
  message's status. Batches still non-final after 72 h are closed as failed (refunded).
- Status mapping: `Delivered` → delivered; `Sent`, `Pending` → still pending; everything else
  (`Blacklisted`, `Undeliverable/Failed`, `Unrouteable/Error`, `Rejected`, any `NACK/…`) → failed.
- Any message ending `failed` (send-time or polled) is refunded **exactly once** via the existing
  `campaign_refund` ledger reason, linked to the campaign (`refunded` flag + idempotent RPC).
  Campaign status recomputed: Completed / Partial / Failed.

### 5.5a Solvency gate (Hubtel Disbursement balance)
- SMS is charged to the Hubtel **Disbursement (prepaid) account**. Its balance comes from
  `GET https://trnf.hubtel.com/api/inter-transfers/prepaid/{HUBTEL_DISBURSEMENT_ACCOUNT}`
  (`{responseCode:"0000", data:{amount}}`), which **only accepts whitelisted IPs** — so it is
  called through the existing DigitalOcean relay (`scripts/hubtel-relay`, fixed whitelisted IP,
  secret-authenticated) via a new `/balance` route. Relay stays logic-free (forward + auth only).
- Backed credits = balance_ghs ÷ cost_per_sms, where cost_per_sms = highest `rate` observed over
  the last 7 days (conservative), falling back to an admin setting `sms_hubtel_cost_per_sms`
  until data exists. `credit_sms_units_if_solvent` only credits purchases while total unused
  credits (all balances + pending) stay ≤ backed credits; otherwise the existing pending-credit
  flow applies.
- Admin alerts: balance below a threshold setting `sms_hubtel_low_balance_ghs`; any send
  returning out-of-funds.

### 5.6 KYC backend
- APIs: get/save draft, upload documents (image/PDF ≤ 5 MB, MIME-checked), submit; admin list,
  approve, reject (reason required).
- Ghana Card validated `^GHA-\d{9}-\d$`; only last 4 stored in the row (the uploaded photo is the
  verification artifact, private, purged 30 days after decision).
- Approve → `mode = 'business'`, `mode_changed_at`, unpause paused sender IDs, notify user.
  Reject → notify user with reason; user may edit and resubmit.
- Admins notified in-app on submission.

### 5.7 Sender IDs
- Validation (client + server): 3–11 chars, `[A-Za-z0-9 ]`, at least one letter, not containing
  any protected name (case- and space-insensitive substring), not equal to another account's
  active ID.
- Limits: Platform 1 (`kyc_free`), Business 200.
- Admin approve (active immediately — Hubtel needs no registration), reject (reason), revoke.
  Revoked default sender → account default falls back to platform sender.
- Pool names (`sms_sender_pool`) usable by Business accounts only.
- Admin can set an account back to Platform; extra IDs re-paused.
- Existing Moolre/mNotify sender-ID push/poll stays in code for fallback but is removed from the
  customer flow.

### 5.8 Bundles and revenue
- Bundle CRUD API accepts `mode` + `sort_order`; customers only see bundles for their mode.
- Purchases write `amount_ghs` to the ledger; Total Revenue = sum of `amount_ghs` (+ activation
  fees, already in `sms_accounts.amount_paid`).

## 6. Testing
- `policy.ts`: every branch — each mode × each cap, keyword block vs flag, own-domain vs other
  links, suspend and hold thresholds, record-only mode.
- Sender-name validator incl. protected names inside words.
- Refund idempotency: duplicate failed delivery reports refund once.
- KYC transitions incl. resubmit and unpausing on approval.
- Migration SQL test: balances identical, correct kept/paused IDs, counts unchanged.
- Hubtel adapter against a fake fetch; one live SMS before going primary.
- Baseline: full suite stays green apart from the 9 known pre-existing
  `order-health-service` failures.

## 7. Rollout
1. Apply migration (verified live: invariants, settings seeded, `sms_policy_enforced = false`).
2. Deploy code with policy in record-only mode; Hubtel adapter present but not primary.
3. Live Hubtel test → set primary.
4. Review shadow-policy data for a few days to tune default caps/keyword lists before Phase 3
   enforcement.

## 8. Out of scope for Phase 1
All new UI (Phases 2–3), scheduled sends and billed order confirmations (Phase 4), changes to
admin broadcast UI.

## 9. Open items (user action during build)
- Resolved: Hubtel docs supplied; Platform-mode link domains = `datagod.store` (+ subdomains) and
  custom domains.
- **Credentials (Vercel env, never in chat):** `HUBTEL_SMS_CLIENT_ID`, `HUBTEL_SMS_CLIENT_SECRET`,
  `HUBTEL_DISBURSEMENT_ACCOUNT`.
- **Relay redeploy:** after the `/balance` route lands, update the droplet (`server.ts` +
  `relay-handler.ts`) and add `HUBTEL_DISBURSEMENT_ACCOUNT` to its env; confirm with the Hubtel
  Retail Systems Engineer that the relay IP's whitelist also covers the balance-query endpoint.
- Confirm whether the Disbursement account is also used by other Hubtel payouts (if so, SMS
  shares that float and the low-balance threshold should account for it).
- Possible later addition (not in Phase 1): automatic top-up from Collection → Disbursement via
  Hubtel's Balance Transfer API when the float runs low.
