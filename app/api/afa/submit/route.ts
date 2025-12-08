import { NextRequest, NextResponse } from "next/server"
import { supabase } from "@/lib/supabase"

export async function POST(request: NextRequest) {
  try {
    // Get auth header
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.substring(7)

    // Verify token and get user
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Parse request body
    const body = await request.json()
    const { fullName, phoneNumber, amount, userId } = body

    // Validate inputs
    if (!fullName || !phoneNumber || !amount || !userId) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    if (userId !== user.id) {
      return NextResponse.json(
        { error: "User ID mismatch" },
        { status: 401 }
      )
    }

    // Get user's wallet
    const { data: wallet, error: walletError } = await supabase
      .from("wallets")
      .select("balance")
      .eq("user_id", user.id)
      .single()

    if (walletError || !wallet) {
      return NextResponse.json(
        { error: "Wallet not found" },
        { status: 404 }
      )
    }

    // Check balance
    if (wallet.balance < amount) {
      return NextResponse.json(
        { error: "Insufficient balance" },
        { status: 400 }
      )
    }

    // Generate order code and transaction code
    const orderCode = `AFA-${Date.now().toString().slice(-7)}`
    const transactionCode = Math.random().toString(36).substring(2, 12).toUpperCase()

    // Create AFA order
    const { data: afaOrder, error: afaError } = await supabase
      .from("afa_orders")
      .insert({
        user_id: user.id,
        order_code: orderCode,
        transaction_code: transactionCode,
        full_name: fullName,
        phone_number: phoneNumber,
        amount,
        status: "pending",
        created_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (afaError) {
      console.error("Error creating AFA order:", afaError)
      return NextResponse.json(
        { error: "Failed to create AFA order" },
        { status: 500 }
      )
    }

    // Deduct from wallet
    const { error: updateError } = await supabase
      .from("wallets")
      .update({ balance: wallet.balance - amount })
      .eq("user_id", user.id)

    if (updateError) {
      console.error("Error updating wallet:", updateError)
      return NextResponse.json(
        { error: "Failed to process payment" },
        { status: 500 }
      )
    }

    // Create transaction record
    const { error: transError } = await supabase
      .from("wallet_transactions")
      .insert({
        user_id: user.id,
        type: "debit",
        amount,
        description: `AFA Registration - ${fullName}`,
        reference: transactionCode,
        source: "afa_registration",
        created_at: new Date().toISOString(),
      })

    if (transError) {
      console.error("Error creating transaction record:", transError)
      // Don't fail the response, the order was already created
    }

    return NextResponse.json(
      {
        success: true,
        order: afaOrder,
        message: "AFA registration submitted successfully",
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("Error in AFA submit:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
