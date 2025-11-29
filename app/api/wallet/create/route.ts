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
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    // Create wallet for user
    const { data: newWallet, error: createError } = await supabase
      .from("wallets")
      .insert([{
        user_id: user.id,
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
      success: true,
      wallet: {
        balance: newWallet.balance,
        totalCredited: newWallet.total_credited,
        totalDebited: newWallet.total_spent,
      },
    })
  } catch (error) {
    console.error("Wallet creation error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
