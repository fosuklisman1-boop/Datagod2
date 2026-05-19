import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

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
// Body: { tokens: number }
// Admin grants tokens directly — no payment deducted.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const adminId = await requireAdmin(request)
  if (!adminId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { tokens } = await request.json()

  if (!tokens || tokens < 1) return NextResponse.json({ error: "tokens must be >= 1" }, { status: 400 })

  const { data: shopCode } = await supabase
    .from("ussd_shop_codes")
    .select("id, shop_id, token_balance")
    .eq("id", id)
    .single()

  if (!shopCode) return NextResponse.json({ error: "Shop code not found" }, { status: 404 })

  const { error: tokenError } = await supabase
    .from("ussd_shop_codes")
    .update({ token_balance: shopCode.token_balance + tokens, updated_at: new Date().toISOString() })
    .eq("id", id)

  if (tokenError) return NextResponse.json({ error: tokenError.message }, { status: 500 })

  await supabase.from("ussd_shop_token_purchases").insert([{
    shop_code_id: id,
    shop_id: shopCode.shop_id,
    tokens_purchased: tokens,
    amount_paid: 0,
    payment_method: 'admin',
    payment_status: 'completed',
  }]).then(({ error }) => { if (error) console.warn("[ADMIN-USSD-TOKENS] audit insert failed:", error) })

  return NextResponse.json({ success: true, new_token_balance: shopCode.token_balance + tokens })
}
