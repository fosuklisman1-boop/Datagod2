# Bulk Package Price Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin select multiple packages on `app/admin/packages/page.tsx` and bulk-recalculate their `price` and/or `dealer_price` — either by a percentage adjustment or by setting a per-GB rate — with a preview step before committing.

**Architecture:** A pure, dependency-free calculation module (`lib/bulk-package-pricing.ts`) implements the percentage/per-GB formulas and safeguard checks once; it's imported both by a new client-side preview (in a new `BulkPriceUpdateDialog` component) and by the new server-side API route (`app/api/admin/packages/bulk-update-price/route.ts`), so the preview the admin sees always matches what the server will actually do. The route follows the existing `app/api/admin/packages/*` auth/validation conventions and the `inChunks()` batching pattern from `app/api/admin/orders/bulk-update-status/route.ts`. The page gains checkbox selection + a network filter, following the pattern in `app/admin/withdrawals/page.tsx`.

**Tech Stack:** Next.js 15 App Router, TypeScript, Supabase (service-role client), shadcn/ui (`Dialog`, `Checkbox`, `RadioGroup`), Vitest.

**Design spec:** `docs/superpowers/specs/2026-09-21-bulk-package-price-update-design.md`

---

## Task 1: Pure calculation module

**Files:**
- Create: `lib/bulk-package-pricing.ts`
- Test: `lib/bulk-package-pricing.test.ts`

This module has zero dependencies (no Supabase, no fetch) so it can be unit-tested directly and safely imported into a client component for the live preview.

- [ ] **Step 1: Write the failing tests**

```typescript
// lib/bulk-package-pricing.test.ts
import { computePackagePriceUpdate, type BulkPriceUpdates, type PackagePriceInput } from "@/lib/bulk-package-pricing"

const basePkg: PackagePriceInput = { id: "pkg-1", price: 20, dealer_price: 18, size: "5" }

describe("computePackagePriceUpdate — percentage mode", () => {
  it("increases price by a positive percentage", () => {
    const updates: BulkPriceUpdates = { price: { mode: "percentage", value: 10 } }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.new_price).toBe(22)
    expect(result.skip_reason).toBeNull()
  })

  it("decreases price with a negative percentage", () => {
    const updates: BulkPriceUpdates = { price: { mode: "percentage", value: -10 } }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.new_price).toBe(18)
  })

  it("rounds to 2 decimal places", () => {
    const pkg: PackagePriceInput = { ...basePkg, price: 19.99 }
    const updates: BulkPriceUpdates = { price: { mode: "percentage", value: 7 } }
    const result = computePackagePriceUpdate(pkg, updates)
    // 19.99 * 1.07 = 21.3893 -> 21.39
    expect(result.new_price).toBe(21.39)
  })

  it("leaves price untouched when price field is not in updates", () => {
    const updates: BulkPriceUpdates = { dealer_price: { mode: "percentage", value: 5 } }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.new_price).toBe(basePkg.price)
  })
})

describe("computePackagePriceUpdate — per_gb mode", () => {
  it("sets price to size(GB) * rate, replacing the old price", () => {
    const updates: BulkPriceUpdates = { price: { mode: "per_gb", value: 4.5 } }
    const result = computePackagePriceUpdate(basePkg, updates) // size "5" -> 5GB
    expect(result.new_price).toBe(22.5)
  })

  it("ignores the old price entirely in per_gb mode", () => {
    const pkg: PackagePriceInput = { ...basePkg, price: 999 }
    const updates: BulkPriceUpdates = { price: { mode: "per_gb", value: 2 } }
    const result = computePackagePriceUpdate(pkg, updates)
    expect(result.new_price).toBe(10) // 5GB * 2, not derived from 999
  })

  it("treats a non-numeric size as 0GB (resulting price is non-positive and gets skipped)", () => {
    const pkg: PackagePriceInput = { ...basePkg, size: "unlimited" }
    const updates: BulkPriceUpdates = { price: { mode: "per_gb", value: 4.5 } }
    const result = computePackagePriceUpdate(pkg, updates)
    expect(result.new_price).toBe(0)
    expect(result.skip_reason).toBe("non_positive_price")
  })
})

describe("computePackagePriceUpdate — dealer_price handling", () => {
  it("updates dealer_price independently of price", () => {
    const updates: BulkPriceUpdates = { dealer_price: { mode: "percentage", value: 10 } }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.new_dealer_price).toBe(19.8) // 18 * 1.1
    expect(result.new_price).toBe(basePkg.price) // untouched
  })

  it("falls back to price as the dealer_price base when dealer_price is null", () => {
    const pkg: PackagePriceInput = { ...basePkg, dealer_price: null }
    const updates: BulkPriceUpdates = { dealer_price: { mode: "percentage", value: 10 } }
    const result = computePackagePriceUpdate(pkg, updates)
    expect(result.new_dealer_price).toBe(22) // 20 (price) * 1.1, not 0 * 1.1
  })

  it("can update both price and dealer_price in one call with different modes", () => {
    const updates: BulkPriceUpdates = {
      price: { mode: "per_gb", value: 5 },
      dealer_price: { mode: "percentage", value: -5 },
    }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.new_price).toBe(25) // 5GB * 5
    expect(result.new_dealer_price).toBe(17.1) // 18 * 0.95
  })
})

describe("computePackagePriceUpdate — safeguards", () => {
  it("skips when the computed price would be zero or negative", () => {
    const updates: BulkPriceUpdates = { price: { mode: "percentage", value: -150 } }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.skip_reason).toBe("non_positive_price")
  })

  it("skips when the computed dealer_price would be zero or negative", () => {
    const updates: BulkPriceUpdates = { dealer_price: { mode: "percentage", value: -150 } }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.skip_reason).toBe("non_positive_dealer_price")
  })

  it("skips when the new dealer_price would exceed the new price", () => {
    const updates: BulkPriceUpdates = { dealer_price: { mode: "per_gb", value: 100 } }
    const result = computePackagePriceUpdate(basePkg, updates) // dealer becomes 500, price stays 20
    expect(result.skip_reason).toBe("dealer_price_exceeds_price")
  })

  it("does not flag dealer_price_exceeds_price when dealer_price isn't being updated and was already <= price", () => {
    const updates: BulkPriceUpdates = { price: { mode: "percentage", value: -1 } } // 20 -> 19.8, dealer stays 18
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.skip_reason).toBeNull()
  })

  it("returns old values unchanged alongside the skip reason (caller decides whether to apply)", () => {
    const updates: BulkPriceUpdates = { price: { mode: "percentage", value: -150 } }
    const result = computePackagePriceUpdate(basePkg, updates)
    expect(result.old_price).toBe(20)
    expect(result.old_dealer_price).toBe(18)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- lib/bulk-package-pricing.test.ts`
