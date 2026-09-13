# Release Held Orders Now — Design

## Goal

Give the admin an on-demand button on `/admin/mtn-registration` that immediately re-runs the same safe release checks the hourly cron already performs, instead of waiting up to an hour for `/api/cron/release-held-mtn-orders` to fire. It must never force-release a genuinely unregistered/unwhitelisted number — it only releases orders whose number is *actually* confirmed registered or whitelisted at the moment the button is clicked.

## Context

- `lib/mtn-hold.ts` already has `releaseHeldMtnOrders(phones?)` — sweeps every `held_registration` order across all 5 order tables, re-checks each held phone against `mtn_number_registry.status = 'registered'`, and dispatches the ones that pass via `processManualFulfillment` / `fulfillUssdOrder`. Called with no `phones` arg, it sweeps everything.
- `lib/mtn-hold.ts` also has `releaseWhitelistHeldOrders(phones)` — same dispatch mechanics, but releases based on `whitelist_status = 'allowed'` instead, and requires an explicit phone list (it doesn't do its own registry query).
- `app/api/cron/release-held-mtn-orders/route.ts` already calls `releaseHeldMtnOrders()` on an hourly schedule (`7 * * * *`) — this is the "safety net" sweep this feature is exposing as an on-demand trigger.
- `app/api/admin/mtn-registration/mark-registered/route.ts` is the existing precedent for triggering a release from an admin route: `verifyAdminAccess`, calls a release function, returns `{ ordersReleased, ordersDispatched, ordersQueuedManual, ordersFailed }`.
- `app/admin/mtn-registration/page.tsx` already fetches and displays a `held_orders` count (line ~176, in the stats grid) via `GET /api/admin/mtn-registration/list`. This is the natural home for the new button — right next to the number it affects.
- UI conventions on this page (reused as-is): `getToken()` helper for the admin bearer token, `toast` from `sonner` for results, a per-action `useState<boolean>` loading flag disabling the button and swapping in a `Loader2` spin icon, and a comma-joined summary message mirroring `handleMarkRegistered`'s pattern (`"${dispatched} fulfilled", "${queuedManual} queued for manual fulfillment", "${failed} still blocked"`).

## Design

### 1. `POST /api/admin/mtn-registration/release-held` (new route)

```ts
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { releaseHeldMtnOrders, releaseWhitelistHeldOrders } = await import("@/lib/mtn-hold")

  // Pass 1: registration-gate sweep (checks mtn_number_registry.status).
  const registryPass = await releaseHeldMtnOrders()

  // Pass 2: whatever's still held after pass 1 might be held specifically for
  // a whitelist reason whose number has since cleared (whitelist_status and
  // registration status are independent columns on the same registry row).
  // Find the phones still held whose whitelist_status is now 'allowed', and
  // release those specifically — releaseWhitelistHeldOrders needs an explicit
  // phone list, it doesn't do its own registry query.
  const stillHeldPhones = await getHeldOrderPhones() // helper, queries all 5 tables for status='held_registration'
  let whitelistPass = { released: 0, dispatched: 0, failed: 0 }
  if (stillHeldPhones.length > 0) {
    const { data: allowedRows } = await supabase
      .from("mtn_number_registry")
      .select("phone")
      .in("phone", stillHeldPhones)
      .eq("whitelist_status", "allowed")
    const allowedPhones = (allowedRows ?? []).map(r => r.phone)
    if (allowedPhones.length > 0) {
      whitelistPass = await releaseWhitelistHeldOrders(allowedPhones)
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
}
```

`getHeldOrderPhones()` is a small new helper in `lib/mtn-hold.ts` (exported, unit-testable) that queries the 5 `MTN_ORDER_TABLES` for rows at `HOLD_STATUS` and returns their normalized phones — a read-only reuse of the same table/column mapping `releaseHeldMtnOrders` already uses (`statusColumnFor`, `phoneColumnFor`), so it doesn't duplicate that logic, just the query shape.

### 2. `app/admin/mtn-registration/page.tsx` — new button

Placed in the stats grid's "held orders" card as a small inline action (not a full-width button), or directly to the right of the grid — final placement is a one-line JSX decision, not a design question. Behavior:

```ts
const [releasing, setReleasing] = useState(false)

const handleReleaseHeld = async () => {
  setReleasing(true)
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
    setReleasing(false)
  }
}
```

Button disabled while `releasing || loading`, with the same `Loader2`-spin-while-busy convention as `handleExport`.

## Error handling

- Route: `verifyAdminAccess` failure → existing 401/403 short-circuit (unchanged pattern). Any thrown error inside the two release passes → 500 with a generic message (mirrors every other admin route in this directory); nothing here is more failure-prone than the cron already running the same code hourly.
- Client: any non-OK response or thrown error surfaces via `toast.error`, loading flag always resets in `finally`.

## Testing

- Unit test `getHeldOrderPhones()` against a faked Supabase client (existing `fakeSupabase`-style pattern from `lib/phone-verify-upload.test.ts`) — confirms it queries all 5 tables and returns a deduped, normalized phone list.
- No new tests for `releaseHeldMtnOrders`/`releaseWhitelistHeldOrders` themselves — unchanged, already exercised by existing behavior.
- Manual verification: click the button locally against a held test order, confirm the toast summary matches the API response and `loadStatus()` refreshes the counts.
