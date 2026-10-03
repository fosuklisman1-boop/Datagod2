# mNotify Sender ID Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add mNotify as a second sender-ID provider alongside Moolre, track approval per provider, replace auto-push-on-submit with admin-triggered manual push/reject/fetch-status per row, and make SMS sending skip a provider that hasn't approved the sender ID in use.

**Architecture:** Parallel `mnotify_*` columns on the existing `sms_sender_ids` table (not a new table — two providers, flat and simple, matching the existing Moolre columns). A new `lib/mnotify-sender-id.ts` client mirrors the existing Moolre functions' shape exactly. `lib/sms/sender-id-service.ts` gains three new provider-generic functions (`pushSenderId`, `rejectSenderId`, `fetchSenderIdStatus`) and `pollSenderIds()` extends to loop both providers.

**Tech Stack:** Next.js route handlers, Supabase (service-role), axios, Vitest.

## Global Constraints

- No auto-push on submit, anywhere — not the admin quick-add form, not the tenant-facing `/api/sms/sender-ids` POST. `submitSenderId()` only ever inserts a pending row.
- Reject is purely local (never calls a provider) and is scoped per-provider or to the whole row before any push.
- `local_status` keeps its current Moolre-only meaning; the enqueue-time sendable gate becomes "active on Moolre OR active on mNotify" via an `.or()` query, not a new combined column.
- Every new admin route is `verifyAdminAccess`-gated, matching the existing sender-ID routes.
- mNotify client fail-softs exactly like the just-fixed Moolre one: never trust a non-success response body as if it were a real status (the exact bug just fixed in `queryMoolreSenderIdStatus`).

---

### Task 1: Schema migration

**Files:**
- Create: `migrations/sms_sender_ids_mnotify_columns.sql`

- [ ] **Step 1: Write and apply the migration**

```sql
-- Parallel mNotify columns on sms_sender_ids, alongside the existing Moolre
-- ones. A new row starts untouched on both providers (local_status and
-- mnotify_local_status both default 'pending', both *_pushed_at null) — no
-- provider is contacted until an admin explicitly pushes.
ALTER TABLE sms_sender_ids
  ADD COLUMN IF NOT EXISTS mnotify_status text,
  ADD COLUMN IF NOT EXISTS mnotify_local_status text NOT NULL DEFAULT 'pending'
    CHECK (mnotify_local_status IN ('pending', 'active', 'rejected')),
  ADD COLUMN IF NOT EXISTS mnotify_last_polled_at timestamptz,
  ADD COLUMN IF NOT EXISTS mnotify_pushed_at timestamptz,
  ADD COLUMN IF NOT EXISTS moolre_pushed_at timestamptz;
```

