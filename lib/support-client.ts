import type { SenderRole } from "@/lib/support-ticks"

export interface ClientMessage {
  id: string
  thread_id: string
  sender_role: SenderRole
  body: string
  attachment_path: string | null
  delivered_to_user_at: string | null
  read_by_user_at: string | null
  created_at: string
}

export interface ClientThread {
  id: string
  order_id: string | null
  shop_order_id: string | null
  subject: string
  category: string
  status: "open" | "closed" | string
  last_message_at: string
  created_at: string
}

export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024
const SCREENSHOT_TYPES = ["image/jpeg", "image/png", "image/webp"]

/** Insert or replace by id, keeping time order. */
export function mergeMessage(list: ClientMessage[], incoming: ClientMessage): ClientMessage[] {
  const without = list.filter((m) => m.id !== incoming.id)
  return [...without, incoming].sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/** Support-side messages the user has not read yet. */
export function countUnread(list: ClientMessage[] | undefined): number {
  if (!list) return 0
  return list.filter((m) => m.sender_role !== "user" && !m.read_by_user_at).length
}

export function orderSubject(reference: string | null | undefined, id: string): string {
  const ref = reference && reference.trim() ? reference.trim() : id.slice(0, 8)
  return `Issue with order ${ref.replace(/[<>&]/g, "")}`.slice(0, 200)
}

/** The server rejects <, > and &; say so before the request. */
export function customerTextError(text: string): string | null {
  return /[<>&]/.test(text) ? "Please remove the characters < > & from your message." : null
}

export function validateScreenshot(file: { type: string; size: number }): string | null {
  if (!SCREENSHOT_TYPES.includes(file.type)) return "Only JPG, PNG and WebP images are allowed."
  if (file.size > MAX_SCREENSHOT_BYTES) return "The screenshot must be 4 MB or smaller."
  return null
}

const stripMarkup = (s: string) => s.replace(/[<>&]/g, "")

export interface ComplaintTarget {
  kind: "order" | "shop_order" | "none"
  id: string | null
  subject: string
}

/**
 * Which support link a My Orders row supports. Only `bulk` (orders) and `shop`
 * (shop_orders) rows can be linked; other types get an unlinked thread whose
 * subject names the order so an admin can find it.
 */
export function complaintTargetForOrder(row: {
  id: string
  type: string | null
  reference: string | null
  network_name: string
  package_name: string
  phone_number: string
}): ComplaintTarget {
  const ref = stripMarkup(row.reference && row.reference.trim() ? row.reference.trim() : row.id.slice(0, 8))
  const kind = row.type === "bulk" ? "order" : row.type === "shop" ? "shop_order" : "none"
  const subject =
    kind === "none"
      ? `Issue with order ${ref} - ${stripMarkup(row.network_name)} ${stripMarkup(row.package_name)} to ${stripMarkup(row.phone_number)}`
      : `Issue with order ${ref}`
  return { kind, id: kind === "none" ? null : row.id, subject: subject.slice(0, 200) }
}

export interface ThreadFormInput {
  /** "general" = form-supplied subject/category; "none" = order complaint with a precomputed subject, no link. */
  kind: "order" | "shop_order" | "general" | "none"
  id?: string
  reference?: string | null
  subject?: string
  category?: string
  message: string
  phone: string
  whatsapp: string
  image: File | null
}

export function buildThreadFormData(input: ThreadFormInput): FormData {
  const fd = new FormData()
  if (input.kind === "general") {
    fd.set("subject", input.subject ?? "")
    fd.set("category", input.category ?? "other")
  } else if (input.kind === "none") {
    fd.set("subject", input.subject ?? "")
    fd.set("category", "order")
  } else {
    fd.set("subject", input.subject ?? orderSubject(input.reference, input.id ?? ""))
    fd.set("category", "order")
    fd.set(input.kind === "order" ? "order_id" : "shop_order_id", input.id ?? "")
  }
  fd.set("message", input.message)
  fd.set("phone_number", input.phone)
  fd.set("whatsapp_number", input.whatsapp)
  if (input.image) fd.set("image", input.image)
  return fd
}

export type CreateThreadResult =
  | { ok: true; threadId: string; attachmentSaved: boolean | null }
  | { ok: false; error: string }

/** POST the multipart body to the create route and map status codes to copy. */
export async function postNewThread(fd: FormData, token: string): Promise<CreateThreadResult> {
  const res = await fetch("/api/support/threads", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  })
  const json = await res.json().catch(() => ({}))
  if (res.status === 201 && json?.success) {
    return { ok: true, threadId: json.data.thread_id, attachmentSaved: json.data.attachment_saved ?? null }
  }
  if (res.status === 409) return { ok: false, error: "You already have 3 open complaints" }
  if (res.status === 429) return { ok: false, error: "You are doing that too often. Please try again later." }
  return { ok: false, error: json?.error || "Could not send your complaint" }
}

/** Below lg only one pane shows at a time. */
export function visiblePanes(selectedId: string | null): { list: boolean; chat: boolean } {
  return { list: selectedId === null, chat: selectedId !== null }
}
