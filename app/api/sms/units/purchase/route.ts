import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { purchaseUnitsByQuantity, quoteCredits } from "@/lib/sms/bundle-service"
import { initializePayment } from "@/lib/paystack"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// POST /api/sms/units/purchase — buy an arbitrary number of credits at the admin
// per-credit fee. Body: { credits: number, paidFrom: "wallet" | "paystack" }.
// The cost is ALWAYS computed server-side from sms_price_per_credit.
export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  let body: { credits?: unknown; paidFrom?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }

  const credits = Number(body.credits)
  const paidFrom = body.paidFrom === "paystack" ? "paystack" : "wallet"
  if (!Number.isInteger(credits) || credits <= 0) {
    return NextResponse.json({ error: "credits must be a positive integer" }, { status: 400 })
  }

  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ error: "No SMS account" }, { status: 403 })
  if (account.owner_type !== "platform" && account.status !== "active") {
    return NextResponse.json({ error: "NOT_ACTIVATED" }, { status: 403 })
  }

  if (paidFrom === "paystack") {
    if (!user.email) return NextResponse.json({ error: "Account email required" }, { status: 400 })
    const { cost } = await quoteCredits(credits)
    if (cost <= 0) return NextResponse.json({ error: "Pricing not configured" }, { status: 400 })
    const reference = `smsqty-${account.id}-${credits}-${Date.now()}`
    const init = await initializePayment({
      email: user.email,
      amount: cost,
      reference,
      purpose: "SMS Credits",
      metadata: { type: "sms_units_qty", sms_account_id: account.id, units: credits },
    })
    return NextResponse.json({ authorizationUrl: init.authorizationUrl, reference })
  }

  const result = await purchaseUnitsByQuantity(user.id, account.id, credits)
  if (!result.ok) {
    const status = result.error === "NOT_ACTIVATED" ? 403 : result.error === "Insufficient wallet balance" ? 402 : 400
    return NextResponse.json({ error: result.error }, { status })
  }
  return NextResponse.json({
    success: true,
    pending: result.pending ?? false,
    unitsCredited: result.unitsCredited ?? 0,
    cost: result.cost,
  })
}
