import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getBlockedNumbersSettings } from "@/lib/blocked-numbers/settings"
import { DEALER_SURFACES } from "@/lib/blocked-numbers/types"
import { authUserId, ownedShopIds } from "@/lib/blocked-numbers/user-auth"
import { loadScopedRows, USER_PAGE_SIZE, type Section } from "@/lib/blocked-numbers/user-view"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const userId = await authUserId(request)
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  try {
    const sp = new URL(request.url).searchParams
    const section: Section = sp.get("section") === "orders" ? "orders" : "shops"
    const page = Math.max(1, Math.floor(Number(sp.get("page"))) || 1)

    const shopIds = await ownedShopIds(userId)
    const rows = await loadScopedRows(
      supabaseAdmin,
      userId,
      section,
      { status: sp.get("status"), from: sp.get("from"), to: sp.get("to") },
      shopIds
    )

    const { data: anyOrder } = await supabaseAdmin
      .from("mtn_blocked_attempts")
      .select("id")
      .eq("user_id", userId)
      .in("surface", [...DEALER_SURFACES])
      .limit(1)
    const settings = await getBlockedNumbersSettings()

    const start = (page - 1) * USER_PAGE_SIZE
    return NextResponse.json({
      rows: rows.slice(start, start + USER_PAGE_SIZE),
      total: rows.length,
      page,
      hasShops: shopIds.length > 0,
      hasOrders: (anyOrder?.length ?? 0) > 0,
      enabled: settings.enabled,
    })
  } catch {
    return NextResponse.json({ error: "Failed to load blocked numbers" }, { status: 500 })
  }
}
