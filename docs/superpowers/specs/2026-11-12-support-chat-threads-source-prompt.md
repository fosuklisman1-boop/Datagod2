> Owner's original prompt, saved verbatim on 2026-11-12. Where it conflicts with `2026-11-12-support-chat-threads-design.md`, the design wins.

# Complaints & Support System  rebuild— Build Prompt (hand this to Claude)

> You are building a **complaints / support-chat system** for a Next.js 15 (App Router) + Supabase (Postgres, Auth, RLS) + Tailwind + shadcn/ui fintech reseller platform (data bundles, airtime, wallets). Users, shop owners (resellers) and admins all take part. Build exactly what is described below. Follow the **Security rules** section strictly: this app moves money and holds customer PII.

---

## 1. What the feature does (product view)

1. **A customer or shop owner files a complaint**, usually from an order row ("Report a problem" / "File a Complaint"), or free-form from a Support page.
2. Filing a complaint **opens a chat thread** (subject + first message + phone + WhatsApp number + optional linked order).
3. The user gets an **instant in-app notification + web push** confirming receipt. All **admins get an email + push**.
4. **Admin opens the thread** in a console and sees: the user's contact details (tap-to-call / WhatsApp / email), the full chat, and an **"Order Details" panel** with the linked order: reference, beneficiary number, package, order time, status and **which supplier fulfilled it**.
5. Admin **replies** (user gets notification + push) and finally **closes** the thread (optional closing note, user notified). Replies show **WhatsApp-style ticks** (sent / delivered / read).
6. The user sees replies **live** (Supabase Realtime) and can reply until the thread is closed. A closed thread cannot receive messages; they open a new one.
7. A **"Support active now / away" badge** shows the user whether an admin has been active in the last 3 minutes.
8. **Legacy (v1) complaints** still exist: a single-shot row on one order with `pending → resolved/rejected` and resolution notes. Shop owners still file these from their shop-orders page. They live in a **separate read-only "Legacy" tab** for admins and are auto-deleted after 30 days.

There are **three complaint stores** in total:

| Store | Who files | Shape | Admin surface |
|---|---|---|---|
| `support_threads` + `support_messages` (current) | any user, from My Orders / bundle orders / Support page | chat thread | Threads tab |
| `complaints` (legacy) | shop owner from shop orders page (`/api/complaints/submit`) | one row, admin resolves with notes | Legacy tab |
| `results_checker_complaints` | user/shop for exam-result-checker voucher orders | one row, `open → resolved`, `admin_note` | its own admin page |

If your platform has no results-checker product, skip the third store.

---

## 2. Database (Postgres / Supabase)

Apply as migrations, in order. Tables are **server-write-only**: the browser may only SELECT (and flip its own read/delivered timestamps). Every insert/update goes through API routes using the service-role client after validation.

