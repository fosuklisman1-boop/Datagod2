# Support Chat Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the one-shot website complaint form with chat threads (customer or shop owner ↔ admin) linked to an order, with an admin console that shows the order and its supplier.

**Architecture:** Two new server-write-only tables (`support_threads`, `support_messages`) plus `admin_presence`. All writes go through Next.js route handlers using the service-role client after Bearer-token auth and explicit ownership checks; the browser reads its own rows through RLS and Supabase Realtime. Pure logic (validation, ticks, supplier resolution, order normalisation, rate-limit fallback, image sniffing) lives in `lib/` with unit tests; routes stay thin.

**Tech Stack:** Next.js 15 App Router, Supabase (Postgres, RLS, Realtime, Storage), zod 4, Upstash ratelimit, Vitest 4, Tailwind + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-11-12-support-chat-threads-design.md`. It builds on the owner's "Complaints & Support System rebuild" prompt, saved by Task 1 as `docs/superpowers/specs/2026-11-12-support-chat-threads-source-prompt.md`. Executors read all three.

## Global Constraints

- Auth: user routes read `Authorization: Bearer <token>` and call `supabase.auth.getUser(token)` on the service client. Admin routes call `verifyAdminAccess(request)` from `lib/admin-auth.ts` in the handler and return 401 when `userId` is undefined (the cron-secret bypass must not reach support routes).
- Every route file: `export const dynamic = "force-dynamic"`. Response envelope `{ success: true, data }` or `{ success: false, error }`.
- Browser may only SELECT support tables and UPDATE `read_by_user_at`, `delivered_to_user_at`.
- Post-response work uses `after()` from `next/server`, wrapped so a throw outside request scope falls back to a detached promise (pattern in `app/api/ussd-hubtel/interaction/route.ts`). Each notification in its own try/catch; a failure never fails the request.
- Limits: 3 open threads per user (DB trigger), 3 new threads/hour/user, 10 messages/minute/user, message 5–5000 chars on create and 1–5000 on reply, subject 3–200, screenshot ≤ 4 MB JPEG/PNG/WebP, presence window 3 minutes, admin list window clamped 1–90 days (default 30, limit 300), signed URLs 10 minutes, retention 90 days.
- Phone regex: `^(0|\+233)[2-9][0-9]{8}$`.
- Logs carry ids only: no phone numbers, message bodies or emails.
- Code edits use the Edit/Write tools, never `sed`.
- UI: existing tokens (navy `--primary`), light and dark, `lg:` widening and multi-column from the start.
- Do not touch `lib/whatsapp-bot/**`, `whatsapp_complaints`, or `app/api/admin/whatsapp-inbox/**`.
- Work on a new branch `feat/support-chat-threads` cut from `main` in a git worktree (the current checkout has unrelated uncommitted work).

## Deviation from the spec (decided while planning)

The spec's `exported` supplier tag is dropped. `order_download_batches` holds 4 rows in total, so export tracking is not a usable signal. Instead: a shop order with no tracking row and `fulfillment_method = 'manual'` shows "Manual"; everything else without a known tracking provider shows "N/A".

## Review Focus

1. A shop owner files on a `shop_orders` row from a shop they do not own (including a sub-agent's parent): expect 404 and no thread. Test in Task 6.
2. Screenshot upload fails or the file is a renamed non-image: the complaint is still created, the response carries `attachment_saved: false`, nothing is stored. Tests in Tasks 4 and 6.
3. Upstash is down: the 4th thread in an hour is still refused (in-memory fallback). Test in Task 3.
4. Two admins close the same thread at once: exactly one succeeds, the other gets 409, the user gets one notification. Test in Task 7.
5. An order has several tracking rows with a stale early provider, or a provider string not in `PROVIDER_DISPLAY`: badge shows the latest known provider, never a wrong label. Test in Task 2.

---

### Task 1: Branch, source prompt, migration

**Files:**
- Create: `docs/superpowers/specs/2026-11-12-support-chat-threads-source-prompt.md` (the owner's prompt, verbatim)
- Create: `migrations/20261112_support_chat_threads.sql`
- Create: `migrations/20261112_support_chat_threads.verify.sql`

**Interfaces:**
- Produces tables/columns used by every later task:
  - `support_threads(id, user_id, order_id, shop_order_id, subject, category, phone_number, whatsapp_number, status, handler, needs_human_at, closed_at, closed_by, last_message_at, created_at, updated_at)`
  - `support_messages(id, thread_id, sender_role, sender_id, body, attachment_path, delivered_to_user_at, delivered_to_admin_at, read_by_user_at, read_by_admin_at, created_at)`
  - `admin_presence(admin_id, last_seen_at)`
  - trigger error text `OPEN_THREAD_LIMIT`

- [ ] **Step 1:** Create the worktree and branch `feat/support-chat-threads` from `main` (superpowers:using-git-worktrees). Copy the spec and this plan into it; write the source prompt file.

- [ ] **Step 2:** Write the migration. Take sections 1–5 and 7 of the source prompt's SQL verbatim, then apply exactly these changes:
  - `support_threads`: add `shop_order_id uuid REFERENCES public.shop_orders(id) ON DELETE SET NULL`, `handler text NOT NULL DEFAULT 'human' CHECK (handler IN ('ai','human'))`, `needs_human_at timestamptz`, and `CONSTRAINT support_threads_one_order CHECK (order_id IS NULL OR shop_order_id IS NULL)`. Index `idx_support_threads_shop_order_id ON (shop_order_id) WHERE shop_order_id IS NOT NULL`.
  - `support_messages`: `sender_role CHECK (sender_role IN ('user','admin','ai'))`; add `attachment_path text`.
  - Skip sections 6 and 8. Instead, for the existing `complaints` table: `DROP POLICY IF EXISTS "Users can insert own complaints" ON public.complaints; REVOKE INSERT, UPDATE, DELETE ON public.complaints FROM anon, authenticated;`
  - Wrap everything in one transaction; use `CREATE TABLE IF NOT EXISTS` / `DROP TRIGGER IF EXISTS` / `DROP POLICY IF EXISTS` so it is re-runnable. Guard the two `ALTER PUBLICATION … ADD TABLE` statements with a `pg_publication_tables` existence check.

- [ ] **Step 3:** Write the verify script. It must return one row per check with `ok boolean`:
  - `has_table_privilege('authenticated','public.support_threads','SELECT')` true; `INSERT`, `UPDATE`, `DELETE` false; same for `support_messages` at table level.
  - `has_column_privilege('authenticated','public.support_messages','read_by_user_at','UPDATE')` true; `'body','UPDATE'` false; `'read_by_admin_at','UPDATE'` false.
  - `anon` has no privilege on any of the three tables; `authenticated` has none on `admin_presence`.
  - RLS enabled on all three; `complaints` has no INSERT policy; both support tables are in `supabase_realtime`.
  - Cap trigger: inside a `DO` block that ends with `RAISE EXCEPTION 'ROLLBACK_OK'`, insert 3 open threads for an existing user id, assert the 4th raises `OPEN_THREAD_LIMIT`, assert a thread with both `order_id` and `shop_order_id` violates `support_threads_one_order`, assert inserting a message bumps `last_message_at`.

- [ ] **Step 4:** Dry run against production per the owner's prod-change protocol: precheck (`to_regclass` for the three tables is null; `complaints` row count), then run the migration body inside a transaction that ends with `RAISE EXCEPTION` so it rolls back, with the verify checks executed before the raise. Expected: every check `ok = true`, then the deliberate rollback error.

- [ ] **Step 5:** STOP. Show the owner the dry-run result and ask for the go-ahead to apply. After approval apply with `mcp__supabase__apply_migration`, run the verify script for real, and re-check with an anon-key session of a test user (see memory `reference-supabase-access.md`): own thread rows readable, another user's not, direct INSERT refused.

- [ ] **Step 6:** Commit: `feat(support): chat thread tables, RLS and open-thread cap`.

---

### Task 2: Pure helpers (validation, ticks, supplier, order shape)

**Files:**
- Create: `lib/support-validation.ts`, `lib/support-ticks.ts`, `lib/order-supplier.ts`, `lib/support-order.ts`
- Test: one `*.test.ts` beside each

**Interfaces (produced):**

```ts
// lib/support-validation.ts
export const GH_PHONE_RE: RegExp
export const SUPPORT_CATEGORIES = ["order", "payment", "account", "other"] as const
export const createThreadSchema  // { subject, category, message, phone_number, whatsapp_number, order_id?, shop_order_id? }
export const userMessageSchema   // { message }  1–5000, customer text rules
export const adminActionSchema   // discriminatedUnion("action"): {action:"reply",message} | {action:"close",note?} | {action:"read"}
export const resolveComplaintSchema // { id: uuid, status: "resolved"|"rejected", resolution_notes: string (trimmed, max 2000) }
export function isUuid(v: unknown): v is string

// lib/support-ticks.ts
export type SenderRole = "user" | "admin" | "ai"
export type TickState = "sent" | "delivered" | "read"
export function getCounterpartReceipt(senderRole: SenderRole, row: ReceiptColumns): { delivered_at: string | null; read_at: string | null }
export function getMessageTickState(r: { delivered_at: string | null; read_at: string | null }): TickState

// lib/order-supplier.ts
export type SupplierResult =
  | { kind: "supplier"; provider: string; attemptedOnly: boolean }
  | { kind: "manual" }
  | null
export function resolveSupplier(
  trackingRows: { provider: string | null; created_at: string | null }[],
  orderStatus: string | null,
  fulfillmentMethod: string | null,
): SupplierResult

// lib/support-order.ts
export interface SupportOrder {
  source: "order" | "shop_order"; id: string; reference: string | null; beneficiary: string | null
  network: string | null; size: string | null; price: number | null; status: string | null
  created_at: string | null; shop_name: string | null
}
export function fromOrderRow(row: OrdersRow): SupportOrder            // reference = order_code, size = `${size}GB` as stored
export function fromShopOrderRow(row: ShopOrdersRow, shopName: string | null): SupportOrder // reference = reference_code, beneficiary = customer_phone, size = `${volume_gb}GB`, price = total_price, status = order_status
export function fromLegacyOrderDetails(details: unknown): SupportOrder | null // legacy complaints.order_details {network, package, phone, amount, date, orderRefId, type}
```

- [ ] **Step 1: Failing tests.** Assertions that must exist:
  - validation: accepts `0241234567` and `+233241234567`, rejects `0141234567` and `024123456`; rejects subject of 2 chars and 201 chars; rejects create message of 4 chars and 5001 chars; rejects customer text containing `<`, `>`, `&`, or `javascript:`; rejects a body with both `order_id` and `shop_order_id`; admin reply allows `<>&` but rejects `<script`; `resolution_notes` of 2500 chars is rejected; unknown `action` rejected.
  - ticks: admin message uses `delivered_to_user_at`/`read_by_user_at`; `ai` behaves exactly like `admin`; user message uses the admin columns; state is `read` when `read_at` set even if `delivered_at` null.
  - supplier: rows `[{sykes, 10:00}, {kuntanii, 10:05}]` + status `completed` → `{kind:"supplier", provider:"kuntanii", attemptedOnly:false}`; same rows + status `failed` → `attemptedOnly:true`; `pending` → `attemptedOnly:true`; statuses `processing`, `refunded`, `reversed` → `false`; a later row with provider `"mystery"` is skipped in favour of the earlier known one; an unparseable `created_at` sorts oldest; no rows + `fulfillmentMethod "manual"` → `{kind:"manual"}`; no rows + `"auto_mtn"` → `null`; rows whose only providers are unknown → `null`. "Known" means a key of `PROVIDER_DISPLAY` in `lib/mtn-providers/provider-display.ts`.
  - order shape: each mapper fills every field from a sample row; `fromLegacyOrderDetails(null)` and a non-object return `null`.

- [ ] **Step 2:** Run `npx vitest run lib/support-validation.test.ts lib/support-ticks.test.ts lib/order-supplier.test.ts lib/support-order.test.ts`. Expected: FAIL (modules missing).

- [ ] **Step 3:** Implement the four modules. Also add the providers the live data shows but `PROVIDER_DISPLAY` lacks: `kuntanii` ("Kuntanii") and `spfastit_telecel` ("SPFastIT Telecel"), reusing existing badge class styles.

- [ ] **Step 4:** Re-run the same command. Expected: PASS.

- [ ] **Step 5:** Commit: `feat(support): validation, tick, supplier and order-shape helpers`.

---

### Task 3: Rate limit fallback and admin presence

**Files:**
- Create: `lib/support-rate-limit.ts`, `lib/admin-presence.ts`
- Test: `lib/support-rate-limit.test.ts`, `lib/admin-presence.test.ts`

**Interfaces (produced):**

```ts
// lib/support-rate-limit.ts
export type SupportLimitKind = "thread_create" | "message_send"   // 3 per 3_600_000 ms | 10 per 60_000 ms
export async function checkSupportRateLimit(request: NextRequest, kind: SupportLimitKind, userId: string): Promise<{ allowed: boolean }>
export function __resetSupportRateLimitMemory(): void   // tests only

// lib/admin-presence.ts
export const SUPPORT_ACTIVE_WINDOW_MS = 180_000
export async function touchAdminPresence(db: SupabaseClient, adminId: string): Promise<void>   // upsert; never throws
export async function isSupportActive(db: SupabaseClient, now?: Date): Promise<boolean>         // false on any error
```

`checkSupportRateLimit` calls `applyRateLimit(request, "support_" + kind, max, windowMs, userId)`. If the result has `degraded: true`, it ignores `allowed` and consults an in-memory sliding window (Map of userId+kind → timestamps) with the same limits.

- [ ] **Step 1: Failing tests** (mock `@/lib/rate-limiter`):
  - limiter returns `{allowed:false, degraded:false}` → `allowed:false`.
  - limiter returns `{allowed:true, degraded:true}` four times for `thread_create` → first three allowed, fourth refused; a different user is still allowed.
  - degraded `message_send`: 10 allowed, 11th refused; after advancing fake timers 60 001 ms, allowed again.
  - presence: a row 2 minutes old → `true`; 4 minutes old → `false`; query error → `false`; `touchAdminPresence` swallows an upsert error.

- [ ] **Step 2:** Run both test files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(support): fail-closed rate limit and admin presence`.

---

### Task 4: Screenshot handling

**Files:**
- Create: `lib/support-attachment.ts`
- Test: `lib/support-attachment.test.ts`

**Interfaces (produced):**

```ts
export const SUPPORT_ATTACHMENT_BUCKET = "complaint-evidence"
export const SUPPORT_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024
export const SUPPORT_ATTACHMENT_URL_TTL_SECONDS = 600
export type SniffedImage = { mime: "image/jpeg" | "image/png" | "image/webp"; ext: "jpg" | "png" | "webp" }
export function sniffImage(bytes: Uint8Array): SniffedImage | null   // magic bytes only
export function buildAttachmentPath(userId: string, threadId: string, ext: SniffedImage["ext"]): string
  // `threads/${userId}/${threadId}/${crypto.randomUUID()}.${ext}`
export async function storeThreadAttachment(db: SupabaseClient, args: { userId: string; threadId: string; file: File }): Promise<{ path: string } | { error: "too_large" | "not_image" | "upload_failed" }>
export async function signAttachmentUrl(db: SupabaseClient, path: string | null): Promise<string | null>
export async function removeAttachments(db: SupabaseClient, paths: string[]): Promise<void>  // chunks of 100, never throws
```

- [ ] **Step 1: Failing tests:** JPEG (`FF D8 FF`), PNG (`89 50 4E 47 0D 0A 1A 0A`), WebP (`RIFF....WEBP`) headers sniff correctly; a PDF header, an HTML string and an empty array return `null`; a file whose declared type is `image/png` but whose bytes are HTML → `{error:"not_image"}` and the fake storage `upload` is never called; 4 MB + 1 byte → `{error:"too_large"}`; storage error → `{error:"upload_failed"}`; the path never contains the uploaded file's name; `signAttachmentUrl(db, null)` → `null`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Upload with `contentType` from the sniff result and `upsert: false`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(support): optional screenshot storage helpers`.

---

### Task 5: Notification helpers

**Files:**
- Create: `lib/support-notify.ts`
- Modify: `lib/notification-service.ts` (add `"support_reply"` to `NotificationType`)
- Test: `lib/support-notify.test.ts`

**Interfaces (produced):**

```ts
export type SupportUserEvent = "received" | "replied" | "closed"
export async function notifyUserSupportEvent(db: SupabaseClient, userId: string, event: SupportUserEvent, threadId: string): Promise<void>
export async function alertAdminsNewThread(args: { threadId: string; subject: string; summary: string }): Promise<void>
export function runAfterResponse(task: () => Promise<void>): void
```

Fixed copy (title / message): `received` → "We received your complaint" / "Our support team will reply here shortly."; `replied` → "Support replied to your complaint" / "Open Support & Complaints to read the reply."; `closed` → "Your complaint was closed" / "Open a new complaint if you still need help." Each inserts a `notifications` row (`type: "support_reply"`, `reference_id: threadId`, `action_url: "/dashboard/complaints"`, `read: false`) and calls `sendPushToUser(userId, { title, body, data: { url: "/dashboard/complaints" } })`. `alertAdminsNewThread` calls `alertAdminsOfRequest("complaint", { complaintId: threadId, summary: summary.slice(0, 200), url: "/admin/complaints", customerLabel: subject })`.

- [ ] **Step 1: Failing tests:** each event inserts the exact copy above; a notification insert error still attempts the push; a push rejection does not reject the helper; `runAfterResponse` falls back to running the task when `after` throws.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(support): user and admin notification helpers`.

---

### Task 6: User routes

**Files:**
- Create: `app/api/support/threads/route.ts` (POST), `app/api/support/threads/[id]/messages/route.ts` (POST), `app/api/support/threads/[id]/attachment/route.ts` (GET), `app/api/support/presence/route.ts` (GET)
- Create: `lib/support-auth.ts` — `export async function getSupportUser(request: NextRequest): Promise<{ userId: string } | null>`
- Test: `route.test.ts` beside each POST route and the attachment route (mock `@supabase/supabase-js` with a hand-rolled fake as in `app/api/admin/packages/bulk-update-price/route.test.ts`)

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `POST /api/support/threads` — JSON or `multipart/form-data` (fields as `createThreadSchema`, optional file field `image`). 201 → `{ success: true, data: { thread_id: string, attachment_saved: boolean | null } }` (`null` when no image was sent).
  - `POST /api/support/threads/[id]/messages` — `{ message }` → 201 `{ success: true, data: { id, created_at } }`.
  - `GET /api/support/threads/[id]/attachment` → `{ success: true, data: { url: string | null } }`.
  - `GET /api/support/presence` → `{ success: true, data: { active: boolean } }` (requires a signed-in user).

Order of checks in thread create: auth 401 → parse + validate 400 → rate limit 429 → ownership 404 → insert thread (`OPEN_THREAD_LIMIT` in error message → 409 "You already have 3 open complaints") → insert first message (on failure delete the thread, 500) → optional screenshot via `storeThreadAttachment`, then set `attachment_path` on the first message → `runAfterResponse` with `alertAdminsNewThread` and `notifyUserSupportEvent(…, "received", …)`.

Ownership: `order_id` → `orders` where `id` and `user_id = caller`. `shop_order_id` → load `shop_orders.shop_id`, then `user_shops` where `id = shop_id` and `user_id = caller`.

- [ ] **Step 1: Failing tests.** Thread create: no bearer → 401; invalid phone → 400; rate-limited → 429 and no insert; `order_id` owned by another user → 404 and no insert; `shop_order_id` whose shop belongs to another user → 404; shop order owned through the caller's shop → 201; trigger error containing `OPEN_THREAD_LIMIT` → 409; first-message insert failure → thread delete called, 500; image that fails sniffing → 201 with `attachment_saved: false`; valid image → `attachment_saved: true` and the message updated with a path starting `threads/<caller>/<thread>/`; a throwing notification still yields 201. Messages: non-uuid id → 400; thread of another user → 404; closed thread → 409; 11th message in a minute → 429; success inserts `sender_role: "user"`, `sender_id: caller`. Attachment: another user's thread → 404; own thread without attachment → `url: null`.
- [ ] **Step 2:** Run `npx vitest run app/api/support`. Expected: FAIL.
- [ ] **Step 3:** Implement the four routes and `getSupportUser`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(support): user thread, message, attachment and presence routes`.

---

### Task 7: Admin thread routes

**Files:**
- Create: `app/api/admin/support/threads/route.ts` (GET), `app/api/admin/support/threads/[id]/route.ts` (GET, POST), `app/api/admin/support/counts/route.ts` (GET)
- Create: `lib/support-admin-data.ts`
- Test: `route.test.ts` beside each; `lib/support-admin-data.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:

```ts
// lib/support-admin-data.ts
export async function loadSupportOrders(db: SupabaseClient, threads: { id: string; order_id: string | null; shop_order_id: string | null }[]):
  Promise<Map<string /* thread id */, { order: SupportOrder; supplier: SupplierResult }>>
