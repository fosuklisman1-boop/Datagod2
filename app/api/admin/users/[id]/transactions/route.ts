import { NextRequest, NextResponse } from "next/server"
import { parsePaging, parseTxFilter, TX_FILTERS } from "@/lib/admin-users/drawer-params"
import { badRequest, gateAdmin, serviceClient, userIdParam, type IdCtx } from "@/lib/admin-users/route-utils"

export const dynamic = "force-dynamic"

const TX_COLUMNS = "id, type, amount, status, description, reference_id, source, balance_before, balance_after, created_at"

/**
 * GET /api/admin/users/[id]/transactions?page=1&pageSize=20&type=credit|debit|refund|admin
 *
 * One page of the user's wallet ledger (public.transactions), newest first, with an exact count of the
 * matching rows, plus the wallet's current balance and running totals.
 * → { rows, total, page, pageSize, wallet: { balance, totalCredited, totalSpent, rows } | null }
 *   wallet.rows is the number of wallet rows the user has; more than one is a data problem.
 */
export async function GET(req: NextRequest, ctx: IdCtx) {
  const gate = await gateAdmin(req)
  if (!gate.ok) return gate.response
  const idp = await userIdParam(ctx)
  if (!idp.ok) return idp.response

  const sp = new URL(req.url).searchParams
  const paging = parsePaging(sp)
  if (!paging.ok) return badRequest(paging.error)
  const type = parseTxFilter(sp)
  if (!type.ok) return badRequest(type.error)
  const { page, pageSize, offset, to } = paging.value

  const db = serviceClient()
  let q = db.from("transactions").select(TX_COLUMNS, { count: "exact" }).eq("user_id", idp.id)
  if (type.value) q = q.in("type", [...TX_FILTERS[type.value]])
  const [tx, wallet] = await Promise.all([
    q.order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, to),
    db.from("wallets").select("balance, total_credited, total_spent", { count: "exact" }).eq("user_id", idp.id)
      .order("balance", { ascending: false }).limit(1).maybeSingle(),
  ])
  if (tx.error || wallet.error) {
    console.error("[ADMIN-USER-TX]", tx.error?.message ?? wallet.error?.message)
    return NextResponse.json({ error: "Failed to load transactions" }, { status: 500 })
  }
  const w = wallet.data as { balance: unknown; total_credited: unknown; total_spent: unknown } | null
  return NextResponse.json({
    rows: tx.data ?? [],
    total: tx.count ?? 0,
    page,
    pageSize,
    // rows > 1 means duplicate wallet rows: the balance shown is the larger one and adjustments are refused.
    wallet: w
      ? { balance: Number(w.balance ?? 0), totalCredited: Number(w.total_credited ?? 0), totalSpent: Number(w.total_spent ?? 0), rows: wallet.count ?? 1 }
      : null,
  })
}
