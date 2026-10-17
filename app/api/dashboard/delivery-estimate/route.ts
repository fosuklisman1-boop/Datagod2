import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { channelsForClient, getDeliveryEstimates } from "@/lib/delivery-estimate/query"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// Live: the dashboard polls this every ~25s and expects real-time numbers, never a cached response.
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Missing or invalid authorization header" }, { status: 401 })
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.slice(7))
    if (authError || !user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const now = new Date().toISOString()
    const channels = channelsForClient(await getDeliveryEstimates(supabase, now), request.nextUrl.searchParams.get("v"))
    // serverNow lets the browser tick open orders against the server's clock, not its own (skewed) one.
    return NextResponse.json({ success: true, serverNow: now, channels })
  } catch (error) {
    console.error("[DELIVERY-ESTIMATE] Error:", error)
    return NextResponse.json({ success: false, error: "Could not load delivery estimates", channels: [] }, { status: 500 })
  }
}
