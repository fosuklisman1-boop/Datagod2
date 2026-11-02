import { NextRequest, NextResponse } from "next/server"
import { parsePaging } from "@/lib/admin-users/drawer-params"
import { badRequest, gateAdmin, serviceClient, userIdParam, type IdCtx } from "@/lib/admin-users/route-utils"

export const dynamic = "force-dynamic"

/**
 * GET /api/admin/users/[id]/audit?page=1&pageSize=20
 *
 * admin_audit_log rows whose target is this user, newest first (idx_admin_audit_log_target), with the
 * acting admin's email looked up for just this page.
 * → { rows: [{ id, action, admin_id, admin_email, old_value, new_value, created_at }], total, page, pageSize }
 */
export async function GET(req: NextRequest, ctx: IdCtx) {
  const gate = await gateAdmin(req)
  if (!gate.ok) return gate.response
  const idp = await userIdParam(ctx)
  if (!idp.ok) return idp.response

  const paging = parsePaging(new URL(req.url).searchParams)
  if (!paging.ok) return badRequest(paging.error)
  const { page, pageSize, offset, to } = paging.value

  const db = serviceClient()
  const { data, count, error } = await db
    .from("admin_audit_log")
    .select("id, admin_id, action, old_value, new_value, created_at", { count: "exact" })
    .eq("target_user_id", idp.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, to)
  if (error) {
    console.error("[ADMIN-USER-AUDIT]", error.message)
    return NextResponse.json({ error: "Failed to load admin history" }, { status: 500 })
  }

  const rows = (data ?? []) as Array<{ id: string; admin_id: string; action: string; old_value: unknown; new_value: unknown; created_at: string }>
  const adminIds = [...new Set(rows.map((r) => r.admin_id).filter(Boolean))]
  const emails = new Map<string, string>()
  if (adminIds.length) {
    const admins = await db.from("users").select("id, email").in("id", adminIds)
    if (admins.error) console.warn("[ADMIN-USER-AUDIT] admin emails:", admins.error.message)
    for (const a of (admins.data ?? []) as Array<{ id: string; email: string | null }>) if (a.email) emails.set(a.id, a.email)
  }

  return NextResponse.json({
    rows: rows.map((r) => ({ ...r, admin_email: emails.get(r.admin_id) ?? null })),
    total: count ?? 0,
    page,
    pageSize,
  })
}
