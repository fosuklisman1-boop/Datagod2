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

// GET /api/admin/ussd-shops/[id]
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const adminId = await requireAdmin(request)
  if (!adminId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data, error } = await supabase
    .from("ussd_shop_codes")
    .select(`id, code, status, token_balance, activation_fee_paid, activation_paid_at, created_at, user_shops!inner(shop_name, user_id)`)
    .eq("id", params.id)
    .single()

  if (error || !data) return NextResponse.json({ error: "Not found" }, { status: 404 })

  return NextResponse.json({ data })
}

// PUT /api/admin/ussd-shops/[id] — update status or code
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const adminId = await requireAdmin(request)
  if (!adminId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json()
  const allowed = ['status', 'code']
  const updates: Record<string, any> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key]
  }

  const { data, error } = await supabase
    .from("ussd_shop_codes")
    .update(updates)
    .eq("id", params.id)
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: "Code already taken" }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

// DELETE /api/admin/ussd-shops/[id] — only if no pending orders and token balance is 0
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const adminId = await requireAdmin(request)
  if (!adminId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: code } = await supabase
    .from("ussd_shop_codes").select("token_balance").eq("id", params.id).single()
  if (!code) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { count: pendingCount } = await supabase
    .from("ussd_shop_orders")
    .select("id", { count: 'exact', head: true })
    .eq("shop_code_id", params.id)
    .in("order_status", ['pending', 'processing'])

  if ((pendingCount ?? 0) > 0) {
    return NextResponse.json({ error: "Cannot delete: shop has pending orders" }, { status: 409 })
  }

  const { error } = await supabase.from("ussd_shop_codes").delete().eq("id", params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
