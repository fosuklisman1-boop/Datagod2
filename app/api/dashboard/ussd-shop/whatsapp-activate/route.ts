import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { activateWhatsappShop } from "@/lib/shop-commerce/whatsapp-activation"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST /api/dashboard/ussd-shop/whatsapp-activate
// One-time fee to unlock the WhatsApp shop bot for the caller's shop code.
// Mirrors app/api/dashboard/ussd-shop/activate/route.ts's auth + wallet-deduction
// charge pattern (that route's actual payment mechanism today is a synchronous
// Datagod-wallet deduction, not a Paystack redirect/MoMo charge — there is no
// hosted/direct-charge activation flow currently wired to any UI), but the
// actual claim + charge + rollback logic lives in
// lib/shop-commerce/whatsapp-activation.ts (activateWhatsappShop) — an atomic
// "claim-then-pay" so two concurrent requests for the same shop code can't
// both deduct the wallet (see that module's comment for the race it closes).
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
    .from("ussd_shop_codes").select("id").eq("shop_id", shop.id).single()
  if (!shopCode) return NextResponse.json({ error: "No USSD code assigned to your shop" }, { status: 404 })

  const { data: settings } = await supabase
    .from("app_settings").select("whatsapp_shop_activation_fee").limit(1).single()
  const fee = Number(settings?.whatsapp_shop_activation_fee ?? 0)

  // Unlike USSD activation (which allows a free activation when the admin fee is
  // 0), WhatsApp activation requires the admin to have explicitly set a fee — a
  // fee of 0 means the feature hasn't been priced/rolled out yet.
  if (fee <= 0) {
    return NextResponse.json({ error: "WhatsApp activation is not available yet" }, { status: 400 })
  }

  const result = await activateWhatsappShop({ shopCodeId: shopCode.id, shopId: shop.id, userId: user.id, fee })
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }

  return NextResponse.json({ success: true, whatsapp_activated: true })
}
