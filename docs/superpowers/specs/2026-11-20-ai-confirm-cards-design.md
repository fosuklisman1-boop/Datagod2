# AI Confirm Cards (Phase 1 of the AI assistant upgrade) — Design

Date: 2026-11-20 · Status: draft for approval

## 1. Intent

Today the web AI chat moves money and changes accounts as soon as the model
*decides* the user said "yes". A prompt-injected or confused model can call
`place_wallet_order` or an admin write tool with no human act in between.

Phase 1 makes it structurally impossible for the AI to spend money or perform a
sensitive admin action. The AI may only **prepare a draft**. The action happens
only when the signed-in user taps **Confirm** on a card, and that tap is checked
on the server (owner, expiry, single use, fresh price) before it is handed to the
**same endpoint the normal UI already uses**.

Origin: a friend's AI-assistant design doc ("draft-card pattern"), compared
against our code on 2026-11-20. This is item 1 of 5 phases. Phase 2 (tool
registry + invariant tests, data-fencing tool results, DB re-read of role on
every message) is separate.

## 2. Goals

1. The dealer-dashboard chat can no longer place a wallet order without the
   user's own tap on a card.
2. In the admin chat, five tools become card-only: `adjust_wallet_balance`,
   `manage_withdrawal` (approve/reject/complete), `suspend_user`,
   `update_user_role`, `bulk_update_order_status`.
3. One tap can never become two orders or two actions: double taps, retries,
   refreshes and second tabs all resolve to the first outcome.
4. Every outcome is a distinct card state the user can see.
5. Scheduled ("every Monday") orders keep working, but only through an approval
   the user tapped once at setup. Background runs never let the AI order.
6. Every draft the AI proposed and what happened to it is recorded.

## 3. Non-goals

- WhatsApp bot, WhatsApp shop bot, USSD, storefront: unchanged.
  `place_whatsapp_order` / `place_shop_order` already stage a confirm menu the
  customer must answer (1/2/0); storefront `prepare_checkout` already opens the
  normal checkout form.
- Remaining admin write tools (blacklist, toggles, manual fulfill, provider
  switch, packages, shops, scheduled-task admin, notifications) stay as they
  are. They move behind cards in a later batch using this same system.
- No rate/usage caps, credits, prompt caching, knowledge-base changes or new
  admin console (later phases or excluded).
- No new pricing logic: prices come from the same sources the purchase endpoint
  already uses.

## 4. Anti-goals (failure even if it "works")

- Any path where model output alone — text or tool call — creates an order,
  moves a balance, or changes a role, suspension or withdrawal.
- A new route that itself moves money. The confirm route only checks a draft
  and hands it to an existing endpoint.
- The card saying "done" when the server didn't confirm it, or the AI's text
  claiming an order was placed.
- Breaking existing scheduled orders silently. Owners must be told if their
  task stops ordering.
- Trusting the browser for price, owner, expiry or single use.

## 5. Constraints

- Money/auth/schema change: fresh reviewer, failing tests first, and the
  production change process (precheck → self-rolling-back dry run → owner OK →
  apply → verify → build → push → live check) for the migration and deploy.
- Logic lives in `lib/` (pure, unit-tested); routes stay thin.
- RLS: new tables are service-role only (`REVOKE ALL FROM anon, authenticated`,
  RLS on, no policies). Migration 0060 grants `authenticated` CRUD on all
  tables, so a missing revoke is a leak.
- PII-free logs (no phone numbers in console output).
- `/api/orders/purchase` is live money code (`deduct_wallet` RPC, then order
  insert, with a refund on insert failure). Changes there must be minimal and
  additive.
- Run `next build` with placeholder env before pushing main.

## 6. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | Card carries the full order; Confirm calls the existing endpoint straight from the browser with a key | Smallest change, but single use, expiry and "already placed" live only in the browser. A refresh, second tab or crafted request can replay. No server record of what the AI proposed; nothing for a scheduled approval to point at. |
| **B (chosen)** | **Draft saved server-side in `ai_drafts`; card holds only the draft id; one thin confirm route checks it and hands off to the existing endpoint** | One table, one migration, one small route. Single use, expiry, owner and fresh price are server facts. Full audit. Scheduled approval = an approved draft with a price cap. |
| C | Signed (HMAC) card, no storage | Stops tampering but still can't enforce single use or expiry without storage. Collapses into B. |

