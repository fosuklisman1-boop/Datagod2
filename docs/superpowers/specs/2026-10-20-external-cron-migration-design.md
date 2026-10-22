# Move all cron jobs from Vercel Cron to cron-job.org — design

Date: 2026-10-20 · Status: draft for approval

## Intent and why
Vercel cron invocations are costing money. 21 of the 39 jobs in `vercel.json` fire every minute. cron-job.org triggers the same HTTP routes for free, so we move the scheduler out of Vercel and keep the routes unchanged.

## Goals
- All 39 scheduled routes in `vercel.json` are triggered by cron-job.org with the same schedule they have today.
- `vercel.json` ends with no `crons` block.
- No route is left unscheduled by accident, and no route double-fires after cutover.
- Jobs are created by a repeatable script (user's choice), not by hand.
- Stays inside cron-job.org's API limit of **100 requests per day** (user-reported).

## Non-goals
- No changes to route logic, auth, or schedules.
- No new scheduler for `sync-mtn-status/bundleportal` (exists, is webhook-first, not scheduled today — leave as is unless told otherwise).
- Not building a scheduler of our own (Supabase pg_cron, Cloudflare, etc.).

## Anti-goals (failure even if it "works")
- A cron route reachable without the Bearer secret.
- CRON_SECRET appearing in a command line, committed file, or log.
- Money/fulfillment jobs (drain-fulfillment-queue, verify-pending-payments, withdrawals-status-check, reconcile-paystack-refunds) silently not running for any stretch during cutover.
- The script burning the daily API budget on retries or verification calls.

## Constraints (verified in repo)
- Every route authenticates with `Authorization: Bearer <CRON_SECRET>` (`lib/cron-auth.ts` plus inline copies in withdrawals-status-check and phone-verify). Vercel sent this automatically; cron-job.org must send the same header per job. No route code change needed.
- 12 routes declare `maxDuration = 300` (drain-fulfillment-queue, drain-broadcasts, hubtel-callbacks, hubtel-status-check, hubtel-cs-status-check, reconcile-paystack-refunds, phone-verify, sms-hubtel-dlr, mtn-whitelist-retry, sms-scheduled, sync-afa-status/apexprime, sms-contact-verify). cron-job.org's per-request timeout is believed to be ~30s — to be confirmed.
- cron-job.org minimum interval is 1 minute (matches our fastest schedule).
- API limit: 100 requests/day. Creating 39 jobs = at most 39 calls (2 already exist in the account and are adopted: check-subscription-expiry, check-subscriptions). Account also holds an unrelated mdatagh.com job and two disabled legacy jobs; the script never touches jobs whose URL host isn't www.datagod.store. Production host: https://www.datagod.store.

## Decisions made with the user
- Scope: **move every cron**.
- Mechanism: **script via cron-job.org API** (user creates the API key; kept in env only).
- Long routes: **measure real durations first**, then decide per route. User raised leaving some on Vercel; the rule below is my recommendation, pending approval:
  - Finishes within the timeout → moves, untouched.
  - Exceeds it and is not money/fulfillment → small return-immediately change (TDD), then moves.
  - Exceeds it and is money/fulfillment (e.g. drain-fulfillment-queue, reconcile-paystack-refunds) → stays on Vercel cron unless the change is trivially safe. "Move every cron" therefore means "every cron that can move safely"; leftovers are listed explicitly.
- Cutover: **short overlap is fine**. Each route is checked for run-twice safety; any that isn't gets a no-overlap cutover with a brief gap.
- Account: cron-job.org account exists; plan limits unknown (see Step 0).

## Step 0 (user, before building)
Look up in the cron-job.org dashboard and report: max number of jobs, minimum interval, per-request timeout, and whether the account can create an API key. If max jobs < 39 (+ the 6 already there) or the interval floor is above 1 minute, scope shrinks (the every-minute jobs are what matter most). Also confirm the "100 requests/day" figure applies to the API.

## Settled by me (check these)
- Secrets (CRON_SECRET, cron-job.org API key) read from a local env file at run time, never on a command line or in the repo.
- Retries off on money jobs; failure emails only for money jobs.
- Canonical production host taken from the app's env URL; the script checks it for apex/www redirects (which can drop the Authorization header) before creating anything.
- Staleness alert is optional and out of scope for v1.
- Durations come from the user's Vercel logs export or from timing the routes directly; I cannot query production logs.

## Design
**Source of truth.** One schedule-list file the script reads, generated from the current `vercel.json` crons so nothing is retyped. Each entry becomes a job: GET `https://<prod-domain><path>`, header `Authorization: Bearer $CRON_SECRET`, same cron expression, timezone UTC (Vercel crons are UTC).

**API-budget rules for the script** (my call):
- Default is a local dry run: prints the diff, makes zero API calls.
- One list call to learn existing jobs, then create/update only what differs (an idempotent re-run costs 1 call).
- No per-job read-back verification; verify via the jobs' execution history and app logs.
- A persisted per-day counter refuses to run past ~80 calls, leaving headroom for fixes.
- Prefer disable over delete when rolling back.

**Cutover (phased, avoids double-firing and gaps).**
1. Create all jobs on cron-job.org **disabled**; compare against the schedule list.
2. Batch A (low-risk daily/hourly): enable externally, remove from `vercel.json`, deploy, confirm one run each in logs.
3. Batch B (every-minute sync/drain jobs), then Batch C (money jobs last, one at a time) — same steps. Batches may span days to stay inside the API budget.
4. When `crons` is empty, remove the block and confirm in the Vercel dashboard that no cron invocations remain.
Rollback for a batch = re-add its entries to `vercel.json`, redeploy, and disable the external job.

**Overlap safety.** A job briefly scheduled by both systems must be safe to run twice. Check idempotence per route while planning; non-idempotent routes are cut over with no overlap (remove from Vercel first, enable externally within the same minute).

## Monitoring (my call)
Enable cron-job.org failure email notifications for the money jobs. Add a "last successful run" staleness alert for them if none exists.

## Left to the builder
Script language/location (suggest Node/TypeScript under `scripts/`), schedule-list file format, how to persist the call counter, batching order within A/B.

## Open items
- Confirm "100 requests/day" is the API call limit.
- Confirm cron-job.org's actual per-request timeout and job-count limit on the user's plan.
- Measure real durations for the 12 `maxDuration = 300` routes.
