import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { notifyUserOfOutcome } from "@/lib/admin-actions"
import { approveShop } from "@/lib/sub-agents/open-shop"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { shopId } = await request.json()

    if (!shopId) {
      return NextResponse.json(
        { error: "Missing shopId" },
        { status: 400 }
      )
    }

    // Activate only an inactive shop that is not a closed storefront joiner (conditional update: a double click
    // cannot send the owner a second approval message, and a joiner never opens without prices).
    const result = await approveShop(supabase, shopId)

    if (result.status === "opens_when_priced") {
      return NextResponse.json(
        { error: "This storefront sub-agent's shop opens when they set their prices. It doesn't need approval." },
        { status: 409 }
      )
    }

    if (result.status === "already_approved") {
      return NextResponse.json(
        { error: "Shop already approved" },
        { status: 409 }
      )
    }

    const data = [result.shop]

    console.log(`Shop ${shopId} approved by admin`)

    // Notify shop owner (in-app, push, email, SMS) via the central notifier
    try {
      const shop = data[0]
      if (shop?.user_id) {
        const { data: owner } = await supabase
          .from("users")
          .select("phone_number")
          .eq("id", shop.user_id)
          .maybeSingle()
        await notifyUserOfOutcome("shop", "approved", { userId: shop.user_id, reference: shopId }, { shopId, shopName: shop.shop_name || "Your shop", ownerPhone: owner?.phone_number ?? null })
      }
    } catch (e) {
      console.warn("[ADMIN-ACTION] shop approval notify failed:", e instanceof Error ? e.message : e)
    }

    return NextResponse.json({
      success: true,
      data: data[0]
    })
  } catch (error: any) {
    console.error("Error in POST /api/admin/shops/approve:", error)
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    )
  }
}
