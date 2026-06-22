import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"

/**
 * GET  /api/admin/security-alerts?severity=&unacked=1&limit=
 *   → recent security_alerts (admin only)
 * POST /api/admin/security-alerts  { action: "acknowledge", id }
 *   → mark an alert acknowledged (writes are service-role only)
 */
function svc() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  const url = new URL(request.url)
  const severity = url.searchParams.get("severity")
  const unacked = url.searchParams.get("unacked")
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 300)

  const supabase = svc()
  let q = supabase.from("security_alerts").select("*").order("created_at", { ascending: false }).limit(limit)
  if (severity && ["critical", "high", "info"].includes(severity)) q = q.eq("severity", severity)
  if (unacked === "1") q = q.is("acknowledged_at", null)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { count: unackedCount } = await supabase
    .from("security_alerts")
    .select("id", { count: "exact", head: true })
    .is("acknowledged_at", null)

  return NextResponse.json({ alerts: data || [], unackedCount: unackedCount ?? 0 })
}

export async function POST(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }

  const supabase = svc()

  if (body?.action === "acknowledge") {
    const id = body?.id
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })
    const { error } = await supabase
      .from("security_alerts")
      .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: auth.userId || null })
      .eq("id", id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (body?.action === "acknowledge_all") {
    const { error } = await supabase
      .from("security_alerts")
      .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: auth.userId || null })
      .is("acknowledged_at", null)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 })
}
