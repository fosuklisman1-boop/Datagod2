import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { applyRateLimit } from "@/lib/rate-limiter"
import { deviceHashFor, readDeviceId } from "@/lib/ai-voice/device-cookie"
import { isClientEndReason } from "@/lib/ai-voice/end-reasons"

export const dynamic = "force-dynamic"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const bodySchema = z.object({
  callId: z.string().uuid(),
  reason: z.string().min(1).max(64),
  conversationId: z.string().max(128).optional(),
  started: z.boolean().optional(),
  startedAt: z.string().max(40).optional(),
})

export async function POST(req: NextRequest) {
  let raw: unknown
  try { raw = await req.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  const { callId, started, reason } = parsed.data
  // Only reasons a client really sends. Server-set reasons (cap_exceeded, count_failed, mint_*) must never be
  // writable here: the daily-cap counts exclude cap_exceeded rows.
  if (!isClientEndReason(reason)) return NextResponse.json({ error: "Invalid reason" }, { status: 400 })

  // Caller identity: verified user id, else the device cookie hash.
  let userId: string | undefined
  const authHeader = req.headers.get("authorization")
  if (authHeader?.startsWith("Bearer ")) {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
    if (!error && user) userId = user.id
  }
  const deviceId = readDeviceId(req)
  if (!userId && !deviceId) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const deviceHash = deviceId ? deviceHashFor(deviceId) : null

  const rl = await applyRateLimit(req, "ai_voice_end", 30, 60_000, userId ?? deviceHash!, { pgFallback: true })
  if (!rl.allowed) return NextResponse.json({ error: "Too many requests. Please wait a moment." }, { status: 429 })

  let q = supabaseAdmin.from("ai_voice_calls").select("id, ended_at, created_at").eq("id", callId)
  q = userId ? q.eq("user_id", userId) : q.eq("device_hash", deviceHash!)
  const { data: row } = await q.maybeSingle()
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const r = row as { ended_at?: string | null; created_at?: string | null }
  if (r.ended_at) return new NextResponse(null, { status: 204 })

  const nowMs = Date.now()
  const now = new Date(nowMs).toISOString()
  const patch: Record<string, unknown> = { ended_at: now, end_reason: reason }
  if (parsed.data.conversationId) patch.conversation_id = parsed.data.conversationId
  if (started) {
    // The client's presented time, clamped to [created_at, now]; without a usable value, now.
    let startedMs = Date.parse(parsed.data.startedAt ?? "")
    if (!Number.isFinite(startedMs)) startedMs = nowMs
    const createdMs = Date.parse(r.created_at ?? "")
    if (Number.isFinite(createdMs)) startedMs = Math.max(startedMs, createdMs)
    patch.started_at = new Date(Math.min(startedMs, nowMs)).toISOString()
  }
  // .is("ended_at", null) keeps a racing second call from overwriting the first.
  await supabaseAdmin.from("ai_voice_calls").update(patch).eq("id", callId).is("ended_at", null)
  return new NextResponse(null, { status: 204 })
}
