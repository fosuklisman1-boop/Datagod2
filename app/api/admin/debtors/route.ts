import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

// Lists users whose wallet balance is negative -- i.e. the platform has
// already paid out more than they funded (real, currently-possible state;
// see profit_debt_recovery.sql for a past one-time cleanup of exactly this).
// Backs the Admin Dashboard's Float & Liability "Review settlements" link.
export async function GET(request: NextRequest) {
  try {
    const { isAdmin, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || ""
    )

    const { data: wallets, error } = await supabase
      .from("wallets")
      .select("user_id, balance, updated_at")
      .lt("balance", 0)
      .order("balance", { ascending: true })

    if (error) {
      console.error("[ADMIN-DEBTORS] Query error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const userIds = (wallets || []).map((w) => w.user_id)
    let usersById: Record<string, { email: string; first_name: string | null; role: string }> = {}
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from("users")
        .select("id, email, first_name, role")
        .in("id", userIds)
      usersById = Object.fromEntries((users || []).map((u) => [u.id, u]))
    }

    const debtors = (wallets || []).map((w) => ({
      userId: w.user_id,
      email: usersById[w.user_id]?.email || "Unknown",
      firstName: usersById[w.user_id]?.first_name || null,
      role: usersById[w.user_id]?.role || "user",
      balance: w.balance,
      updatedAt: w.updated_at,
    }))

    return NextResponse.json({
      debtors,
      totalOwed: debtors.reduce((sum, d) => sum + Math.abs(d.balance), 0),
    })
  } catch (error) {
    console.error("[ADMIN-DEBTORS] Unexpected error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load debtors" },
      { status: 500 }
    )
  }
}
