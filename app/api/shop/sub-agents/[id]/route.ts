import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// DELETE: remove a sub-agent from the caller's network. Only clears the
// sub-agent's own parent_shop_id/tier_level -- never touches is_active or
// is_blocked, which stay admin-only (/api/shop/manage explicitly blocks a
// shop from setting those on itself; this route is the parent acting on a
// DIFFERENT shop, scoped strictly to the parent/sub-agent relationship).
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7))
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { data: shop, error: shopError } = await supabase
      .from("user_shops")
      .select("id")
      .eq("user_id", user.id)
      .single()
    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    const { data: subAgent, error: subAgentError } = await supabase
      .from("user_shops")
      .select("id, shop_name, parent_shop_id")
      .eq("id", id)
      .single()
    if (subAgentError || !subAgent) {
      return NextResponse.json({ error: "Sub-agent not found" }, { status: 404 })
    }
    if (subAgent.parent_shop_id !== shop.id) {
      return NextResponse.json({ error: "This shop is not in your network" }, { status: 403 })
    }

    const { error: updateError } = await supabase
      .from("user_shops")
      .update({ parent_shop_id: null, tier_level: 1 })
      .eq("id", id)
    if (updateError) {
      console.error("[SUB-AGENTS] Failed to remove sub-agent:", updateError.message)
      return NextResponse.json({ error: "Could not remove this sub-agent. Please try again." }, { status: 500 })
    }

    return NextResponse.json({ success: true, shop_name: subAgent.shop_name })
  } catch (error) {
    console.error("[SUB-AGENTS] DELETE error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
