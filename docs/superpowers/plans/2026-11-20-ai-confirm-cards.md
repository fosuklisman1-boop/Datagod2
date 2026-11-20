# AI Confirm Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The web AI chat (dashboard + admin) can only *prepare* money or account actions as server-stored drafts; the action runs only when the owner taps Confirm on a card, checked server-side and handed to the existing endpoint.

**Architecture:** New `ai_drafts` table (service-role only) holds every proposed action. `prepare_*` tools write drafts and emit a `draft_card` SSE event. `POST /api/ai/drafts/[id]/confirm` claims the draft atomically (`pending → executing`), re-validates, and calls the existing endpoint with the caller's JWT. Scheduled orders run from a stored `standing_order` without the model.

**Tech Stack:** Next.js 15 App Router, Supabase (Postgres + service-role client `supabaseAdmin`), TypeScript, zod 4, Vitest 4, PGlite for SQL selftests.

**Spec:** `docs/superpowers/specs/2026-11-20-ai-confirm-cards-design.md` (read it first; section refs below are to it).

## Global Constraints

- Base branch: **`origin/main`** (local `main` is behind). Work in a worktree on `feat/ai-confirm-cards`.
- No `sed`/shell edits of code — Edit/Write only (tell every subagent).
- Migration number **0188**; the file pair is `migrations/0188_ai_confirm_cards.sql` + `migrations/0188_ai_confirm_cards.selftest.sql`.
- New tables/functions: RLS on, no policies, `REVOKE ALL … FROM anon, authenticated` (functions also `FROM PUBLIC`), `GRANT EXECUTE … TO service_role`.
- Logs carry no phone numbers or emails.
- Draft expiry: dashboard **10 min**, admin **5 min**, admin drafts created by background tasks **12 h**.
- Caps: dashboard order ≤ **GHS 500**; admin wallet adjust ≤ **GHS 2,000**; withdrawal card total ≤ **GHS 10,000**; bulk status ≤ **500 ids**. Above → refusal "use the normal page".
- Duplicate-warning window: **10 minutes**, same user + package + recipient, order status not failed.
- Standing orders: schedule types `once|daily|weekly` only; `hourly` refused. Three consecutive skips → pause + notify.
- Forbidden in every `aiTools()` list for `dashboard`/`admin` and in the cron tool set: `place_wallet_order`, `adjust_wallet_balance`, `manage_withdrawal`, `suspend_user`, `update_user_role`, `bulk_update_order_status`.
- Unique test phone numbers per test.
- Before pushing main: `next build` with placeholder env; check origin/main for other sessions' commits.

## Review Focus

1. **Double tap / two tabs on one card:** exactly one execution; the other gets `already_done` → Task 6 test `confirm_race_one_executes`.
2. **Model claims success in text after a failed card:** the next turn's server note says failed → Task 8 test `server_note_reflects_failed_draft`.
3. **Price rises between card and tap:** `failed{price_changed}`, nothing charged → Task 6 test `price_changed_no_call`.
4. **Another user's draft id posted to confirm:** 404, no state change → Task 7 test `confirm_other_users_draft_404`.
5. **Cron fires twice in one slot for a standing order:** one order → Task 10 test `standing_order_double_fire_one_order`.

---

### Task 0: Worktree + carry the spec

- [ ] **Step 1:** Use superpowers:using-git-worktrees to create a worktree from `origin/main` on branch `feat/ai-confirm-cards`.
- [ ] **Step 2:** Copy `docs/superpowers/specs/2026-11-20-ai-confirm-cards-design.md` and this plan from the original working tree into the worktree.
- [ ] **Step 3:** `npx vitest run` — record the baseline failures (the known order-health ones) so later tasks compare against them.
- [ ] **Step 4:** Commit `docs: AI confirm cards spec + plan`.

### Task 1: Migration 0188

**Files:**
- Create: `migrations/0188_ai_confirm_cards.sql`, `migrations/0188_ai_confirm_cards.selftest.sql`

