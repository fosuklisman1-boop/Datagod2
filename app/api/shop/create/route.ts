import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Server-side shop creation. Migration 0077 revoked INSERT on every public table
// from `authenticated`/`anon`, so the old browser-client insert in
// shopService.createShop now fails with "permission denied for table user_shops".
// Routing through this service-role endpoint restores creation AND closes the
// latent trust bug: identity is taken from the verified JWT (not a client-supplied
// userId) and the privileged `is_active` flag is forced false (admin must approve)
// rather than trusted from the browser. user_shops carries status + markup fields,
// so 0077's guidance forbids re-granting on an ownership-only RLS policy — this
// route is the sanctioned fix.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

export async function POST(request: NextRequest) {
  // 1) Authenticate the caller from their session token.
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const token = authHeader.substring(7)
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token)
  if (userError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // 2) Parse + validate input.
  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }
  const shop_name = typeof body?.shop_name === "string" ? body.shop_name.trim() : ""
  const shop_slug = typeof body?.shop_slug === "string" ? body.shop_slug.trim() : ""
  if (!shop_name) {
    return NextResponse.json({ error: "Shop name is required" }, { status: 400 })
  }
  if (!shop_slug) {
    return NextResponse.json({ error: "Shop slug is required" }, { status: 400 })
  }
  // Optional presentation fields — coerce to null when absent/blank.
  const description = typeof body?.description === "string" && body.description.trim() ? body.description.trim() : null
  const logo_url = typeof body?.logo_url === "string" && body.logo_url.trim() ? body.logo_url.trim() : null
  const banner_url = typeof body?.banner_url === "string" && body.banner_url.trim() ? body.banner_url.trim() : null

  // 3) Insert with SERVER-controlled identity + status. user_id comes from the
  //    verified token (never the client) and is_active is forced false so new
  //    shops still go through admin approval.
  const { data, error } = await supabaseAdmin
    .from("user_shops")
    .insert([{
      user_id: user.id,
      shop_name,
      shop_slug,
      description,
      logo_url,
      banner_url,
      is_active: false,
    }])
    .select()
    .single()

  if (error) {
    // Unique-violation on shop_slug (or any other unique key) → friendly 409.
    if (error.code === "23505") {
      return NextResponse.json(
        { error: "That shop link is already taken — please try a different name." },
        { status: 409 }
      )
    }
    console.error("[SHOP-CREATE-API] Insert failed:", error.message)
    return NextResponse.json({ error: "Failed to create shop" }, { status: 500 })
  }

  return NextResponse.json({ success: true, shop: data })
}
