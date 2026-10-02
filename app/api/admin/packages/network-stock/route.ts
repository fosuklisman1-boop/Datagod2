import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import {
  getNetworkStockMap,
  setNetworkOutOfStock,
  restockNetwork,
  STOCK_TRACKED_NETWORKS,
} from "@/lib/network-stock-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    const status = await getNetworkStockMap(adminClient)
    return NextResponse.json({ status })
  } catch (error) {
    console.error("[NETWORK-STOCK] GET error:", error)
    return NextResponse.json({ error: "Failed to fetch network stock status" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { network, outOfStock } = body ?? {}

  if (!STOCK_TRACKED_NETWORKS.includes(network)) {
    return NextResponse.json(
      { error: `network must be one of: ${STOCK_TRACKED_NETWORKS.join(", ")}` },
      { status: 400 }
    )
  }

  if (typeof outOfStock !== "boolean") {
    return NextResponse.json({ error: "outOfStock must be a boolean" }, { status: 400 })
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    const result = outOfStock
      ? await setNetworkOutOfStock(adminClient, network)
      : await restockNetwork(adminClient, network)

    // Best-effort audit trail — never blocks the response on failure (same
    // fire-and-forget pattern as bulk-update-price's admin_audit_log insert).
    adminClient
      .from("admin_audit_log")
      .insert([
        {
          admin_id: userId,
          action: "network_stock_toggle",
          target_user_id: null,
          old_value: { network },
          new_value: { outOfStock, ...result },
          created_at: new Date().toISOString(),
        },
      ])
      .then(({ error }: { error: any }) => {
        if (error) console.warn("[ADMIN-AUDIT] network_stock_toggle log insert failed:", error.message)
      })

    return NextResponse.json({ success: true, network, outOfStock, affected: result.affected })
  } catch (error) {
    console.error("[NETWORK-STOCK] POST error:", error)
    return NextResponse.json({ error: "Failed to update network stock status" }, { status: 500 })
  }
}
