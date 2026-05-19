import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { chargeMobileMoney } from "@/lib/paystack"
import { resolveEmail } from "@/lib/ussd/resolve-email"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST /api/dashboard/ussd-shop/activate
// Body: { payment_method: 'wallet' | 'momo' }
// Shop owner self-service activation — fee is read from app_settings.
export async function POST(request: NextRequest) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { payment_method } = await request.json()
  if (!['wallet', 'momo'].includes(payment_method)) {
    return NextResponse.json({ error: "payment_method must be 'wallet' or 'momo'" }, { status: 400 })
  }

  // Fetch the shop and its code
  const { data: shop } = await supabase
    .from("user_shops")
    .select("id")
    .eq("user_id", user.id)
    .single()

  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 })

  const { data: shopCode } = await supabase
    .from("ussd_shop_codes")
    .select("id, activation_fee_paid, status")
    .eq("shop_id", shop.id)
    .single()

  if (!shopCode) return NextResponse.json({ error: "No USSD code assigned to your shop" }, { status: 404 })
  if (shopCode.activation_fee_paid) return NextResponse.json({ error: "Already activated" }, { status: 409 })

  // Read activation fee from settings
  const { data: settings } = await supabase
    .from("app_settings")
    .select("ussd_shop_activation_fee")
    .limit(1)
    .single()

  const fee = Number(settings?.ussd_shop_activation_fee ?? 0)

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
      try {
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
        }])
      } catch (txErr) {
        console.warn("[USSD-SHOP-SELF-ACTIVATE] Transaction insert failed (non-fatal):", txErr)
      }
    }

    await supabase
      .from("ussd_shop_codes")
      .update({ status: 'active', activation_fee_paid: true, activation_paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", shopCode.id)

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

  // MoMo — fetch phone number
  const { data: userRow } = await supabase
    .from("users")
    .select("phone_number")
    .eq("id", user.id)
    .single()

  if (!userRow?.phone_number) {
    return NextResponse.json({ error: "Phone number not found on your account" }, { status: 400 })
  }

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
    }])
    .select("id")
    .single()

  if (!purchase) return NextResponse.json({ error: "Failed to create payment record" }, { status: 500 })

  const email = await resolveEmail(userRow.phone_number)

  try {
    await chargeMobileMoney({
      email,
      amount: fee,
      phone: userRow.phone_number,
      provider: 'mtn',
      reference: purchase.id,
      metadata: {
        source: 'ussd_shop_activation',
        ussd_shop_token_purchase_id: purchase.id,
        shop_code_id: shopCode.id,
        initial_tokens: 0,
      },
    })
  } catch (err: any) {
    await supabase.from("ussd_shop_token_purchases").update({ payment_status: 'failed' }).eq("id", purchase.id)
    return NextResponse.json({ error: err.message ?? "MoMo charge failed" }, { status: 502 })
  }

  return NextResponse.json({
    success: true,
    message: "MoMo prompt sent to your phone. Your code will be activated on payment confirmation.",
  })
}
