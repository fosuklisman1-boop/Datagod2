# MTN completed→failed Reversal Safeguard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch when an MTN provider flips an order it previously reported `completed` back to `failed` (within 72h), and flag it to a new `reversed` status that is manually downloadable + per-line fulfillable and never auto-re-sent.

**Architecture:** A provider-agnostic helper (`lib/mtn-reversal.ts`) exposes a pure `isReversal()` predicate and a `flagReversal()` writer. Each of the 6 MTN sync crons additionally loads its provider's `completed`-within-72h tracking rows, obtains each order's current provider status *its own existing way* (Sykes = bulk-feed map lookup; EazyGhData/others = per-order `checkMTNOrderStatus`), and calls the helper. A one-line widening of `enforce_order_state_machine` permits `completed → reversed` only. Admin surfaces (all-pending, download, `/admin/orders`) treat `reversed` like a downloadable, per-line-fulfillable review queue.

**Tech Stack:** Next.js 15 App Router (route handlers), TypeScript, Supabase (`@supabase/supabase-js` service-role), Postgres trigger (plpgsql), Vitest (tests alongside as `*.test.ts`).

## Global Constraints

- `reversed` is NEVER added to auto-fulfillment pickup sets nor to any cron's re-poll `status` filter — it is a one-shot flag.
- `completed → pending` must remain blocked by `enforce_order_state_machine` (ERRCODE 23514). Only `completed → reversed` is newly permitted.
- Detection adds NO new provider API calls on bulk-feed crons (reuse the already-fetched map). On per-order crons, completed-row checks are bounded by that cron's existing batch/rate budget.
- Order status columns: `orders.status`, `api_orders.status` use `status`; `shop_orders`, `ussd_orders`, `ussd_shop_orders` use `order_status`. Tracking table is `mtn_fulfillment_tracking` (`status`, `external_status`, `external_message`, `updated_at`, `mtn_order_id`, `provider`, `order_type`, `order_id`, `shop_order_id`, `api_order_id`).
- Spec: `docs/superpowers/specs/2026-07-15-mtn-completed-to-failed-reversal-safeguard-design.md`.

---

## File Structure

- Create: `migrations/20260716_reversed_status_state_machine.sql` — widen the state-machine guard.
- Create: `lib/mtn-reversal.ts` — `isReversal()` (pure), `flagReversal()` (writer), `REVERSAL_WINDOW_MS`, `fetchReversalCandidates()`.
- Create: `lib/mtn-reversal.test.ts` — unit tests for the pure + writer logic.
- Modify: `app/api/cron/sync-mtn-status/route.ts` — Sykes (bulk feed) wiring.
- Modify: `app/api/cron/sync-mtn-status/eazyghdata/route.ts` — per-order cron wiring (template for xpress/bisdel/codecraft/datakazina crons).
- Modify: `app/api/cron/sync-mtn-status/{xpress,bisdel,codecraft,datakazina}/route.ts` — same per-order wiring.
- Modify: `app/api/webhooks/mtn/datakazina/route.ts` — route incoming `failed`-on-`completed` to `flagReversal`.
- Modify: `app/api/admin/orders/all-pending/route.ts` and `app/api/admin/orders/download/route.ts` — include `reversed`.
- Modify: `app/admin/orders/page.tsx` — `reversed` badge + filter + per-line Manual fulfill button (button reuses existing `POST /api/admin/fulfillment/manual-fulfill`).

---

## Task 1: Migration — permit `completed → reversed`

**Files:**
- Create: `migrations/20260716_reversed_status_state_machine.sql`

**Interfaces:**
- Produces: DB accepts `order_status` transition `completed → reversed`; still rejects `completed → pending` with ERRCODE 23514.

- [ ] **Step 1: Write the migration**

