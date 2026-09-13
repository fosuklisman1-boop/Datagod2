# Release Held Orders Now Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-triggered "release held orders now" action that re-runs the same safe registry/whitelist release checks the hourly cron already performs, surfaced as a button on `/admin/mtn-registration`.

**Architecture:** A new read-only helper `getHeldOrderPhones()` in `lib/mtn-hold.ts` finds phones still held after the existing `releaseHeldMtnOrders()` sweep; a new admin API route (`/api/admin/mtn-registration/release-held`) runs that sweep, then re-checks those remaining phones' `whitelist_status` and releases any that are now `allowed` via the existing `releaseWhitelistHeldOrders()`; a button on the existing admin page calls the route and toasts a summary.

**Tech Stack:** Next.js App Router API routes, Supabase (service-role client), Vitest, React (existing admin page), sonner toasts.

Design doc: `docs/superpowers/specs/2026-09-13-release-held-orders-now-design.md`

---

### Task 1: `getHeldOrderPhones()` helper in `lib/mtn-hold.ts`

**Files:**
- Modify: `lib/mtn-hold.ts` (add new exported function at end of file, after `releaseWhitelistHeldOrders`)
- Test: `lib/mtn-hold.test.ts` (add new `describe` block)

- [ ] **Step 1: Write the failing test**

`lib/mtn-hold.test.ts` currently exists with only pure-function tests (`decideMtnGate`/`statusColumnFor`/`HOLD_STATUS`/`MTN_ORDER_TABLES`) and starts with this exact import line:

```ts
import { describe, it, expect } from 'vitest'
import { decideMtnGate, statusColumnFor, HOLD_STATUS, MTN_ORDER_TABLES } from './mtn-hold'
```

This adds the file's first Supabase-backed test, so `@supabase/supabase-js` needs mocking (`lib/mtn-hold.ts` calls `createClient()` directly rather than importing a shared client). Make two edits:

**Edit A — replace that exact import line** (adds `vi`, `beforeEach`, and the mock — do not add a second copy of the `decideMtnGate` import elsewhere in the file):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decideMtnGate, statusColumnFor, HOLD_STATUS, MTN_ORDER_TABLES } from './mtn-hold'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

/** Minimal fake client: `.from(table).select(col).eq(statusCol, val)` resolves
 *  to whatever rows are configured for that table. */
