import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = user.id
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayString = today.toISOString()

    // Get total transaction count
    const { count: totalCount } = await supabase
      .from("wallet_transactions")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)

    // Get today's income (credits)
    const { data: todayCredits } = await supabase
      .from("wallet_transactions")
      .select("amount")
      .eq("user_id", userId)
      .eq("type", "credit")
      .gte("created_at", todayString)

    const todayIncome = todayCredits?.reduce((sum, t) => sum + t.amount, 0) || 0

    // Get today's expenses (debits)
    const { data: todayDebits } = await supabase
      .from("wallet_transactions")
      .select("amount")
      .eq("user_id", userId)
      .eq("type", "debit")
      .gte("created_at", todayString)

    const todayExpenses = todayDebits?.reduce((sum, t) => sum + t.amount, 0) || 0

    // Get today's refunds
    const { data: todayRefunds } = await supabase
      .from("wallet_transactions")
      .select("amount")
      .eq("user_id", userId)
      .eq("type", "refund")
      .gte("created_at", todayString)

    const todayRefundsTotal = todayRefunds?.reduce((sum, t) => sum + t.amount, 0) || 0

    return NextResponse.json({
      totalTransactions: totalCount || 0,
      todayIncome,
      todayExpenses,
      todayRefunds: todayRefundsTotal,
    })
  } catch (error) {
    console.error("Error fetching transaction stats:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
