import { NextRequest, NextResponse } from "next/server"
import { getSupportDb, getSupportUser } from "@/lib/support-auth"
import { createThreadSchema } from "@/lib/support-validation"
import { checkSupportRateLimit } from "@/lib/support-rate-limit"
import { ownedOrderTiming, ownedShopOrderTiming } from "@/lib/support-ownership"
import { complaintEligibility } from "@/lib/support-eligibility"
import { removeAttachments, storeThreadAttachment } from "@/lib/support-attachment"
import { alertAdminsNewThread, notifyUserSupportEvent, runAfterResponse } from "@/lib/support-notify"

export const dynamic = "force-dynamic"

const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status })

const FORM_FIELDS = ["subject", "category", "message", "phone_number", "whatsapp_number", "order_id", "shop_order_id"] as const

/** Returns the raw fields plus the optional image, or null when the body cannot be parsed. */
async function parseBody(request: NextRequest): Promise<{ raw: Record<string, unknown>; image: File | null } | null> {
  try {
    if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await request.formData()
      const raw: Record<string, unknown> = {}
      for (const key of FORM_FIELDS) {
        const v = form.get(key)
        if (typeof v === "string" && !((key === "order_id" || key === "shop_order_id") && v === "")) raw[key] = v
      }
      const img = form.get("image")
      return { raw, image: img instanceof File && img.size > 0 ? img : null }
    }
    const json = await request.json()
    if (!json || typeof json !== "object" || Array.isArray(json)) return null
    return { raw: json as Record<string, unknown>, image: null }
  } catch {
    return null
  }
}

export async function POST(request: NextRequest) {
  const user = await getSupportUser(request)
  if (!user) return fail("Unauthorized", 401)
  const { userId } = user

  try {
    const body = await parseBody(request)
    if (!body) return fail("Invalid request body", 400)
    const parsed = createThreadSchema.safeParse(body.raw)
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid request", 400)
    const input = parsed.data

    const limit = await checkSupportRateLimit(request, "thread_create", userId)
    if (!limit.allowed) return fail("Too many requests. Please try again later.", 429)

    const db = getSupportDb()
    // Ownership first (404 reveals nothing), then the owner's complaint window on the caller's own order.
    if (input.order_id || input.shop_order_id) {
      const timing = input.order_id
        ? await ownedOrderTiming(db, userId, input.order_id)
        : await ownedShopOrderTiming(db, userId, input.shop_order_id as string)
      if (!timing) return fail("Order not found", 404)
      const window = complaintEligibility(timing)
      if (!window.eligible) return fail(window.reason, 422)
    }

    const { data: thread, error: threadError } = await db
      .from("support_threads")
      .insert({
        user_id: userId,
        order_id: input.order_id ?? null,
        shop_order_id: input.shop_order_id ?? null,
        subject: input.subject,
        category: input.category,
        phone_number: input.phone_number,
        whatsapp_number: input.whatsapp_number,
      })
      .select("id")
      .single()
    if (threadError || !thread) {
      if (threadError?.message?.includes("OPEN_THREAD_LIMIT")) return fail("You already have 3 open complaints", 409)
      console.error("[SUPPORT] thread insert failed", { userId })
      return fail("Something went wrong. Please try again.", 500)
    }
    const threadId: string = thread.id

    const { data: message, error: messageError } = await db
      .from("support_messages")
      .insert({ thread_id: threadId, sender_role: "user", sender_id: userId, body: input.message })
      .select("id")
      .single()
    if (messageError || !message) {
      console.error("[SUPPORT] first message insert failed", { userId, threadId })
      const { error: cleanupError } = await db.from("support_threads").delete().eq("id", threadId).eq("user_id", userId)
      if (cleanupError) console.error("[SUPPORT] compensating thread delete failed", { userId, threadId })
      return fail("Something went wrong. Please try again.", 500)
    }

    let attachmentSaved: boolean | null = null
    if (body.image) {
      attachmentSaved = false
      const stored = await storeThreadAttachment(db, { userId, threadId, file: body.image })
      if ("path" in stored) {
        const { error } = await db
          .from("support_messages")
          .update({ attachment_path: stored.path })
          .eq("id", message.id)
          .eq("thread_id", threadId)
        if (error) {
          console.error("[SUPPORT] attachment path update failed", { userId, threadId })
          // The file is uploaded but no row points at it: remove it so no orphan stays.
          await removeAttachments(db, [stored.path])
        } else attachmentSaved = true
      }
    }

    runAfterResponse(async () => {
      try {
        await alertAdminsNewThread({ threadId, subject: input.subject, summary: input.message })
      } catch {
        console.error("[SUPPORT] admin alert threw", { threadId })
      }
      try {
        await notifyUserSupportEvent(db, userId, "received", threadId)
      } catch {
        console.error("[SUPPORT] user notification threw", { threadId })
      }
    })

    return NextResponse.json({ success: true, data: { thread_id: threadId, attachment_saved: attachmentSaved } }, { status: 201 })
  } catch {
    console.error("[SUPPORT] thread create failed", { userId })
    return fail("Something went wrong. Please try again.", 500)
  }
}
