import { NextRequest, NextResponse } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { parsePaging, type Paging } from "@/lib/admin-users/drawer-params"
import { badRequest, gateAdmin, serviceClient, userIdParam, type IdCtx } from "@/lib/admin-users/route-utils"

export const dynamic = "force-dynamic"

const PARTS = ["all", "sub_agents", "withdrawals"] as const
type Part = (typeof PARTS)[number]

class QueryError extends Error {}
const must = <T,>(r: { data: T; error: { message: string } | null; count?: number | null }) => {
  if (r.error) throw new QueryError(r.error.message)
  return r
}

/**
 * GET /api/admin/users/[id]/shop?part=all|sub_agents|withdrawals&page=1&pageSize=20
 *
 * part=all (default): { shop, parent, subAgents, withdrawals } with page 1 of both lists.
 *   shop        { id, shop_name, shop_slug, is_active, created_at, customers, balance{...} } | null
 *   parent      the shop this user's shop sits under (sub-agents only): { id, shop_name, shop_slug, user_id } | null
 * part=sub_agents | withdrawals: just that list, at ?page.
 *   subAgents   { rows: [{ shop_id, user_id, email, shop_name, shop_slug, created_at }], total, page, pageSize }
 *   withdrawals { rows: [{ id, amount, fee_amount, net_amount, status, withdrawal_method, reference_code, created_at }], total, ... }
 * Counts are exact counts; nothing is loaded to be counted.
 */
export async function GET(req: NextRequest, ctx: IdCtx) {
  const gate = await gateAdmin(req)
  if (!gate.ok) return gate.response
  const idp = await userIdParam(ctx)
  if (!idp.ok) return idp.response

  const sp = new URL(req.url).searchParams
  const part = (sp.get("part") || "all") as Part
  if (!PARTS.includes(part)) return badRequest("Unknown part")
  const paging = parsePaging(sp)
  if (!paging.ok) return badRequest(paging.error)
  if (part === "all" && paging.value.page !== 1) return badRequest("page applies to part=sub_agents or part=withdrawals")

  const db = serviceClient()
  try {
    const shopRes = must(await db
      .from("user_shops")
      .select("id, shop_name, shop_slug, is_active, parent_shop_id, created_at")
      .eq("user_id", idp.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle())
    const shop = shopRes.data as { id: string; shop_name: string; shop_slug: string; is_active: boolean | null; parent_shop_id: string | null; created_at: string } | null

    if (part === "sub_agents") return NextResponse.json({ subAgents: await subAgents(db, shop?.id ?? null, paging.value) })
    if (part === "withdrawals") return NextResponse.json({ withdrawals: await withdrawals(db, idp.id, paging.value) })

    const [balance, customers, parent, subs, wds] = await Promise.all([
      shop
        ? db.from("shop_available_balance")
            .select("available_balance, total_profit, withdrawn_profit, pending_profit, credited_profit")
            .eq("shop_id", shop.id).maybeSingle().then(must)
        : null,
      shop ? db.from("shop_customers").select("id", { count: "exact", head: true }).eq("shop_id", shop.id).then(must) : null,
      shop?.parent_shop_id
        ? db.from("user_shops").select("id, shop_name, shop_slug, user_id").eq("id", shop.parent_shop_id).maybeSingle().then(must)
        : null,
      subAgents(db, shop?.id ?? null, paging.value),
      withdrawals(db, idp.id, paging.value),
    ])

    const b = (balance?.data ?? null) as Record<string, unknown> | null
    return NextResponse.json({
      shop: shop
        ? {
            id: shop.id,
            shop_name: shop.shop_name,
            shop_slug: shop.shop_slug,
            is_active: shop.is_active,
            created_at: shop.created_at,
            customers: customers?.count ?? 0,
            balance: {
              available: Number(b?.available_balance ?? 0),
              totalProfit: Number(b?.total_profit ?? 0),
              withdrawn: Number(b?.withdrawn_profit ?? 0),
              pending: Number(b?.pending_profit ?? 0),
              credited: Number(b?.credited_profit ?? 0),
            },
          }
        : null,
      parent: parent?.data ?? null,
      subAgents: subs,
      withdrawals: wds,
    })
  } catch (e) {
    console.error("[ADMIN-USER-SHOP]", e instanceof Error ? e.message : e)
    return NextResponse.json({ error: "Failed to load shop" }, { status: 500 })
  }
}

async function subAgents(db: SupabaseClient, shopId: string | null, { page, pageSize, offset, to }: Paging) {
  if (!shopId) return { rows: [], total: 0, page, pageSize }
  const res = must(await db
    .from("user_shops")
    .select("id, user_id, shop_name, shop_slug, created_at", { count: "exact" })
    .eq("parent_shop_id", shopId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, to))
  const shops = (res.data ?? []) as Array<{ id: string; user_id: string; shop_name: string; shop_slug: string; created_at: string }>
  const emails = new Map<string, string | null>()
  if (shops.length) {
    const users = must(await db.from("users").select("id, email").in("id", shops.map((s) => s.user_id)))
    for (const u of (users.data ?? []) as Array<{ id: string; email: string | null }>) emails.set(u.id, u.email)
  }
  return {
    rows: shops.map((s) => ({
      shop_id: s.id, user_id: s.user_id, email: emails.get(s.user_id) ?? null,
      shop_name: s.shop_name, shop_slug: s.shop_slug, created_at: s.created_at,
    })),
    total: res.count ?? 0,
    page,
    pageSize,
  }
}

async function withdrawals(db: SupabaseClient, userId: string, { page, pageSize, offset, to }: Paging) {
  const res = must(await db
    .from("withdrawal_requests")
    .select("id, amount, fee_amount, net_amount, status, withdrawal_method, reference_code, created_at", { count: "exact" })
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, to))
  return { rows: res.data ?? [], total: res.count ?? 0, page, pageSize }
}
