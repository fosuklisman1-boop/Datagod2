import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { sendPushToUser } from "@/lib/push-service"
import { sendSMS } from "@/lib/sms-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const token = authHeader.slice(7)

  // Resolve user — accept both regular JWT and CRON_SECRET (for scheduled tasks)
  let userId: string
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && token === cronSecret) {
    const body = await request.json()
    if (!body.userId) return NextResponse.json({ error: "userId required" }, { status: 400 })
    userId = body.userId
    return handleNotify(userId, body)
  }

  const { data: authData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !authData?.user?.id) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 })
  }
  userId = authData.user.id

  const body = await request.json()
  return handleNotify(userId, body)
}

async function handleNotify(userId: string, body: Record<string, unknown>) {
  const { title, message, channels = ["push"] } = body as {
    title: string
    message: string
    channels?: string[]
  }

  if (!title || !message) {
    return NextResponse.json({ error: "title and message are required" }, { status: 400 })
  }

  const notifTitle = "DATAGOD AI"
  const notifBody = title !== "DATAGOD AI" ? `${title}: ${message}` : message

  let pushed = 0
  let smsed = 0

  if ((channels as string[]).includes("push")) {
    try {
      const result = await sendPushToUser(userId, { title: notifTitle, body: notifBody })
      pushed = result.sent
    } catch {}
  }

  if ((channels as string[]).includes("sms")) {
    const { data: user } = await supabase
      .from("users")
      .select("phone")
      .eq("id", userId)
      .maybeSingle()

    if (user?.phone) {
      try {
        const result = await sendSMS({
          phone: user.phone,
          message: `DATAGOD AI — ${notifBody}`.slice(0, 160),
          type: "reminder",
          userId,
          skipLogging: true,
        })
        if (result.success) smsed = 1
      } catch {}
    }
  }

  return NextResponse.json({ pushed, smsed })
}
