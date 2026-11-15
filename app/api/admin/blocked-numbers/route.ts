// Admin list + stats for blocked MTN numbers. Phones appear in the response (admin-only); logs carry counts only.
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase"
import { getCustomerVerificationSettings } from "@/lib/mtn-providers/customer-verification"
import { PAGE_SIZE, parseListParams, aggregateAttempts, type AttemptLite } from "@/lib/blocked-numbers/admin-view"
import { NUMBER_COLUMNS, applyFilters, shopIdsForSearch, shopNames, type NumberRow } from "@/lib/blocked-numbers/admin-query"

export const dynamic = "force-dynamic"

const DAY_MS = 86_400_000
const SURFACE_READ_CAP = 20_000
const PAGE = 1000
const ATTEMPT_READ_LIMIT = 1000

async function headCount(build: (q: any) => any): Promise<number> {
  const { count, error } = await build(supabaseAdmin.from("mtn_blocked_numbers").select("id", { count: "exact", head: true }))
  if (error) throw new Error(`count failed: ${error.code ?? "db"}`)
  return count ?? 0
}

async function loadStats(now: Date) {
  const d7 = new Date(now.getTime() - 7 * DAY_MS).toISOString()
  const d1 = new Date(now.getTime() - DAY_MS).toISOString()
  const [open, allowed7, texted7, expired] = await Promise.all([
    headCount((q) => q.eq("status", "blocked")),
    headCount((q) => q.gte("allowed_at", d7)),
    headCount((q) => q.gte("customer_notified_at", d7)),
    headCount((q) => q.eq("status", "expired")),
  ])
  const a24 = await supabaseAdmin.from("mtn_blocked_attempts").select("id", { count: "exact", head: true }).gte("created_at", d1)
  if (a24.error) throw new Error(`count failed: ${a24.error.code ?? "db"}`)

  const bySurface = new Map<string, number>()
  let read = 0
  for (let from = 0; from < SURFACE_READ_CAP; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("mtn_blocked_attempts")
      .select("surface")
      .gte("created_at", d7)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`surface read failed: ${error.code ?? "db"}`)
    const rows = (data ?? []) as Array<{ surface: string }>
    for (const r of rows) bySurface.set(r.surface, (bySurface.get(r.surface) ?? 0) + 1)
    read += rows.length
    if (rows.length < PAGE) break
  }
  return {
    open,
    becameAllowed7d: allowed7,
    customersTexted7d: texted7,
    expired,
    attempts24h: a24.count ?? 0,
    surfaces7d: [...bySurface.entries()].sort((a, b) => b[1] - a[1]).map(([surface, count]) => ({ surface, count })),
    surfaces7dTruncated: read >= SURFACE_READ_CAP,
  }
}

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const sp = new URL(request.url).searchParams
    const p = parseListParams(sp)
    const shopSearchIds = await shopIdsForSearch(supabaseAdmin, p.q)

    const from = (p.page - 1) * PAGE_SIZE
    const { data, count, error } = await applyFilters(
      supabaseAdmin.from("mtn_blocked_numbers").select(NUMBER_COLUMNS, { count: "exact" }),
      p,
      shopSearchIds
    )
      .order("last_blocked_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`list failed: ${error.code ?? "db"}`)
    const numbers = (data ?? []) as NumberRow[]

    // Surfaces and shops per number: the denormalised last_* first, then whatever attempts add (bounded read).
    let agg = new Map<string, { surfaces: string[]; shopIds: string[] }>()
    if (numbers.length > 0) {
      const att = await supabaseAdmin
        .from("mtn_blocked_attempts")
        .select("blocked_number_id, surface, shop_id")
        .in("blocked_number_id", numbers.map((n) => n.id))
        .order("created_at", { ascending: false })
        .limit(ATTEMPT_READ_LIMIT)
      if (att.error) throw new Error(`attempts failed: ${att.error.code ?? "db"}`)
      agg = aggregateAttempts((att.data ?? []) as AttemptLite[])
    }
    const names = await shopNames(
      supabaseAdmin,
      numbers.flatMap((n) => [...(n.last_shop_id ? [n.last_shop_id] : []), ...(agg.get(n.id)?.shopIds ?? [])])
    )
    const rows = numbers.map((n) => {
      const a = agg.get(n.id)
      const surfaces = [...new Set([...(n.last_surface ? [n.last_surface] : []), ...(a?.surfaces ?? [])])]
      const shopIds = [...new Set([...(n.last_shop_id ? [n.last_shop_id] : []), ...(a?.shopIds ?? [])])]
      return { ...n, surfaces, shopNames: shopIds.map((id) => names.get(id) ?? "Unnamed shop") }
    })

    const withStats = sp.get("include_stats") === "1"
    const stats = withStats ? await loadStats(new Date()) : null
    // Supplier dropdown is limited to the current checkout provider list (the export route enforces the same list).
    const suppliers = withStats ? (await getCustomerVerificationSettings()).providers : []
    return NextResponse.json({ rows, total: count ?? 0, page: p.page, pageSize: PAGE_SIZE, stats, suppliers })
  } catch (err) {
    console.error("[BLOCKED-ADMIN] list failed:", err instanceof Error ? err.message : "UnknownError")
    return NextResponse.json({ error: "Failed to load blocked numbers" }, { status: 500 })
  }
}
