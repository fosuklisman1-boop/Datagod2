import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import {
  mapRowToUser,
  parseRpcResult,
  parseUsersListParams,
  toRpcArgs,
  type UsersListResponse,
} from "@/lib/admin-users/list-params"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

/**
 * GET /api/admin/users
 *
 * Query: q, role, suspended, hasShop, pricingMode, from, to (YYYY-MM-DD, inclusive),
 *        sort (created_at|balance|email|shop_balance|last_sign_in_at), dir (asc|desc),
 *        page (1-based), pageSize (1..200, default 50).
 * 200: { users, total, page, pageSize }   400: { error, details }
 *
 * One call to public.admin_list_users (migrations/0145) does the filtering,
 * sorting, paging and joins in the database. Callers that need every match page
 * through this endpoint (the users page export does, 200 at a time).
 */
export async function GET(req: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(req)
  if (!isAdmin) return errorResponse

  const parsed = parseUsersListParams(req.nextUrl.searchParams)
  if (!parsed.ok) {
    return NextResponse.json({ error: "Invalid query", details: parsed.errors }, { status: 400 })
  }
  const params = parsed.params

  try {
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    const { data, error } = await adminClient.rpc("admin_list_users", toRpcArgs(params))
    if (error) {
      console.error("[ADMIN-USERS] admin_list_users failed:", error.message)
      return NextResponse.json({ error: error.message || "Failed to load users" }, { status: 500 })
    }

    const { total, rows } = parseRpcResult(data)
    const body: UsersListResponse = {
      users: rows.map(mapRowToUser),
      total,
      page: params.page,
      pageSize: params.pageSize,
    }
    return NextResponse.json(body)
  } catch (error: any) {
    console.error("API error:", error)
    return NextResponse.json({ error: error.message || "Internal server error" }, { status: 500 })
  }
}