Apply via the Supabase Management API SQL endpoint (see this session's established pattern — `POST /v1/projects/riijesduargxlzxuperj/database/query`). Verify with:
```sql
select column_name from information_schema.columns where table_name = 'sms_sender_ids' order by ordinal_position;
```
Expected: the 5 new columns present.

- [ ] **Step 2: Commit**

```bash
git add migrations/sms_sender_ids_mnotify_columns.sql
git commit -m "feat(sms): add mNotify sender-ID columns to sms_sender_ids"
```

---

### Task 2: mNotify sender-ID client

**Files:**
- Create: `lib/mnotify-sender-id.ts`
- Create: `lib/mnotify-sender-id.test.ts`

**Interfaces:**
- Produces: `createMnotifySenderId(senderId: string): Promise<{ok: boolean; message?: string}>`, `queryMnotifySenderIdStatus(senderId: string): Promise<{rawStatus: string; localStatus: "pending"|"active"|"rejected"}>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// lib/mnotify-sender-id.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockPost = vi.hoisted(() => {
  process.env.MNOTIFY_API_KEY = "test-mnotify-key"
  return vi.fn()
})
vi.mock("axios", () => ({
  default: { post: mockPost, isAxiosError: () => false },
}))

import { createMnotifySenderId, queryMnotifySenderIdStatus } from "./mnotify-sender-id"

beforeEach(() => {
  mockPost.mockReset()
})

describe("createMnotifySenderId", () => {
  it("returns ok:true on a successful registration", async () => {
    mockPost.mockResolvedValue({ data: { status: "success", code: "2000", message: "Sender ID Successfully Registered.", summary: { status: "Pending" } } })
    const result = await createMnotifySenderId("DTGOD")
    expect(result.ok).toBe(true)
  })

  it("returns ok:false when mNotify reports a non-success status", async () => {
    mockPost.mockResolvedValue({ data: { status: "error", message: "Sender ID already exists" } })
    const result = await createMnotifySenderId("DTGOD")
    expect(result.ok).toBe(false)
  })

  it("returns ok:false on a network error", async () => {
    mockPost.mockRejectedValue(new Error("network down"))
    const result = await createMnotifySenderId("DTGOD")
    expect(result.ok).toBe(false)
  })
})

describe("queryMnotifySenderIdStatus", () => {
  it("maps Approved to active", async () => {
    mockPost.mockResolvedValue({ data: { status: "success", code: "2000", summary: { status: "Approved" } } })
    const result = await queryMnotifySenderIdStatus("DTGOD")
    expect(result).toEqual({ rawStatus: "Approved", localStatus: "active" })
  })

  it("maps Rejected to rejected", async () => {
    mockPost.mockResolvedValue({ data: { status: "success", code: "2000", summary: { status: "Rejected" } } })
    const result = await queryMnotifySenderIdStatus("DTGOD")
    expect(result).toEqual({ rawStatus: "Rejected", localStatus: "rejected" })
  })

  it("maps Pending (and anything unrecognized) to pending", async () => {
    mockPost.mockResolvedValue({ data: { status: "success", code: "2000", summary: { status: "Pending" } } })
    expect(await queryMnotifySenderIdStatus("DTGOD")).toEqual({ rawStatus: "Pending", localStatus: "pending" })
  })

  it("treats a non-success response as a failure sentinel instead of trusting its body (same class of bug just fixed for Moolre)", async () => {
    mockPost.mockResolvedValue({ data: { status: "error", message: "Sender ID not found" } })
    const result = await queryMnotifySenderIdStatus("DTGOD")
    expect(result).toEqual({ rawStatus: "error", localStatus: "pending" })
  })

  it("falls back to the error sentinel on a network/axios exception", async () => {
    mockPost.mockRejectedValue(new Error("network down"))
    expect(await queryMnotifySenderIdStatus("DTGOD")).toEqual({ rawStatus: "error", localStatus: "pending" })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/mnotify-sender-id.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the client**

```typescript
// lib/mnotify-sender-id.ts
/**
 * mNotify sender-ID registration + status check.
 *
 *   createMnotifySenderId        — POST /senderid/register (type-less; one call per sender ID)
 *   queryMnotifySenderIdStatus   — POST /senderid/status
 *
 * Mirrors lib/sms-service.ts's Moolre sender-ID functions exactly, including
 * the fail-soft contract (never throws) and — critically — checking mNotify's
 * own success/failure signal BEFORE trusting any field in the response body
 * as a real status. A previous version of the equivalent Moolre code skipped
 * this check and silently stored an error code as if it were a real status
 * for months; this client is written to not repeat that.
 */
import axios from "axios"

const MNOTIFY_API_KEY = process.env.MNOTIFY_API_KEY
const MNOTIFY_BASE_URL = "https://api.mnotify.com/api"
// mNotify requires a "purpose" string on registration; there is no per-tenant
// source for this, so a single fixed platform-level purpose is used for every
// sender ID registered through this admin tool.
const REGISTRATION_PURPOSE = "Transactional and marketing SMS for Datagod merchants"

function isSuccess(data: any): boolean {
  return data?.status === "success" || data?.code === "2000"
}

export async function createMnotifySenderId(senderId: string): Promise<{ ok: boolean; message?: string }> {
  if (!MNOTIFY_API_KEY) return { ok: false, message: "mNotify API key not configured" }
  try {
    const response = await axios.post(
      `${MNOTIFY_BASE_URL}/senderid/register?key=${MNOTIFY_API_KEY}`,
      { sender_name: senderId, purpose: REGISTRATION_PURPOSE },
      { headers: { "Content-Type": "application/json" } }
    )
    const ok = isSuccess(response.data)
    return { ok, message: response.data?.message ?? response.data?.summary?.status ?? "" }
  } catch (error) {
    console.error("[mNotify] createSenderId failed:", axios.isAxiosError(error) ? error.message : error)
    return { ok: false, message: axios.isAxiosError(error) ? error.message : "Unknown error" }
  }
}

export async function queryMnotifySenderIdStatus(senderId: string): Promise<{
  rawStatus: string
  localStatus: "pending" | "active" | "rejected"
}> {
  if (!MNOTIFY_API_KEY) return { rawStatus: "no_api_key", localStatus: "pending" }
  try {
    const response = await axios.post(
      `${MNOTIFY_BASE_URL}/senderid/status?key=${MNOTIFY_API_KEY}`,
      { sender_name: senderId },
      { headers: { "Content-Type": "application/json" } }
    )
    if (!isSuccess(response.data)) {
      console.error("[mNotify] querySenderIdStatus returned a failure:", response.data?.code, response.data?.message)
      return { rawStatus: "error", localStatus: "pending" }
    }
    const rawStatus = response.data?.summary?.status ?? "unknown"
    const rawStr = String(rawStatus)
    const localStatus: "pending" | "active" | "rejected" =
      rawStr === "Approved" ? "active"
      : rawStr === "Rejected" ? "rejected"
      : "pending"
    return { rawStatus: rawStr, localStatus }
  } catch (error) {
    console.error("[mNotify] querySenderIdStatus failed:", axios.isAxiosError(error) ? error.message : error)
    return { rawStatus: "error", localStatus: "pending" }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/mnotify-sender-id.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/mnotify-sender-id.ts lib/mnotify-sender-id.test.ts
git commit -m "feat(sms): add mNotify sender-ID register/status client"
```

---

### Task 3: Service layer — manual push/reject/fetch-status + dual-provider poll

**Files:**
- Modify: `lib/sms/sender-id-service.ts`
- Modify: `lib/sms/sender-id-service.test.ts`

**Interfaces:**
- Consumes: `createMnotifySenderId`, `queryMnotifySenderIdStatus` from Task 2.
- Produces: `pushSenderId(id, provider)`, `rejectSenderId(id, provider)`, `fetchSenderIdStatus(id, provider)`, all exported from `sender-id-service.ts`. `pollSenderIds()`'s behavior extends but its exported signature is unchanged.

- [ ] **Step 1: Remove the auto-push from `submitSenderId`**

In `lib/sms/sender-id-service.ts`, delete this block (the Moolre auto-registration after insert):
```typescript
  // Fire the Moolre registration. Failure here is non-fatal — the row stays pending
  // and the poll cron / a manual resubmit can reconcile it.
  const moolre = await createMoolreSenderId(senderId)

  const { data: updated } = await supabaseAdmin
    .from("sms_sender_ids")
    .update({ moolre_status: moolre.message ?? null, updated_at: new Date().toISOString() })
    .eq("id", (row as SmsSenderId).id)
    .select()
    .maybeSingle()

  return { ok: true, data: { row: (updated ?? row) as SmsSenderId, moolre } }
```
replaced with:
```typescript
  return { ok: true, data: { row: row as SmsSenderId, moolre: { ok: true, message: "Not yet pushed to a provider" } } }
```
(The `moolre: {ok, message}` field in the return shape is kept so existing callers of `submitSenderId` that destructure it don't break — it's just no longer the result of an actual API call.)

Remove the now-unused `createMoolreSenderId` import if `pushSenderId` (Step 3 below) is the only other place it's needed — re-add it there instead.

- [ ] **Step 2: Extend the `SmsSenderId` interface**

```typescript
export interface SmsSenderId {
  id: string
  sms_account_id: string | null
  sender_id: string
  moolre_status: string | null
  local_status: "pending" | "active" | "rejected"
  submitted_at: string
  last_polled_at: string | null
  moolre_pushed_at: string | null
  mnotify_status: string | null
  mnotify_local_status: "pending" | "active" | "rejected"
  mnotify_last_polled_at: string | null
  mnotify_pushed_at: string | null
  created_at: string
  updated_at: string
}
```

- [ ] **Step 3: Add `pushSenderId`**

```typescript
import { createMoolreSenderId, queryMoolreSenderIdStatus } from "@/lib/sms-service"
import { createMnotifySenderId, queryMnotifySenderIdStatus } from "@/lib/mnotify-sender-id"

/**
 * Admin-triggered push to one provider. Never called automatically — see
 * submitSenderId, which only inserts the pending row.
 */
export async function pushSenderId(
  id: string,
  provider: "moolre" | "mnotify"
): Promise<ServiceResult<{ row: SmsSenderId; result: { ok: boolean; message?: string } }>> {
  const { data: existing } = await supabaseAdmin.from("sms_sender_ids").select("sender_id").eq("id", id).maybeSingle()
  if (!existing) return { ok: false, error: "Sender ID not found" }

  const result = provider === "moolre"
    ? await createMoolreSenderId(existing.sender_id)
    : await createMnotifySenderId(existing.sender_id)

  const patch = provider === "moolre"
    ? { moolre_status: result.message ?? null, moolre_pushed_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    : { mnotify_status: result.message ?? null, mnotify_pushed_at: new Date().toISOString(), updated_at: new Date().toISOString() }

  const { data: updated, error } = await supabaseAdmin.from("sms_sender_ids").update(patch).eq("id", id).select().maybeSingle()
  if (error || !updated) return { ok: false, error: error?.message ?? "Failed to record push" }

  return { ok: true, data: { row: updated as SmsSenderId, result } }
}
```

- [ ] **Step 4: Add `rejectSenderId` and `approveSenderId`**

```typescript
/**
 * Admin-side manual override — never calls a provider. Scoped to one
 * provider's local-status column, or "both". Shared by rejectSenderId
 * (status "rejected") and approveSenderId (status "active").
 *
 * approveSenderId exists because Moolre's status-check API has been broken
 * for months (the "IE01" bug) — there is currently no reliable automated way
 * to confirm a real approval, and an admin may already know (checked via
 * Moolre's own dashboard, or prior experience) that a sender ID IS genuinely
 * approved even though polling can't reflect that right now. Available for
 * both providers, not just Moolre, for symmetry.
 */
async function setSenderIdLocalStatus(
  id: string,
  provider: "moolre" | "mnotify" | "both",
  status: "active" | "rejected"
): Promise<ServiceResult<SmsSenderId>> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (provider === "moolre" || provider === "both") patch.local_status = status
  if (provider === "mnotify" || provider === "both") patch.mnotify_local_status = status

  const { data, error } = await supabaseAdmin.from("sms_sender_ids").update(patch).eq("id", id).select().maybeSingle()
  if (error || !data) return { ok: false, error: error?.message ?? "Sender ID not found" }
  return { ok: true, data: data as SmsSenderId }
}

export async function rejectSenderId(id: string, provider: "moolre" | "mnotify" | "both"): Promise<ServiceResult<SmsSenderId>> {
  return setSenderIdLocalStatus(id, provider, "rejected")
}

export async function approveSenderId(id: string, provider: "moolre" | "mnotify" | "both"): Promise<ServiceResult<SmsSenderId>> {
  return setSenderIdLocalStatus(id, provider, "active")
}
```

- [ ] **Step 5: Add `fetchSenderIdStatus`**

```typescript
/**
 * Manual, single-row, single-provider status check — the per-row "Fetch
 * status" button. Same isSentinel fail-soft contract as pollSenderIds: a
 * transient provider error never clobbers the last-known-good status.
 */
export async function fetchSenderIdStatus(
  id: string,
  provider: "moolre" | "mnotify"
): Promise<ServiceResult<SmsSenderId>> {
  const { data: existing } = await supabaseAdmin.from("sms_sender_ids").select("sender_id").eq("id", id).maybeSingle()
  if (!existing) return { ok: false, error: "Sender ID not found" }

  const { rawStatus, localStatus } = provider === "moolre"
    ? await queryMoolreSenderIdStatus(existing.sender_id)
    : await queryMnotifySenderIdStatus(existing.sender_id)

  const isSentinel = rawStatus === "error" || rawStatus === "no_api_key" || rawStatus === "unknown"
  const nowIso = new Date().toISOString()
  const patch: Record<string, unknown> = provider === "moolre"
    ? { last_polled_at: nowIso, updated_at: nowIso }
    : { mnotify_last_polled_at: nowIso, updated_at: nowIso }
  if (!isSentinel) {
    if (provider === "moolre") { patch.moolre_status = rawStatus; patch.local_status = localStatus }
    else { patch.mnotify_status = rawStatus; patch.mnotify_local_status = localStatus }
  }

  const { data, error } = await supabaseAdmin.from("sms_sender_ids").update(patch).eq("id", id).select().maybeSingle()
  if (error || !data) return { ok: false, error: error?.message ?? "Failed to record status" }
  return { ok: true, data: data as SmsSenderId }
}
```

- [ ] **Step 6: Extend `pollSenderIds` to also poll mNotify**

Replace the single Moolre loop with two loops (or one loop handling both providers per row) — add, after the existing Moolre loop body, an equivalent mNotify loop:

```typescript
export async function pollSenderIds(): Promise<ServiceResult<PollSummary>> {
  const { data: pendingMoolre, error: moolreErr } = await supabaseAdmin
    .from("sms_sender_ids")
    .select("id, sender_id, local_status")
    .eq("local_status", "pending")
    .not("moolre_pushed_at", "is", null)
  if (moolreErr) return { ok: false, error: moolreErr.message }

  const { data: pendingMnotify, error: mnotifyErr } = await supabaseAdmin
    .from("sms_sender_ids")
    .select("id, sender_id, mnotify_local_status")
    .eq("mnotify_local_status", "pending")
    .not("mnotify_pushed_at", "is", null)
  if (mnotifyErr) return { ok: false, error: mnotifyErr.message }

  const summary: PollSummary = { polled: 0, updated: 0, results: [] }

  for (const r of (pendingMoolre ?? []) as Pick<SmsSenderId, "id" | "sender_id" | "local_status">[]) {
    summary.polled++
    const { rawStatus, localStatus } = await queryMoolreSenderIdStatus(r.sender_id)
    const isSentinel = rawStatus === "error" || rawStatus === "no_api_key" || rawStatus === "unknown"
    const patch: Record<string, unknown> = { last_polled_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    if (!isSentinel) { patch.moolre_status = rawStatus; patch.local_status = localStatus }
    const { error: updErr } = await supabaseAdmin.from("sms_sender_ids").update(patch).eq("id", r.id)
    if (updErr) continue
    if (!isSentinel && localStatus !== r.local_status) {
      summary.updated++
      summary.results.push({ senderId: r.sender_id, from: r.local_status, to: localStatus })
    }
  }

  for (const r of (pendingMnotify ?? []) as { id: string; sender_id: string; mnotify_local_status: "pending" | "active" | "rejected" }[]) {
    summary.polled++
    const { rawStatus, localStatus } = await queryMnotifySenderIdStatus(r.sender_id)
    const isSentinel = rawStatus === "error" || rawStatus === "no_api_key" || rawStatus === "unknown"
    const patch: Record<string, unknown> = { mnotify_last_polled_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    if (!isSentinel) { patch.mnotify_status = rawStatus; patch.mnotify_local_status = localStatus }
    const { error: updErr } = await supabaseAdmin.from("sms_sender_ids").update(patch).eq("id", r.id)
    if (updErr) continue
    if (!isSentinel && localStatus !== r.mnotify_local_status) {
      summary.updated++
      summary.results.push({ senderId: r.sender_id, from: r.mnotify_local_status, to: localStatus })
    }
  }

  return { ok: true, data: summary }
}
```

- [ ] **Step 7: Update existing tests for the removed auto-push, add tests for the 4 new functions and dual-provider poll**

Update `lib/sms/sender-id-service.test.ts`'s `submitSenderId` tests: the "registers the ID with Moolre" assertion (`expect(h.createMoolreSenderId).toHaveBeenCalledWith(...)`) must become an assertion that it is NOT called. Add new `describe` blocks for `pushSenderId`, `rejectSenderId`, `approveSenderId`, `fetchSenderIdStatus` following the existing hoisted-mock-state pattern already in this file (extend the shared fake Supabase client / mocked provider functions rather than building a new harness). For `approveSenderId`, cover both single-provider (`"moolre"`) and `"both"` scoping, matching `rejectSenderId`'s test shape exactly. Add a dual-provider case to the `pollSenderIds` tests (one row pending+pushed on Moolre only, one pending+pushed on mNotify only, confirm both get polled and only the pushed-to provider's columns are touched).

- [ ] **Step 8: Run the tests**

Run: `npx vitest run lib/sms/sender-id-service.test.ts`
Expected: PASS

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 10: Commit**

```bash
git add lib/sms/sender-id-service.ts lib/sms/sender-id-service.test.ts
git commit -m "feat(sms): manual push/reject/fetch-status + dual-provider polling"
```

---

### Task 4: Admin API routes

**Files:**
- Create: `app/api/admin/sms-sender-ids/push/route.ts`
- Create: `app/api/admin/sms-sender-ids/reject/route.ts`
- Create: `app/api/admin/sms-sender-ids/approve/route.ts`
- Create: `app/api/admin/sms-sender-ids/fetch-status/route.ts`

**Interfaces:**
- Consumes: `pushSenderId`, `rejectSenderId`, `approveSenderId`, `fetchSenderIdStatus` from Task 3.

- [ ] **Step 1: Push route**

```typescript
// app/api/admin/sms-sender-ids/push/route.ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { pushSenderId } from "@/lib/sms/sender-id-service"

// POST /api/admin/sms-sender-ids/push — { id, provider: "moolre" | "mnotify" }
export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  let body: { id?: string; provider?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.id || (body.provider !== "moolre" && body.provider !== "mnotify")) {
    return NextResponse.json({ success: false, error: "id and provider ('moolre' | 'mnotify') are required" }, { status: 400 })
  }

  const result = await pushSenderId(body.id, body.provider)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data })
}
```

- [ ] **Step 2: Reject route**

```typescript
// app/api/admin/sms-sender-ids/reject/route.ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { rejectSenderId } from "@/lib/sms/sender-id-service"

// POST /api/admin/sms-sender-ids/reject — { id, provider: "moolre" | "mnotify" | "both" }
export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  let body: { id?: string; provider?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.id || !["moolre", "mnotify", "both"].includes(body.provider ?? "")) {
    return NextResponse.json({ success: false, error: "id and provider ('moolre' | 'mnotify' | 'both') are required" }, { status: 400 })
  }

  const result = await rejectSenderId(body.id, body.provider as "moolre" | "mnotify" | "both")
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data })
}
```

- [ ] **Step 3: Approve route**

```typescript
// app/api/admin/sms-sender-ids/approve/route.ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { approveSenderId } from "@/lib/sms/sender-id-service"

