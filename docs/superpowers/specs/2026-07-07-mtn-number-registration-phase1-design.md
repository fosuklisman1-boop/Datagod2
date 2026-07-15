# Design: MTN Number Registration — Phase 1 (registry + capture + delta export)

**Date:** 2026-07-07
**Branch:** feat/moolre-withdrawal-integration
**Status:** Approved (brainstorming) — ready for implementation planning
**Related:** builds on `2026-07-07-all-order-phone-export-design.md` (reuses `all_order_phones` view + `normalize_gh_phone`)

## Background / problem

MTN now only fulfills data to phone numbers **pre-registered in their system**. We must hand our
provider the numbers to register, and keep doing so as new numbers appear. Phase 1 delivers the
**collection + stateful pipeline + admin download page** so the provider can be given, on an ongoing
basis, only the *new* numbers to register.

**Phase 2 (separate spec, later):** gate MTN fulfillment on registration status — hold an unregistered
number's order, show an on-screen notice, and auto-fulfill once registered. **Out of scope here.**

## Scope (Phase 1)

- A stateful `mtn_number_registry` (`pending` → `submitted` → `registered`, + `rejected`).
- Automatic **capture** of every new MTN data-order beneficiary number (DB trigger, all channels).
- One-time **seed/backfill** from all existing MTN (or prefix-MTN) numbers we already have.
- Admin page `/admin/mtn-registration`: **delta export** of new numbers ("Download new numbers"),
  **mark-registered**, status counts, batch history + re-download.
- **MTN only.** AT/iShare/BigTime/Telecel are untouched.