Expected: FAIL — `Cannot find module '@/lib/bulk-package-pricing'` (or similar), since the module doesn't exist yet.

- [ ] **Step 3: Implement the module**

```typescript
// lib/bulk-package-pricing.ts
//
// Pure calculation for the admin "bulk update package prices" feature.
// Dependency-free (no Supabase, no fetch) so the exact same formula runs
// client-side for the live preview and server-side as the authoritative
// calculation — the preview an admin sees is guaranteed to match what the
// API will actually save, because both call this function.

export type PriceMode = "percentage" | "per_gb"

export interface FieldUpdate {
  mode: PriceMode
  value: number
}

export interface BulkPriceUpdates {
  price?: FieldUpdate
  dealer_price?: FieldUpdate
}

export interface PackagePriceInput {
  id: string
  price: number
  dealer_price: number | null
  size: string
}

export type SkipReason =
  | "non_positive_price"
  | "non_positive_dealer_price"
  | "dealer_price_exceeds_price"

export interface PackagePriceResult {
  id: string
  old_price: number
  new_price: number
  old_dealer_price: number | null
  new_dealer_price: number | null
  skip_reason: SkipReason | null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function applyMode(mode: PriceMode, value: number, currentValue: number, sizeGb: number): number {
  if (mode === "per_gb") return sizeGb * value
  return currentValue * (1 + value / 100)
}

/**
 * Computes the new price/dealer_price for one package given a bulk update
 * request. Never throws — an invalid result (<=0, or dealer > price) comes
 * back with a `skip_reason` instead, so the caller (UI preview or API route)
 * can decide what to do with it, and both sides make the same decision
 * because they call the same function.
 */
export function computePackagePriceUpdate(
  pkg: PackagePriceInput,
  updates: BulkPriceUpdates
): PackagePriceResult {
  const sizeGb = parseFloat(pkg.size) || 0

  const newPrice = updates.price
    ? round2(applyMode(updates.price.mode, updates.price.value, pkg.price, sizeGb))
    : pkg.price

  // dealer_price falls back to price as its base when unset, matching how
  // the rest of the app already treats a null dealer_price (see
  // lib/products-catalog.ts) — a dealer discount is meaningless without a
  // base to discount from.
  const dealerBase = pkg.dealer_price ?? pkg.price
  const newDealerPrice = updates.dealer_price
    ? round2(applyMode(updates.dealer_price.mode, updates.dealer_price.value, dealerBase, sizeGb))
    : pkg.dealer_price

  let skip_reason: SkipReason | null = null
  if (newPrice <= 0) {
    skip_reason = "non_positive_price"
  } else if (newDealerPrice !== null && newDealerPrice <= 0) {
    skip_reason = "non_positive_dealer_price"
  } else if (newDealerPrice !== null && newDealerPrice > newPrice) {
    skip_reason = "dealer_price_exceeds_price"
  }

  return {
    id: pkg.id,
    old_price: pkg.price,
    new_price: newPrice,
    old_dealer_price: pkg.dealer_price,
    new_dealer_price: newDealerPrice,
    skip_reason,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- lib/bulk-package-pricing.test.ts`
