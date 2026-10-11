# SMS Platform Rebuild — Phase 4 (Scheduled Sends + Billed Order Confirmations) Design

Date: 2026-10-12
Status: Approved in brainstorming (user: "carry on" on the proposed design), pending spec review
Builds on: Phase 1 (decision D5, `scheduled` status), Phase 3 (customer pages, enforcement, held campaigns, per-account send lease).

## 1. Goal
1. **Scheduled sends** — a customer can schedule a campaign for 2 minutes to 30 days ahead.
2. **Billed order confirmations** — the Home toggle "Use my sender ID for order confirmations" becomes live: off = free from the platform sender (default), on = the shop's own sender ID, billed in credits.

## 2. Decisions
| # | Decision |
|---|---|
| P4-1 | A scheduled send is validated like a normal send **at scheduling time** (kill switch, entitlement, sender, caps/policy when enforced) and its credits are **debited immediately**. Content/policy is **not** re-evaluated at send time (user-approved). |
| P4-2 | Storage reuses the held-campaign shape: `sms_send_logs.status = 'scheduled'` + new `scheduled_for`, messages stored `pending` and unclaimed. `claim_sms_messages` already skips `scheduled` logs. |
| P4-3 | A per-minute cron promotes due logs `scheduled → queued` atomically and dispatches them with the normal post-debit sequence. |
| P4-4 | Cancel = full refund of the unsent messages, one SQL transaction, idempotent (same pattern as `reject_held_sms_campaign`). No in-place edit (cancel and reschedule). |
| P4-5 | Order-confirmation toggle: off (default) = free platform sender; on = shop's own active sender ID, billed 1 credit per message segment, falling back to the free platform sender when credits are insufficient / no active sender / account not entitled. **Existing shops move to the platform sender** (D5) — a visible behaviour change that is announced in the runbook. |
| P4-6 | Order confirmations never block order fulfilment; every failure is swallowed and logged (as today). |

## 3. Scheduled sends

### 3.1 Data
Migration adds `sms_send_logs.scheduled_for TIMESTAMPTZ NULL` (+ partial index on `(scheduled_for) WHERE status='scheduled'`), and the new column must be added to the `authenticated` column-grant list on `sms_send_logs` only if it is meant to be browser-readable (it is not; service-role routes only — keep it ungranted).

### 3.2 Scheduling (extends the existing send path)
- `POST /api/shop/sms/send` (and v1 `POST /api/v1/sms/send`) accept optional `scheduledAt` (ISO 8601). Server validation: `now + 2 min ≤ scheduledAt ≤ now + 30 days`, else 400 `INVALID_SCHEDULE` with the bounds in the message. Compose sends the UTC instant; the UI displays Ghana time (UTC+0, GMT).
- With `scheduledAt`, `enqueueSend` runs every check a normal send runs (kill switch, entitlement, sender resolution, policy when enforced, the per-account lease), debits per chunk, inserts the log with `status='scheduled'`, `scheduled_for`, the messages as `pending` (unclaimed) — **no dispatch** — and returns `{scheduled:true, scheduledFor, sendLogId, ...}`. Sends >500 recipients create one scheduled log per 500-chunk, all with the same `scheduled_for`.
- Usage caps count the log at creation (already true: `sms_account_usage` counts every non-blocked/non-rejected log), so scheduling cannot dodge daily/hourly caps.
- Enforcement OFF behaviour for non-scheduled sends is untouched (golden fixture stays green).

### 3.3 Dispatch cron
- New route `app/api/cron/sms-scheduled` (CRON_SECRET bearer, `vercel.json` schedule every minute). It selects logs with `status='scheduled' AND scheduled_for <= now()` (limit per run, oldest first) and for each: conditional `UPDATE ... SET status='queued' WHERE id=$1 AND status='scheduled'` (the gate; concurrent runs and cancel are safe), then claims and dispatches using the **same helpers** as `held-service.releaseHeldCampaign` (factor the shared dispatch into one module rather than a third copy), then `recompute_sms_send_result`.
- Pre-flight per log, in order: account `suspended` → cancel + refund (reason "account suspended"); SMS kill switch off → leave `scheduled` (retry next tick, log once); otherwise dispatch.
- A log whose process dies after the flip is recovered by the existing drain/stale-claim reaper (messages are claimable once the log is `queued`).
- Late dispatch is acceptable (cron granularity ≈ 1 min plus runtime); a log more than 24 h overdue is still sent (credits already debited) but flagged in the Records detail as "sent late".

### 3.4 Cancel
`POST /api/sms/logs/[id]/cancel` (customer, `resolveAccount`, ownership enforced): only `status='scheduled'` logs of the caller's account. Calls new SQL `cancel_scheduled_sms_campaign(p_log_id, p_account_id)` — one transaction: lock log `FOR UPDATE`, require still `scheduled`, close its messages (`attempts ≥ 3`, `last_error='scheduled_cancelled'`), refund the **unrefunded unsent** messages via one ledger row (`adjust_sms_units`, reason `campaign_refund`, ref `sched_cancel:<logId>`, linked by `send_log_id`), mark messages refunded, set the log `failed`, `credits_used=0`, `completed_at`, `policy_shadow.review = {outcome:'cancelled', ...}`. Idempotent (second call → `already_cancelled`). Not blocked by the kill switch. `sms_account_usage` excludes cancelled logs (extend the existing rejected exclusion).

