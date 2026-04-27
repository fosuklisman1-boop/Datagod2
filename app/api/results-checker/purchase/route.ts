import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import {
  isValidExamBoard,
  isExamBoardEnabled,
  getMaxQuantity,
  getAvailableCount,
  purchaseResultsCheckerVouchers,
} from "@/lib/results-checker-service"
import { deliverVouchers } from "@/lib/results-checker-notification-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    // 1. Auth
    const authHeader = request.headers.get("Authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    const token = authHeader.slice(7)
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized: Invalid token" }, { status: 401 })
    }

    // 2. Parse and validate body
    const { examBoard, quantity: rawQuantity, shopId } = await request.json()

    if (!examBoard || !rawQuantity) {
      return NextResponse.json({ error: "examBoard and quantity are required" }, { status: 400 })
    }
    if (!isValidExamBoard(examBoard)) {
      return NextResponse.json({ error: "Invalid examBoard. Must be WAEC, BECE, or NOVDEC" }, { status: 400 })
    }

    const quantity = parseInt(rawQuantity)
    if (isNaN(quantity) || quantity < 1) {
      return NextResponse.json({ error: "quantity must be a positive integer" }, { status: 400 })
    }

    const maxQty = await getMaxQuantity()
    if (quantity > maxQty) {
      return NextResponse.json({ error: `Maximum ${maxQty} vouchers per order` }, { status: 400 })
    }

    // 3. Check feature enabled
    const enabled = await isExamBoardEnabled(examBoard)
    if (!enabled) {
      return NextResponse.json({ error: `${examBoard} vouchers are currently unavailable` }, { status: 503 })
    }

    // 4. Idempotency guard — block same (userId, examBoard, quantity) within 30s
    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString()
    const { data: recentOrder } = await supabase
      .from("results_checker_orders")
      .select("id, reference_code")
      .eq("user_id", user.id)
      .eq("exam_board", examBoard)
      .eq("quantity", quantity)
      .eq("status", "pending")
      .gte("created_at", thirtySecondsAgo)
      .maybeSingle()

    if (recentOrder) {
      return NextResponse.json(
        { error: "Duplicate request detected. Please wait before trying again.", reference: recentOrder.reference_code },
        { status: 409 }
      )
    }

    // 5. Check inventory
    const available = await getAvailableCount(examBoard)
    if (available < quantity) {
      return NextResponse.json(
        { error: `Only ${available} ${examBoard} voucher${available !== 1 ? "s" : ""} available. Please reduce quantity.`, available },
        { status: 409 }
      )
    }

    // 6. Fetch customer contact info for notifications
    const { data: userProfile } = await supabase
      .from("users")
      .select("phone_number, email, first_name")
      .eq("id", user.id)
      .single()

    // 7. Execute purchase (wallet deduct + assign + finalize)
    const { order, vouchers, newBalance } = await purchaseResultsCheckerVouchers({
      userId: user.id,
      examBoard,
      quantity,
      shopId,
    })

    // Attach customer contact so notification service can reach them
    const orderWithContact = {
      ...order,
      customer_phone: userProfile?.phone_number ?? null,
      customer_email: userProfile?.email ?? user.email ?? null,
    }

    // 8. Non-blocking delivery (SMS + email)
    Promise.allSettled([deliverVouchers(orderWithContact, vouchers)])
      .catch(e => console.warn("[RC-PURCHASE] Notification error:", e))

    console.log(`[RC-PURCHASE] ✓ ${order.reference_code} | ${examBoard} x${quantity} | GHS ${order.total_paid} | user ${user.id}`)

    return NextResponse.json({
      success: true,
      message: `${examBoard} voucher${quantity > 1 ? "s" : ""} purchased successfully`,
      order,
      vouchers,
      newBalance,
    })

  } catch (error: any) {
    if (error.code === "INSUFFICIENT_BALANCE") {
      return NextResponse.json({ error: "Insufficient wallet balance", required: error.required }, { status: 402 })
    }
    if (error.code === "INSUFFICIENT_INVENTORY") {
      return NextResponse.json({ error: "Vouchers sold out during checkout. Your wallet has been refunded." }, { status: 409 })
    }
    console.error("[RC-PURCHASE] Unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
