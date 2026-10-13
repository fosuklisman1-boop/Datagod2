# Admin-Action Notifications — Design

Date: 2026-10-12 · Status: draft for review

## Goal

Every user-initiated request that needs a platform admin must (1) alert admins by **email + push** when it is created, and (2) message the user by **email + SMS** when an admin approves, rejects, completes or resolves it. One central notifier replaces today's patchy, per-route sends.

## Scope (user decisions)

| Flow | Create (admin alert) | Outcomes (user message) |
|---|---|---|
| Withdrawals | `app/api/user/withdrawals/create` (via `withdrawalService.createWithdrawalRequest`) | approve, reject, complete (`app/api/admin/withdrawals/{approve,reject,complete}`; bulk-approve too) |
| AFA registrations | `app/api/afa/submit`, USSD/other AFA creators | status updates: `app/api/admin/afa-update-status`, `lib/afa-fulfillment.ts` |
| Results-check requests | `lib/results-checker-service.ts` (+ `notifyAdminsNewResultsCheckRequest`) | delivered / declined via `app/api/admin/results-check-requests` and the service |
| Shop approvals | `app/api/shop/setup` | approve, reject: `app/api/admin/shops/approve` |
| SMS sender IDs | `app/api/sms/sender-ids` (user create) | approve, reject: `app/api/admin/sms-sender-ids/{approve,reject}` (and poll/fetch-status when it flips state) |
| Complaints | `app/api/complaints/create` | resolved/closed: `app/api/admin/complaints/update`, `app/api/admin/whatsapp-inbox/resolve-complaint` |

**Out of scope:** sub-agent requests (approved by the shop owner, not a platform admin); custom domains (admin-created, no user request flow); manual-fulfil data orders (very high volume — not selected); refunds (admin-initiated; already notify the customer/owner).

Outcomes that notify: **approved/completed AND rejected/declined** (rejections include the admin's reason when one exists). Intermediate "in progress" states do not.

## Architecture

New module `lib/admin-actions/`:

- `registry.ts` — typed registry keyed by flow id (`withdrawal | afa | results_check | shop | sender_id | complaint`). Each entry defines:
  - `adminAlert(ctx)` → `{ subject, html, pushTitle, pushBody, url }` (url = the admin page for that flow);
  - `userOutcome(outcome, ctx)` → `{ email: {subject, html}, sms: string, push?: {...}, inApp?: {...} }` per outcome (`approved | rejected | completed | resolved`).
- `notify.ts`:
  - `alertAdminsOfRequest(flow, ctx)` → email to all admins (existing `email-service.notifyAdmins`) + push to all admin devices (existing `push-service.notifyAdminsPush`).
  - `notifyUserOfOutcome(flow, outcome, ctx)` → email (existing `sendEmail`, logged with `type`/`referenceId`) + SMS (existing `sendSMS`) to the requester; **plus** the push/in-app notices that a flow already sends today (never regress existing channels).
- Templates: new `EmailTemplates` entries and `SMSTemplates` entries (SMS ≤ ~160 chars). The wording of existing templates (`withdrawalApproved/Rejected`, `shopApproved/Rejected`, results-check delivery) is the starting point.

Recipient resolution: admins = `users.role = 'admin'` (existing helpers); the requester's email/phone from `users` by the flow's owner user id. A missing email or phone skips that channel and logs it.

## Reliability rules

1. Each channel is independent (`Promise.allSettled`, own try/catch, short timeout). One failing channel never blocks the others or the request.
2. The two entry points **never throw**. Routes **await** them (serverless may freeze fire-and-forget work).
3. Callers invoke them only **after the state change succeeded** (e.g. the conditional update that moved pending → approved returned a row). A double click or retry therefore cannot send twice. No new table or migration.
4. SMS goes through `sendSMS` as today (its provider routing, exhaustion handling and logging are reused). Admin alerts do **not** use SMS (user decision: email + push).
5. Notifications never contain secrets (no OTPs, tokens, full account numbers).

## Migrating existing sends

Withdrawals (approve/reject), shop approvals (approve/reject), results checks and AFA already send some of these inline. Each is replaced by one `notifyUserOfOutcome` call so that wording and channels live in one place. Acceptance: for every migrated route, the user still receives every channel they received before (email/SMS/push/in-app) — the new notifier is a superset — and exactly one message per channel per outcome.

## Gaps this closes

- Admins alerted by email + push on all six flows (today: results-check only, partly; complaints via WhatsApp only).
- Users told on every outcome by email + SMS (today missing for: complaints, sender IDs, withdrawal completion, AFA email, results-check decline, etc.).

## Testing

- Unit: each registry entry's templates (subject/body/SMS length, reason inclusion, no secrets); notifier failure isolation (email throws → SMS and push still sent; all throw → returns normally); skip rules (no email/no phone/no push subscription).
- Route-level: for each flow, create route calls `alertAdminsOfRequest` exactly once; each outcome route calls `notifyUserOfOutcome` exactly once with the right outcome, only on a real state change (a repeat call on an already-handled request sends nothing).
- Regression: migrated routes keep their previous channel set (assert via the notifier's recorded sends).

## Rollout

Pure code change, no migration. Deployable at any time. SMS volume rises (every outcome now texts the user); admin email/push volume rises with request volume — acceptable per the user's decision.

## Open items for planning

- Exact hook point and owner-user-id source for each create route (e.g. AFA has several creators: dashboard, USSD, WhatsApp bot; complaints are also created via the WhatsApp bot).
- Where a flow has more than one "completed" path (withdrawals: approve may pay immediately via a gateway vs. the separate `complete` route) — notify once per real outcome, not per route.
- Whether the sender-ID `poll`/`fetch-status` routes (which can flip an ID to approved asynchronously) should notify the user — default yes, on the real state flip only.
- Admin deep-link URLs per flow (confirm the admin page paths).