**Interfaces — Produces:**
- Table `public.ai_drafts` exactly as spec §7.1, plus status `partial`; CHECK on `status in ('pending','executing','succeeded','partial','failed','unknown','expired','superseded','cancelled')`; CHECK on `action in ('wallet_order','wallet_adjustment','withdrawal_action','user_suspension','role_change','bulk_status_update')`; CHECK on `context in ('dashboard','admin')`.
- `orders.idempotency_key uuid` + `CREATE UNIQUE INDEX orders_idempotency_key_uniq ON orders(idempotency_key) WHERE idempotency_key IS NOT NULL`.
- `ai_scheduled_tasks.standing_order jsonb`, `ai_scheduled_tasks.approved_draft_id uuid REFERENCES ai_drafts(id)`, `ai_scheduled_tasks.consecutive_skips int not null default 0`.
- `public.revert_wallet_deduction(p_user_id uuid, p_amount numeric) RETURNS numeric` (new balance): one `UPDATE wallets SET balance = balance + p_amount, total_spent = greatest(0, total_spent - p_amount), updated_at = now() WHERE user_id = p_user_id`; raises if `p_amount <= 0` or no row. `SECURITY DEFINER`, `SET search_path = public`.

- [ ] **Step 1: Write the selftest** (psql style, prints `AI_CONFIRM_CARDS_OK`): asserts the table exists with RLS on and `has_table_privilege('authenticated','public.ai_drafts','SELECT') = false` (also for `anon`); an invalid status/action insert fails; two orders with the same `idempotency_key` fail and two with NULL succeed; `revert_wallet_deduction` adds back exactly the amount after an interleaved sequence (balance 100 → deduct 20 → another deduct 10 → revert 20 → 90); `has_function_privilege('authenticated', 'public.revert_wallet_deduction(uuid,numeric)', 'EXECUTE') = false`.
- [ ] **Step 2:** Run it with the PGlite runner (memory: reference-pglite-sql-tests) against the stub tables it creates — expect FAIL (objects missing).
- [ ] **Step 3:** Write the migration.
- [ ] **Step 4:** Run the selftest — expect `AI_CONFIRM_CARDS_OK`.
- [ ] **Step 5:** Commit `feat(ai-drafts): 0188 drafts table, order idempotency key, revert_wallet_deduction`.

### Task 2: Draft schemas + repository

**Files:**
- Create: `lib/ai-drafts/types.ts`, `lib/ai-drafts/repo.ts`, `lib/ai-drafts/repo.test.ts`

**Interfaces — Produces:**
- `types.ts`: `DraftAction` union (the 6 actions); `DraftStatus` union; zod `.strict()` schemas `WalletOrderParams {packageId, network, size, recipient, price, balanceBefore, schedule?: {type:'once'|'daily'|'weekly', runAtTime?, runOnDays?, runAtTimestamp?}}`, `WalletAdjustmentParams {targetUserId, type:'credit'|'debit', amount, reason, balanceBefore}`, `WithdrawalActionParams {action:'approve'|'reject'|'complete', ids: string[], totalGhs, reason?}`, `UserSuspensionParams {targetUserId, suspend: boolean}`, `RoleChangeParams {targetUserId, fromRole, toRole}`, `BulkStatusParams {status, idsByTable: Record<'orders'|'shop_orders'|'ussd_orders'|'ussd_shop_orders'|'api_orders', string[]>, filter: Record<string, unknown>}`; `paramsSchemaFor(action)`; `CAPS` and `EXPIRY_MS` constants (values from Global Constraints); `AiDraft` row type; `DraftToolResult = { draft_id, display, expires_at, warnings: string[] } | { refused: true, code: string, message: string }`.
- `repo.ts` (all take `db: SupabaseClient` first):
  - `createDraft(db, input: {userId, context, action, params, display, amountGhs, conversationKey, expiresInMs}): Promise<AiDraft>` — validates params with `paramsSchemaFor`, supersedes older `pending` drafts with the same `(user_id, conversation_key)`, inserts.
  - `getOwnDraft(db, id, userId): Promise<AiDraft | null>`
  - `claimDraft(db, id, userId): Promise<AiDraft | null>` — `update … set status='executing' where id and user_id and status='pending' and expires_at > now() returning *`.
  - `finishDraft(db, id, status: DraftStatus, outcome: Record<string, unknown>): Promise<void>`
  - `expireIfDue(db, draft): Promise<AiDraft>`
  - `cancelDraft(db, id, userId): Promise<AiDraft | null>`
  - `terminalDraftsSince(db, userId, conversationKey, sinceIso): Promise<AiDraft[]>`

