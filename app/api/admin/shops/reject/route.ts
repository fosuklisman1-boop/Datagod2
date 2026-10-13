import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { notifyUserOfOutcome } from "@/lib/admin-actions"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { shopId, reason } = await request.json()

    if (!shopId) {
      return NextResponse.json(
        { error: "Missing shopId" },
        { status: 400 }
      )
    }

    // Update shop to inactive (rejected). NOTE: user_shops has no separate
    // pending/rejected state (both are is_active=false), so there is no reliable
    // pre-state to condition on; this stays unconditional as before.
    const { data, error } = await supabase
      .from("user_shops")
      .update({
        is_active: false,
        updated_at: new Date().toISOString()
      })
      .eq("id", shopId)
      .select("*, user_id")

    if (error) {
      console.error("Error rejecting shop:", error)
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      )
    }

    console.log(`Shop ${shopId} rejected by admin`)

    // Notify shop owner (in-app, push, email, SMS) via the central notifier
    try {
      const shop = data?.[0]
      if (shop?.user_id) {
        const { data: owner } = await supabase
          .from("users")
          .select("phone_number")
          .eq("id", shop.user_id)
          .maybeSingle()
        await notifyUserOfOutcome("shop", "rejected", { userId: shop.user_id, reference: shopId }, { shopId, shopName: shop.shop_name || "Your shop", reason, ownerPhone: owner?.phone_number ?? null })
      }
    } catch (e) {
      console.warn("[ADMIN-ACTION] shop rejection notify failed:", e instanceof Error ? e.message : e)
    }

    return NextResponse.json({
      success: true,
      data: data[0]
    })
  } catch (error: any) {
    console.error("Error in POST /api/admin/shops/reject:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