// POST /api/admin/sms-sender-ids/approve — { id, provider: "moolre" | "mnotify" | "both" }
export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  let body: { id?: string; provider?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.id || !["moolre", "mnotify", "both"].includes(body.provider ?? "")) {
    return NextResponse.json({ success: false, error: "id and provider ('moolre' | 'mnotify' | 'both') are required" }, { status: 400 })
  }

  const result = await approveSenderId(body.id, body.provider as "moolre" | "mnotify" | "both")
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data })
}
```

- [ ] **Step 4: Fetch-status route**

```typescript
// app/api/admin/sms-sender-ids/fetch-status/route.ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { fetchSenderIdStatus } from "@/lib/sms/sender-id-service"

// POST /api/admin/sms-sender-ids/fetch-status — { id, provider: "moolre" | "mnotify" }
export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  let body: { id?: string; provider?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.id || (body.provider !== "moolre" && body.provider !== "mnotify")) {
    return NextResponse.json({ success: false, error: "id and provider ('moolre' | 'mnotify') are required" }, { status: 400 })
  }

  const result = await fetchSenderIdStatus(body.id, body.provider)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data })
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/sms-sender-ids/push/route.ts app/api/admin/sms-sender-ids/reject/route.ts app/api/admin/sms-sender-ids/approve/route.ts app/api/admin/sms-sender-ids/fetch-status/route.ts
git commit -m "feat(sms): add admin push/reject/approve/fetch-status API routes"
```

---

### Task 5: Admin UI — per-provider actions

**Files:**
- Modify: `app/admin/sms-centre/_components/ProvidersTab.tsx`

**Interfaces:**
- Consumes: the 3 new routes from Task 4; the extended `SmsSenderId` shape from Task 3.

- [ ] **Step 1: Extend the `SenderId` interface and add per-row action handlers**

Add the new fields to the local `SenderId` interface (mirror Task 3 Step 2's shape). Add three handlers next to the existing `submitSender`/`pollNow`:

```typescript
async function pushTo(id: string, provider: "moolre" | "mnotify") {
  setBusy(true)
  const res = await api(`/api/admin/sms-sender-ids/push`, { method: "POST", body: JSON.stringify({ id, provider }) })
  setBusy(false)
  if (res.success) { toast.success(`Pushed to ${provider === "moolre" ? "Moolre" : "mNotify"}.`); await load() }
  else toast.error(res.error ?? "Push failed")
}

