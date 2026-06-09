import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { sendWhatsAppText, sendWhatsAppMedia } from "@/lib/whatsapp-bot/send"
import { sendSMS } from "@/lib/sms-service"

export const dynamic = "force-dynamic"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const { searchParams } = new URL(request.url)
  const status = searchParams.get("status") ?? "pending"
  const page = parseInt(searchParams.get("page") ?? "1", 10)
  const limit = 20
  const offset = (page - 1) * limit

  let query = supabase
    .from("results_check_requests")
    .select("*", { count: "exact" })
    .eq("payment_status", "paid")   // never show unpaid/pending-payment requests
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (status !== "all") {
    query = query.eq("status", status)
  }

  const { data, count, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ data: data ?? [], count: count ?? 0, page, limit })
}

export async function PATCH(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json() as {
    id: string
    status?: string
    result_data?: string
    media_url?: string
    media_type?: "image" | "document" | "video"
    deliver?: boolean
  }

  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.status) updatePayload.status = body.status
  if (body.result_data !== undefined) updatePayload.result_data = body.result_data
  if (body.media_url !== undefined) updatePayload.media_url = body.media_url
  if (body.media_type !== undefined) updatePayload.media_type = body.media_type

  const { data: req, error: updateErr } = await supabase
    .from("results_check_requests")
    .update(updatePayload)
    .eq("id", body.id)
    .select()
    .single()

  if (updateErr || !req) {
    return NextResponse.json({ error: updateErr?.message ?? "Not found" }, { status: 400 })
  }

  // Deliver results if requested
  if (body.deliver && (req.result_data || req.media_url)) {
    const mediaUrl: string | null = body.media_url ?? req.media_url ?? null
    const mediaType: string = body.media_type ?? req.media_type ?? "image"

    if (req.channel === "whatsapp") {
      const phone = req.phone_number.startsWith("0")
        ? `233${req.phone_number.slice(1)}`
        : req.phone_number.replace(/^\+/, "")

      // Send text results first if present
      if (req.result_data) {
        const resultMsg =
          `Your ${req.exam_board} results for index number ${req.index_number} (${req.exam_year}):\n\n` +
          req.result_data +
          `\n\nRef: ${req.payment_reference}`
        await sendWhatsAppText(phone, resultMsg).catch(e =>
          console.error("[RC-DELIVER] WhatsApp text send failed:", e)
        )
      }

      // Send media if provided
      if (mediaUrl) {
        const caption = req.result_data
          ? undefined
          : `Your ${req.exam_board} results — ${req.index_number} (${req.exam_year})`
        await sendWhatsAppMedia(
          phone,
          mediaType as "image" | "document" | "video",
          mediaUrl,
          caption,
          mediaType === "document" ? `${req.exam_board}_results_${req.exam_year}.pdf` : undefined,
        ).catch(e => console.error("[RC-DELIVER] WhatsApp media send failed:", e))
      }
    } else {
      // USSD: SMS only (no media)
      if (req.result_data) {
        const resultMsg =
          `${req.exam_board} results for ${req.index_number} (${req.exam_year}):\n` +
          req.result_data +
          `\nRef: ${req.payment_reference}`
        await sendSMS({ phone: req.phone_number, message: resultMsg, type: "results_check", reference: req.id })
          .catch(e => console.error("[RC-DELIVER] SMS send failed:", e))
      }
    }

    // Mark as completed
    await supabase
      .from("results_check_requests")
      .update({ status: "completed", updated_at: new Date().toISOString() })
      .eq("id", req.id)
  }

  return NextResponse.json({ success: true, request: req })
}
