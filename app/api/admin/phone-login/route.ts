import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getPhoneLoginSettingsStrict, setPhoneLoginSettings } from "@/lib/phone-login/settings"
import { countEvents, recordEvent } from "@/lib/phone-login/store"
import { raiseSecurityAlert } from "@/lib/security-alerts"

export const dynamic = "force-dynamic"

const DAY_MS = 86_400_000

const db = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!
  try {
    const client = db()
    const settings = await getPhoneLoginSettingsStrict(client)
    const [login_ok, challenge_sent, challenge_passed, lockout] = await Promise.all([
      countEvents(client, "login_ok", DAY_MS),
      countEvents(client, "challenge_sent", DAY_MS),
      countEvents(client, "challenge_passed", DAY_MS),
      countEvents(client, "lockout", DAY_MS),
    ])
    return NextResponse.json({ settings, last24h: { login_ok, challenge_sent, challenge_passed, lockout } })
  } catch {
    return NextResponse.json({ error: "Could not load phone login settings" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  let body: { enabled?: unknown; newDeviceCode?: unknown } | null = null
  try {
    body = await request.json()
  } catch {
    body = null
  }
  if (!body || typeof body.enabled !== "boolean" || typeof body.newDeviceCode !== "boolean") {
    return NextResponse.json({ error: "enabled and newDeviceCode must be booleans" }, { status: 400 })
  }
  const next = { enabled: body.enabled, newDeviceCode: body.newDeviceCode }

  try {
    const client = db()
    // Strict read: a failed read must never be mistaken for defaults and overwritten.
    const prev = await getPhoneLoginSettingsStrict(client)
    await setPhoneLoginSettings(client, next)

    if (prev.newDeviceCode && !next.newDeviceCode) {
      await recordEvent(client, "code_switch_off", { userId })
      await raiseSecurityAlert({
        severity: "high",
        category: "phone_login_code_off",
        title: "Phone login new-device code switched OFF",
        actor: userId ?? null,
        detail: { by: userId },
      })
    }
    return NextResponse.json({ settings: next })
  } catch {
    return NextResponse.json({ error: "Could not save phone login settings" }, { status: 500 })
  }
}
