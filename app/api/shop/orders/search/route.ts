import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { shopHandleOrFilter } from "@/lib/shop-handle"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

import { applyRateLimit } from "@/lib/rate-limiter"
import { RATE_LIMITS } from "@/lib/rate-limit-config"

// Public endpoint (customers track orders by phone). It returns only what the tracking
// screens show: never buyer details, cost, profit or internal references.
const DATA_COLUMNS = "id, reference_code, network, volume_gb, total_price, order_status, payment_status, created_at, updated_at"
const AIRTIME_COLUMNS = "id, reference_code, network, airtime_amount, total_paid, status, payment_status, created_at, updated_at"

const badRequest = () =>
  NextResponse.json({ error: "Phone number and shop slug (or id) are required" }, { status: 400 })

/** Absent (undefined/null) is allowed; anything present must be a string. */
const optionalText = (value: unknown): string | undefined | false =>
  value === undefined || value === null ? undefined : typeof value === "string" ? value : false

export async function POST(request: NextRequest) {
  // Apply search rate limiting (e.g. 30/min max)
  const rateLimit = await applyRateLimit(
    request,
    'search_orders',
    RATE_LIMITS.SEARCH.maxRequests,
    RATE_LIMITS.SEARCH.windowMs
  )

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: RATE_LIMITS.SEARCH.message },
      { status: 429 }
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest()
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return badRequest()
  const input = body as Record<string, unknown>

  const phone = typeof input.phone === "string" ? input.phone.trim() : ""
  const shopSlug = optionalText(input.shopSlug)
  let shopId = optionalText(input.shopId)
  if (!phone || shopSlug === false || shopId === false) return badRequest()

  try {
    // SECURITY: prefer slug, resolve server-side. Slug is the public identifier.
    // Match either the clean subdomain or the legacy shop_slug (on a subdomain
    // storefront this value is the subdomain; see middleware rewrite).
    if (shopSlug) {
      const { data: shopRow } = await supabase
        .from("user_shops")
        .select("id")
        .or(shopHandleOrFilter(shopSlug))
        .single()
      if (shopRow) shopId = shopRow.id
      else return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    if (!shopId) return badRequest()

    // Verify the shop exists, no user_id enforcement needed for public search
    const { data: shop } = await supabase
      .from("user_shops")
      .select("id")
      .eq("id", shopId)
      .single()

    if (!shop) {
      return NextResponse.json({ error: "Invalid shop ID" }, { status: 404 })
    }

    const { data: dataOrders } = await supabase
      .from("shop_orders")
      .select(DATA_COLUMNS)
      .eq("shop_id", shopId)
      .eq("customer_phone", phone)
      .order("created_at", { ascending: false })
      .limit(200)

    const { data: airtimeOrders } = await supabase
      .from("airtime_orders")
      .select(AIRTIME_COLUMNS)
      .eq("shop_id", shopId)
      .eq("beneficiary_phone", phone)
      .order("created_at", { ascending: false })
      .limit(200)

    // Built field by field: a row can never carry an extra column into the response.
    const combinedOrders = [
      ...((dataOrders as any[]) || []).map(o => ({
        id: o.id,
        type: "data",
        reference_code: o.reference_code,
        network: o.network,
        volume_gb: o.volume_gb,
        total_price: o.total_price,
        order_status: o.order_status,
        payment_status: o.payment_status,
        created_at: o.created_at,
        updated_at: o.updated_at,
      })),
      ...((airtimeOrders as any[]) || []).map(o => ({
        id: o.id,
        type: "airtime",
        reference_code: o.reference_code || o.id,
        network: o.network,
        volume_gb: o.airtime_amount,
        total_price: Number(o.total_paid) || 0,
        order_status: o.status || "pending",
        payment_status: o.payment_status,
        created_at: o.created_at,
        updated_at: o.updated_at,
      })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    return NextResponse.json({ success: true, orders: combinedOrders, count: combinedOrders.length })
  } catch (error) {
    console.error("[SHOP-ORDER-SEARCH] Error searching orders:", error instanceof Error ? error.message : "unknown")
    return NextResponse.json({ error: "Internal server error", success: false }, { status: 500 })
  }
}
