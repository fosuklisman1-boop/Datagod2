import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { checkMTNOrderStatus, syncMTNOrderStatus } from "@/lib/mtn-fulfillment"
import { runStaleRecheck } from "@/lib/stale-tracking-recheck"

/**
 * POST /api/admin/stale-tracking/recheck
 *
 * One-off cleanup tool for tracking rows that have been open (pending/processing) for more than a week.
 * Asks the provider once more for each row and reports what it says. With { apply: true } it applies ONLY
 * provider-confirmed completions (through syncMTNOrderStatus, which also updates the order table).
 * Provider-confirmed failures are never applied here: syncMTNOrderStatus would put the order back to
 * "pending", which can resend a week-old paid order. Those, and every unresolved row, are for the owner
 * to decide per order. Runs in production because provider API keys only exist there.
 */
export const maxDuration = 300

const PROVIDERS = ["agentportalgh", "sykes"] as const
const MIN_AGE_DAYS = 7
const MAX_LIMIT = 40

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  let body: any = {}
  try {
    const text = await request.text()
    body = text ? JSON.parse(text) : {}
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const apply = body?.apply === true
  const olderThanDays = body?.olderThanDays ?? MIN_AGE_DAYS
  const limit = body?.limit ?? MAX_LIMIT
  const afterId: string | null = body?.afterId ?? null

  if (typeof olderThanDays !== "number" || !Number.isFinite(olderThanDays) || olderThanDays < MIN_AGE_DAYS) {
    return NextResponse.json({ error: `olderThanDays must be a number >= ${MIN_AGE_DAYS}` }, { status: 400 })
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return NextResponse.json({ error: `limit must be an integer from 1 to ${MAX_LIMIT}` }, { status: 400 })
  }
  if (afterId !== null && typeof afterId !== "string") {
    return NextResponse.json({ error: "afterId must be a string" }, { status: 400 })
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const cutoffIso = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()
  let query = adminClient
    .from("mtn_fulfillment_tracking")
    .select("id, mtn_order_id, provider, order_type, status, created_at, order_id, shop_order_id, api_order_id")
    .in("provider", [...PROVIDERS])
    .in("status", ["pending", "processing"])
    .lt("created_at", cutoffIso)
    .not("mtn_order_id", "is", null)
    .order("id", { ascending: true })
    .limit(limit)
  if (afterId) query = query.gt("id", afterId)

  const { data: rows, error } = await query
  if (error) {
    console.error("[STALE-RECHECK] Failed to load rows:", error.message)
    return NextResponse.json({ error: "Failed to load stale rows" }, { status: 500 })
  }

  const list = (rows as any[]) ?? []

  // The linked order's current status, branched exactly like syncMTNOrderStatus's order-table mirror
  // (USSD/USSD-shop ids live in order_id, so order_type is checked first).
  const orderStatus = async (row: any): Promise<string | null> => {
    let table: string | null = null
    let col = "order_status"
    let id: string | null = null
    if (row.order_type === "bulk" && row.order_id) { table = "orders"; col = "status"; id = row.order_id }
    else if (row.order_type === "api" && (row.api_order_id || row.order_id)) { table = "api_orders"; col = "status"; id = row.api_order_id || row.order_id }
    else if (row.order_type === "ussd" && row.order_id) { table = "ussd_orders"; id = row.order_id }
    else if (row.order_type === "ussd_shop" && row.order_id) { table = "ussd_shop_orders"; id = row.order_id }
    else if (row.shop_order_id) { table = "shop_orders"; id = row.shop_order_id }
    if (!table || !id) return null
    const { data } = await adminClient.from(table).select(col).eq("id", id).maybeSingle()
    return ((data as any)?.[col] as string | undefined) ?? null
  }

  const { counts, rows: report } = await runStaleRecheck(list, { apply }, {
    check: (row) => checkMTNOrderStatus(row.mtn_order_id, row.provider),
    orderStatus,
    sync: (trackingId) => syncMTNOrderStatus(trackingId),
    sleep,
  })

  if (apply) {
    adminClient
      .from("admin_audit_log")
      .insert([
        {
          admin_id: userId,
          action: "stale_tracking_recheck",
          target_user_id: null,
          old_value: { ids: list.map((r) => r.id) },
          new_value: counts,
          created_at: new Date().toISOString(),
        },
      ])
      .then(({ error: auditError }: { error: any }) => {
        if (auditError) console.warn("[ADMIN-AUDIT] stale_tracking_recheck log insert failed:", auditError.message)
      })
  }

  console.log(`[STALE-RECHECK] apply=${apply} checked=${list.length}`, counts)

  return NextResponse.json({
    apply,
    checked: list.length,
    nextAfterId: list.length === limit ? list[list.length - 1].id : null,
    counts,
    rows: report,
  })
}