Expected: PASS — all 15 tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/bulk-package-pricing.ts lib/bulk-package-pricing.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): add pure calculation module for bulk package price updates

Percentage and per-GB pricing formulas plus safeguard checks, shared by
both the client-side preview and the server-side API route so the two
never disagree.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Register the new route as a heavy admin operation

**Files:**
- Modify: `lib/rate-limit-config.ts:163-171`

- [ ] **Step 1: Add the new path to `HEAVY_ADMIN_OPERATIONS`**

In `lib/rate-limit-config.ts`, change:

```typescript
export const HEAVY_ADMIN_OPERATIONS = [
    '/api/admin/sync-orders',
    '/api/admin/fix-failed-orders',
    '/api/admin/orders/bulk-update-status',
    '/api/admin/orders/download',
    '/api/admin/orders/phone-export',
    '/api/admin/mtn-registration/export',
    '/api/admin/mtn-registration/batch',
] as const
```

to:

```typescript
export const HEAVY_ADMIN_OPERATIONS = [
    '/api/admin/sync-orders',
    '/api/admin/fix-failed-orders',
    '/api/admin/orders/bulk-update-status',
    '/api/admin/orders/download',
    '/api/admin/orders/phone-export',
    '/api/admin/mtn-registration/export',
    '/api/admin/mtn-registration/batch',
    '/api/admin/packages/bulk-update-price',
] as const
```

- [ ] **Step 2: Verify the file still compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add lib/rate-limit-config.ts
git commit -m "$(cat <<'EOF'
chore(admin): rate-limit the bulk package price update route as heavy

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Bulk update API route

**Files:**
- Create: `app/api/admin/packages/bulk-update-price/route.ts`
- Test: `app/api/admin/packages/bulk-update-price/route.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// app/api/admin/packages/bulk-update-price/route.test.ts
import { POST } from "./route"
import { NextRequest } from "next/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => ({ isAdmin: true, userId: "admin-1" })),
}))

const h = vi.hoisted(() => {
  const state = {
    packagesRows: [
      { id: "pkg-1", price: 20, dealer_price: 18, size: "5" },
      { id: "pkg-2", price: 10, dealer_price: 9, size: "2" },
    ] as { id: string; price: number; dealer_price: number | null; size: string }[],
    updateCalls: [] as { id: string; data: any }[],
    auditInserts: [] as any[],
  }
  const fake = {
    from: (table: string) => {
      if (table === "packages") {
        return {
          select: () => ({
            in: (_col: string, ids: string[]) =>
              Promise.resolve({
                data: state.packagesRows.filter((p) => ids.includes(p.id)),
                error: null,
              }),
          }),
          update: (data: any) => ({
            eq: (_col: string, id: string) => {
              state.updateCalls.push({ id, data })
              return Promise.resolve({ error: null })
            },
          }),
        }
      }
      if (table === "admin_audit_log") {
        return {
          insert: (rows: any[]) => {
            state.auditInserts.push(...rows)
            return { then: (resolve: (v: { error: null }) => void) => resolve({ error: null }) }
          },
        }
      }
      throw new Error(`Unexpected table in fake client: ${table}`)
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/admin/packages/bulk-update-price", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.packagesRows = [
    { id: "pkg-1", price: 20, dealer_price: 18, size: "5" },
    { id: "pkg-2", price: 10, dealer_price: 9, size: "2" },
  ]
  h.state.updateCalls = []
  h.state.auditInserts = []
})

describe("POST /api/admin/packages/bulk-update-price", () => {
  it("rejects an empty packageIds array", async () => {
    const res = await POST(postRequest({ packageIds: [], updates: { price: { mode: "percentage", value: 10 } } }))
    expect(res.status).toBe(400)
  })

  it("rejects a request with no updates", async () => {
    const res = await POST(postRequest({ packageIds: ["pkg-1"], updates: {} }))
    expect(res.status).toBe(400)
  })

  it("rejects an unknown mode", async () => {
    const res = await POST(
      postRequest({ packageIds: ["pkg-1"], updates: { price: { mode: "bogus", value: 10 } } })
    )
    expect(res.status).toBe(400)
  })

  it("rejects a non-finite value", async () => {
    const res = await POST(
      postRequest({ packageIds: ["pkg-1"], updates: { price: { mode: "percentage", value: Number.NaN } } })
    )
    expect(res.status).toBe(400)
  })

  it("applies a percentage price update to all requested packages", async () => {
    const res = await POST(
      postRequest({
        packageIds: ["pkg-1", "pkg-2"],
        updates: { price: { mode: "percentage", value: 10 } },
      })
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.updated).toHaveLength(2)
    expect(body.skipped).toHaveLength(0)
    expect(h.state.updateCalls).toEqual(
      expect.arrayContaining([
        { id: "pkg-1", data: { price: 22 } },
        { id: "pkg-2", data: { price: 11 } },
      ])
    )
  })

  it("skips a package whose computed price would be non-positive, without failing the batch", async () => {
    const res = await POST(
      postRequest({
        packageIds: ["pkg-1", "pkg-2"],
        updates: { price: { mode: "percentage", value: -150 } },
      })
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.updated).toHaveLength(0)
    expect(body.skipped).toHaveLength(2)
    expect(body.skipped[0].skip_reason).toBe("non_positive_price")
    expect(h.state.updateCalls).toHaveLength(0)
  })

  it("writes a best-effort admin_audit_log row", async () => {
    await POST(
      postRequest({
        packageIds: ["pkg-1"],
        updates: { price: { mode: "percentage", value: 10 } },
      })
    )
    expect(h.state.auditInserts).toHaveLength(1)
    expect(h.state.auditInserts[0]).toMatchObject({
      admin_id: "admin-1",
      action: "bulk_price_update",
    })
  })

  it("rejects when verifyAdminAccess denies access", async () => {
    const { verifyAdminAccess } = await import("@/lib/admin-auth")
    ;(verifyAdminAccess as any).mockResolvedValueOnce({
      isAdmin: false,
      errorResponse: new Response(JSON.stringify({ error: "Admin access required" }), { status: 403 }),
    })
    const res = await POST(
      postRequest({ packageIds: ["pkg-1"], updates: { price: { mode: "percentage", value: 10 } } })
    )
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- app/api/admin/packages/bulk-update-price/route.test.ts`
Expected: FAIL — `Cannot find module './route'`, since the route file doesn't exist yet.

