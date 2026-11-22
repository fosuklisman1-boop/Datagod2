import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { z } from "zod"
import { applyRateLimit } from "@/lib/rate-limiter"
import { flagConversation } from "@/lib/ai-console/transcripts"

export const dynamic = "force-dynamic"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const bodySchema = z.object({ conversationKey: z.string().uuid(), event: z.enum(["handoff", "error"]) })

// Widgets ping this when someone presses "Talk to a person" or sees an error bubble. Guests have no session, so there
// is no auth: the only thing it can do is add a flag to a conversation that already exists, found by an unguessable
// uuid. It never creates a conversation and never returns anything.
export async function POST(req: NextRequest) {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 })

  const rl = await applyRateLimit(req, "ai_conversation_events", 30, 60 * 1000)
  if (!rl.allowed) return NextResponse.json({ error: "Too many requests" }, { status: 429 })

  await flagConversation(supabaseAdmin, parsed.data.conversationKey, parsed.data.event)
  return new NextResponse(null, { status: 204 })
}
