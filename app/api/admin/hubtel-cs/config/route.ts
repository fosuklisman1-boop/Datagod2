import { NextRequest, NextResponse } from "next/server"
import { auditLog, errorJson, needsEnvGate, requireAdmin } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsConfig, hubtelCsEnvReady, setHubtelCsConfig, validateConfigPatch } from "@/lib/hubtel-cs/config"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"
import { HUBTEL_CS_SERVICES, HUBTEL_CS_SERVICE_KEYS } from "@/lib/hubtel-cs/services"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  try {
    const { db } = getHubtelCsRuntime()
    const config = await getHubtelCsConfig(db)
    return NextResponse.json({
      config,
      // Names of missing env vars only, never values.
      env: hubtelCsEnvReady(config.mode),
      services: HUBTEL_CS_SERVICE_KEYS.map(k => ({ key: k, label: HUBTEL_CS_SERVICES[k].label, kind: HUBTEL_CS_SERVICES[k].kind })),
    })
  } catch (e) {
    return errorJson(e)
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  if (!auth.userId) return NextResponse.json({ error: "A signed-in admin is required to change configuration" }, { status: 403 })
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  const v = validateConfigPatch(body)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  try {
    const { db } = getHubtelCsRuntime()
    const before = await getHubtelCsConfig(db)
    const nextMode = v.patch.mode ?? before.mode
    if (needsEnvGate(v.patch.enabled, before.enabled)) {
      const env = hubtelCsEnvReady(nextMode)
      if (!env.ready) return NextResponse.json({ error: `Cannot enable: missing ${env.missing.join(", ")}` }, { status: 400 })
    }
    const config = await setHubtelCsConfig(db, v.patch)
    auditLog(db, { adminId: auth.userId, action: "hubtel_cs_config_update", oldValue: before, newValue: config })
    return NextResponse.json({ config })
  } catch (e) {
    return errorJson(e)
  }
}
