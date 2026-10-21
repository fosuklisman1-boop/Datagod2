import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { expireStaleBotOrders } from "@/lib/bot-commission/stale-sweep"

// Fails commission-cashback bot orders from the Uzo main + shop USSD and the WhatsApp main + shop bots (never Hubtel
// USSD or storefront) that stayed pending + unpaid for 30 minutes (bounded per run), and their in-flight
// wallet_payments rows. All logic: lib/bot-commission/stale-sweep.ts.
// A late Paystack payment after the sweep lands in the engine's needs-review path (paid + failed, never sent,
// URGENT refund alert); see docs/hubtel-commission-services/runbook.md.
export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const result = await expireStaleBotOrders(supabase)
  console.log("[BOT-STALE-SWEEP] run:", JSON.stringify(result))
  return NextResponse.json({ ok: result.errors === 0, ...result }, { status: result.errors === 0 ? 200 : 500 })
}
