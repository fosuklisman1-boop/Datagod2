import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { withdrawalService } from "@/lib/shop-service"

// Server-side withdrawal creation. The fee is read from `app_settings`, which is
// locked to service_role — so this MUST run here, not in the browser. Doing it
// client-side meant the read intermittently executed as `anon` (42501) and the
// old code silently waived the fee. Routing through this service-role endpoint
// removes the race entirely and the fee read now fails closed.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

export async function POST(request: NextRequest) {
  // 1) Authenticate the caller
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const token = authHeader.substring(7)
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token)
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // 2) Parse + validate input
  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  const { shopId, amount, withdrawal_method, account_details } = body || {}
  if (!shopId || typeof amount !== "number" || !withdrawal_method || !account_details) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 })
  }

  // 3) Authorize: the caller must own the shop they're withdrawing from
  const { data: shop, error: shopError } = await supabaseAdmin
    .from("user_shops")
    .select("id, user_id")
    .eq("id", shopId)
    .maybeSingle()
  if (shopError) {
    console.error("[WITHDRAWAL-CREATE-API] Shop lookup failed:", shopError.message)
    return NextResponse.json({ error: "Could not verify shop ownership" }, { status: 500 })
  }
  if (!shop || shop.user_id !== user.id) {
    return NextResponse.json({ error: "You do not have permission to withdraw from this shop" }, { status: 403 })
  }

  // 4) Create the withdrawal with the service-role client so the fee read (and all
  //    other app_settings-locked reads) succeed. Domain validation errors thrown
  //    by the service are surfaced to the client as 400s with their message.
  try {
    const created = await withdrawalService.createWithdrawalRequest(
      user.id,
      shopId,
      { amount, withdrawal_method, account_details },
      supabaseAdmin
    )
    return NextResponse.json({ success: true, withdrawal: created })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create withdrawal request"
    console.error("[WITHDRAWAL-CREATE-API] Error:", message)
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
