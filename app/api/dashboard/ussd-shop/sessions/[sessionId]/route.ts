import { NextRequest, NextResponse } from "next/server"
import { getTranscript } from "@/lib/ussd-hubtel/interaction-log"
import { SESSION_ID_RE } from "@/lib/ussd-hubtel/interaction-routes"
import { ownerShop } from "../owner"

// GET /api/dashboard/ussd-shop/sessions/<sessionId>: transcript, only when the owner's shop code was used in it.
export async function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const owner = await ownerShop(request)
  if (!owner) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { sessionId } = await params
  if (!SESSION_ID_RE.test(sessionId)) return NextResponse.json({ error: "Invalid session id" }, { status: 400 })
  const r = await getTranscript(owner.db, sessionId, owner.shopId)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ rows: r.rows.map(row => ({ created_at: row.created_at, seq: row.seq, request_type: row.request_type, input: row.input, reply_type: row.reply_type, reply: row.reply })) })
}
