# mNotify Sender ID Integration — Design Spec

## Context

Sender IDs are currently registered and polled against Moolre only (`lib/sms/sender-id-service.ts`, `lib/sms-service.ts`). mNotify also offers sender-ID registration (`POST /senderid/register`) and status-check (`POST /senderid/status`) endpoints. mNotify is already a known SMS-sending provider in this codebase (`PROVIDERS = ["moolre", "mnotify", "brevo"]` in the routing config), just not for sender-ID management.

Requirements (confirmed with the user):
1. Add mNotify sender-ID registration + status-check, independent of Moolre.
2. Track approval status **per provider**, not one combined status — an admin needs to see "approved on Moolre, not yet on mNotify" (or vice versa) at a glance.
3. Submitting a sender ID stops auto-registering with any provider. Every sender ID — tenant-submitted or admin-submitted — lands as a bare pending row. An admin reviews it and explicitly clicks "Push to Moolre" and/or "Push to mNotify" per row, whenever they choose.
4. A "Reject" action marks a row rejected on our side without ever contacting a provider — distinct from a provider rejecting it themselves later.
5. A per-row, per-provider "Fetch status" button (manual status check, no more relying solely on the 10-minute poll cron for visibility).
6. Sending must stay correct when a sender ID is approved on only one provider: the SMS provider fallback chain should skip any provider that hasn't approved the specific sender ID being sent under, rather than attempting it and failing.

## Schema

Add two columns to `sms_sender_ids`, parallel to the existing Moolre ones:

```sql
ALTER TABLE sms_sender_ids
  ADD COLUMN IF NOT EXISTS mnotify_status text,
  ADD COLUMN IF NOT EXISTS mnotify_local_status text NOT NULL DEFAULT 'pending'
    CHECK (mnotify_local_status IN ('pending', 'active', 'rejected')),
  ADD COLUMN IF NOT EXISTS mnotify_last_polled_at timestamptz,
  ADD COLUMN IF NOT EXISTS mnotify_pushed_at timestamptz;
```

The existing `moolre_status`/`local_status`/`last_polled_at` columns gain a parallel `moolre_pushed_at timestamptz` column (nullable; null = never pushed to Moolre). `local_status`'s existing CHECK constraint and default are untouched.

A new row's `local_status` and `mnotify_local_status` both default to `'pending'`, and `moolre_pushed_at`/`mnotify_pushed_at` are both null (meaning "never submitted to that provider") — this is what "fully manual" means: no provider call happens until an admin pushes.

## Workflow change

`submitSenderId()` (`lib/sms/sender-id-service.ts`) currently calls `createMoolreSenderId()` immediately after inserting the row. That call is removed. The function becomes purely: validate → check idempotency → insert the pending row. No provider is contacted at submission time, for either the admin quick-add form or the tenant-facing `/api/sms/sender-ids` POST.

Two new admin-only actions replace it:
- **Push to Moolre**: calls `createMoolreSenderId()` (existing function, unchanged), sets `moolre_pushed_at = now()`.
- **Push to mNotify**: calls the new `createMnotifySenderId()`, sets `mnotify_pushed_at = now()`.

Pushing to a provider a second time is allowed (e.g. after a rejection, to resubmit) — it simply re-calls that provider's register endpoint and updates `*_pushed_at` again.

**Reject**: an admin-only action, scoped to one provider column (reject on Moolre vs reject on mNotify are independent) OR the whole row (if neither provider has been pushed yet). Sets `local_status`/`mnotify_local_status` to `'rejected'` directly in our DB — no provider API call. This is for an admin who decides a sender name shouldn't go out at all (e.g. impersonation, bad word), separate from a provider later rejecting a pushed submission (which the poll/fetch-status flow already handles by writing `'rejected'` from the provider's own response).

## mNotify sender-ID client

