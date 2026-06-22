import { NextRequest, NextResponse } from "next/server"
import { deliverSecurityAlert } from "@/lib/security-alerts"

/**
 * POST /api/internal/security-alert   { alert_id }
 * Header: x-internal-secret: <SECURITY_ALERT_SECRET>
 *
 * Called in real time by the Postgres security_alerts AFTER INSERT trigger via
 * pg_net (migration 0084). Authenticated by a shared secret that lives in both
 * the DB (internal_config) and Vercel env. Fans the alert out to admins.
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-internal-secret")
  if (!secret || secret !== process.env.SECURITY_ALERT_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  const alertId = body?.alert_id
  if (!alertId || typeof alertId !== "string") {
    return NextResponse.json({ error: "alert_id required" }, { status: 400 })
  }

  try {
    const result = await deliverSecurityAlert(alertId)
    return NextResponse.json(result)
  } catch (e: any) {
    console.error("[SECURITY-ALERT] delivery error:", e?.message)
    return NextResponse.json({ ok: false, error: "delivery failed" }, { status: 500 })
  }
}
