import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { allocateCredits } from "@/lib/sms/admin-actions"

// POST { accountId, units } — admin credit allocation (solvency-gated; may land as pending). Requires a real admin user; audited.
export async function POST(request: NextRequest) {
  const g = await adminGuard(request, { write: true })
  if (!g.ok) return g.response
  let body: { accountId?: string; units?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  const r = await allocateCredits(g.adminId!, String(body.accountId ?? ""), Number(body.units))
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
  return NextResponse.json({ success: true, pending: r.pending, unitsCredited: r.unitsCredited })
}
