import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { drainPendingAlerts } from "@/lib/security-alerts"

/**
 * Fallback delivery for DB-level security alerts. Real-time delivery happens via
 * the security_alerts pg_net trigger -> /api/internal/security-alert. This cron
 * (every minute, vercel.json) catches any alert whose notified_at is still NULL
 * a minute later — e.g. if pg_net was unavailable or the request failed. Auth via
 * CRON_SECRET / x-vercel-cron (verifyCronAuth).
 */
export async function GET(request: NextRequest) {
  const auth = verifyCronAuth(request)
  if (!auth.authorized) return auth.errorResponse!

  try {
    const result = await drainPendingAlerts(60)
    return NextResponse.json({ success: true, ...result })
  } catch (error: any) {
    console.error("[CRON-SECURITY-ALERTS] Error:", error)
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 })
  }
}