async function rejectOn(id: string, provider: "moolre" | "mnotify" | "both") {
  setBusy(true)
  const res = await api(`/api/admin/sms-sender-ids/reject`, { method: "POST", body: JSON.stringify({ id, provider }) })
  setBusy(false)
  if (res.success) { toast.success("Rejected."); await load() }
  else toast.error(res.error ?? "Reject failed")
}

// Manual override for when the provider's own status-check API can't be
// trusted (e.g. Moolre's /sms/query outage) but the admin independently
// knows (their own dashboard, prior experience) that it's really approved.
async function approveOn(id: string, provider: "moolre" | "mnotify" | "both") {
  setBusy(true)
  const res = await api(`/api/admin/sms-sender-ids/approve`, { method: "POST", body: JSON.stringify({ id, provider }) })
  setBusy(false)
  if (res.success) { toast.success("Marked approved."); await load() }
  else toast.error(res.error ?? "Approve failed")
}

async function fetchStatusFor(id: string, provider: "moolre" | "mnotify") {
  setBusy(true)
  const res = await api(`/api/admin/sms-sender-ids/fetch-status`, { method: "POST", body: JSON.stringify({ id, provider }) })
  setBusy(false)
  if (res.success) { toast.success("Status refreshed."); await load() }
  else toast.error(res.error ?? "Fetch status failed")
}
```

- [ ] **Step 2: Update the submit success toast**

Change:
```typescript
toast.success(`Submitted "${sid}". Approval is asynchronous — use "Poll now" to refresh status.`)
```
to:
```typescript
toast.success(`Submitted "${sid}". Push to a provider below to start approval.`)
```

- [ ] **Step 3: Rebuild the sender-IDs table with per-provider columns**

Replace the existing table (the one with "Sender ID / Owner / Status / Moolre status / Last polled" columns) with one column per provider showing status + actions. A small inline helper component keeps the per-provider cell logic in one place rather than duplicated twice:

```typescript
function ProviderCell({
  pushedAt, localStatus, rawStatus, lastPolledAt, busy, onPush, onReject, onApprove, onFetch,
}: {
  pushedAt: string | null; localStatus: "pending" | "active" | "rejected"; rawStatus: string | null
  lastPolledAt: string | null; busy: boolean
  onPush: () => void; onReject: () => void; onApprove: () => void; onFetch: () => void
}) {
  if (!pushedAt) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">Not pushed</span>
        <Button variant="outline" size="sm" onClick={onPush} disabled={busy}>Push</Button>
        <Button variant="outline" size="sm" onClick={onApprove} disabled={busy}>Mark approved</Button>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <div>
        <Badge className={STATUS_VARIANT[localStatus] ?? "bg-muted text-muted-foreground"} variant="secondary">{localStatus}</Badge>
        <p className="text-[10px] text-muted-foreground mt-0.5">{rawStatus ?? "—"} · {lastPolledAt ? new Date(lastPolledAt).toLocaleString() : "never polled"}</p>
      </div>
      {localStatus === "pending" && (
        <>
          <Button variant="outline" size="sm" onClick={onFetch} disabled={busy}>Fetch</Button>
          <Button variant="outline" size="sm" onClick={onApprove} disabled={busy}>Mark approved</Button>
          <Button variant="outline" size="sm" onClick={onReject} disabled={busy}>Reject</Button>
        </>
      )}
      {localStatus === "rejected" && (
        <>
          <Button variant="outline" size="sm" onClick={onPush} disabled={busy}>Re-push</Button>
          <Button variant="outline" size="sm" onClick={onApprove} disabled={busy}>Mark approved</Button>
        </>
      )}
    </div>
  )
}
```

"Mark approved" is available even before a push (an admin may know a sender ID is already approved from a prior registration made directly on the provider's dashboard, outside this tool) and after a rejection (overturning a local-only rejection), not just while pending — the only state where it's redundant is already-`active`, where it's simply not shown.

Table header becomes: Sender ID / Owner / Moolre / mNotify. Each row's Moolre cell:
```tsx
<td className="py-2">
  <ProviderCell
    pushedAt={s.moolre_pushed_at} localStatus={s.local_status} rawStatus={s.moolre_status} lastPolledAt={s.last_polled_at}
    busy={busy} onPush={() => pushTo(s.id, "moolre")} onReject={() => rejectOn(s.id, "moolre")} onApprove={() => approveOn(s.id, "moolre")} onFetch={() => fetchStatusFor(s.id, "moolre")}
  />
