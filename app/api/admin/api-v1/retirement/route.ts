import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getAdminClient } from "@/lib/api-v2/store"
import { clearV1RetirementCache } from "@/lib/api-v1/retirement"
import { findMissingUserIds, loadStragglers, parseExpectedUpdatedAt, parseRetirementUpdate } from "@/lib/api-v1/retirement-admin"

const CONFIG_COLS = "v1_sunset_at, v1_exempt_user_ids, v1_notice_sent_at, updated_at"

async function exemptUsers(supabase: ReturnType<typeof getAdminClient>, ids: string[]) {
  if (ids.length === 0) return []
  const { data, error } = await (supabase as any)
    .from("users")
    .select("id, email, phone_number, first_name")
    .in("id", ids)
  if (error) throw new Error("users lookup failed")
  return ((data ?? []) as any[]).map((u) => ({
    id: u.id,
    email: u.email ?? null,
    phone: u.phone_number ?? null,
    first_name: u.first_name ?? null,
  }))
}

/** GET /api/admin/api-v1/retirement - Admin: retirement settings plus v1 stragglers (last 7 days). */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (errorResponse) return errorResponse
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const supabase = getAdminClient()
  try {
    const { data, error } = await (supabase as any).from("api_v2_config").select(CONFIG_COLS).eq("id", true).maybeSingle()
    if (error || !data) throw new Error("config read failed")
    const exemptIds: string[] = Array.isArray(data.v1_exempt_user_ids) ? data.v1_exempt_user_ids : []
    const [exempt_users, stragglers] = await Promise.all([
      exemptUsers(supabase, exemptIds),
      loadStragglers(supabase as any, exemptIds, new Date()),
    ])
    return NextResponse.json({
      sunset_at: data.v1_sunset_at ?? null,
      exempt_users,
      notice_sent_at: data.v1_notice_sent_at ?? null,
      updated_at: data.updated_at ?? null,
      stragglers,
    })
  } catch (e) {
    console.error("[ADMIN API V1] Retirement read error:", e instanceof Error ? e.message : "unknown")
    return NextResponse.json({ error: "Failed to read retirement settings" }, { status: 500 })
  }
}

/** PUT /api/admin/api-v1/retirement - Admin: set sunset date and exempt users. */
export async function PUT(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (errorResponse) return errorResponse
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const parsed = parseRetirementUpdate(body, new Date())
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const expected = parseExpectedUpdatedAt(body)
  if (!expected.ok) return NextResponse.json({ error: expected.error }, { status: 400 })

  const supabase = getAdminClient()
  try {
    const missing = await findMissingUserIds(supabase as any, parsed.value.exempt_user_ids)
    if (missing.length > 0) return NextResponse.json({ error: "Some exempt users do not exist" }, { status: 400 })

    const { data, error } = await (supabase as any)
      .from("api_v2_config")
      .update({
        v1_sunset_at: parsed.value.sunset_at,
        v1_exempt_user_ids: parsed.value.exempt_user_ids,
        updated_at: new Date().toISOString(),
      })
      .eq("id", true)
      .eq("updated_at", expected.value)
      .select(CONFIG_COLS)
      .maybeSingle()
    if (error) throw new Error("config update failed")
    if (!data) {
      // Someone else saved since this form loaded (or the row is gone): write nothing, make the admin reload.
      return NextResponse.json(
        { error: "stale", message: "Settings changed since you loaded them. Reload and try again." },
        { status: 409 }
      )
    }
    clearV1RetirementCache()
    return NextResponse.json({
      sunset_at: data.v1_sunset_at ?? null,
      exempt_user_ids: Array.isArray(data.v1_exempt_user_ids) ? data.v1_exempt_user_ids : [],
      notice_sent_at: data.v1_notice_sent_at ?? null,
      updated_at: data.updated_at ?? null,
    })
  } catch (e) {
    console.error("[ADMIN API V1] Retirement update error:", e instanceof Error ? e.message : "unknown")
    return NextResponse.json({ error: "Failed to update retirement settings" }, { status: 500 })
  }
}