- [ ] **Step 1: Write failing tests** (fake-client pattern, memory: reference-testing): `rejects_unknown_param_keys`; `rejects_negative_amount`; `new_draft_supersedes_older_pending_same_conversation` (older row → `superseded`); `claim_only_from_pending` (second claim returns null); `claim_refuses_expired`; `cancel_only_owner_and_pending`.
- [ ] **Step 2:** `npx vitest run lib/ai-drafts/repo.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Implement `types.ts` and `repo.ts`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(ai-drafts): draft schemas and repository`.

### Task 3: Shared wallet-order price + purchase idempotency + refund fix

**Files:**
- Create: `lib/pricing/wallet-order-price.ts`, `lib/pricing/wallet-order-price.test.ts`
- Modify: `app/api/orders/purchase/route.ts` (price block ~L207-221; order insert ~L285; refund branch ~L304-319)
- Test: `app/api/orders/purchase/route.idempotency.test.ts` (new); existing `route.role-pricing.test.ts`, `route.block-context.test.ts` must stay green

**Interfaces — Produces:**
- `walletOrderPrice(db, userId: string, userRole: string, pkg: {id, size, price, dealer_price, is_available}): Promise<number>` — the existing `getCustomPrices` + `roleBasePrices(db, userRole, [pkg], { admin: "as_user" })` + `priceWith` block moved verbatim; throws the same `CustomPriceReadError` / `RoleReadError`.
- Purchase body accepts optional `idempotencyKey` (uuid, zod-validated; invalid → 400). Response gains `alreadyPlaced: true` on replay.

- [ ] **Step 1: Write failing tests:** `same_key_twice_one_debit` (second call: `alreadyPlaced: true`, `deduct_wallet` called once, same `order_code`); `no_key_unchanged` (no key lookup query, behaves as before); `invalid_key_400`; `insert_failure_reverts_atomically` (insert error → `rpc('revert_wallet_deduction', {p_user_id, p_amount: validatedPrice})`, and no `wallets.update({balance: …})` call); `wallet_order_price_matches_route` for user, dealer, sub_agent and a custom-price user.
- [ ] **Step 2:** Run those files — the new tests FAIL, existing ones PASS.
- [ ] **Step 3:** Add `walletOrderPrice` and switch the route to it (no behaviour change); add the key pre-check **before** `deduct_wallet` (`orders…eq('idempotency_key', key).maybeSingle()` → return the existing order); write `idempotency_key` on insert; replace the refund `update` with the RPC.
- [ ] **Step 4:** Run — all PASS.
- [ ] **Step 5:** Commit `feat(purchase): optional idempotency key; atomic refund on insert failure`.

### Task 4: `prepare_wallet_order` draft builder

**Files:**
- Create: `lib/ai-drafts/prepare-wallet-order.ts`, `lib/ai-drafts/prepare-wallet-order.test.ts`