The owner picked **B**.

## 7. Design

### 7.1 Data (new migration)

**`ai_drafts`**

| column | type | notes |
|---|---|---|
| id | uuid pk default gen_random_uuid() | Card reference **and** idempotency key |
| user_id | uuid not null → users.id | Owner. Only this user can confirm. |
| context | text not null | `dashboard` \| `admin` |
| action | text not null | allowlisted enum (§7.2) |
| params | jsonb not null | server-resolved, schema-validated (never raw model input) |
| display | jsonb not null | exact strings the card shows |
| amount_ghs | numeric(12,2) | money the action moves; null for non-money admin actions |
| status | text not null default 'pending' | `pending` → `executing` → `succeeded` \| `partial` \| `failed` \| `unknown`; or `pending` → `expired` \| `superseded` \| `cancelled` |
| outcome | jsonb | result shown on the card (order_code, new_balance, error code, message) |
| expires_at | timestamptz not null | created_at + 10 min (customer) / 5 min (admin) |
| conversation_key | text | groups drafts per chat, so a new draft supersedes older pending ones |
| created_at, updated_at, executed_at | timestamptz | |

Indexes: `(user_id, status, created_at desc)`; `(user_id, conversation_key)`.
RLS on, no policies, `REVOKE ALL FROM anon, authenticated`.

**`orders`**: add nullable `idempotency_key uuid` with a unique partial index
(`WHERE idempotency_key IS NOT NULL`). This is the second wall behind the draft
claim (§7.4).

**`ai_scheduled_tasks`**: add `standing_order jsonb` (package_id, network,
size, recipient, max_price_ghs) and `approved_draft_id uuid` → ai_drafts.id.

### 7.2 Draft tools replace direct tools

The model never receives `place_wallet_order` or the five admin write tools in
`dashboard` / `admin` contexts. Instead:

| Context | Draft tool | Resolves server-side | On confirm calls |
|---|---|---|---|
| dashboard | `prepare_wallet_order` (network, size, phone, optional `schedule`) | package by network+size+is_available; the price the purchase route would charge; wallet balance; network-prefix check; duplicate check | `POST /api/orders/purchase` |
| admin | `prepare_wallet_adjustment` | target user exists; current balance; balance after ≥ 0 | `/api/admin/update-balance` |
| admin | `prepare_withdrawal_action` (action + one or many ids) | each withdrawal exists and its state allows the action; frozen id list; count; **total GHS**; first 5 requesters; total cap | `/api/admin/withdrawals/{approve\|reject\|complete}`, per id |
| admin | `prepare_user_suspension` | target exists; current state; not self | `/api/admin/users/suspend` |
| admin | `prepare_role_change` | target exists; current role; new role valid; not removing the last admin | `/api/admin/users/update-role` |
| admin | `prepare_bulk_status_update` | resolves the **exact id list** now with the **exact same filters as today** (incl. the forced `payment_status = completed` guard on shop/ussd tables); count **per table**; sample of 5; refuses above 500 ids ("use the admin orders page") | `/api/admin/orders/bulk-update-status` with the ids still matching at confirm (§7.4 step 6) |

Each draft tool:
1. Re-derives everything from the DB. It never trusts model-supplied ids,
   prices or balances.
2. Validates `params` against a strict schema that rejects unknown keys, with
   bounds: positive amounts, a per-action max draftable amount, balance after
   ≥ 0, and price inside the package's sane range.
3. Marks older `pending` drafts in the same `conversation_key` as `superseded`.
4. Inserts the `ai_drafts` row and returns
   `{ draft_id, display, expires_at, warnings[] }` to the model, plus a
   `draft_card` event to the widget (same mechanism as `action_buttons` in
   `lib/ai-agentic-loop.ts`).
5. Returns a refusal (not a draft) when it can't draft: unknown package,
   insufficient balance, over the cap ("use the normal checkout"), invalid
   target.

