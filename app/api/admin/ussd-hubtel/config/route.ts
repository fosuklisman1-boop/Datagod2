import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import {
  DEFAULT_BRAND, getHubtelUssdConfig, hubtelEnvReady, setHubtelUssdConfig, validateBrandName, validateWelcome,
} from "@/lib/ussd-hubtel/config"

const adminClient = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

/** Redis configured (the shop-token billing guard and the session store need it). */
const redisConfigured = () => !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN
/** Same rule as lib/ussd-hubtel/billing-guard.ts: production/Vercel never uses the in-process guard. */
const isProductionLike = () => process.env.NODE_ENV === "production" || !!process.env.VERCEL

const FORBIDDEN = () => NextResponse.json({ error: "Admin access required" }, { status: 403 })

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  // A rate-limited admin comes back with isAdmin true AND a 429 errorResponse: honour it.
  if (!isAdmin || errorResponse) return errorResponse ?? FORBIDDEN()
  try {
    const config = await getHubtelUssdConfig(adminClient())
    const { missing } = hubtelEnvReady()
    return NextResponse.json({
      config,
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
  // Without Redis in production the shop billing guard refuses every shop code: do not let the
  // Hubtel code be switched into a mode that can only answer "Shop unavailable".
  if (body.mode === "shop" && isProductionLike() && !redisConfigured()) {
    return NextResponse.json(
      { error: "Cannot switch to shop mode: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set in production" },
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
    const before = await getHubtelUssdConfig(client)
    const config = await setHubtelUssdConfig(client, { enabled: body.enabled, mode: body.mode, visibility: body.visibility, brandName, welcome })
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
