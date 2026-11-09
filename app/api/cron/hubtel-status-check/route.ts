import { after, NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createSupabaseTxStore } from "@/lib/ussd-hubtel/tx-store"
import { createOrderHandlers, createFailHandlers, createPaidReviewHandlers, createPossiblyPaidAlerts } from "@/lib/ussd-hubtel/order-handlers"
import { runStatusChecks } from "@/lib/ussd-hubtel/status-check"
import { checkTransactionStatus } from "@/lib/ussd-hubtel/relay"
import { withStatusCheckLogging } from "@/lib/ussd-hubtel/callback-log"
import { safeDbError } from "@/lib/ussd-hubtel/log-safe"
import { urgentAlert } from "@/lib/ussd-hubtel/special-payment"
import { sweepWalletPayments } from "@/lib/ussd-hubtel/wallet-pay"

export const maxDuration = 300

/** Stop starting new rows well before maxDuration; the next run picks up the rest. */
const TIME_BUDGET_MS = 240_000

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!
  const deadlineMs = Date.now() + TIME_BUDGET_MS
  const handlers = createOrderHandlers(supabase, { defer: after })

  // Customers' wallets already debited, with no order finished. A failure here must not stop the status checks.
  let walletSweep: Awaited<ReturnType<typeof sweepWalletPayments>> | null = null
  try {
    walletSweep = await sweepWalletPayments(supabase, handlers, urgentAlert, undefined, deadlineMs)
  } catch (e) {
    console.error("[HUBTEL-STATUS] wallet sweep failed:", safeDbError(e))
  }

  const check = withStatusCheckLogging(checkTransactionStatus, supabase)
  const result = await runStatusChecks({
    store: createSupabaseTxStore(supabase),
    handlers,
    failHandlers: createFailHandlers(supabase),
    paidReviewHandlers: createPaidReviewHandlers(supabase),
    possiblyPaidAlerts: createPossiblyPaidAlerts(supabase),
    check,
    deadlineMs,
  })
  await check.flush()
  return NextResponse.json({ ...result, walletSweep })
}
