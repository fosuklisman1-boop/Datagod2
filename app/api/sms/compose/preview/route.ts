import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { applyRateLimit } from "@/lib/rate-limiter"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { getShopTokens } from "@/lib/sms/shop-context-service"
import { previewDraft } from "@/lib/sms/compose-preview"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const PREVIEW_LIMIT_PER_MIN = 60

const EMPTY_TOKENS = { shop_name: "", shop_link: "", shop_phone: "", shop_whatsapp: "" }

/**
 * POST /api/sms/compose/preview  { message, senderId?, recipientCount }
 * Advisory, read-only: what the send policy would decide for this draft. Never debits or logs.
 */
export async function POST(request: NextRequest) {
  const auth = await resolveAccount(request)
  if (auth.error) return auth.error
  const { account } = auth

  const rateLimit = await applyRateLimit(request, "sms_compose_preview", PREVIEW_LIMIT_PER_MIN, 60 * 1000, account.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: "Too many preview requests. Please slow down." }, { status: 429 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 })
  }
  const { message, senderId, recipientCount } = (body ?? {}) as { message?: unknown; senderId?: unknown; recipientCount?: unknown }

  if (typeof message !== "string" || message.length < 1 || message.length > 1000) {
    return NextResponse.json({ success: false, error: "message must be a string up to 1000 characters" }, { status: 400 })
  }
  if (senderId !== undefined && senderId !== null && typeof senderId !== "string") {
    return NextResponse.json({ success: false, error: "senderId must be a string" }, { status: 400 })
  }
  if (typeof recipientCount !== "number" || !Number.isInteger(recipientCount) || recipientCount < 0 || recipientCount > 5000) {
    return NextResponse.json({ success: false, error: "recipientCount must be an integer between 0 and 5000" }, { status: 400 })
  }

  try {
    // Same defaults the send route applies: shop tokens, and the account's first active sender ID
    // when none is chosen.
    const tokens = await getShopTokens(account).catch(() => EMPTY_TOKENS)
    let effectiveSenderId = (senderId as string | null | undefined) || undefined
    if (!effectiveSenderId) {
      const { data: activeSender } = await supabaseAdmin
        .from("sms_sender_ids")
        .select("sender_id")
        .eq("sms_account_id", account.id)
        .eq("local_status", "active")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle()
      effectiveSenderId = (activeSender as { sender_id?: string } | null)?.sender_id ?? undefined
    }
    const data = await previewDraft({ accountId: account.id, message, senderId: effectiveSenderId, recipientCount, tokens })
    return NextResponse.json({ success: true, data })
  } catch (e) {
    console.error("[SMS-PREVIEW] route failed:", e)
    return NextResponse.json({
      success: true,
      data: { decision: "allow", code: "OK", reason: "Preview unavailable.", flagged: false, unavailable: true },
    })
  }
}
