import { NextRequest, NextResponse } from "next/server"
import { cancelDraft, expireIfDue, getOwnDraft, recoverStaleExecuting } from "@/lib/ai-drafts/repo"
import { authenticate, isUuid, notFound, storedState } from "@/lib/ai-drafts/http"

// POST /api/ai/drafts/[id]/cancel: cancels a pending draft. Anything else owned by the caller reads back as its
// current state (200); not owned or unknown is 404.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req)
  if (!auth.ok) return auth.res
  const { id } = await params
  if (!isUuid(id)) return notFound()
  const { userId } = auth.caller

  try {
    const cancelled = await cancelDraft(auth.db, id, userId)
    if (cancelled) return NextResponse.json(storedState(cancelled))
    const loaded = await getOwnDraft(auth.db, id, userId)
    if (!loaded) return notFound()
    const draft = await expireIfDue(auth.db, await recoverStaleExecuting(auth.db, loaded))
    return NextResponse.json(storedState(draft))
  } catch {
    console.error("ai_drafts: cancel failed")
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 })
  }
}
