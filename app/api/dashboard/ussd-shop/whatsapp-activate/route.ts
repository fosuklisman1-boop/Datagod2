import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST /api/dashboard/ussd-shop/whatsapp-activate
// One-time fee to unlock the WhatsApp shop bot for the caller's shop code.
// Mirrors app/api/dashboard/ussd-shop/activate/route.ts's auth + wallet-deduction
// charge pattern exactly (that route's actual payment mechanism today is a
// synchronous Datagod-wallet deduction, not a Paystack redirect/MoMo charge —
// there is no hosted/direct-charge activation flow currently wired to any UI).
// This activation grants NO USSD sessions — it only flips whatsapp_activated.
// token_balance / status / activation_fee_paid stay untouched and exclusively
// tied to the USSD activation path.
export async function POST(request: NextRequest) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: shop } = await supabase
    .from("user_shops").select("id").eq("user_id", user.id).single()
  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 })

  const { data: shopCode } = await supabase
    .from("ussd_shop_codes").select("id, whatsapp_activated").eq("shop_id", shop.id).single()
  if (!shopCode) return NextResponse.json({ error: "No USSD code assigned to your shop" }, { status: 404 })
  if (shopCode.whatsapp_activated) return NextResponse.json({ error: "Already activated" }, { status: 409 })

  const { data: settings } = await supabase
    .from("app_settings").select("whatsapp_shop_activation_fee").limit(1).single()
  const fee = Number(settings?.whatsapp_shop_activation_fee ?? 0)

  // Unlike USSD activation (which allows a free activation when the admin fee is
  // 0), WhatsApp activation requires the admin to have explicitly set a fee — a
  // fee of 0 means the feature hasn't been priced/rolled out yet.
  if (fee <= 0) {
    return NextResponse.json({ error: "WhatsApp activation is not available yet" }, { status: 400 })
  }

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
    source: 'whatsapp_shop_activation',
    amount: fee,
    balance_before: balanceBefore,
    balance_after: newBalance,
    description: 'WhatsApp shop activation fee',
    reference_id: shopCode.id,
    status: 'completed',
    created_at: new Date().toISOString(),
  }]).then(({ error }) => { if (error) console.warn("[WHATSAPP-ACTIVATE] tx insert failed:", error) })

  const { error: activateErr } = await supabase
    .from("ussd_shop_codes")
    .update({
      whatsapp_activated: true,
      whatsapp_activated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", shopCode.id)

  if (activateErr) {
    console.error("[WHATSAPP-ACTIVATE] Failed to activate WhatsApp shop:", activateErr)
    return NextResponse.json({ error: "Activation failed — please contact support" }, { status: 500 })
  }

  await supabase.from("ussd_shop_token_purchases").insert([{
    shop_code_id: shopCode.id,
    shop_id: shop.id,
    tokens_purchased: 0,
    amount_paid: fee,
    payment_method: 'wallet',
    payment_status: 'completed',
    is_whatsapp_activation: true,
  }])

  return NextResponse.json({ success: true, whatsapp_activated: true })
}
