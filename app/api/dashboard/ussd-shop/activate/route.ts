import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { secureNumericCode } from "@/lib/secure-random"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Self-service code provisioning -- mirrors the admin route's auto-generate
// logic (app/api/admin/ussd-shops/route.ts) so a shop owner can go from "no
// code yet" to "activated" in one click, instead of needing an admin to
// create the row first.
async function provisionShopCode(shopId: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = attempt < 10 ? secureNumericCode(4) : secureNumericCode(6)
    const { data: existing } = await supabase
      .from("ussd_shop_codes").select("id").eq("code", candidate).maybeSingle()
    if (existing) continue
    const { data: created, error } = await supabase
      .from("ussd_shop_codes")
      .insert([{ shop_id: shopId, code: candidate, token_balance: 0 }])
      .select("id, activation_fee_paid")
      .single()
    if (error) {
      if (error.code === "23505") continue // race on the code uniqueness — retry
      throw error
    }
    return created
  }
  throw new Error("Could not generate a unique USSD code")
}

// POST /api/dashboard/ussd-shop/activate
export async function POST(request: NextRequest) {
  const token = request.headers.get("Authorization")?.replace("Bearer ", "")
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: shop } = await supabase
    .from("user_shops").select("id").eq("user_id", user.id).single()
  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 })

  let shopCode = (await supabase
    .from("ussd_shop_codes").select("id, activation_fee_paid").eq("shop_id", shop.id).maybeSingle()).data

  if (!shopCode) {
    try {
      shopCode = await provisionShopCode(shop.id)
    } catch (err) {
      console.error("[USSD-ACTIVATE] Failed to provision a code:", err)
      return NextResponse.json({ error: "Could not set up your USSD code — please try again" }, { status: 500 })
    }
  }
  if (shopCode.activation_fee_paid) return NextResponse.json({ error: "Already activated" }, { status: 409 })

  const { data: settings } = await supabase
    .from("app_settings").select("ussd_shop_activation_fee").is("key", null).single()
  const fee = Number(settings?.ussd_shop_activation_fee ?? 0)

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
    console.error("[USSD-ACTIVATE] Failed to activate shop code:", activateErr)
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
