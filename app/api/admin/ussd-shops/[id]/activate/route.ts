import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { initializePayment } from "@/lib/paystack"
import crypto from "crypto"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function requireAdmin(request: NextRequest): Promise<string | null> {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return null
  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return null
  const { data } = await supabase.from("users").select("role").eq("id", user.id).single()
  return data?.role === "admin" ? user.id : null
}

// POST /api/admin/ussd-shops/[id]/activate
// Body: { payment_method: 'wallet' | 'momo', amount: number, initial_tokens?: number }
// Records the one-time activation payment and sets status to 'active'.
// wallet: deducts immediately; momo: initiates charge (webhook completes activation).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const adminId = await requireAdmin(request)
  if (!adminId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const body = await request.json()
  const { payment_method, amount, initial_tokens = 0 } = body

  if (!amount || amount <= 0) return NextResponse.json({ error: "amount must be > 0" }, { status: 400 })
  if (!['wallet', 'momo'].includes(payment_method)) {
    return NextResponse.json({ error: "payment_method must be 'wallet' or 'momo'" }, { status: 400 })
  }

  const { data: shopCode } = await supabase
    .from("ussd_shop_codes")
    .select("id, shop_id, status, activation_fee_paid, user_shops!inner(user_id)")
    .eq("id", id)
    .single()

  if (!shopCode) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (shopCode.activation_fee_paid) {
    return NextResponse.json({ error: "Shop code already activated" }, { status: 409 })
  }

  const shopOwnerId = (shopCode as any).user_shops?.user_id

  if (payment_method === 'wallet') {
    if (!shopOwnerId) return NextResponse.json({ error: "Shop owner not found" }, { status: 400 })

    const { data: deductResult, error: deductError } = await supabase.rpc('deduct_wallet', {
      p_user_id: shopOwnerId,
      p_amount: amount,
    })

    if (deductError || !deductResult || deductResult.length === 0) {
      return NextResponse.json({ error: "Insufficient wallet balance" }, { status: 402 })
    }

    const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]
    try {
      await supabase.from("transactions").insert([{
        user_id: shopOwnerId,
        type: 'debit',
        source: 'ussd_shop_activation',
        amount,
        balance_before: balanceBefore,
        balance_after: newBalance,
        description: `USSD shop code activation fee`,
        reference_id: id,
        status: 'completed',
        created_at: new Date().toISOString(),
      }])
    } catch (txErr) {
      console.warn("[USSD-SHOP-ACTIVATE] Transaction insert failed (non-fatal):", txErr)
    }

    const { error: activateErr } = await supabase
      .from("ussd_shop_codes")
      .update({
        status: 'active',
        activation_fee_paid: true,
        activation_paid_at: new Date().toISOString(),
        token_balance: initial_tokens,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)

    if (activateErr) {
      console.error("[USSD-SHOP-ACTIVATE] Failed to update shop code:", activateErr)
      return NextResponse.json({ error: "Activation failed — database update error" }, { status: 500 })
    }

    await supabase.from("ussd_shop_token_purchases").insert([{
      shop_code_id: id,
      shop_id: shopCode.shop_id,
      tokens_purchased: initial_tokens,
      amount_paid: amount,
      payment_method: 'wallet',
      payment_status: 'completed',
      is_activation: true,
    }])

    return NextResponse.json({ success: true, status: 'active' })
  }

  // Paystack checkout — get owner's email for payment page
  const ownerAuth = await supabase.auth.admin.getUserById(shopOwnerId)
  const ownerEmail = ownerAuth.data.user?.email
  if (!ownerEmail) return NextResponse.json({ error: "Shop owner email not found" }, { status: 400 })

  const paystackRef = `USSD-SHOP-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`

  const { data: purchase } = await supabase
    .from("ussd_shop_token_purchases")
    .insert([{
      shop_code_id: id,
      shop_id: shopCode.shop_id,
      tokens_purchased: initial_tokens,
      amount_paid: amount,
      payment_method: 'momo',
      payment_status: 'pending',
      is_activation: true,
      paystack_reference: paystackRef,
    }])
    .select("id")
    .single()

  if (!purchase) return NextResponse.json({ error: "Failed to create purchase record" }, { status: 500 })

  await supabase.from("wallet_payments").insert([{
    user_id: shopOwnerId,
    order_id: purchase.id,
    order_type: 'ussd_shop_activation',
    amount,
    fee: 0,
    reference: paystackRef,
    status: 'pending',
    payment_method: 'momo',
    created_at: new Date().toISOString(),
  }])

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${process.env.VERCEL_URL}` || "http://localhost:3000"

  try {
    const result = await initializePayment({
      email: ownerEmail,
      amount,
      reference: paystackRef,
      redirectUrl: `${appUrl}/dashboard/ussd-shop?payment=activation&reference=${paystackRef}`,
      metadata: { source: 'ussd_shop_activation', ussd_shop_token_purchase_id: purchase.id, shop_code_id: id, initial_tokens },
      channels: ["mobile_money", "card", "bank_transfer"],
    })
    return NextResponse.json({ success: true, authorizationUrl: result.authorizationUrl, reference: paystackRef, message: "Share this payment link with the shop owner." })
  } catch (err: any) {
    await supabase.from("ussd_shop_token_purchases").update({ payment_status: 'failed' }).eq("id", purchase.id)
    await supabase.from("wallet_payments").update({ status: 'failed' }).eq("reference", paystackRef)
    return NextResponse.json({ error: err.message ?? "Payment initialization failed" }, { status: 502 })
  }

  return NextResponse.json({
    success: true,
    message: "MoMo prompt sent to shop owner. Shop will be activated on payment confirmation.",
    purchase_id: purchase.id,
  })
}
