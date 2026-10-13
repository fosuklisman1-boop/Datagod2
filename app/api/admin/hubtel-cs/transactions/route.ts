import { NextRequest, NextResponse } from "next/server"
import { getOrderAdapter } from "@/lib/hubtel-cs/adapters"
import { clampPage, errorJson, requireAdmin, searchAlternate } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"
import type { HubtelCsState } from "@/lib/hubtel-cs/types"

export const dynamic = "force-dynamic"

const STATES = new Set(["created", "pending", "fulfilled", "failed", "needs_review"])

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  const sp = new URL(request.url).searchParams
  const stateParam = sp.get("state")
  const state = stateParam === "attention" ? "attention" : stateParam && STATES.has(stateParam) ? (stateParam as HubtelCsState) : undefined
  const q = sp.get("q") ?? undefined
  try {
    const { store } = getHubtelCsRuntime()
    const [{ rows, total }, stats] = await Promise.all([
      store.listForAdmin({ state, q, qAlt: searchAlternate(q), ...clampPage(sp) }),
      store.stats(),
    ])
    return NextResponse.json({
      rows: rows.map(r => ({ ...r, refundable: r.state === "failed" && !!r.order_id && !!getOrderAdapter(r.order_table)?.refundToWallet && !r.refund_claimed_at })),
      total, stats,
    })
  } catch (e) {
    return errorJson(e)
  }
}
