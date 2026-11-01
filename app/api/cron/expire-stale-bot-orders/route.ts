import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { expireStaleBotOrders } from "@/lib/bot-commission/stale-sweep"
import { watchStuckSpecialGroups, type SpecialWatchResult } from "@/lib/standard-bundles/special-watch"

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

  // Special Bundles stuck-children watch: READ-ONLY on orders, one urgent alert per stuck group (6h dedupe).
  // Never affects the sweep or this response's status; skips itself before migration 0141.
  let specialWatch: SpecialWatchResult | { error: true } | undefined
  try {
    specialWatch = await watchStuckSpecialGroups(supabase, {
      alert: async (message) => {
        const { notifyAdmins } = await import("@/lib/sms-service")
        await notifyAdmins(message, "bills_review", undefined, false) // urgent: keep the email fallback
      },
    })
  } catch (e) {
    console.error("[SPECIAL-WATCH] failed:", e instanceof Error ? e.message : String(e))
    specialWatch = { error: true }
  }

  return NextResponse.json({ ok: result.errors === 0, ...result, specialWatch }, { status: result.errors === 0 ? 200 : 500 })
}