</td>
```
and mNotify cell mirrors it with the `mnotify_*` fields and `"mnotify"` provider argument. Drop the old "Status" and "Last polled" columns — both are now folded into each provider's own cell.

- [ ] **Step 4: Manual smoke check**

Start the dev server, open the admin SMS Centre's Providers tab, submit a test sender ID, confirm it shows "Not pushed" on both columns, click Push on one, confirm it moves to a pending badge with Fetch/Reject buttons.

- [ ] **Step 5: Commit**

```bash
git add app/admin/sms-centre/_components/ProvidersTab.tsx
git commit -m "feat(sms): per-provider push/reject/fetch-status UI"
```

---

### Task 6: Read-only admin monitoring view

**Files:**
- Modify: `app/admin/sms/page.tsx`

- [ ] **Step 1: Add the mNotify status column**

In the `SenderIdRow` interface, add `mnotify_status: string | null` and `mnotify_local_status: string`. In the sender-IDs table, add an "mNotify status" column next to the existing "Moolre status" column, displaying `s.mnotify_local_status` as a badge and `s.mnotify_status ?? "—"` as the raw value — read-only, no buttons (this page is a monitoring surface; the interactive controls live in Task 5's page).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add app/admin/sms/page.tsx
git commit -m "feat(sms): show mNotify status on the admin SMS monitoring view"
```