**Interfaces:**
- Consumes: `createDraft`, `CAPS`, `EXPIRY_MS`, `DraftToolResult` (Task 2); `walletOrderPrice` (Task 3); existing `getPrefixValidationConfig` / `validateNetworkPrefix`.
- Produces: `prepareWalletOrder(db, ctx: {userId, userRole, conversationKey}, input: {network, size, phone_number, schedule?}): Promise<DraftToolResult>`. `display` keys: `title`, `lines: {label, value}[]`, `recipientMasked` (`024 *** 4567`), `priceGhs`, `balanceBefore`, `balanceAfter`, `scheduleText?`.

- [ ] **Step 1: Write failing tests:** `unknown_package_refused`; `insufficient_balance_refused` (code `insufficient_balance`); `over_cap_refused` (price > 500, code `over_cap`); `prefix_mismatch_refused`; `duplicate_recent_warns` (order 3 min ago → `warnings` contains `duplicate_recent`, draft still created); `old_order_no_warning` (11 min ago); `hourly_schedule_refused`; `price_from_walletOrderPrice` (a dealer gets the dealer price); `schedule_text_includes_cap` (contains `"up to GHS 23.50 each time"` for price 23.50).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(ai-drafts): prepare_wallet_order builder`.

### Task 5: Admin draft builders

**Files:**
- Create: `lib/ai-drafts/prepare-admin.ts`, `lib/ai-drafts/bulk-status-ids.ts`, `lib/ai-drafts/prepare-admin.test.ts`

**Interfaces — Produces** (all `(db, ctx: {adminId, conversationKey, background?: boolean}, input) => Promise<DraftToolResult>`; `background: true` → 12 h expiry):
- `prepareWalletAdjustment(input: {user_id, type, amount, reason})` — refuse self, amount > 2,000, reason not 5–500 chars, a debit below 0.
- `prepareWithdrawalAction(input: {action, withdrawal_ids: string[], reason?})` — every id exists and is in the state its route accepts (read the exact state names from `app/api/admin/withdrawals/{approve,reject,complete}/route.ts`); total ≤ 10,000; display shows count, total and the first 5 requester names.
- `prepareUserSuspension(input: {user_id, suspend: boolean})` — refuse self; refuse a no-op.
- `prepareRoleChange(input: {user_id, role})` — refuse self; refuse removing the last admin; validate the role the same way `/api/admin/users/update-role` does.
- `prepareBulkStatusUpdate(input: {status, filters})` — the id resolution moves out of today's `bulk_update_order_status` handler into `bulk-status-ids.ts` as `resolveBulkStatusIds(db, filters, status): Promise<BulkStatusParams['idsByTable']>`, unchanged (incl. the forced `payment_status = completed` on shop/ussd tables); > 500 ids refused; display has per-table counts + 5 samples.

- [ ] **Step 1: Write failing tests:** one refusal test per rule above, plus `withdrawal_display_totals` (3 ids → count 3, total = sum); `bulk_ids_frozen_with_payment_guard`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(ai-drafts): admin draft builders`.

### Task 6: Executor + confirm logic

**Files:**
- Create: `lib/ai-drafts/execute.ts`, `lib/ai-drafts/confirm.ts`, `lib/ai-drafts/confirm.test.ts`

**Interfaces:**
- Consumes: Task 2 repo; Task 3 `walletOrderPrice`; Task 5 `resolveBulkStatusIds`. Endpoint bodies on origin/main: purchase `{packageId, phoneNumber, network, idempotencyKey}`; update-balance `{userId, type, amount, reason, expectedBalance}`; withdrawals `{withdrawalId, reason?}` per id; suspend and update-role (read the body shape from each route); bulk-update-status `{orderIds, status, orderType}` per table.
- Produces:
  - `executeDraft(draft: AiDraft, call: {baseUrl, jwt}): Promise<{status: 'succeeded'|'partial'|'failed'|'unknown', outcome: Record<string, unknown>}>` — maps HTTP 402 → `failed{code:'insufficient_balance'}`, `alreadyPlaced` → `succeeded`, `BALANCE_CHANGED` → reconcile, fetch throw/timeout (15 s) → `unknown`.
  - `revalidateDraft(db, draft): Promise<{ok: true, draft: AiDraft} | {ok: false, status: 'failed', outcome}>` — re-price (`price_changed` with `{oldPrice, newPrice}`); withdrawal state per id (drop moved ids; all moved → failed); bulk ids re-read (keep only still-matching, record `skipped`).
  - `confirmDraft(db, id, caller: {userId, isAdmin, jwt, baseUrl}): Promise<CardState>` — spec §7.4 steps 2–8; `CardState = {status, outcome, display}`.
  - `recheckDraft(db, id, caller): Promise<CardState>` — spec §7.4 step 9, only for `unknown`.

