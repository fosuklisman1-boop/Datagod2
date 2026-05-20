import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { withdrawalId } = await request.json()
    if (!withdrawalId) {
      return NextResponse.json({ error: "withdrawalId required" }, { status: 400 })
    }

    const { data: withdrawal, error: fetchError } = await supabase
      .from("withdrawal_requests")
      .select("id, status")
      .eq("id", withdrawalId)
      .single()

    if (fetchError || !withdrawal) {
      return NextResponse.json({ error: "Withdrawal not found" }, { status: 404 })
    }

    if (withdrawal.status !== "processing") {
      return NextResponse.json(
        { error: `Only processing withdrawals can be reset (current: ${withdrawal.status})` },
        { status: 400 }
      )
    }

    await supabase
      .from("withdrawal_requests")
      .update({
        status: "pending",
        moolre_transfer_id: null,
        moolre_external_ref: null,
        moolre_fee: null,
        transfer_attempted_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", withdrawalId)

    console.log(`[WITHDRAWAL-RESET] Reset processing → pending: ${withdrawalId}`)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[WITHDRAWAL-RESET] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
