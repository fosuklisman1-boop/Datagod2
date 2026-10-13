import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { actOnFlag } from "@/lib/sms/admin-lists"

// POST { source: "flag" | "legacy", action: "dismiss" | "suspend" }
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await adminGuard(request, { write: true })
  if (!g.ok) return g.response
  const { id } = await params
  let body: { source?: string; action?: string }
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  const r = await actOnFlag(g.adminId!, body.source as "flag" | "legacy", id, body.action as "dismiss" | "suspend")
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
  return NextResponse.json({ success: true })
}
