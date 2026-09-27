import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getLatestCompletedOrder } from "@/lib/order-health-service"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, serviceRoleKey)

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Missing or invalid authorization header" }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)

    if (authError || !user?.id) {
      console.error("[LATEST-ORDER] Auth error:", authError)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const order = await getLatestCompletedOrder(supabase, user.id)
    return NextResponse.json({ success: true, order })
  } catch (error) {
    console.error("[LATEST-ORDER] Error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Internal server error", order: null },
      { status: 500 }
    )
  }
}
