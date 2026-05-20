import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST /api/dashboard/ussd-shop/buy-sessions
// Body: { sessions: number }
export async function POST(request: NextRequest) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { sessions } = await request.json()

  const { data: settings } = await supabase
    .from("app_settings")
    .select("ussd_shop_session_price, ussd_shop_min_sessions, ussd_shop_max_sessions")
    .limit(1).single()

  const sessionPrice = Number(settings?.ussd_shop_session_price ?? 0)
  const minSessions = Number(settings?.ussd_shop_min_sessions ?? 1)
  const maxSessions = Number(settings?.ussd_shop_max_sessions ?? 100)

  if (!sessions || sessions < minSessions || sessions > maxSessions) {
    return NextResponse.json({ error: `Sessions must be between ${minSessions} and ${maxSessions}` }, { status: 400 })
  }

  const totalAmount = sessionPrice * sessions

  const { data: shop } = await supabase
    .from("user_shops").select("id").eq("user_id", user.id).single()
  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 })

  const { data: shopCode } = await supabase
    .from("ussd_shop_codes").select("id, token_balance").eq("shop_id", shop.id).single()
  if (!shopCode) return NextResponse.json({ error: "No USSD code assigned to your shop" }, { status: 404 })

  if (totalAmount > 0) {
    const { data: deductResult, error: deductError } = await supabase.rpc('deduct_wallet', {
      p_user_id: user.id,
      p_amount: totalAmount,
    })
    if (deductError || !deductResult || deductResult.length === 0) {
      return NextResponse.json({ error: "Insufficient wallet balance" }, { status: 402 })
    }
    const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]
    await supabase.from("transactions").insert([{
      user_id: user.id,
      type: 'debit',
      source: 'ussd_shop_tokens',
      amount: totalAmount,
      balance_before: balanceBefore,
      balance_after: newBalance,
      description: `USSD shop session top-up: ${sessions} sessions`,
      reference_id: shopCode.id,
      status: 'completed',
      created_at: new Date().toISOString(),
    }]).then(({ error }) => { if (error) console.warn("[USSD-BUY-SESSIONS] tx insert failed:", error) })
  }

  const { error: creditErr } = await supabase
    .from("ussd_shop_codes")
    .update({ token_balance: shopCode.token_balance + sessions, updated_at: new Date().toISOString() })
    .eq("id", shopCode.id)

  if (creditErr) {
    console.error("[USSD-BUY-SESSIONS] Failed to credit token balance:", creditErr)
    return NextResponse.json({ error: "Failed to credit sessions — please contact support" }, { status: 500 })
  }

  await supabase.from("ussd_shop_token_purchases").insert([{
    shop_code_id: shopCode.id,
    shop_id: shop.id,
    tokens_purchased: sessions,
    amount_paid: totalAmount,
    payment_method: 'wallet',
    payment_status: 'completed',
  }])

  return NextResponse.json({ success: true, new_token_balance: shopCode.token_balance + sessions })
}
