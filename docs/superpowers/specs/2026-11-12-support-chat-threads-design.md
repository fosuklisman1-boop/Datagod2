# Support chat threads (complaints rebuild, piece 1 of 2)

Date: 2026-11-12
Status: awaiting owner approval
Source: the owner's "Complaints & Support System rebuild" build prompt (pasted in the session of 2026-11-12). That prompt is the base specification. This document records only where Datagod differs from it, the decisions the owner made, and the calls made on their behalf. Where this document is silent, the prompt applies as written.

## Intent

Website complaints today are a one-shot form: the customer must upload a balance screenshot, the admin resolves the row with a note, and there is no conversation. The owner wants a chat: a customer or shop owner opens a thread (usually from an order), an admin sees the thread with the order and supplier attached, they talk, and the admin closes it.

The second piece, built right after this one, puts an AI first responder inside the same threads: the AI answers first and an admin takes over. The owner wants to be able to "train" it. This piece must leave the database ready for that so piece 2 needs no reshaping.

## Decisions the owner made

1. The WhatsApp bot's complaints (`whatsapp_complaints`, claim and resolve from WhatsApp, the inbox resolve button) are not touched.
2. The AI answers first and an admin takes over. Delivered as a separate build after this one.
3. Shop owners file chat threads too, linked to their shop order. They do not use the old single-shot complaint.
4. Cleanup deletes old-style complaints only when they are resolved or rejected and 90 days old. Open ones are never deleted.
5. The customer can attach one optional screenshot when filing. It never blocks filing.

## Goals

- Chat threads for customers and shop owners, as the prompt describes: file, live replies, ticks, presence badge, close.
- Admin console at `/admin/complaints` with Threads and Legacy tabs, order details and supplier badge.
- Every create path checks that the caller owns the linked order. Today's route does not.
- Existing complaints (1,341 rows, 56 still pending) stay readable and resolvable in the Legacy tab, with their photos.

## Non-goals

- The AI responder itself (piece 2).
- Any change to WhatsApp bot complaints or the WhatsApp inbox.
- Photos sent as chat messages. Only the one optional screenshot at filing is supported (see "Optional screenshot when filing").
- Migrating old complaints into threads.
- `results_checker_complaints` and `bundle_orders`: neither table exists here.
- The mobile app. It only links to `/dashboard/complaints` on the web.

## Anti-goals

- A customer or shop owner able to open a thread against someone else's order, or read anyone else's thread.
- An open complaint disappearing: aging out of the admin list or being deleted by the cleanup.
- Support tables writable from the browser beyond the two receipt columns.
- The AI slot changing behaviour in this piece. Nothing writes `ai` rows yet.

## Where Datagod differs from the prompt

### Orders

The prompt assumes one `orders` table with `reference_code`, `fulfillment_method`, `download_batch_id`, `shop_name` and a mirrored row for every shop order. Datagod has none of that:

| Prompt | Datagod |
|---|---|
| `orders.reference_code` | `orders.order_code` (also `transaction_code`) |
| shop orders mirrored into `orders` | shop orders live only in `shop_orders` (`reference_code`, `customer_phone`, `volume_gb`, `total_price`, `order_status`) |
| `orders.fulfillment_method` = supplier | not on `orders`; on `shop_orders` it is a dispatch mode (`auto_mtn`, `auto_codecraft`, `manual`), never a supplier |
| `download_batch_id` on the order | exports are recorded in `order_download_batches` |
| tracking `api_response.supplier` | `mtn_fulfillment_tracking.provider`, keyed by `order_id` or `shop_order_id` |

So `support_threads` gets two nullable links, at most one set (CHECK constraint):

