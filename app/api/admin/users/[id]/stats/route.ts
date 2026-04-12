import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

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

    // Use optimized RPC to aggregate stats directly on the database.
    // This replaces multiple heavy paginated loops with a single efficient query.
    const { data: stats, error: rpcError } = await adminClient.rpc("get_user_financial_summary", { 
      p_user_id: userId 
    })

    if (rpcError) {
      console.error("[USER-STATS] RPC Error:", rpcError)
      return NextResponse.json(
        { error: "Failed to fetch user statistics. Please ensure the latest SQL migrations have been applied." },
        { status: 500 }
      )
    }

    if (!stats) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    return NextResponse.json({
      userId,
      wallet: stats.wallet,
      orders: stats.orders,
      shop: stats.shop,
      withdrawals: stats.withdrawals
    })
  } catch (error: any) {
    console.error("[USER-STATS] Unexpected error:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
