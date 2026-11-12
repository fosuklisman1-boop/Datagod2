import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { mapRowToUser, type AdminListUsersRow, type UsersExportResponse } from "@/lib/admin-users/list-params"
import { encodeExportCursor, parseExportParams, parseExportRpcResult, toExportRpcArgs } from "@/lib/admin-users/export-params"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

/**
 * GET /api/admin/users/export
 *
 * Query: the list filters (q, role, suspended, hasShop, pricingMode, from, to), cursor (opaque, from
 * the previous response), limit (1..5000, default 5000). sort/dir/page/pageSize are ignored: the
 * export order is fixed to (created_at, id) ascending so keyset paging never skips or repeats a row.
 * 200: { users, nextCursor }   400: { error, details }
 *
 * One admin_export_users call (migrations/0170) per request, so 100k users is ~20 requests.
 */
export async function GET(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  const parsed = parseExportParams(req.nextUrl.searchParams)
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid query", details: parsed.errors }, { status: 400 })
  }

  try {
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data, error } = await adminClient.rpc("admin_export_users", toExportRpcArgs(parsed.filters, parsed.cursor, parsed.limit))
    if (error) {
      console.error("[ADMIN-USERS-EXPORT] admin_export_users failed:", error.message)
      return NextResponse.json({ error: error.message || "Export failed" }, { status: 500 })
    }

    const { rows, nextCursor } = parseExportRpcResult(data)
    const body: UsersExportResponse = {
      users: (rows as AdminListUsersRow[]).map(mapRowToUser),
      nextCursor: nextCursor ? encodeExportCursor(nextCursor) : null,
    }
    return NextResponse.json(body)
  } catch (error: any) {
    console.error("[ADMIN-USERS-EXPORT] error:", error)
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 })
  }
}
