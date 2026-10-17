import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { channelsForClient, getPublicDeliveryEstimates } from "@/lib/delivery-estimate/query"

// Public live delivery estimate for the landing page and storefronts. No login: the response holds only
// durations, timestamps and labels (no customer data), and one computation is shared by every visitor
// for 15s (plus the CDN header below), so anonymous traffic can't hammer the order tables.
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const channels = channelsForClient(await getPublicDeliveryEstimates(supabaseAdmin), request.nextUrl.searchParams.get("v"))
    return NextResponse.json(
      { success: true, serverNow: new Date().toISOString(), channels },
      { headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=30" } },
    )
  } catch (error) {
    console.error("[DELIVERY-ESTIMATE] public error:", error)
    return NextResponse.json({ success: false, channels: [] }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
}
