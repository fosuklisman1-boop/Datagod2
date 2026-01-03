import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyUserPendingPayments } from "@/lib/payment-cleanup-service"

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

    // Verify any pending payments for this user (in background, don't block response)
    verifyUserPendingPayments(userId).then(result => {
      if (result.credited > 0 || result.failed > 0) {
        console.log(`[WALLET-BALANCE] Verified pending payments for ${userId}:`, result)
      }
    }).catch(err => {
      console.warn("[WALLET-BALANCE] Error verifying pending payments:", err)
    })

    // Get wallet balance data from wallets table
    const { data: walletData, error: walletError } = await supabase
      .from("wallets")
      .select("balance, total_credited, total_spent")
      .eq("user_id", userId)
      .maybeSingle()

    if (walletError) {
      console.error("[WALLET-BALANCE] Wallet fetch error:", walletError)
      return NextResponse.json(
        { error: "Failed to fetch wallet", details: walletError.message },
        { status: 400 }
      )
    }

    // If wallet doesn't exist, create one automatically
    if (!walletData) {
      console.log("[WALLET-BALANCE] Wallet not found for user:", userId, "Creating new wallet")
      const { data: newWallet, error: createError } = await supabase
        .from("wallets")
        .insert({
          user_id: userId,
          balance: 0,
          total_credited: 0,
          total_spent: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single()

      if (createError) {
        console.error("[WALLET-BALANCE] Error creating wallet:", createError)
        // Return zeros rather than failing
        return NextResponse.json({
          balance: 0,
          totalCredited: 0,
          totalDebited: 0,
          transactionCount: 0,
        })
      }

      console.log("[WALLET-BALANCE] Wallet created for user:", userId)
      return NextResponse.json({
        balance: newWallet.balance || 0,
        totalCredited: newWallet.total_credited || 0,
        totalDebited: newWallet.total_spent || 0,
        transactionCount: 0,
      })
    }

    const balance = walletData.balance || 0
    const totalCredited = walletData.total_credited || 0
    const totalDebited = walletData.total_spent || 0

    console.log("[WALLET-BALANCE] User:", userId, "Balance:", balance, "Credited:", totalCredited, "Spent:", totalDebited)

    return NextResponse.json({
      balance,
      totalCredited,
      totalDebited,
      transactionCount: 0,
    })
  } catch (error) {
    console.error("Error fetching wallet balance:", error)
    return NextResponse.json(
      { error: "Internal server error: " + (error instanceof Error ? error.message : "Unknown error") },
      { status: 500 }
    )
  }
}
