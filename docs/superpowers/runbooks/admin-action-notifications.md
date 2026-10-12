# Admin-action notifications runbook

Central notifier: `lib/admin-actions/` (`alertAdminsOfRequest`, `notifyUserOfOutcome`). Both never throw, are awaited at the call site, and isolate each channel (one failing channel never blocks another or the route).

## Flows

| Flow | Create hook -> admin alert (email + push) | Outcome hooks -> user message (email + SMS, plus existing push/in-app) |
|---|---|---|
| withdrawal | `app/api/user/withdrawals/create` | approved (manual approvals: `admin/withdrawals/approve`, `bulk-approve`), rejected (`reject`), completed (`withdrawal-hook.ts`: `complete`, `submit-transfer-otp`, instant payouts in approve/bulk-approve, `cron/withdrawals-status-check`, Paystack webhook `transfer.success`) |
| shop | `app/api/shop/create` | approved / rejected: `admin/shops/approve`, `reject` |
| afa | `lib/afa-fulfillment.ts` (manual orders, and on auto-fulfil failure), `cron/sync-afa-status/apexprime` (provider failure / release) | completed: `admin/afa-update-status`, apexprime cron, `afa-fulfillment.ts` |
| results_check | `lib/results-checker-service.ts` (`notifyAdminsNewResultsCheckRequest`, before the WhatsApp early return) | completed / rejected: `admin/results-check-requests`, `results-checker-service.ts` |
| sender_id | `app/api/sms/sender-ids` | approved / rejected via `sender-id-hook.ts`: `admin/sms-sender-ids/approve`, `reject` |
| complaint | `app/api/complaints/create`, `lib/whatsapp-bot/complaints.ts` | resolved: `admin/complaints/update`, WhatsApp admin-router resolve |

## Where things live

Message text is in `lib/admin-actions/flows/<flow>.ts` (`adminAlert`, `userMessage`). Context types: `contexts.ts`. Flow registry: `registry.ts`. SMS bodies are clipped to 160 chars centrally in `notifier.ts`.

## Adding a flow

1. Add the context interface to `contexts.ts` (keys must equal the new `FlowId`).
2. Write `flows/<flow>.ts` exporting a `FlowDef`.
3. Register it in `registry.ts`.
4. Add it to the `SUPPORTED` map in `flows.test.ts`.
5. Add a wiring guard in `wiring.test.ts`.
6. Call `alertAdminsOfRequest` / `notifyUserOfOutcome` from the route only AFTER a real state change: use a conditional update (`.eq("status", prev)` + `.select()` and check rows) or gate on the pre-image status. Never notify on a no-op or repeat click.

## Reading results

Each notify call logs ONE summary line: `[ADMIN-ACTION] <flow> <outcome|alert> <reference> sent=<n> skipped=<channels> failed=<channels>` (channel names only, never phones, emails or message text). Per-channel failures also log `[ADMIN-ACTION] <channel> failed: <detail>`. `sent` is optimistic where a provider swallows errors.

## Common causes of silence

- No admin users (admin email/push has no recipients).
- No push subscriptions for the user/admin.
- SMS credits exhausted (see `sendSMS` logs).
- User has no email or phone on file (channel `skipped`). Guests: results-check/complaint pass explicit phones; results delivered to guests only by SMS.
- Flow out of scope (below).

## Known behaviours and exclusions

- Out of scope: sub-agent requests and custom domains.
- Complaints: bulk "Resolve all" is deliberately silent (mass-send risk); single resolves notify.
- Results check: the "completed" message is also sent where result delivery already texts/emails (USSD SMS, web email) - one extra SMS per completion by design.
- AFA: admin alerts only when manual fulfilment or on provider failure.
- Sender ID: admin alert only on new / re-opened requests (`isNew`); platform IDs untouched.
- Withdrawals: "approved" = manual approvals only; "completed" = payout confirmed or instant (single send per path, guarded by conditional status flip).

## Cost

Every outcome now sends an SMS (plus email); every request sends admin email + push. Watch SMS spend after rollout.

## Known limitations

- Channel status is optimistic where a provider swallows errors (`notifyAdmins`, `sendSMS` no-ops); worst case ~13s per notify call (8s channel cap).
- White-label leak: shop customers and API resellers receive DATAGOD-branded SMS/email for AFA and results-check completion.
- `ussd_afa_orders` (USSD + storefront AFA) are excluded from alerts and outcomes.
- Web bulk complaint resolve texts each selected complaint (only the "Resolve all" button is silent).
- Email provider quota/volume: every outcome and admin alert is an email; watch the provider quota after rollout.
- Bulk-approve "completed" remaining balance may be stale (the bulk path never syncs the shop balance before the message reads it).
- Read-then-write double-notify windows remain in `afa-update-status`, `complaints/update` and results-check deliver (two admins acting in the same moment can double-notify).
- Shop routes do an extra unbounded phone lookup outside the notifier timeout; shop approve 409 is also returned for a nonexistent shopId.
- Wiring tests are source greps, not behavioural.

## Post-deploy checklist

1. Withdrawal create: one admin alert; approve (manual), reject and complete each send exactly one message (check `sms_logs` by `message_type` + `reference_id`).
2. Instant Moolre/Paystack payout: exactly one `withdrawal_completed` per withdrawal (no `withdrawal_approved` on that path).
3. Shop create / approve / reject: one admin alert, one user message each.
4. AFA: manual order alerts admins once; auto-fulfil failure alerts once (not on admin `fulfill-pending` retries); completed message once, including the Apex Prime cron (run the duplicate query below).
5. USSD wallet results-check: session responds quickly after the debit (admin notify now runs after the response).
6. Sender ID: new request alerts admins; re-submitting a pending ID does not.
7. Complaints: a single admin push per WhatsApp/web complaint; single resolve notifies the user once.
8. Global duplicate check, expecting 0 rows after a day:
   `select message_type, reference_id, count(*) from sms_logs where created_at > now() - interval '1 day' and reference_id is not null group by 1,2 having count(*) > 1;`

## Duplicate-send audit (2026-10-12)

No double-sends found. Remaining inline senders in wired files are unrelated (shop-order/wallet pushes, results-check admin WhatsApp text which is a separate channel, "Transfer Failed" in-app/push which is neither approved nor rejected). `SMSTemplates.afaCompleted` has no remaining callers.
