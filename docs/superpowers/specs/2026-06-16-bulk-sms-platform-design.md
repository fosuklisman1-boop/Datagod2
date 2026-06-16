# Bulk SMS Platform — Design Spec

**Date:** 2026-06-16
**Status:** Approved
**Branch:** feat/bulk-sms-platform (to be created)

---

## Overview

A multi-tenant bulk-SMS product (in the spirit of mNotify / Hubtel / Arkesel) layered on top of the platform's existing Moolre SMS integration. The admin gets a full SMS console; **each shop owner and each sub-agent gets their own independent SMS account** with their own contacts, sender IDs, prepaid unit balance, and campaigns.

The feature reuses the platform's hardest-won assets rather than rebuilding them:

- The **durable-send pattern** from the admin broadcast system (`broadcast_recipients` + `lib/broadcast-drain.ts`): claim rows `FOR UPDATE SKIP LOCKED`, attempt-cap, idempotent per-row sending, survives tab close.
- The **Moolre send + delivery-status pipeline** already in `lib/sms-service.ts` (`sendSMSViaMoolre`, `queryMoolreDeliveryStatus`) and the `sms-delivery-sync` cron writing to `sms_logs`.
- The **wallet + Paystack** flows for one of the three top-up paths.

What is genuinely new: contacts/audiences, per-tenant sender-ID management, a prepaid **units** ledger, a campaign composer with a live preview, and a purpose-built campaign queue. New tables and a new drain are created rather than overloading `broadcast_recipients` (Option B — reuse the *pattern*, not the *table*), keeping the two products independently understandable and unable to break each other.

### Key decisions (from brainstorming)

| Area | Decision |
|---|---|
| Product shape | New product; purpose-built `sms_campaigns`/`sms_messages` queue reusing the broadcast drain pattern + existing Moolre send/delivery-sync |
| Tenancy | One `sms_account` per user — admin, each shop owner, each sub-agent. Everything scoped by `sms_account_id` + RLS |
| Audience | Uploaded contact lists/groups **and** auto-built customer segments |
| Billing | Internal prepaid **units** ledger; top-up via cash wallet, Paystack, **and** admin manual; admin-defined bundle tiers; **segment-aware** debit; reserve-on-start / settle-on-send |
| Supply guard | Monitor Moolre master credit balance; auto-pause campaign `awaiting_credit` + alert admin; auto-resume when funded |
| Sender IDs | Per account; create at Moolre (type 3, no `approve`) → poll status (type 1) → `active`; only active IDs usable for sends |
| Send engine | Cron drain mirrors `lib/broadcast-drain.ts`; **batches** recipients into Moolre `messages[]` POST; per-recipient `ref` tracking |
| Composer | Merge fields, audience picker (groups ∪ segments, deduped), sender picker, scheduling, and a **full live preview** |
| Scheduling | In v1 |
| Reports | Aggregate `sms_messages` / `sms_logs` per campaign via existing delivery-sync |

### v1 exclusions (deliberate, recorded as risk + fast-follow)

- **No opt-out / STOP suppression.** Honoring opt-outs protects sender-ID reputation and provider goodwill in Ghana; v1 ships without it to reduce scope and avoid an unconfirmed Moolre inbound-SMS webhook dependency. Planned fast-follow once inbound is confirmed.
- **No sub-agent nesting.** Sub-agents get a flat per-account model identical to shop owners, not a parent→child billing hierarchy.

---

## Architecture

