import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import {
  computePackagePriceUpdate,
  type BulkPriceUpdates,
  type PackagePriceInput,
  type PackagePriceResult,
  type FieldUpdate,
  type PriceMode,
  type SkipReason,
} from "@/lib/bulk-package-pricing"

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Route-level skip reason: everything computePackagePriceUpdate can report,
// plus "write_failed" for a package that passed the pure calculation but
// whose DB write itself errored. lib/bulk-package-pricing.ts doesn't need to
// know about DB write failures — that's bookkeeping local to this route.
type RouteSkipReason = SkipReason | "write_failed"
interface SkippedResult extends Omit<PackagePriceResult, "skip_reason"> {
  skip_reason: RouteSkipReason
}

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
  if (!isAdmin) return errorResponse!

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

  if (!packageIds.every((id) => UUID_REGEX.test(id))) {
    return NextResponse.json({ error: "packageIds must all be valid UUIDs" }, { status: 400 })
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

  const foundIds = new Set(rows.map((r) => r.id))
  const not_found = packageIds.filter((id) => !foundIds.has(id))

  const results = rows.map((pkg) => computePackagePriceUpdate(pkg, safeUpdates))
  const passed = results.filter((r) => r.skip_reason === null)
  const preSkipped: SkippedResult[] = results
    .filter((r): r is PackagePriceResult & { skip_reason: SkipReason } => r.skip_reason !== null)
    .map((r) => ({ ...r, skip_reason: r.skip_reason }))

  // Capture each write's own result — a Promise.all that discards `error`
  // would report a package as "updated" (and bake that into the audit log)
  // even when its .update() failed (constraint violation, transient error,
  // row deleted between SELECT and UPDATE, etc). Never trust "attempted" as
  // "succeeded" for a bulk write; see lib/bulk-package-pricing.ts callers.
  const writeResults = await Promise.all(
    passed.map(async (r) => {
      const data: Record<string, number> = {}
      if (safeUpdates.price) data.price = r.new_price
      if (safeUpdates.dealer_price && r.new_dealer_price !== null) data.dealer_price = r.new_dealer_price
      const { error } = await adminClient.from("packages").update(data).eq("id", r.id)
      return { result: r, error }
    })
  )

  const updated = writeResults.filter((w) => !w.error).map((w) => w.result)
  const failedWrites: SkippedResult[] = writeResults
    .filter((w) => w.error)
    .map((w) => ({ ...w.result, skip_reason: "write_failed" as const }))

  if (failedWrites.length > 0) {
    console.error(
      "[BULK-PRICE-UPDATE] write failed for package(s):",
      failedWrites.map((f) => f.id),
      writeResults.filter((w) => w.error).map((w) => w.error?.message)
    )
  }

  const skipped: SkippedResult[] = [...preSkipped, ...failedWrites]

  // Best-effort audit trail — never blocks the response on failure (same
  // fire-and-forget pattern as app/api/admin/update-balance/route.ts).
  // Reflects the same corrected updated/skipped split as the HTTP response,
  // never what was merely attempted.
  adminClient
    .from("admin_audit_log")
    .insert([
      {
        admin_id: userId,
        action: "bulk_price_update",
        target_user_id: null,
        old_value: { package_ids: packageIds, updates: safeUpdates },
        new_value: { updated, skipped, not_found },
        created_at: new Date().toISOString(),
      },
    ])
    .then(({ error }: { error: any }) => {
      if (error) console.warn("[ADMIN-AUDIT] bulk_price_update log insert failed:", error.message)
    })

  return NextResponse.json({ updated, skipped, not_found })
}
