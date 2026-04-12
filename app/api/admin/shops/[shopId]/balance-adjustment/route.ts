import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { shopProfitService } from "@/lib/shop-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

/**
 * POST /api/admin/shops/[shopId]/balance-adjustment
 * Manually credit or debit a shop's profit balance.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ shopId: string }> }
) {
  try {
    const { shopId } = await params
    const { isAdmin, userEmail, errorResponse } = await verifyAdminAccess(request)
    if (!isAdmin) return errorResponse

    const body = await request.json()
    const { amount, type, notes } = body

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return NextResponse.json({ error: "Valid amount is required" }, { status: 400 })
    }

    if (!type || !["credit", "debit"].includes(type)) {
      return NextResponse.json({ error: "Invalid adjustment type" }, { status: 400 })
    }

    // Determine final amount (negative for debit)
    const adjustmentAmount = type === "debit" ? -Math.abs(Number(amount)) : Math.abs(Number(amount))
    const displayType = type.charAt(0).toUpperCase() + type.slice(1)
    
    console.log(`[BALANCE-ADJUSTMENT] Admin ${userEmail} adjusting shop ${shopId}: ${adjustmentAmount} GHS (${notes})`)

    // 1. Insert manual profit record
    const { data: profitRecord, error: profitError } = await supabase
      .from("shop_profits")
      .insert([{
        shop_id: shopId,
        profit_amount: adjustmentAmount,
        status: "credited",
        adjustment_type: "manual",
        notes: notes || `Manual ${displayType} by admin`,
        credited_at: new Date().toISOString()
      }])
      .select()
      .single()

    if (profitError) {
      console.error("[BALANCE-ADJUSTMENT] Database error:", profitError)
      return NextResponse.json({ error: "Failed to record adjustment" }, { status: 500 })
    }

    // 2. Sync the summary balance table
    try {
      await shopProfitService.syncAvailableBalance(shopId)
    } catch (syncError) {
      console.error("[BALANCE-ADJUSTMENT] Sync warning:", syncError)
      // We don't fail the request here since the profit record was successfully saved
    }

    return NextResponse.json({
      success: true,
      message: `Successfully ${type}ed shop balance`,
      record: profitRecord
    })

  } catch (error) {
    console.error("[BALANCE-ADJUSTMENT] Critical error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
