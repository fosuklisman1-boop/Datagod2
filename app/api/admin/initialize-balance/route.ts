import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * Initialize shop_available_balance table with existing profit data
 * GET /api/admin/initialize-balance
 */
export async function GET(request: NextRequest) {
  try {
    // Get all shops with their profits
    const { data: shops, error: shopsError } = await supabase
      .from("shop_profits")
      .select("shop_id")
      .limit(1)

    if (shopsError && shopsError.code !== "PGRST116") {
      return NextResponse.json(
        { error: "Failed to fetch shops" },
        { status: 500 }
      )
    }

    // Get all unique shop IDs with profits
    const { data: allProfits, error: profitsError } = await supabase
      .from("shop_profits")
      .select("shop_id, profit_amount, status")

    if (profitsError) {
      return NextResponse.json(
        { error: "Failed to fetch profits" },
        { status: 500 }
      )
    }

    // Group by shop_id and calculate balances
    const shopBalances: { [key: string]: any } = {}

    allProfits?.forEach((profit: any) => {
      if (!shopBalances[profit.shop_id]) {
        shopBalances[profit.shop_id] = {
          shop_id: profit.shop_id,
          total_profit: 0,
          pending_profit: 0,
          credited_profit: 0,
          withdrawn_profit: 0,
        }
      }

      const amount = profit.profit_amount || 0
      shopBalances[profit.shop_id].total_profit += amount

      if (profit.status === "pending") {
        shopBalances[profit.shop_id].pending_profit += amount
      } else if (profit.status === "credited") {
        shopBalances[profit.shop_id].credited_profit += amount
      } else if (profit.status === "withdrawn") {
        shopBalances[profit.shop_id].withdrawn_profit += amount
      }
    })

    // Insert into shop_available_balance
    const recordsToInsert = Object.values(shopBalances).map((balance: any) => ({
      shop_id: balance.shop_id,
      available_balance: balance.pending_profit + balance.credited_profit,
      total_profit: balance.total_profit,
      withdrawn_amount: balance.withdrawn_profit,
      pending_profit: balance.pending_profit,
      credited_profit: balance.credited_profit,
      withdrawn_profit: balance.withdrawn_profit,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }))

    if (recordsToInsert.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No shops with profits to initialize",
        count: 0,
      })
    }

    const { error: insertError } = await supabase
      .from("shop_available_balance")
      .upsert(recordsToInsert, { onConflict: "shop_id" })

    if (insertError) {
      console.error("Error inserting balance records:", insertError)
      return NextResponse.json(
        { error: `Failed to initialize balances: ${insertError.message}` },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      message: "Shop available balance table initialized",
      count: recordsToInsert.length,
      shops: recordsToInsert.map((r: any) => ({
        shop_id: r.shop_id,
        available_balance: r.available_balance,
        total_profit: r.total_profit,
      })),
    })
  } catch (error) {
    console.error("Error initializing balance:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
