import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { bundleVisibleTo, type OwnerType } from "@/lib/sms/foundation-rules"
import { isSmsEnabled, SMS_DISABLED_MESSAGE } from "@/lib/sms/kill-switch"
import { SMS_SURFACE, smsHostedGateway, smsStartRefusal } from "@/lib/sms/gateway-start"
import { startHostedPayment } from "@/lib/payment-gateway/start"
import { decideAttemptReplay } from "@/lib/payment-gateway/web-replay"
import { resolveTrustedBaseUrl } from "@/lib/custom-domain-lookup"

// A Hubtel start awaits the relay.
export const maxDuration = 60

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(authHeader.slice(7))
  if (error || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await isSmsEnabled())) return NextResponse.json({ error: SMS_DISABLED_MESSAGE, code: "SMS_DISABLED" }, { status: 503 })
  if (!user.email) return NextResponse.json({ error: "Account email required" }, { status: 400 })
  const { bundleId } = await request.json()
  const account = await getOrCreateAccountForUser(user.id)
  if (!account) return NextResponse.json({ error: "No SMS account" }, { status: 403 })
  if (account.owner_type !== "platform" && account.status !== "active") {
    return NextResponse.json({ error: "NOT_ACTIVATED" }, { status: 403 })
  }
  const { data: bundle } = await supabaseAdmin.from("sms_bundles").select("*").eq("id", bundleId).maybeSingle()
  if (!bundle || !bundle.active || !bundleVisibleTo(bundle, account.owner_type as OwnerType, account.mode ?? "platform")) {
    return NextResponse.json({ error: "Bundle not available" }, { status: 400 })
  }
  const amount = Number(bundle.price_ghs)
  const gateway = await smsHostedGateway(false, amount)
  const replay = await decideAttemptReplay(supabaseAdmin, SMS_SURFACE, gateway, { prefix: `smsbundle-${account.id}-${bundleId}-` })
  if (replay.kind === "refuse") return NextResponse.json(replay.body, { status: replay.status })
  const reference = replay.kind === "replay" ? replay.reference : `smsbundle-${account.id}-${bundleId}-${Date.now()}`
  try {
    const init = await startHostedPayment(SMS_SURFACE, {
      email: user.email,
      amount,
      reference,
      purpose: "SMS Bundle",
      metadata: { type: "sms_bundle", sms_account_id: account.id, units: bundle.units, bundle_id: bundleId },
      // Paystack returns to its dashboard's callback; Hubtel's return route needs somewhere to send the customer.
      ...(gateway === "hubtel" ? { redirectUrl: `${await resolveTrustedBaseUrl(request.headers.get("host"))}/dashboard/sms` } : {}),
      reusedReference: replay.kind === "replay",
    })
    return NextResponse.json({ authorizationUrl: init.authorizationUrl, reference })
  } catch (e) {
    const refusal = smsStartRefusal(e)
    if (refusal) return NextResponse.json(refusal.body, { status: refusal.status })
    throw e
  }
}
