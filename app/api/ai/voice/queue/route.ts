import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { applyRateLimit } from "@/lib/rate-limiter"
import { loadAIConfig } from "@/lib/ai-console/load-config"
import { resolveVoiceSettings } from "@/lib/ai-voice/settings"
import { deviceHashFor, readDeviceId } from "@/lib/ai-voice/device-cookie"
import { nuanceKeys } from "@/lib/ai-voice/keys"
import { etaSeconds, freeSlotCount, waitingPosition } from "@/lib/ai-voice/queue"
import { expireStaleTickets, readLiveTickets, setTicketStatus } from "@/lib/ai-voice/queue-db"
import { readOpenByKey } from "@/lib/ai-voice/slots"

export const dynamic = "force-dynamic"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const bodySchema = z.object({
  ticketId: z.string().uuid(),
  action: z.literal("leave").optional(),
})

const unavailable = () => NextResponse.json({ error: "Unavailable" }, { status: 503 })

/**
 * Waiting-line check-in. The page polls this every few seconds while it waits: each call proves the caller is still
 * there, and the first caller in line is admitted as soon as a call slot is free. Admitting never starts a call:
 * the page then asks the token route again with the ticket, which runs every gate and the real slot claim.
 */
export async function POST(req: NextRequest) {
  let raw: unknown
  try { raw = await req.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  const { ticketId, action } = parsed.data

  // Caller identity, exactly like the end route: verified user id, else the device cookie hash.
  let userId: string | undefined
  const authHeader = req.headers.get("authorization")
  if (authHeader?.startsWith("Bearer ")) {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
    if (!error && user) userId = user.id
  }
  const deviceId = readDeviceId(req)
  if (!userId && !deviceId) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const deviceHash = deviceId ? deviceHashFor(deviceId) : null

  const rl = await applyRateLimit(req, "ai_voice_queue", 40, 60_000, userId ?? deviceHash!, { pgFallback: true })
  if (!rl.allowed) return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 })
  // Admitting hands out a paid slot: a limiter that could not count fails closed.
  if (rl.degraded) return unavailable()

  const cfg = await loadAIConfig(supabaseAdmin)
  const voice = resolveVoiceSettings(cfg)
  if (!(await expireStaleTickets(supabaseAdmin, voice.queueMaxWaitMinutes * 60_000))) return unavailable()

  // The ticket must be this caller's own; anything else is "not found" (no probing other people's tickets).
  let q = supabaseAdmin.from("ai_voice_queue").select("id, status").eq("id", ticketId)
  q = userId ? q.eq("user_id", userId) : q.eq("device_hash", deviceHash!)
  const { data: row, error: rowErr } = await q.maybeSingle()
  if (rowErr) return unavailable()
  const ticket = row as { id?: string; status?: string } | null
  if (!ticket?.id) return NextResponse.json({ error: "Not found" }, { status: 404 })

  if (ticket.status !== "waiting" && ticket.status !== "admitted") {
    return action === "leave" ? new NextResponse(null, { status: 204 }) : NextResponse.json({ status: ticket.status })
  }
  if (action === "leave") {
    if (!(await setTicketStatus(supabaseAdmin, ticketId, "left"))) return unavailable()
    return new NextResponse(null, { status: 204 })
  }

  if (!voice.enabled || !voice.queueEnabled) {
    // The line was switched off while this caller waited.
    await setTicketStatus(supabaseAdmin, ticketId, "expired")
    return NextResponse.json({ status: "expired" })
  }

  // Proof of life first, so a slow slot read below cannot make a present caller look stale.
  const seen = await supabaseAdmin.from("ai_voice_queue").update({ last_seen_at: new Date().toISOString() }).eq("id", ticketId)
  if (seen.error) return unavailable()

  if (ticket.status === "admitted") return NextResponse.json({ status: "admitted", position: 0, etaSeconds: 0 })

  const live = await readLiveTickets(supabaseAdmin)
  if (!live) return unavailable()
  const position = waitingPosition(live, ticketId)
  if (position === 0) return NextResponse.json({ status: "expired" }) // raced with an expiry

  const keys = nuanceKeys()
  const openCutoff = new Date(Date.now() - (voice.maxCallSeconds + 60) * 1000).toISOString()
  const openByKey = await readOpenByKey(supabaseAdmin, openCutoff)
  if (!openByKey) return unavailable()
  // A slot an admitted caller is about to take is not free for anyone else.
  const held = live.filter((t) => t.status === "admitted").length
  const free = freeSlotCount(keys, voice.callsPerKey, openByKey, voice.multiAccount) - held

  if (position === 1 && free > 0) {
    // Compare-and-set: only a ticket that is still waiting can be admitted.
    const ok = await setTicketStatus(supabaseAdmin, ticketId, "admitted", "waiting", { admitted_at: new Date().toISOString() })
    if (!ok) {
      // Someone else changed it first (a parallel check-in admitted it, or it left/expired): report what it is now.
      const { data: now } = await supabaseAdmin.from("ai_voice_queue").select("status").eq("id", ticketId).maybeSingle()
      const st = (now as { status?: string } | null)?.status
      return NextResponse.json(st === "admitted" ? { status: "admitted", position: 0, etaSeconds: 0 } : { status: st ?? "expired" })
    }
    return NextResponse.json({ status: "admitted", position: 0, etaSeconds: 0 })
  }

  const totalSlots = (voice.multiAccount ? keys.length : 1) * voice.callsPerKey
  return NextResponse.json({ status: "waiting", position, etaSeconds: etaSeconds(position, totalSlots, voice.maxCallSeconds) })
}
