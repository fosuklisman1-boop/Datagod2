# Blocked MTN numbers: operator runbook

The feature ships dark. Nothing records or sends until you flip the switches below. Spec: `docs/superpowers/specs/2026-11-15-blocked-numbers-tracking-design.md` (section 9 is the rollout).

Two switches live in the `blocked_numbers_settings` admin setting (card on `/admin/settings/mtn`, under "Customer verification"):

- `enabled` (default OFF): recording blocked numbers and the daily re-check cron.
- `customer_sms_enabled` (default OFF): the "number ready" SMS to customers.

Other settings: `retention_days` 30, `spike_threshold_per_hour` 25, `daily_sms_ceiling` 300.

## Step 1. Apply migration 0182

File: `migrations/0182_mtn_blocked_numbers.sql`. It is additive (two new tables, service-role only) and re-runnable.

1. Pre-check. It must return NULL and NULL:

   ```sql
   SELECT to_regclass('public.mtn_blocked_numbers'), to_regclass('public.mtn_blocked_attempts');
   ```

2. Self-test (rolls itself back). The run string must be built by code, never by hand. From the repo root run:

   ```
   npx tsx scripts/print-0182-selftest.ts > 0182-selftest-run.sql
   ```

   It prints `0182_mtn_blocked_numbers.sql` with only its final `COMMIT` line removed, followed by `migrations/0182_mtn_blocked_numbers.selftest.sql` from the line that starts with `DO` onward. The builder (`lib/blocked-numbers/migration-0182-run.ts`) refuses to print anything (non-zero exit) unless the string has no `COMMIT`, no bare `END;`, and ends by raising `SELFTEST_OK` (the 0130 incident lesson); `lib/blocked-numbers/migration-0182.test.ts` runs the same builder. Send the contents of `0182-selftest-run.sql` to production. PASS means the error text starts with `SELFTEST_OK`. Any `FAIL ...` or other error means stop and report. If the client keeps the session open, send `ROLLBACK;`.
3. Re-run the pre-check; it must still return NULL and NULL (proves the dry run left nothing behind).
4. Apply the real file (it has its own `BEGIN`/`COMMIT`).
5. Verify:

   ```sql
   SELECT to_regclass('public.mtn_blocked_numbers'), to_regclass('public.mtn_blocked_attempts');  -- both non-NULL
   SELECT count(*) FROM public.mtn_blocked_numbers;  -- 0
   ```

## Step 2. Deploy and schedule the cron

1. Deploy the merged branch (the switches are off, so behaviour is unchanged).
2. The daily re-check is `/api/cron/mtn-blocked-recheck` at `30 6 * * *`. It is already in `lib/cron-migration/crons.json` and classified Batch A. Register it on cron-job.org from the repo root (needs `CRONJOB_API_KEY` and `CRON_SECRET` in `.env.local`; they are read from the file, never typed on the command line):

   ```
   npx tsx scripts/sync-cronjob-org.ts --plan --only /api/cron/mtn-blocked-recheck
   npx tsx scripts/sync-cronjob-org.ts --apply --only /api/cron/mtn-blocked-recheck
   npx tsx scripts/sync-cronjob-org.ts --enable A --only /api/cron/mtn-blocked-recheck
   ```

   `--plan` shows the diff (one API call). `--apply` creates the job DISABLED (it first checks the live site answers 401 to an unauthenticated call). `--enable A --only ...` switches on just this one job. The script budgets cron-job.org API calls (cap 80/day).
3. Confirm the first run in Vercel logs for that route. While `enabled` is OFF it must do nothing.

## Step 3. Flip `enabled` ON

Turn on `enabled` in `/admin/settings/mtn`. Watch `/admin/blocked-numbers` fill for 24 to 48 hours. Sanity-check the block rate and the breakdown by surface (storefront, dashboard, API, USSD, bots).

## Step 4. Supplier list

Export a supplier list from `/admin/blocked-numbers`, hand it to the supplier, and wait for the first numbers to flip to allowed.

Note: while `customer_sms_enabled` is off, numbers that become allowed are marked notified and will never be texted later (spec section 4, step 5). That includes the first real flips in this step, so turn SMS on promptly after the first verified flip (Step 5).

## Step 5. Flip `customer_sms_enabled` ON

Only after you have seen at least one real flip with a correct `allowed_by` (the provider that approved the number). Then turn on `customer_sms_enabled` promptly, because numbers that flipped while it was off were marked notified and will not be texted. Watch the first few sends. The cron stops sending for the UTC day at `daily_sms_ceiling` (the digest says so).

## Step 6. Announce

Tell shop owners and dealers (channel announcement, "Post now").

## What to watch

- `/admin/blocked-numbers`: totals, status, attempts, provider breakdown.
- Spike alert: fires when distinct blocked numbers in a rolling hour exceed `spike_threshold_per_hour` (25).
- Daily digest (once per day).
- SMS ceiling: sends per UTC day against `daily_sms_ceiling`.
- Vercel logs for `/api/cron/mtn-blocked-recheck`: logs carry counts and error class names only, no phone numbers.
- Attempts older than 90 days are purged by the cron (they hold purchaser phones).

## Accepted risk

A storefront preview can be attributed to any shop slug by a caller who knows a real blocked number. Impact is bounded: at most 2 "number ready" texts per number per 90 days, and everything stays under the daily ceiling. Not mitigated further by design (accepted risk, spec sections 5 and 8).

## Rollback

1. Turn `enabled` OFF (stops recording and the re-check). Turn `customer_sms_enabled` OFF first if SMS are the concern; it stops sends on its own.
2. Optionally disable the job: `npx tsx scripts/sync-cronjob-org.ts --disable A --only /api/cron/mtn-blocked-recheck`.
3. Nothing else changes: no order, wallet or payment path was modified, and the block decision is the same as before.
4. The tables are additive and can stay. They hold phone numbers, so if you want them gone, ask for a separate, reviewed drop migration (do not drop by hand).
