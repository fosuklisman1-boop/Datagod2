import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getTranscript } from "@/lib/ussd-hubtel/interaction-log"
import { SESSION_ID_RE } from "@/lib/ussd-hubtel/interaction-routes"

// GET /api/admin/ussd-hubtel/sessions/<sessionId>: the full transcript, oldest first.
export async function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin || errorResponse) return errorResponse ?? NextResponse.json({ error: "Admin access required" }, { status: 403 })
  const { sessionId } = await params
  if (!SESSION_ID_RE.test(sessionId)) return NextResponse.json({ error: "Invalid session id" }, { status: 400 })
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const r = await getTranscript(supabase, sessionId, null)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ rows: r.rows })
}
