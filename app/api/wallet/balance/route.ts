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

    // Get wallet data
    const { data: wallet, error: walletError } = await supabase
      .from("user_wallets")
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

    // If wallet doesn't exist, create one with 0 balance
    if (!wallet) {
      const { data: newWallet, error: createError } = await supabase
        .from("user_wallets")
        .insert([{ user_id: userId, balance: 0 }])
        .select()
        .single()

      if (createError) {
        console.error("Wallet creation error:", createError)
        return NextResponse.json(
          { error: "Failed to create wallet" },
          { status: 400 }
        )
      }
    }

    // Get total credited (sum of credit transactions)
    const { data: creditData, error: creditError } = await supabase
      .from("wallet_transactions")
      .select("amount")
      .eq("user_id", userId)
      .eq("type", "credit")

    if (creditError) {
      console.error("Credit error:", creditError)
      return NextResponse.json(
        { error: "Failed to fetch credits" },
        { status: 400 }
      )
    }

    const totalCredited = creditData?.reduce((sum, t) => sum + t.amount, 0) || 0

    // Get total debited (sum of debit transactions)
    const { data: debitData, error: debitError } = await supabase
      .from("wallet_transactions")
      .select("amount")
      .eq("user_id", userId)
      .eq("type", "debit")

    if (debitError) {
      console.error("Debit error:", debitError)
      return NextResponse.json(
        { error: "Failed to fetch debits" },
        { status: 400 }
      )
    }

    const totalDebited = debitData?.reduce((sum, t) => sum + t.amount, 0) || 0

    // Get transaction count
    const { count } = await supabase
      .from("wallet_transactions")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)

    const walletData: WalletData = {
      balance: wallet?.balance || 0,
      totalCredited,
      totalDebited,
      transactionCount: count || 0,
    }

    return NextResponse.json(walletData)
  } catch (error) {
    console.error("Error fetching wallet balance:", error)
    return NextResponse.json(
      { error: "Internal server error: " + (error instanceof Error ? error.message : "Unknown error") },
      { status: 500 }
    )
  }
}
