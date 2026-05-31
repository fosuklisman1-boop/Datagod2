import { NextRequest, NextResponse } from "next/server"
import { generateShopToken } from "@/lib/shop-token"
import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"
import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  // Rate limit token generation — prevents pre-fetching a stockpile of tokens
  const rateLimit = await applyRateLimit(request, "shop_order_token", RATE_LIMITS.SHOP_ORDER_TOKEN.maxRequests, RATE_LIMITS.SHOP_ORDER_TOKEN.windowMs)
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 })
  }

  const shopId = request.nextUrl.searchParams.get("shopId")
  if (!shopId) return NextResponse.json({ error: "shopId required" }, { status: 400 })

  // Verify shop exists and is active
  const { data: shop } = await supabase
    .from("user_shops")
    .select("id, is_active, is_blocked")
    .eq("id", shopId)
    .single()

  if (!shop || !shop.is_active || shop.is_blocked) {
    return NextResponse.json({ error: "Shop not available" }, { status: 404 })
  }

  const token = generateShopToken(shopId)
  return NextResponse.json({ token }, {
    headers: { "Cache-Control": "no-store" }
  })
}
