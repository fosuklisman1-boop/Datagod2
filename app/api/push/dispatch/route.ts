import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Target of the Supabase Database Webhook on `public.notifications` INSERT.
// Sends the inserted notification as an Expo push to all of the user's devices.
// Always returns 200 to the webhook (failures are logged) so Supabase doesn't
// retry-storm; auth failures are the exception and return 401.
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"

export async function POST(request: NextRequest) {
  // Fail closed: if the secret env is missing, nobody can use this endpoint.
  const secret = process.env.PUSH_WEBHOOK_SECRET
  if (!secret || request.headers.get("x-push-webhook-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let payload: any
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ ok: true, skipped: "bad body" })
  }
  const record = payload?.record
  if (payload?.type !== "INSERT" || !record?.user_id || !record?.title) {
    return NextResponse.json({ ok: true, skipped: "not a notification insert" })
  }

  const { data: tokens, error } = await supabaseAdmin
    .from("device_push_tokens")
    .select("token")
    .eq("user_id", record.user_id)
  if (error || !tokens || tokens.length === 0) {
    return NextResponse.json({ ok: true, sent: 0 })
  }

  const messages = tokens.map((t) => ({
    to: t.token,
    title: record.title,
    body: record.message ?? "",
    sound: "default" as const,
    channelId: "default",
    data: {
      type: record.type ?? "admin_action",
      reference_id: record.reference_id ?? null,
      action_url: record.action_url ?? null,
      notificationId: record.id ?? null,
    },
  }))

  let sent = 0
  const dead: string[] = []
  // Expo accepts max 100 messages per request.
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100)
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chunk),
      })
      const json = await res.json().catch(() => null)
      const tickets: any[] = Array.isArray(json?.data) ? json.data : []
      tickets.forEach((ticket, idx) => {
        if (ticket?.status === "ok") sent++
        else if (ticket?.details?.error === "DeviceNotRegistered") dead.push(chunk[idx].to)
      })
    } catch (e) {
      console.error("[PUSH-DISPATCH] Expo send failed:", e)
    }
  }

  if (dead.length > 0) {
    await supabaseAdmin.from("device_push_tokens").delete().in("token", dead)
  }
  return NextResponse.json({ ok: true, sent, pruned: dead.length })
}
