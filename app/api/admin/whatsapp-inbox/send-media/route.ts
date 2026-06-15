import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { sendWhatsAppMedia } from "@/lib/whatsapp-bot/send"
import { logMessage } from "@/lib/whatsapp-bot/log-message"

export const dynamic = "force-dynamic"

// POST /api/admin/whatsapp-inbox/send-media
// { phone, mediaUrl, mediaType: "image" | "document", filename?, caption? }
// Sends an already-uploaded (public admin-uploads URL) photo/PDF to the customer
// and logs it as an outbound message carrying the media URL.
export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json().catch(() => ({})) as {
    phone?: string; mediaUrl?: string; mediaType?: string; filename?: string; caption?: string
  }
  const phone = String(body.phone ?? "").replace(/[^\d]/g, "")
  const mediaUrl = String(body.mediaUrl ?? "").trim()
  const mediaType = body.mediaType === "document" ? "document" : "image"
  const caption = (body.caption ?? "").trim() || undefined
  const filename = body.filename

  if (!phone) return NextResponse.json({ error: "phone is required" }, { status: 400 })
  if (!/^https:\/\//.test(mediaUrl)) return NextResponse.json({ error: "valid mediaUrl is required" }, { status: 400 })

  try {
    await sendWhatsAppMedia(phone, mediaType, mediaUrl, caption, mediaType === "document" ? filename : undefined)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[WA-INBOX] send-media failed:", msg)
    return NextResponse.json({ error: `Failed to send: ${msg}` }, { status: 502 })
  }

  // Log it as outbound, carrying the media so the bubble can render it. The
  // visible text is the caption, or a type label when there's no caption.
  const label = caption ?? (mediaType === "document" ? "📄 Document" : "📷 Photo")
  await logMessage(phone, "outbound", label, null, { url: mediaUrl, type: mediaType })

  return NextResponse.json({ ok: true })
}
