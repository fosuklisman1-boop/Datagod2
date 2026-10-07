import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createSupabaseTxStore } from "@/lib/ussd-hubtel/tx-store"
import { createOrderHandlers, createFailHandlers } from "@/lib/ussd-hubtel/order-handlers"
import { runStatusChecks } from "@/lib/ussd-hubtel/status-check"
import { checkTransactionStatus } from "@/lib/ussd-hubtel/relay"

export const maxDuration = 300

/** Stop starting new rows well before maxDuration; the next run picks up the rest. */
const TIME_BUDGET_MS = 240_000

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!
  const result = await runStatusChecks({
    store: createSupabaseTxStore(supabase),
    handlers: createOrderHandlers(supabase),
    failHandlers: createFailHandlers(supabase),
    check: checkTransactionStatus,
    deadlineMs: Date.now() + TIME_BUDGET_MS,
  })
  return NextResponse.json(result)
}