---

### Task 7: Send-time provider-aware gating

**Files:**
- Modify: `lib/sms/send-service.ts`
- Modify: `lib/sms-service.ts`
- Modify: `lib/sms/send-service.test.ts`

**Interfaces:**
- Consumes: `sms_sender_ids`'s new `mnotify_local_status` column.

- [ ] **Step 1: Widen the enqueue-time sendable gate**

In `lib/sms/send-service.ts`, change:
```typescript
    const { data: active } = await supabaseAdmin
      .from("sms_sender_ids")
      .select("sender_id")
      .eq("sms_account_id", accountId)
      .eq("sender_id", sid)
      .eq("local_status", "active")
      .maybeSingle()
```
to:
```typescript
    const { data: active } = await supabaseAdmin
      .from("sms_sender_ids")
      .select("sender_id")
      .eq("sms_account_id", accountId)
      .eq("sender_id", sid)
      .or("local_status.eq.active,mnotify_local_status.eq.active")
      .maybeSingle()
```

- [ ] **Step 2: Make `sendSMS` skip a provider that hasn't approved the sender ID in use**

In `lib/sms-service.ts`'s `sendSMS`, after the existing `order` array is built and filtered (the line `order = [...new Set(order)].filter(...)`) but before the send loop, add:

```typescript
  // A custom (non-default) sender ID may be approved on only one provider.
  // Drop any provider from the chain that hasn't approved THIS sender ID,
  // rather than attempting it and getting a provider-side rejection.
  if (payload.senderId && payload.senderId.trim()) {
    const sid = payload.senderId.trim().toUpperCase()
    const { data: senderRow } = await supabaseAdmin
      .from('sms_sender_ids')
      .select('local_status, mnotify_local_status')
      .eq('sender_id', sid)
      .maybeSingle()
    if (senderRow) {
      const approvedProviders = new Set<string>()
      if (senderRow.local_status === 'active') approvedProviders.add('moolre')
      if (senderRow.mnotify_local_status === 'active') approvedProviders.add('mnotify')
      const narrowed = order.filter((p) => approvedProviders.size === 0 || approvedProviders.has(p))
      if (narrowed.length > 0) order = narrowed
    }
  }
```

