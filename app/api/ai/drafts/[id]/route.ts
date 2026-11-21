import { NextRequest, NextResponse } from "next/server"
import { expireIfDue, getOwnDraft, recoverStaleExecuting } from "@/lib/ai-drafts/repo"
import { authenticate, isUuid, notFound, storedState } from "@/lib/ai-drafts/http"

// GET /api/ai/drafts/[id]: the stored state of the caller's own draft (after stale-recovery and expiry).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req)
  if (!auth.ok) return auth.res
  const { id } = await params
  if (!isUuid(id)) return notFound()

  try {
    const loaded = await getOwnDraft(auth.db, id, auth.caller.userId)
    if (!loaded) return notFound()
    const recovered = await recoverStaleExecuting(auth.db, loaded)
    const draft = await expireIfDue(auth.db, recovered)
    return NextResponse.json(storedState(draft))
  } catch {
    console.error("ai_drafts: get failed")
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 })
  }
}
