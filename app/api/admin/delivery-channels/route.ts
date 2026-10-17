import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { freeze } from "@/lib/delivery-estimate/compute"
import { computeLiveEstimate, DELIVERY_CHANNELS, isDeliveryChannel, loadOverrides, OVERRIDES_TABLE } from "@/lib/delivery-estimate/query"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export const dynamic = "force-dynamic"

/** Every channel with its manual override state. */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const overrides = await loadOverrides(supabase)
  return NextResponse.json({
    channels: DELIVERY_CHANNELS.map(({ key, label }) => {
      const o = overrides.get(key)
      return { channel: key, label, isManuallyDown: !!o?.isManuallyDown, reason: o?.reason ?? null, since: o?.since ?? null }
    }),
  })
}

/**
 * Mark a channel down ({ channel, down: true, reason? }) or back up ({ channel, down: false }).
 * Marking down snapshots the live numbers so the dashboard shows them frozen instead of recomputing.
 */
export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  const body = await request.json().catch(() => null)
  if (!isDeliveryChannel(body?.channel)) return NextResponse.json({ error: "Invalid channel" }, { status: 400 })
  if (typeof body?.down !== "boolean") return NextResponse.json({ error: "down must be true or false" }, { status: 400 })
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 200) : null

  try {
    const now = new Date().toISOString()
    const row = body.down
      ? { channel: body.channel, is_manually_down: true, reason, since: now, frozen: freeze(await computeLiveEstimate(supabase, body.channel, now)), updated_by: userId ?? null, updated_at: now }
      : { channel: body.channel, is_manually_down: false, reason: null, since: null, frozen: null, updated_by: userId ?? null, updated_at: now }
    const { error } = await supabase.from(OVERRIDES_TABLE).upsert(row, { onConflict: "channel" })
    if (error) {
      console.error("[DELIVERY-CHANNELS] Save failed:", error.message)
      return NextResponse.json({ error: "Could not save. Has migration 0125_delivery_channel_overrides.sql been applied?" }, { status: 500 })
    }
    return NextResponse.json({ ok: true, channel: body.channel, isManuallyDown: body.down, reason: row.reason, since: row.since })
  } catch (e) {
    console.error("[DELIVERY-CHANNELS] Error:", e)
    return NextResponse.json({ error: "Could not update the channel" }, { status: 500 })
  }
}
