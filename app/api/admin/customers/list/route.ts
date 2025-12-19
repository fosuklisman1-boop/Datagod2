import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { customerTrackingService } from "@/lib/customer-tracking-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  try {
    // Verify user is authenticated
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = authHeader.slice(7)
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Get user's shop
    const { data: shop, error: shopError } = await supabase
      .from("shops")
      .select("id")
      .eq("user_id", userId)
      .single()

    if (shopError || !shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 })
    }

    // Get query params
    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100)
    const offset = parseInt(searchParams.get("offset") || "0")

    // Fetch customers
    const result = await customerTrackingService.listCustomers(shop.id, limit, offset)

    return NextResponse.json({
      success: true,
      ...result,
    })
  } catch (error) {
    console.error("[CUSTOMER-LIST] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
