import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { sendEmail, EmailTemplates } from "@/lib/email-service"

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
// Body: { initial_tokens?: number }
// Manually activates a shop code with an optional initial token balance.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const adminId = await requireAdmin(request)
  if (!adminId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { initial_tokens = 0 } = await request.json()

  const { data: shopCode } = await supabase
    .from("ussd_shop_codes")
    .select("id, shop_id, code, activation_fee_paid, user_shops!inner(user_id, shop_name)")
    .eq("id", id)
    .single()

  if (!shopCode) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (shopCode.activation_fee_paid) return NextResponse.json({ error: "Shop code already activated" }, { status: 409 })

  const shopOwnerId = (shopCode as any).user_shops?.user_id
  const shopName: string = (shopCode as any).user_shops?.shop_name ?? "Your shop"
  const shopCodeStr: string = (shopCode as any).code ?? ""
  if (!shopOwnerId) return NextResponse.json({ error: "Shop owner not found" }, { status: 400 })

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
    console.error("[ADMIN-USSD-ACTIVATE] Failed to update shop code:", activateErr)
    return NextResponse.json({ error: "Activation failed — database update error" }, { status: 500 })
  }

  await supabase.from("ussd_shop_token_purchases").insert([{
    shop_code_id: id,
    shop_id: shopCode.shop_id,
    tokens_purchased: initial_tokens,
    amount_paid: 0,
    payment_method: 'manual',
    payment_status: 'completed',
    is_activation: true,
  }])

  // Send activation email to shop owner (non-blocking)
  ;(async () => {
    try {
      const { data: owner } = await supabase.from("users").select("email, first_name").eq("id", shopOwnerId).single()
      if (!owner?.email) return
      const tpl = EmailTemplates.ussdShopActivated(shopName, shopCodeStr, initial_tokens)
      await sendEmail({
        to: [{ email: owner.email, name: owner.first_name ?? undefined }],
        subject: tpl.subject,
        htmlContent: tpl.html,
        type: 'ussd_shop_activated',
        referenceId: id,
      })
    } catch (err) {
      console.warn("[ADMIN-USSD-ACTIVATE] email failed (non-fatal):", err)
    }
  })()

  return NextResponse.json({ success: true, status: 'active' })
}
