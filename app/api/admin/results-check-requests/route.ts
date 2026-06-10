import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { deliverResultsCheckRequest } from "@/lib/results-checker-service"

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
    .in("payment_status", ["paid", "completed"])   // never show unpaid/pending-payment requests
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
  const deliveryNotes: string[] = []

  if (body.deliver && (req.result_data || req.media_url)) {
    const result = await deliverResultsCheckRequest(req.id)
    deliveryNotes.push(...result.deliveryNotes)
  }

  return NextResponse.json({ success: true, request: req, deliveryNotes })
}
