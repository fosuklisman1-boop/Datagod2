import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { chargeMobileMoney } from "@/lib/paystack"
import { resolveEmail } from "@/lib/ussd/resolve-email"

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

    await supabase
      .from("ussd_shop_codes")
      .update({
        status: 'active',
        activation_fee_paid: true,
        activation_paid_at: new Date().toISOString(),
        token_balance: initial_tokens,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)

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

  // MoMo — charge shop owner's phone
  const { data: ownerRow } = await supabase
    .from("users").select("phone_number").eq("id", shopOwnerId).single()

  if (!ownerRow?.phone_number) {
    return NextResponse.json({ error: "Shop owner phone number not found" }, { status: 400 })
  }

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
    }])
    .select("id")
    .single()

  if (!purchase) return NextResponse.json({ error: "Failed to create purchase record" }, { status: 500 })

  const email = await resolveEmail(ownerRow.phone_number)

  try {
    await chargeMobileMoney({
      email,
      amount,
      phone: ownerRow.phone_number,
      provider: 'mtn',
      reference: purchase.id,
      metadata: {
        source: 'ussd_shop_activation',
        ussd_shop_token_purchase_id: purchase.id,
        shop_code_id: id,
        initial_tokens,
      },
    })
  } catch (err: any) {
    await supabase.from("ussd_shop_token_purchases").update({ payment_status: 'failed' }).eq("id", purchase.id)
    return NextResponse.json({ error: err.message ?? "MoMo charge failed" }, { status: 502 })
  }

  return NextResponse.json({
    success: true,
    message: "MoMo prompt sent to shop owner. Shop will be activated on payment confirmation.",
    purchase_id: purchase.id,
  })
}
