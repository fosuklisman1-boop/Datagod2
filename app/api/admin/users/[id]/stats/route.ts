import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

/** PostgREST "function not found in the schema cache" (e.g. migration 0145 not applied yet). */
const FUNCTION_NOT_FOUND = "PGRST202"

/**
 * GET /api/admin/users/[id]/stats
 *
 * { userId, wallet, orders, shop, withdrawals } from public.admin_user_stats
 * (migrations/0145): every sum and count is a SQL aggregate. If that function is
 * not deployed yet, falls back to get_user_financial_summary, which returns the
 * same JSON. (The old in-JS fallback, which loaded up to 5,000 transactions and
 * 10,000 shop orders and filtered on shop_orders columns that do not exist, is gone.)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  try {
    const { id: userId } = await params

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    let { data: stats, error: rpcError } = await adminClient.rpc("admin_user_stats", { p_user_id: userId })

    if (rpcError?.code === FUNCTION_NOT_FOUND) {
      console.warn("[USER-STATS] admin_user_stats not deployed, using get_user_financial_summary")
      ;({ data: stats, error: rpcError } = await adminClient.rpc("get_user_financial_summary", { p_user_id: userId }))
    }

    if (rpcError) {
      console.error("[USER-STATS] RPC failed:", rpcError.message)
      return NextResponse.json({ error: rpcError.message || "Failed to load user stats" }, { status: 500 })
    }

    if (!stats) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    return NextResponse.json({
      userId,
      wallet: stats.wallet,
      orders: stats.orders,
      shop: stats.shop,
      withdrawals: stats.withdrawals,
    })
  } catch (error: any) {
    console.error("[USER-STATS] Unexpected error:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
