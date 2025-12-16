import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    // Get user from auth header
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user) {
      console.error("[WALLET-DEBIT] Auth error:", authError)
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const { amount, orderId, description } = await request.json()

    console.log("[WALLET-DEBIT] Request received:")
    console.log("  User:", user.id)
    console.log("  Amount:", amount)
    console.log("  Order ID:", orderId)
    console.log("  Description:", description)

    if (!amount || amount <= 0) {
      return NextResponse.json(
        { error: "Invalid amount" },
        { status: 400 }
      )
    }

    // Get wallet (select only needed columns)
    console.log("[WALLET-DEBIT] Fetching wallet...")
    const { data: wallet, error: walletError } = await supabase
      .from("wallets")
      .select("balance, total_spent")
      .eq("user_id", user.id)
      .maybeSingle()

    if (walletError) {
      console.error("[WALLET-DEBIT] Wallet fetch error:", walletError)
      return NextResponse.json(
        { error: "Failed to fetch wallet" },
        { status: 400 }
      )
    }

    if (!wallet) {
      return NextResponse.json(
        { error: "Wallet not found" },
        { status: 404 }
      )
    }

    const currentBalance = wallet.balance || 0
    console.log("[WALLET-DEBIT] Current balance:", currentBalance)

    if (currentBalance < amount) {
      console.warn("[WALLET-DEBIT] Insufficient balance")
      return NextResponse.json(
        {
          error: "Insufficient balance",
          currentBalance,
          required: amount,
        },
        { status: 400 }
      )
    }

    // Deduct from wallet
    console.log("[WALLET-DEBIT] Deducting amount...")
    const newBalance = currentBalance - amount
    const newTotalSpent = (wallet.total_spent || 0) + amount

    const { error: updateError } = await supabase
      .from("wallets")
      .update({
        balance: newBalance,
        total_spent: newTotalSpent,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id)

    if (updateError) {
      console.error("[WALLET-DEBIT] Update error:", updateError)
      return NextResponse.json(
        { error: "Failed to update wallet" },
        { status: 400 }
      )
    }

    // Create debit transaction
    console.log("[WALLET-DEBIT] Creating transaction...")
    const { error: txError } = await supabase
      .from("transactions")
      .insert([{
        user_id: user.id,
        type: "debit",
        amount,
        reference_id: orderId,
        description: description || "Order payment",
        source: "wallet_debit",
        status: "completed",
        balance_before: currentBalance,
        balance_after: newBalance,
        created_at: new Date().toISOString(),
      }])

    if (txError) {
      console.error("[WALLET-DEBIT] Transaction error:", txError)
      return NextResponse.json(
        { error: "Failed to create transaction" },
        { status: 400 }
      )
    }

    // If this is a shop order payment via wallet, mark it as paid
    if (orderId) {
      console.log("[WALLET-DEBIT] Checking if order is a shop order...")
      const { data: shopOrder, error: shopOrderError } = await supabase
        .from("shop_orders")
        .select("id")
        .eq("id", orderId)
        .maybeSingle()

      if (!shopOrderError && shopOrder) {
        console.log("[WALLET-DEBIT] Marking shop order payment as completed...")
        const { error: updateShopOrderError } = await supabase
          .from("shop_orders")
          .update({
            payment_status: "completed",
            order_status: "pending", // Keep as pending for admin to process
            updated_at: new Date().toISOString(),
          })
          .eq("id", orderId)

        if (updateShopOrderError) {
          console.error("[WALLET-DEBIT] Failed to update shop order:", updateShopOrderError)
        } else {
          console.log("[WALLET-DEBIT] ✓ Shop order payment status updated to completed")
        }
      }
    }

    console.log("[WALLET-DEBIT] ✓ Success - New balance:", newBalance)

    return NextResponse.json({
      success: true,
      newBalance,
      amount,
      reference: orderId,
    })
  } catch (error) {
    console.error("[WALLET-DEBIT] ✗ Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
