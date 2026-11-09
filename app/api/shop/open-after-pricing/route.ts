import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { openPricedShop, ShopNotFoundError } from "@/lib/sub-agents/open-shop"
import { CustomPriceReadError } from "@/lib/pricing/package-price"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST: a storefront joiner opens their shop after saving prices. Service role: the 0146 trigger blocks owners from
// changing is_active / prices_set_at themselves. The shop is always the caller's own (from the token), never the body.
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7))
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const result = await openPricedShop(supabase, user.id)
    switch (result.status) {
      case "opened":
      case "already_open":
        return NextResponse.json({ success: true, ...result })
      case "no_prices":
        return NextResponse.json(
          { success: false, status: result.status, error: "Set a price on at least one product your shop owner offers to open your shop." },
          { status: 409 }
        )
      case "blocked":
        return NextResponse.json(
          { success: false, status: result.status, error: "Your shop can't be opened right now. Please contact support." },
          { status: 403 }
        )
    }
  } catch (error) {
    if (error instanceof ShopNotFoundError) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }
    if (error instanceof CustomPriceReadError) {
      // Retryable: prices could not be read, so the shop was not opened.
      return NextResponse.json({ error: "We couldn't check your prices just now. Please try again." }, { status: 503 })
    }
    console.error("[OPEN-AFTER-PRICING] Error:", error instanceof Error ? error.message : "unknown")
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
