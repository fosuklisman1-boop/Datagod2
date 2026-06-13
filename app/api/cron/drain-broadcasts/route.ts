import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { drainBroadcasts } from "@/lib/broadcast-drain"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Drains the broadcast_recipients queue for any broadcast still 'processing'.
// This is what makes a broadcast survive the admin closing their tab: the send
// loop no longer lives in the browser. Runs every minute (vercel.json). Auth via
// CRON_SECRET / x-vercel-cron (see verifyCronAuth).
export async function GET(request: NextRequest) {
  const auth = verifyCronAuth(request)
  if (!auth.authorized) return auth.errorResponse!

  try {
    const result = await drainBroadcasts(supabase)
    return NextResponse.json({ success: true, ...result })
  } catch (error: any) {
    console.error("[CRON-DRAIN-BROADCASTS] Error:", error)
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 })
  }
}