function fakeSupabase(rowsByTable: Record<string, any[]>) {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return Promise.resolve({ data: rowsByTable[table] ?? [], error: null })
            },
          }
        },
      }
    },
  }
}
```

**Edit B — append this new block to the end of the file** (after the existing `describe('HOLD_STATUS', ...)` block, which is currently the last thing in the file):

```ts
describe('getHeldOrderPhones', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('collects normalized, deduped phones across all 5 order tables', async () => {
    const { createClient } = await import('@supabase/supabase-js')
    const { getHeldOrderPhones } = await import('./mtn-hold')
    vi.mocked(createClient).mockReturnValue(fakeSupabase({
      orders: [{ phone_number: '0551111111' }],
      shop_orders: [{ customer_phone: '+233551111111' }], // same number, different format -> dedup
      api_orders: [{ recipient_phone: '0552222222' }],
      ussd_orders: [],
      ussd_shop_orders: [],
    }) as any)

    const phones = await getHeldOrderPhones()
    expect(phones.sort()).toEqual(['0551111111', '0552222222'])
  })

  it('returns an empty array when nothing is held', async () => {
    const { createClient } = await import('@supabase/supabase-js')
    const { getHeldOrderPhones } = await import('./mtn-hold')
    vi.mocked(createClient).mockReturnValue(fakeSupabase({}) as any)

    expect(await getHeldOrderPhones()).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/mtn-hold.test.ts`
Expected: FAIL — `getHeldOrderPhones is not a function` / import error, since it doesn't exist yet in `lib/mtn-hold.ts`.

- [ ] **Step 3: Write minimal implementation**

Add this to the end of `lib/mtn-hold.ts` (after the existing `releaseWhitelistHeldOrders` function, which currently ends the file around line 257):

```ts
/**
 * Read-only: normalized, deduped phones currently on a held_registration
 * order, across all 5 order tables. Used by the on-demand "release held
 * orders now" admin action to find phones worth re-checking against
 * whitelist_status — releaseHeldMtnOrders() already does its own
 * registration-status re-check internally and needs no phone list, but
 * releaseWhitelistHeldOrders() requires an explicit list of phones to check.
 */
export async function getHeldOrderPhones(): Promise<string[]> {
  const supabase = serviceClient()
  const { normalizeGhanaPhone } = await import("@/lib/phone-format")
  const phones = new Set<string>()

  for (const table of MTN_ORDER_TABLES) {
    const statusCol = statusColumnFor(table)
    const phoneCol = phoneColumnFor(table)
    const { data, error } = await supabase
      .from(table)
      .select(phoneCol)
      .eq(statusCol, HOLD_STATUS)
    if (error) {
      console.error(`[MTN-HOLD] getHeldOrderPhones select failed for ${table}:`, error)
      continue
    }
    for (const row of (data as any[]) ?? []) {
      const norm = normalizeGhanaPhone(String((row as any)[phoneCol] ?? ""))
      if (norm) phones.add(norm)
    }
  }

  return [...phones]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/mtn-hold.test.ts`
Expected: PASS (both new tests, plus all pre-existing tests in the file still passing)

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: PASS — all test files green (was 744 tests passing before this change per the last full run in this project's history; expect 746 after adding these 2).

- [ ] **Step 6: Commit**

```bash
git add lib/mtn-hold.ts lib/mtn-hold.test.ts
git commit -m "feat(mtn-hold): add getHeldOrderPhones() helper for on-demand release"
```

---

### Task 2: New admin route `POST /api/admin/mtn-registration/release-held`

**Files:**
- Create: `app/api/admin/mtn-registration/release-held/route.ts`

No automated test for this route — it is thin orchestration over `releaseHeldMtnOrders()`, `releaseWhitelistHeldOrders()`, and `getHeldOrderPhones()`, all of which are already covered by their own tests (the latter as of Task 1). This matches the design spec's testing section. Verify it manually in Task 4.

- [ ] **Step 1: Write the route**

Create `app/api/admin/mtn-registration/release-held/route.ts`:

```ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * POST /api/admin/mtn-registration/release-held
 * On-demand version of the hourly release-held-mtn-orders cron: re-checks
 * every held_registration order's number against the registry (and, for
 * whatever's still held after that, against whitelist_status) and releases
 * anything that's actually confirmed registered/allowed right now. Never
 * force-releases a number that isn't confirmed — same safety guarantees as
 * the cron, just triggered immediately instead of waiting up to an hour.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { releaseHeldMtnOrders, releaseWhitelistHeldOrders, getHeldOrderPhones } = await import("@/lib/mtn-hold")

    // Pass 1: registration-gate sweep (mtn_number_registry.status = 'registered').
    const registryPass = await releaseHeldMtnOrders()

    // Pass 2: whatever's still held might be held for a whitelist reason whose
    // number has since cleared — registration status and whitelist status are
    // independent columns on the same registry row, so a number can already be
    // 'registered' (pass 1 wouldn't touch it further) while also having been
    // whitelist-blocked, or vice versa. Find still-held phones now allowed and
    // release those specifically.
    const stillHeldPhones = await getHeldOrderPhones()
    let whitelistPass = { released: 0, dispatched: 0, failed: 0 }
    if (stillHeldPhones.length > 0) {
      const { data: allowedRows, error: allowedErr } = await supabase
        .from("mtn_number_registry")
        .select("phone")
        .in("phone", stillHeldPhones)
        .eq("whitelist_status", "allowed")
      if (allowedErr) {
        console.error("[RELEASE-HELD] allowed-phones query failed:", allowedErr)
      } else {
        const allowedPhones = (allowedRows ?? []).map((r: any) => r.phone).filter(Boolean)
        if (allowedPhones.length > 0) {
          whitelistPass = await releaseWhitelistHeldOrders(allowedPhones)
        }
      }
    }

    return NextResponse.json({
      ok: true,
      checked: registryPass.checked,
      released: registryPass.released + whitelistPass.released,
      dispatched: registryPass.dispatched + whitelistPass.dispatched,
      queuedManual: registryPass.queuedManual,
      failed: registryPass.failed + whitelistPass.failed,
    })
  } catch (error) {
    console.error("[RELEASE-HELD] error:", error)
    return NextResponse.json({ error: "Failed to release held orders" }, { status: 500 })
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors introduced by this file (pre-existing errors elsewhere in the project, if any, are not this task's concern — only check that this new file doesn't add any).

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/mtn-registration/release-held/route.ts
git commit -m "feat(admin): add release-held route to trigger held-order release on demand"
```

---

### Task 3: Button on `/admin/mtn-registration`

**Files:**
- Modify: `app/admin/mtn-registration/page.tsx`

- [ ] **Step 1: Add loading state**

In `app/admin/mtn-registration/page.tsx`, find this block (currently around line 44-50):

```ts
export default function MtnRegistrationPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [payload, setPayload] = useState<ListPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [markingId, setMarkingId] = useState<string | null>(null)
  const [redownloadingId, setRedownloadingId] = useState<string | null>(null)
```

Replace with (adds `releasingHeld` state):

```ts
export default function MtnRegistrationPage() {
  const { isAdmin, loading: adminLoading } = useAdminProtected()
  const [payload, setPayload] = useState<ListPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [markingId, setMarkingId] = useState<string | null>(null)
  const [redownloadingId, setRedownloadingId] = useState<string | null>(null)
  const [releasingHeld, setReleasingHeld] = useState(false)
```

- [ ] **Step 2: Add the handler**

In the same file, find `handleMarkRegistered` (currently ends around line 125, right before `handleRedownload`). Insert this new function directly after it, before `handleRedownload`:

```ts
  const handleReleaseHeld = async () => {
    setReleasingHeld(true)
    try {
      const token = await getToken()
      const res = await fetch("/api/admin/mtn-registration/release-held", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || "Failed to release held orders")
      if (data.checked === 0) {
        toast.info("No held orders to check right now.")
      } else if (data.released === 0) {
        toast.info(`Checked ${data.checked} held order(s) — none are registered/whitelisted yet.`)
      } else {
        const parts = [`${data.dispatched} fulfilled`]
        if (data.queuedManual > 0) parts.push(`${data.queuedManual} queued for manual fulfillment`)
        if (data.failed > 0) parts.push(`${data.failed} still blocked`)
        toast.success(`Checked ${data.checked} held order(s) — ${data.released} released: ${parts.join(", ")}.`)
      }
      await loadStatus()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to release held orders")
    } finally {
      setReleasingHeld(false)
    }
  }
```

- [ ] **Step 3: Add the button to the "held orders" stat card**

Find this block (currently around lines 171-191):

```tsx
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {([
            ["pending", "pending"],
            ["submitted", "submitted"],
            ["registered", "registered"],
            ["held_orders", "held orders"],
          ] as const).map(([key, label]) => (
            <Card key={key}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium capitalize text-muted-foreground">
                  {label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {loading ? "—" : (counts[key] ?? 0).toLocaleString()}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
```

Replace with (adds the button under the "held orders" card specifically):

```tsx
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {([
            ["pending", "pending"],
            ["submitted", "submitted"],
            ["registered", "registered"],
            ["held_orders", "held orders"],
          ] as const).map(([key, label]) => (
            <Card key={key}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium capitalize text-muted-foreground">
                  {label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">
                  {loading ? "—" : (counts[key] ?? 0).toLocaleString()}
                </div>
                {key === "held_orders" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 w-full"
                    onClick={handleReleaseHeld}
                    disabled={releasingHeld || loading}
                  >
                    {releasingHeld ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-2" />
                    )}
                    {releasingHeld ? "Checking…" : "Release held orders now"}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
```

Note: `Button`, `Loader2`, and `RefreshCw` are already imported at the top of this file (used by `handleExport` and the batches-table refresh button) — no new imports needed.

- [ ] **Step 4: Manual verification**

Run the dev server (`npm run dev`), sign in as an admin, navigate to `/admin/mtn-registration`, and confirm:
- The "Release held orders now" button renders under the "held orders" count card.
- Clicking it disables the button, shows the spinner + "Checking…" text, then re-enables and shows a toast.
- The toast text matches one of the three branches in `handleReleaseHeld` depending on whether anything was held/released.
- The stat counts refresh after the toast (via the existing `loadStatus()` call).

- [ ] **Step 5: Commit**

```bash
git add app/admin/mtn-registration/page.tsx
git commit -m "feat(admin): add \"release held orders now\" button to MTN registration page"
```

---

### Task 4: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Verify against a real held order (if one exists in the current environment)**

Use the diagnostic query pattern already established in this project (Supabase Management API `POST /v1/projects/{ref}/database/query`, per the `reference-supabase-access` reference) to check the current count of `held_registration` rows across the 5 order tables before and after clicking the button, confirming the button's reported `checked`/`released` counts match reality. If no held orders currently exist in the environment, this step can be skipped — Task 3 Step 4's manual click-through (confirming `checked: 0` → "No held orders to check right now.") already exercises the empty-state path.

- [ ] **Step 2: Confirm no regression in the existing hourly cron**

Read `app/api/cron/release-held-mtn-orders/route.ts` and confirm it is unchanged by this plan (it should still call bare `releaseHeldMtnOrders()` with no arguments, exactly as before) — this feature only adds a new, separate on-demand entry point; it does not modify the cron.
