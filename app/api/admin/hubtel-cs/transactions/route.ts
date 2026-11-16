import { NextRequest, NextResponse } from "next/server"
import { getOrderAdapter } from "@/lib/hubtel-cs/adapters"
import { clampPage, clampSearch, errorJson, requireAdmin, searchAlternate } from "@/lib/hubtel-cs/admin-route"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"
import { isMissingTableError } from "@/lib/hubtel-cs/status-runner"
import type { HubtelCsState } from "@/lib/hubtel-cs/types"
import type { LedgerFact } from "@/lib/bills/admin"
import { fetchLedgersFor, ledgerRetryCheck, supersededBy } from "@/lib/hubtel-cs/retry"

export const dynamic = "force-dynamic"

const STATES = new Set(["created", "pending", "fulfilled", "failed", "needs_review"])

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth.response
  const sp = new URL(request.url).searchParams
  const stateParam = sp.get("state")
  const state = stateParam === "attention" ? "attention" : stateParam && STATES.has(stateParam) ? (stateParam as HubtelCsState) : undefined
  const q = clampSearch(sp.get("q"))
  try {
    const { store, db } = getHubtelCsRuntime()
    const [{ rows, total }, stats] = await Promise.all([
      store.listForAdmin({ state, q, qAlt: searchAlternate(q), ...clampPage(sp) }),
      store.stats(),
    ])
    // Every attempt for the orders on this page, so a failed row knows whether a later attempt replaced it.
    // A read error only disables Retry on this page (fail closed); the list itself still loads.
    let ledgers: Map<string, LedgerFact[]> | null = null
    try { ledgers = await fetchLedgersFor(db, rows) } catch (e) { console.error("[hubtel-cs] ledger read for retry flags failed:", e instanceof Error ? e.message : e) }
    return NextResponse.json({
      rows: rows.map(r => {
        const ledger = ledgers?.get(`${r.order_table}:${r.order_id}`) ?? []
        const superseded = ledgers && r.order_id ? supersededBy(r, ledger) : null
        const retry = ledgers ? ledgerRetryCheck(r, ledger) : { ok: false as const, reason: "Could not read the Hubtel ledger; reload" }
        return {
          ...r,
          refundable: r.state === "failed" && !superseded && !!r.order_id && !!getOrderAdapter(r.order_table)?.refundToWallet && !r.refund_claimed_at,
          retryable: retry.ok,
          retry_block: retry.ok ? null : retry.reason,
          superseded,
        }
      }),
      total, stats,
    })
  } catch (e) {
    // Before migrations 0113/0114 the ledger table does not exist: show an empty page, not a 500.
    if (isMissingTableError(e)) {
      return NextResponse.json({ rows: [], total: 0, stats: { total: 0, in_flight: 0, needs_review: 0, failed: 0, fulfilled: 0, commission_earned: 0 }, notMigrated: true })
    }
    return errorJson(e)
  }
}