```

It runs at most four queries regardless of thread count: `orders` by ids, `shop_orders` by ids, `user_shops` names for those shops, and `mtn_fulfillment_tracking` (`provider, created_at, order_id, shop_order_id`) for both id sets. Chunk every `.in()` at 200 ids.

  - `GET /api/admin/support/threads?status=open|closed|all&days=30` → `{ success, data: { threads: AdminThreadRow[] } }` where each row has thread fields, `user: { first_name, last_name, email, phone_number }`, `order: SupportOrder | null`, `last_message: { body, sender_role, created_at } | null`, `unread_count: number`. Open threads are returned regardless of `days`; closed ones only inside the window. Calls `touchAdminPresence`.
  - `GET /api/admin/support/threads/[id]` → thread + `user` + `order` + `supplier` + `messages[]` (ascending; each with `delivered_at`, `read_at` from `getCounterpartReceipt`, and `attachment_url` signed when a path exists). Marks unread user messages `delivered_to_admin_at`.
  - `POST /api/admin/support/threads/[id]` with `adminActionSchema` → `read` | `reply` (409 if closed; notifies `replied`) | `close` (optional note inserted as an admin message; `UPDATE … WHERE id = ? AND status = 'open'` returning rows; zero rows → 409; notifies `closed`). A human reply also sets `handler = 'human'`.
  - `GET /api/admin/support/counts` → `{ openThreads, unreadMessages, legacyPending }` (`legacyPending` = `complaints.status IN ('pending','in_review')`).

- [ ] **Step 1: Failing tests.** Non-admin → the `errorResponse` from `verifyAdminAccess`; admin result with no `userId` → 401 on all four; list with `status=all&days=7` builds the filter `status.eq.open,last_message_at.gte.<since>`; `days=500` clamps to 90, `days=0` to 1; unread count counts only user messages with null `read_by_admin_at`; reply to a closed thread → 409 and no insert; close when the guarded update returns zero rows → 409 and no `closed` notification; close with a note inserts the note before the update; the recipient of every notification is the thread row's `user_id` even if the body carries a different `user_id`; `loadSupportOrders` with 450 threads issues `.in()` calls of at most 200 ids.
- [ ] **Step 2:** Run `npx vitest run app/api/admin/support lib/support-admin-data.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(support): admin thread list, conversation, actions and counts`.

---

### Task 8: Legacy routes and retirement of the old form's API

**Files:**
- Create: `app/api/admin/complaints/route.ts` (GET), `app/api/admin/complaints/resolve/route.ts` (POST)
- Delete: `app/api/complaints/create/route.ts`, `app/api/admin/complaints/update/route.ts`
- Modify: `lib/admin-actions/wiring.test.ts` (the assertion on `app/api/complaints/create/route.ts` now targets `lib/support-notify.ts`)
- Test: `route.test.ts` beside each new route

**Interfaces (produced):**
  - `GET /api/admin/complaints?days=30` (clamped 1–90) → `{ success, data: { complaints: LegacyComplaintRow[] } }`; each row: complaint columns, `user: { first_name, last_name, email }`, `order: SupportOrder | null` (from the joined `orders` row when `order_id` is set, else `fromLegacyOrderDetails(order_details)`), `supplier: SupplierResult` (null when there is no `order_id`), `has_evidence: boolean`. Pending rows are always returned regardless of `days`.
  - `POST /api/admin/complaints/resolve` with `resolveComplaintSchema` → loads the row, 404 if missing, 409 if status is already `resolved` or `rejected`, updates `status`, `resolution_notes`, `updated_at`, then `notifyUserOfOutcome("complaint", status, { userId: row.user_id, reference: row.id }, { complaintId: row.id, orderId: row.order_id ?? undefined, resolutionNotes })`.

- [ ] **Step 1: Failing tests:** non-admin refused; `status: "pending"` in the body → 400; already-resolved row → 409 and no notify; recipient comes from the row; notes over 2000 chars → 400; list returns a pending row older than the window; a shop row with no `order_id` gets its order from `order_details`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; delete the two old routes; update the wiring test. Run `git grep -n "complaints/create\|complaints/update"` and confirm the only remaining hits are `components/complaint-modal.tsx` and `app/admin/complaints/page.tsx` (both replaced in Tasks 10 and 11).
- [ ] **Step 4:** Run `npx vitest run app/api/admin/complaints lib/admin-actions`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(support): legacy complaint list and resolve routes; retire old create/update`.

