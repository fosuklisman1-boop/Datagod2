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

Every call logs `[ADMIN-ACTION]` lines with per-channel `sent | skipped | failed` and the reason. Note `sent` is optimistic where a provider swallows errors (e.g. `notifyAdmins`, `sendSMS` no-ops).

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

## Known limitations (deferred minors)

- Channel status in logs is optimistic when providers swallow errors; SMS log not tied to userId; worst case ~13s per notify call (8s channel cap), matters for large cron batches.
- Admin alert per failed AFA attempt (admin retries can flood); AFA/complaint update routes key on id only, so concurrent admins could double-notify.
- Results-check admin email shows raw channel (`whatsapp_shop`); PATCH `reason` lacks a type/length guard; completion is read-then-write.
- Bulk-approve completed message "remaining balance" may be stale; no log on a lost completed write.
- Shop routes do an extra unbounded phone lookup outside the notifier timeout; approve 409 also returned for nonexistent shopId.
- Wiring tests are source greps, not behavioural.

## Duplicate-send audit (2026-10-12)

No double-sends found. Remaining inline senders in wired files are unrelated (shop-order/wallet pushes, results-check admin WhatsApp text which is a separate channel, "Transfer Failed" in-app/push which is neither approved nor rejected). `SMSTemplates.afaCompleted` has no remaining callers.