- [ ] **Step 3: Implement the route**

```typescript
// app/api/admin/packages/bulk-update-price/route.ts
import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import {
  computePackagePriceUpdate,
  type BulkPriceUpdates,
  type PackagePriceInput,
  type FieldUpdate,
  type PriceMode,
} from "@/lib/bulk-package-pricing"

// Loops one .update() per package — package catalogs are small (dozens, not
// thousands) so this is simpler and safe without the multi-chunk machinery
// bulk-update-status needs for tens of thousands of order rows.
export const maxDuration = 300

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

const MODES: PriceMode[] = ["percentage", "per_gb"]

/** Fetch rows in URL-length-safe chunks (PostgREST .in() has a practical URL limit). */
async function inChunks<T = any>(
  ids: string[],
  build: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: any }>,
  chunkSize = 200
): Promise<{ data: T[]; error: any }> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += chunkSize) {
    const { data, error } = await build(ids.slice(i, i + chunkSize))
    if (error) return { data: out, error }
    if (data) out.push(...data)
  }
  return { data: out, error: null }
}

function isValidFieldUpdate(value: unknown): value is FieldUpdate {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  if (!MODES.includes(v.mode as PriceMode)) return false
  if (typeof v.value !== "number" || !isFinite(v.value)) return false
  if (v.mode === "per_gb" && v.value <= 0) return false
  return true
}

export async function POST(req: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { packageIds, updates } = body ?? {}

  if (!Array.isArray(packageIds) || packageIds.length === 0 || !packageIds.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "packageIds must be a non-empty array of strings" }, { status: 400 })
  }

  if (!updates || typeof updates !== "object" || (!updates.price && !updates.dealer_price)) {
    return NextResponse.json({ error: "updates must include price and/or dealer_price" }, { status: 400 })
  }

  if (updates.price !== undefined && !isValidFieldUpdate(updates.price)) {
    return NextResponse.json({ error: "updates.price must be a valid { mode, value }" }, { status: 400 })
  }

  if (updates.dealer_price !== undefined && !isValidFieldUpdate(updates.dealer_price)) {
    return NextResponse.json({ error: "updates.dealer_price must be a valid { mode, value }" }, { status: 400 })
  }

  const safeUpdates: BulkPriceUpdates = {
    ...(updates.price ? { price: updates.price as FieldUpdate } : {}),
    ...(updates.dealer_price ? { dealer_price: updates.dealer_price as FieldUpdate } : {}),
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: rows, error: fetchError } = await inChunks<PackagePriceInput>(packageIds, (chunk) =>
    adminClient.from("packages").select("id, price, dealer_price, size").in("id", chunk)
  )

  if (fetchError) {
    console.error("Error fetching packages for bulk price update:", fetchError)
    return NextResponse.json({ error: "Failed to fetch packages" }, { status: 500 })
  }

  const results = rows.map((pkg) => computePackagePriceUpdate(pkg, safeUpdates))
  const updated = results.filter((r) => r.skip_reason === null)
  const skipped = results.filter((r) => r.skip_reason !== null)

  await Promise.all(
    updated.map((r) => {
      const data: Record<string, number> = {}
      if (safeUpdates.price) data.price = r.new_price
      if (safeUpdates.dealer_price && r.new_dealer_price !== null) data.dealer_price = r.new_dealer_price
      return adminClient.from("packages").update(data).eq("id", r.id)
    })
  )

  // Best-effort audit trail — never blocks the response on failure (same
  // fire-and-forget pattern as app/api/admin/update-balance/route.ts).
  adminClient
    .from("admin_audit_log")
    .insert([
      {
        admin_id: userId,
        action: "bulk_price_update",
        target_user_id: null,
        old_value: { package_ids: packageIds, updates: safeUpdates },
        new_value: { updated, skipped },
        created_at: new Date().toISOString(),
      },
    ])
    .then(({ error }: { error: any }) => {
      if (error) console.warn("[ADMIN-AUDIT] bulk_price_update log insert failed:", error.message)
    })

  return NextResponse.json({ updated, skipped })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- app/api/admin/packages/bulk-update-price/route.test.ts`
