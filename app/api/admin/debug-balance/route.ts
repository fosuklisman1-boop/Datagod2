import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const shopId = searchParams.get("shopId")

    if (!shopId) {
      return NextResponse.json({ error: "shopId required" }, { status: 400 })
    }

    // Get all profits for this shop
    const { data: profits, error: profitError } = await supabase
      .from("shop_profits")
      .select("id, shop_id, profit_amount, status, created_at")
      .eq("shop_id", shopId)

    if (profitError) throw profitError

    // Get current balance table record
    const { data: balance, error: balanceError } = await supabase
      .from("shop_available_balance")
      .select("id, shop_id, available_balance, total_profit, created_at")
      .eq("shop_id", shopId)

    if (balanceError) console.warn("Balance table error:", balanceError)

    // Calculate what balance should be
    const breakdown = {
      totalProfit: 0,
      pendingProfit: 0,
      creditedProfit: 0,
      withdrawnProfit: 0,
    }

    profits?.forEach((p: any) => {
      const amount = p.profit_amount || 0
      breakdown.totalProfit += amount

      if (p.status === "pending") {
        breakdown.pendingProfit += amount
      } else if (p.status === "credited") {
        breakdown.creditedProfit += amount
      } else if (p.status === "withdrawn") {
        breakdown.withdrawnProfit += amount
      }
    })

    const expectedAvailableBalance = breakdown.pendingProfit + breakdown.creditedProfit

    return NextResponse.json({
      shopId,
      profitRecords: profits,
      breakdown,
      expectedAvailableBalance,
      currentBalance: balance && balance.length > 0 ? balance[0] : null,
      discrepancy: {
        tableExists: balance !== null,
        recordCount: profits?.length || 0,
        balanceTableRecordExists: balance && balance.length > 0,
        expectedVsActual: expectedAvailableBalance === (balance && balance.length > 0 ? balance[0].available_balance : 0)
      }
    })
  } catch (error) {
    console.error("Debug error:", error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
