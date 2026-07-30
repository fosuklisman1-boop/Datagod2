import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { adminRevokeWhatsappShop } from "@/lib/shop-commerce/whatsapp-activation"

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

// POST /api/admin/ussd-shops/[id]/whatsapp-deactivate
// Pure access-flag revoke — no refund/reversal logic.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const adminId = await requireAdmin(request)
  if (!adminId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  const { data: shopCode } = await supabase
    .from("ussd_shop_codes")
    .select("id")
    .eq("id", id)
    .single()

  if (!shopCode) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const result = await adminRevokeWhatsappShop({ shopCodeId: id })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })

  return NextResponse.json({ success: true, whatsapp_activated: false })
}
