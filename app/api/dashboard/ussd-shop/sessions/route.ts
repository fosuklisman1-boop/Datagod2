import { NextRequest, NextResponse } from "next/server"
import { listSessionSummaries, sessionOutcome } from "@/lib/ussd-hubtel/interaction-log"
import { parseListParams } from "@/lib/ussd-hubtel/interaction-routes"
import { ownerShop } from "./owner"

// GET /api/dashboard/ussd-shop/sessions?limit=30&before=<ISO>: Hubtel USSD sessions on the owner's shop code.
export async function GET(request: NextRequest) {
  const owner = await ownerShop(request)
  if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const params = parseListParams(request.nextUrl.searchParams)
  if ("error" in params) return NextResponse.json({ error: params.error }, { status: 400 })
  const r = await listSessionSummaries(owner.db, { shopId: owner.shopId, before: params.before, limit: params.limit })
  if (!r.ok) return NextResponse.json({ error: r.missing ? "Session history is not available yet" : r.error }, { status: r.missing ? 503 : 500 })
  const sessions = r.sessions.map(s => ({ ...s, outcome: sessionOutcome(s) }))
  const nextBefore = sessions.length === params.limit ? sessions[sessions.length - 1].started_at : null
  return NextResponse.json({ sessions, nextBefore })
}