Expected: PASS — all 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add "app/api/admin/packages/bulk-update-price/route.ts" "app/api/admin/packages/bulk-update-price/route.test.ts"
git commit -m "$(cat <<'EOF'
feat(admin): add bulk package price update API route

POST /api/admin/packages/bulk-update-price recomputes price and/or
dealer_price for a batch of packages using the shared calculation module,
skips any package that would end up with a non-positive or
dealer-exceeds-user price, and writes a best-effort admin_audit_log entry.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Client service wrapper

**Files:**
- Modify: `lib/admin-service.ts`

- [ ] **Step 1: Add `bulkUpdatePrices` to `adminPackageService`**

Add this method inside the `adminPackageService` object in `lib/admin-service.ts`, right after `deletePackage` (i.e. before the object's closing `}`):

```typescript
  // Bulk update price and/or dealer_price for many packages at once
  async bulkUpdatePrices(
    packageIds: string[],
    updates: import("./bulk-package-pricing").BulkPriceUpdates
  ) {
    try {
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.access_token) {
        throw new Error("No authentication token available")
      }

      const response = await fetch("/api/admin/packages/bulk-update-price", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ packageIds, updates }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to bulk update prices")
      }

      return data as {
        updated: import("./bulk-package-pricing").PackagePriceResult[]
        skipped: import("./bulk-package-pricing").PackagePriceResult[]
      }
    } catch (error: any) {
      console.error("Error bulk updating package prices:", error)
      throw error
    }
  },
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add lib/admin-service.ts
git commit -m "$(cat <<'EOF'
feat(admin): add bulkUpdatePrices client wrapper to adminPackageService

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Bulk price update dialog component

**Files:**
- Create: `components/admin/bulk-price-update-dialog.tsx`

This is a UI component with no automated test (this codebase's Vitest setup covers pure logic and API routes only — see `vitest.config.ts`); it's verified manually in Task 7's browser walkthrough once it's wired into the page.

- [ ] **Step 1: Write the component**

```tsx
// components/admin/bulk-price-update-dialog.tsx
"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Badge } from "@/components/ui/badge"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { adminPackageService } from "@/lib/admin-service"
import {
  computePackagePriceUpdate,
  type BulkPriceUpdates,
  type PriceMode,
  type PackagePriceResult,
} from "@/lib/bulk-package-pricing"

interface SelectedPackage {
  id: string
  network: string
  size: string
  price: number
  dealer_price?: number | null
}

interface BulkPriceUpdateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedPackages: SelectedPackage[]
  onApplied: () => void
}

const SKIP_REASON_LABEL: Record<string, string> = {
  non_positive_price: "New price would be zero or negative",
  non_positive_dealer_price: "New dealer price would be zero or negative",
  dealer_price_exceeds_price: "New dealer price would exceed the new price",
}

