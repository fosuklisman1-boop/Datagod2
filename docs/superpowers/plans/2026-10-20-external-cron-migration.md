# External Cron Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the 39 Vercel cron jobs in `vercel.json` to cron-job.org via a dry-run-first sync script, cut over in batches with no gaps, and end with no `crons` block (except money/fulfillment routes proven too slow, which stay on Vercel).

**Architecture:** Pure logic (cron-expression conversion, job payloads, diff/budget) lives in `lib/cron-migration/` with Vitest tests. A thin `scripts/sync-cronjob-org.ts` does the HTTP and CLI. Cutover is a runbook executed per batch: enable externally, remove from `vercel.json`, deploy, verify.

**Tech Stack:** TypeScript, Vitest (`npm run test:run`), `tsx` + `dotenv` (both already in package.json), cron-job.org REST API (`https://api.cron-job.org`).

**Spec:** `docs/superpowers/specs/2026-10-20-external-cron-migration-design.md`

## Global Constraints

- Production host is `https://www.datagod.store`; jobs are GET requests with header `Authorization: Bearer <CRON_SECRET>`.
- Timezone UTC (Vercel crons are UTC).
- cron-job.org API budget: 100 requests/day; the script refuses to run past 80 calls/day.
- Secrets (`CRON_SECRET`, `CRONJOB_API_KEY`) are read from `.env.local` at run time; never on a command line, never in the repo, never logged.
- Script touches only jobs whose URL host is `www.datagod.store`; never the `mdatagh.com` job.
- Jobs are created **disabled**. Retries off for fulfillment-class jobs; failure notification only for them.
- Before pushing to main: run a real `next build` with placeholder env, and check local main for other sessions' commits (user's standing rules).
- Use Edit/Write for code changes, not sed.
- No route logic changes except Task 7's per-route return-immediately changes, each TDD'd.

## Review Focus

- `*/2`, `*/5`, `*/10`, `*/30` steps and `7 * * * *`, `0 6 * * *`, `30 3 * * *` convert to the exact minute/hour sets Vercel used (off-by-one in step lists).
- Re-running the script twice makes zero create calls the second time (idempotent).
- The 6 jobs already in the account are never modified unless their URL matches a desired job; `mdatagh.com` job untouched.
- API key or CRON_SECRET never appear in printed output, dry-run table, or error messages.
- Apex→www redirect would drop the Authorization header; preflight fails loudly instead of creating jobs.
- Budget counter survives restarts and a new UTC day resets it.

---

### Task 0: Verify the cron-job.org API shape and dashboard limits (no code)

