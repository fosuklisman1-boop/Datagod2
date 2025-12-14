import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface WalletData {
  balance: number
  totalCredited: number
  totalDebited: number
  transactionCount: number
}

export async function GET(request: NextRequest) {
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

    if (authError) {
      console.error("Auth error:", authError)
      return NextResponse.json(
        { error: "Unauthorized: " + authError.message },
        { status: 401 }
      )
    }

    if (!user) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 401 }
      )
    }

    const userId = user.id

    // Get wallet balance data from wallet_balance table
    const { data: walletBalance, error: walletError } = await supabase
      .from("wallet_balance")
      .select("balance")
      .eq("user_id", userId)
      .maybeSingle()

    if (walletError) {
      console.error("Wallet fetch error:", walletError)
      return NextResponse.json(
        { error: "Failed to fetch wallet" },
        { status: 400 }
      )
    }

    // If wallet doesn't exist, return 0
    if (!walletBalance) {
      return NextResponse.json({
        balance: 0,
        totalCredited: 0,
        totalDebited: 0,
        transactionCount: 0,
      })
    }

    // Get transaction count
    const { count } = await supabase
      .from("transactions")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)

    const walletData: WalletData = {
      balance: walletBalance.balance || 0,
      totalCredited: 0,
      totalDebited: 0,
      transactionCount: count || 0,
    }

    console.log("[WALLET-BALANCE] User:", userId, "Wallet data:", walletData)

    return NextResponse.json(walletData)
  } catch (error) {
    console.error("Error fetching wallet balance:", error)
    return NextResponse.json(
      { error: "Internal server error: " + (error instanceof Error ? error.message : "Unknown error") },
      { status: 500 }
    )
  }
}
