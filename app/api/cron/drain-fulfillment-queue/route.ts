import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { drainFulfillmentQueue } from "@/lib/fulfillment-queue-drain"

export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const auth = verifyCronAuth(request)
  if (!auth.authorized) return auth.errorResponse!

  try {
    const result = await drainFulfillmentQueue(supabase)
    return NextResponse.json({ success: true, ...result })
  } catch (error: any) {
    console.error("[CRON-DRAIN-FULFILLMENT] Error:", error)
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 })
  }
}
