import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { atishareService } from "@/lib/at-ishare-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * Authorized status-refresh endpoint.
 *
 * Trigger sources (any one of):
 *   - Vercel Cron with Bearer ${CRON_SECRET}
 *   - Authenticated dashboard user (admin or regular) — fire-and-forget refresh
 *
 * Anonymous callers are rejected to prevent abuse of the upstream AT-Ishare API
 * (each call iterates pending orders and hits external services).
 */
async function isAuthorized(request: NextRequest): Promise<boolean> {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return false

  const token = authHeader.slice(7)

  // 1) Cron secret bypass — for scheduled runs
  if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) return true

  // 2) Authenticated dashboard user — JWT validates against Supabase
  try {
    const { data: { user } } = await supabase.auth.getUser(token)
    return !!user
  } catch {
    return false
  }
}

export async function GET(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const result = await atishareService.checkScheduledOrders()
    return NextResponse.json({
      success: true,
      message: `Checked ${result.checked} orders, updated ${result.updated}`,
      ...result,
    })
  } catch (error) {
    console.error("[CHECK-ORDERS] Error:", error)
    return NextResponse.json(
      { error: "Failed to check orders", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
