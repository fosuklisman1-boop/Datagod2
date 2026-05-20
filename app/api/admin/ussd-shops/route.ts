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

// GET /api/admin/ussd-shops — list all shop codes with stats
export async function GET(request: NextRequest) {
  const adminId = await requireAdmin(request)
  if (!adminId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: codes, error } = await supabase
    .from("ussd_shop_codes")
    .select(`
      id, code, status, token_balance, activation_fee_paid, activation_paid_at, created_at,
      user_shops!inner(id, shop_name, user_id)
    `)
    .order("created_at", { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Fetch order counts per shop code
  const ids = (codes ?? []).map((c: any) => c.id)
  let orderCounts: Record<string, number> = {}
  if (ids.length > 0) {
    const { data: counts } = await supabase
      .from("ussd_shop_orders")
      .select("shop_code_id")
      .in("shop_code_id", ids)
    for (const row of counts ?? []) {
      orderCounts[row.shop_code_id] = (orderCounts[row.shop_code_id] ?? 0) + 1
    }
  }

  const result = (codes ?? []).map((c: any) => ({
    id: c.id,
    code: c.code,
    status: c.status,
    token_balance: c.token_balance,
    activation_fee_paid: c.activation_fee_paid,
    activation_paid_at: c.activation_paid_at,
    created_at: c.created_at,
    shop_id: c.user_shops?.id,
    shop_name: c.user_shops?.shop_name,
    shop_owner_user_id: c.user_shops?.user_id,
    order_count: orderCounts[c.id] ?? 0,
  }))

  return NextResponse.json({ data: result })
}

// POST /api/admin/ussd-shops — create a new shop code
export async function POST(request: NextRequest) {
  const adminId = await requireAdmin(request)
  if (!adminId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await request.json()
  const { shop_id, code, initial_tokens = 0 } = body

  if (!shop_id) return NextResponse.json({ error: "shop_id is required" }, { status: 400 })

  // Auto-generate a unique 4-digit code if not provided
  let finalCode = code?.trim()
  if (!finalCode) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const candidate = attempt < 10
        ? String(Math.floor(1000 + Math.random() * 9000))
        : String(Math.floor(100000 + Math.random() * 900000))
      const { data: existing } = await supabase
        .from("ussd_shop_codes").select("id").eq("code", candidate).maybeSingle()
      if (!existing) { finalCode = candidate; break }
    }
    if (!finalCode) return NextResponse.json({ error: "Could not generate a unique code" }, { status: 500 })
  }

  const { data, error } = await supabase
    .from("ussd_shop_codes")
    .insert([{ shop_id, code: finalCode, token_balance: initial_tokens }])
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: "Code already taken" }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data }, { status: 201 })
}
