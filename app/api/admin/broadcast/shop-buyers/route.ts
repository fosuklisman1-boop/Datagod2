import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin } from "@/lib/supabase"
import { countOptOuts, loadShopBuyerCounts, parseSinceDays } from "@/lib/sms/shop-buyers"

// GET /api/admin/broadcast/shop-buyers?since=all|30|90|180
// Per-shop counts for the "Shop buyers" broadcast audience: each buyer is counted once,
// under the shop of their latest paid data order (migration 0145).
export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const since = parseSinceDays(request.nextUrl.searchParams.get("since"))
  if (since === "invalid") {
    return NextResponse.json({ success: false, error: "since must be all, 30, 90 or 180" }, { status: 400 })
  }
  try {
    const [counts, optedOut] = await Promise.all([loadShopBuyerCounts(supabaseAdmin, since), countOptOuts(supabaseAdmin)])
    return NextResponse.json({ success: true, data: { ...counts, optedOut } })
  } catch (e) {
    const code = (e as { code?: string } | null)?.code
    console.error("[SHOP-BUYERS] counts failed:", code ?? (e instanceof Error ? e.name : "UnknownError"))
    const missing = code === "PGRST202" || code === "42883" || code === "42P01"
    return NextResponse.json(
      { success: false, error: missing ? "Shop buyers isn't set up yet: run migration 0145 in Supabase." : "Failed to load shop buyers" },
      { status: missing ? 503 : 500 },
    )
  }
}
