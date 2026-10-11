import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { getAdminSettings, saveSection } from "@/lib/sms/admin-settings"

export async function GET(request: NextRequest) {
  const g = await adminGuard(request)
  if (!g.ok) return g.response
  try {
    return NextResponse.json({ success: true, data: await getAdminSettings() })
  } catch (e) {
    console.error("[SMS-ADMIN] settings load failed:", e)
    return NextResponse.json({ success: false, error: "Could not load settings" }, { status: 500 })
  }
}

// PATCH { section: string, values: object } — one section per call.
export async function PATCH(request: NextRequest) {
  const g = await adminGuard(request, { write: true })
  if (!g.ok) return g.response
  let body: { section?: string; values?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }
  const r = await saveSection(g.adminId!, String(body.section ?? ""), body.values)
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
  return NextResponse.json({ success: true, data: await getAdminSettings() })
}