```sql
-- 0. prerequisites: public.users(id), public.orders(id), uuid_generate_v4()

-- 1. Chat threads ------------------------------------------------------------
CREATE TABLE public.support_threads (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         uuid NOT NULL REFERENCES public.users(id)  ON DELETE CASCADE,
  order_id        uuid          REFERENCES public.orders(id) ON DELETE SET NULL,
  subject         text NOT NULL,
  category        text NOT NULL DEFAULT 'other'
                    CHECK (category IN ('order','payment','account','other')),
  phone_number    text NOT NULL,
  whatsapp_number text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_at       timestamptz,
  closed_by       uuid,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.support_messages (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  thread_id             uuid NOT NULL REFERENCES public.support_threads(id) ON DELETE CASCADE,
  sender_role           text NOT NULL CHECK (sender_role IN ('user','admin')),
  sender_id             uuid NOT NULL,
  body                  text NOT NULL,
  -- direction-scoped receipts (a message's counterpart is fixed by sender_role)
  delivered_to_user_at  timestamptz,
  delivered_to_admin_at timestamptz,
  read_by_user_at       timestamptz,
  read_by_admin_at      timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_support_threads_user_id ON public.support_threads(user_id, last_message_at DESC);
CREATE INDEX idx_support_threads_status  ON public.support_threads(status,  last_message_at DESC);
CREATE INDEX idx_support_messages_thread ON public.support_messages(thread_id, created_at);
CREATE INDEX idx_support_threads_order_id ON public.support_threads(order_id) WHERE order_id IS NOT NULL;

-- Optional: a second order table (e.g. a "bundle_orders" product). Nullable FK, validated by the route.
-- ALTER TABLE public.support_threads
--   ADD COLUMN bundle_order_id uuid REFERENCES public.bundle_orders(id) ON DELETE SET NULL;

-- 2. Open-thread cap: max 3 open threads per user, RACE-SAFE -----------------
-- The advisory lock serialises inserts per user so two parallel taps cannot both pass the count.
CREATE OR REPLACE FUNCTION public.enforce_support_thread_cap() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE open_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('support_thread_cap:' || NEW.user_id::text));
  SELECT count(*) INTO open_count FROM public.support_threads
   WHERE user_id = NEW.user_id AND status = 'open';
  IF open_count >= 3 THEN
    RAISE EXCEPTION 'OPEN_THREAD_LIMIT' USING HINT = 'A user may have at most 3 open support threads.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_support_thread_cap BEFORE INSERT ON public.support_threads
  FOR EACH ROW EXECUTE FUNCTION public.enforce_support_thread_cap();

-- 3. Keep last_message_at atomic (API routes can never forget it) ------------
CREATE OR REPLACE FUNCTION public.bump_support_thread_last_message() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  UPDATE public.support_threads SET last_message_at = NEW.created_at, updated_at = now()
   WHERE id = NEW.thread_id;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_support_thread_bump AFTER INSERT ON public.support_messages
  FOR EACH ROW EXECUTE FUNCTION public.bump_support_thread_last_message();

CREATE OR REPLACE FUNCTION public.update_support_threads_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER trg_support_threads_updated_at BEFORE UPDATE ON public.support_threads
  FOR EACH ROW EXECUTE FUNCTION public.update_support_threads_updated_at();

-- 4. RLS + grants ------------------------------------------------------------
ALTER TABLE public.support_threads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY support_threads_owner_select ON public.support_threads
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

CREATE POLICY support_messages_owner_select ON public.support_messages
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.support_threads t WHERE t.id = thread_id AND t.user_id = (SELECT auth.uid())));

CREATE POLICY support_messages_owner_mark_read ON public.support_messages
  FOR UPDATE TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.support_threads t WHERE t.id = thread_id AND t.user_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.support_threads t WHERE t.id = thread_id AND t.user_id = (SELECT auth.uid())));

-- Supabase auto-grants CRUD on new tables: strip it, then grant the minimum.
REVOKE ALL ON public.support_threads  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.support_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.support_threads  TO authenticated;
GRANT SELECT ON public.support_messages TO authenticated;
-- Column-level: the user may only ever write THEIR direction's receipt columns.
GRANT UPDATE (read_by_user_at, delivered_to_user_at) ON public.support_messages TO authenticated;

-- 5. Realtime (postgres_changes is RLS-guarded) ------------------------------
ALTER PUBLICATION supabase_realtime ADD TABLE public.support_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.support_threads;

-- 6. Notifications: allow a 'support_reply' type (extend your existing CHECK) -
-- ALTER TABLE public.notifications DROP CONSTRAINT notifications_type_check;
-- ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
--   CHECK (type IN (..., 'complaint_resolved', 'support_reply'));

-- 7. "Support active now" heartbeat -----------------------------------------
CREATE TABLE public.admin_presence (
  admin_id     uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_presence ENABLE ROW LEVEL SECURITY;   -- no policies = deny-all
REVOKE ALL ON public.admin_presence FROM PUBLIC, anon, authenticated;

-- 8. Legacy single-shot complaints (shop-owner flow) -------------------------
CREATE TABLE public.complaints (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          uuid NOT NULL REFERENCES public.users(id)  ON DELETE CASCADE,
  order_id         uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  title            text NOT NULL,
  description      text NOT NULL,
  status           text DEFAULT 'pending' CHECK (status IN ('pending','in_review','resolved','rejected')),
  priority         text DEFAULT 'medium'  CHECK (priority IN ('low','medium','high')),
  resolution_notes text,
  evidence         jsonb,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);
CREATE INDEX idx_complaints_user_id ON public.complaints(user_id);
CREATE INDEX idx_complaints_status  ON public.complaints(status);
ALTER TABLE public.complaints ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own complaints" ON public.complaints
  FOR SELECT USING ((SELECT auth.uid()) = user_id);
-- DO NOT add a client INSERT/UPDATE policy. Inserts go through the API route (see Security rules).
REVOKE INSERT, UPDATE, DELETE ON public.complaints FROM anon, authenticated;
```

