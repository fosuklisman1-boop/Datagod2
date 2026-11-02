import { NextRequest, NextResponse } from "next/server"
import { parseOrderFilters, parsePaging } from "@/lib/admin-users/drawer-params"
import { badRequest, gateAdmin, serviceClient, userIdParam, type IdCtx } from "@/lib/admin-users/route-utils"

export const dynamic = "force-dynamic"

/**
 * GET /api/admin/users/[id]/orders?page=1&pageSize=20&source=&status=
 *
 * The user's orders across every order table with a user_id column, newest first, from
 * public.admin_user_orders (migrations/0147): paging and the per-source counts are SQL. Counts stop at
 * countCap (1000) per source; cappedSources / totalCapped say when they did, and hasMore drives "Next".
 * → { rows, total, totalCapped, hasMore, counts: { <source>: n }, cappedSources, countCap, page, pageSize }
 */
export async function GET(req: NextRequest, ctx: IdCtx) {
  const gate = await gateAdmin(req)
  if (!gate.ok) return gate.response
  const idp = await userIdParam(ctx)
  if (!idp.ok) return idp.response

  const sp = new URL(req.url).searchParams
  const paging = parsePaging(sp)
  if (!paging.ok) return badRequest(paging.error)
  const filters = parseOrderFilters(sp)
  if (!filters.ok) return badRequest(filters.error)
  const { page, pageSize, offset } = paging.value

  const { data, error } = await serviceClient().rpc("admin_user_orders", {
    p_user_id: idp.id,
    p_source: filters.value.source,
    p_status: filters.value.status,
    p_limit: pageSize,
    p_offset: offset,
  })
  if (error) {
    console.error("[ADMIN-USER-ORDERS]", error.message)
    return NextResponse.json({ error: "Failed to load orders" }, { status: 500 })
  }
  return NextResponse.json({
    rows: data?.rows ?? [],
    total: Number(data?.total ?? 0),
    totalCapped: data?.total_capped === true,
    hasMore: data?.has_more === true,
    counts: data?.counts ?? {},
    cappedSources: data?.capped_sources ?? [],
    countCap: Number(data?.count_cap ?? 1000),
    page,
    pageSize,
  })
}
