import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { initializePayment } from "@/lib/paystack"
import crypto from "crypto"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST /api/dashboard/ussd-shop/activate
// Body: { payment_method: 'wallet' | 'momo' }
export async function POST(request: NextRequest) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { payment_method } = await request.json()
  if (!['wallet', 'momo'].includes(payment_method)) {
    return NextResponse.json({ error: "payment_method must be 'wallet' or 'momo'" }, { status: 400 })
  }

  const { data: shop } = await supabase
    .from("user_shops").select("id").eq("user_id", user.id).single()
  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 })

  const { data: shopCode } = await supabase
    .from("ussd_shop_codes").select("id, activation_fee_paid, status").eq("shop_id", shop.id).single()
  if (!shopCode) return NextResponse.json({ error: "No USSD code assigned to your shop" }, { status: 404 })
  if (shopCode.activation_fee_paid) return NextResponse.json({ error: "Already activated" }, { status: 409 })

  const { data: settings } = await supabase
    .from("app_settings").select("ussd_shop_activation_fee").limit(1).single()
  const fee = Number(settings?.ussd_shop_activation_fee ?? 0)

  console.log("[USSD-ACTIVATE] user:", user.id, "shopCode:", shopCode.id, "fee:", fee, "method:", payment_method)

  // ── Wallet path ──────────────────────────────────────────────────────────────
  if (payment_method === 'wallet') {
    if (fee > 0) {
      const { data: deductResult, error: deductError } = await supabase.rpc('deduct_wallet', {
        p_user_id: user.id,
        p_amount: fee,
      })
      if (deductError || !deductResult || deductResult.length === 0) {
        return NextResponse.json({ error: "Insufficient wallet balance" }, { status: 402 })
      }
      const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]
      await supabase.from("transactions").insert([{
        user_id: user.id,
        type: 'debit',
        source: 'ussd_shop_activation',
        amount: fee,
        balance_before: balanceBefore,
        balance_after: newBalance,
        description: 'USSD shop code activation fee',
        reference_id: shopCode.id,
        status: 'completed',
        created_at: new Date().toISOString(),
      }]).then(({ error }) => { if (error) console.warn("[USSD-ACTIVATE] tx insert failed:", error) })
    }

    const { error: activateErr } = await supabase
      .from("ussd_shop_codes")
      .update({ status: 'active', activation_fee_paid: true, activation_paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", shopCode.id)

    if (activateErr) {
      console.error("[USSD-ACTIVATE] Failed to update shop code:", activateErr)
      return NextResponse.json({ error: "Activation failed — please contact support" }, { status: 500 })
    }

    await supabase.from("ussd_shop_token_purchases").insert([{
      shop_code_id: shopCode.id,
      shop_id: shop.id,
      tokens_purchased: 0,
      amount_paid: fee,
      payment_method: 'wallet',
      payment_status: 'completed',
      is_activation: true,
    }])

    return NextResponse.json({ success: true, status: 'active' })
  }

  // ── Paystack checkout path ────────────────────────────────────────────────────
  const paystackRef = `USSD-SHOP-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`

  const { data: purchase } = await supabase
    .from("ussd_shop_token_purchases")
    .insert([{
      shop_code_id: shopCode.id,
      shop_id: shop.id,
      tokens_purchased: 0,
      amount_paid: fee,
      payment_method: 'momo',
      payment_status: 'pending',
      is_activation: true,
      paystack_reference: paystackRef,
    }])
    .select("id")
    .single()

  if (!purchase) return NextResponse.json({ error: "Failed to create payment record" }, { status: 500 })

  const { error: wpErr } = await supabase.from("wallet_payments").insert([{
    user_id: user.id,
    shop_id: shop.id,
    order_id: purchase.id,
    order_type: 'ussd_shop_activation',
    amount: fee,
    fee: 0,
    reference: paystackRef,
    status: 'pending',
    payment_method: 'momo',
    created_at: new Date().toISOString(),
  }])

  if (wpErr) {
    console.error("[USSD-ACTIVATE] wallet_payments insert failed:", wpErr)
    await supabase.from("ussd_shop_token_purchases").update({ payment_status: 'failed' }).eq("id", purchase.id)
    return NextResponse.json({ error: "Failed to create payment record" }, { status: 500 })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${process.env.VERCEL_URL}` || "http://localhost:3000"

  try {
    const result = await initializePayment({
      email: user.email!,
      amount: fee,
      reference: paystackRef,
      redirectUrl: `${appUrl}/dashboard/ussd-shop?payment=activation&reference=${paystackRef}`,
      metadata: {
        source: 'ussd_shop_activation',
        ussd_shop_token_purchase_id: purchase.id,
        shop_code_id: shopCode.id,
      },
      channels: ["mobile_money", "card", "bank_transfer"],
    })
    return NextResponse.json({ success: true, authorizationUrl: result.authorizationUrl, reference: paystackRef })
  } catch (err: any) {
    await supabase.from("ussd_shop_token_purchases").update({ payment_status: 'failed' }).eq("id", purchase.id)
    await supabase.from("wallet_payments").update({ status: 'failed' }).eq("reference", paystackRef)
    return NextResponse.json({ error: err.message ?? "Payment initialization failed" }, { status: 502 })
  }
}
