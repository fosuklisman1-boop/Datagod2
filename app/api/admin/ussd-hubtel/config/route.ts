import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getHubtelUssdConfig, setHubtelUssdConfig, hubtelEnvReady } from "@/lib/ussd-hubtel/config"

const adminClient = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!
  try {
    const config = await getHubtelUssdConfig(adminClient())
    const { missing } = hubtelEnvReady()
    return NextResponse.json({
      config,
      env: {
        webhookSecret: !missing.includes("HUBTEL_WEBHOOK_SECRET"),
        relayUrl: !missing.includes("HUBTEL_RELAY_URL"),
        relaySecret: !missing.includes("HUBTEL_RELAY_SECRET"),
      },
    })
  } catch (e) {
    console.error("[HUBTEL-ADMIN] config GET error:", e)
    return NextResponse.json({ error: "Failed to load Hubtel USSD config" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (body?.mode !== undefined && body.mode !== "main" && body.mode !== "shop") {
    return NextResponse.json({ error: "mode must be 'main' or 'shop'" }, { status: 400 })
  }
  if (body?.enabled !== undefined && typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 })
  }
  if (body.enabled === true && !hubtelEnvReady().ready) {
    return NextResponse.json(
      { error: "Cannot enable: HUBTEL_WEBHOOK_SECRET, HUBTEL_RELAY_URL and HUBTEL_RELAY_SECRET must all be set" },
      { status: 400 }
    )
  }
  const vis = body?.visibility
  if (vis !== undefined) {
    const valid = ["data", "afa", "airtime", "resultsChecker"]
    if (typeof vis !== "object" || vis === null || Object.entries(vis).some(([k, v]) => !valid.includes(k) || typeof v !== "boolean")) {
      return NextResponse.json({ error: "invalid visibility" }, { status: 400 })
    }
  }

  const client = adminClient()
  try {
    const before = await getHubtelUssdConfig(client)
    const config = await setHubtelUssdConfig(client, { enabled: body.enabled, mode: body.mode, visibility: body.visibility })
    client.from("admin_audit_log").insert([{
      admin_id: userId, action: "hubtel_ussd_config_update", target_user_id: null,
      old_value: before, new_value: config, created_at: new Date().toISOString(),
    }]).then(({ error }: { error: any }) => { if (error) console.warn("[ADMIN-AUDIT] hubtel config log failed:", error.message) })
    return NextResponse.json({ config })
  } catch (e) {
    console.error("[HUBTEL-ADMIN] config POST error:", e)
    return NextResponse.json({ error: "Failed to update Hubtel USSD config" }, { status: 500 })
  }
}
