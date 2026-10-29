import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { parseReviewUrl, REVIEW_URL_SETTING_KEY } from "@/lib/review-prompt"

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7))
    if (authError || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const { data: setting, error: settingError } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", REVIEW_URL_SETTING_KEY)
      .maybeSingle()
    if (settingError) return NextResponse.json({ show: false, url: null })

    const url = parseReviewUrl(setting?.value)
    if (!url) return NextResponse.json({ show: false, url: null })

    // Same source /dashboard/my-orders reads: combined_orders_view by shop_owner_id
    // (orders.user_id, api_orders.user_id, shop_orders owner, ussd_orders.shop_owner_id).
    const { count, error } = await supabase
      .from("combined_orders_view")
      .select("id", { count: "exact", head: true })
      .eq("shop_owner_id", user.id)
      .eq("status", "completed")
    if (error) return NextResponse.json({ show: false, url: null })

    return NextResponse.json({ show: (count ?? 0) > 0, url })
  } catch {
    console.error("[review-prompt] failed")
    return NextResponse.json({ show: false, url: null })
  }
}
