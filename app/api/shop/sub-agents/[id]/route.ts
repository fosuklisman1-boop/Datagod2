import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { subAgentRemovalUpdate } from "@/lib/sub-agents/open-shop"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// DELETE: remove a sub-agent from the caller's network, scoped strictly to the
// parent/sub-agent relationship (this route is the parent acting on a
// DIFFERENT shop). An invited sub-agent only loses parent_shop_id/tier_level,
// as before. A storefront joiner skipped admin approval, so it is also closed
// (is_active=false), loses joined_via and dealer rates, and lands in the normal
// admin approval queue instead of becoming an unreviewed main shop (see
// subAgentRemovalUpdate). is_blocked is never touched here: it stays admin-only.
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
      .select("id, shop_name, parent_shop_id, joined_via")
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
      .update(subAgentRemovalUpdate(subAgent))
      .eq("id", id)
      .eq("parent_shop_id", shop.id)
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
