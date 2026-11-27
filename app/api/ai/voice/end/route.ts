import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { deviceHashFor, readDeviceId } from "@/lib/ai-voice/device-cookie"

export const dynamic = "force-dynamic"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const bodySchema = z.object({
  callId: z.string().uuid(),
  reason: z.string().min(1).max(64),
  conversationId: z.string().max(128).optional(),
  started: z.boolean().optional(),
})

export async function POST(req: NextRequest) {
  let raw: unknown
  try { raw = await req.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  const { callId, started } = parsed.data
  const reason = parsed.data.reason.replace(/[^A-Za-z0-9_.:-]/g, "_")

  // Caller identity: verified user id, else the device cookie hash.
  let userId: string | undefined
  const authHeader = req.headers.get("authorization")
  if (authHeader?.startsWith("Bearer ")) {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
    if (!error && user) userId = user.id
  }
  const deviceId = readDeviceId(req)
  if (!userId && !deviceId) return NextResponse.json({ error: "Not found" }, { status: 404 })

  let q = supabaseAdmin.from("ai_voice_calls").select("id, ended_at").eq("id", callId)
  q = userId ? q.eq("user_id", userId) : q.eq("device_hash", deviceHashFor(deviceId!))
  const { data: row } = await q.maybeSingle()
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if ((row as { ended_at?: string | null }).ended_at) return new NextResponse(null, { status: 204 })

  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { ended_at: now, end_reason: reason }
  if (parsed.data.conversationId) patch.conversation_id = parsed.data.conversationId
  if (started) patch.started_at = now
  // .is("ended_at", null) keeps a racing second call from overwriting the first.
  await supabaseAdmin.from("ai_voice_calls").update(patch).eq("id", callId).is("ended_at", null)
  return new NextResponse(null, { status: 204 })
}
