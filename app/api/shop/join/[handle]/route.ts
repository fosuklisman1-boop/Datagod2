import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { shopHandleOrFilter } from "@/lib/shop-handle"
import { targetStatus } from "@/lib/sub-agents/join-eligibility"
import { getWholesalePackages } from "@/lib/sub-agents/wholesale-packages"
import { CustomPriceReadError } from "@/lib/pricing/package-price"

export const dynamic = "force-dynamic"

interface Params {
  params: Promise<{ handle: string }>
}

// Its own query: a missing column (code deployed before migration 0146) means off, not an error.
async function readSubAgentOpenJoin(): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("app_settings")
      .select("sub_agent_open_join_enabled")
      .is("key", null)
      .maybeSingle()
    if (error) return false
    return (data as { sub_agent_open_join_enabled?: boolean } | null)?.sub_agent_open_join_enabled === true
  } catch {
    return false
  }
}

// GET: public join page data. Returns only { status, shop_name, wholesale_packages }; only { status } when closed.
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { handle } = await params
    const trimmed = (handle || "").trim()
    if (!trimmed) return NextResponse.json({ status: "closed" })

    const enabled = await readSubAgentOpenJoin()
    if (!enabled) return NextResponse.json({ status: "closed" })

    const { data: shop, error } = await supabaseAdmin
      .from("user_shops")
      .select("id, shop_name, is_active, is_blocked, parent_shop_id")
      .or(shopHandleOrFilter(trimmed))
      .limit(1)
      .maybeSingle()
    if (error) {
      console.error("join page shop lookup failed:", error.code, error.message)
      return NextResponse.json({ error: "Failed to load. Please try again." }, { status: 500 })
    }

    if (!shop || targetStatus(shop, enabled) !== "open") {
      return NextResponse.json({ status: "closed" })
    }

    let wholesale_packages
    try {
      wholesale_packages = await getWholesalePackages(supabaseAdmin, shop.id)
    } catch (e) {
      if (e instanceof CustomPriceReadError) {
        return NextResponse.json({ error: "Prices are unavailable right now. Please try again." }, { status: 503 })
      }
      throw e
    }

    return NextResponse.json({ status: "open", shop_name: shop.shop_name, wholesale_packages })
  } catch (error) {
    console.error("Error loading join page:", (error as Error)?.message)
    return NextResponse.json({ error: "Failed to load. Please try again." }, { status: 500 })
  }
}
