import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import {
  BLOCKED_SETTINGS_KEY,
  getBlockedNumbersSettings,
  parseBlockedSettings,
  _resetSettingsMemo,
} from "@/lib/blocked-numbers/settings"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const settings = await getBlockedNumbersSettings({ fresh: true })
    return NextResponse.json({ success: true, settings })
  } catch (error) {
    console.error("[BLOCKED-NUMBERS-SETTING] GET error:", error)
    return NextResponse.json({ error: "Failed to fetch setting" }, { status: 500 })
  }
}

const BOOLEAN_FIELDS = ["enabled", "customer_sms_enabled"] as const
const NUMBER_FIELDS = ["retention_days", "spike_threshold_per_hour", "daily_sms_ceiling"] as const

export async function POST(request: NextRequest) {
  const { isAdmin, userId: adminId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  try {
    const body = await request.json()
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Body must be an object" }, { status: 400 })
    }
    for (const f of BOOLEAN_FIELDS) {
      if (body[f] !== undefined && typeof body[f] !== "boolean") {
        return NextResponse.json({ error: `'${f}' must be a boolean` }, { status: 400 })
      }
    }
    for (const f of NUMBER_FIELDS) {
      if (body[f] !== undefined && (typeof body[f] !== "number" || !Number.isFinite(body[f]))) {
        return NextResponse.json({ error: `'${f}' must be a number` }, { status: 400 })
      }
    }

    // Omitted = keep what's stored.
    const current = await getBlockedNumbersSettings({ fresh: true })
    const merged: Record<string, unknown> = { ...current }
    for (const f of [...BOOLEAN_FIELDS, ...NUMBER_FIELDS]) {
      if (body[f] !== undefined) merged[f] = body[f]
    }
    const newValue = parseBlockedSettings(merged)

    const { error } = await supabase.from("admin_settings").upsert(
      {
        key: BLOCKED_SETTINGS_KEY,
        value: newValue,
        description: "Blocked MTN number tracking: master switch, customer 'now allowed' SMS switch, retention, spike threshold and daily SMS ceiling.",
        updated_at: new Date().toISOString(),
        updated_by: adminId,
      },
      { onConflict: "key" }
    )
    if (error) throw error

    _resetSettingsMemo()
    console.log(`[BLOCKED-NUMBERS-SETTING] set enabled=${newValue.enabled} customer_sms_enabled=${newValue.customer_sms_enabled}`)
    return NextResponse.json({ success: true, settings: newValue })
  } catch (error) {
    console.error("[BLOCKED-NUMBERS-SETTING] POST error:", error)
    return NextResponse.json({ error: "Failed to update setting" }, { status: 500 })
  }
}