- [ ] **Step 1: Write failing tests:** `confirm_race_one_executes` (two concurrent `confirmDraft` → executor called once; the other returns `already_done`); `terminal_returns_stored_outcome`; `expired_marks_expired_no_call`; `price_changed_no_call`; `admin_action_requires_isAdmin`; `withdrawal_partial` (1 of 3 calls fails → `partial`, per-id results); `bulk_skips_changed_ids`; `wallet_adjust_sends_expectedBalance_and_reason`; `wallet_adjust_replay_balance_changed_to_already_done` (balance equals after); `unknown_purchase_recheck_finds_order_by_key` → succeeded; `unknown_purchase_recheck_no_order` → failed; `unknown_adjust_ambiguous_balance_stays_unknown`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(ai-drafts): confirm, revalidate, execute`.

### Task 7: Draft routes

**Files:**
- Create: `app/api/ai/drafts/[id]/route.ts` (GET), `app/api/ai/drafts/[id]/confirm/route.ts`, `app/api/ai/drafts/[id]/recheck/route.ts`, `app/api/ai/drafts/[id]/cancel/route.ts` (all POST except GET), `app/api/ai/drafts/routes.test.ts`

**Interfaces:** Consumes Task 6. Auth: `Authorization: Bearer <jwt>` → `supabaseAdmin.auth.getUser`; `isAdmin` from a fresh `users.role` read (never JWT claims). Each returns `CardState` JSON. Confirm is rate-limited with the existing `applyRateLimit` (10/min per user).

- [ ] **Step 1: Write failing tests:** `confirm_other_users_draft_404`; `no_auth_401`; `get_returns_stored_state`; `cancel_pending_only`; `admin_draft_by_demoted_user_403`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement thin routes. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(ai-drafts): draft routes`.

### Task 8: Tools, prompts, loop event, server outcome notes

**Files:**
- Modify: `lib/ai-tools.ts` (tool defs; `aiTools()` dashboard/admin lists; `executeToolCall` cases; `ToolContext` gains `conversationKey?: string`, `background?: boolean`)
- Modify: `lib/ai-agentic-loop.ts` (emit `{type:'draft_card', draft_id, display, expires_at, warnings}` when a `prepare_*` result has `draft_id`, beside the existing `action_buttons` emit)
- Modify: `app/api/ai/chat/route.ts` (accept `conversationKey` — a client-generated uuid per chat session, validated; inject server notes; strip client notes; add the prompt rule)
- Test: `lib/ai-tools.confirm-cards.test.ts`, `app/api/ai/chat/route.outcome-notes.test.ts`

**Interfaces — Produces:** tools `prepare_wallet_order`, `prepare_wallet_adjustment`, `prepare_withdrawal_action`, `prepare_user_suspension`, `prepare_role_change`, `prepare_bulk_status_update`. The handlers and definitions of the 6 forbidden tools are deleted (their endpoint calls now live in `execute.ts`). Note format: `[card <draft_id>: <status>; <short outcome>]`, built only from `terminalDraftsSince`. Client message lines matching `/^\[card [0-9a-f-]{36}:/m` are stripped.

Prompt rule (dashboard + admin, verbatim): "You cannot place orders or change wallets, withdrawals, roles, suspensions or order statuses yourself. Call the matching prepare_* tool; a confirm card appears for the user. Tell them to tap Confirm on the card. Never say an action is done — only the card shows results. Card results arrive as [card …] notes."

