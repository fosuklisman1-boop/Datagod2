import { NextRequest, NextResponse } from "next/server"
import { confirmDraft } from "@/lib/ai-drafts/confirm"
import { authenticate, isUuid, limitOrNull, notFound, suspendedResponse } from "@/lib/ai-drafts/http"

// POST /api/ai/drafts/[id]/confirm: claim and run the caller's own pending draft. All logic lives in lib/ai-drafts.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req)
  if (!auth.ok) return auth.res
  if (auth.suspended) return suspendedResponse()
  const { id } = await params
  if (!isUuid(id)) return notFound()
  const limited = await limitOrNull(req, "ai_draft_confirm", auth.caller.userId)
  if (limited) return limited

  try {
    const state = await confirmDraft(auth.db, id, auth.caller)
    return state ? NextResponse.json(state) : notFound()
  } catch {
    console.error("ai_drafts: confirm failed")
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 })
  }
}
