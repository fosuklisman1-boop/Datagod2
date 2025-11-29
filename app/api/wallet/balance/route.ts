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

    // Get wallet data from wallets table
    const { data: wallet, error: walletError } = await supabase
      .from("wallets")
      .select("balance, total_credited, total_spent")
      .eq("user_id", userId)
      .maybeSingle()

    if (walletError) {
      console.error("Wallet fetch error:", walletError)
      return NextResponse.json(
        { error: "Failed to fetch wallet" },
        { status: 400 }
      )
    }

    // If wallet doesn't exist, create one with 0 balance
    if (!wallet) {
      const { data: newWallet, error: createError } = await supabase
        .from("wallets")
        .insert([{
          user_id: userId,
          balance: 0,
          total_credited: 0,
          total_spent: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }])
        .select()
        .single()

      if (createError) {
        console.error("Wallet creation error:", createError)
        return NextResponse.json(
          { error: "Failed to create wallet" },
          { status: 400 }
        )
      }

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
      balance: wallet.balance || 0,
      totalCredited: wallet.total_credited || 0,
      totalDebited: wallet.total_spent || 0,
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
