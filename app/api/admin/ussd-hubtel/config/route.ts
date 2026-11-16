import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { isRedisRestConfigured } from "@/lib/redis-env"
import {
  DEFAULT_BRAND, getHubtelMainLineConfig, getHubtelUssdConfig, hubtelEnvReady, setHubtelMainLineConfig,
  setHubtelUssdConfig, validateBrandName, validateWelcome, VISIBILITY_KEYS,
} from "@/lib/ussd-hubtel/config"

const adminClient = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

/** Redis configured (the USSD session store; shop billing is guarded in Postgres, migration 0111). */
const redisConfigured = () => isRedisRestConfigured()

const FORBIDDEN = () => NextResponse.json({ error: "Admin access required" }, { status: 403 })

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  // A rate-limited admin comes back with isAdmin true AND a 429 errorResponse: honour it.
  if (!isAdmin || errorResponse) return errorResponse ?? FORBIDDEN()
  try {
    const client = adminClient()
    // `config` stays the existing URL's settings: /admin/utility-bills reads it too.
    const [config, mainLine] = await Promise.all([getHubtelUssdConfig(client), getHubtelMainLineConfig(client)])
    const { missing } = hubtelEnvReady()
    return NextResponse.json({
      config,
      mainLine,
      env: {
        webhookSecret: !missing.includes("HUBTEL_WEBHOOK_SECRET"),
        relayUrl: !missing.includes("HUBTEL_RELAY_URL"),
        relaySecret: !missing.includes("HUBTEL_RELAY_SECRET"),
        redis: redisConfigured(),
      },
    })
  } catch (e) {
    console.error("[HUBTEL-ADMIN] config GET error:", e)
    return NextResponse.json({ error: "Failed to load Hubtel USSD config" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin || errorResponse) return errorResponse ?? FORBIDDEN()
  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (body.line !== undefined && body.line !== "main") {
    return NextResponse.json({ error: "line must be 'main' when given" }, { status: 400 })
  }
  const isMainLine = body.line === "main"
  if (isMainLine && body.mode !== undefined) {
    return NextResponse.json({ error: "The main code has no mode" }, { status: 400 })
  }
  if (body.walletPayment !== undefined) {
    if (!isMainLine) return NextResponse.json({ error: "walletPayment is a main code setting: send line 'main'" }, { status: 400 })
    if (typeof body.walletPayment !== "boolean") return NextResponse.json({ error: "walletPayment must be a boolean" }, { status: 400 })
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
    const valid: string[] = VISIBILITY_KEYS
    if (typeof vis !== "object" || vis === null || Object.entries(vis).some(([k, v]) => !valid.includes(k) || typeof v !== "boolean")) {
      return NextResponse.json({ error: "invalid visibility" }, { status: 400 })
    }
  }
  // Optional brand name and welcome line. BOTH are validated before any DB access, so an invalid
  // one never leaves the other half-written. Empty/whitespace resets: brand -> default, welcome ->
  // custom override cleared (back to "Welcome to <brand>").
  const isBlank = (v: unknown) => typeof v === "string" && v.trim() === ""
  let brandName: string | undefined
  if (body.brandName !== undefined) {
    if (isBlank(body.brandName)) {
      brandName = DEFAULT_BRAND
    } else {
      const v = validateBrandName(body.brandName)
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
      brandName = v.value
    }
  }
  let welcome: string | null | undefined
  if (body.welcome !== undefined) {
    if (isBlank(body.welcome)) {
      welcome = null
    } else {
      const v = validateWelcome(body.welcome)
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
      welcome = v.value
    }
  }

  const client = adminClient()
  try {
    const shared = { enabled: body.enabled, visibility: body.visibility, brandName, welcome }
    const before = isMainLine ? await getHubtelMainLineConfig(client) : await getHubtelUssdConfig(client)
    const config = isMainLine
      ? await setHubtelMainLineConfig(client, { ...shared, walletPayment: body.walletPayment })
      : await setHubtelUssdConfig(client, { ...shared, mode: body.mode })
    client.from("admin_audit_log").insert([{
      admin_id: userId, action: isMainLine ? "hubtel_ussd_main_line_config_update" : "hubtel_ussd_config_update", target_user_id: null,
      old_value: before, new_value: config, created_at: new Date().toISOString(),
    }]).then(({ error }: { error: any }) => { if (error) console.warn("[ADMIN-AUDIT] hubtel config log failed:", error.message) })
    return NextResponse.json(isMainLine ? { mainLine: config } : { config })
  } catch (e) {
    console.error("[HUBTEL-ADMIN] config POST error:", e)
    return NextResponse.json({ error: "Failed to update Hubtel USSD config" }, { status: 500 })
  }
}