### Order data the admin needs (already exists in the host app)

The admin console joins the thread to the order. The order table must expose: `reference_code`, `phone_number` (beneficiary), `network`, `size`, `price`, `status`, `created_at`, `shop_name` (if reseller order), `fulfillment_method` (which supplier took it) and `download_batch_id` (set when manually exported). Optional: a tracking table with one **insert-only row per fulfillment attempt** carrying `api_response.supplier` and `created_at`.

---

## 3. Server logic (API routes, all `export const dynamic = 'force-dynamic'`)

Response envelope: `{ success: true, data }` or `{ success: false, error }`.
Auth: **user routes** use the cookie/RLS-aware client and `auth.getUser()`. **Admin routes** call an in-handler `validateAdminAccess(request)` (never rely on middleware alone). **All writes** use the service-role client.

### 3.1 User routes

**`POST /api/support/threads`**: open a thread.
1. `getUser()` → 401.
2. Validate body (zod): `subject` (3–200), `category` enum, `message` (≥5, ≤5000), `phone_number`, `whatsapp_number` (Ghana regex `^(0|\+233)[2-9][0-9]{8}$`; adapt for your country), optional `order_id` (UUID). Reject text containing `<>&`/script patterns for customer text.
3. Optional second-order link (`bundle_order_id`); **at most one** of `order_id`/`bundle_order_id`.
4. **Rate limit server-side: 3 new threads/hour/user** (Upstash sliding window; in-memory fallback if Redis env is missing. Never fail open).
5. If `order_id` is given, confirm the **caller owns that order** (`orders.id = ? AND user_id = caller`) → else 404.
6. Insert the thread with the service-role client. If the error message contains `OPEN_THREAD_LIMIT` → 409 "You already have 3 open complaints".
7. Insert the first `support_messages` row (`sender_role='user'`). If it fails, **delete the thread** so no empty thread is left behind.
8. In `waitUntil(...)` (so serverless teardown can't kill it), non-blocking, each in its own try/catch:
   - email admin (`sendAdminNewComplaintAlert`),
   - push admins ("New complaint", url `/admin/complaints`), **not mutable by admin notification preferences**,
   - insert user notification "We received your complaint" (`type: 'support_reply'`, `action_url: '/dashboard/complaints'`),
   - web push to the user (category `support`).

**`POST /api/support/threads/[id]/messages`**: user reply.
Validate UUID → `getUser()` → validate message → **rate limit 10 msgs/min/user** → read thread via the RLS client and confirm `user_id === caller` → 409 if `status !== 'open'` → insert message (`sender_role='user'`) via service role.

**`GET /api/support/presence`**: returns `{ active: boolean }` from `isSupportActive()` (any `admin_presence.last_seen_at` within the last 3 minutes).

The user's **thread list / messages are read directly from the browser** with the RLS client (SELECT-only grants), plus Realtime. The only browser writes are the two user-direction receipt columns.

**Legacy: `POST /api/complaints/submit`**: shop-owner/user single-shot complaint on one order.
Validate `{ title, description, order_id, priority }` → `getUser()` → UUID check on `order_id` → **verify the caller owns the order** (select `orders` where `id` and `user_id = caller`, else 404; this prevents cross-tenant forging) → coerce priority to `low|medium|high` → insert `status:'pending'` → email admin → in-app notification + push to the user ("We received your complaint") → push to admins. The shop page passes the **mirrored order id** (`orders.shop_order_id = shop_orders.id`) with title `[Shop: <owner first name>] Issue with order <ref>`.

### 3.2 Admin routes

**`GET /api/admin/support/threads?status=open|closed|all&days=30`** (days clamped 1–90, limit 300)
- Joins `users(first_name,last_name,email,phone_number)` and `orders(reference_code,network,size,status)`.
- **Open threads are ALWAYS returned regardless of the date window** (an open complaint must never age out). Closed ones respect the window: `status.eq.open,last_message_at.gte.<since>`.
- Attaches `last_message` preview and `unread_count` (user messages where `read_by_admin_at IS NULL`) from one messages query (newest-first, capped at 3000).
- Attaches the second-order type via a separate `.in('id', ids)` query if you have one.
- Calls `touchAdminPresence(admin.id)` (upsert `admin_presence`).

**`GET /api/admin/support/threads/[id]`**: full thread + messages
- Thread joined with `users(...)` and the **full order**: `orders(reference_code, network, size, status, price, phone_number, created_at, fulfillment_method, download_batch_id)`.
- Messages ordered ascending. On first admin view, one scoped `UPDATE … SET delivered_to_admin_at = now() WHERE thread_id=? AND sender_role='user' AND delivered_to_admin_at IS NULL` (grey double-tick).
- Maps each message through `getCounterpartReceipt()` so the UI gets `delivered_at`/`read_at` relative to the other party.

**`POST /api/admin/support/threads/[id]`** with `{ action: 'reply' | 'close' | 'read' }` (zod discriminated union). Recipient and thread state are derived **from the thread row**; nothing sensitive is trusted from the body.
- `read`: set `read_by_admin_at` and `delivered_to_admin_at` on that thread's unread user messages.
- `reply`: 409 if thread closed; insert `sender_role='admin'` message; notify user ("Support replied to your complaint": in-app `support_reply` + web push).
- `close`: 409 if already closed; optionally insert a closing-note message; then `UPDATE … SET status='closed', closed_at, closed_by WHERE id=? AND status='open' RETURNING id`. **The `status='open'` guard makes two concurrent closes safe**; if zero rows return → 409. Notify user ("Your complaint was closed").

**`GET /api/admin/support/counts`**: sidebar badges: `openThreads`, `unreadMessages` (user msgs with `read_by_admin_at IS NULL`), `legacyPending` (`complaints.status in ('pending','in_review')`). Server-side counts because RLS-scoped client counts always read ~0 for admins.

**`GET /api/admin/complaints?days=30`** (legacy list, days clamped 1–90): `complaints` joined to `users(first_name,last_name,email)` and `orders(reference_code, phone_number, network, size, shop_name, created_at, status, fulfillment_method, download_batch_id)`.

**`POST /api/admin/complaints/resolve`** `{ id, status: 'resolved'|'rejected', resolution_notes }`: admin-only; notes trimmed/capped at 2000 chars; load the row, update status + notes + `updated_at`, insert notification (`complaint_resolved`, url `/dashboard/complaints`), send "resolved/rejected" email. The recipient and order ref come from the **row**, never the request.

### 3.3 Cron

`GET /api/cron/delete-old-complaints` (secret-header auth, run daily):
- delete legacy `complaints` older than **30 days**;
- delete `support_threads` with `status='closed'` and `closed_at` older than **90 days** (messages cascade). **Open threads are never deleted.**

---

## 4. Supplier resolution (the "which supplier took this order" column)

Pure function, no I/O. Used by every admin complaint view.

```ts
type SupplierTag = 'supplierA' | 'supplierB' | /* …your suppliers… */ 'exported'

resolveSupplier(trackingRows, downloadBatchId, fulfillmentMethod, orderStatus): SupplierTag | null
```
Rules (these exist because of real bugs, so keep them):
1. **`orders.fulfillment_method` wins**, because every dispatch path overwrites it with the latest attempted supplier. But only trust it when `orderStatus ∈ {processing, completed, refunded}`. On `pending`/`failed` it means "last supplier *attempted*", not "supplier that fulfilled it".
2. Otherwise fall back to the **latest** tracking row (by `created_at`, unparseable dates sort oldest) whose `api_response.supplier` is a known supplier. Tracking is insert-only, so "first row" returns a stale attempt.
3. Otherwise `download_batch_id` set → `'exported'` (manually exported to a supplier file).
4. Otherwise `null` → render "N/A". Unknown supplier strings also degrade to `null`; never cast them into the tag type.
5. `'auto'`/`'manual'` in `fulfillment_method` are dispatch modes, not suppliers.

A `SUPPLIER_META` map gives each tag a `label` and badge colour class; the UI renders `<SupplierBadge order={…}/>`.

---

## 5. Frontend

### 5.1 User: `/dashboard/complaints` ("Support & Complaints")
- Header + **New Complaint** button. Contact hub (WhatsApp / call / email / community links from admin settings).
- Two-pane layout: thread list (subject, status badge, category, last message time, unread bubble) and chat pane. On mobile show one pane at a time.
- Chat: bubbles (user right, admin left), auto-scroll, composer (maxLength 1000) only while `open`; closed → lock notice + "New Complaint".
- **Realtime**: one channel subscribed to `INSERT` on `support_messages` and `UPDATE` on `support_threads` (`user_id=eq.<me>`). Guard with a ref of my thread ids (defence in depth on top of RLS). When an admin message arrives, write `delivered_to_user_at`. Opening a thread marks admin messages `read_by_user_at` + `delivered_to_user_at`.
- Select an **explicit column list** for messages; do not ship `read_by_admin_at` to the browser.
- "Support active now/away" badge polls `/api/support/presence` every 45 s.
- A contextual **push-permission prompt** appears while chatting without notifications.
- Past legacy complaints are in a collapsible "Past order complaints".
- Suspended users are allowed on this page so they can appeal.

### 5.2 Entry points that pre-link an order
- **My Orders → "Report a problem"**: dialog (description, phone, WhatsApp) → `POST /api/support/threads` with `order_id`, `subject: "Issue with order <ref>"`, `category: 'order'`.
- **Second order type dialog** (`BundleComplaintDialog`): same, with `bundle_order_id`; uses a synchronous `inFlight` ref as a double-tap guard.
- **Shop owner orders page**: order row shows "Complaint: <status>" badge if one exists, else a **File a Complaint** button → legacy `POST /api/complaints/submit` against the mirrored order id. A small follow-up query loads `complaints(id, order_id, status)` for the current page's order ids.

### 5.3 Admin: `/admin/complaints`
Page title "Support & Complaints" with a segmented toggle **Threads | Legacy**.

**Threads tab**
- Stat cards: open complaints, unread messages, in view.
- Search (name, email, subject, phone, order ref), status filter (Open default / Closed / All), window (7/30/90 days), Refresh.
- Rows: subject, unread bubble, user name/email, last-message preview ("You:" prefix for admin), status badge, last activity, order ref.
- Row click → **conversation dialog**: header with subject/status, tel / WhatsApp (`wa.me/<normalised>`) / mailto links, a linked-order strip with a **View Details** button, chat bubbles with ticks on admin messages (sent ✓, delivered ✓✓ grey, read ✓✓ blue), composer + **Close** button → inline "Close this complaint?" with optional closing note.
- **Order Details dialog** (this is the "attached order + supplier + time" view): Order reference · Beneficiary number · Package (`network size`) · Order placed (timestamp) · **Supplier badge**. Subtitle: "For resolving this complaint against the right order and supplier."
- Opening a thread fires `action:'read'` and zeroes its list badge. List polls every **180 s**, open conversation every **30 s**. Polling is deliberately slow to protect egress. Each poll passes through auth middleware.

**Legacy tab**
- Table (desktop) / cards (mobile): User (+ "Shop: <shop_name>" badge for reseller orders), Order Ref, Order Date, Beneficiary, Package, **Supplier**, Issue, Status, Filed. Filters: search, status (with counts), date presets (today/yesterday/7 days/custom range).
- Detail dialog: status, beneficiary, order placed, supplier, title + description, **Resolution Notes** textarea with **Reject / Mark Resolved** buttons (only while `pending`/`in_review`), read-only resolution afterwards.

Sidebar badge = `openThreads + legacyPending` (or unread), refreshed from `/api/admin/support/counts`.

### 5.4 Tick helper
```ts
getCounterpartReceipt(senderRole, row) =
  senderRole === 'admin' ? { delivered_at: row.delivered_to_user_at,  read_at: row.read_by_user_at }
                         : { delivered_at: row.delivered_to_admin_at, read_at: row.read_by_admin_at }
getMessageTickState({delivered_at, read_at}) = read_at ? 'read' : delivered_at ? 'delivered' : 'sent'
```

---

## 6. Security rules (non-negotiable)

1. **Money/support tables are server-write-only.** `REVOKE ALL … FROM PUBLIC, anon, authenticated` first, then grant only `SELECT` (and the two column-level `UPDATE` receipt columns). Supabase auto-grants CRUD on new tables, so the explicit revoke is required.
2. **Never keep a client `INSERT` policy on `complaints`** (the original schema had `FOR INSERT WITH CHECK (auth.uid() = user_id)`). It lets any user insert a complaint against **someone else's `order_id`**. All inserts go through the route, which checks order ownership.
3. **Ownership check before linking any order** (`orders.user_id = caller`) on every create path. Never echo another user's order reference in an admin alert.
4. **Admin routes authorise in the handler** (`validateAdminAccess`), not only in middleware, because they return customer PII (phone/WhatsApp/email).
5. **Derive recipients from the DB row**, never from the request body (resolve and reply/close actions).
6. **Race safety in the DB, not the app:** advisory-lock trigger for the 3-open-thread cap; `WHERE status='open'` compare-and-swap on close; `last_message_at` maintained by trigger.
7. **Rate limit server-side** (client cooldowns are UX only): 3 threads/hour, 10 messages/minute, Redis-backed with an in-memory fallback and no fail-open.
8. **Customer text is validated** (length + reject `<>&`/script patterns); admin-authored text may allow `<>&` but still blocks script injection. Cap `resolution_notes` at 2000 chars before it hits an HTML email.
9. **`waitUntil()` around post-response work** (emails/push/notifications). A bare un-awaited promise is dropped by serverless teardown.
10. **Notification failures never fail the request.** Wrap each in try/catch and log.
11. **Column-level REVOKE does nothing if a table-level GRANT exists.** Verify with `has_table_privilege(role, table, 'SELECT')`.
12. **Don't ship admin-only columns to the browser.** Select explicit columns on the user side.

---

## 7. Suggested build order

1. Migration (§2) → verify grants/RLS with a test user (can SELECT own rows, cannot INSERT/UPDATE except receipt columns).
2. `lib/support-validation.ts` (zod), `lib/support-rate-limit.ts`, `lib/support-ticks.ts`, `lib/admin-presence.ts`, `lib/order-supplier.ts` (pure, **write unit tests for the resolver precedence rules**).
3. User routes (§3.1), then admin routes (§3.2), then the cron.
4. Notifications + push + admin email helper.
5. User page, order-row entry points, admin console (Threads tab first, then Legacy).
6. Pure-logic tests (schema, ticks, resolver, rate limit) + manual browser pass: two browsers (user & admin), file → reply → read ticks → close → try replying to closed thread (expect 409) → file 4 threads (expect the 4th to be refused).

## 8. Things to adapt to your platform
- Phone regex and `wa.me` normalisation (Ghana `0XXXXXXXXX` / `+233`).
- Supplier list and `SUPPLIER_META` labels/colours: use **your own** suppliers.
- Order table/column names, `notifications` table shape, push service, email provider.
- Retention (30 d legacy / 90 d closed threads) and caps (3 open, 3/hour, 10/min).