```
┌─────────────────────────── Bulk SMS Product ───────────────────────────┐
│                                                                         │
│  FRONT OF HOUSE (new)                    BACK OF HOUSE                   │
│  ┌──────────────┐                        ┌──────────────────┐           │
│  │ Contacts &   │──┐                      │ sms_campaigns    │           │
│  │ Groups       │  │                      │ + sms_messages   │           │
│  └──────────────┘  │      compose         │ (new queue)      │           │
│  ┌──────────────┐  ├─────────────────────▶│                  │           │
│  │ Customer     │  │   reserve units      │ drain cron       │           │
│  │ Segments     │──┘                      │ (broadcast       │           │
│  └──────────────┘                         │  pattern, batched)│          │
│  ┌──────────────┐                         └────────┬─────────┘           │
│  │ Campaign     │  live preview                    │ batched send        │
│  │ Composer     │  (phone mock + meter)            ▼                      │
│  └──────────────┘                         ┌──────────────────┐           │
│  ┌──────────────┐   Moolre type 3/1       │ POST /sms/send   │           │
│  │ Sender IDs   │◀────────────────────────│ messages[] +     │           │
│  │ (create+poll)│                         │ per-campaign      │          │
│  └──────────────┘                         │ sender ID        │           │
│  ┌──────────────┐   settle units          └────────┬─────────┘           │
│  │ SMS Units /  │◀────────────────────────────────┐│                     │
│  │ Bundles      │   (3 top-up paths)               ▼▼                     │
│  └──────────────┘                         ┌──────────────────┐           │
│  ┌──────────────┐  master-balance gate    │ sms_logs +       │           │
│  │ Supply Guard │◀── Moolre type 2 ───────│ delivery-sync    │           │
│  │ + Reports    │                         │ (EXISTING)       │           │
│  └──────────────┘                         └──────────────────┘           │
│                                                                         │
│  TENANCY: every row scoped by sms_account_id (RLS → user_id)            │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tenancy spine

Everything hangs off a single `sms_account` owned by a `user_id`:

- `owner_type` ∈ `platform | shop | sub_agent` — drives permissions and pricing only, not the data shape.
- `owner_id` — `shop_id` / sub-agent id; null for `platform`.
- An account is created lazily on first visit to the SMS console (or eagerly on shop/sub-agent approval).
- **Every** contact, group, sender ID, campaign, and unit transaction references `sms_account_id`. That single FK *is* the tenant boundary: one `.eq("sms_account_id", …)` everywhere, re-enforced by RLS.

**RLS is a first-class requirement.** Contact lists are tenant-private PII. Per the prior RLS audit (`project-rls-grant-model`), bare `USING(true)` policies leak; all new tables get explicit policies scoping `sms_account_id` → owning `user_id`, with service-role access for the cron drains.

---

## Data model (new tables)

| Table | Purpose | Key columns |
|---|---|---|
| `sms_accounts` | tenant + unit balance | `id`, `user_id`, `owner_type`, `owner_id`, `unit_balance int`, `status`, timestamps |
| `sms_unit_transactions` | units audit log (credit/debit) | `sms_account_id`, `delta int`, `reason`, `balance_after int`, `ref`, `campaign_id?`, timestamps |
| `sms_bundles` | admin-defined buyable tiers | `id`, `name`, `units int`, `price_ghs numeric`, `owner_type_scope`, `active bool` |
| `sms_sender_ids` | per-account sender IDs | `sms_account_id`, `sender_id (≤11)`, `moolre_status`, `local_status`, `last_polled_at`, timestamps |
| `sms_contacts` | tenant contacts | `sms_account_id`, `phone` (normalized), `first_name`, `attributes jsonb`, timestamps |
| `sms_groups` | contact lists | `sms_account_id`, `name`, timestamps |
| `sms_group_members` | M:N join | `group_id`, `contact_id` |
| `sms_campaigns` | a send | `sms_account_id`, `sender_id`, `body`, `audience jsonb`, `scheduled_at`, `status`, `units_reserved int`, count columns, timestamps |
| `sms_messages` | per-recipient queue row | `campaign_id`, `phone`, `rendered_body`, `ref`, `status`, `attempts int`, `moolre_ref`, `error_message`, timestamps |

**Reused, not rebuilt:** `sms_logs` (delivery-sync already writes here; `sms_messages.ref` uses the same tracking-ref mechanism `queryMoolreDeliveryStatus` polls), `wallets`/`wallet_transactions` (cash top-up), Paystack init/verify/webhook (Paystack top-up).

`sms_campaigns.status` ∈ `draft | scheduled | queued | sending | awaiting_credit | completed | cancelled | failed`.
`sms_messages.status` ∈ `pending | claimed | sent | delivered | failed`.

Unique constraints: `sms_contacts (sms_account_id, phone)` for per-account dedupe; `sms_sender_ids (sms_account_id, sender_id)`.

---

## Components

### 1. Contacts & Groups

- Import by paste or CSV upload → normalized via existing `normalizePhoneNumber` → deduped per account (`ON CONFLICT (sms_account_id, phone)`).
- Many-to-many groups via `sms_group_members`.
- Invalid/unparseable numbers surface as **import errors**, never silently dropped.
- `attributes jsonb` holds merge-field data (e.g. `first_name`, custom fields) used by the composer preview and render.

### 2. Customer Segments (auto-audiences)

- Read-only queries over existing customer/order data ("everyone who bought MTN data", "shop X customers"). No new storage — a segment resolves to a phone-number list at compose time.
- For shop/sub-agent accounts, segments are scoped to that owner's own customers.
- Defined as a small set of named, parameterized server-side queries (not free-form SQL).

### 3. Sender IDs

- Submit → `POST /open/sms/query` type 3 with `senderids:[{senderid}]` (no `approve`, since the integrator lacks that permission — `ASMQ09`). Store `local_status=pending`.
- A **poll cron** calls type 1 (`{senderid}`) per pending ID until Moolre returns "Approved" (`ASMQ02`) → `local_status=active`; update `last_polled_at`.
- Campaigns may only select an `active` sender ID.
- Optional platform-shared fallback sender for accounts with none yet (configurable; off by default to keep attribution clean).

### 4. SMS Units & Bundles (billing)

- Internal `unit_balance` per account, the quota/billing layer. **Decoupled** from the single shared Moolre master credit pool (the supply layer — see Supply Guard).
- **Unit = one SMS segment.** Segment count uses GSM-7 (160 chars/segment, 153 in concatenated parts) vs UCS-2 (70 chars/segment, 67 concatenated) detection. A single non-GSM character (emoji, smart quote) forces UCS-2 and must be counted correctly.
- **Three top-up paths**, each writing an `sms_unit_transactions` credit:
  1. **Cash wallet** — atomic debit `wallets` + credit units (one money system, instant), logged in `wallet_transactions`.
  2. **Paystack** — reuse init/verify/webhook; on confirmed success, credit units.
  3. **Admin manual** — admin allocates units to any account (e.g. offline payment).
- **Reserve / settle:** units are reserved when a campaign starts (`units_reserved`), settled as messages are sent, and reserved-but-unsent units are refunded on cancel/failure. No double-debit, no negative balance.
- Bundle tiers (`sms_bundles`) are admin-defined; `owner_type_scope` allows different pricing for shops vs sub-agents.

### 5. Campaign Composer + Engine

**Composer** (the live preview is the billing surface):

```
┌─ Compose ───────────────────┐   ┌─ Live Preview ────────────────┐
│ From: [ GHANAKAY  ▼]        │   │  ┌──────────────────────────┐ │
│ To:   [VIP list ✓][MTN seg✓]│   │  │ GHANAKAY            now  │ │
│       8,431 recipients      │   │  │ Hi Ama, your data bundle │ │
│ Message:                    │   │  │ promo ends Friday!       │ │
│ Hi {{first_name}}, your...  │   │  └──────────────────────────┘ │
│                             │   │  Sample: Ama  ◀ prev ▶ next   │
│                             │   │  149 chars · 1 segment · GSM-7│
│                             │   │  8,431 × 1 = 8,431 units ✓    │
└─────────────────────────────┘   └───────────────────────────────┘
```

- **Phone-mock bubble** with the chosen sender ID as "from".
- **Merge fields** (`{{first_name}}` etc.) rendered from a **real sample contact**, with prev/next to cycle samples and spot-check rendering.
- **Live meter:** char count, segment count, GSM-7 vs UCS-2 indicator, and unit cost (`segments × recipients`). Turns **red and blocks send** if `cost > unit_balance`, or warns "this will cost 2×" when a Unicode char inflates segments.
- Audience picker unions groups + segments and **dedupes** the resolved recipient set.
- **Scheduling:** a `scheduled_at` datetime; "Send now" sets it to now.

**Engine** (`lib/sms-campaign-drain.ts`, mirroring `lib/broadcast-drain.ts`):

- On submit: resolve recipients → render per-recipient bodies → insert `sms_messages` rows → reserve units → set campaign `queued`/`scheduled`.
- Drain cron (every minute) claims due rows (`scheduled_at <= now`) via a `claim_sms_messages(...)` SQL fn (`FOR UPDATE SKIP LOCKED`, increments `attempts` at claim, cap 3).
- **Batched send:** group claimed rows into `POST /open/sms/send` calls with a `messages:[{recipient, message, ref}]` array (e.g. 100/batch). Each message keeps its own `ref` for per-recipient delivery tracking.
- **Partial batch failure:** mark only the failed refs retryable; succeeded refs settle their unit and move to `sent`.
- Stale `claimed` rows (crashed worker) reaped back to `pending` after a timeout, as in broadcast.
- Recompute campaign counts + flip to `completed` when nothing is outstanding.

### 6. Supply Guard + Reports

- **Supply guard:** before each batch, check the Moolre master balance (`POST /open/sms/query` type 2 → `data.balance`). If it cannot cover the batch, set the campaign `awaiting_credit`, alert admin (in-app + existing notification channels), and stop draining that campaign. A resume check auto-continues when the master balance recovers. An admin dashboard widget shows the live master balance; an optional admin-set safety floor blocks sends below a threshold.
- **Reports:** aggregate `sms_messages` / `sms_logs` per campaign and per account (queued / sent / delivered / failed), powered by the existing `queryMoolreDeliveryStatus` + `sms-delivery-sync` cron — no new delivery infrastructure.

---

## Routes & surfaces (indicative)

| Surface | Path |
|---|---|
| Admin SMS console | `app/admin/sms/` (dashboard, campaigns, contacts, sender IDs, bundles, master-balance widget) |
| Shop/sub-agent SMS console | `app/dashboard/sms/` (same features, scoped to their account) |
| Public storefront | none (internal tool) |
| Campaign create/list/detail | `app/api/sms/campaigns/...` |
| Contacts + groups + import | `app/api/sms/contacts/...`, `app/api/sms/groups/...` |
| Sender IDs (submit/list) | `app/api/sms/sender-ids/...` |
| Units: balance, buy bundle, admin allocate | `app/api/sms/units/...`, `app/api/admin/sms/allocate/...` |
| Cron: campaign drain | `app/api/cron/sms-campaign-drain/route.ts` (vercel.json, every minute) |
| Cron: sender-ID poll | `app/api/cron/sms-senderid-poll/route.ts` |
| Cron: master-balance / awaiting_credit resume | folded into drain or a small cron |
| Provider helpers | extend `lib/sms-service.ts`: `sendSMSBatchViaMoolre`, `createMoolreSenderId`, `queryMoolreSenderIdStatus`, `queryMoolreSmsBalance` |

---

## Build sequence

Shipped together in v1, built in dependency order so each layer is testable before the next:

1. **Foundation** — `sms_accounts`, units ledger, RLS, bundle tiers, all three top-up paths.
2. **Sender IDs** — submit → create at Moolre → poll cron → admin visibility.
3. **Contacts & groups** — import, dedupe, M:N groups.
4. **Composer + engine** — segments, live preview/cost meter, `sms_messages`, drain, batched send.
5. **Supply guard + reports + scheduling** — master-balance gating + auto-pause/resume, dashboards, scheduled sends.

---

## Error handling & testing

- **Money/units correctness (highest risk):** pure, unit-tested helpers for segment count, cost, and reserve/settle (matches the `reference-testing` "pure money helper" pattern). Covered: no double-debit, no negative balance, refund-on-cancel, GSM-7 vs UCS-2 boundary counts (159/160/161 chars; one emoji flips to UCS-2).
- **Idempotent sends:** a re-drained `sms_message` never double-sends (per-row status + attempt cap, same guard as broadcast). Already-sent rows are never re-sent on retry.
- **Partial batch failures:** a batch where some `messages[]` refs fail marks only those retryable.
- **Tenant isolation:** tests proving account A can never read or send to account B's contacts (query scoping + RLS).
- **Supply guard:** campaign pauses at `awaiting_credit` when master balance is short, and auto-resumes when funded, with reserved units intact.
- **Sender-ID gating:** a campaign cannot send on a non-`active` sender ID.

---

## Open dependencies / follow-ups

- **Moolre inbound-SMS webhook** (for STOP auto-opt-out) — unconfirmed; gates the suppression fast-follow.
- **Moolre master SMS account funding** — operational: admin must keep the shared Moolre credit pool topped up; the supply guard + dashboard widget make low balance visible.
- **`vercel.json` cron registration** for the new drain + poll crons.
