import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import { shapeKeyActivity } from "@/lib/api-v2/admin-stats"

const DAY_MS = 24 * 60 * 60 * 1000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** GET /api/admin/api-v2/keys/[id]/activity - Admin: 24h activity for one key. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const { id } = await params
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid key id" }, { status: 400 })

  const supabase = getAdminClient() as unknown as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: { message?: string; code?: string } | null }>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any
  }

  const { data: key, error: keyError } = await supabase.from("api_v2_keys").select("id").eq("id", id).maybeSingle()
  if (keyError) {
    console.error("[ADMIN API V2] Activity key lookup error:", keyError.code, keyError.message)
    return NextResponse.json({ error: "Failed to load API key" }, { status: 500 })
  }
  if (!key) return NextResponse.json({ error: "API key not found" }, { status: 404 })

  const since = new Date(Date.now() - DAY_MS).toISOString()
  const { data: raw, error } = await supabase.rpc("api_v2_key_activity", { p_key: id, p_since: since })
  if (error) {
    console.error("[ADMIN API V2] Activity error:", error.code, error.message)
    return NextResponse.json({ error: "Failed to load activity" }, { status: 500 })
  }

  return NextResponse.json({ activity: shapeKeyActivity(raw) })
}