```sql
-- migrations/20260716_reversed_status_state_machine.sql
-- Permit ONLY completed -> reversed (the automated reversal safeguard). Every other exit
-- from completed stays blocked (notably completed -> pending). payment_status rule unchanged.
CREATE OR REPLACE FUNCTION public.enforce_order_state_machine()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.order_status = 'completed'
     AND NEW.order_status IS DISTINCT FROM 'completed'
     AND NEW.order_status IS DISTINCT FROM 'reversed' THEN
    RAISE EXCEPTION 'Invalid transition: order_status cannot move from completed to %', NEW.order_status
      USING ERRCODE = '23514';
  END IF;
  IF OLD.payment_status = 'completed' AND NEW.payment_status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'Invalid transition: payment_status cannot move from completed to %', NEW.payment_status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
```

- [ ] **Step 2: Apply it to the database**

Apply via the project's Management API SQL runner (see `reference-supabase-access`): POST the file contents to `https://api.supabase.com/v1/projects/riijesduargxlzxuperj/database/query`.

- [ ] **Step 3: Verify the new transition is allowed and the old one still blocked**

Run (expect the first UPDATE to succeed, the second to raise 23514) against a scratch/rolled-back transaction:
```sql
BEGIN;
-- pick any completed shop order id into :id first, or use a temp insert
UPDATE shop_orders SET order_status='reversed' WHERE order_status='completed' LIMIT 1;   -- expect: UPDATE 1
UPDATE shop_orders SET order_status='pending'  WHERE order_status='reversed' LIMIT 1;    -- expect: reversed->pending OK (guard only fires on OLD=completed)
-- prove completed->pending still blocked:
SAVEPOINT s; UPDATE shop_orders SET order_status='pending' WHERE order_status='completed' LIMIT 1;  -- expect: ERROR 23514
ROLLBACK;
```
Expected: `completed→reversed` succeeds; `completed→pending` raises `23514`.

- [ ] **Step 4: Commit**

```bash
git add migrations/20260716_reversed_status_state_machine.sql
git commit -m "feat(orders): allow completed->reversed transition for reversal safeguard"
```

---

## Task 2: Shared reversal helper + unit tests

**Files:**
- Create: `lib/mtn-reversal.ts`
- Test: `lib/mtn-reversal.test.ts`

**Interfaces:**
- Produces:
  - `REVERSAL_WINDOW_MS: number` (= 72h in ms)
  - `isReversal(args: { trackingStatus: string; completedAt: string | Date; providerStatus: string; now?: Date }): boolean`
  - `ReversalRow = { id: string; order_type: string | null; order_id: string | null; shop_order_id: string | null; api_order_id: string | null; provider: string | null }`
  - `flagReversal(supabase: SupabaseClient, row: ReversalRow, provider: { status?: string; message?: string }): Promise<{ flagged: boolean }>`
- Consumes: `@supabase/supabase-js` `SupabaseClient`; `notifyAdminsPush` from `@/lib/push-service`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/mtn-reversal.test.ts
import { describe, it, expect, vi } from "vitest"
import { isReversal, flagReversal, REVERSAL_WINDOW_MS } from "./mtn-reversal"

vi.mock("@/lib/push-service", () => ({ notifyAdminsPush: vi.fn().mockResolvedValue(undefined) }))

const now = new Date("2026-07-16T12:00:00Z")

describe("isReversal", () => {
  it("flags a completed row now reported failed, within window", () => {
    expect(isReversal({ trackingStatus: "completed", completedAt: "2026-07-16T06:00:00Z", providerStatus: "failed", now })).toBe(true)
  })
  it("ignores when provider still completed", () => {
    expect(isReversal({ trackingStatus: "completed", completedAt: "2026-07-16T06:00:00Z", providerStatus: "completed", now })).toBe(false)
  })
  it("ignores when the row is not completed", () => {
    expect(isReversal({ trackingStatus: "processing", completedAt: "2026-07-16T06:00:00Z", providerStatus: "failed", now })).toBe(false)
  })
  it("ignores completions older than the window", () => {
    const old = new Date(now.getTime() - REVERSAL_WINDOW_MS - 1000).toISOString()
    expect(isReversal({ trackingStatus: "completed", completedAt: old, providerStatus: "failed", now })).toBe(false)
  })
})

