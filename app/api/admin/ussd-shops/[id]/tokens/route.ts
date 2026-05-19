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
// Body: { tokens: number, amount: number }
// Deducts amount from shop owner's wallet and credits tokens to the shop code.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const adminId = await requireAdmin(request)
  if (!adminId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const { tokens, amount } = await request.json()

  if (!tokens || tokens < 1) return NextResponse.json({ error: "tokens must be >= 1" }, { status: 400 })
  if (!amount || amount <= 0) return NextResponse.json({ error: "amount must be > 0" }, { status: 400 })

  const { data: shopCode } = await supabase
    .from("ussd_shop_codes")
    .select("id, shop_id, token_balance, user_shops!inner(user_id)")
    .eq("id", id)
    .single()

  if (!shopCode) return NextResponse.json({ error: "Shop code not found" }, { status: 404 })

  const shopOwnerId = (shopCode as any).user_shops?.user_id
  if (!shopOwnerId) return NextResponse.json({ error: "Shop owner not found" }, { status: 400 })

  const { data: deductResult, error: deductError } = await supabase.rpc('deduct_wallet', {
    p_user_id: shopOwnerId,
    p_amount: amount,
  })

  if (deductError || !deductResult || deductResult.length === 0) {
    return NextResponse.json({ error: "Insufficient wallet balance" }, { status: 402 })
  }

  const { new_balance: newBalance, old_balance: balanceBefore } = deductResult[0]
  await supabase.from("transactions").insert([{
    user_id: shopOwnerId,
    type: 'debit',
    source: 'ussd_shop_tokens',
    amount,
    balance_before: balanceBefore,
    balance_after: newBalance,
    description: `USSD shop token top-up: ${tokens} tokens`,
    reference_id: id,
    status: 'completed',
    created_at: new Date().toISOString(),
  }]).then(({ error }) => { if (error) console.warn("[ADMIN-USSD-TOKENS] tx insert failed:", error) })

  const { error: tokenError } = await supabase
    .from("ussd_shop_codes")
    .update({ token_balance: shopCode.token_balance + tokens, updated_at: new Date().toISOString() })
    .eq("id", id)

  if (tokenError) return NextResponse.json({ error: tokenError.message }, { status: 500 })

  await supabase.from("ussd_shop_token_purchases").insert([{
    shop_code_id: id,
    shop_id: shopCode.shop_id,
    tokens_purchased: tokens,
    amount_paid: amount,
    payment_method: 'wallet',
    payment_status: 'completed',
  }])

  return NextResponse.json({ success: true, new_token_balance: shopCode.token_balance + tokens })
}
