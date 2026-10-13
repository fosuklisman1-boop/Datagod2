import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { checkLowBalance } from "@/lib/hubtel-cs/float"
import { getHubtelCsRuntime, HUBTEL_CS_CRON_TIME_BUDGET_MS, HUBTEL_CS_EVENT_RETENTION_MS } from "@/lib/hubtel-cs/runtime"
import { isMissingTableError, runHubtelCsStatusChecks, warnLedgerNotMigrated } from "@/lib/hubtel-cs/status-runner"

export const maxDuration = 300

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!
  const rt = getHubtelCsRuntime()

  // Reconciliation always runs, even while paused, disabled or when the config cannot be read:
  // rows already in flight must still settle.
  const result = await runHubtelCsStatusChecks({
    store: rt.store, check: rt.checkStatus, onTransition: rt.onTransition, deadlineMs: Date.now() + HUBTEL_CS_CRON_TIME_BUDGET_MS,
  })
  try {
    await rt.store.purgeEventsOlderThan(new Date(Date.now() - HUBTEL_CS_EVENT_RETENTION_MS).toISOString())
  } catch (e) {
    if (isMissingTableError(e)) warnLedgerNotMigrated()
    else console.error("[hubtel-cs] event purge failed:", e instanceof Error ? e.message : "error")
  }

  let balance: Awaited<ReturnType<typeof checkLowBalance>> = { checked: false }
  try {
    // A config read error is treated as disabled: no balance check (and no alert) for new work.
    const cfg = await rt.getConfig()
    if (cfg.enabled) balance = await checkLowBalance({ threshold: cfg.lowBalanceThreshold, fetchBalance: rt.fetchBalance, alert: rt.floatDeps.alert })
  } catch (e) {
    console.error("[hubtel-cs] low-balance check failed:", e instanceof Error ? e.message : "error")
  }
  return NextResponse.json({ ...result, balance })
}
