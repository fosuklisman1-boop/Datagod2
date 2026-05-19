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

// POST /api/admin/ussd-shops/[id]/tokens
// Body: { tokens: number, amount: number, payment_method: 'wallet' | 'momo' }
// wallet: deducts from the shop owner's Datagod wallet and credits tokens immediately
// momo:   initiates a Paystack MoMo charge; webhook credits tokens on success
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const adminId = await requireAdmin(request)
  if (!adminId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const body = await request.json()
  const { tokens, amount, payment_method } = body

  if (!tokens || tokens < 1) return NextResponse.json({ error: "tokens must be >= 1" }, { status: 400 })
  if (!amount || amount <= 0) return NextResponse.json({ error: "amount must be > 0" }, { status: 400 })
  if (!['wallet', 'momo'].includes(payment_method)) {
    return NextResponse.json({ error: "payment_method must be 'wallet' or 'momo'" }, { status: 400 })
  }

  const { data: shopCode } = await supabase
    .from("ussd_shop_codes")
    .select("id, shop_id, token_balance, user_shops!inner(user_id, shop_name)")
    .eq("id", id)
    .single()

  if (!shopCode) return NextResponse.json({ error: "Shop code not found" }, { status: 404 })

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
        source: 'ussd_shop_tokens',
        amount,
        balance_before: balanceBefore,
        balance_after: newBalance,
        description: `USSD shop token top-up: ${tokens} tokens`,
        reference_id: id,
        status: 'completed',
        created_at: new Date().toISOString(),
      }])
    } catch (txErr) {
      console.warn("[USSD-SHOP-TOKENS] Transaction insert failed (non-fatal):", txErr)
    }

    const { error: tokenError } = await supabase
      .from("ussd_shop_codes")
      .update({ token_balance: shopCode.token_balance + tokens, updated_at: new Date().toISOString() })
      .eq("id", id)

    if (tokenError) return NextResponse.json({ error: tokenError.message }, { status: 500 })

    await supabase.from("ussd_shop_token_purchases").insert([{
      shop_code_id: id,
      shop_id: shopCode.shop_id,
      tokens_purchased: tokens,
      amount_paid: amount,
      payment_method: 'wallet',
      payment_status: 'completed',
    }])

    return NextResponse.json({ success: true, new_token_balance: shopCode.token_balance + tokens })
  }

  const ownerAuth = await supabase.auth.admin.getUserById(shopOwnerId)
  const ownerEmail = ownerAuth.data.user?.email
  if (!ownerEmail) return NextResponse.json({ error: "Shop owner email not found" }, { status: 400 })

  const paystackRef = `USSD-SHOP-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`

  const { data: purchase, error: purchaseError } = await supabase
    .from("ussd_shop_token_purchases")
    .insert([{
      shop_code_id: id,
      shop_id: shopCode.shop_id,
      tokens_purchased: tokens,
      amount_paid: amount,
      payment_method: 'momo',
      payment_status: 'pending',
      paystack_reference: paystackRef,
    }])
    .select("id")
    .single()

  if (purchaseError || !purchase) {
    return NextResponse.json({ error: "Failed to create purchase record" }, { status: 500 })
  }

  await supabase.from("wallet_payments").insert([{
    user_id: shopOwnerId,
    order_id: purchase.id,
    order_type: 'ussd_shop_token',
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
      redirectUrl: `${appUrl}/dashboard/ussd-shop?payment=sessions&reference=${paystackRef}`,
      metadata: { source: 'ussd_shop_token', ussd_shop_token_purchase_id: purchase.id, shop_code_id: id, tokens },
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
    message: "MoMo prompt sent to shop owner. Tokens will be added on payment confirmation.",
    purchase_id: purchase.id,
  })
}
