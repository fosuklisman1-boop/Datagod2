import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { adminGrantWhatsappShop } from "@/lib/shop-commerce/whatsapp-activation"
import { sendPushToUser } from "@/lib/push-service"

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

// POST /api/admin/ussd-shops/[id]/whatsapp-activate
// Admin-granted WhatsApp activation — no wallet charge. Mirrors the sibling
// USSD /activate route's "manual activation" pattern.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const adminId = await requireAdmin(request)
  if (!adminId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: shopCode } = await supabase
    .from("ussd_shop_codes")
    .select("id, shop_id, code, user_shops!inner(user_id, shop_name)")
    .eq("id", id)
    .single()

  if (!shopCode) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const result = await adminGrantWhatsappShop({ shopCodeId: id, shopId: shopCode.shop_id })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  const shopOwnerId = (shopCode as any).user_shops?.user_id
  const shopName: string = (shopCode as any).user_shops?.shop_name ?? "Your shop"
  const shopCodeStr: string = (shopCode as any).code ?? ""

  if (shopOwnerId) {
    sendPushToUser(shopOwnerId, {
      title: "WhatsApp Shop Activated",
      body: `WhatsApp ordering is now active for "${shopName}" (code ${shopCodeStr}).`,
      data: { url: `/dashboard/ussd-shop` },
    }).catch(() => {})
  }

  return NextResponse.json({ success: true, whatsapp_activated: true })
}
