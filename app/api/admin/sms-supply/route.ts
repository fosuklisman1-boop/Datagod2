import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { queryMoolreSmsBalance } from "@/lib/sms-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET /api/admin/sms-supply — the SMS supply / solvency snapshot.
//   wholesaleBalance : live Moolre wholesale SMS credit (the shared pool)
//   totalUsable      : SUM of all accounts' spendable unit_balance
//   totalPending     : SUM of pending (paid-but-unbacked) credits
//   headroom         : wholesaleBalance - totalUsable (how much more can be credited now)
export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const [wholesaleBalance, usableRes, pendingRes] = await Promise.all([
    queryMoolreSmsBalance(),
    supabaseAdmin.from("sms_accounts").select("unit_balance"),
    supabaseAdmin.from("sms_pending_credits").select("units").eq("status", "pending"),
  ])

  const totalUsable = (usableRes.data ?? []).reduce(
    (s: number, r: { unit_balance: number | null }) => s + (r.unit_balance || 0), 0
  )
  const totalPending = (pendingRes.data ?? []).reduce(
    (s: number, r: { units: number | null }) => s + (r.units || 0), 0
  )
  const headroom = Math.max(0, wholesaleBalance - totalUsable)

  return NextResponse.json({
    success: true,
    data: { wholesaleBalance, totalUsable, totalPending, headroom },
  })
}
