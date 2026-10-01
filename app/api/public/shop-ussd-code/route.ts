import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { shopHandleOrFilter } from "@/lib/shop-handle"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// Public read of a single shop's own USSD PIN -- deliberately minimal (never
// exposes the ussd_shop_codes row wholesale; that table has no anon RLS
// policy at all, see migrations/ussd_shop_codes.sql). Only returns the code
// when it's genuinely usable right now, so the storefront card never
// advertises a code that would fail on entry.
export async function GET(request: NextRequest) {
  try {
    const shopSlug = request.nextUrl.searchParams.get("shopSlug")
    if (!shopSlug) {
      return NextResponse.json({ error: "shopSlug is required" }, { status: 400 })
    }

    const { data: shop } = await supabase
      .from("user_shops")
      .select("id")
      .or(shopHandleOrFilter(shopSlug))
      .single()
    if (!shop) {
      return NextResponse.json({ active: false, code: null })
    }

    const { data: shopCode } = await supabase
      .from("ussd_shop_codes")
      .select("code, status, token_balance")
      .eq("shop_id", shop.id)
      .maybeSingle()

    const active = !!shopCode && shopCode.status === "active" && shopCode.token_balance > 0
    return NextResponse.json(
      { active, code: active ? shopCode!.code : null },
      { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } }
    )
  } catch (error) {
    console.error("[PUBLIC-SHOP-USSD-CODE] Error:", error)
    return NextResponse.json({ active: false, code: null }, { status: 200 })
  }
}
