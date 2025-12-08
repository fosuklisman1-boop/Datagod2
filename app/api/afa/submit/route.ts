import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

// AFA Order Submission API Endpoint
export async function POST(request: NextRequest) {
  try {
    console.log("[AFA-SUBMIT] Request received")
    
    // Get auth header
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      console.log("[AFA-SUBMIT] No auth header")
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const token = authHeader.substring(7)
    console.log("[AFA-SUBMIT] Token extracted")

    // Verify token and get user
    const { data: { user }, error: userError } = await supabase.auth.getUser(token)
    if (userError || !user) {
      console.log("[AFA-SUBMIT] User verification failed:", userError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    console.log("[AFA-SUBMIT] User verified:", user.id)

    // Parse request body
    const body = await request.json()
    const { fullName, phoneNumber, ghCardNumber, location, region, occupation, amount, userId } = body
    console.log("[AFA-SUBMIT] Body parsed:", { fullName, phoneNumber, ghCardNumber, location, region, occupation, amount, userId })

    // Validate inputs
    if (!fullName || !phoneNumber || !ghCardNumber || !location || !region || !amount || !userId) {
      console.log("[AFA-SUBMIT] Missing required fields")
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    if (userId !== user.id) {
      console.log("[AFA-SUBMIT] User ID mismatch")
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
      console.log("[AFA-SUBMIT] Wallet not found:", walletError)
      return NextResponse.json(
        { error: "Wallet not found" },
        { status: 404 }
      )
    }

    console.log("[AFA-SUBMIT] Wallet found, balance:", wallet.balance)

    // Check balance
    if (wallet.balance < amount) {
      console.log("[AFA-SUBMIT] Insufficient balance")
      return NextResponse.json(
        { error: "Insufficient balance" },
        { status: 400 }
      )
    }

    // Generate order code and transaction code
    const orderCode = `AFA-${Date.now().toString().slice(-7)}`
    const transactionCode = Math.random().toString(36).substring(2, 12).toUpperCase()
    console.log("[AFA-SUBMIT] Generated codes:", { orderCode, transactionCode })

    // Create AFA order
    console.log("[AFA-SUBMIT] Attempting to create AFA order")
    const { data: afaOrder, error: afaError } = await supabase
      .from("afa_orders")
      .insert({
        user_id: user.id,
        order_code: orderCode,
        transaction_code: transactionCode,
        full_name: fullName,
        phone_number: phoneNumber,
        gh_card_number: ghCardNumber,
        location: location,
        region: region,
        occupation: occupation,
        amount,
        status: "pending",
        created_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (afaError) {
      console.error("[AFA-SUBMIT] Error creating AFA order:", afaError)
      return NextResponse.json(
        { error: "Failed to create AFA order", details: afaError.message },
        { status: 500 }
      )
    }

    console.log("[AFA-SUBMIT] AFA order created:", afaOrder.id)

    // Deduct from wallet
    console.log("[AFA-SUBMIT] Updating wallet")
    const { error: updateError } = await supabase
      .from("wallets")
      .update({ balance: wallet.balance - amount })
      .eq("user_id", user.id)

    if (updateError) {
      console.error("[AFA-SUBMIT] Error updating wallet:", updateError)
      return NextResponse.json(
        { error: "Failed to process payment", details: updateError.message },
        { status: 500 }
      )
    }

    console.log("[AFA-SUBMIT] Wallet updated")

    // Create transaction record
    console.log("[AFA-SUBMIT] Creating transaction record")
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
      console.error("[AFA-SUBMIT] Error creating transaction record:", transError)
      // Don't fail the response, the order was already created
    } else {
      console.log("[AFA-SUBMIT] Transaction record created")
    }

    console.log("[AFA-SUBMIT] Success - AFA order completed")
    return NextResponse.json(
      {
        success: true,
        order: afaOrder,
        message: "AFA registration submitted successfully",
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("[AFA-SUBMIT] Unexpected error:", error)
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json(
      { error: "Internal server error", details: errorMessage },
      { status: 500 }
    )
  }
}
