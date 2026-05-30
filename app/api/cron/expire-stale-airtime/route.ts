import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Orders unpaid for longer than this are considered abandoned
const EXPIRY_MINUTES = 30

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  try {
    const cutoff = new Date(Date.now() - EXPIRY_MINUTES * 60 * 1000).toISOString()

    const { data, error } = await supabase
      .from("airtime_orders")
      .update({ status: "expired", payment_status: "expired", updated_at: new Date().toISOString() })
      .eq("status", "pending_payment")
      .eq("payment_status", "pending_payment")
      .lt("created_at", cutoff)
      .select("id")

    if (error) {
      console.error("[EXPIRE-AIRTIME] DB error:", error)
      return NextResponse.json({ error: "DB update failed" }, { status: 500 })
    }

    const expired = data?.length ?? 0
    console.log(`[EXPIRE-AIRTIME] Expired ${expired} stale airtime orders (cutoff: ${cutoff})`)

    return NextResponse.json({ expired })
  } catch (err) {
    console.error("[EXPIRE-AIRTIME] Unexpected error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