- `order_id uuid REFERENCES orders(id) ON DELETE SET NULL`
- `shop_order_id uuid REFERENCES shop_orders(id) ON DELETE SET NULL` (this takes the prompt's "second order table" slot)

Ownership checks, both done server-side with an explicit filter:

- `order_id`: `orders.user_id = caller`.
- `shop_order_id`: the order's `shop_id` is a `user_shops` row with `user_id = caller`. A parent shop cannot file on a sub-agent's order (builder's call).
- Either failing returns 404, and nothing about the order is echoed.

The admin thread and list routes return one normalised `order` object regardless of source: `{ source: 'order' | 'shop_order', reference, beneficiary, network, size, price, status, created_at, shop_name? }`. `shop_name` comes from `user_shops` for shop orders.

### Supplier resolution

`lib/order-supplier.ts` stays a pure function with unit tests, but the rules change because there is no supplier column on the order:

1. Latest tracking row (by `created_at`, unparseable dates sort oldest) whose `provider` is a known supplier wins. Tracking is insert-only, so never take the first row.
2. Qualify it by order status: on `processing`, `completed`, `refunded` or `reversed` it is the supplier that took the order; on `pending` or `failed` the badge reads "Last tried: X".
3. No tracking row and a shop order with `fulfillment_method = 'manual'`: "Manual". (The prompt's `exported` tag is dropped: `order_download_batches` holds only 4 rows, so it is not a usable signal.)
4. Otherwise `null`, rendered "N/A". Unknown provider strings also give `null`.
5. `auto_mtn`, `auto_codecraft`, `manual`, `auto` are dispatch modes and never suppliers.

Known suppliers seen in the last 60 days: agentportalgh, bundleportal, sykes, kuntanii, apexprime, datakazina, spfastit, spfastit_telecel, eazyghdata, bisdel. The builder should take the full list from the provider registry in `lib/mtn-providers/` rather than this snapshot, and confirm how an order's membership in an export batch is looked up (see `app/api/admin/orders/download/route.ts`).

### Auth

Datagod API routes authenticate with `Authorization: Bearer <token>` and `supabase.auth.getUser(token)` on the service client, not cookies. User routes follow that; every read then filters by the caller's id explicitly. Admin routes call `verifyAdminAccess(request)` from `lib/admin-auth.ts` in the handler. Note that helper also passes a `CRON_SECRET` bearer with no `userId`: the support admin routes must reject a call with no `userId`, since replies, closes and presence need a real admin.

The browser still reads its own threads and messages directly through the RLS client and Realtime, as the prompt says.

### Rate limiting

`applyRateLimit` in `lib/rate-limiter.ts` fails open when Upstash is missing or down and reports `degraded: true`. `lib/support-rate-limit.ts` wraps it: when the result is degraded it applies an in-memory sliding window with the same limits, so it never fails open. Limits as the prompt: 3 new threads per hour, 10 messages per minute, per user. These replace today's 5 per day.

### Post-response work

Use `after()` from `next/server`, which this repo already uses, in place of `waitUntil`. Follow the existing guard for unit tests where `after()` throws outside a request scope (see `app/api/ussd-hubtel/interaction/route.ts`).

### Notifications

- `notifications.type` has no CHECK constraint, so no constraint migration. Add `support_reply` to the `NotificationType` union in `lib/notification-service.ts`.
- Admin alert on a new thread goes through the existing `alertAdminsOfRequest("complaint", …)` in `lib/admin-actions/` (email + push). It must not include another user's order reference; since ownership is checked first, the linked reference is always the caller's own.
- Legacy resolve keeps using `notifyUserOfOutcome("complaint", …)`.

### Cron

`GET /api/cron/delete-old-complaints`, authorised with `verifyCronAuth`. Daily. It deletes:

- `support_threads` with `status = 'closed'` and `closed_at` older than 90 days (messages cascade);
- `complaints` with `status IN ('resolved','rejected')` and `updated_at` older than 90 days, after removing their files from the private `complaint-evidence` bucket (paths are in `evidence.balance_image_path` and `evidence.momo_receipt_path`).

Open threads and pending complaints are never deleted. Deletes are chunked (a few hundred ids at a time). The job must be registered on cron-job.org via `scripts/sync-cronjob-org.ts`; a `crons.json` entry alone schedules nothing.

The first run removes a large backlog of resolved complaints. Before it is scheduled, the builder reports the exact count to the owner and waits for a go-ahead.

### Optional screenshot when filing

The owner's decision is "one optional screenshot at filing"; the mechanics below are the builder's calls.

- `POST /api/support/threads` accepts either JSON or `multipart/form-data` with the same fields plus an optional `image` file.
- Accepted: JPEG, PNG, WebP, at most 4 MB (Vercel caps request bodies at 4.5 MB). Check the declared type and the file's leading bytes; derive the stored extension from the detected type, never from the uploaded file name.
- Stored in the existing private `complaint-evidence` bucket at `threads/<user_id>/<thread_id>/<random uuid>.<ext>`, uploaded by the service client after the thread and first message exist. The path goes in a new nullable column `support_messages.attachment_path` on the first message.
- An upload failure never fails the complaint: the thread is kept and the response says the screenshot was not saved.
- The browser never gets a storage path it can use directly. `GET /api/support/threads/[id]/attachment` (caller must own the thread) and the admin thread `GET` return a signed URL valid for 10 minutes.
- The filing dialogs show an "Add a screenshot (optional)" picker. The chat shows the image in the first bubble for both sides.
- The cleanup cron removes these files along with their closed threads.

## Database

The prompt's SQL, with these changes:

- `support_messages.attachment_path text` (nullable), as described under "Optional screenshot when filing".

- `support_threads`: add `shop_order_id` as above and the at-most-one CHECK; index on it where not null.
- `support_messages.sender_role CHECK (sender_role IN ('user','admin','ai'))`. Nothing writes `ai` in this piece.
- `support_threads.handler text NOT NULL DEFAULT 'human' CHECK (handler IN ('ai','human'))` and `needs_human_at timestamptz`. Unused in this piece; they are the AI slot so piece 2 can say who currently owns a thread.
- Receipts: an `ai` message counts as the support side, so `getCounterpartReceipt` treats `ai` like `admin`.
- `complaints` already exists and is not recreated. Its real shape differs from the prompt (`order_id` nullable, `order_details jsonb`, `category`, 71 shop rows with no `order_id`). The migration only drops the "Users can insert own complaints" policy and revokes INSERT/UPDATE/DELETE from `anon` and `authenticated`. (`authenticated` holds only SELECT today, so the policy is inert, but it goes.)
- Realtime: add both support tables to `supabase_realtime` (it currently carries only `security_alerts`).
- `uuid_generate_v4()` is available.

Migration file: next number after 0160, in the same place and style as 0160. Applied to production under the owner's usual protocol: precheck counts, self-rolling-back dry run, owner OK, apply, verify. After applying, verify with a real test user that own rows are readable, others' are not, and INSERT/UPDATE is refused except the two receipt columns (`has_table_privilege` and `has_column_privilege`).

## Server routes

As the prompt, section 3, with the adaptations above. Specifics:

- `POST /api/support/threads` accepts optional `order_id` or `shop_order_id` (never both).
- `POST /api/support/threads/[id]/messages`, `GET /api/support/presence`: as written.
- Admin: `GET /api/admin/support/threads`, `GET` and `POST /api/admin/support/threads/[id]`, `GET /api/admin/support/counts`, `GET /api/admin/complaints`, `POST /api/admin/complaints/resolve`: as written, returning the normalised order object and the supplier tag.
- Legacy list: rows without `order_id` show their order from `order_details` (network, package, phone, amount, date) and no supplier.
- Retired: `POST /api/complaints/create`, `PATCH /api/admin/complaints/update` (it accepts any status string; `resolve` replaces it) and `components/complaint-modal.tsx`. `lib/admin-actions/wiring.test.ts` asserts on the old create route and must be updated to the new thread route.
- Kept: `POST /api/admin/complaints/evidence-urls`, used by the Legacy detail dialog to show old photos.
- The prompt's legacy `POST /api/complaints/submit` is not built: nobody files old-style complaints any more.

## Screens

As the prompt, section 5, in the existing design system (navy primary, shadcn, light and dark), with desktop widening and multi-column layouts from the start.

- `/dashboard/complaints` becomes "Support & Complaints": two-pane threads and chat, New Complaint, contact hub from the existing support settings, presence badge, push prompt, and a collapsible "Past order complaints" listing the user's old rows read-only.
- My Orders: the "Complain" button opens a small dialog (description, phone, WhatsApp number) that creates a thread with `order_id`, subject "Issue with order <order_code>", category `order`. No photo upload.
- Shop owner order rows (the list in `app/dashboard/shop-dashboard/page.tsx` that uses the modal today; check `app/dashboard/shop-orders/page.tsx` for a second place): same dialog with `shop_order_id`. A row with an open thread shows "Complaint: open" in place of the button.
- `/admin/complaints`: Threads tab and Legacy tab as described. Legacy keeps Resolve/Reject for pending rows and the photo viewer. The admin home card ("Complaints … Issues") and any sidebar badge read from `/api/admin/support/counts` (`openThreads + legacyPending`).
- Nav label "My Complaints" becomes "Support & Complaints" (web nav and the mobile side menu label). It is a rename, not a new item, so no NEW tag.
- Suspended users must be able to reach `/dashboard/complaints` and the two user routes; the builder finds where suspension is enforced and makes the exception there.

## Rollout

No feature switch (builder's call): the migration is additive and can be applied first; the code deploy then swaps the screens. Old complaints remain visible throughout. Order: migration, libraries with tests, user routes, admin routes, screens, cron (scheduled last, after the owner's go-ahead on the first-run count).

## Testing

- Unit tests written first for: validation schema, tick helper, supplier resolver precedence, rate-limit fallback, order normalisation.
- Route tests with the repo's fake-client pattern for: ownership refusal on both order types, closed-thread 409, open-thread cap 409, concurrent close, admin route refusing a call with no `userId`.
- SQL tests for the cap trigger, grants and RLS (PGlite).
- Manual two-browser pass as in the prompt, section 7 step 6, once as a customer and once as a shop owner, plus a real `next build` before pushing.

## Left to the builder

- Exact supplier list, labels and badge colours (`SUPPLIER_META`).
- How export-batch membership is looked up.
- Component breakdown of the two pages.
- Where the suspended-user exception goes.

## For piece 2 (not built here)

The AI responder will reuse `lib/ai-agentic-loop.ts` and the admin AI Knowledge page as its "training" surface, write `sender_role = 'ai'` messages, and use `handler` / `needs_human_at` for the hand-over. It will only read (order status, knowledge base) and never move money or change orders. Those are assumptions to confirm when piece 2 is designed.
