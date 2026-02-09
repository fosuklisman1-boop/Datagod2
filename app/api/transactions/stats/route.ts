import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * Helper function to fetch all transactions with pagination
 */
async function fetchAllTransactions(
  userId: string,
  type: string,
  startDate: string
) {
  let allTransactions: any[] = []
  let offset = 0
  const batchSize = 1000
  let hasMore = true

  while (hasMore) {
    const { data, error } = await supabase
      .from("transactions")
      .select("amount")
      .eq("user_id", userId)
      .eq("type", type)
      .gte("created_at", startDate)
      .range(offset, offset + batchSize - 1)

    if (error) throw error

    if (data && data.length > 0) {
      allTransactions = allTransactions.concat(data)
      offset += batchSize
      hasMore = data.length === batchSize
    } else {
      hasMore = false
    }
  }

  return allTransactions
}

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
      .from("transactions")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)

    // Get today's income (credits) WITH PAGINATION
    const todayCredits = await fetchAllTransactions(userId, "credit", todayString)
    const todayIncome = todayCredits.reduce((sum, t) => sum + t.amount, 0)

    // Get today's expenses (debits) WITH PAGINATION
    const todayDebits = await fetchAllTransactions(userId, "debit", todayString)
    const todayExpenses = todayDebits.reduce((sum, t) => sum + t.amount, 0)

    // Get today's refunds WITH PAGINATION
    const todayRefunds = await fetchAllTransactions(userId, "refund", todayString)
    const todayRefundsTotal = todayRefunds.reduce((sum, t) => sum + t.amount, 0)

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