export function BulkPriceUpdateDialog({ open, onOpenChange, selectedPackages, onApplied }: BulkPriceUpdateDialogProps) {
  const [updatePrice, setUpdatePrice] = useState(true)
  const [priceMode, setPriceMode] = useState<PriceMode>("percentage")
  const [priceValue, setPriceValue] = useState("")

  const [updateDealerPrice, setUpdateDealerPrice] = useState(false)
  const [dealerMode, setDealerMode] = useState<PriceMode>("percentage")
  const [dealerValue, setDealerValue] = useState("")

  const [preview, setPreview] = useState<PackagePriceResult[] | null>(null)
  const [applying, setApplying] = useState(false)
  const [results, setResults] = useState<{ updated: PackagePriceResult[]; skipped: PackagePriceResult[] } | null>(null)

  const reset = () => {
    setUpdatePrice(true)
    setPriceMode("percentage")
    setPriceValue("")
    setUpdateDealerPrice(false)
    setDealerMode("percentage")
    setDealerValue("")
    setPreview(null)
    setResults(null)
  }

  const buildUpdates = (): BulkPriceUpdates | null => {
    const updates: BulkPriceUpdates = {}
    if (updatePrice) {
      const value = parseFloat(priceValue)
      if (!isFinite(value)) return null
      updates.price = { mode: priceMode, value }
    }
    if (updateDealerPrice) {
      const value = parseFloat(dealerValue)
      if (!isFinite(value)) return null
      updates.dealer_price = { mode: dealerMode, value }
    }
    if (!updates.price && !updates.dealer_price) return null
    return updates
  }

  const handlePreview = () => {
    const updates = buildUpdates()
    if (!updates) {
      toast.error("Enter a valid value for each field you want to update")
      return
    }
    const computed = selectedPackages.map((pkg) =>
      computePackagePriceUpdate(
        { id: pkg.id, price: pkg.price, dealer_price: pkg.dealer_price ?? null, size: pkg.size },
        updates
      )
    )
    setPreview(computed)
  }

  const handleApply = async () => {
    const updates = buildUpdates()
    if (!updates) return
    setApplying(true)
    try {
      const data = await adminPackageService.bulkUpdatePrices(selectedPackages.map((p) => p.id), updates)
      setResults(data)
      onApplied()
    } catch (error: any) {
      toast.error(error?.message || "Failed to apply bulk price update")
    } finally {
      setApplying(false)
    }
  }

  const validPreviewCount = preview?.filter((r) => r.skip_reason === null).length ?? 0
  const packageById = new Map(selectedPackages.map((p) => [p.id, p]))

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bulk Update Prices</DialogTitle>
          <DialogDescription>
            {selectedPackages.length} package{selectedPackages.length === 1 ? "" : "s"} selected
          </DialogDescription>
        </DialogHeader>

        {results ? (
          <div className="space-y-3">
            <div className="flex gap-4 text-sm">
              <span className="text-success font-semibold">✓ {results.updated.length} updated</span>
              <span className="text-destructive font-semibold">✗ {results.skipped.length} skipped</span>
            </div>
            {results.skipped.length > 0 && (
              <div className="space-y-2">
                {results.skipped.map((r) => (
                  <div key={r.id} className="p-2 rounded-lg text-xs border border-destructive/20 bg-destructive/5">
                    <span className="font-semibold">{packageById.get(r.id)?.network} {packageById.get(r.id)?.size}GB</span>
                    {" — "}
                    {SKIP_REASON_LABEL[r.skip_reason ?? ""] ?? r.skip_reason}
                  </div>
                ))}
              </div>
            )}
            <Button onClick={() => onOpenChange(false)} className="w-full">Close</Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Price field */}
            <div className="border border-border rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox checked={updatePrice} onCheckedChange={(v) => setUpdatePrice(v === true)} />
                <Label>Update user price</Label>
              </div>
              {updatePrice && (
                <div className="pl-6 space-y-2">
                  <RadioGroup value={priceMode} onValueChange={(v) => setPriceMode(v as PriceMode)} className="flex gap-4">
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="percentage" id="price-mode-pct" />
                      <Label htmlFor="price-mode-pct">Percentage adjustment</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="per_gb" id="price-mode-gb" />
                      <Label htmlFor="price-mode-gb">Set per-GB rate</Label>
                    </div>
                  </RadioGroup>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder={priceMode === "percentage" ? "e.g. 10 or -5" : "e.g. 4.50"}
                    value={priceValue}
                    onChange={(e) => setPriceValue(e.target.value)}
                  />
                </div>
              )}
            </div>

            {/* Dealer price field */}
            <div className="border border-border rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox checked={updateDealerPrice} onCheckedChange={(v) => setUpdateDealerPrice(v === true)} />
                <Label>Update dealer price</Label>
              </div>
              {updateDealerPrice && (
                <div className="pl-6 space-y-2">
                  <RadioGroup value={dealerMode} onValueChange={(v) => setDealerMode(v as PriceMode)} className="flex gap-4">
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="percentage" id="dealer-mode-pct" />
                      <Label htmlFor="dealer-mode-pct">Percentage adjustment</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value="per_gb" id="dealer-mode-gb" />
                      <Label htmlFor="dealer-mode-gb">Set per-GB rate</Label>
                    </div>
                  </RadioGroup>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder={dealerMode === "percentage" ? "e.g. 10 or -5" : "e.g. 4.00"}
                    value={dealerValue}
                    onChange={(e) => setDealerValue(e.target.value)}
                  />
                </div>
              )}
            </div>

            <Button variant="outline" onClick={handlePreview} className="w-full">Preview</Button>

            {preview && (
              <div className="space-y-2">
                <div className="overflow-x-auto border border-border rounded-lg">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="px-3 py-2 text-left">Package</th>
                        <th className="px-3 py-2 text-left">Old Price</th>
                        <th className="px-3 py-2 text-left">New Price</th>
                        <th className="px-3 py-2 text-left">Old Dealer</th>
                        <th className="px-3 py-2 text-left">New Dealer</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {preview.map((r) => {
                        const pkg = packageById.get(r.id)
                        return (
                          <tr key={r.id} className={r.skip_reason ? "bg-destructive/5" : ""}>
                            <td className="px-3 py-2">{pkg?.network} {pkg?.size}GB</td>
                            <td className="px-3 py-2">GHS {r.old_price.toFixed(2)}</td>
                            <td className="px-3 py-2 font-semibold">
                              {r.skip_reason ? (
                                <Badge className="bg-destructive/15 text-destructive">skipped</Badge>
                              ) : (
                                `GHS ${r.new_price.toFixed(2)}`
                              )}
                            </td>
                            <td className="px-3 py-2">{r.old_dealer_price != null ? `GHS ${r.old_dealer_price.toFixed(2)}` : "-"}</td>
                            <td className="px-3 py-2">{!r.skip_reason && r.new_dealer_price != null ? `GHS ${r.new_dealer_price.toFixed(2)}` : "-"}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {preview.some((r) => r.skip_reason) && (
                  <p className="text-xs text-muted-foreground">
                    Rows marked "skipped" will not be changed — hover reason shown in results after applying.
                  </p>
                )}
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>Cancel</Button>
              <Button onClick={handleApply} disabled={!preview || validPreviewCount === 0 || applying}>
                {applying ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Applying...</> : `Confirm & Apply (${validPreviewCount})`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add components/admin/bulk-price-update-dialog.tsx
git commit -m "$(cat <<'EOF'
feat(admin): add BulkPriceUpdateDialog component

Field toggles for user/dealer price, percentage or per-GB mode per field,
a client-side preview (reusing the same pure calculation as the API route),
and a results view after applying.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire selection + filter + dialog into the packages page

**Files:**
- Modify: `app/admin/packages/page.tsx`

- [ ] **Step 1: Fix the stale network list and add imports**

In `app/admin/packages/page.tsx`, replace:

```typescript
const AVAILABLE_NETWORKS = [
  "MTN",
  "Telecel",
  "AT - iShare",
  "AT - BigTime",
]
```

with the canonical list actually enforced server-side (matches `ALLOWED_NETWORKS` in `app/api/admin/packages/route.ts`):

```typescript
const AVAILABLE_NETWORKS = ["MTN", "AirtelTigo", "Telecel"]
```

Add these imports alongside the existing ones at the top of the file:

```typescript
import { Checkbox } from "@/components/ui/checkbox"
import { BulkPriceUpdateDialog } from "@/components/admin/bulk-price-update-dialog"
```

- [ ] **Step 2: Add selection, filter, and dialog state**

Inside `AdminPackagesPage`, add these state declarations right after the existing `formData` state:

```typescript
  const [networkFilter, setNetworkFilter] = useState<string>("all")
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBulkDialog, setShowBulkDialog] = useState(false)
```

- [ ] **Step 3: Add filtered-packages derivation and selection helpers**

Add this right after `loadPackages` (before `handleSubmit`):

```typescript
  const filteredPackages = networkFilter === "all"
    ? packages
    : packages.filter((p) => p.network === networkFilter)

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAllVisible = () => setSelectedIds(new Set(filteredPackages.map((p) => p.id)))
  const deselectAll = () => setSelectedIds(new Set())
```

Add a `useEffect` right after the existing `loadPackages` effect to clear stale selections when the network filter changes:

```typescript
  useEffect(() => {
    setSelectedIds(new Set())
  }, [networkFilter])
```

- [ ] **Step 4: Add the network filter control and bulk action bar**

In the JSX, find this exact block (the end of the page header, right before the add/edit form):

```tsx
          <Button
            onClick={() => !showForm ? setShowForm(true) : resetForm()}
            className="bg-gradient-to-r from-primary to-primary hover:from-primary hover:to-primary"
          >
            <Plus className="w-4 h-4 mr-2" />
            {showForm ? "Cancel" : "Add Package"}
          </Button>
        </div>

        {/* Add/Edit Form */}
```

Insert the new block between the header's closing `</div>` and the `{/* Add/Edit Form */}` comment, so it reads:

```tsx
          <Button
            onClick={() => !showForm ? setShowForm(true) : resetForm()}
            className="bg-gradient-to-r from-primary to-primary hover:from-primary hover:to-primary"
          >
            <Plus className="w-4 h-4 mr-2" />
            {showForm ? "Cancel" : "Add Package"}
          </Button>
        </div>

        {/* Network Filter */}
        <div className="flex flex-wrap gap-2">
          {["all", ...AVAILABLE_NETWORKS].map((net) => (
            <Button
              key={net}
              size="sm"
              variant={networkFilter === net ? "default" : "outline"}
              onClick={() => setNetworkFilter(net)}
              className={networkFilter === net ? "bg-primary hover:bg-primary" : ""}
            >
              {net === "all" ? "All Networks" : net}
            </Button>
          ))}
        </div>

        {/* Bulk Action Toolbar */}
        {filteredPackages.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              onClick={selectedIds.size === filteredPackages.length ? deselectAll : selectAllVisible}
              className="text-xs border-border"
            >
              {selectedIds.size === filteredPackages.length ? "Deselect All" : `Select All (${filteredPackages.length})`}
            </Button>
            {selectedIds.size > 0 && (
              <div className="flex items-center gap-2 p-2 bg-primary/5 border border-primary/20 rounded-lg">
                <span className="text-xs font-medium text-foreground">{selectedIds.size} selected</span>
                <Button
                  size="sm"
                  onClick={() => setShowBulkDialog(true)}
                  className="h-7 px-3 text-xs bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  Bulk Update Prices
                </Button>
                <Button size="sm" variant="ghost" onClick={deselectAll} className="h-7 px-2 text-xs text-muted-foreground">
                  ✕ Clear
                </Button>
              </div>
            )}
          </div>
        )}
```

- [ ] **Step 5: Add the checkbox column to the table**

Replace the table `<thead>` block:

```tsx
                <thead className="bg-card backdrop-blur border-b border-primary/20">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-foreground">Network</th>
```

with:

```tsx
                <thead className="bg-card backdrop-blur border-b border-primary/20">
                  <tr>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-foreground w-10"></th>
                    <th className="px-6 py-3 text-left text-sm font-semibold text-foreground">Network</th>
```

Replace the `<tbody>` opening and row mapping:

```tsx
                <tbody className="divide-y divide-blue-100/40">
                  {packages.map((pkg) => (
                    <tr key={pkg.id} className="hover:bg-primary/10 backdrop-blur transition-colors">
                      <td className="px-6 py-4 font-medium text-foreground">{pkg.network}</td>
```

with:

```tsx
                <tbody className="divide-y divide-blue-100/40">
                  {filteredPackages.map((pkg) => (
                    <tr key={pkg.id} className="hover:bg-primary/10 backdrop-blur transition-colors">
                      <td className="px-6 py-4">
                        <Checkbox
                          checked={selectedIds.has(pkg.id)}
                          onCheckedChange={() => toggleSelection(pkg.id)}
                        />
                      </td>
                      <td className="px-6 py-4 font-medium text-foreground">{pkg.network}</td>
```

- [ ] **Step 6: Render the dialog and refresh after apply**

Find this exact block at the end of the file (the packages table's closing tags):

```tsx
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
```

Insert the dialog between the `</Card>` that closes the packages table and the `</div>` that closes the outer `space-y-6` wrapper, so it reads:

```tsx
            </div>
          </CardContent>
        </Card>

        <BulkPriceUpdateDialog
          open={showBulkDialog}
          onOpenChange={setShowBulkDialog}
          selectedPackages={packages.filter((p) => selectedIds.has(p.id))}
          onApplied={() => {
            deselectAll()
            loadPackages()
          }}
        />
      </div>
    </DashboardLayout>
  )
}
```

- [ ] **Step 7: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 8: Commit**

```bash
git add app/admin/packages/page.tsx
git commit -m "$(cat <<'EOF'
feat(admin): wire bulk price update into the packages page

Adds a network filter, per-row checkboxes, select-all, and a bulk action
bar that opens BulkPriceUpdateDialog. Also fixes the stale AVAILABLE_NETWORKS
list (was ["MTN","Telecel","AT - iShare","AT - BigTime"], the real
server-enforced values are ["MTN","AirtelTigo","Telecel"]).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Run the full test suite and manually verify in the browser

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated test suite**

Run: `npm test`
Expected: All tests pass, including the new `lib/bulk-package-pricing.test.ts` and `app/api/admin/packages/bulk-update-price/route.test.ts`.

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Start the dev server**

Run: `npm run dev`
Expected: Server starts on the configured port without errors.

- [ ] **Step 4: Manually walk through the feature as an admin**

Using the `webapp-testing` skill (Playwright) or a real browser, log in as an admin and go to `/admin/packages`:

1. Confirm the network filter buttons show "All Networks", "MTN", "AirtelTigo", "Telecel" (not the old "AT - iShare"/"AT - BigTime" values) and that clicking one filters the table.
2. Select 2-3 packages via checkboxes; confirm the bulk action bar appears with the correct count.
3. Click "Select All", confirm all visible (filtered) rows get checked; click again to deselect all.
4. With 2+ packages selected, click "Bulk Update Prices". In the dialog:
   - Check "Update user price", choose "Percentage adjustment", enter `10`, click Preview — confirm the preview table shows each package's price increased by 10% and rounded to 2 decimals.
   - Switch to "Set per-GB rate", enter a rate, click Preview — confirm new price = size(GB) × rate for each row.
   - Check "Update dealer price" too with a different mode/value, click Preview — confirm both columns update independently.
   - Enter a value that would push a price to zero or below (e.g. -150%) — confirm that row is marked "skipped" in the preview and excluded from the enabled Confirm count.
5. Click "Confirm & Apply" on a valid preview — confirm the results view shows updated/skipped counts, and that `/admin/packages` reloads with the new prices visible in the table.
6. Refresh the page and spot-check that the updated prices persisted (i.e. actually saved to the DB, not just local state).

- [ ] **Step 5: Report results**

Summarize what was verified and any issues found. Do not mark this task complete until the walkthrough has actually been performed and prices are confirmed to persist after a page reload.

---

## Out of Scope (per design spec)

- Bulk-adjusting shop/sub-agent margins (`shop_packages.profit_margin`, `sub_agent_catalog.wholesale_margin`, `sub_agent_shop_packages.sub_agent_profit_margin`).
- Bulk availability toggling (already exists as a separate single-row feature).
- Pagination of the packages table.
