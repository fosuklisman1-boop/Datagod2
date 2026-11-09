import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { DELIVERY_MODE_KEY, getDeliveryMode } from "@/lib/mtn-providers/kuntanii-provider"
import { createKuntaniiClient } from "@/lib/mtn-providers/kuntanii-client"
import { fileNotReceived, refreshDispute } from "@/lib/mtn-providers/kuntanii-disputes"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MODES = ["normal", "instant"] as const

// Everything except phone_number (PII) and raised_by.
const DISPUTE_COLUMNS =
  "id, tracking_id, external_order_id, order_reference, report_reference, data_gb, reason_code, description, dispute_status, created_at, updated_at, last_checked_at"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const action = request.nextUrl.searchParams.get("action")

  try {
    if (action === "settings") {
      return NextResponse.json({ success: true, mode: await getDeliveryMode() })
    }

    if (action === "pricing") {
      const client = createKuntaniiClient()
      const fetchMode = async (mode: "normal" | "instant") => {
        try {
          const res = await client.getPricing(mode)
          return res.ok ? res.data : null
        } catch {
          return null
        }
      }
      const [normal, instant] = await Promise.all([fetchMode("normal"), fetchMode("instant")])
      return NextResponse.json({ success: true, normal, instant })
    }

    if (action === "disputes") {
      const trackingId = request.nextUrl.searchParams.get("trackingId") ?? ""
      if (!UUID_RE.test(trackingId)) {
        return NextResponse.json({ error: "Invalid trackingId" }, { status: 400 })
      }
      const { data, error } = await supabase
        .from("kuntanii_not_received_reports")
        .select(DISPUTE_COLUMNS)
        .eq("tracking_id", trackingId)
        .order("created_at", { ascending: false })
      if (error) {
        console.error("[ADMIN-KUNTANII] disputes query failed:", error.message)
        return NextResponse.json({ error: "Failed to load disputes" }, { status: 500 })
      }
      return NextResponse.json({ success: true, disputes: data ?? [] })
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (error) {
    console.error("[ADMIN-KUNTANII] GET error:", (error as Error).message)
    return NextResponse.json({ error: "Kuntanii request failed" }, { status: 502 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    let body: any
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    }
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    }

    if (body.action === "set-delivery-mode") {
      const mode = body.mode
      if (!MODES.includes(mode)) {
        return NextResponse.json({ error: "Invalid mode. Use: normal, instant" }, { status: 400 })
      }
      const { error } = await supabase
        .from("admin_settings")
        .upsert({ key: DELIVERY_MODE_KEY, value: { mode }, updated_at: new Date().toISOString() }, { onConflict: "key" })
      if (error) {
        console.error("[ADMIN-KUNTANII] Failed to save delivery mode:", error.message)
        return NextResponse.json({ error: "Failed to save setting" }, { status: 500 })
      }
      return NextResponse.json({ success: true, mode })
    }

    if (body.action === "report-not-received") {
      if (typeof body.trackingId !== "string" || !UUID_RE.test(body.trackingId)) {
        return NextResponse.json({ error: "Invalid trackingId" }, { status: 400 })
      }
      if (!userId) {
        return NextResponse.json({ error: "Could not identify the admin" }, { status: 400 })
      }
      const result = await fileNotReceived({
        trackingId: body.trackingId,
        adminUserId: userId,
        description: typeof body.description === "string" ? body.description : undefined,
        reasonCode: typeof body.reasonCode === "string" ? body.reasonCode : undefined,
      })
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error, ...(result.code ? { code: result.code } : {}) },
          { status: result.status }
        )
      }
      if (result.persisted === false) {
        return NextResponse.json({
          success: true,
          reportReference: result.reportReference,
          warning: "Report filed with Kuntanii but not saved locally — note the reference",
        })
      }
      return NextResponse.json({ success: true, reportReference: result.reportReference })
    }

    if (body.action === "refresh-dispute") {
      if (typeof body.reportId !== "string" || !UUID_RE.test(body.reportId)) {
        return NextResponse.json({ error: "Invalid reportId" }, { status: 400 })
      }
      const status = await refreshDispute(body.reportId)
      if (status === null) {
        return NextResponse.json({ error: "Could not refresh the dispute" }, { status: 502 })
      }
      return NextResponse.json({ success: true, disputeStatus: status })
    }

    return NextResponse.json({ error: `Unknown action: ${body.action}` }, { status: 400 })
  } catch (error) {
    console.error("[ADMIN-KUNTANII] POST error:", (error as Error).message)
    return NextResponse.json({ error: "Kuntanii request failed" }, { status: 502 })
  }
}
