import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { canUseOwnSenderForConfirmations } from "@/lib/sms/order-confirmation"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const NO_SHOP_REASON = "Order confirmations are only available for shop accounts."

type State = { useOwnSender: boolean; canEnable: boolean; reason?: string }

/** The shop that backs this SMS account (user_shops.user_id = account.user_id), or null. */
async function shopIdFor(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("user_shops").select("id").eq("user_id", userId).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as { id?: string } | null)?.id ?? null
}

/** Stored toggle. A missing column (migration not applied) or any read error counts as off. */
async function readToggle(shopId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("shop_settings").select("order_confirmation_use_own_sender").eq("shop_id", shopId).maybeSingle()
  if (error) return false
  return (data as { order_confirmation_use_own_sender?: boolean } | null)?.order_confirmation_use_own_sender === true
}

async function stateFor(shopId: string): Promise<State> {
  const [useOwnSender, check] = await Promise.all([readToggle(shopId), canUseOwnSenderForConfirmations(shopId)])
  return { useOwnSender, canEnable: check.ok, ...(check.ok ? {} : { reason: check.reason }) }
}

export async function GET(request: NextRequest) {
  const auth = await resolveAccount(request)
  if (auth.error) return auth.error
  try {
    const shopId = await shopIdFor(auth.account.user_id)
    if (!shopId) return NextResponse.json({ success: true, data: { useOwnSender: false, canEnable: false, reason: NO_SHOP_REASON } })
    return NextResponse.json({ success: true, data: await stateFor(shopId) })
  } catch (e) {
    console.error("[SMS-ORDER-CONFIRM-API] GET failed:", e)
    return NextResponse.json({ success: false, error: "Could not load this setting" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await resolveAccount(request)
  if (auth.error) return auth.error

  const body = await request.json().catch(() => null)
  if (!body || typeof body.useOwnSender !== "boolean") {
    return NextResponse.json({ success: false, error: "useOwnSender must be true or false" }, { status: 400 })
  }
  const want: boolean = body.useOwnSender

  try {
    const shopId = await shopIdFor(auth.account.user_id)
    if (!shopId) return NextResponse.json({ success: false, error: NO_SHOP_REASON }, { status: 400 })

    if (want) {
      const check = await canUseOwnSenderForConfirmations(shopId)
      if (!check.ok) {
        return NextResponse.json({ success: false, error: check.reason ?? "You can't turn this on yet." }, { status: 400 })
      }
    }

    const { error } = await supabaseAdmin
      .from("shop_settings")
      .upsert({ shop_id: shopId, order_confirmation_use_own_sender: want }, { onConflict: "shop_id" })
    if (error) {
      console.error("[SMS-ORDER-CONFIRM-API] upsert failed:", error.message)
      return NextResponse.json({ success: false, error: "Could not save this setting" }, { status: 500 })
    }
    return NextResponse.json({ success: true, data: await stateFor(shopId) })
  } catch (e) {
    console.error("[SMS-ORDER-CONFIRM-API] PATCH failed:", e)
    return NextResponse.json({ success: false, error: "Could not save this setting" }, { status: 500 })
  }
}