describe("flagReversal", () => {
  it("sets tracking + shop order to reversed and returns flagged", async () => {
    const updates: any[] = []
    const fake: any = {
      from(table: string) {
        return {
          update(vals: any) { updates.push({ table, vals }); return { eq: () => Promise.resolve({ error: null }) } },
        }
      },
    }
    const row = { id: "trk1", order_type: "shop", order_id: null, shop_order_id: "shop1", api_order_id: null, provider: "sykes" }
    const res = await flagReversal(fake, row, { status: "failed", message: "reversed by provider" })
    expect(res.flagged).toBe(true)
    expect(updates).toContainEqual(expect.objectContaining({ table: "mtn_fulfillment_tracking", vals: expect.objectContaining({ status: "reversed" }) }))
    expect(updates).toContainEqual(expect.objectContaining({ table: "shop_orders", vals: expect.objectContaining({ order_status: "reversed" }) }))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:run -- lib/mtn-reversal.test.ts`
Expected: FAIL — cannot find module `./mtn-reversal`.

- [ ] **Step 3: Implement the helper**

```ts
// lib/mtn-reversal.ts
import type { SupabaseClient } from "@supabase/supabase-js"
import { notifyAdminsPush } from "@/lib/push-service"

export const REVERSAL_WINDOW_MS = 72 * 60 * 60 * 1000

export type ReversalRow = {
  id: string
  order_type: string | null
  order_id: string | null
  shop_order_id: string | null
  api_order_id: string | null
  provider: string | null
}

/** A completed tracking row whose provider now reports failed, still inside the 72h window. */
export function isReversal(args: {
  trackingStatus: string
  completedAt: string | Date
  providerStatus: string
  now?: Date
}): boolean {
  if (args.trackingStatus !== "completed") return false
  if (args.providerStatus !== "failed") return false
  const now = args.now ?? new Date()
  const completed = new Date(args.completedAt).getTime()
  return now.getTime() - completed <= REVERSAL_WINDOW_MS
}

// Which order table + status column does this tracking row point at?
function orderTarget(row: ReversalRow): { table: string; col: "status" | "order_status"; id: string } | null {
  if (row.order_type === "bulk" && row.order_id) return { table: "orders", col: "status", id: row.order_id }
  if (row.order_type === "api" && (row.api_order_id || row.order_id)) return { table: "api_orders", col: "status", id: (row.api_order_id || row.order_id)! }
  if (row.order_type === "ussd" && row.order_id) return { table: "ussd_orders", col: "order_status", id: row.order_id }
  if (row.order_type === "ussd_shop" && row.order_id) return { table: "ussd_shop_orders", col: "order_status", id: row.order_id }
  if (row.shop_order_id) return { table: "shop_orders", col: "order_status", id: row.shop_order_id }
  return null
}

/** Flag a provider reversal: tracking + order -> 'reversed', notify admins. Idempotent-safe. */
export async function flagReversal(
  supabase: SupabaseClient,
  row: ReversalRow,
  provider: { status?: string; message?: string },
): Promise<{ flagged: boolean }> {
  const nowIso = new Date().toISOString()

  await supabase
    .from("mtn_fulfillment_tracking")
    .update({ status: "reversed", external_status: provider.status ?? "failed", external_message: provider.message ?? null, updated_at: nowIso })
    .eq("id", row.id)

  const target = orderTarget(row)
  if (target) {
    await supabase.from(target.table).update({ [target.col]: "reversed", updated_at: nowIso }).eq("id", target.id)
  }

  const ref = row.shop_order_id || row.order_id || row.api_order_id || row.id
  notifyAdminsPush({
    title: "⚠️ Provider reversed a completed order",
    body: `${row.provider ?? "provider"} flipped order #${String(ref).slice(0, 8)} completed→failed — flagged for review`,
    data: { url: "/admin/orders" },
  }).catch(() => {})

  return { flagged: true }
}

/** Load completed tracking rows for a provider that are still inside the 72h reversal window. */
export async function fetchReversalCandidates(supabase: SupabaseClient, provider: string, limit = 200): Promise<ReversalRow[]> {
  const since = new Date(Date.now() - REVERSAL_WINDOW_MS).toISOString()
  const { data } = await supabase
    .from("mtn_fulfillment_tracking")
    .select("id, mtn_order_id, order_type, order_id, shop_order_id, api_order_id, provider, status, updated_at")
    .eq("provider", provider)
    .eq("status", "completed")
    .gte("updated_at", since)
    .not("mtn_order_id", "is", null)
    .order("updated_at", { ascending: false })
    .limit(limit)
  return (data as any[]) ?? []
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:run -- lib/mtn-reversal.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/mtn-reversal.ts lib/mtn-reversal.test.ts
git commit -m "feat(mtn): add reversal detector + flag writer (lib/mtn-reversal)"
```

---

## Task 3: Wire detection into the Sykes cron (bulk-feed)

**Files:**
- Modify: `app/api/cron/sync-mtn-status/route.ts`

**Interfaces:**
- Consumes: `fetchReversalCandidates`, `isReversal`, `flagReversal` from `@/lib/mtn-reversal`; the existing `sykesOrderMap` (Map keyed by `String(mtn_order_id)`), the existing local `normalizeStatus()`.

- [ ] **Step 1: Import the helper**

At the top of `app/api/cron/sync-mtn-status/route.ts`, add:
```ts
import { fetchReversalCandidates, isReversal, flagReversal } from "@/lib/mtn-reversal"
```

- [ ] **Step 2: After the existing sync loop completes (just before the final `NextResponse.json({...})` return), add reversal detection**

```ts
    // ── Reversal safeguard: provider flipped a completed order back to failed ──
    // Reuse the already-fetched sykesOrderMap — no extra provider calls.
    let reversed = 0
    const candidates = await fetchReversalCandidates(supabase, "sykes")
    for (const cand of candidates) {
      const providerOrder = sykesOrderMap.get(String((cand as any).mtn_order_id))
      if (!providerOrder?.status) continue
      const providerStatus = normalizeStatus(providerOrder.status)
      if (isReversal({ trackingStatus: "completed", completedAt: (cand as any).updated_at, providerStatus })) {
        await flagReversal(supabase, cand, { status: providerOrder.status, message: providerOrder.message })
        reversed++
        console.log(`[CRON] ⚠️ Reversal flagged for ${(cand as any).mtn_order_id} (sykes)`)
      }
    }
```
Add `reversed` to the returned JSON payload (e.g. `reversed,` alongside `synced`).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/sync-mtn-status/route.ts
git commit -m "feat(cron): detect completed->failed reversals in Sykes sync"
```

---

## Task 4: Wire detection into the per-order crons + datakazina webhook

**Files:**
- Modify: `app/api/cron/sync-mtn-status/eazyghdata/route.ts` (worked example)
- Modify: `app/api/cron/sync-mtn-status/xpress/route.ts`, `.../bisdel/route.ts`, `.../codecraft/route.ts`, `.../datakazina/route.ts`
- Modify: `app/api/webhooks/mtn/datakazina/route.ts`

**Interfaces:**
- Consumes: `fetchReversalCandidates`, `isReversal`, `flagReversal` from `@/lib/mtn-reversal`; each cron's existing `checkMTNOrderStatus(mtnOrderId, providerKey)` call.

- [ ] **Step 1: Add imports to `eazyghdata/route.ts`**

```ts
import { fetchReversalCandidates, isReversal, flagReversal } from "@/lib/mtn-reversal"
```

- [ ] **Step 2: After the existing per-order sync loop (before the final return), add a bounded reversal sweep**

Per-order providers cost one API call per candidate, so bound it to the same rate budget (`BATCH_SIZE`). `checkMTNOrderStatus` already returns a normalized `.status`.
```ts
        // ── Reversal safeguard (bounded to stay within rate limits) ──
        let reversed = 0
        const candidates = await fetchReversalCandidates(supabase, "eazyghdata", BATCH_SIZE)
        for (const cand of candidates) {
            const chk = await checkMTNOrderStatus((cand as any).mtn_order_id, "eazyghdata")
            if (!chk.success || !chk.status) { await sleep(DELAY_BETWEEN_REQUESTS_MS); continue }
            if (isReversal({ trackingStatus: "completed", completedAt: (cand as any).updated_at, providerStatus: chk.status })) {
                await flagReversal(supabase, cand, { status: chk.order?.status ?? "failed", message: chk.message })
                reversed++
                console.log(`[CRON-EAZYGHDATA] ⚠️ Reversal flagged for ${(cand as any).mtn_order_id}`)
            }
            await sleep(DELAY_BETWEEN_REQUESTS_MS)
        }
```
Add `reversed` to the returned JSON.

- [ ] **Step 3: Apply the same block to the other per-order crons**

For `xpress`, `bisdel`, `codecraft`, `datakazina` cron routes: first confirm each file's provider-status mechanism. If it bulk-fetches a map like Sykes, use Task 3's map-lookup block instead; if it calls `checkMTNOrderStatus` per order like EazyGhData, use Step 2's block with that file's provider key and its own batch/delay constants. Do NOT add extra provider calls beyond each file's existing batch budget.

- [ ] **Step 4: datakazina webhook — route failed-on-completed to flagReversal**

In `app/api/webhooks/mtn/datakazina/route.ts`, where an incoming status is applied: before writing a `failed` status, load the current tracking row; if it is already `status='completed'` and within the window, call `flagReversal` instead of the normal failed-write path.
```ts
import { isReversal, flagReversal } from "@/lib/mtn-reversal"
// ...when the webhook's normalized status is "failed":
if (existingTracking?.status === "completed" &&
    isReversal({ trackingStatus: "completed", completedAt: existingTracking.updated_at, providerStatus: "failed" })) {
  await flagReversal(supabase, existingTracking, { status: incomingStatus, message: "datakazina webhook reversal" })
  return NextResponse.json({ ok: true, reversed: true })
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/api/cron/sync-mtn-status/eazyghdata/route.ts app/api/cron/sync-mtn-status/xpress/route.ts app/api/cron/sync-mtn-status/bisdel/route.ts app/api/cron/sync-mtn-status/codecraft/route.ts app/api/cron/sync-mtn-status/datakazina/route.ts app/api/webhooks/mtn/datakazina/route.ts
git commit -m "feat(cron): detect reversals across per-order MTN providers + datakazina webhook"
```

---

## Task 5: Make `reversed` orders downloadable

**Files:**
- Modify: `app/api/admin/orders/all-pending/route.ts`
- Modify: `app/api/admin/orders/download/route.ts`

**Interfaces:**
- Produces: `reversed` orders appear in the admin pending/download queue and can be claimed → `processing` by a download.

- [ ] **Step 1: Include `reversed` in all-pending**

In `app/api/admin/orders/all-pending/route.ts`, change each per-table filter from `.eq("status"/"order_status", "pending")` to include reversed. For the `orders` and `api_orders` tables:
```ts
      .in("status", ["pending", "reversed"])
```
For `shop_orders`, `ussd_orders`, `ussd_shop_orders` (keep the existing `payment_status='completed'` filter):
```ts
      .in("order_status", ["pending", "reversed"])
```
Also select the status back (`status`/`order_status` are already selected) so the UI can badge it.

- [ ] **Step 2: Include `reversed` in the download claim**

In `app/api/admin/orders/download/route.ts` the filter path fetches `combined_orders_view` and the claim UPDATEs match `.eq("status","pending")` / `.eq("order_status","pending")`. Change the download's onlyPending filter and each claim's status match to accept both:
- filter fetch: where it does `.eq("status","pending")`, use `.in("status",["pending","reversed"])`.
- each claim UPDATE (bulk/shop/api/ussd/ussd_shop): change `.eq("status","pending")` → `.in("status",["pending","reversed"])` and `.eq("order_status","pending")` → `.in("order_status",["pending","reversed"])`, so a `reversed` order is claimed → `processing` exactly like a pending one. (`reversed → processing` is unguarded.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/orders/all-pending/route.ts app/api/admin/orders/download/route.ts
git commit -m "feat(orders): include reversed orders in the manual download queue"
```

---

## Task 6: Admin UI — badge, filter, and per-line Manual fulfill

**Files:**
- Modify: `app/admin/orders/page.tsx`

**Interfaces:**
- Consumes: existing `POST /api/admin/fulfillment/manual-fulfill` — body `{ shop_order_id: <orderId>, order_type: "shop"|"bulk"|"api"|"ussd"|"ussd_shop", provider? }` (note the param name is `shop_order_id` but it accepts any order id for the given `order_type`).

- [ ] **Step 1: Add a `reversed` status badge**

Wherever order status is rendered as a badge in `app/admin/orders/page.tsx`, add a `reversed` case with a distinct style (e.g. amber/`bg-warning/10 text-warning`, label "Reversed"). Follow the file's existing status-badge switch/map.

- [ ] **Step 2: Add a `reversed` filter/count**

Add `reversed` to the page's status filter control and show a count of reversed orders in the queue (mirror how `pending`/`failed` filters are implemented in this file).

- [ ] **Step 3: Add a per-line "Manual fulfill" button**

In the order-row actions, add a button shown for a row whose status is `reversed` (and optionally `pending`) that POSTs to the manual-fulfill endpoint for that single order:
```ts
async function manualFulfillOne(order: { id: string; type: string }) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch("/api/admin/fulfillment/manual-fulfill", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify({ shop_order_id: order.id, order_type: order.type }),
  })
  const json = await res.json()
  if (res.ok && json.success) { toast.success("Fulfillment queued"); await loadPendingOrders() }
  else toast.error(json.error || "Fulfillment failed")
}
```
Wire the button's `onClick` to `manualFulfillOne(order)`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/admin/orders/page.tsx
git commit -m "feat(admin): reversed badge/filter + per-line manual fulfill button"
```

---

## Self-review notes (addressed)

- **Spec coverage:** detection window (Task 2/3/4), all 6 providers + datakazina webhook (Task 4), new `reversed` status + state-machine widening (Task 1), no auto-resend (Global Constraints + never added to auto-fulfil/re-poll sets), downloadable (Task 5), per-line fulfill (Task 6), admin notification (Task 2 `flagReversal`), tests (Task 2 unit + Task 1 migration verification). No financial action — omitted by design (profits credited at purchase).
- **Per-order rate limits:** reversal sweeps on per-order crons are bounded to each cron's `BATCH_SIZE` so they never exceed the existing rate budget (coverage of older candidates rolls over across runs).
- **Type consistency:** `ReversalRow`/`isReversal`/`flagReversal`/`fetchReversalCandidates` signatures are defined once in Task 2 and consumed unchanged in Tasks 3–4.
- **Open confirmation during impl:** classify each of xpress/bisdel/codecraft/datakazina crons as bulk-feed vs per-order before wiring (Task 4 Step 3); confirm the datakazina webhook's exact status-write site (Task 4 Step 4).