(`senderRow` not found, or no provider shows `active` for it, falls through to the existing unfiltered `order` — defensive, since the enqueue-time gate in Task 7 Step 1 should already prevent an unapproved sender ID reaching this point at all.)

This requires `lib/sms-service.ts` to have a Supabase client available — add it the same way `lib/sms/sender-id-service.ts` does:
```typescript
import { createClient } from '@supabase/supabase-js'
const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
```
at the top of the file (only if no equivalent client already exists there — check first; several files in this codebase already instantiate this exact client).

- [ ] **Step 3: Update/add tests**

In `lib/sms/send-service.test.ts`, update the existing sender-ID gate test(s) to also cover: a sender ID with `local_status: 'pending'` but `mnotify_local_status: 'active'` is now accepted (previously would have been rejected). Add a case confirming a sender ID with both columns `'pending'` is still rejected (`INVALID_SENDER_ID`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/sms/send-service.test.ts lib/sms-service-moolre-senderid.test.ts`

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add lib/sms/send-service.ts lib/sms-service.ts lib/sms/send-service.test.ts
git commit -m "feat(sms): route sends around a provider that hasn't approved the sender ID"
```

---

### Task 8: Final verification

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all tests pass (aside from the pre-existing, unrelated `lib/order-health-service.test.ts` failures from concurrent unrelated work, if still present).

- [ ] **Step 2: Full typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Report the new env var to the user**

`MNOTIFY_API_KEY` needs to be added in Vercel (production + preview) before the Push-to-mNotify button will work live — without it, `createMnotifySenderId`/`queryMnotifySenderIdStatus` fail soft with "mNotify API key not configured" / `no_api_key`, same as the existing Moolre fail-soft behavior when its key is missing.

- [ ] **Step 4: Do not push yet**

Report completion to the user and wait for explicit confirmation before pushing, per this session's established norm.
