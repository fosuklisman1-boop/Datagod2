# Cron idempotence and duration audit (Tasks 5 and 6)

Status: PARTIAL - written 2026-10-20 during execution. Items marked UNVERIFIED must be checked before that route's cutover.

## Why overlap is lower-risk than it sounds
Vercel never guaranteed a singleton for these jobs: every-minute routes with `maxDuration = 300` already overlap themselves whenever a run exceeds 60s, and Vercel can deliver a cron event more than once. So routes should already tolerate two concurrent invocations. This audit checks whether each one actually does.

## Verified so far
| Route | Finding |
|---|---|
| reconcile-paystack-refunds | Selects `order_refunds` with `status = 'processing'` and `updated_at < now-5min`, and bumps `updated_at` on every processed row. A second concurrent run mostly skips rows the first just touched. Final write safety lives in `lib/refunds/reconcile-paystack.ts` - UNVERIFIED that it is conditional on status. |
| drain-fulfillment-queue | Thin wrapper over `drainFulfillmentQueue` in `lib/fulfillment-queue-drain.ts`. Claim/lock behavior lives there - UNVERIFIED. |

## Not yet audited (read the handler AND the lib it calls)
Batch B: run-ai-tasks, drain-broadcasts, wa-delivery-notify, sms-pending-credits, sms-send-drain, sms-scheduled, sms-hubtel-dlr, security-alerts, phone-verify.
Batch C: all sync-mtn-status/*, sync-afa-status/apexprime, sync-codecraft-status, sync-digiwapy, hubtel-callbacks, hubtel-status-check, hubtel-cs-status-check, verify-pending-payments, withdrawals-status-check.
Batch A is daily/hourly/5-minute housekeeping; audit check-subscriptions, check-subscription-expiry, expire-stale-airtime before moving them.

## Recommended cutover rule until a route is verified
- Batch A: overlap is acceptable only after the three routes above are checked.
- Batch B/C routes that are UNVERIFIED: no-overlap cutover. Remove the entry from `vercel.json` and deploy first, then enable the external job (a gap of a few minutes; these are polling/draining jobs and the providers are webhook-first). Never leave both running on an unverified money route.
- withdrawals-status-check and verify-pending-payments: last, one at a time, watched through one full cycle.

## Task 6 - durations of the 12 `maxDuration = 300` routes (needs data)
Need p50/p95/max from the Vercel logs. Routes: drain-fulfillment-queue, drain-broadcasts, hubtel-callbacks, hubtel-status-check, hubtel-cs-status-check, reconcile-paystack-refunds, phone-verify, sms-hubtel-dlr, mtn-whitelist-retry, sms-scheduled, sync-afa-status/apexprime, sms-contact-verify.

| Route | p50 | p95 | max | Verdict |
|---|---|---|---|---|
| (to fill in from Vercel logs) | | | | |

Rule: fits the cron-job.org timeout -> moves; exceeds and non-fulfillment -> return-immediately change (Task 7); exceeds and fulfillment -> stays on Vercel.