**Pricing (builder-check call, revised against origin/main):** main's purchase
route already prices through shared helpers (`getCustomPrices` +
`roleBasePrices(…, { admin: "as_user" })` + `priceWith`, which refuse on read
errors). That three-call block is wrapped *unchanged* as
`walletOrderPrice(db, userId, role, pkg)` in `lib/pricing/wallet-order-price.ts`.
The existing `route.role-pricing.test.ts` must stay green, and both the purchase
route and `prepare_wallet_order` call the wrapper, so draft and charge can't
drift. The
dashboard chat serves user, dealer, sub_agent and custom roles, and all of them
get cards. The shop and home widgets never get `prepare_wallet_order`.

**Withdrawals in bulk (owner):** one card can cover many withdrawals. It shows
count, total GHS and the first 5 names, capped at a total (builder sets it,
e.g. GHS 10,000). At confirm, each id is re-checked as still in the right state
and then processed one by one. The outcome stores a per-id result, and the card
shows e.g. "11 paid · 1 failed (reason)". Status is `succeeded` if all
succeeded, `partial` if some did, `failed` if none did. `partial` is a terminal
state with its own card display.

`prepare_wallet_order` adds a **duplicate warning**: same user + same package +
same recipient with a non-failed order in the last 10 minutes →
`warnings: ["duplicate_recent"]`. The card shows "You ordered this for 024… 3
min ago. Order again?" It warns, not blocks.

New prompt rule (dashboard + admin): "You cannot place orders or perform these
actions. Call the prepare_* tool; a card appears; tell the user to tap Confirm
on the card. Never say an action was done. The card reports the result."

### 7.3 Card UI (dashboard + admin widgets)

New `components/ai/DraftCard.tsx`, used by `components/dashboard/AIChatWidget.tsx`
and `components/admin/AdminAIChatWidget.tsx`. Navy accent, mobile-first, `lg:`
widening per our UI conventions.

```
┌──────────────────────────────────────┐
│ Confirm data order                   │
│ MTN 5GB  →  024 *** 4567             │
│ Price      GHS 23.50                 │
│ Balance    GHS 120.00 → GHS 96.50    │
│ ⚠ You ordered this 3 min ago        │
│ Expires in 9:41                      │
│ [ Confirm ]           [ Cancel ]     │
└──────────────────────────────────────┘
```

States (each is the server's answer, never a client guess):

| state | shown |
|---|---|
| pending | details + countdown + Confirm/Cancel |
| confirming | spinner, buttons disabled |
| succeeded | ✓ + order code / result + new balance |
| already_done | same as succeeded ("already placed") — replay of a used draft |
| insufficient_balance | message + "Top up" link |
| price_changed | old → new price + "Prepare again" |
| rejected | reason from the endpoint (blocked number, prefix mismatch, …) |
| expired | greyed + "Prepare again" |
| superseded | greyed: "Replaced by a newer card" |
| cancelled | greyed |
| unknown | "We couldn't confirm the result." + "Check again" (safe, §7.4 step 9) |

On mount and reload the card fetches `GET /api/ai/drafts/[id]` (owner only) and
renders the stored status. A used card never offers Confirm again.

**Outcome feedback to the model (builder-check call): the server injects it,
never the client.** On each chat request, the chat route loads this user's
drafts for the `conversation_key` that reached a terminal state since the last
turn, and appends a server-built note (`[card <id>: succeeded, order ORD-…]`) to
the model's context. Any client-sent text that looks like a card note is
stripped. The model can only learn outcomes from the draft rows.

### 7.4 Confirm route: `POST /api/ai/drafts/[id]/confirm`

Thin route; logic in `lib/ai-drafts/confirm.ts`.

1. Auth: verified session (Bearer JWT → `auth.getUser`). Admin actions also
   need `verifyAdminAccess`, re-read from the DB.
2. Load the draft; `draft.user_id` must equal the caller (else 404).
3. Status already terminal → return the stored outcome (`already_done` /
   stored state). This makes repeat taps safe.
4. `expires_at < now` → set `expired`, return.
5. **Atomic claim:** `UPDATE ai_drafts SET status='executing' WHERE id=$1 AND
   status='pending' RETURNING *`. Zero rows → re-read and return current state.
6. Fresh re-validation: re-price the package / re-check withdrawal state /
   balance. Price differs → `failed` with `price_changed` (old/new in outcome).
   Bulk status: re-read each id's **current** status and keep only ids that
   still match the draft's filter. Ids that moved on (e.g. now `completed`,
   which is terminal on shop_orders) are skipped, never overwritten. The
   outcome reports "applied N, skipped M (changed since card)".
