import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

/**
 * POST /api/admin/withdrawals/recalibrate
 * Calls a single Postgres function that recalculates and upserts the correct
 * available_balance for every shop in one DB round trip.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  console.log(`[RECALIBRATE] Admin ${adminId} triggered balance recalibration`)

  const { data, error } = await supabase.rpc("recalibrate_shop_balances")

  if (error) {
    console.error("[RECALIBRATE] Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const result = data as {
    total: number
    changed: number
    changes: { shopId: string; before: number; after: number; diff: number }[] | null
  }

  console.log(`[RECALIBRATE] Done — ${result.total} shops, ${result.changed} balances changed`)

  return NextResponse.json({
    success: true,
    summary: {
      total: result.total,
      balancesChanged: result.changed,
    },
    changes: result.changes || [],
  })
}
