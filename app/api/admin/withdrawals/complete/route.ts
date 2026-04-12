import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

/**
 * POST /api/admin/withdrawals/complete
 * Marks an approved withdrawal as completed, marks matching profits as withdrawn,
 * and syncs the available balance.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { withdrawalId } = await request.json()
  if (!withdrawalId || typeof withdrawalId !== "string") {
    return NextResponse.json({ error: "withdrawalId is required" }, { status: 400 })
  }

  const { data: withdrawal, error: fetchError } = await supabase
    .from("withdrawal_requests")
    .select("id, shop_id, amount, status")
    .eq("id", withdrawalId)
    .single()

  if (fetchError || !withdrawal) {
    return NextResponse.json({ error: "Withdrawal not found" }, { status: 404 })
  }

  if (withdrawal.status !== "approved") {
    return NextResponse.json(
      { error: `Only approved withdrawals can be marked as completed (current: ${withdrawal.status})` },
      { status: 400 }
    )
  }

  // Mark withdrawal as completed
  const { error: updateError } = await supabase
    .from("withdrawal_requests")
    .update({ status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", withdrawalId)

  if (updateError) {
    return NextResponse.json({ error: `Failed to update withdrawal: ${updateError.message}` }, { status: 500 })
  }

  console.log(`[WITHDRAWAL-COMPLETE] Admin ${adminId} marked withdrawal ${withdrawalId} as completed — Amount: GHS ${withdrawal.amount}`)

  // Available balance is automatically synced via the database trigger sync_shop_balance
  // which fires when withdrawal_requests changes status.



  return NextResponse.json({ success: true, message: "Withdrawal marked as completed" })
}
