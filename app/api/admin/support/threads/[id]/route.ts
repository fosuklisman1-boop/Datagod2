import { NextRequest, NextResponse } from "next/server"
import { getSupportDb, requireSupportAdmin } from "@/lib/support-auth"
import { adminActionSchema, isUuid } from "@/lib/support-validation"
import { getCounterpartReceipt, type SenderRole } from "@/lib/support-ticks"
import { signAttachmentUrl } from "@/lib/support-attachment"
import { notifyUserSupportEvent, runAfterResponse } from "@/lib/support-notify"
import { touchAdminPresence } from "@/lib/admin-presence"
import { loadSupportOrders, loadThreadUsers, THREAD_COLUMNS } from "@/lib/support-admin-data"

export const dynamic = "force-dynamic"

const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status })
const GENERIC = "Something went wrong. Please try again."

type MessageRow = {
  id: string
  sender_role: SenderRole
  body: string
  attachment_path: string | null
  created_at: string
  delivered_to_user_at: string | null
  delivered_to_admin_at: string | null
  read_by_user_at: string | null
  read_by_admin_at: string | null
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSupportAdmin(request)
  if ("response" in auth) return auth.response
  const { adminId } = auth

  try {
    const { id } = await params
    if (!isUuid(id)) return fail("Invalid thread id", 400)

    const db = getSupportDb()
    const { data: thread, error } = await db.from("support_threads").select(THREAD_COLUMNS).eq("id", id).maybeSingle()
    if (error) {
      console.error("[SUPPORT] admin thread lookup failed", { adminId, threadId: id })
      return fail(GENERIC, 500)
    }
    if (!thread) return fail("Thread not found", 404)

    await touchAdminPresence(db, adminId)

    // Grey double-tick for the customer: the admin has now opened the conversation.
    const { error: deliverError } = await db
      .from("support_messages")
      .update({ delivered_to_admin_at: new Date().toISOString() })
      .eq("thread_id", id)
      .eq("sender_role", "user")
      .is("delivered_to_admin_at", null)
    if (deliverError) console.warn("[SUPPORT] mark delivered failed", { adminId, threadId: id })

    const { data: rows, error: msgError } = await db
      .from("support_messages")
      .select("id, sender_role, body, attachment_path, created_at, delivered_to_user_at, delivered_to_admin_at, read_by_user_at, read_by_admin_at")
      .eq("thread_id", id)
      .order("created_at", { ascending: true })
    if (msgError) {
      console.error("[SUPPORT] admin messages lookup failed", { adminId, threadId: id })
      return fail(GENERIC, 500)
    }

    const [users, orders, messages] = await Promise.all([
      loadThreadUsers(db, [thread.user_id]),
      loadSupportOrders(db, [thread]),
      Promise.all(
        ((rows ?? []) as MessageRow[]).map(async (m) => ({
          id: m.id,
          sender_role: m.sender_role,
          body: m.body,
          created_at: m.created_at,
          ...getCounterpartReceipt(m.sender_role, m),
          attachment_url: await signAttachmentUrl(db, m.attachment_path),
        })),
      ),
    ])
    const found = orders.get(thread.id)
    return NextResponse.json({
      success: true,
      data: {
        ...thread,
        user: users.get(thread.user_id) ?? { first_name: null, last_name: null, email: null, phone_number: null },
        order: found?.order ?? null,
        supplier: found?.supplier ?? null,
        messages,
      },
    })
  } catch {
    console.error("[SUPPORT] admin thread view failed", { adminId })
    return fail(GENERIC, 500)
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSupportAdmin(request)
  if ("response" in auth) return auth.response
  const { adminId } = auth

  try {
    const { id } = await params
    if (!isUuid(id)) return fail("Invalid thread id", 400)

    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      return fail("Invalid request body", 400)
    }
    const parsed = adminActionSchema.safeParse(raw)
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid request", 400)
    const action = parsed.data

    const db = getSupportDb()
    // Recipient and state come from this row only; nothing else in the body is read.
    const { data: thread, error } = await db.from("support_threads").select("id, user_id, status").eq("id", id).maybeSingle()
    if (error) {
      console.error("[SUPPORT] admin thread lookup failed", { adminId, threadId: id })
      return fail(GENERIC, 500)
    }
    if (!thread) return fail("Thread not found", 404)

    await touchAdminPresence(db, adminId)

    if (action.action === "read") {
      const now = new Date().toISOString()
      const { error: readError } = await db
        .from("support_messages")
        .update({ read_by_admin_at: now, delivered_to_admin_at: now })
        .eq("thread_id", id)
        .eq("sender_role", "user")
        .is("read_by_admin_at", null)
      if (readError) {
        console.error("[SUPPORT] mark read failed", { adminId, threadId: id })
        return fail(GENERIC, 500)
      }
      return NextResponse.json({ success: true, data: { ok: true } })
    }

    if (action.action === "reply") {
      if (thread.status !== "open") return fail("This complaint is closed", 409)
      const { data: message, error: insertError } = await db
        .from("support_messages")
        .insert({ thread_id: id, sender_role: "admin", sender_id: adminId, body: action.message })
        .select("id, created_at")
        .single()
      if (insertError || !message) {
        console.error("[SUPPORT] admin reply insert failed", { adminId, threadId: id })
        return fail(GENERIC, 500)
      }
      const { error: handlerError } = await db.from("support_threads").update({ handler: "human" }).eq("id", id)
      if (handlerError) console.warn("[SUPPORT] handler update failed", { adminId, threadId: id })
      runAfterResponse(() => notifyUserSupportEvent(db, thread.user_id, "replied", id))
      return NextResponse.json({ success: true, data: { id: message.id, created_at: message.created_at } }, { status: 201 })
    }

    // close
    if (thread.status !== "open") return fail("This complaint is already closed", 409)
    // The status guard makes two concurrent closes safe: only one gets a row back.
    const { data: closed, error: closeError } = await db
      .from("support_threads")
      .update({ status: "closed", closed_at: new Date().toISOString(), closed_by: adminId })
      .eq("id", id)
      .eq("status", "open")
      .select("id")
    if (closeError) {
      console.error("[SUPPORT] close failed", { adminId, threadId: id })
      return fail(GENERIC, 500)
    }
    if (!Array.isArray(closed) || closed.length === 0) return fail("This complaint is already closed", 409)
    // Only the close that won leaves a note. A note that fails to save never undoes the close.
    if (action.note) {
      const { error: noteError } = await db
        .from("support_messages")
        .insert({ thread_id: id, sender_role: "admin", sender_id: adminId, body: action.note })
      if (noteError) console.error("[SUPPORT] closing note insert failed", { adminId, threadId: id })
    }
    runAfterResponse(() => notifyUserSupportEvent(db, thread.user_id, "closed", id))
    return NextResponse.json({ success: true, data: { ok: true } })
  } catch {
    console.error("[SUPPORT] admin thread action failed", { adminId })
    return fail(GENERIC, 500)
  }
}