### 3.5 Customer UI
- Compose: "Send later" toggle → date/time picker (min now+2 min, max now+30 days), summary line "Will be sent on <date> at <time> (GMT)", credits are reserved now. Preview note and cost summary unchanged.
- Records: chip **Scheduled**; scheduled rows show "Scheduled for <time>" and a Cancel button (confirm dialog: "Credits will be refunded"); detail page shows the schedule and, once sent, the normal delivery breakdown. `view.ts` helpers (`scheduleBounds`, `formatScheduled`, status label `scheduled` already exists) are pure and unit-tested.
- Credits history: the debit appears at scheduling time; a cancel appears as "Refund — scheduled campaign #N".

### 3.6 Admin
Messages tab already lists `scheduled`; no new admin controls. Flagged/held logic is unaffected (scheduled ≠ held). Kill switch note in the runbook: turning SMS off pauses dispatch of due scheduled sends (they stay scheduled) but never blocks cancel/refund.

## 4. Billed order confirmations

### 4.1 Toggle
Migration: `shop_settings.order_confirmation_use_own_sender BOOLEAN NOT NULL DEFAULT false`. Home's currently-disabled switch becomes live: `GET/PATCH /api/sms/order-confirmations` (`resolveAccount`; maps account → owning shop; PATCH `{useOwnSender:boolean}`; requires an active own sender ID to turn ON, else 400 with a link-worthy message). The existing `order_confirmation_sms_enabled` (send at all) is unchanged and remains controlled from the shop pages.

### 4.2 Send path (`app/api/fulfillment/process-order/route.ts`)
Replace the inline "use the shop's first active sender, free" lookup with a service `lib/sms/order-confirmation-sender.ts: resolveConfirmationSender(shopId)` → `{ senderId?: string, billed: boolean, accountId?: string }`:
- toggle off / no shop SMS account → `{}` (platform sender, free, exactly the current fallback);
- toggle on → the default own sender (same `loadDefaultSender` rule used elsewhere), `billed: true`.
When `billed`, the confirmation is sent via a new `sendBilledConfirmation(accountId, phone, message, senderId)` in the SMS service layer that: checks entitlement (active, not suspended) and `isSmsEnabled()`, computes segments (`calculateSegments`), debits with `debit_sms_for_send` (idempotent per order: ref/log keyed `order_confirm:<shopOrderId>` so a retried fulfilment can never double-bill or double-send), inserts a normal `sms_send_logs` row (`sender_id`, `mode`, credits) so it appears in Records and Credit History as "Order confirmation", and dispatches through the same provider path as `sendSMS` with the shop sender. **Any failure at any step falls back to the free platform-sender message** (never raise to the caller); insufficient credits falls back and records one `sms_order_confirm_unbilled` notification to the shop owner per day ("Your order confirmations are going out from the platform sender because you're out of credits").
- Policy engine: order confirmations are system-generated and **exempt** from enforcement (like OTP/transactional), but they still debit credits and are logged.

### 4.3 Customer UI
- Home: the switch shows state, a one-line explanation ("Customers get your order confirmation from your own sender ID. Costs 1 credit per message."), disabled with a reason when no active sender / not entitled.
- Records shows these sends with an "Order confirmation" label; Credits history labels debits "Order confirmation SMS".

## 5. Testing
Pure helpers unit-tested (schedule bounds, formatting, status labels); services against fake DBs (scheduling writes, dispatcher gate/idempotency, suspended/kill-switch pre-flight, cancel idempotency and refund amount, confirmation sender resolution matrix, billed send idempotency key, fallback on every failure mode); SQL (`cancel_scheduled_sms_campaign`, `scheduled_for`, usage function) reviewed line by line and smoke-tested in a rolled-back transaction before application; golden fixture proves non-scheduled / enforcement-off behaviour unchanged; gates: `tsc`, full vitest (9 known failures only), placeholder-env `next build`; visual check of Compose (schedule picker), Records (scheduled chip, cancel), Home (toggle) at phone + desktop width; final whole-implementation review per milestone (4a scheduled sends, 4b billed confirmations — shipped separately).

## 6. Rollout
Migrations first (additive), then deploy. Scheduling is available to customers immediately (no flag) — it only adds a new optional parameter. The order-confirmation behaviour change (existing shops with an own sender move to the platform sender until they switch the toggle on) takes effect on deploy; the runbook carries the announcement text. `vercel.json` gains the per-minute cron entry; verify the cron appears in the Vercel project after deploy (auto-deploy is sometimes flaky).

## 7. Out of scope
Recurring schedules; editing a scheduled send in place; timezone selection (GMT only); scheduled sends via admin broadcast; re-evaluating policy at send time.
