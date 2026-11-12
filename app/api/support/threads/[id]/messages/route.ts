import { NextRequest, NextResponse } from "next/server"
import { getSupportDb, getSupportUser } from "@/lib/support-auth"
import { isUuid, userMessageSchema } from "@/lib/support-validation"
import { checkSupportRateLimit } from "@/lib/support-rate-limit"

export const dynamic = "force-dynamic"

const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status })

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSupportUser(request)
  if (!user) return fail("Unauthorized", 401)
  const { userId } = user

  try {
    const { id } = await params
    if (!isUuid(id)) return fail("Invalid thread id", 400)

    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      return fail("Invalid request body", 400)
    }
    const parsed = userMessageSchema.safeParse(raw)
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid message", 400)

    const limit = await checkSupportRateLimit(request, "message_send", userId)
    if (!limit.allowed) return fail("Too many requests. Please try again later.", 429)

    const db = getSupportDb()
    const { data: thread, error: threadError } = await db
      .from("support_threads")
      .select("id, status")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle()
    if (threadError) {
      console.error("[SUPPORT] thread lookup failed", { userId, threadId: id })
      return fail("Something went wrong. Please try again.", 500)
    }
    if (!thread) return fail("Thread not found", 404)
    if (thread.status !== "open") return fail("This complaint is closed", 409)

    const { data: message, error } = await db
      .from("support_messages")
      .insert({ thread_id: id, sender_role: "user", sender_id: userId, body: parsed.data.message })
      .select("id, created_at")
      .single()
    if (error || !message) {
      console.error("[SUPPORT] message insert failed", { userId, threadId: id })
      return fail("Something went wrong. Please try again.", 500)
    }
    return NextResponse.json({ success: true, data: { id: message.id, created_at: message.created_at } }, { status: 201 })
  } catch {
    console.error("[SUPPORT] message send failed", { userId })
    return fail("Something went wrong. Please try again.", 500)
  }
}