---

### Task 9: Cleanup cron

**Files:**
- Create: `app/api/cron/delete-old-complaints/route.ts`, `lib/support-cleanup.ts`
- Modify: `lib/cron-migration/crons.json` (add `/api/cron/delete-old-complaints`, schedule `15 3 * * *`)
- Test: `lib/support-cleanup.test.ts`

**Interfaces (produced):**

```ts
export const SUPPORT_RETENTION_DAYS = 90
export async function deleteOldSupportData(db: SupabaseClient, now: Date, opts?: { dryRun?: boolean }):
  Promise<{ closedThreads: number; legacyComplaints: number; filesRemoved: number }>
```

Selection: threads with `status = 'closed' AND closed_at < now - 90d`; complaints with `status IN ('resolved','rejected') AND updated_at < now - 90d`. For each batch of 200 ids: collect file paths (`support_messages.attachment_path`; `complaints.evidence->>'balance_image_path'` and `'momo_receipt_path'`), `removeAttachments`, then delete the rows. With `dryRun` it only counts. The route authorises with `verifyCronAuth` and accepts `?dry=1`.

- [ ] **Step 1: Failing tests:** an open thread 200 days old is never selected; a closed thread 89 days old is kept, 91 days deleted; a `pending` complaint 400 days old is kept; a resolved one 91 days old is deleted and both its evidence paths are passed to storage removal; 450 eligible rows are deleted in batches of at most 200; `dryRun` deletes nothing and returns the same counts.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(support): 90-day cleanup cron for closed threads and resolved complaints`. Do NOT register the job on cron-job.org yet (Task 12).

---

### Task 10: Customer and shop-owner screens

**Files:**
- Create: `components/support/report-problem-dialog.tsx`, `components/support/thread-list.tsx`, `components/support/chat-pane.tsx`, `components/support/message-bubble.tsx`, `components/support/presence-badge.tsx`, `components/support/new-complaint-dialog.tsx`, `hooks/use-support-threads.ts`
- Rewrite: `app/dashboard/complaints/page.tsx`
- Modify: `app/dashboard/my-orders/page.tsx`, `app/dashboard/shop-dashboard/page.tsx`, `lib/dashboard-nav-items.ts` (+ its test), `mobile/src/components/side-menu.tsx` (label only)
- Delete: `components/complaint-modal.tsx`

**Interfaces:**
- Consumes: Task 6 routes; `lib/support-ticks.ts`; `supabase` from `lib/supabase.ts`; `useSupportConfig`.
- Produces: `<ReportProblemDialog open onOpenChange order={{ kind: "order" | "shop_order", id, reference, summary }} />`; `useSupportThreads()` → `{ threads, messagesByThread, openThread(id), sendMessage(id, text), loading, error }`.

Behaviour to implement (source prompt §5.1–5.2 applies in full):
- `useSupportThreads` selects explicit columns. Messages: `id, thread_id, sender_role, body, attachment_path, delivered_to_user_at, read_by_user_at, created_at` — never the admin receipt columns. One Realtime channel: `INSERT` on `support_messages`, `UPDATE` on `support_threads` filtered `user_id=eq.<me>`; ignore events for thread ids not in a ref of my threads. On an incoming admin/ai message write `delivered_to_user_at`; opening a thread writes `read_by_user_at` and `delivered_to_user_at`.
- `ReportProblemDialog`: description (5–1000), phone and WhatsApp number prefilled from the user's profile, "Add a screenshot (optional)" picker (client-side 4 MB / image type hint), submits `multipart/form-data` with `subject: "Issue with order <reference>"`, `category: "order"`, and `order_id` or `shop_order_id`. A synchronous `inFlight` ref blocks double taps. On 409 show "You already have 3 open complaints"; on `attachment_saved === false` toast "Complaint sent, but the screenshot could not be saved." On success route to `/dashboard/complaints`.
- Page: header "Support & Complaints", New Complaint button, contact hub, two panes on `lg:` and one pane at a time below, presence badge polling `/api/support/presence` every 45 s, composer `maxLength={1000}` only while open, closed → lock notice + New Complaint, collapsible "Past order complaints" (the user's `complaints` rows, read-only: title, status, resolution notes, date), push-permission prompt while chatting without notifications.
- My Orders: the existing "Complain" button opens `ReportProblemDialog` with `kind: "order"`.
- Shop dashboard: keep the existing "completed for ≥ 30 minutes" condition; the button opens the dialog with `kind: "shop_order"`. One extra query loads `support_threads(shop_order_id, status)` for the visible order ids; a row with an open thread shows a "Complaint: open" badge instead of the button. Check `app/dashboard/shop-orders/page.tsx`; if it lists the owner's orders with actions, add the same button there.
- Nav label "My Complaints" → "Support & Complaints" (web and mobile).
- Suspension: `git grep -n "is_suspended"` shows no page-level gate in `middleware.ts` or `app/dashboard`. Confirm; if a gate exists, exempt `/dashboard/complaints` and `/api/support/*`. Record what was found in the commit message.

- [ ] **Step 1:** Update `lib/dashboard-nav-items.test.ts` for the new label; run it; expected FAIL.
- [ ] **Step 2:** Build the hook and components, then the page and the two entry points; delete the old modal.
- [ ] **Step 3:** `npx tsc --noEmit` and `npx vitest run`. Expected: no new type errors; only the 9 known order-health failures remain.
- [ ] **Step 4:** Screenshot `/dashboard/complaints` at 500 px and 1440 px, light and dark, via the headless-Chrome recipe in memory `reference-headless-screenshots.md`; confirm both panes, bubbles, lock notice.
- [ ] **Step 5:** Commit: `feat(support): customer chat page and order entry points`.

---

### Task 11: Admin console

**Files:**
- Create: `components/admin/support/threads-tab.tsx`, `conversation-dialog.tsx`, `order-details-dialog.tsx`, `supplier-badge.tsx`, `legacy-tab.tsx`, `legacy-detail-dialog.tsx` (all under `components/admin/support/`)
- Rewrite: `app/admin/complaints/page.tsx`
- Modify: `app/admin/page.tsx` (the Complaints card reads `openThreads + legacyPending` from `/api/admin/support/counts`; label "Support & Complaints")

**Interfaces:**
- Consumes: Tasks 7 and 8 routes; `getProviderDisplay` from `lib/mtn-providers/provider-display.ts`; `getMessageTickState`.
- Produces: `<SupplierBadge supplier={SupplierResult} />` — `null` → "N/A"; `{kind:"manual"}` → "Manual"; supplier → provider label, prefixed "Last tried: " when `attemptedOnly`.

Behaviour (source prompt §5.3 applies in full): segmented toggle Threads | Legacy. Threads: three stat cards, search (name, email, subject, phone, order ref), status filter (Open default), window 7/30/90, Refresh; list polls every 180 s, an open conversation every 30 s; opening fires `action: "read"` and zeroes that row's badge. Conversation dialog: subject/status header, `tel:`, `https://wa.me/233XXXXXXXXX` (strip leading `0` or `+`), `mailto:` links, order strip with View Details, bubbles with ticks on admin messages (✓ sent, ✓✓ grey delivered, ✓✓ blue read), the first message's screenshot inline when `attachment_url` exists, composer, Close → inline "Close this complaint?" with optional note. Order Details dialog: reference, beneficiary, package (`network size`), order placed, supplier badge, subtitle "For resolving this complaint against the right order and supplier." Legacy: table on desktop / cards on mobile with the columns in the prompt, filters, detail dialog with evidence photos (via the kept `POST /api/admin/complaints/evidence-urls`) and Resolution Notes + Reject / Mark Resolved only while `pending` or `in_review`.

- [ ] **Step 1:** Component test `components/admin/support/supplier-badge.test.tsx` for the four badge outputs above; run; expected FAIL.
- [ ] **Step 2:** Build the components and the page.
- [ ] **Step 3:** `npx tsc --noEmit` and `npx vitest run`. Expected as in Task 10.
- [ ] **Step 4:** Screenshot `/admin/complaints` (both tabs, conversation dialog open) at 500 px and 1440 px.
- [ ] **Step 5:** Commit: `feat(support): admin Support & Complaints console`.

---

### Task 12: Verification and release

- [ ] **Step 1:** Fresh-reviewer gate (owner's review-gates rule: auth + schema change): request a code review of the whole branch with focus on the Review Focus list, RLS/grants, and ownership checks; fix confirmed findings with a failing test first.
- [ ] **Step 2:** `npx tsc --noEmit`, `npx vitest run`, then a real `next build` with placeholder env. Expected: build succeeds.
- [ ] **Step 3:** Manual two-browser pass on a preview deployment: file from My Orders with a screenshot → admin sees thread, order details, supplier, image → reply → user sees it live and ticks turn blue → close → user reply refused (409) → open 4 threads (4th refused). Repeat filing as a shop owner from the shop dashboard. Try `POST /api/support/threads` with another user's `order_id` (expect 404).
- [ ] **Step 4:** Call `GET /api/cron/delete-old-complaints?dry=1` against production data and report the three counts to the owner. STOP for go-ahead before registering the job with `scripts/sync-cronjob-org.ts`.
- [ ] **Step 5:** With the owner's OK: check local `main` for other sessions' commits, merge, push, watch the deploy, live-check both pages.
- [ ] **Step 6:** Write the memory file `project-support-chat-threads.md` (+ index line) and give the owner the ready-to-paste customer channel announcement with how-to-use steps.