Update the `schedule_task` and `manage_scheduled_task` descriptions to say (verbatim): "Scheduled tasks cannot place orders or perform admin actions on their own. For a recurring data order use prepare_wallet_order with schedule; admin tasks can only prepare cards for you to confirm."

Also remove/replace prompt lines that tell the model to call the removed tools (e.g. the admin bulk/withdrawal instructions and "After successfully placing an order, proactively suggest scheduling it" → suggest scheduling via `prepare_wallet_order` with `schedule`).

- [ ] **Step 1: Write failing tests:** `forbidden_tools_absent` (each of the 6 names absent from `aiTools('dashboard')` and `aiTools('admin')`); `prepare_tools_present`; `loop_emits_draft_card`; `server_note_reflects_failed_draft`; `client_fake_note_stripped`; `shop_and_home_have_no_prepare_wallet_order`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `lib/ai-tools.test.ts` stays green (update only assertions that named removed tools).
- [ ] **Step 5:** Commit `feat(ai): prepare_* tools replace direct money/admin tools`.

### Task 9: DraftCard UI

**Files:**
- Create: `components/ai/DraftCard.tsx`, `components/ai/DraftCard.test.tsx`
- Modify: `components/dashboard/AIChatWidget.tsx`, `components/admin/AdminAIChatWidget.tsx` (handle `draft_card` events next to `action_buttons`; keep cards in the message list; send `conversationKey`)

**Interfaces:** `<DraftCard draftId initial={{display, expires_at, warnings}} getToken={() => Promise<string>} />`. On mount → GET state. Renders the spec §7.3 states plus `partial` ("11 done · 1 failed" with an expandable per-item list). Navy `--primary`, mobile-first, `lg:` widening. Countdown from `expires_at`; at 0 → expired view.

- [ ] **Step 1: Write failing tests** (React Testing Library): `pending_shows_confirm`; `confirm_disables_buttons_while_request_in_flight`; `succeeded_hides_confirm_after_reload`; `unknown_shows_check_again`; `superseded_greyed`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Headless screenshots at 500px and 1280px (memory: reference-headless-screenshots) of a pending and a succeeded card; check them.
- [ ] **Step 6:** Commit `feat(ai): confirm card UI in dashboard and admin chat`.

### Task 10: Standing orders + cron

**Files:**
- Create: `lib/ai-drafts/standing-order.ts`, `lib/ai-drafts/standing-order.test.ts`
- Modify: `lib/ai-drafts/execute.ts` (a wallet_order draft with `schedule` → insert the `ai_scheduled_tasks` row with `standing_order`, `approved_draft_id`, and `next_run_at` computed by the same function the scheduled-tasks POST route uses — export it if needed; no order is placed at confirm)
- Modify: `app/api/cron/run-ai-tasks/route.ts`

**Interfaces — Produces:**
- `STANDING_ORDER_NS = "6f1d2c3a-8b7e-4d10-9a5c-2e4f6a8b0c1d"`; `standingOrderKey(taskId: string, slotIso: string): string` (uuid v5).
- `runStandingOrder(db, task, {baseUrl, cronSecret}): Promise<{result: 'ordered'|'skipped', reason?: string, orderCode?: string}>` — re-price via `walletOrderPrice`; skip if price > `max_price_ghs`, the package is unavailable, or balance < price; else POST purchase (CRON_SECRET path with `userId`, `idempotencyKey = standingOrderKey(task.id, task.next_run_at)`).
- Cron: `standing_order` tasks → `runStandingOrder` (no model). Skip → info push only, `consecutive_skips += 1`; at 3 → `is_active=false` + notify. Ordered → `consecutive_skips = 0` + normal notify. Prompt-only dashboard tasks get `aiTools('dashboard')` minus every `prepare_*` tool.

