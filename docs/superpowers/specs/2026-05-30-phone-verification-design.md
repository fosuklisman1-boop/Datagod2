# Phone Number Verification — Design Spec
**Date:** 2026-05-30  
**Branch:** feat/moolre-withdrawal-integration

---

## Context

Admins need a way to bulk-verify phone numbers against the Moolre validate API to confirm they are active mobile money accounts. Verified numbers (those with a returned account name) are saved to the database alongside their account name and network. The tool is standalone — no downstream action is taken; it generates a verification report and supports Excel export. Upload volumes up to 500,000 numbers must be supported.

---

## Architecture

**Approach:** Background processing with client-driven processing loop.

The admin uploads a CSV or Excel file. The server immediately parses it, creates a session record, and bulk-inserts all numbers as `pending`, returning a `sessionId`. The frontend then drives the processing by calling the `/process` endpoint in a loop — each call processes a chunk of 200 numbers and returns `remaining` count. The frontend updates the progress bar after each chunk. All state is persisted in the database, so if the tab is refreshed the admin can resume from Session History (previously processed numbers won't be re-processed as they are no longer `pending`).

**Concurrency:** The background processor reads numbers in batches of 50 and calls Moolre's validate API with 20 concurrent requests per batch. This brings 500k numbers to an estimated 40–60 minutes depending on Moolre response times.

**Moolre integration:** Reuses the existing `validateAccountName()` function from `lib/moolre-transfer.ts`. A number is **verified** if Moolre returns a non-empty account name. A number is **invalid** if Moolre returns no name, an error, or the phone is unparseable.

**Network detection:** Automatically inferred from the phone prefix using existing logic in `lib/phone-validation.ts`. No network column required in the upload file.

---

## Database Schema

### `phone_verification_sessions`
```sql
id              uuid PRIMARY KEY DEFAULT gen_random_uuid()
file_name       text NOT NULL
total_count     int NOT NULL DEFAULT 0
verified_count  int NOT NULL DEFAULT 0
invalid_count   int NOT NULL DEFAULT 0
status          text NOT NULL DEFAULT 'processing'  -- processing | completed | failed
created_by      uuid REFERENCES auth.users(id)
created_at      timestamptz DEFAULT now()
completed_at    timestamptz
```

### `phone_verification_results`
```sql
id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
session_id      uuid REFERENCES phone_verification_sessions(id) ON DELETE CASCADE
phone_number    text NOT NULL
account_name    text                -- null if invalid
network         text NOT NULL       -- MTN | TELECEL | AT | UNKNOWN
status          text NOT NULL DEFAULT 'pending'  -- pending | verified | invalid
verified_at     timestamptz
```

**Indexes:**
- `idx_pvr_session_id` on `phone_verification_results(session_id)`
- `idx_pvr_session_status` on `phone_verification_results(session_id, status)`

**RLS:** Tables are admin-only. All access via service role key (same pattern as withdrawal tables).

---

## API Routes

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/admin/phone-verify/upload` | Parse file, create session, bulk-insert numbers, return `sessionId` |
| POST | `/api/admin/phone-verify/process` | Process one chunk of 200 pending numbers; returns `{ processed, remaining, status }` |
| GET | `/api/admin/phone-verify/session/[id]` | Load session results (paginated, filterable by status) |
| GET | `/api/admin/phone-verify/session/[id]/export` | Download results as .xlsx |
| GET | `/api/admin/phone-verify/sessions` | List all sessions for history tab |

All routes use `verifyAdminAccess(request)` from `lib/admin-auth.ts`.

### Upload route detail
- Accepts `multipart/form-data` with `file` field
- Supports `.csv` and `.xlsx` (reuses xlsx library already in project)
- File size limit: 50 MB
- Parses to array of phone strings, normalises via `normalizeGhanaPhoneNumber()` from `lib/phone-validation.ts`
- Bulk-inserts all numbers in batches of 1000 using Supabase service role
- Returns `{ sessionId }` — does NOT trigger processing (avoids serverless timeout issues)

### Process route detail
- Called repeatedly by the **client** in a loop (not fire-and-forget from upload route)
- Each call processes one chunk: reads up to 200 `pending` rows for the given `session_id`
- Calls `validateAccountName()` for all 200 in parallel (20 concurrent via a concurrency limiter)
- Updates each row: `status = verified/invalid`, `account_name`, `verified_at`
- Updates session counters (`verified_count`, `invalid_count`) after the chunk
- Returns `{ processed: N, remaining: M, status: "in_progress" | "completed" }`
- Client calls this endpoint in a loop until `status = "completed"`, with a 1-second pause between calls
- On unhandled error: sets session `status = failed`, returns error message

### Export route detail
- Queries all results for session ordered by status (verified first)
- Builds xlsx workbook with columns: Phone Number, Account Name, Network, Status
- Two sheets: "Verified" (verified only) and "All Results"
- Streams as `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- File name: `verification-{sessionId}-{date}.xlsx`

---

## Frontend Page

**Route:** `/admin/phone-verification`  
**File:** `app/admin/phone-verification/page.tsx`  
**Pattern:** Wraps with `DashboardLayout` + `useAdminProtected()` hook (same as all admin pages)

### Tab 1 — Upload & Verify
1. **Drag & drop zone** — accepts .csv / .xlsx, 50 MB max, with "Download Template" button (generates a sample single-column CSV)
2. **Parse preview** — after file selected: shows file name + number count + "Start Verification" button
3. **Progress bar** — appears after start; frontend calls `/api/admin/phone-verify/process` in a loop, updating the bar after each chunk response; shows `X / total processed`
4. **Results summary** — stat cards for Verified / Invalid / Total; "Export .xlsx" button
5. **Filter pills** — All / Verified / Invalid
6. **Results table** — columns: #, Phone, Account Name, Network, Status; paginated (100 rows per page)

### Tab 2 — Session History
- Table of all past sessions: Date, File Name, Total, Verified, Invalid, Actions
- Actions per row: "View" (switches to Tab 1 and loads that session's results) + "↓ xlsx" (direct export)

---

## Files to Create / Edit

| Action | File |
|--------|------|
| CREATE | `app/admin/phone-verification/page.tsx` |
| CREATE | `app/api/admin/phone-verify/upload/route.ts` |
| CREATE | `app/api/admin/phone-verify/process/route.ts` |
| CREATE | `app/api/admin/phone-verify/session/[id]/route.ts` |
| CREATE | `app/api/admin/phone-verify/session/[id]/export/route.ts` |
| CREATE | `app/api/admin/phone-verify/sessions/route.ts` |
| CREATE | `migrations/0043_phone_verification_tables.sql` |
| EDIT | `components/layout/sidebar.tsx` — add nav link under admin section |
| EDIT | `lib/moolre-transfer.ts` — ensure `validateAccountName` is exported |

---

## Reused Existing Code

- `lib/moolre-transfer.ts` → `validateAccountName(account, channelId)` — core Moolre validate call
- `lib/phone-validation.ts` → `normalizeGhanaPhoneNumber()`, `validatePhoneNumber()` — phone parsing and network detection
- `lib/admin-auth.ts` → `verifyAdminAccess(request)` — admin authentication
- `xlsx` npm package (already installed) — file parsing and export generation
- `DashboardLayout`, `useAdminProtected` — page wrapper pattern

---

## Verification / Testing

1. Run migration `0043_phone_verification_tables.sql` against local Supabase
2. Navigate to `/admin/phone-verification` — page should load with empty history
3. Upload a small CSV (10 numbers, mix of valid/invalid Ghana numbers)
4. Confirm session created, progress bar appears, polling works
5. Confirm results table populates with correct account names and statuses
6. Click "Export .xlsx" — verify file downloads with two sheets and correct data
7. Check Session History tab — new session row should appear
8. Click "View" on history row — should reload results for that session
9. Test with a large file (~1000 numbers) to verify bulk insert and batch processing
10. Verify `lib/moolre-transfer.ts` env vars (`MOOLRE_TRANSFER_USER`, `MOOLRE_TRANSFER_KEY`) are set