7. Call the existing endpoint **with the caller's own JWT**, passing the draft
   id as `idempotencyKey` for purchase.
8. Map the response to `succeeded` / `failed{code}` and store the outcome.
   Network error / timeout → `unknown`.
9. `unknown` → "Check again": for purchases, look up `orders.idempotency_key =
   draft.id`; found → `succeeded`, not found → `failed` (debit and order insert
   are paired in the route, and an insert failure refunds). For wallet
   adjustments, re-read the balance: equal to the card's "after" → `succeeded`;
   equal to the card's "before" → not applied, and Confirm is safe to retry
   (below); anything else → stays `unknown` with "Check the user's wallet
   history" (no retry offered). For suspend/role/withdrawal/bulk status,
   re-read the target state (these are set-to-value actions, so comparing is
   reliable).

`POST /api/ai/drafts/[id]/cancel`: `pending` → `cancelled` (owner only).

**Purchase endpoint change (minimal, additive):** accept optional
`idempotencyKey` (uuid). If present, then **before** `deduct_wallet`, look up
`orders` by that key; if found, return that order with `alreadyPlaced: true`
and no charge. Store the key on insert. A concurrent duplicate that slips past
both the draft claim and the pre-check hits the unique index on insert, and the
existing refund-on-insert-failure path returns the money. Calls without the key
behave exactly as today.

**Refund-branch fix (builder-check call):** the existing refund-on-insert-failure
branch writes back an absolute `balance: balanceBefore`. A concurrent debit in
that window would be wiped. Since this design relies on that branch as the
second wall, it changes to a new atomic RPC
`revert_wallet_deduction(p_user_id, p_amount)` (`balance += amount`,
`total_spent -= amount`, one UPDATE, service_role only), in the same migration.
This is a latent bug fix; it gets its own test and is in reviewer scope.

**Wallet adjustments need no endpoint change (revised against origin/main):**
main's `/api/admin/update-balance` runs the atomic `admin_wallet_adjust` RPC and
accepts `expectedBalance`, refusing with `BALANCE_CHANGED` when the locked
balance differs. The dispatcher always sends the draft's "before" balance as
`expectedBalance`, plus the required `reason` (5–500 chars, captured in the
draft). A replay after success can then never apply twice. All admin endpoints
are unchanged; on the AI path, the draft claim (step 5) is also their
single-use guarantee.

### 7.5 Scheduled orders: approve once at setup

- `prepare_wallet_order` accepts an optional `schedule` (type/time/days). The
  card reads "Order MTN 5GB for 024… every Monday 08:00 — up to GHS 23.50 each
  time". Confirming creates the `ai_scheduled_tasks` row with `standing_order`
  + `approved_draft_id`. The task row is written by the confirm dispatcher, not
  the model.
- `max_price_ghs` = the draft's price at approval, with no buffer. Any price
  rise skips the run.
- `run-ai-tasks` cron: a task with `standing_order` runs **deterministically,
  without the model**. It re-prices. If the price is above `max_price_ghs`, the
  package is unavailable or the balance is too low, it skips and notifies the
  owner with the reason. Otherwise it calls purchase via the existing
  CRON_SECRET path with `idempotencyKey = uuid_v5(ns, task.id + ':' +
  scheduled next_run_at ISO)`, where `ns` is a fixed namespace constant in
  code. That is one key per scheduled slot, so a cron double-fire can't
  double-order. It then notifies through `notify_channels`.
- Standing orders allow `once`, `daily` and `weekly`; **`hourly` is refused**
  (builder-check call: hourly data purchases are almost certainly a mistake).
- A skipped run (price above cap, package unavailable, low balance) sends an
  **info push only, not the failure SMS**. It advances `next_run_at`
  normally with no same-day retry. Three consecutive skips pause the task
  and notify the owner.
- Background AI runs (prompt-only tasks) get no ordering tool at all,
  `prepare_wallet_order` included (nobody is there to tap).
- **Existing prompt-based ordering tasks (owner):** on deploy, a one-off script
  pauses every active dashboard task whose prompt the old tool set used for
  ordering. It identifies them from `ai_scheduled_tasks` run history showing
  `place_wallet_order` calls where logged, else by a reviewed keyword list
  (buy/order/send + GB/data). Each owner gets a notification, "Your scheduled
  order is paused — tap to re-approve", whose link opens the dashboard chat
  with a prepared card. Nothing orders until they tap. The list of paused tasks
  is shown to the owner before the script runs.

