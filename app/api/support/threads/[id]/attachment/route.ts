import { NextRequest, NextResponse } from "next/server"
import { getSupportDb, getSupportUser } from "@/lib/support-auth"
import { isUuid } from "@/lib/support-validation"
import { signAttachmentUrl } from "@/lib/support-attachment"

export const dynamic = "force-dynamic"

const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status })

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSupportUser(request)
  if (!user) return fail("Unauthorized", 401)
  const { userId } = user

  try {
    const { id } = await params
    if (!isUuid(id)) return fail("Invalid thread id", 400)

    const db = getSupportDb()
    const { data: thread, error: threadError } = await db
      .from("support_threads")
      .select("id")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle()
    if (threadError) {
      console.error("[SUPPORT] thread lookup failed", { userId, threadId: id })
      return fail("Something went wrong. Please try again.", 500)
    }
    if (!thread) return fail("Thread not found", 404)

    // The screenshot is attached to the thread's earliest (first user) message.
    const { data: first, error } = await db
      .from("support_messages")
      .select("attachment_path")
      .eq("thread_id", id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error) {
      console.error("[SUPPORT] attachment lookup failed", { userId, threadId: id })
      return fail("Something went wrong. Please try again.", 500)
    }

    const url = await signAttachmentUrl(db, first?.attachment_path ?? null)
    return NextResponse.json({ success: true, data: { url } })
  } catch {
    console.error("[SUPPORT] attachment fetch failed", { userId })
    return fail("Something went wrong. Please try again.", 500)
  }
}