- [ ] **Step 1: Write failing tests:** `standing_order_double_fire_one_order`; `standing_order_above_cap_skips_no_purchase`; `skip_sends_push_not_sms`; `third_skip_pauses_task`; `cron_dashboard_toolset_has_no_prepare_wallet_order`; `confirm_with_schedule_creates_task_not_order`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(ai): standing orders run without the model`.

### Task 11: Admin background tasks → push a card

**Files:**
- Modify: `app/api/cron/run-ai-tasks/route.ts`, `lib/ai-drafts/prepare-admin.ts` (honour `ctx.background`), `components/admin/AdminAIChatWidget.tsx` (`?draft=<id>` opens the widget with that card)
- Test: `app/api/cron/run-ai-tasks/route.admin-cards.test.ts`

**Interfaces:** Admin cron runs pass `background: true`. After the loop, each draft it created → push to the task owner: title "Action needs your confirmation", body = `display.title`, link `/admin?draft=<id>`. The GET route's owner check guards it.

- [ ] **Step 1: Failing tests:** `admin_task_creates_12h_draft_and_push`; `admin_task_cannot_execute` (no endpoint fetch during the cron run).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(ai): admin background tasks send confirm cards`.

### Task 12: Pause script for old prompt-based orders

**Files:**
- Create: `scripts/pause-prompt-order-tasks.ts`, `lib/ai-drafts/prompt-order-detect.ts`, `lib/ai-drafts/prompt-order-detect.test.ts`

**Interfaces:** `looksLikeOrderPrompt(prompt: string): boolean` — true when the prompt has an order verb (`buy|order|send|purchase|top ?up`) **and** a data marker (`\d+\s*(gb|mb)|data|bundle`), case-insensitive. Script: `--dry-run` (default) prints task id, owner id and the first 60 prompt chars with **no phone numbers**; `--apply` sets `is_active=false` on active `context='dashboard'` matches and pushes each owner "Your scheduled order is paused — tap to re-approve", linking `/dashboard?ai=reapprove&task=<id>`. The dashboard widget, on that link, opens with a prefilled message "Re-create my scheduled order: <prompt>".

- [ ] **Step 1: Failing tests:** `detects_buy_1gb_weekly`; `ignores_balance_report`; `ignores_order_status_check` ("check my order status").
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(ai): script to pause prompt-based scheduled orders`.

### Task 13: Verify, review, ship (prod change protocol)

- [ ] **Step 1:** `npx vitest run` — no new failures against the Task 0 baseline.
- [ ] **Step 2:** `npx tsc --noEmit` and `next build` with placeholder env — both clean.
- [ ] **Step 3:** Fresh **opus** reviewer over the whole branch diff (money/auth/schema gate) with the spec and Review Focus. Fix findings with failing tests first.
- [ ] **Step 4:** Prod precheck: read the live `orders`, `ai_scheduled_tasks`, `wallets` columns; confirm `ai_drafts` / `revert_wallet_deduction` don't exist yet.
- [ ] **Step 5:** Self-rolling-back dry run of 0188 on prod (`BEGIN; …; ROLLBACK;`) plus the selftest checks as `pg_temp`; show the owner the output.
- [ ] **Step 6:** `scripts/pause-prompt-order-tasks.ts --dry-run` against prod; show the owner the list.
- [ ] **Step 7: STOP — owner OK** for the migration apply, the pause list and the deploy.
- [ ] **Step 8:** Apply 0188; verify objects + grants. Merge to main (check origin/main for other sessions first), push, wait for the Vercel deploy.
- [ ] **Step 9:** Run the pause script with `--apply`.
- [ ] **Step 10:** Live check with the owner: a dealer card (small bundle to a test number) → Confirm → one order; Confirm again → "already placed"; an admin wallet-adjust card on a test account.
- [ ] **Step 11:** Update memory (project note + MEMORY.md line) and draft the WhatsApp channel post (Post now / Hold).