New file `lib/mnotify-sender-id.ts` (mirrors the existing Moolre functions' shape):

```typescript
const MNOTIFY_API_KEY = process.env.MNOTIFY_API_KEY
const MNOTIFY_BASE_URL = "https://api.mnotify.com/api"

export async function createMnotifySenderId(senderId: string): Promise<{ ok: boolean; message?: string }>
export async function queryMnotifySenderIdStatus(senderId: string): Promise<{
  rawStatus: string
  localStatus: "pending" | "active" | "rejected"
}>
```

- `createMnotifySenderId`: `POST {MNOTIFY_BASE_URL}/senderid/register?key=...`, body `{sender_name, purpose}`. `purpose` is a fixed platform string (e.g. `"Transactional and marketing SMS for Datagod merchants"`) — the docs don't suggest this varies per sender ID, and there's no per-tenant purpose field to source it from. Success: `{status:"success", code:"2000", summary:{status:"Pending"}}`.
- `queryMnotifySenderIdStatus`: `POST {MNOTIFY_BASE_URL}/senderid/status?key=...`, body `{sender_name}`. Maps `summary.status` — `"Approved"` → `active`, `"Rejected"` → `rejected`, anything else (`"Pending"`, unrecognized) → `pending`. Follows the same hardened pattern just fixed for Moolre: check `response.data?.status !== "success"` (or a non-2000 `code`) BEFORE trusting `summary.status`, returning a `rawStatus: "error"` sentinel on failure instead of storing a misleading value.
- Both fail soft (never throw): network errors and missing API key return `{ok: false, message: ...}` / `{rawStatus: "error", localStatus: "pending"}`, matching `lib/sms-service.ts`'s existing Moolre functions.
- `MNOTIFY_API_KEY` is a new env var the user will add in Vercel (not read locally this session).

## Service layer changes (`lib/sms/sender-id-service.ts`)

- `submitSenderId()`: drop the Moolre auto-push call (see Workflow change above). Still inserts the pending row and still returns it idempotently for a repeat submission by the same owner.
- New `pushSenderId(id: string, provider: "moolre" | "mnotify"): Promise<ServiceResult<SmsSenderId>>` — looks up the row, calls the matching provider's create function, writes `{provider}_status` (if returned) and `{provider}_pushed_at`, returns the updated row. Does NOT flip `local_status`/`mnotify_local_status` to anything other than `pending` on push — only a status check (poll or fetch) does that, consistent with how Moolre already works today.
- New `rejectSenderId(id: string, provider: "moolre" | "mnotify" | "both"): Promise<ServiceResult<SmsSenderId>>` — sets the matching local-status column(s) to `'rejected'` directly, no provider call.
- `pollSenderIds()` extends to also poll any row with `mnotify_local_status = 'pending'` AND `mnotify_pushed_at IS NOT NULL` (skip rows never pushed to mNotify — nothing to poll) via `queryMnotifySenderIdStatus`, mirroring the existing Moolre loop exactly (including the `isSentinel` fail-soft pattern). A row can independently be mid-poll-cycle on one provider and untouched on the other.
- New `fetchSenderIdStatus(id: string, provider: "moolre" | "mnotify"): Promise<ServiceResult<SmsSenderId>>` — the manual, single-row, single-provider version of what the poll cron does in bulk. Used by the new per-row "Fetch status" button. Reuses the same `isSentinel` logic so a transient provider error doesn't clobber the last-known-good status.

## Admin API routes

- `app/api/admin/sms-sender-ids/route.ts`: unchanged (still just create + list) — the POST no longer triggers a provider call because `submitSenderId()` itself changed.
- New `app/api/admin/sms-sender-ids/push/route.ts` — `POST { id, provider: "moolre" | "mnotify" }` → `pushSenderId`.
- New `app/api/admin/sms-sender-ids/reject/route.ts` — `POST { id, provider: "moolre" | "mnotify" | "both" }` → `rejectSenderId`.
- New `app/api/admin/sms-sender-ids/fetch-status/route.ts` — `POST { id, provider: "moolre" | "mnotify" }` → `fetchSenderIdStatus`.
- `app/api/admin/sms-sender-ids/poll/route.ts`: unchanged (still bulk-polls both providers via the extended `pollSenderIds()`).

All four routes are `verifyAdminAccess`-gated, matching every existing admin sender-ID route — these are admin-only actions, not exposed to the tenant-facing `/api/sms/sender-ids` routes.

## Admin UI (`app/admin/sms-centre/_components/ProvidersTab.tsx`)

The sender-IDs table gains a Moolre column and an mNotify column (each showing that provider's local status badge + raw status + last-polled time) in place of today's single combined Status/Moolre-status pair, plus a per-row, per-provider action cluster:
- If not yet pushed to that provider: a "Push" button.
- If pushed and still pending: a "Fetch status" button + a "Reject" button.
- If active or rejected on that provider: just the raw status shown (rejected rows keep a "Push" button to allow resubmission).

The existing global "Poll now" button stays (bulk-polls both providers for all pushed-but-pending rows). The submit form's success toast copy changes from "Approval is asynchronous — use Poll now" to something reflecting that nothing has been pushed yet (e.g. "Submitted. Push to a provider to start approval.").

`app/admin/sms/page.tsx` (the read-only monitoring view) gets the mNotify status column added for consistency, no new buttons — it's explicitly a monitoring surface, not where the user asked for the push/reject controls.

## Send-time gating (`lib/sms-service.ts`'s `sendSMS`)

Today, `local_status === 'active'` is the sole gate (checked once, at enqueue time, in `lib/sms/send-service.ts`) for whether a tenant may send under a given sender ID at all — that gate is unaffected by this work (it becomes "active on Moolre OR active on mNotify" simply by virtue of `local_status` still meaning "approved somewhere," since pushing/approval on either provider can independently flip it — see below).

New, additional behavior inside `sendSMS()`: when `payload.senderId` is a non-default, explicitly-provided sender ID (the tenant-campaign case — platform-default transactional sends, which omit `senderId`, are unaffected and skip this entirely), look up that sender ID's row and filter the provider `order` array to only the provider(s) where it's actually approved, before applying the existing fallback-chain logic unchanged. If the row isn't found, or has no provider approvals at all (shouldn't happen past the enqueue-time gate, but defensively), fall through to the existing unfiltered order rather than sending with an empty list.

This requires `sendSMS()` to do one extra Supabase lookup when `senderId` is present — acceptable, since `sendSMS()` already does a DB-backed `getRoutingConfig()` lookup on every call.

**Deriving `local_status` as "approved on either provider":** rather than maintaining a THIRD combined field that duplicates `local_status`/`mnotify_local_status`, `local_status` columns stays Moolre-specific exactly as today (unchanged meaning), and the enqueue-time gate in `lib/sms/send-service.ts` changes from `.eq("local_status", "active")` to `.or("local_status.eq.active,mnotify_local_status.eq.active")` — "sendable if approved on either." This keeps each column's meaning simple (one column, one provider) rather than overloading `local_status` with a dual meaning.

## Testing

- `lib/mnotify-sender-id.test.ts` — unit tests for `createMnotifySenderId`/`queryMnotifySenderIdStatus` mirroring the existing Moolre test pattern (mock axios, cover success/rejection/error-sentinel cases), including the same "don't trust a non-success response body" regression test just added for Moolre.
- `lib/sms/sender-id-service.test.ts` — extend for `pushSenderId`, `rejectSenderId`, `fetchSenderIdStatus`, and the dual-provider `pollSenderIds` loop.
- `lib/sms/send-service.test.ts` (if it exists) — extend the sender-ID gate test for the `.or(...)` change.