The payload field names below come from memory and must be confirmed (user's rule: verify external API assumptions).

- [ ] **Step 1:** Fetch `https://docs.cron-job.org/rest-api.html` and record, in a comment block at the top of `lib/cron-migration/cronjob-api.ts` (Task 4), the exact shape of: create (`PUT /jobs`), update (`PATCH /jobs/{id}`), list (`GET /jobs`); schedule fields (`timezone`, `hours`, `mdays`, `minutes`, `months`, `wdays`, `-1` = every); header field (`extendedData.headers`); `enabled`; failure-notification and retry settings; any per-job timeout field.
- [ ] **Step 2:** User reads from the dashboard and reports: max jobs, minimum interval, request timeout. Stop and re-scope if max jobs < 45 (39 + the 6 existing) or minimum interval > 1 minute.

### Task 1: Cron expression → cron-job.org schedule

**Files:**
- Create: `lib/cron-migration/schedule.ts`
- Test: `lib/cron-migration/schedule.test.ts`

**Interfaces:**
- Produces: `type JobSchedule = { timezone: "UTC"; hours: number[]; mdays: number[]; minutes: number[]; months: number[]; wdays: number[] }` and `cronToSchedule(expr: string): JobSchedule`. `[-1]` means "every". Throws on unsupported syntax.

- [ ] **Step 1:** Write failing tests with these exact cases: `"* * * * *"` → minutes `[-1]`, hours `[-1]`; `"*/2 * * * *"` → minutes `[0,2,...,58]` (30 values); `"*/5 * * * *"`, `"*/10 * * * *"` and `"*/30 * * * *"` → `[0,5,...,55]`, `[0,10,...,50]`, `[0,30]`; `"7 * * * *"` → minutes `[7]`; `"0 0 * * *"` → hours `[0]`, minutes `[0]`; `"0 6 * * *"` → hours `[6]`; `"30 3 * * *"` → minutes `[30]`, hours `[3]`; `"0 * * * *"` → minutes `[0]`, hours `[-1]`; `"1-5 * * * *"` throws `/unsupported/`.
- [ ] **Step 2:** Run `npx vitest run lib/cron-migration/schedule.test.ts`; expect FAIL (module missing).
- [ ] **Step 3:** Implement `cronToSchedule` supporting only `*`, `*/N`, and a single integer per field; day-of-month, month, weekday must be `*`.
- [ ] **Step 4:** Run the same command; expect PASS.
- [ ] **Step 5:** Add one test that parses every `crons[].schedule` in the real `vercel.json` without throwing; run; PASS.
- [ ] **Step 6:** Commit `feat(cron-migration): convert vercel cron expressions to cron-job.org schedules`.

### Task 2: Job specs, batches, and fulfillment class

**Files:**
- Create: `lib/cron-migration/jobs.ts`
- Test: `lib/cron-migration/jobs.test.ts`

**Interfaces:**
- Consumes: `cronToSchedule`.
- Produces:
  - `type JobSpec = { path: string; cron: string; title: string; url: string; schedule: JobSchedule; batch: "A"|"B"|"C"; fulfillment: boolean }`
  - `buildJobSpecs(vercelCrons: {path:string; schedule:string}[], host: string): JobSpec[]`
  - `toCreatePayload(spec: JobSpec, cronSecret: string): object` (disabled, GET, Bearer header, `fulfillment` ⇒ retries off + failure notification on)
  - `redactSecret(text: string, secret: string): string`.
- Batch rules: **A** = daily/hourly/≥5-minute non-fulfillment jobs (check-subscription-expiry, check-subscriptions, mtn-whitelist-retry, sms-kyc-purge, release-held-mtn-orders, sms-senderid-poll, check-mtn-balance, sms-contact-verify, sms-delivery-sync, expire-stale-airtime). **B** = every-1–2-minute non-fulfillment (run-ai-tasks, drain-broadcasts, wa-delivery-notify, sms-pending-credits, sms-send-drain, sms-scheduled, sms-hubtel-dlr, security-alerts, phone-verify). **C** = fulfillment class: everything under `sync-mtn-status`, `sync-afa-status`, `sync-codecraft-status`, `sync-digiwapy`, plus hubtel-callbacks, hubtel-status-check, hubtel-cs-status-check, verify-pending-payments, withdrawals-status-check, drain-fulfillment-queue, reconcile-paystack-refunds (`fulfillment: true`).
- Title is `dg:<path>` (the ownership prefix).

- [ ] **Step 1:** Tests: every real `vercel.json` cron gets exactly one batch (no unclassified path throws); 39 specs; payload for `/api/cron/drain-fulfillment-queue` has `enabled: false`, GET, header `Authorization: Bearer test-secret`, retries off; payload for a batch-A job contains no retry/notification overrides; `redactSecret("Bearer abc", "abc")` contains no `abc`.
- [ ] **Step 2:** Run `npx vitest run lib/cron-migration/jobs.test.ts`; FAIL.
- [ ] **Step 3:** Implement per the Interfaces block; map to the real API field names recorded in Task 0.
- [ ] **Step 4:** Run; PASS.
- [ ] **Step 5:** Commit `feat(cron-migration): job specs, batches and create payloads`.

### Task 3: Diff and daily API budget

**Files:**
- Create: `lib/cron-migration/plan.ts`
- Test: `lib/cron-migration/plan.test.ts`

**Interfaces:**
- Consumes: `JobSpec`.
- Produces:
  - `type ExistingJob = { jobId: number; title: string; url: string; enabled: boolean }`
  - `type Action = { kind: "create"|"update"|"skip"; spec: JobSpec; jobId?: number; reason?: string }`
  - `planActions(specs: JobSpec[], existing: ExistingJob[], host: string): Action[]`
  - `checkBudget(state: {day: string; used: number} | null, today: string, needed: number, cap?: number): {ok: boolean; state: {day: string; used: number}}` (cap default 80; resets when `day !== today`).
- Rules: existing job with the same URL is **adopted** (`update` only if schedule/headers differ, else `skip`); URLs on other hosts are never matched; a second run over the same state yields all `skip`.

- [ ] **Step 1:** Tests: empty account → 39 `create`; account containing `check-subscription-expiry` and `check-subscriptions` with matching URLs → those 2 `skip` (or `update`), 37 `create`; existing `https://www.mdatagh.com/api/cron/verify-pending-payments` never matched to the `www.datagod.store` spec; `checkBudget` with used 70, needed 15 → `ok: false`; with a different day → `ok: true`, used reset.
- [ ] **Step 2:** Run `npx vitest run lib/cron-migration/plan.test.ts`; FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; PASS.
- [ ] **Step 5:** Commit `feat(cron-migration): idempotent diff and daily API budget guard`.

### Task 4: API client and CLI script

**Files:**
- Create: `lib/cron-migration/cronjob-api.ts` (list/create/update/delete over `fetch`, base `https://api.cron-job.org`, API-shape notes from Task 0 in a header comment)
- Create: `scripts/sync-cronjob-org.ts`
- Modify: `.gitignore` (add `.cron-sync-budget.json`)
- Test: `lib/cron-migration/cronjob-api.test.ts` (fake `fetch`)

**Interfaces:**
- Consumes: `buildJobSpecs`, `toCreatePayload`, `planActions`, `checkBudget`, `redactSecret`.
- Produces CLI flags: default **dry run** (prints the action table; zero API calls; shows spec URLs and schedules but never headers); `--apply` creates/updates (disabled); `--enable <A|B|C>` enables that batch's jobs; `--disable <A|B|C>` disables them; `--only <path>` limits to one route (used for one-at-a-time money cutover).

- [ ] **Step 1:** Tests with a fake `fetch`: `listJobs` parses `{jobs:[...]}`; `createJob` returns `jobId`; non-2xx throws an error whose message contains no API key; 429 is not retried (no hidden budget burn).
- [ ] **Step 2:** Run `npx vitest run lib/cron-migration/cronjob-api.test.ts`; FAIL.
- [ ] **Step 3:** Implement the client, then the script: load `.env.local` with `dotenv`, require `CRONJOB_API_KEY` and `CRON_SECRET`, run the **redirect preflight** (GET host root with `redirect: "manual"`; abort if apex/www redirects before the final host), enforce `checkBudget` before any call, persist the counter to `.cron-sync-budget.json` after each call.
- [ ] **Step 4:** Run `npx vitest run lib/cron-migration` and `npx tsc --noEmit`; PASS.
- [ ] **Step 5:** Run `npx tsx scripts/sync-cronjob-org.ts` (dry run). Expected: table of 39 rows, 2 adopted, 37 to create, no secret in output. User reviews.
- [ ] **Step 6:** Commit `feat(cron-migration): sync script with dry-run default and API budget`.

### Task 5: Idempotence audit of all 39 routes

**Files:**
- Create: `docs/superpowers/plans/2026-10-20-cron-idempotence-audit.md`

- [ ] **Step 1:** For each route in batches B and C, read the handler and record: safe to run twice concurrently? (yes/no/why). Pay special attention to drain-fulfillment-queue, verify-pending-payments, withdrawals-status-check, reconcile-paystack-refunds, the `sync-*` status syncs (stale-row and false-completed history), and hubtel-callbacks.
- [ ] **Step 2:** Mark any route that is **not** safe; those get a no-overlap cutover (remove from `vercel.json` and deploy first, enable externally right after, accepting a brief gap). Review the audit with the user.

### Task 6: Measure durations of the 12 `maxDuration = 300` routes

**Files:**
- Modify: the audit doc (add a duration table)

- [ ] **Step 1:** Collect p50/p95/max run time per route from the user's Vercel logs export (or timing from logs after the first external runs). Do **not** invoke money routes just to time them.
- [ ] **Step 2:** Classify each of the 12: fits the cron-job.org timeout (confirmed in Task 0) → moves as is; exceeds and non-fulfillment → Task 7; exceeds and fulfillment → stays on Vercel, listed in the audit doc and in the design's open items. Get the user's OK on the staying list.

### Task 7: Return-immediately change for slow non-fulfillment routes (only those Task 6 flags)

**Files (per route):**
- Modify: `app/api/cron/<route>/route.ts`
- Test: the route's existing or new `route.test.ts`

- [ ] **Step 1:** Write a failing test: handler returns a 200 JSON body within the timeout while the work continues (use Next's `after()` or equivalent, matching what the repo already uses); unauthorized request still returns 401.
- [ ] **Step 2:** Run it to see it fail, implement, run to see it pass, run the route's other tests.
- [ ] **Step 3:** Commit per route: `fix(cron): <route> responds immediately and finishes in the background`.

### Task 8: Cutover runbook, executed batch by batch

Order: **A, then B, then C** (C one provider/route at a time using `--only`). Repeat for each batch:

- [ ] **Step 1 (precheck):** `npx tsx scripts/sync-cronjob-org.ts` (dry run) shows only expected actions; budget has room.
- [ ] **Step 2:** `--apply` (jobs created disabled). User spot-checks 2–3 jobs in the dashboard.
- [ ] **Step 3:** `--enable <batch>`. Leave `vercel.json` unchanged for the overlap window (Task 5 says overlap is safe); for routes marked unsafe, remove from `vercel.json` and deploy first.
- [ ] **Step 4:** Edit `vercel.json` with the Edit tool to remove the batch's entries. Run `npm run test:run`, then a real `next build` with placeholder env. Check local main for other sessions' commits, push, watch the deploy.
- [ ] **Step 5 (verify):** In cron-job.org history and app logs, confirm each job in the batch ran successfully at its schedule and each route did real work (not just a 401). In Vercel, confirm those crons no longer invoke.
- [ ] **Step 6 (rollback if anything fails):** re-add the entries to `vercel.json`, redeploy, `--disable <batch>`. No cron-job.org API calls are needed to restore the Vercel schedule.

### Task 9: Wrap-up

- [ ] **Step 1:** Remove the `crons` block if empty (keep only the routes that stayed on Vercel); deploy; confirm no unexpected invocations.
- [ ] **Step 2:** User rotates the cron-job.org API key and removes the stale disabled legacy jobs (7128750, 7129293) if no longer needed.
- [ ] **Step 3:** Save a project memory file `project-external-cron-migration.md` (what moved, what stayed, host, how to re-run the script) and add its line to `MEMORY.md`.
- [ ] **Step 4:** Commit `docs: record cron migration outcome`.
