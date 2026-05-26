# WhatsApp Admin Conversations Panel — Design Spec

**Date:** 2026-05-26  
**Status:** Approved

---

## Overview

An admin-only page at `/admin/whatsapp-conversations` for monitoring, replying to, closing, and exporting WhatsApp conversations. Built on the existing `whatsapp_conversations` and `whatsapp_messages` Supabase tables with the same `verifyAdminAccess` auth pattern used across the admin API surface.

---

## Page Layout

Two-panel split layout matching existing admin patterns (e.g. `mtn-logs`, `orders`):

- **Left panel** — Conversation list (scrollable, paginated 20/page)
- **Right panel** — Message thread for the selected conversation

### Left Panel — Conversation List

Each row shows:
- Phone number (always present)
- Full name if the phone is matched to a Datagod user account, else "Guest"
- Last message preview (truncated to ~60 chars)
- Status badge: `active` (green) or `closed` (gray)
- Time since last inbound message (relative, e.g. "3 min ago")

Controls:
- Search input — filters by phone number or name (client-side against loaded page)
- Filter toggle — All / Matched / Unmatked / Active / Closed
- Pagination — 20 conversations per page, prev/next buttons

### Right Panel — Message Thread

Displays when a conversation is selected. Shows:
- Thread header: phone, name (if matched), status badge, **Close** button, **Export** button
- Message bubbles ordered chronologically:
  - **Inbound** (user) — green bubble, right-aligned label "User"
  - **Outbound** (AI / admin) — blue bubble, left-aligned label "AI" or "Admin"
  - **Status receipts** — gray inline row: "Delivered", "Read", etc.
  - Each message shows timestamp and a collapsed `tool_context` badge (click to expand JSON)
- **Admin reply box** at the bottom: textarea + "Send" button
  - Sends via existing `sendWhatsAppText` in `whatsapp-service.ts`
  - Logged as `direction: "outbound"` with `tool_context: { source: "admin_reply", adminId }`
  - Updates `latest_outbound_at` and `last_message_preview` on the conversation

### Actions

| Action | Trigger | Effect |
|--------|---------|--------|
| Close conversation | Button in thread header | PATCH sets `status = "closed"`, refreshes list |
| Export conversation | Button in thread header | Downloads `.csv` with columns: timestamp, direction, message, status |
| Send admin reply | Textarea + Send | POST to reply API, appends message to thread, scrolls to bottom |

---

## API Routes

All routes use `verifyAdminAccess` from `lib/admin-auth.ts`. All Supabase calls use the service role key.

### `GET /api/admin/whatsapp-conversations`

Query params:
- `page` (default 1) — 20 per page, ordered by `latest_inbound_at DESC`
- `search` — optional phone/name substring filter (server-side ILIKE)
- `status` — optional filter: `active` | `closed`
- `matched` — optional filter: `true` | `false` (whether `user_id IS NOT NULL`)

Response:
```json
{
  "conversations": [...],
  "total": 120,
  "page": 1
}
```

Each conversation object includes a `user` join: `{ first_name, last_name }` if `user_id` is set.

### `GET /api/admin/whatsapp-conversations/[id]`

Returns all messages for a conversation ordered by `created_at ASC`. No pagination (conversations are bounded by the 24hr window and 12-message history already enforced in the webhook).

Response: `{ "messages": [...] }`

### `PATCH /api/admin/whatsapp-conversations/[id]`

Body: `{ "status": "closed" | "active" }`  
Updates `whatsapp_conversations.status`.

### `POST /api/admin/whatsapp-conversations/[id]/reply`

Body: `{ "message": string }`  
- Validates message is non-empty and ≤ 4096 chars
- Calls `sendWhatsAppText` with `skipLogging: false`
- Logs with `tool_context: { source: "admin_reply" }`
- Updates conversation `latest_outbound_at` and `last_message_preview`

---

## Files to Create / Modify

| File | Action |
|------|--------|
| `app/admin/whatsapp-conversations/page.tsx` | Create — main page component |
| `app/api/admin/whatsapp-conversations/route.ts` | Create — list endpoint |
| `app/api/admin/whatsapp-conversations/[id]/route.ts` | Create — get messages + PATCH status |
| `app/api/admin/whatsapp-conversations/[id]/reply/route.ts` | Create — admin reply |
| `app/admin/layout.tsx` | Modify — add nav link if sidebar uses a static list |

---

## Error Handling

- Missing conversation ID → 404
- Message > 4096 chars → 400
- WhatsApp send failure → return error to UI, do not log as sent
- Unauthenticated/non-admin → 401/403 via `verifyAdminAccess`

---

## Constraints

- No new Supabase tables required — uses existing `whatsapp_conversations` and `whatsapp_messages`
- Export is client-side CSV generation (no server endpoint needed)
- Admin replies bypass the AI loop entirely — direct `sendWhatsAppText` call
- The page does not auto-poll; admin refreshes manually or navigates back to list
