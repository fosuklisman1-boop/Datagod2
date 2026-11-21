import { NextResponse, NextRequest } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { parseQueueParams } from "@/lib/order-queue/params"
import { QUEUE_VIEWS, type QueueRow, type QueueView } from "@/lib/order-queue/types"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type DbRow = Record<string, unknown>

function mapRow(r: DbRow): QueueRow {
  return {
    id: String(r.id),
    createdAt: r.created_at as string,
    phoneNumber: (r.phone_number as string) ?? null,
    price: r.price == null ? null : Number(r.price),
    network: (r.network as string) ?? null,
    status: (r.status as string) ?? null,
    paymentStatus: (r.payment_status as string) ?? null,
    paymentReference: (r.payment_reference as string) ?? null,
    volumeGb: (r.volume_gb as string) ?? null,
    type: (r.type as string) ?? null,
    customerEmail: (r.customer_email as string) ?? null,
    storeName: (r.store_name as string) ?? null,
    shopOwnerEmail: (r.shop_owner_email as string) ?? null,
    lastProvider: (r.last_provider as string) ?? null,
    lastAttemptStatus: (r.last_attempt_status as string) ?? null,
    lastError: (r.last_error as string) ?? null,
    attemptCount: Number(r.attempt_count ?? 0),
    hasReversal: Boolean(r.has_reversal),
    isHeld: Boolean(r.is_held),
    failureReason: (r.failure_reason as QueueRow["failureReason"]) ?? null,
  }
}

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const parsed = parseQueueParams(request.nextUrl.searchParams)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const p = parsed.value

  try {
    const [rows, countRows] = await Promise.all([
      supabase.rpc("admin_order_queue", {
        p_view: p.view,
        p_statuses: p.statuses,
        p_networks: p.networks,
        p_types: p.types,
        p_from: p.from,
        p_to: p.to,
        p_search: p.search,
        p_last_provider: p.lastProvider,
        p_failure_reason: p.failureReason,
        p_limit: p.limit,
        p_offset: p.offset,
      }),
      supabase.rpc("admin_order_queue_counts", {
        p_networks: p.networks,
        p_types: p.types,
        p_from: p.from,
        p_to: p.to,
        p_search: p.search,
        p_last_provider: p.lastProvider,
        p_failure_reason: p.failureReason,
      }),
    ])

    if (rows.error || countRows.error) {
      // Log only a flag/length: error text and search could carry phone numbers.
      console.error("[ORDER-QUEUE] RPC failed", {
        view: p.view,
        searchLen: p.search.length,
        listFailed: Boolean(rows.error),
        countsFailed: Boolean(countRows.error),
      })
      return NextResponse.json({ error: "Failed to load the order queue. Please try again." }, { status: 500 })
    }

    const counts = Object.fromEntries(QUEUE_VIEWS.map((v) => [v, 0])) as Record<QueueView, number>
    for (const c of (countRows.data ?? []) as Array<{ view: string; n: number | string }>) {
      if ((QUEUE_VIEWS as readonly string[]).includes(c.view)) counts[c.view as QueueView] = Number(c.n)
    }

    const data = ((rows.data ?? []) as DbRow[]).map(mapRow)
    const total = counts[p.view]
    return NextResponse.json({
      success: true,
      data,
      counts,
      total,
      hasMore: p.offset + data.length < total,
    })
  } catch {
    console.error("[ORDER-QUEUE] Unexpected error", { view: p.view, searchLen: p.search.length })
    return NextResponse.json({ error: "Failed to load the order queue. Please try again." }, { status: 500 })
  }
}
