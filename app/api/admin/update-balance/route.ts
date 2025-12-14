import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    const { shopId, amount, type } = await request.json()

    if (!shopId || amount === undefined || !type) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    // Get the user_id from the shop
    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("user_id")
      .eq("id", shopId)
      .single()

    if (shopError || !shop) {
      return NextResponse.json(
        { error: "Shop not found" },
        { status: 404 }
      )
    }

    const userId = shop.user_id

    // Get current wallet balance
    const { data: wallet, error: walletError } = await supabase
      .from("wallets")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle()

    if (walletError) {
      console.error("Wallet fetch error:", walletError)
      return NextResponse.json(
        { error: "Failed to fetch wallet" },
        { status: 400 }
      )
    }

    if (!wallet) {
      return NextResponse.json(
        { error: "Wallet not found for user" },
        { status: 404 }
      )
    }

    const currentBalance = wallet.balance || 0
    const newBalance = type === "credit" 
      ? currentBalance + amount 
      : Math.max(0, currentBalance - amount)

    // Update wallet balance
    const { data: updated, error: updateError } = await supabase
      .from("wallets")
      .update({ balance: newBalance })
      .eq("user_id", userId)
      .select()

    if (updateError) {
      console.error("Wallet update error:", updateError)
      return NextResponse.json(
        { error: `Failed to update wallet: ${updateError.message}` },
        { status: 400 }
      )
    }

    // Create transaction history record
    const transactionType = type === "credit" ? "admin_credit" : "admin_debit"
    const description = type === "credit" 
      ? `Admin credited GHS ${amount.toFixed(2)}` 
      : `Admin debited GHS ${amount.toFixed(2)}`

    const { error: transactionError } = await supabase
      .from("transactions")
      .insert([{
        user_id: userId,
        amount: amount,
        type: transactionType,
        status: "completed",
        description: description,
        reference_id: `ADMIN_${type.toUpperCase()}_${Date.now()}`,
        source: "admin_operation",
        balance_before: currentBalance,
        balance_after: newBalance,
        created_at: new Date().toISOString(),
      }])

    if (transactionError) {
      console.error("Error creating transaction record:", transactionError)
      return NextResponse.json(
        { error: `Failed to create transaction record: ${transactionError.message}` },
        { status: 400 }
      )
    }

    return NextResponse.json({
      success: true,
      data: updated?.[0]
    })
  } catch (error: any) {
    console.error("Error in update-balance route:", error)
    return NextResponse.json(
      { error: error?.message || "Failed to update balance" },
      { status: 500 }
    )
  }
}