Not in scope: any change to order/fulfillment/payment flow (that's Phase 2).

## Decisions (locked during brainstorming)

| Decision | Choice |
|----------|--------|
| Capture mechanism | **DB `AFTER INSERT` trigger** on the 5 data-order tables (no code-hooks — no single chokepoint; `api_orders` is inserted inside a `SECURITY DEFINER` SQL function that hooks would miss). |
| Provider file format | **Local `0XXXXXXXXX`** only. |
| Initial seed | **Auto on migration apply** (idempotent via `ON CONFLICT DO NOTHING`). |
| First-order behaviour (hold/notify) | **Phase 2** — not built here. |
| Network scope | **MTN only.** |

## The 5 MTN data-order tables (capture sources)

| Table | Beneficiary phone column | Network column |
|-------|--------------------------|----------------|
| `orders` | `phone_number` | `network` |
| `shop_orders` | `customer_phone` | `network` |
| `api_orders` | `recipient_phone` | `network` |
| `ussd_orders` | `recipient_phone` | `network` |
| `ussd_shop_orders` | `recipient_phone` | `network` |

(Airtime/AFA/results are **not** data purchases and are excluded — MTN's restriction is on data.)

## Data model (new migration)

### `mtn_number_registry`
- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `phone text NOT NULL UNIQUE` — canonical local `0XXXXXXXXX` (via `normalize_gh_phone`)
- `status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','registered','rejected'))`
- `source text` — where first seen (`'order:orders'`, `'seed:users'`, …)
- `first_seen_at timestamptz NOT NULL DEFAULT now()`
- `submitted_at timestamptz`, `submitted_batch uuid` (→ `mtn_registration_batches.id`)
- `registered_at timestamptz`
- `notes text`
- `updated_at timestamptz NOT NULL DEFAULT now()`
- Indexes: `(status)`, and the UNIQUE on `phone`.
- **RLS enabled**, single `service_role` `FOR ALL` policy; `REVOKE ALL … FROM anon, authenticated`.

### `mtn_registration_batches`
- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `batch_time timestamptz NOT NULL DEFAULT now()`
- `phones jsonb NOT NULL` — array of the `0XXXXXXXXX` strings in the batch (for re-download)
- `number_count integer NOT NULL`
- `status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','registered'))`
- `downloaded_by uuid`, `downloaded_by_email text`
- `registered_at timestamptz`
- `created_at timestamptz NOT NULL DEFAULT now()`
- **RLS enabled**, `service_role`-only (mirrors `airtime_download_batches`).

## SQL helpers (new migration)

- **Reuse** `normalize_gh_phone(text)` (already exists from the export migration).
- **New** `gh_is_mtn(raw text) RETURNS boolean` — true iff the normalized number's two significant
  digits ∈ {24,25,53,54,55,59} (mirrors `detectGhanaNetwork` MTN prefixes in `lib/phone-format.ts`).
  Returns false/NULL for un-normalizable input.

## Capture trigger (new migration)

One `SECURITY DEFINER` function fired `AFTER INSERT` on each of the 5 data tables:

```
capture_mtn_number():
  j := to_jsonb(NEW)
  if lower(coalesce(j->>'network','')) <> 'mtn' then return NEW   -- MTN only
  raw := per-table beneficiary column:
           orders -> phone_number
           shop_orders -> customer_phone
           else (api/ussd/ussd_shop) -> recipient_phone
  norm := normalize_gh_phone(raw)
  if norm is null then return NEW
  INSERT INTO mtn_number_registry(phone, source)
    VALUES (norm, 'order:'||TG_TABLE_NAME)
    ON CONFLICT (phone) DO NOTHING           -- idempotent; never revives a registered/rejected row
  return NEW
  EXCEPTION WHEN OTHERS THEN return NEW       -- best-effort; never break the order insert
```

- `SECURITY DEFINER` + `SET search_path = public` so the insert succeeds regardless of the writing
  role; function `REVOKE`d from PUBLIC/anon/authenticated.
- Fires on *attempt* (any new order row, any payment/fulfillment status) — that's the point: a new
  number that can't yet be fulfilled is exactly the one we must register.
- One `CREATE TRIGGER trg_capture_mtn_<table> AFTER INSERT ON <table> FOR EACH ROW EXECUTE FUNCTION
  capture_mtn_number();` per table.

## Seed / backfill (in the migration, after table creation)

Idempotent inserts (`ON CONFLICT (phone) DO NOTHING`), all as `status='pending'`:
- **Order buyers (definite MTN):** `SELECT DISTINCT phone FROM all_order_phones WHERE network_raw='MTN' AND phone IS NOT NULL` → `source='seed:orders'`.
- **Phone-verification (known MTN):** `phone_verification_results WHERE network='MTN'` → `'seed:phone_verify'`.
- **Prefix-MTN contacts** (via `gh_is_mtn`): `users.phone_number` → `'seed:users'`; `whatsapp_conversations.phone_number` → `'seed:whatsapp'`; `sms_contacts.phone_number` → `'seed:sms_contacts'`; `sms_messages.phone` → `'seed:sms_messages'`; `broadcast_recipients.phone` → `'seed:broadcast'`; `phone_otp_verifications.phone` → `'seed:otp'`.

All numbers normalized; NULLs filtered. Re-running the migration is safe (no duplicates).

## Admin API routes (`app/api/admin/mtn-registration/…`, all `verifyAdminAccess`, service-role client)

1. **`GET .../export`** — the delta download.
   - Select `phone` from `mtn_number_registry WHERE status='pending'` ordered by `first_seen_at`.
   - **If none pending:** write **no** batch row, return a header-only `.xlsx` with response header
     `X-New-Count: 0`. (The page reads `X-New-Count` and, when 0, toasts "No new numbers" instead of
     saving the file.)
   - Otherwise: set `X-New-Count: <n>`, create a `mtn_registration_batches` row (phones, count, downloaded_by/email); then
     **claim**: `UPDATE mtn_number_registry SET status='submitted', submitted_at=now(),
     submitted_batch=<id> WHERE status='pending' AND phone = ANY(<claimed phones>)` — race-safe (only
     flips still-`pending` rows).
   - Build `.xlsx`, single sheet `MTN Numbers`, one column **`Phone`** (`0XXXXXXXXX`).
   - Write an `admin_audit_log` row (`action: 'export_mtn_registration'`, count) — bulk PII export.
   - Return the file (`Content-Disposition: attachment; filename="mtn-register-YYYY-MM-DD.xlsx"`,
     `Cache-Control: no-store`, `export const dynamic = "force-dynamic"`).
2. **`POST .../mark-registered`** — body `{ batchId }`: set `mtn_number_registry.status='registered',
   registered_at=now()` where `submitted_batch=batchId AND status='submitted'`, and the batch row
   `status='registered', registered_at=now()`. Audit-logged.
3. **`GET .../list`** — status counts (`pending`/`submitted`/`registered`/`rejected`) + recent batch
   history (id, batch_time, number_count, status).
4. **`GET .../batch/[id]/download`** — re-download a prior batch's numbers from its stored `phones`
   jsonb (no status change), for when a file is lost.

## Admin page `/admin/mtn-registration` (client, template = `/admin/phone-verification`)

- `<DashboardLayout>` + `useAdminProtected()`; bearer token via `supabase.auth.getSession()`.
- **Status summary** cards: Pending / Submitted / Registered counts.
- **"Download new numbers"** button → calls `export`, streams the `.xlsx`, toasts count; refetches
  counts (pending → submitted afterwards).
- **Batch history** table: batch_time, count, status Badge, **"Mark registered"** button (calls
  `mark-registered`), and a **re-download** icon (`batch/[id]/download`).
- One sidebar link in `components/layout/sidebar.tsx` (copy the `/admin/phone-verification` block,
  new icon), label **"MTN Registration"**.

## Security & audit

- All routes `verifyAdminAccess`; service-role reads/writes server-side only.
- Registry + batches tables: RLS on, `service_role`-only, revoked from anon/authenticated.
- Capture + `gh_is_mtn` functions: `SET search_path = public`; capture is `SECURITY DEFINER` and
  revoked from PUBLIC/anon/authenticated.
- Bulk exports audit-logged (`admin_audit_log`).

## Testing

- **Pure unit tests** (Vitest, co-located) for any TS extracted for the routes — e.g. a
  `buildMtnRegistrationSheet(phones)` shaper (one `Phone` column) and a `phonesFromRegistryRows`
  helper. Keep route-DB logic thin.
- **SQL verification queries** (run on apply, like the export migration): `gh_is_mtn` truth table
  (`0241234567`→true, `0201112223`→false, junk→false/NULL); trigger smoke — insert a throwaway MTN
  `orders` row in a transaction, assert a `pending` registry row appears, `ROLLBACK`; seed sanity —
  `SELECT status, count(*) FROM mtn_number_registry GROUP BY 1`.
- **Delta correctness test:** after an export claims the pending set, a second export with no new
  inserts yields zero new numbers (all now `submitted`).

## Files (anticipated)

- `migrations/20260707_mtn_number_registry.sql` — tables, `gh_is_mtn`, capture function + 5 triggers,
  seed backfill, grants/RLS.
- `lib/mtn-registration.ts` — pure helpers (sheet shaping) + co-located tests.
- `app/api/admin/mtn-registration/export/route.ts`
- `app/api/admin/mtn-registration/mark-registered/route.ts`
- `app/api/admin/mtn-registration/list/route.ts`
- `app/api/admin/mtn-registration/batch/[id]/download/route.ts`
- `app/admin/mtn-registration/page.tsx`
- `components/layout/sidebar.tsx` — one nav link.

## Out of scope / open items

- **Phase 2**: fulfillment gate (hold unregistered MTN orders), on-screen customer notice, and
  auto-fulfill-on-`registered` cron. Separate spec.
- **Provider confirmation ingest**: Phase 1 marks a batch registered via an admin button (manual).
  If the provider later returns a file of confirmed/rejected numbers, an upload-to-reconcile flow can
  be added.
- **Portability caveat**: prefix-MTN seeding may include a few ported non-MTN numbers; MTN simply
  won't register those. Order-capture (`network='MTN'`) is exact and unaffected.
- **`rejected` handling**: Phase 1 stores the state but the only writer is a future manual/reconcile
  path; capture's `ON CONFLICT DO NOTHING` intentionally never revives a `rejected`/`registered` row.
