import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { CALLBACK_LOG_TABLE, isCallbackLogTableMissing } from "@/lib/ussd-hubtel/callback-log"
import { safeDbError } from "@/lib/ussd-hubtel/log-safe"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET /api/admin/ussd-hubtel/callback-logs/<uuid>: the full row (payload, raw body, response, error).
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  // A rate-limited admin comes back with isAdmin true AND a 429 errorResponse: honour it.
  if (!isAdmin || errorResponse) return errorResponse ?? NextResponse.json({ error: "Admin access required" }, { status: 403 })

  const { id } = await context.params
  if (!UUID_RE.test(id ?? "")) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { data, error } = await supabase.from(CALLBACK_LOG_TABLE).select("*").eq("id", id).maybeSingle()
    if (error) {
      if (isCallbackLogTableMissing(error)) return NextResponse.json({ error: "Not found", tableMissing: true }, { status: 404 })
      console.error("[HUBTEL-ADMIN] callback-log detail error:", safeDbError(error))
      return NextResponse.json({ error: "Failed to load callback log" }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json({ log: data })
  } catch (e) {
    console.error("[HUBTEL-ADMIN] callback-log detail error:", safeDbError(e))
    return NextResponse.json({ error: "Failed to load callback log" }, { status: 500 })
  }
}
