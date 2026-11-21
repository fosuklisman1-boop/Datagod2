import { NextRequest, NextResponse } from "next/server"
import { recheckDraft } from "@/lib/ai-drafts/confirm"
import { authenticate, isUuid, limitOrNull, notFound, suspendedResponse } from "@/lib/ai-drafts/http"

// POST /api/ai/drafts/[id]/recheck: re-verify an `unknown` draft against the world. Read-only, safe to repeat.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req)
  if (!auth.ok) return auth.res
  if (auth.suspended) return suspendedResponse()
  const { id } = await params
  if (!isUuid(id)) return notFound()
  const limited = await limitOrNull(req, "ai_draft_recheck", auth.caller.userId)
  if (limited) return limited

  try {
    const state = await recheckDraft(auth.db, id, auth.caller)
    return state ? NextResponse.json(state) : notFound()
  } catch {
    console.error("ai_drafts: recheck failed")
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 })
  }
}