### 7.7 Admin background tasks: report, then tap (owner)

- The cron's admin tool set loses the five write tools, like the chat. Admin
  background tasks can still read (`get_all_orders`, `list_withdrawals`, …) and
  may call the prepare_* tools. Drafts created by a background run get
  `expires_at` = 12 h and are delivered as a **push notification with a link
  to the confirm card** in the admin chat. Nothing executes without the
  admin's tap.
- Existing admin tasks whose prompts used those tools keep running unchanged
  in wording. They now end in "here's a card to confirm" instead of acting.
  The admin is notified once on deploy that this behaviour changed.
- `schedule_task` / `manage_scheduled_task` (task creation): the tool
  descriptions and prompt say that tasks cannot order or act on their own. A
  recurring order must go through `prepare_wallet_order` with `schedule`.
  There is no hard prompt filter; the structural guarantee is that the cron
  has no tool that acts.

### 7.6 Removing the old tools

- `place_wallet_order` and the five admin write tools are removed from
  `aiTools("dashboard")` / `aiTools("admin")`. Their endpoint calls move into
  `lib/ai-drafts/execute.ts` (one function per action), so the AI path calls
  each endpoint from exactly one place.
- A unit test asserts that `place_wallet_order`, `adjust_wallet_balance`,
  `manage_withdrawal`, `suspend_user`, `update_user_role` and
  `bulk_update_order_status` never appear in any `aiTools(...)` list for
  `dashboard`, `admin`, or the cron's tool set. This starts the Phase-2
  registry tests early.

## 8. Testing (TDD, failing first)

- `lib/ai-drafts/*`: schema rejects unknown keys and out-of-bounds amounts;
  owner check; expiry; claim race (two confirms → one executes, one gets
  `already_done`); price-changed; supersede; duplicate-warning window;
  unknown → reconcile by idempotency key.
- Purchase route: same key twice → one debit, second returns `alreadyPlaced`;
  no key → unchanged (existing tests stay green); refund branch credits
  atomically (a concurrent debit survives).
- Pricing wrapper: existing `route.role-pricing.test.ts` stays green; the
  draft price equals the purchase price for user, dealer, sub_agent and a
  custom-price user.
- Wallet adjust: a confirm replay after success gets `BALANCE_CHANGED` and
  the card shows `already_done`, never a second change.
- Withdrawals bulk: partial failure → `partial` with per-id results; an id
  no longer pending at confirm is skipped.
- Bulk status: an id that changed state since the draft is skipped, not
  overwritten.
- Chat route: client-sent fake card notes are stripped; the server note
  reflects the draft row.
- Cron: standing order above `max_price` → skipped + notify; double-fire on
  the same day → one order; prompt-only task has no ordering tool.
- Tool lists: forbidden names absent.
- PGlite SQL test for the migration (tables, unique index, revoke, RLS).
- Unique test phone numbers per test.

## 9. Decisions log

Owner decided (2026-11-20):
- Approach B (server-stored drafts).
- Scheduled orders: approve once at setup with a price cap.
- Admin Phase-1 scope: wallet adjust, withdrawals, suspend, role change, bulk
  status.
- Admin background tasks: report + push a confirm card; never act.
- Withdrawals: one card may cover many, with per-item results.
- Existing prompt-based scheduled orders: pause + notify to re-approve.

Builder-check calls (made by Claude; owner may override): main's existing
pricing helpers wrapped unchanged; bulk status re-checks each id at confirm and
caps at 500; filters preserved exactly with a per-table count; refund branch →
atomic `revert_wallet_deduction` RPC; wallet adjust uses main's existing
`expectedBalance` guard (no endpoint change); standing
order key per scheduled slot; hourly standing orders refused; skips = info push
+ advance, pause after 3; outcome notes injected server-side only.

## 10. Left to the builder

Exact expiry durations; per-action max draftable amounts (suggest dashboard
order ≤ GHS 500, admin wallet adjust ≤ GHS 2,000, larger → "use the normal
page"); migration number; card styling details; the format of the system note
fed back to the model.
