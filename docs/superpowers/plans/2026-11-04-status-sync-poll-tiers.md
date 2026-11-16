# Status-Sync Poll Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut Vercel Fluid Provisioned Memory (61% of the $38.46 Oct usage bill) by having the provider status-sync crons poll only fresh orders on most runs, instead of re-polling the same stuck orders with 1-2 s sleeps every run.

**Architecture:** `lib/status-sync-window.ts` already gives every per-provider sync one shared "earliest created_at to poll" (7 days, or all-time during the 03:00 UTC daily sweep). This plan adds a third, narrower tier: on a normal run only the last 6 hours are polled; the full 7-day window is polled only during a 5-minute "hourly slot" (minutes 00-04); the daily sweep is unchanged. All 10 per-provider routes pick this up through the existing helper with no route edits. The Apex Prime AFA sync, which has no window at all, is wired to the same helper.

**Tech Stack:** Next.js 15 route handlers, Supabase JS client, Vitest.

**Spec:** No separate spec. Evidence gathered 2026-11-04 (this plan's "Why" section is the spec). Builds on commit e10c82d8 (the 7-day window + daily sweep).

## Why (the evidence)

- Invoice WCDIAURR-0014 (Oct 2-Nov 1): $38.46 usage, Fluid Provisioned Memory $23.46. Billing charges API: datagod used 119.6 GB-hours of provisioned memory on Oct 29 (about 5 GB held around the clock).
- Open `mtn_fulfillment_tracking` rows (pending/processing) on 2026-11-04: agentportalgh 117 in the 7-day window but only **9 from the last 6 h**. apexprime 56 in the window and **0 from the last 24 h**.
- `sync-mtn-status/agentportalgh` (every 5 min, cron-job.org) and `sync-mtn-status/apexprime` (every 5 min) each take up to 50 rows oldest-first with `await sleep(1000)` between provider calls, so most of each run is spent re-checking orders that won't change.
- `sync-afa-status/apexprime` (every minute, vercel.json) has **no created_at window**: 37 pending AFA rows (30 older than 7 days) polled oldest-first every minute.
- Webhooks deliver most results: agentportalgh 10,351 of 11,089 orders (93%) in the last 30 days arrived by webhook, so polling is a safety net there. Exception: spfastit received 0 of 140 by webhook. For spfastit, orders older than 6 h will now be re-checked hourly, not every minute. Orders normally finish in minutes, so anything older than 6 h is already stuck.

## Global Constraints

- `SYNC_WINDOW_DAYS` stays `7`. The daily sweep stays 03:00-03:04 UTC and reaches back to 2000-01-01.
- New constants: `RECENT_WINDOW_HOURS = 6`; hourly slot = UTC minutes `0-4` of every hour.
- Precedence: daily sweep > hourly slot > recent window.
- No change to cron schedules, batch sizes, sleep delays, status-priority logic, notifications or order-table writes.
- Logic lives in `lib/` with Vitest tests (TDD). Use Edit/Write tools only — no sed for code edits.
- Work on a fresh branch off `main` in a worktree (`superpowers:using-git-worktrees`), NOT on `feat/api-v2-console`.

## Review Focus

1. **A */5 cron hits the hourly slot exactly once an hour.** cron-job.org fires `*/5` crons at :00, :05 and so on, so the :00 run lands in minutes 0-4. Test: a :00 run gets the 7-day window and a :05 run gets 6 h.
2. **A row aged 6 h to 7 d isn't polled for up to an hour.** This is accepted; the test pins the tier boundaries so nobody "fixes" it by accident. Caveat (final review): this holds only while the 7-day backlog is at most BATCH_SIZE (50); routes take the oldest rows first, so with a bigger backlog newer 6h-7d rows wait until it shrinks. Pre-existing behavior, not made worse here.
3. **Clock skew or a late cron-job.org fire (:05:30 instead of :05:00)** stays a normal run, not a missed slot. The slot depends only on the minute value, so nothing breaks.
4. **AFA rows can legitimately stay pending for days** while MTN approves them. They still get checked hourly (inside 7 d) and daily (older), never dropped. Test: the AFA route's select uses `syncWindowStartIso()`.
5. **The daily sweep must still win at 03:00-03:04** even though that is also an hourly slot. Test: 03:00 returns the all-time start, not 7 days.

---

### Task 1: Three-tier sync window

**Files:**
- Modify: `lib/status-sync-window.ts`
- Test: `lib/status-sync-window.test.ts`

**Interfaces:**
- Produces: `export const RECENT_WINDOW_HOURS = 6`, `export function isHourlySlot(now?: Date): boolean`. `syncWindowStartIso(now?: Date): string` keeps the same signature with the new tiering. Every existing caller is unchanged.

- [ ] **Step 1: Write the failing tests.** Replace the `"is 7 days back on a normal run"` case and add:

```ts
const HOUR = 60 * 60 * 1000

describe("syncWindowStartIso tiers", () => {
  it("is 6 hours back on a normal run", () => {
    const now = at("2026-10-21T12:34:00Z")
    expect(RECENT_WINDOW_HOURS).toBe(6)
    expect(syncWindowStartIso(now)).toBe(new Date(now.getTime() - 6 * HOUR).toISOString())
  })
  it("is 7 days back during the hourly slot (minutes 0-4)", () => {
    for (const iso of ["2026-10-21T12:00:00Z", "2026-10-21T12:04:59Z"]) {
      const now = at(iso)
      expect(SYNC_WINDOW_DAYS).toBe(7)
      expect(syncWindowStartIso(now)).toBe(new Date(now.getTime() - 7 * DAY).toISOString())
    }
  })
  it("a */5 cron gets the 6-hour window at :05", () => {
    const now = at("2026-10-21T12:05:00Z")
    expect(syncWindowStartIso(now)).toBe(new Date(now.getTime() - 6 * HOUR).toISOString())
  })
  it("daily sweep wins over the hourly slot at 03:00", () => {
    expect(new Date(syncWindowStartIso(at("2026-10-21T03:00:00Z"))).getUTCFullYear()).toBeLessThan(2010)
  })
})

describe("isHourlySlot", () => {
  it("is true only for minutes 0-4", () => {
    expect(isHourlySlot(at("2026-10-21T15:00:00Z"))).toBe(true)
    expect(isHourlySlot(at("2026-10-21T15:04:59Z"))).toBe(true)
    expect(isHourlySlot(at("2026-10-21T15:05:00Z"))).toBe(false)
    expect(isHourlySlot(at("2026-10-21T15:59:59Z"))).toBe(false)
  })
})
```

Add `RECENT_WINDOW_HOURS, isHourlySlot` to the import. Keep the existing `isDailySweep` and "provider status syncs use the window" tests unchanged.

- [ ] **Step 2: Run, expect FAIL** (`RECENT_WINDOW_HOURS`/`isHourlySlot` not exported).
Run: `npx vitest run lib/status-sync-window.test.ts`

- [ ] **Step 3: Implement.** Add `RECENT_WINDOW_HOURS = 6`, `HOURLY_SLOT_MINUTES = 5`, `isHourlySlot(now) = now.getUTCMinutes() < HOURLY_SLOT_MINUTES`. In `syncWindowStartIso`: daily sweep → 2000-01-01; else hourly slot → now − 7 d; else now − 6 h. Update the file's header comment to describe the three tiers and the 2026-11-04 evidence (one short paragraph).

- [ ] **Step 4: Run, expect PASS.** `npx vitest run lib/status-sync-window.test.ts`. Then run the whole suite with `npm run test:run`. The only failures allowed are the 9 known order-health ones.

- [ ] **Step 5: Commit** `perf(cron): status syncs poll the last 6h normally, 7d hourly, all daily`

### Task 2: Wire the Apex Prime AFA sync to the window

**Files:**
- Modify: `app/api/cron/sync-afa-status/apexprime/route.ts` (the `syncTable` select, around lines 36-43)
- Test: `lib/status-sync-window.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `syncWindowStartIso()` from Task 1.

- [ ] **Step 1: Write the failing test.**

```ts
describe("AFA apexprime sync uses the window", () => {
  it("filters pending AFA rows by created_at >= syncWindowStartIso()", () => {
    const src = readFileSync(join(__dirname, "../app/api/cron/sync-afa-status/apexprime/route.ts"), "utf8")
    expect(src).toMatch(/\.eq\("fulfillment_status", "pending"\)[\s\S]{0,120}\.gte\("created_at", syncWindowStartIso\(\)\)/)
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Import `syncWindowStartIso` from `@/lib/status-sync-window` and add `.gte("created_at", syncWindowStartIso())` right after the `.not("fulfillment_ref", "is", null)` line. Before relying on the test, confirm with `rg "sync-afa-status" lib app -g "*.test.ts"` that the existing AFA wiring test still passes.
- [ ] **Step 4: Run** `npx vitest run lib/status-sync-window.test.ts` plus any AFA test files, and expect PASS. Then run `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `perf(cron): AFA apexprime sync uses the shared poll window`

### Task 3: Stale-order re-check route (ask the provider, then decide)

**Why:** on 2026-11-09, 123 tracking rows have been open for more than 7 days: **59 agentportalgh** (31 with no provider reply ever, 28 "Order in flight (not yet found in order listing)", last touched Nov 2-3) and **64 Sykes** (last touched Oct 23, mostly no provider message). The owner chose: ask the provider once more, apply only answers the provider confirms, and list everything else for a manual decision. The ~950 rows the owner bulk-completed on 2026-11-05 are **out of scope** and must not be touched. Provider API keys are write-only Vercel secrets, so this can't be a local script. It has to be an admin route running in production.

**Files:**
- Create: `lib/stale-tracking-recheck.ts` (pure classifier, no I/O)
- Test: `lib/stale-tracking-recheck.test.ts`
- Create: `app/api/admin/stale-tracking/recheck/route.ts`

**Interfaces:**
- Produces: `export type RecheckVerdict = "confirm_completed" | "confirm_failed" | "unresolved"` and `export function classifyRecheck(result: { success: boolean; status?: string; message?: string }): RecheckVerdict`.
- Consumes: `checkMTNOrderStatus(mtnOrderId, providerName)` and `syncMTNOrderStatus(trackingId)` from `lib/mtn-fulfillment.ts` (the latter already blocks backwards status changes and updates the tracking row and order table together), and `verifyAdminAccess` from `@/lib/admin-auth`.

- [ ] **Step 1: Write the failing tests** in `lib/stale-tracking-recheck.test.ts`:

```ts
it("confirms completed only when the provider call succeeded and says completed", () => {
  expect(classifyRecheck({ success: true, status: "completed" })).toBe("confirm_completed")
})
it("confirms failed only when the provider call succeeded and says failed", () => {
  expect(classifyRecheck({ success: true, status: "failed" })).toBe("confirm_failed")
})
it.each([
  [{ success: true, status: "processing", message: "Order in flight (not yet found in order listing)" }],
  [{ success: true, status: "pending" }],
  [{ success: false, message: "Service temporarily unavailable" }],
  [{ success: false, status: "completed" }],   // a failed call never counts as an answer
  [{ success: true }],                         // no status
])("everything else is unresolved: %o", (r) => {
  expect(classifyRecheck(r)).toBe("unresolved")
})
```

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run lib/stale-tracking-recheck.test.ts`
- [ ] **Step 3: Implement `classifyRecheck`** so it returns a confirmed verdict only when `success === true` and `status` is exactly `"completed"` or `"failed"`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Implement the route** `POST /api/admin/stale-tracking/recheck`:
  - `verifyAdminAccess(request)` first. Return its `errorResponse` when the caller isn't an admin.
  - Body `{ apply?: boolean, olderThanDays?: number, limit?: number, afterId?: string }`. Defaults: `apply=false`, `olderThanDays=7` (reject below 7), `limit=40` (cap at 40 so a run stays under `maxDuration = 300`), `afterId` is a paging cursor ordered by `id`.
  - Select rows from `mtn_fulfillment_tracking` where `provider in ('agentportalgh','sykes')`, `status in ('pending','processing')`, `created_at < now − olderThanDays`, `mtn_order_id` is not null, `id > afterId`, ordered by `id` and limited to `limit`.
  - For each row, call `checkMTNOrderStatus(row.mtn_order_id, row.provider)` and then `classifyRecheck`. Wait 1,000 ms between calls (same pacing as the crons).
  - `apply=true` acts on **`confirm_completed` rows only**, through `syncMTNOrderStatus(row.id)`. `confirm_failed` rows are never applied: inside `syncMTNOrderStatus`, a failed result puts the order back to `pending`, and that would resend a week-old paid order. They go in the report for the owner to decide between refund and resend.
  - Response: `{ apply, checked, nextAfterId, counts: { confirm_completed, confirm_failed, unresolved, applied }, rows: [{ id, provider, order_type, created_at, providerStatus, providerMessage, verdict, applied }] }`. No phone numbers or customer fields in the response or logs.
  - When `apply=true`, insert one `admin_audit_log` row per call, following the shape used in `app/api/admin/packages/network-stock/route.ts:67`: `action: "stale_tracking_recheck"`, `old_value: { ids }`, `new_value: counts`.
- [ ] **Step 6: Verify** with `npx tsc --noEmit`, then `npm run test:run` (only the 9 known order-health failures are allowed).
- [ ] **Step 7: Commit** `feat(admin): re-check stale tracking rows with the provider; apply only confirmed completions`

### Task 4: Ship, clean up and measure

- [ ] **Step 1: Fresh review.** This touches order-status paths, so it needs a fresh reviewer (`superpowers:requesting-code-review`) on the branch diff. Fix any confirmed findings test-first.
- [ ] **Step 2: Real build.** Run `npm run build` with placeholder env. It must pass, because tsc and vitest miss Next route-export problems.
- [ ] **Step 3: Merge to main.** First check local `main` for other sessions' commits (`git log origin/main..main`). Then merge, push, and watch the Vercel deploy reach READY.
- [ ] **Step 4: Live check.** At the next :00-:04 slot and again at a non-slot minute, read the Vercel runtime logs for `[CRON-AGENTPORTALGH] Found N orders to sync`. Expect N at most 9 (plus recent failures) outside the slot, and up to 50 in the slot.
- [ ] **Step 5: Stale cleanup dry run.** Run the precheck count in SQL first: the number of open rows older than 7 days for agentportalgh and sykes (123 on 2026-11-09). Then, as an admin, call `POST /api/admin/stale-tracking/recheck` with `{}` and page through with `afterId` until `nextAfterId` is null. Save the combined report to the scratchpad and show the owner the counts per verdict and provider.
- [ ] **Step 6: Owner OK, then apply.** Only after the owner approves, re-run every page with `{ "apply": true }`. Verify with SQL that each `confirm_completed` row is now `completed`, with its order table row, and that no other row changed. Hand the `confirm_failed` and `unresolved` lists to the owner to decide case by case (refund via /admin/refunds, or leave open). Nothing gets bulk-marked.
- [ ] **Step 7: Measure after 3 full days.** Pull `list_billing_charges` for single days (`teamId=team_f6Q50jzrhitengGoOyqusfmA`; a whole month exceeds the tool limit). Compare datagod's Fluid Provisioned Memory `ConsumedQuantity` with the baseline of **119.6 GB-h/day (Oct 29)**. Record the result in memory.

## Out of scope (with reasons)

- **Shorter `sleep()` delays / parallel checks:** we don't have the provider rate limits in writing (agentportalgh, apexprime). Changing them without docs risks 429s, and that's how the earlier silent incidents happened. Ask the providers first.
- **Main `sync-mtn-status` downloading 5,000 Sykes orders every minute:** the same response feeds a 30-day DB window, retry logic and reversal checks, so a smaller fetch needs its own analysis. Only 4 Sykes rows are open, so it's a separate follow-up.
- **The ~950 agentportalgh rows the owner bulk-marked completed on 2026-11-05** (08:57-09:12 UTC; this was intentional, per the owner on 2026-11-09). About 60 of them carry "provider refunded" or failure messages, so those customers may not have been delivered. Whether to refund them is a separate owner decision, not part of this plan.
- **Applying `confirm_failed` automatically:** `syncMTNOrderStatus` turns a failed result into an order back at `pending`, which can resend. For orders over a week old, the owner decides per order.
