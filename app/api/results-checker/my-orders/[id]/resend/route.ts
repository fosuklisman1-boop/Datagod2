import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { resendVouchers } from "@/lib/results-checker-notification-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { method } = await request.json()
    if (method !== "sms" && method !== "email") {
      return NextResponse.json({ error: "method must be 'sms' or 'email'" }, { status: 400 })
    }

    // Verify the order belongs to this user and is completed
    const { data: order } = await supabase
      .from("results_checker_orders")
      .select("id, status")
      .eq("id", id)
      .eq("user_id", user.id)
      .single()

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 })
    }
    if (order.status !== "completed") {
      return NextResponse.json({ error: "Order is not completed" }, { status: 422 })
    }

    const result = await resendVouchers(id, method)
    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 422 })
    }

    return NextResponse.json({ success: true, message: result.message })
  } catch (err) {
    console.error("[RC-RESEND]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
