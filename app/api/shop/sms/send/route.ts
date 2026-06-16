import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAccountForUser } from "@/lib/sms/account-service"
import { enqueueSend } from "@/lib/sms/send-service"
import { getShopTokens } from "@/lib/sms/shop-context-service"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  // Auth
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const token = authHeader.slice(7)
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Account
  const account = await getOrCreateAccountForUser(user.id)
  if (!account) {
    return NextResponse.json({ error: "No SMS account for this user" }, { status: 403 })
  }

  // Body validation
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON" }, { status: 400 })
  }

  const { message, recipients, senderId } = (body ?? {}) as { message?: unknown; recipients?: unknown; senderId?: unknown }

  if (senderId !== undefined && typeof senderId !== "string") {
    return NextResponse.json({ success: false, error: "senderId must be a string" }, { status: 400 })
  }

  if (
    typeof message !== "string" ||
    message.length < 3 ||
    message.length > 1000
  ) {
    return NextResponse.json(
      { success: false, error: "message must be a string between 3 and 1000 characters" },
      { status: 400 }
    )
  }

  if (
    !Array.isArray(recipients) ||
    recipients.length === 0 ||
    !recipients.every((r) => typeof r === "string")
  ) {
    return NextResponse.json(
      { success: false, error: "recipients must be a non-empty string array" },
      { status: 400 }
    )
  }

  if (recipients.length > 500) {
    return NextResponse.json(
      { success: false, error: "TOO_MANY_RECIPIENTS", message: "Maximum 500 recipients per send" },
      { status: 400 }
    )
  }

  // Resolve {shop_*} merge-token values so the Insert chips substitute correctly,
  // and default the sender to the account's own active sender ID (their brand)
  // when the client didn't pick one.
  const tokens = await getShopTokens(account)

  let effectiveSenderId = senderId as string | undefined
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

  // Enqueue
  const result = await enqueueSend(user.id, account.id, message, recipients as string[], tokens, effectiveSenderId)

  if (!result.ok) {
    switch (result.error) {
      case "BLOCKED":
        return NextResponse.json(
          { success: false, error: result.error, reason: result.reason },
          { status: 400 }
        )
      case "EMPTY_MESSAGE":
      case "TOO_MANY_RECIPIENTS":
      case "NO_VALID_RECIPIENTS":
      case "INVALID_SENDER_ID":
        return NextResponse.json(
          { success: false, error: result.error },
          { status: 400 }
        )
      case "NOT_ACTIVATED":
      case "SUSPENDED":
        return NextResponse.json(
          { success: false, error: result.error },
          { status: 403 }
        )
      case "INSUFFICIENT_CREDITS":
        return NextResponse.json(
          { success: false, error: result.error },
          { status: 402 }
        )
      default:
        return NextResponse.json(
          { success: false, error: "UNKNOWN_ERROR" },
          { status: 500 }
        )
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      sendLogId: result.sendLogId,
      total: result.total,
      segments: result.segments,
      creditsReserved: result.creditsReserved,
    },
  })
}
