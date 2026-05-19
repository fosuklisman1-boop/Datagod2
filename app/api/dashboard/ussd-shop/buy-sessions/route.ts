import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { chargeMobileMoney } from "@/lib/paystack"
import { resolveEmail } from "@/lib/ussd/resolve-email"
import crypto from "crypto"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST /api/dashboard/ussd-shop/buy-sessions
// Body: { sessions: number, payment_method: 'wallet' | 'momo' }
export async function POST(request: NextRequest) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { sessions, payment_method, momo_phone } = await request.json()

  if (!['wallet', 'momo'].includes(payment_method)) {
    return NextResponse.json({ error: "payment_method must be 'wallet' or 'momo'" }, { status: 400 })
  }

  // Load session settings
  const { data: settings } = await supabase
    .from("app_settings")
    .select("ussd_shop_session_price, ussd_shop_min_sessions, ussd_shop_max_sessions")
    .limit(1)
    .single()

  const sessionPrice = Number(settings?.ussd_shop_session_price ?? 0)
  const minSessions = Number(settings?.ussd_shop_min_sessions ?? 1)
  const maxSessions = Number(settings?.ussd_shop_max_sessions ?? 100)

  if (!sessions || sessions < minSessions || sessions > maxSessions) {
    return NextResponse.json({
      error: `Sessions must be between ${minSessions} and ${maxSessions}`,
    }, { status: 400 })
  }

  const totalAmount = sessionPrice * sessions

  // Fetch shop and its code
  const { data: shop } = await supabase
    .from("user_shops")
    .select("id")
    .eq("user_id", user.id)
    .single()

  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 })

  const { data: shopCode } = await supabase
    .from("ussd_shop_codes")
    .select("id, token_balance")
    .eq("shop_id", shop.id)
    .single()

  if (!shopCode) return NextResponse.json({ error: "No USSD code assigned to your shop" }, { status: 404 })

  if (payment_method === 'wallet') {
    if (totalAmount > 0) {
      const { data: deductResult, error: deductError } = await supabase.rpc('deduct_wallet', {
        p_user_id: user.id,
        p_amount: totalAmount,
      })
      if (deductError || !deductResult || deductResult.length === 0) {
        return NextResponse.json({ error: "Insufficient wallet balance" }, { status: 402 })
      }
      const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]
      try {
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
        }])
      } catch (txErr) {
        console.warn("[USSD-SHOP-BUY-SESSIONS] Transaction insert failed (non-fatal):", txErr)
      }
    }

    const { error: creditErr } = await supabase
      .from("ussd_shop_codes")
      .update({ token_balance: shopCode.token_balance + sessions, updated_at: new Date().toISOString() })
      .eq("id", shopCode.id)

    if (creditErr) {
      console.error("[USSD-SHOP-BUY-SESSIONS] Failed to credit token balance:", creditErr)
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

  // MoMo — use provided number or fall back to account phone
  const { data: userRow } = await supabase
    .from("users").select("phone_number").eq("id", user.id).single()

  const chargePhone = momo_phone?.trim() || userRow?.phone_number
  if (!chargePhone) {
    return NextResponse.json({ error: "No phone number provided and none on your account" }, { status: 400 })
  }

  const paystackRef = `USSD-SHOP-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`

  const { data: purchase } = await supabase
    .from("ussd_shop_token_purchases")
    .insert([{
      shop_code_id: shopCode.id,
      shop_id: shop.id,
      tokens_purchased: sessions,
      amount_paid: totalAmount,
      payment_method: 'momo',
      payment_status: 'pending',
      paystack_reference: paystackRef,
    }])
    .select("id")
    .single()

  if (!purchase) return NextResponse.json({ error: "Failed to create payment record" }, { status: 500 })

  // Create wallet_payments record so the webhook can find it via the standard flow
  await supabase.from("wallet_payments").insert([{
    user_id: user.id,
    order_id: purchase.id,
    order_type: 'ussd_shop_token',
    amount: totalAmount,
    fee: 0,
    reference: paystackRef,
    status: 'pending',
    payment_method: 'momo',
    created_at: new Date().toISOString(),
  }])

  const email = await resolveEmail(chargePhone)

  try {
    await chargeMobileMoney({
      email,
      amount: totalAmount,
      phone: chargePhone,
      provider: 'mtn',
      reference: paystackRef,
      metadata: {
        source: 'ussd_shop_token',
        ussd_shop_token_purchase_id: purchase.id,
        shop_code_id: shopCode.id,
        tokens: sessions,
      },
    })
  } catch (err: any) {
    await supabase.from("ussd_shop_token_purchases").update({ payment_status: 'failed' }).eq("id", purchase.id)
    await supabase.from("wallet_payments").update({ status: 'failed' }).eq("reference", paystackRef)
    return NextResponse.json({ error: err.message ?? "MoMo charge failed" }, { status: 502 })
  }

  return NextResponse.json({
    success: true,
    message: `MoMo prompt sent. ${sessions} sessions will be added on payment confirmation.`,
  })
}
